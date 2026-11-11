import assert from "node:assert/strict";
import { test } from "node:test";
import { parseClosedOffers } from "./closed-offers.js";

// Textes fabriqués sur le modèle des mails Hellowork (noms inventés).

const single = `Suivi de votre candidature

Hello Camille !

Du nouveau pour votre candidature :

Product Owner Data & IA H/F dans l’entreprise Exemple.io Conseil.

L'offre n'est plus disponible sur notre site. Avez-vous été recruté pour ce poste ?`;

const grouped = `Suivi de vos candidatures

Du nouveau pour vos candidatures :

Dans les entreprises Alpha Services, Beta et Gamma Bordeaux.

Les offres ne sont plus disponibles sur notre site.`;

test("un poste : intitulé et entreprise, apostrophes droites ou typographiques, points dans le nom", () => {
  assert.deepEqual(parseClosedOffers({ subject: "L'offre de Product Owner Data & IA H/F n'est plus disponible", text: single }), [
    { jobTitle: "Product Owner Data & IA H/F", company: "Exemple.io Conseil" },
  ]);
});

test("mail groupé : les entreprises seulement", () => {
  assert.deepEqual(parseClosedOffers({ subject: "Des offres auxquelles vous avez postulé ne sont plus disponibles", text: grouped }), [
    { company: "Alpha Services", jobTitle: null },
    { company: "Beta", jobTitle: null },
    { company: "Gamma Bordeaux", jobTitle: null },
  ]);
});

test("corps au format inconnu : l'intitulé de l'objet, sinon rien", () => {
  assert.deepEqual(parseClosedOffers({ subject: "L’offre de Chef de projet H/F n'est plus disponible", text: "Texte réorganisé." }), [
    { company: null, jobTitle: "Chef de projet H/F" },
  ]);
  assert.deepEqual(parseClosedOffers({ subject: "Ces offres ne sont plus disponibles", text: "Texte réorganisé." }), []);
});
