import assert from "node:assert/strict";
import { test } from "node:test";
import { extractOffers, platformOf, titleFilter } from "./offers.js";

// Alertes fabriquées, au format observé (texte du HTML avec les liens complets).

const HELLOWORK = `https://emails.hellowork.com/clic/a https://emails.hellowork.com/clic/b

Hello Camille !

2 nouvelles offres

correspondent à votre alerte.Product owner

Product Owner Digital H/F [https://emails.hellowork.com/clic/1]

ExempleSuper recruteur

Paris - 75

CDI

45 000 - 50 000 € / an

Voir l’offre [https://emails.hellowork.com/clic/1bis]

Chef de Projet H/F [https://emails.hellowork.com/clic/2]

Intérim Plus

Lyon - 69

Intérim

Voir l’offre [https://emails.hellowork.com/clic/2bis]

Voir toutes les offres [https://emails.hellowork.com/clic/tout]`;

const INDEED = `Bonjour A,

Votre parcours pourrait correspondre pour l'offre d'emploi suivante : Chef de projet (H/F). Envoyez votre candidature rapidement si vous êtes intéressé(e).

Voir l'emploi [https://cts.indeed.com/v3/voir]

CHEF DE PROJET (H/F) [https://cts.indeed.com/v3/titre]

Exemple SA

Bordeaux (33)

SALAIRE

De 42 000 € à 55 000 € par an

TYPE DE POSTE

CDI`;

const WTTJ = `Un nouveau job pour vos entreprises favorites

Exemple [http://t.welcometothejungle.com/1] Voir le profil [http://t.welcometothejungle.com/2]

Un nouveau job

Exemple [http://t.welcometothejungle.com/3] Product Builder - Outils internes (CDI) [http://t.welcometothejungle.com/4] CDI - Bordeaux

TOUJOURS INTÉRESSÉ.E ?`;

test("plateforme d'après l'expéditeur ; inconnue (Job Watch) → null", () => {
  assert.equal(platformOf("Hellowork Alert <alerte@emails.hellowork.com>"), "hellowork");
  assert.equal(platformOf("Indeed <donotreply@match.indeed.com>"), "indeed");
  assert.equal(platformOf("Welcome to the Jungle <alerts@welcometothejungle.com>"), "welcome-to-the-jungle");
  assert.equal(platformOf("Job Watch <noreply@jobwatch.ch>"), null);
});

test("Hellowork : chaque annonce avec entreprise, lieu, contrat ; salaire facultatif", () => {
  assert.deepEqual(extractOffers("hellowork", HELLOWORK), [
    {
      platform: "hellowork",
      title: "Product Owner Digital H/F",
      company: "Exemple",
      location: "Paris - 75",
      contract: "CDI",
      url: "https://emails.hellowork.com/clic/1",
    },
    {
      platform: "hellowork",
      title: "Chef de Projet H/F",
      company: "Intérim Plus",
      location: "Lyon - 69",
      contract: "Intérim",
      url: "https://emails.hellowork.com/clic/2",
    },
  ]);
});

test("Indeed : l'annonce unique, intitulé repris de la phrase d'introduction", () => {
  assert.deepEqual(extractOffers("indeed", INDEED), [
    {
      platform: "indeed",
      title: "Chef de projet (H/F)",
      company: "Exemple SA",
      location: "Bordeaux (33)",
      contract: "CDI",
      url: "https://cts.indeed.com/v3/titre",
    },
  ]);
});

test("Welcome to the Jungle : entreprise, intitulé, contrat et lieu sur une ligne ; « Voir le profil » ignoré", () => {
  assert.deepEqual(extractOffers("welcome-to-the-jungle", WTTJ), [
    {
      platform: "welcome-to-the-jungle",
      title: "Product Builder - Outils internes (CDI)",
      company: "Exemple",
      location: "Bordeaux",
      contract: "CDI",
      url: "http://t.welcometothejungle.com/4",
    },
  ]);
});

test("filtre des intitulés : exclusion dans l'intitulé ou le contrat, accents ignorés, mots entiers", () => {
  const rules = { keep: ["product owner", "développeu*", "ops & product"], exclude: ["stage", "intérim", "senior"] };
  const strict = titleFilter(rules, "garder-exclure");
  const loose = titleFilter(rules, "exclusion");

  assert.deepEqual(strict({ title: "Developpeuse React H/F", contract: "CDI" }), {
    keep: true,
    rule: "poste-recherche",
    match: "developpeuse",
  });
  assert.equal(strict({ title: "Ops & Product Manager", contract: null }).keep, true);
  assert.deepEqual(strict({ title: "Product Owner Sénior", contract: "CDI" }), { keep: false, rule: "exclu", match: "senior" });
  assert.deepEqual(strict({ title: "Chef de Projet", contract: "Intérim" }), { keep: false, rule: "exclu", match: "interim" });
  assert.equal(strict({ title: "Data Scientist", contract: "CDI" }).rule, "aucun-poste");
  // « * » au milieu d'une expression.
  const coord = titleFilter({ keep: ["coordinat* de projet*"], exclude: [] }, "garder-exclure");
  assert.equal(coord({ title: "Coordinateur de projet F/H", contract: null }).keep, true);
  assert.equal(coord({ title: "Coordinatrice de projets digitaux", contract: null }).keep, true);
  assert.equal(coord({ title: "Coordinateur logistique", contract: null }).keep, false);
  // « stage » en mot entier seulement : « Stagecoach » n'est pas exclu.
  assert.equal(loose({ title: "Data Scientist Stagecoach", contract: "CDI" }).keep, true);
  assert.equal(loose({ title: "Stage Product Owner", contract: null }).keep, false);
});
