// Donne une priorité (#26) aux annonces triées avant son arrivée : npm run offres:retrier
// Les annonces gardées sans priorité repassent chez Claude, y compris celles ignorées : leurs faits
// servent à évaluer le barème (npm run eval:priorite, gratuit). Claude relève à nouveau tous les
// faits : la décision garder / écarter peut donc changer.
// Avec --toutes : toutes les annonces gardées, même déjà évaluées (après un changement de modèle).
// Appelle Claude : quelques centimes.

import { createClient, MODEL, PRICE_PER_MTOK } from "./classify.js";
import { getSetting, openDb, PROFILE_KEY } from "./db.js";
import { decide, judgeOffer, loadCeilings, type OfferToJudge, priorityOf, saveJudgment } from "./offer-judge.js";


const db = openDb();
const profile = getSetting(db, PROFILE_KEY);
if (!profile) throw new Error("Profil du candidat absent de la base.");
const claude = createClient();
const ceilings = loadCeilings(db);

const all = process.argv.includes("--toutes");
const offers = db
  .prepare(
    `SELECT id, title, company, location, contract, description FROM offers
     WHERE page_status = 'lue' AND verdict = 'garder'
       ${all ? "" : "AND (priority IS NULL OR data_ai_role IS NULL)"} ORDER BY id`,
  )
  .all() as unknown as ({ id: number } & OfferToJudge)[];

const stats = { prio1: 0, prio2: 0, nowRejected: 0, input: 0, output: 0 };
for (const offer of offers) {
  const { facts, usage } = await judgeOffer(claude, profile, offer);
  const judgment = decide(facts, ceilings);
  const priority = priorityOf(facts, offer.location);
  saveJudgment(db, offer.id, facts, judgment, priority, MODEL, new Date());
  stats.input += usage.inputTokens;
  stats.output += usage.outputTokens;
  if (judgment.decision === "ecarter") stats.nowRejected++;
  else if (priority.level === 1) stats.prio1++;
  else stats.prio2++;
}
db.close();

const cost = (stats.input * PRICE_PER_MTOK.input + stats.output * PRICE_PER_MTOK.output) / 1e6;
console.log(
  `${offers.length} annonce(s) repassée(s) : ${stats.prio1} en priorité 1, ${stats.prio2} en priorité 2, ` +
    `${stats.nowRejected} désormais écartée(s). Coût : ${cost.toFixed(3)} $.`,
);
