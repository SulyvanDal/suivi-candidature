// Évalue le jugement des annonces par Claude (#23) sur un jeu annoté à la main :
// npm run eval:offres
// Annotations : data/annotations-offres.json (hors de git), [{ id, expected, raison?, note? }],
// id = identifiant de l'annonce dans la table offers ; expected = « garder » ou « ecarter ».
// Le profil est celui de la base. Rien n'est écrit en base.
// Chaque lancement appelle réellement Claude : il coûte quelques centimes.

import { readFileSync } from "node:fs";
import { createClient } from "./classify.js";
import { getSetting, openDb, PROFILE_KEY } from "./db.js";
import { decide, judgeOffer, loadCeilings, type OfferToJudge } from "./offer-judge.js";

const ANNOTATIONS_PATH = "data/annotations-offres.json";
const PRICE_PER_MTOK = { input: 1, output: 5 }; // Claude Haiku 4.5

interface Annotation {
  id: number;
  expected: "garder" | "ecarter";
  raison?: string;
  note?: string;
}

const annotations: Annotation[] = JSON.parse(readFileSync(ANNOTATIONS_PATH, "utf8"));
const db = openDb();
const profile = getSetting(db, PROFILE_KEY);
if (!profile) throw new Error("Profil du candidat absent de la base.");
const claude = createClient();
const ceilings = loadCeilings(db);

let ok = 0;
const tokens = { input: 0, output: 0 };
const errors: string[] = [];
const confusion = { garderManque: 0, ecarterManque: 0 };

for (const a of annotations) {
  const offer = db
    .prepare("SELECT title, company, location, contract, description FROM offers WHERE id = ? AND page_status = 'lue'")
    .get(a.id) as OfferToJudge | undefined;
  if (!offer) {
    errors.push(`  #${a.id} : annonce introuvable ou non lue`);
    continue;
  }
  const { facts, usage } = await judgeOffer(claude, profile, offer);
  const judgment = decide(facts, ceilings);
  tokens.input += usage.inputTokens;
  tokens.output += usage.outputTokens;
  if (judgment.decision === a.expected) {
    ok++;
    continue;
  }
  // Une bonne annonce écartée est plus grave qu'une annonce de trop.
  if (a.expected === "garder") confusion.garderManque++;
  else confusion.ecarterManque++;
  errors.push(
    `  #${a.id} ${offer.title} — ${offer.company ?? "?"}\n` +
      `     attendu ${a.expected}${a.note ? ` (${a.note})` : ""}, obtenu ${judgment.decision} / ${judgment.raison}\n` +
      `     faits : ${facts ? `${facts.type_poste}, ${facts.experience_min_ans ?? "durée non chiffrée"}, senior=${facts.profil_senior}, niche=${facts.techno_niche}` : "aucun"} — ${facts?.justification ?? ""}`,
  );
}
db.close();

const cost = (tokens.input * PRICE_PER_MTOK.input + tokens.output * PRICE_PER_MTOK.output) / 1e6;
console.log(`Accord avec les annotations : ${ok}/${annotations.length}`);
console.log(`  Bonnes annonces écartées à tort : ${confusion.garderManque}`);
console.log(`  Annonces gardées à tort         : ${confusion.ecarterManque}`);
if (errors.length) console.log(`\nDésaccords :\n${errors.join("\n")}`);
console.log(`\nCoût : ${cost.toFixed(3)} $ (${tokens.input} jetons en entrée, ${tokens.output} en sortie).`);
