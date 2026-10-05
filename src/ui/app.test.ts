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
  // Échange sans candidature correspondante → à classer.
  mail("x1", "09-20", "autre", { company: "Immersion SA", jobTitle: null, subject: "Demande d'immersion" });
  rebuildCandidatures(db);
  return createApp(db, () => NOW);
}

/** Partie « liste des candidatures » de la page (sans la section « À classer » et ses menus). */
const listPart = (body: string) => body.slice(body.indexOf('id="contenu"'));

/** Envoi d'un formulaire depuis l'interface elle-même (même origine). */
const post = (app: ReturnType<typeof setup>, path: string, form: Record<string, string> = {}, origin = "http://localhost") =>
  app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: origin },
    body: new URLSearchParams(form).toString(),
  });

test("« Sans réponse » : envoyée et rien depuis plus de 3 semaines", () => {
  assert.equal(displayStatus("Envoyée", new Date("2026-09-01"), NOW), "Sans réponse");
  assert.equal(displayStatus("Envoyée", new Date("2026-09-25"), NOW), "Envoyée");
  assert.equal(displayStatus("Refus", new Date("2026-07-01"), NOW), "Refus");
});

test("page principale : toutes les candidatures, la plus récente en premier, avec compteurs", async () => {
  const res = await setup().request("/");
  assert.equal(res.status, 200);
  const full = await res.text();
  const body = listPart(full);
  assert.ok(body.indexOf("Exemple") < body.indexOf("Piège") && body.indexOf("Piège") < body.indexOf("Ancienne"));
  assert.match(body, /Toutes <span class="compteur">3<\/span>/);
  assert.match(body, /Sans réponse <span class="compteur">1<\/span>/);
  assert.match(full, /src="\/htmx.js"/);
});

test("filtre par statut", async () => {
  const body = listPart(await (await setup().request("/?statut=Sans%20r%C3%A9ponse")).text());
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

// --- À classer (#17) ---

test("bouton « À classer » sur la page principale, qui ne liste pas les mails elle-même", async () => {
  const body = await (await setup().request("/")).text();
  assert.match(body, /href="\/a-classer"[^>]*>À classer <span class="compteur">1<\/span>/);
  assert.doesNotMatch(body, /Demande d/);
});

test("page « À classer » : le mail et la liste des candidatures pour le rattacher", async () => {
  const body = await (await setup().request("/a-classer")).text();
  assert.match(body, /Demande d&#39;immersion|Demande d'immersion/);
  assert.match(body, /action="\/a-classer\/x1\/creer"/);
  assert.match(body, /<option value="c1">/);
});

test("créer une candidature : le mail quitte « À classer » et la candidature apparaît", async () => {
  const app = setup();
  const res = await post(app, "/a-classer/x1/creer");
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "/", "plus rien à classer : retour à la liste");
  const body = await (await app.request("/")).text();
  assert.match(body, /href="\/a-classer"[^>]*>À classer <span class="compteur">0<\/span>/, "bouton toujours visible");
  assert.match(await (await app.request("/a-classer")).text(), /0 mail à classer/);
  assert.match(listPart(body), /href="\/candidatures\/x1">[\s\S]*?Immersion SA/);
});

test("rattacher à une candidature existante", async () => {
  const app = setup();
  assert.equal((await post(app, "/a-classer/x1/rattacher", { candidature: "c1" })).status, 303);
  const detail = await (await app.request("/candidatures/c1")).text();
  assert.equal(detail.match(/class="evenement /g)?.length, 3);
});

test("rattacher à une candidature inconnue : refusé", async () => {
  assert.equal((await post(setup(), "/a-classer/x1/rattacher", { candidature: "nulle-part" })).status, 400);
});

test("ignorer : le mail disparaît sans créer de candidature", async () => {
  const app = setup();
  await post(app, "/a-classer/x1/ignorer");
  const body = await (await app.request("/")).text();
  assert.match(body, /À classer <span class="compteur">0<\/span>/);
  assert.match(body, /Toutes <span class="compteur">3<\/span>/);
});

test("formulaire envoyé depuis un autre site : rejeté (protection CSRF)", async () => {
  const res = await post(setup(), "/a-classer/x1/ignorer", {}, "https://site-malveillant.example");
  assert.equal(res.status, 403);
});

test("mail ou action inconnus : 404", async () => {
  const app = setup();
  assert.equal((await post(app, "/a-classer/inconnu/creer")).status, 404);
  assert.equal((await post(app, "/a-classer/x1/supprimer")).status, 404);
});
