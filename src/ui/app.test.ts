import assert from "node:assert/strict";
import { test } from "node:test";
import { rebuildCandidatures } from "../candidatures.js";
import { getSetting, loadTitleRules, openDb, PROFILE_KEY, saveMailResult, saveOffer, saveSyncState } from "../db.js";
import { loadCeilings } from "../offer-judge.js";
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

test("page principale : date de la dernière synchronisation", async () => {
  const db = openDb(":memory:");
  const app = createApp(db, () => NOW);
  assert.match(await (await app.request("/")).text(), /Jamais synchronisé/);
  saveSyncState(db, "123");
  assert.match(await (await app.request("/")).text(), /Mis à jour le .+ à \d\d:\d\d/);
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

// --- Édition (#18) ---

test("modifier : seules les informations changées deviennent des corrections, signalées « modifié »", async () => {
  const app = setup();
  const form = { company: "Exemple", jobTitle: "Product Owner", location: "Bordeaux", channel: "", offerUrl: "", status: "Envoyée" };
  assert.equal((await post(app, "/candidatures/a1/modifier", form)).status, 303);

  const corrections = await (await app.request("/corrections")).text();
  assert.equal(corrections.match(/class="correction"/g)?.length, 1, "seul le lieu a changé");
  assert.match(corrections, /lieu → Bordeaux/);

  const detail = await (await app.request("/candidatures/a1")).text();
  assert.match(detail, /Bordeaux/);
  assert.match(detail, /Lieu <span class="modifie"/);
});

test("modifier le statut : affiché et signalé comme modifié", async () => {
  const app = setup();
  const form = { company: "Exemple", jobTitle: "Product Owner", location: "", channel: "", offerUrl: "", status: "Entretien" };
  await post(app, "/candidatures/a1/modifier", form);
  const detail = await (await app.request("/candidatures/a1")).text();
  assert.match(detail, /badge-entretien/);
});

test("formulaire de modification : pré-rempli avec le statut courant", async () => {
  const body = await (await setup().request("/candidatures/c1/modifier")).text();
  assert.match(body, /name="company" value="Piège"/);
  assert.match(body, /<option value="Refus" selected>/);
});

test("« ce n'est pas une candidature » puis annulation depuis la page Corrections", async () => {
  const app = setup();
  assert.equal((await post(app, "/candidatures/c1/pas-candidature")).status, 303);
  assert.doesNotMatch(listPart(await (await app.request("/")).text()), /Piège/);

  const corrections = await (await app.request("/corrections")).text();
  assert.match(corrections, /Piège · Product Owner : ce n&#39;est pas une candidature|Piège · Product Owner : ce n'est pas une candidature/);
  const id = corrections.match(/\/corrections\/(\d+)\/annuler/)![1];

  assert.equal((await post(app, `/corrections/${id}/annuler`)).status, 303);
  assert.match(listPart(await (await app.request("/")).text()), /Piège/);
  assert.match(await (await app.request("/corrections")).text(), /Aucune correction/);
});

test("annuler une correction inconnue : 404", async () => {
  assert.equal((await post(setup(), "/corrections/999/annuler")).status, 404);
});

// --- Offres à regarder (#24) ---------------------------------------------------------------------

function offersSetup() {
  const db = openDb(":memory:");
  const add = (title: string, fields: Record<string, unknown>, day = "10-04") => {
    saveOffer(
      db,
      { platform: "hellowork", title, company: "Exemple", location: "Paris", contract: "CDI", url: `https://suivi.example/${title}` },
      { keep: fields.title_keep !== 0, rule: fields.title_keep === 0 ? "exclu" : "poste-recherche" },
      { gmailId: "al", receivedAt: new Date(`2026-${day}T08:00:00Z`) },
    );
    const sets = Object.keys(fields).filter((k) => k !== "title_keep");
    if (sets.length) {
      db.prepare(`UPDATE offers SET ${sets.map((k) => `${k} = ?`).join(", ")} WHERE title = ?`).run(
        ...sets.map((k) => fields[k] as string | number | null),
        title,
      );
    }
  };
  add("Product Owner", { page_status: "lue", page_url: "https://www.hellowork.com/fr-fr/emplois/1.html", verdict: "garder", justification: "Junior accepté." }, "10-05");
  add("Chef de projet Indeed", { page_status: "non_verifiee" });
  add("PO Senior", { page_status: "lue", verdict: "ecarter", justification: "8 ans demandés." });
  add("Stage PO", { title_keep: 0 });
  add("PMO", { page_status: "lue" }); // pas encore jugée
  add("Business Analyst", { page_status: "lue", verdict: "garder", ignored_at: "2026-10-05T10:00:00Z" });
  return { db, app: createApp(db, () => NOW) };
}

test("offres : gardées par Claude et non vérifiées seulement, la plus récente en premier, compteurs", async () => {
  const { app } = offersSetup();
  const body = await (await app.request("/offres")).text();

  const titles = [...body.matchAll(/<span class="entreprise">([^<]+)<\/span>/g)].map((m) => m[1]);
  assert.deepEqual(titles, ["Product Owner", "Chef de projet Indeed"]);
  assert.match(body, /Junior accepté\./);
  assert.match(body, /non vérifiée/);
  assert.equal((body.match(/class="pastille pastille-nouveau"/g) ?? []).length, 2);
  // « Consulter » retire la pastille sur place (clic, Ctrl-clic, clic molette), sans rechargement.
  assert.match(body, /hx-on:click="this\.closest\(&#39;li&#39;\)\.querySelector\(&#39;\.pastille-nouveau&#39;\)\?\.remove\(\)"/);
  assert.match(body, /hx-on:auxclick=/);
  assert.match(body, /2 annonces écartées ces 7 derniers jours\s+\(1 par l'intitulé, 1 par Claude\) · 1 en cours de tri/);

  // Bouton de la page principale : nombre de nouvelles offres.
  const home = await (await app.request("/")).text();
  assert.match(home, /Offres <span class="compteur">2<\/span>/);
  assert.match(home, /title="2 offres à regarder, dont 2 nouvelles"/);
  assert.doesNotMatch(home, /bouton-offres sans-nouvelle/);
});

test("offres : « Consulter » marque l'annonce vue et ouvre l'adresse directe (sinon le lien de l'alerte)", async () => {
  const { db, app } = offersSetup();
  const id = (title: string) => (db.prepare("SELECT id FROM offers WHERE title = ?").get(title) as { id: number }).id;

  const res = await post(app, `/offres/${id("Product Owner")}/consulter`);
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "https://www.hellowork.com/fr-fr/emplois/1.html");
  const res2 = await post(app, `/offres/${id("Chef de projet Indeed")}/consulter`);
  assert.equal(res2.headers.get("location"), "https://suivi.example/Chef de projet Indeed");

  const body = await (await app.request("/offres")).text();
  assert.doesNotMatch(body, /class="pastille pastille-nouveau"/);
  // Tout est consulté : le bouton garde le nombre d'offres mais n'est plus mis en avant.
  const home = await (await app.request("/")).text();
  assert.match(home, /bouton-offres sans-nouvelle/);
  assert.match(home, /Offres <span class="compteur">2<\/span>/);
  assert.equal((await post(app, "/offres/9999/consulter")).status, 404);
});

test("offres : « Ignorer » retire l'annonce ; formulaire d'un autre site refusé", async () => {
  const { db, app } = offersSetup();
  const id = (db.prepare("SELECT id FROM offers WHERE title = 'Product Owner'").get() as { id: number }).id;

  assert.equal((await post(app, `/offres/${id}/ignorer`, {}, "https://malveillant.example")).status, 403);
  assert.match(await (await app.request("/offres")).text(), /Product Owner/);

  // Seule la liste est remplacée (pas de retour en haut de page, contrairement à hx-boost).
  const page = await (await app.request("/offres")).text();
  assert.match(page, new RegExp(`hx-post="/offres/${id}/ignorer"\\s+hx-target="#offres-liste"`));
  assert.doesNotMatch(page, /hx-boost/);

  const res = await post(app, `/offres/${id}/ignorer`);
  assert.equal(res.status, 303);
  assert.doesNotMatch(await (await app.request("/offres")).text(), />Product Owner</);
});

test("offres : seules les adresses web sont ouvertes", async () => {
  const { db, app } = offersSetup();
  db.prepare("UPDATE offers SET page_url = 'javascript:alert(1)' WHERE title = 'Product Owner'").run();
  const id = (db.prepare("SELECT id FROM offers WHERE title = 'Product Owner'").get() as { id: number }).id;
  assert.equal((await post(app, `/offres/${id}/consulter`)).status, 400);
});

// --- Réglages des offres (#25) -------------------------------------------------------------------

test("réglages : ajout et retrait d'un terme, terme vide refusé", async () => {
  const { db, app } = offersSetup();
  assert.match(await (await app.request("/offres/reglages")).text(), /chef de projet\*/);

  assert.equal((await post(app, "/offres/reglages/termes/ajouter", { kind: "poste", term: "  coordinat*   de projet* " })).status, 303);
  assert.ok(loadTitleRules(db).keep.includes("coordinat* de projet*"));
  await post(app, "/offres/reglages/termes/retirer", { kind: "exclu", term: "senior" });
  assert.ok(!loadTitleRules(db).exclude.includes("senior"));

  const refused = await post(app, "/offres/reglages/termes/ajouter", { kind: "exclu", term: "   " });
  assert.equal(refused.headers.get("location"), "/offres/reglages?message=terme");
  assert.equal((await post(app, "/offres/reglages/termes/ajouter", { kind: "autre", term: "x" })).status, 400);
});

test("réglages : profil enregistré, profil vide refusé", async () => {
  const { db, app } = offersSetup();
  await post(app, "/offres/reglages/profil", { profil: "Développeur junior React." });
  assert.equal(getSetting(db, PROFILE_KEY), "Développeur junior React.");
  const refused = await post(app, "/offres/reglages/profil", { profil: "  " });
  assert.equal(refused.headers.get("location"), "/offres/reglages?message=profil");
  assert.equal(getSetting(db, PROFILE_KEY), "Développeur junior React.");
});

test("réglages : plafond modifié → décisions déjà prises recalculées sans Claude ; valeur invalide refusée", async () => {
  const { db, app } = offersSetup();
  // « PO Senior » a été écarté car il exige 5 ans (plafond 4).
  db.prepare("UPDATE offers SET job_type = 'produit_projet', experience_min = 5, senior = 0, niche_tech = 0 WHERE title = 'PO Senior'").run();
  assert.doesNotMatch(await (await app.request("/offres")).text(), />PO Senior</);

  await post(app, "/offres/reglages/plafonds", { produit_projet: "5", developpeur: "2,5" });
  assert.deepEqual(loadCeilings(db), { produitProjet: 5, developpeur: 2.5 });
  assert.match(await (await app.request("/offres")).text(), />PO Senior</);

  const refused = await post(app, "/offres/reglages/plafonds", { produit_projet: "-1", developpeur: "2" });
  assert.equal(refused.headers.get("location"), "/offres/reglages?message=plafond");
  assert.equal((await post(app, "/offres/reglages/plafonds", { produit_projet: "", developpeur: "2" })).headers.get("location"), "/offres/reglages?message=plafond");
  assert.deepEqual(loadCeilings(db), { produitProjet: 5, developpeur: 2.5 });
});

test("réglages : formulaire venant d'un autre site refusé", async () => {
  const { db, app } = offersSetup();
  const res = await post(app, "/offres/reglages/profil", { profil: "piège" }, "https://malveillant.example");
  assert.equal(res.status, 403);
  assert.equal(getSetting(db, PROFILE_KEY), null);
});

// --- Prioritaires (#27) --------------------------------------------------------------------------

test("prioritaire : l'étoile fait passer l'annonce en tête ; un second clic la retire", async () => {
  const { db, app } = offersSetup();
  const id = (db.prepare("SELECT id FROM offers WHERE title = 'Chef de projet Indeed'").get() as { id: number }).id;
  const titles = async () =>
    [...(await (await app.request("/offres")).text()).matchAll(/<span class="entreprise">([^<]+)<\/span>/g)].map((m) => m[1]);

  assert.deepEqual(await titles(), ["Product Owner", "Chef de projet Indeed"]);
  const res = await post(app, `/offres/${id}/prioritaire`);
  assert.equal(res.status, 303);
  assert.deepEqual(await titles(), ["Chef de projet Indeed", "Product Owner"]);
  const body = await (await app.request("/offres")).text();
  assert.match(body, /<h2 class="offres-section">Prioritaires<\/h2>/);
  assert.match(body, /aria-pressed="true"/);

  await post(app, `/offres/${id}/prioritaire`);
  assert.deepEqual(await titles(), ["Product Owner", "Chef de projet Indeed"]);
  assert.doesNotMatch(await (await app.request("/offres")).text(), /Prioritaires/);
  assert.equal((await post(app, "/offres/9999/prioritaire")).status, 404);
});

test("prioritaire : une annonce prioritaire ignorée disparaît ; formulaire d'un autre site refusé", async () => {
  const { db, app } = offersSetup();
  const id = (db.prepare("SELECT id FROM offers WHERE title = 'Product Owner'").get() as { id: number }).id;

  assert.equal((await post(app, `/offres/${id}/prioritaire`, {}, "https://malveillant.example")).status, 403);
  await post(app, `/offres/${id}/prioritaire`);
  await post(app, `/offres/${id}/ignorer`);
  assert.doesNotMatch(await (await app.request("/offres")).text(), />Product Owner</);
});
