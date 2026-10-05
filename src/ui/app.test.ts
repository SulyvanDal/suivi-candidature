import assert from "node:assert/strict";
import { test } from "node:test";
import { rebuildCandidatures } from "../candidatures.js";
import { openDb, saveMailResult } from "../db.js";
import { createApp } from "./app.js";
import { displayStatus } from "./queries.js";

// Données fabriquées, base en mémoire ; les pages sont testées sans démarrer de serveur.

const NOW = new Date("2026-10-05T12:00:00Z");

function setup() {
  const db = openDb(":memory:");
  const mail = (gmailId: string, day: string, eventType: string, extra: object = {}) =>
    saveMailResult(db, {
      gmailId,
      receivedAt: new Date(`2026-${day}T09:00:00Z`),
      sent: false,
      filterRule: "mot-cle",
      eventType,
      company: "Exemple",
      jobTitle: "Product Owner",
      correspondent: "RH <rh@exemple.com>",
      subject: "Votre candidature",
      ...extra,
    });
  // Candidature récente, toujours en attente.
  mail("a1", "10-01", "candidature_envoyee", { threadId: "t-a" });
  // Candidature ancienne sans nouvelles → « Sans réponse ».
  mail("b1", "08-01", "candidature_envoyee", { company: "Ancienne" });
  // Candidature refusée, avec un objet contenant du HTML.
  mail("c1", "09-01", "candidature_envoyee", { company: "Piège", threadId: "t-c" });
  mail("c2", "09-10", "refus", { company: "Piège", threadId: "t-c", subject: "<script>alert(1)</script>" });
  rebuildCandidatures(db);
  return createApp(db, () => NOW);
}

test("« Sans réponse » : envoyée et rien depuis plus de 3 semaines", () => {
  assert.equal(displayStatus("Envoyée", new Date("2026-09-01"), NOW), "Sans réponse");
  assert.equal(displayStatus("Envoyée", new Date("2026-09-25"), NOW), "Envoyée");
  assert.equal(displayStatus("Refus", new Date("2026-07-01"), NOW), "Refus");
});

test("page principale : toutes les candidatures, la plus récente en premier, avec compteurs", async () => {
  const res = await setup().request("/");
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.ok(body.indexOf("Exemple") < body.indexOf("Piège") && body.indexOf("Piège") < body.indexOf("Ancienne"));
  assert.match(body, /Toutes <span class="compteur">3<\/span>/);
  assert.match(body, /Sans réponse <span class="compteur">1<\/span>/);
  assert.match(body, /src="\/htmx.js"/);
});

test("filtre par statut", async () => {
  const body = await (await setup().request("/?statut=Sans%20r%C3%A9ponse")).text();
  assert.match(body, /Ancienne/);
  assert.doesNotMatch(body, /Piège/);
});

test("statut inconnu dans l'adresse : pas de filtre", async () => {
  const body = await (await setup().request("/?statut=nimportequoi")).text();
  assert.match(body, /Ancienne/);
  assert.match(body, /Piège/);
});

test("page d'une candidature : ses mails dans l'ordre, lien vers le fil Gmail", async () => {
  const res = await setup().request("/candidatures/c1");
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.equal(body.match(/class="evenement /g)?.length, 2);
  const first = body.indexOf('mail-type">Candidature envoyée');
  const second = body.indexOf('mail-type">Refus');
  assert.ok(first > 0 && first < second, "accusé puis refus");
  assert.match(body, /mail\.google\.com\/mail\/u\/0\/#all\/t-c/);
});

test("contenu des mails échappé : un objet en HTML s'affiche comme du texte", async () => {
  const body = await (await setup().request("/candidatures/c1")).text();
  assert.doesNotMatch(body, /<script>alert/);
  assert.match(body, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test("candidature inconnue : 404", async () => {
  const res = await setup().request("/candidatures/inconnue");
  assert.equal(res.status, 404);
});

test("htmx et la feuille de style sont servis localement", async () => {
  const app = setup();
  assert.equal((await app.request("/htmx.js")).headers.get("content-type"), "text/javascript; charset=utf-8");
  assert.match(await (await app.request("/style.css")).text(), /--fond/);
});
