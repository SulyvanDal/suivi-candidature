import assert from "node:assert/strict";
import { test } from "node:test";
import { openDb, saveOffer } from "./db.js";
import { jobPostingText, MAX_DESCRIPTION_CHARS, type PageResult, readOfferPage, readPendingPages } from "./offer-page.js";

// Pages fabriquées et faux accès web : aucune requête réelle.

const page = (jsonLd: object, type = "application/ld&#x2B;json") =>
  `<html><head><script type="application/ld+json">{"@type":"Organization","name":"Plateforme"}</script>` +
  `<script type="${type}">${JSON.stringify(jsonLd)}</script></head><body><nav>Menu</nav></body></html>`;

const POSTING = {
  "@context": "https://schema.org",
  "@type": "JobPosting",
  title: "Product Owner H/F",
  description: "<h2>Détail du poste</h2><p>Rédiger les user stories.<br/>Animer les rituels.</p><p><a href='https://x'>Postuler</a></p>",
  experienceRequirements: { "@type": "OccupationalExperienceRequirements", monthsOfExperience: 24 },
};

/** Faux fetch : renvoie la réponse donnée, avec l'adresse finale après redirection. */
const fakeFetch = (body: string, status = 200, finalUrl = "https://www.exemple.com/emplois/1.html") =>
  (async () => {
    const res = new Response(body, { status });
    Object.defineProperty(res, "url", { value: finalUrl });
    return res;
  }) as unknown as typeof fetch;

test("description : données JobPosting en texte, balise écrite « ld&#x2B;json », expérience ajoutée", () => {
  const text = jobPostingText(page(POSTING))!;
  assert.match(text, /Rédiger les user stories\.\nAnimer les rituels\./);
  assert.match(text, /Expérience demandée : 24 mois$/);
  assert.doesNotMatch(text, /Menu|https:\/\/x/, "ni la page autour, ni les liens");
});

test("description : trouvée aussi dans un tableau ou un @graph ; absente → null", () => {
  assert.ok(jobPostingText(page([{ "@type": "WebPage" }, POSTING], "application/ld+json")));
  assert.ok(jobPostingText(page({ "@graph": [{ "@type": "WebPage" }, POSTING] }, "application/ld+json")));
  assert.equal(jobPostingText(page({ "@type": "WebPage" })), null);
  assert.equal(jobPostingText("<script type='application/ld+json'>{pas du json</script>"), null);
});

test("description plafonnée", () => {
  const long = jobPostingText(page({ "@type": "JobPosting", description: "a".repeat(20_000) }))!;
  assert.equal(long.length, MAX_DESCRIPTION_CHARS + 1);
  assert.ok(long.endsWith("…"));
});

test("lecture d'une page : lue, non vérifiée (403, pas de description), à réessayer (429, 5xx, réseau)", async () => {
  assert.deepEqual(
    await readOfferPage("https://suivi/1", fakeFetch(page({ "@type": "JobPosting", description: "<p>Texte</p>" }))),
    { status: "lue", url: "https://www.exemple.com/emplois/1.html", description: "Texte" },
  );
  assert.deepEqual(await readOfferPage("https://suivi/1", fakeFetch("Accès refusé", 403)), {
    status: "non_verifiee",
    url: "https://www.exemple.com/emplois/1.html",
    error: "HTTP 403",
  });
  assert.deepEqual(await readOfferPage("https://suivi/1", fakeFetch("<html></html>")), {
    status: "non_verifiee",
    url: "https://www.exemple.com/emplois/1.html",
    error: "pas de description structurée",
  });  assert.equal((await readOfferPage("https://suivi/1", fakeFetch("", 429))).status, "a_reessayer");
  assert.equal((await readOfferPage("https://suivi/1", fakeFetch("", 503))).status, "a_reessayer");
  const offline = (async () => {
    throw new TypeError("fetch failed");
  }) as unknown as typeof fetch;
  assert.deepEqual(await readOfferPage("https://suivi/1", offline), { status: "a_reessayer", error: "erreur réseau" });
});

test("pages en attente : seules les annonces gardées et pas encore lues ; un échec passager est retenté", async () => {
  const db = openDb(":memory:");
  const alert = { gmailId: "al", receivedAt: new Date("2026-10-06") };
  const offer = (title: string, url: string) => ({ platform: "hellowork" as const, title, company: "Ex", location: null, contract: "CDI", url });
  saveOffer(db, offer("Product Owner", "u-lue"), { keep: true, rule: "poste-recherche" }, alert);
  saveOffer(db, offer("Chef de projet", "u-403"), { keep: true, rule: "poste-recherche" }, alert);
  saveOffer(db, offer("Développeur", "u-reseau"), { keep: true, rule: "poste-recherche" }, alert);
  saveOffer(db, offer("Data Scientist", "u-ecartee"), { keep: false, rule: "aucun-poste" }, alert);

  const asked: string[] = [];
  const results: Record<string, PageResult> = {
    "u-lue": { status: "lue", url: "https://hw/1", description: "Missions…" },
    "u-403": { status: "non_verifiee", url: "https://hw/2", error: "HTTP 403" },
    "u-reseau": { status: "a_reessayer", error: "erreur réseau" },
  };
  const read = async (url: string) => (asked.push(url), results[url]);

  assert.deepEqual(await readPendingPages(db, read, 0), { read: 1, unverified: 1, retry: 1 });
  assert.deepEqual(asked, ["u-lue", "u-403", "u-reseau"], "l'annonce écartée n'est pas ouverte");
  const rows = db.prepare("SELECT url, page_status, page_url, description, page_error FROM offers ORDER BY id").all();
  assert.deepEqual(
    rows.map((r) => ({ ...r })),
    [
      { url: "u-lue", page_status: "lue", page_url: "https://hw/1", description: "Missions…", page_error: null },
      { url: "u-403", page_status: "non_verifiee", page_url: "https://hw/2", description: null, page_error: "HTTP 403" },
      { url: "u-reseau", page_status: null, page_url: null, description: null, page_error: "erreur réseau" },
      { url: "u-ecartee", page_status: null, page_url: null, description: null, page_error: null },
    ],
  );

  // Passage suivant : seule l'annonce en échec passager est retentée.
  asked.length = 0;
  await readPendingPages(db, read, 0);
  assert.deepEqual(asked, ["u-reseau"]);
});
