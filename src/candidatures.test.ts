import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCandidatures, rebuildCandidatures, sameCompany, sameJob, type CandidatureEvent } from "./candidatures.js";
import { openDb, saveMailResult } from "./db.js";

// Événements fabriqués : aucune vraie donnée.

let n = 0;
function ev(overrides: Partial<CandidatureEvent> & { day: number }): CandidatureEvent {
  const { day, ...rest } = overrides;
  return {
    gmailId: `m${++n}`,
    threadId: null,
    date: new Date(Date.UTC(2026, 6, day)),
    type: "candidature_envoyee",
    company: "Exemple",
    jobTitle: "Product Owner (H/F)",
    location: null,
    channel: null,
    offerUrl: null,
    ...rest,
  };
}

test("critère #10 : accusé → entretien → refus = une candidature, trois événements, statut Refus", () => {
  const events = [
    ev({ day: 1, type: "candidature_envoyee" }),
    ev({ day: 5, type: "entretien" }),
    ev({ day: 9, type: "refus" }),
  ];
  const { candidatures } = buildCandidatures(events);
  assert.equal(candidatures.length, 1);
  const [c] = candidatures;
  assert.equal(c.events.length, 3);
  assert.equal(c.status, "Refus");
  assert.equal(c.id, events[0].gmailId);
  assert.equal(c.appliedAt.getTime(), events[0].date.getTime());
  assert.equal(c.lastEventType, "refus");
});

test("ordre chronologique respecté même si les événements arrivent dans le désordre", () => {
  const { candidatures } = buildCandidatures([ev({ day: 9, type: "refus" }), ev({ day: 1, type: "candidature_envoyee" })]);
  assert.equal(candidatures.length, 1);
  assert.equal(candidatures[0].status, "Refus");
});

test("variantes de noms d'entreprise rapprochées, entreprises différentes séparées", () => {
  assert.ok(sameCompany("Skysoft", "SkySoft-ATM"));
  assert.ok(sameCompany("Team.is", "Teamis"));
  assert.ok(sameCompany("SII", "SII Group"));
  assert.ok(sameCompany("Guarani", "Guarani Bordeaux"));
  assert.ok(sameCompany("ACENSI", "Groupe Acensi"));
  assert.ok(!sameCompany("Atos", "Alan"));
  assert.ok(!sameCompany("CS Group", "Capgemini"));
});

test("intitulés de poste rapprochés malgré (H/F) et l'écriture inclusive", () => {
  assert.ok(sameJob("Développeur Junior Java - Angular H/F", "Développeur junior Java / Angular (H/F)"));
  assert.ok(sameJob("Product Manager Junior", "Product Manager"));
  assert.ok(
    sameJob(
      "Alternance - Assistant Conducteur de Travaux de Proximité H/F",
      "Alternance – Assistant(e) Conducteur(trice) de Travaux de proximité (F/H)",
    ),
  );
  assert.ok(!sameJob("Product Owner", "Chef de projet"));
});

test("même entreprise, postes différents : deux candidatures", () => {
  const { candidatures } = buildCandidatures([
    ev({ day: 1, jobTitle: "Chef de Projet Technique" }),
    ev({ day: 2, jobTitle: "Consultant Transformation Digitale" }),
  ]);
  assert.equal(candidatures.length, 2);
});

test("nouvel envoi après un refus : nouvelle candidature", () => {
  const { candidatures } = buildCandidatures([
    ev({ day: 1, type: "candidature_envoyee" }),
    ev({ day: 3, type: "refus" }),
    ev({ day: 20, type: "candidature_envoyee" }),
    ev({ day: 21, type: "entretien" }),
  ]);
  assert.equal(candidatures.length, 2);
  assert.deepEqual(
    candidatures.map((c) => c.status),
    ["Refus", "Entretien"],
  );
});

test("deux accusés le même jour (plateforme + entreprise) : une seule candidature", () => {
  const { candidatures } = buildCandidatures([
    ev({ day: 1, company: "Talan", jobTitle: "Développeur Junior Java - Angular H/F", channel: "Hellowork" }),
    ev({ day: 1, company: "Talan", jobTitle: "Développeur junior Java / Angular (H/F)" }),
  ]);
  assert.equal(candidatures.length, 1);
  assert.equal(candidatures[0].channel, "Hellowork");
});

test("poste inconnu : rattaché à la seule candidature en cours de l'entreprise", () => {
  const { candidatures } = buildCandidatures([
    ev({ day: 1, company: "Alan", jobTitle: null }),
    ev({ day: 4, company: "Alan", jobTitle: null, type: "refus" }),
  ]);
  assert.equal(candidatures.length, 1);
  assert.equal(candidatures[0].status, "Refus");
});

test("entreprise inconnue (Indeed Apply) puis refus nommé : rattachés par le poste", () => {
  const { candidatures } = buildCandidatures([
    ev({ day: 1, company: null, jobTitle: "Aide conducteur de travaux H/F", channel: "Indeed" }),
    ev({ day: 9, company: "Maisons LARA", jobTitle: "Aide conducteur de travaux H/F", type: "refus" }),
  ]);
  assert.equal(candidatures.length, 1);
  assert.equal(candidatures[0].company, "Maisons LARA");
  assert.equal(candidatures[0].status, "Refus");
});

test("entreprise inconnue et intitulé seulement proche : pas de fusion avec une autre entreprise", () => {
  const { candidatures } = buildCandidatures([
    ev({ day: 1, company: null, jobTitle: "Chef de projet informatique H/F" }),
    ev({ day: 30, company: "Amaris Consulting", jobTitle: "chef de projet" }),
  ]);
  assert.equal(candidatures.length, 2);
});

test("même fil Gmail : rattaché même sans entreprise ni poste", () => {
  const { candidatures, links } = buildCandidatures([
    ev({ day: 1, threadId: "t1", type: "refus" }),
    ev({ day: 2, threadId: "t1", type: "autre", company: null, jobTitle: null, gmailId: "reponse" }),
  ]);
  assert.equal(candidatures.length, 1);
  assert.equal(links.get("reponse")?.candidatureId, candidatures[0].id);
  assert.equal(candidatures[0].status, "Refus", "un mail « autre » ne change pas le statut");
});

test("mail « autre » sans candidature correspondante : non rattaché, aucune création", () => {
  const { candidatures, links } = buildCandidatures([ev({ day: 1, type: "autre", company: "EIC", gmailId: "eic" })]);
  assert.equal(candidatures.length, 0);
  assert.deepEqual(links.get("eic"), { candidatureId: null, toCheck: false });
});

test("cas ambigu : rattaché à la plus récente en cours, marqué à vérifier", () => {
  const { candidatures, links } = buildCandidatures([
    ev({ day: 1, company: "Niji", jobTitle: "Chef de Projet Technique" }),
    ev({ day: 2, company: "Niji", jobTitle: "Consultant Transformation" }),
    ev({ day: 5, company: "Niji", jobTitle: null, type: "refus", gmailId: "ambigu" }),
  ]);
  assert.equal(candidatures.length, 2);
  assert.equal(links.get("ambigu")?.toCheck, true);
  assert.equal(links.get("ambigu")?.candidatureId, candidatures[1].id);
  assert.equal(candidatures[1].toCheck, true);
});

test("recalcul en base : remplace les tables calculées, sans doublon au second passage", () => {
  const db = openDb(":memory:");
  const base = { receivedAt: new Date("2026-07-01"), sent: false, filterRule: "mot-cle", company: "Exemple", jobTitle: "PO" };
  saveMailResult(db, { ...base, gmailId: "a", threadId: "t", eventType: "candidature_envoyee" });
  saveMailResult(db, { ...base, gmailId: "b", threadId: "t", eventType: "refus", receivedAt: new Date("2026-07-05") });
  saveMailResult(db, { ...base, gmailId: "c", eventType: "hors_sujet" });

  rebuildCandidatures(db);
  rebuildCandidatures(db);

  const rows = db.prepare("SELECT id, status FROM candidatures").all();
  assert.deepEqual(rows.map((r) => ({ ...r })), [{ id: "a", status: "Refus" }]);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM mail_links").get() as { n: number }).n, 2);
});
