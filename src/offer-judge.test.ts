import assert from "node:assert/strict";
import { test } from "node:test";
import { openDb, saveOffer } from "./db.js";
import {
  DEFAULT_CEILINGS,
  decide,
  type JudgeResult,
  judgePendingOffers,
  type OfferFacts,
  type OfferToJudge,
  priorityOf,
  recomputeVerdicts,
} from "./offer-judge.js";

// Annonces fabriquées et faux Claude : aucun appel réel.

function setup() {
  const db = openDb(":memory:");
  const alert = { gmailId: "al", receivedAt: new Date("2026-10-06") };
  const add = (title: string, page: "lue" | "non_verifiee" | null) => {
    saveOffer(
      db,
      { platform: "hellowork", title, company: "Ex", location: "Paris", contract: "CDI", url: `u-${title}` },
      { keep: true, rule: "poste-recherche" },
      alert,
    );
    if (page) {
      db.prepare("UPDATE offers SET page_status = ?, description = ? WHERE title = ?").run(
        page,
        page === "lue" ? `Description de ${title}` : null,
        title,
      );
    }
  };
  add("Product Owner", "lue");
  add("Chef de projet senior", "lue");
  add("Développeur", "non_verifiee");
  add("PMO", null);
  add("Business Analyst", "lue");

  const judged: string[] = [];
  const judge = async (o: OfferToJudge): Promise<JudgeResult> => {
    judged.push(o.title);
    const senior = o.title.includes("senior");
    return {
      facts: {
        type_poste: "produit_projet",
        experience_min_ans: senior ? 8 : 1,
        profil_senior: senior,
        techno_niche: false,
        type_employeur: senior ? "esn_conseil" : "editeur_startup",
        culture_ia: !senior,
        stack_proche: false,
        produit_tech: true,
        poste_data_ia: !senior,
        banque_assurance: false,
        taille: "pme_eti",
        justification: senior ? "8 ans demandés." : "Junior accepté.",
      },
      usage: { inputTokens: 1000, outputTokens: 50 },
    };
  };
  return { db, judge, judged };
}

test("seules les annonces lues et pas encore jugées partent chez Claude ; décision enregistrée", async () => {
  const { db, judge, judged } = setup();
  const stats = await judgePendingOffers(db, judge, { model: "modele-test" });

  assert.deepEqual(judged, ["Product Owner", "Chef de projet senior", "Business Analyst"]);
  assert.deepEqual(stats, { kept: 2, rejected: 1, waiting: 0, inputTokens: 3000, outputTokens: 150 });
  const row = db
    .prepare("SELECT verdict, verdict_reason, justification, model, job_type, experience_min, senior FROM offers WHERE title = ?")
    .get("Chef de projet senior");
  assert.deepEqual(
    { ...row },
    {
      verdict: "ecarter",
      verdict_reason: "seniorite",
      justification: "8 ans demandés.",
      model: "modele-test",
      job_type: "produit_projet",
      experience_min: 8,
      senior: 1,
    },
  );

  // Second passage : rien de nouveau à juger.
  judged.length = 0;
  await judgePendingOffers(db, judge);
  assert.deepEqual(judged, []);
});

test("plafond quotidien compté sur la journée entière, toutes synchronisations confondues", async () => {
  const { db, judge, judged } = setup();
  const morning = new Date(2026, 9, 7, 8, 0);
  const evening = new Date(2026, 9, 7, 20, 0);
  const tomorrow = new Date(2026, 9, 8, 8, 0);

  assert.equal((await judgePendingOffers(db, judge, { dailyLimit: 2, now: morning })).waiting, 1);
  assert.deepEqual(judged, ["Product Owner", "Chef de projet senior"]);

  // Même jour : plafond déjà atteint, rien n'est envoyé.
  judged.length = 0;
  assert.equal((await judgePendingOffers(db, judge, { dailyLimit: 2, now: evening })).waiting, 1);
  assert.deepEqual(judged, []);

  // Lendemain : la suite passe.
  await judgePendingOffers(db, judge, { dailyLimit: 2, now: tomorrow });
  assert.deepEqual(judged, ["Business Analyst"]);
});

const facts = (f: Partial<OfferFacts>): OfferFacts => ({
  type_poste: "produit_projet",
  experience_min_ans: null,
  profil_senior: false,
  techno_niche: false,
  type_employeur: "inconnu",
  culture_ia: false,
  stack_proche: false,
  produit_tech: false,
  poste_data_ia: false,
  banque_assurance: false,
  taille: "inconnue",
  justification: "",
  ...f,
});
const verdict = (f: Partial<OfferFacts>) => decide(facts(f), DEFAULT_CEILINGS);

test("décision : minimum exigé comparé au plafond (4 ans produit/projet, 2 ans développeur), égalité gardée", () => {
  assert.deepEqual(verdict({ experience_min_ans: 3 }), { decision: "garder", raison: "correspond" });
  assert.deepEqual(verdict({ experience_min_ans: 4 }), { decision: "garder", raison: "correspond" });
  assert.deepEqual(verdict({ experience_min_ans: 5 }), { decision: "ecarter", raison: "seniorite" });
  assert.equal(verdict({ type_poste: "developpeur", experience_min_ans: 2 }).decision, "garder");
  assert.equal(verdict({ type_poste: "developpeur", experience_min_ans: 3 }).decision, "ecarter");
  // Une durée chiffrée l'emporte sur le vocabulaire.
  assert.equal(verdict({ experience_min_ans: 2, profil_senior: true }).decision, "garder");
});

test("décision : sans durée, seul un poste explicitement senior est écarté ; hors cible et techno de niche écartés", () => {
  assert.equal(verdict({}).decision, "garder");
  assert.deepEqual(verdict({ profil_senior: true }), { decision: "ecarter", raison: "seniorite" });
  assert.deepEqual(verdict({ type_poste: "autre" }), { decision: "ecarter", raison: "hors_cible" });
  assert.deepEqual(verdict({ type_poste: "developpeur", techno_niche: true }), { decision: "ecarter", raison: "hors_cible" });
  // Techno de niche ignorée hors développement.
  assert.equal(verdict({ techno_niche: true }).decision, "garder");
  // Pas de faits (refus de Claude) : gardée.
  assert.deepEqual(decide(null, DEFAULT_CEILINGS), { decision: "garder", raison: "correspond" });
});

// --- Priorité (#26) ------------------------------------------------------------------------------

test("priorité : poste data / IA et stack proche pèsent le plus, priorité 1 à partir de 4", () => {
  // PO data en ESN de taille moyenne, culture IA : 3 + 1 + 1 = 5 (l'ESN n'empêche pas la priorité).
  assert.deepEqual(
    priorityOf(facts({ poste_data_ia: true, type_employeur: "esn_conseil", culture_ia: true, taille: "pme_eti" }), "Paris"),
    { level: 1, points: 5, details: ["poste data / IA +3", "culture IA +1", "taille moyenne +1"] },
  );
  // Développeur junior sur sa stack, à Bordeaux : 1 + 2 + 1 = 4.
  assert.deepEqual(priorityOf(facts({ type_poste: "developpeur", stack_proche: true, experience_min_ans: 0 }), "Bordeaux - 33"), {
    level: 1,
    points: 4,
    details: ["Bordeaux +1", "stack proche +2", "junior +1"],
  });
  // Développeur sur sa stack en ESN parisienne, 3 ans demandés : 2 points.
  assert.equal(priorityOf(facts({ type_poste: "developpeur", type_employeur: "esn_conseil", stack_proche: true, experience_min_ans: 3 }), "Paris").level, 2);
  // Critères propres à chaque famille de poste : la stack ne compte pas pour un PO, ni « data / IA » pour un développeur.
  assert.equal(priorityOf(facts({ stack_proche: true }), null).points, 0);
  assert.equal(priorityOf(facts({ type_poste: "developpeur", poste_data_ia: true, produit_tech: true }), null).points, 0);
  // Startup produit + tech : 1 + 1 = 2.
  assert.equal(priorityOf(facts({ type_employeur: "editeur_startup", produit_tech: true }), "Paris").points, 2);
});

test("priorité : banque / assurance pénalisée sauf startup ou scale-up ; lieux de la Gironde reconnus", () => {
  const banque = facts({ type_employeur: "entreprise_finale", banque_assurance: true, taille: "grand_groupe" });
  assert.deepEqual(priorityOf(banque, "Paris"), { level: 2, points: -1, details: ["entreprise finale +1", "banque / assurance -2"] });
  const neobanque = facts({ type_employeur: "editeur_startup", banque_assurance: true, taille: "startup_scaleup" });
  assert.equal(priorityOf(neobanque, "Paris").points, 1);
  for (const lieu of ["33300 Bordeaux", "Mérignac - 33", "Pessac", "Bordeaux (33)"]) {
    assert.equal(priorityOf(facts({}), lieu).points, 1, lieu);
  }
  assert.equal(priorityOf(facts({}), "Paris 8e - 75").points, 0);
  // Sans faits (refus de Claude) : seul le lieu compte.
  assert.deepEqual(priorityOf(null, "Bordeaux"), { level: 2, points: 1, details: ["Bordeaux +1"] });
});

test("priorité enregistrée au tri, et recalculée sans Claude (annonces triées avant #26 : sans priorité)", async () => {
  const { db, judge } = setup();
  await judgePendingOffers(db, judge);
  const row = () =>
    db.prepare("SELECT priority, priority_points, priority_details FROM offers WHERE title = 'Product Owner'").get();
  // Poste data / IA +3, produit + tech +1, éditeur/startup +1, IA +1, PME/ETI +1 = 7.
  assert.deepEqual(
    { ...row() },
    {
      priority: 1,
      priority_points: 7,
      priority_details: "poste data / IA +3, produit + tech +1, éditeur ou startup +1, culture IA +1, taille moyenne +1",
    },
  );

  db.prepare("UPDATE offers SET data_ai_role = NULL WHERE title = 'Product Owner'").run();
  recomputeVerdicts(db);
  assert.deepEqual({ ...row() }, { priority: null, priority_points: null, priority_details: null });
});
