import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { mailSystemPrompt } from "./classify.js";
import { type Config, ConfigError, loadConfig, parseConfig, startDate } from "./config.js";
import { replaceTerms, termsDiff } from "./config-init.js";
import { loadTitleRules, openDb } from "./db.js";
import { decide, loadCeilings, offerSystemPrompt, type OfferFacts, priorityOf } from "./offer-judge.js";
import { createApp } from "./ui/app.js";

// Configurations : le modèle versionné (celle de Sulyvan, sans donnée personnelle) et une
// configuration fictive d'une autre recherche.

const EXEMPLE = loadConfig("config/exemple.json");

const AUTRE: Config = {
  debutRecherche: "2026-10-05",
  familles: [
    { cle: "voyage_tourisme", nom: "Voyage et tourisme", definition: "travel manager, chargé de voyages d'affaires", plafondAns: 2 },
    { cle: "commercial_marketing", nom: "Commercial et marketing", definition: "account manager, business developer", plafondAns: 2 },
  ],
  horsCible: "comptable, développeur…",
  mails: { demarches: [], autre: [], horsSujet: [] },
  motsClesDeDepart: { postes: ["travel manager", "account manager"], exclus: ["stage", "intérim"] },
  criteres: [
    { cle: "apprentissage", libelle: "apprentissage", points: 3, question: "true si l'annonce propose explicitement un contrat d'apprentissage." },
    {
      cle: "contrat",
      question: "type de contrat proposé.",
      choix: [
        { valeur: "alternance", description: "apprentissage ou professionnalisation", libelle: "alternance", points: 1 },
        { valeur: "cdi_cdd", description: "CDI ou CDD", points: 0 },
        { valeur: "autre", description: "autre ou non précisé", points: 0 },
      ],
    },
    { cle: "accueil", libelle: "surtout de l'accueil", familles: ["voyage_tourisme"], points: -2, question: "true si le poste consiste surtout en accueil." },
    { cle: "agence_interim", libelle: "agence d'intérim", effet: "ecarter", question: "true si l'annonce vient d'une agence d'intérim." },
    { cle: "debutant", libelle: "débutant accepté", experienceMaxAns: 0, points: 1 },
  ],
  priorite: {
    seuil: 4,
    lieux: [
      { nom: "Paris", motif: "paris|\\b75\\b", points: 1 },
      { nom: "Bordeaux", motif: "bordeaux", points: 1 },
    ],
  },
};

const tmp = mkdtempSync(join(tmpdir(), "suivi-config-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

test("modèle versionné : consignes envoyées à Claude identiques à celles d'avant la configuration", () => {
  assert.equal(mailSystemPrompt(EXEMPLE.mails), readFileSync("src/testdata/consignes-mails.txt", "utf8"));
  // Annonces : seule la ligne banque / assurance change (#37) : l'exception « sauf startup », qui
  // était dans le code, passe dans la question posée à Claude.
  const before = readFileSync("src/testdata/consignes-annonces.txt", "utf8").split("\n");
  const after = offerSystemPrompt(EXEMPLE).split("\n");
  assert.equal(after.length, before.length);
  const changed = after.map((line, i) => [before[i], line]).filter(([b, a]) => a !== b);
  assert.deepEqual(changed, [
    [
      "- banque_assurance : true si l'employeur réel est une banque, une assurance ou une mutuelle, ou si la mission s'y déroule.",
      "- banque_assurance : true si l'employeur réel est une banque, une assurance ou une mutuelle, ou si la mission s'y déroule ; false s'il s'agit d'une startup ou d'une scale-up.",
    ],
  ]);
});

test("autre recherche : ses critères dans les consignes, choix décrits détaillés, critère déduit absent", () => {
  const prompt = offerSystemPrompt(AUTRE);
  assert.match(prompt, /- apprentissage : true si l'annonce propose explicitement un contrat d'apprentissage\./);
  assert.match(
    prompt,
    /- contrat : type de contrat proposé\.\n  - alternance : apprentissage ou professionnalisation ;\n  - cdi_cdd : CDI ou CDD ;\n  - autre : autre ou non précisé\.\n/,
  );
  assert.doesNotMatch(prompt, /debutant|stack_proche|techno_niche|banque_assurance/);
  assert.match(prompt, /- agence_interim : .*\n- justification :/);
});

test("autre recherche : points de ses critères, lieux multiples, critère « écarter » et critère limité à une famille", () => {
  const facts = (f: Partial<OfferFacts>): OfferFacts => ({
    type_poste: "commercial_marketing",
    experience_min_ans: null,
    profil_senior: false,
    apprentissage: false,
    contrat: "cdi_cdd",
    accueil: false,
    agence_interim: false,
    justification: "",
    ...f,
  });
  assert.deepEqual(priorityOf(facts({ apprentissage: true, contrat: "alternance", experience_min_ans: 0 }), "Paris 8e - 75", AUTRE), {
    level: 1,
    points: 6,
    details: ["Paris +1", "apprentissage +3", "alternance +1", "débutant accepté +1"],
  });
  // « accueil » ne vaut que pour la famille voyage et tourisme.
  assert.equal(priorityOf(facts({ accueil: true }), null, AUTRE)?.points, 0);
  assert.equal(priorityOf(facts({ type_poste: "voyage_tourisme", accueil: true }), "Bordeaux", AUTRE)?.points, -1);
  assert.deepEqual(decide(facts({ agence_interim: true }), { commercial_marketing: 2 }, AUTRE.criteres), {
    decision: "ecarter",
    raison: "hors_cible",
  });
  assert.equal(decide(facts({}), { commercial_marketing: 2 }, AUTRE.criteres).decision, "garder");
});

test("autre recherche : familles, exemples hors cible et règles des mails viennent de sa configuration", () => {
  const offers = offerSystemPrompt(AUTRE);
  assert.match(offers, /  - voyage_tourisme : travel manager, chargé de voyages d'affaires ;\n  - commercial_marketing : account manager/);
  assert.match(offers, /même si l'intitulé y ressemble \(comptable, développeur…\)/);
  // Section des familles seulement : les critères de priorité, encore propres à Sulyvan, relèvent de #37.
  const familiesSection = offers.slice(offers.indexOf("- type_poste :"), offers.indexOf("- experience_min_ans"));
  assert.doesNotMatch(familiesSection, /Product Owner|produit_projet|developpeur/);

  const mails = mailSystemPrompt(AUTRE.mails);
  assert.match(mails, /auprès de cette entreprise \(candidature…\)/);
  // Ni immersion ni « formation ou alternance hors sujet » : règles propres à Sulyvan.
  assert.doesNotMatch(mails, /immersion|alternance/);
  assert.match(mails, /récapitulatifs d'activité, rendez-vous avec un conseiller France Travail/);
});

test("date de début : minuit à Paris, heure d'été comme d'hiver", () => {
  assert.equal(startDate(EXEMPLE).toISOString(), "2026-05-31T22:00:00.000Z");
  assert.equal(startDate({ ...AUTRE, debutRecherche: "2026-12-01" }).toISOString(), "2026-11-30T23:00:00.000Z");
});

test("configuration invalide : message clair, avec l'endroit de chaque erreur", () => {
  const errorOf = (raw: unknown) => {
    try {
      parseConfig(raw, "test.json");
    } catch (err) {
      assert.ok(err instanceof ConfigError);
      return err.message;
    }
    assert.fail("configuration acceptée à tort");
  };
  const message = errorOf({
    ...AUTRE,
    debutRecherche: "05/10/2026",
    familles: [{ ...AUTRE.familles[0], cle: "autre", plafondAns: -1 }, AUTRE.familles[1]],
    inconnu: true,
  });
  assert.match(message, /^test\.json invalide :/);
  assert.match(message, /debutRecherche : format AAAA-MM-JJ attendu/);
  assert.match(message, /familles\.0\.cle : « autre » est réservé/);
  assert.match(message, /familles\.0\.plafondAns/);
  assert.match(message, /inconnu/);
  assert.match(errorOf({ ...AUTRE, familles: [AUTRE.familles[0]] }), /familles : exactement 2 familles/);
  assert.match(errorOf({ ...AUTRE, familles: [AUTRE.familles[0], AUTRE.familles[0]] }), /clés différentes/);
});

test("critères invalides : famille inconnue, clé en double ou réservée, ni points ni effet, motif de lieu invalide", () => {
  const errorOf = (patch: Partial<Config>) => {
    try {
      parseConfig({ ...AUTRE, ...patch });
    } catch (err) {
      assert.ok(err instanceof ConfigError);
      return err.message;
    }
    assert.fail("configuration acceptée à tort");
  };
  const yesNo = { cle: "x", libelle: "x", question: "true si…", points: 1 };
  assert.match(errorOf({ criteres: [{ ...yesNo, familles: ["inconnue"] }] }), /criteres\.0\.familles : famille « inconnue » inconnue/);
  assert.match(errorOf({ criteres: [yesNo, yesNo] }), /criteres\.1\.cle : clé « x » en double/);
  assert.match(errorOf({ criteres: [{ ...yesNo, cle: "type_poste" }] }), /clé réservée/);
  assert.match(errorOf({ criteres: [{ cle: "x", libelle: "x", question: "true si…" } as never] }), /soit points, soit effet/);
  assert.match(errorOf({ priorite: { seuil: 4, lieux: [{ nom: "x", motif: "(", points: 1 }] } }), /expression régulière invalide/);
});

test("fichier absent ou JSON invalide : message qui dit quoi faire", () => {
  assert.throws(() => loadConfig(join(tmp, "absent.json")), /copier config\/exemple\.json/);
  const bad = join(tmp, "mauvais.json");
  writeFileSync(bad, "{ pas du json");
  assert.throws(() => loadConfig(bad), /n'est pas un JSON valide/);
});

test("config:initialiser : différences affichées, puis mots-clés de la configuration écrits en base", () => {
  const db = openDb(":memory:");
  // Une base neuve contient les mots-clés de la migration 7 (ceux de Sulyvan).
  const diff = termsDiff(db, AUTRE);
  assert.deepEqual(diff.find((d) => d.kind === "poste")?.added, ["travel manager", "account manager"]);
  assert.ok(diff.find((d) => d.kind === "exclu")?.removed.includes("alternance"));

  replaceTerms(db, AUTRE);
  assert.deepEqual(loadTitleRules(db), { keep: ["account manager", "travel manager"], exclude: ["intérim", "stage"] });
  assert.deepEqual(termsDiff(db, AUTRE), []);
});

test("interface : date de début et plafonds par famille tirés de la configuration", async () => {
  const db = openDb(":memory:");
  const sulyvan = createApp(db, () => new Date("2026-10-14T12:00:00Z"), EXEMPLE);
  assert.match(await (await sulyvan.request("/")).text(), /candidatures depuis le 1<sup>er<\/sup> juin/);

  const app = createApp(db, () => new Date("2026-10-14T12:00:00Z"), AUTRE);
  assert.match(await (await app.request("/")).text(), /candidatures depuis le 5 octobre/);
  const settings = await (await app.request("/offres/reglages")).text();
  assert.match(settings, /Voyage et tourisme \(années\)<\/span\s*><input type="number" name="plafond_voyage_tourisme"[^>]*value="2"/);
  assert.match(settings, /name="plafond_commercial_marketing"/);
  assert.doesNotMatch(settings, /Produit \/ projet/);

  const res = await app.request("/offres/reglages/plafonds", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: "http://localhost" },
    body: new URLSearchParams({ plafond_voyage_tourisme: "3", plafond_commercial_marketing: "1,5" }).toString(),
  });
  assert.equal(res.status, 303);
  assert.deepEqual(loadCeilings(db, AUTRE.familles), { voyage_tourisme: 3, commercial_marketing: 1.5 });
});
