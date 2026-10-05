import assert from "node:assert/strict";
import { test } from "node:test";
import { filterMail } from "./filter.js";

// Mails fabriqués pour les tests : aucun vrai mail dans le dépôt.

const mail = (subject: string, text = "", from = "Quelqu'un <contact@exemple.com>") => ({
  from,
  subject,
  text,
});

test("accusé de réception d'un ATS : gardé", () => {
  const d = filterMail(mail("Nous avons reçu votre candidature", "Bonjour, merci d'avoir postulé."));
  assert.deepEqual(d, { keep: true, rule: "mot-cle", match: "candidature" });
});

test("mot-clé dans le texte seulement : gardé", () => {
  const d = filterMail(mail("Suite à notre échange", "Je vous propose un entretien jeudi."));
  assert.equal(d.keep, true);
  assert.equal(d.match, "entretien");
});

test("majuscules ignorées, terminaisons acceptées (y compris accentuées)", () => {
  assert.equal(filterMail(mail("Vous avez POSTULÉ chez nous")).match, "postulé");
  assert.equal(filterMail(mail("Nouvel ENTRETIEN")).match, "entretien");
  assert.equal(filterMail(mail("Your application for Product Owner")).match, "your application");
  assert.equal(filterMail(mail("Ne pas donner  suite")).match, "donner  suite");
});

test("mots entiers uniquement : « posté » ou « CVE » ne déclenchent rien", () => {
  assert.deepEqual(filterMail(mail("Colis posté hier", "Correctif CVE-2026-1234")), {
    keep: false,
    rule: "aucun-mot-cle",
  });
});

test("mail envoyé par moi : mêmes règles", () => {
  const d = filterMail(
    mail("Candidature spontanée – Product Owner", "Veuillez trouver mon CV.", "Moi <moi@exemple.com>"),
  );
  assert.equal(d.keep, true);
});

test("mail non distribué : écarté, par l'objet ou par l'expéditeur standard", () => {
  assert.equal(filterMail(mail("Undeliverable: Re: Votre candidature")).rule, "non-distribue");
  assert.equal(
    filterMail(mail("Échec", "candidature", "Mail Delivery Subsystem <mailer-daemon@googlemail.com>")).rule,
    "non-distribue",
  );
});

test("offre plus disponible : écartée avec sa propre règle", () => {
  const d = filterMail(mail("L'offre de Chef de Projet H/F n'est plus disponible", "Votre candidature…"));
  assert.deepEqual(d, { keep: false, rule: "offre-fermee" });
});

test("alertes d'offres : écartées même si elles parlent de candidature", () => {
  for (const subject of [
    "Sulyvan, 7 nouvelles offres d'emploi rien que pour vous !",
    "Sulyvan, Atos recrute un Chef de Projet H/F",
    "Les nouveautés du jour pour Little Worker",
    "Votre sélection d’offres de la semaine",
  ]) {
    assert.equal(filterMail(mail(subject, "Postulez vite, envoyez votre candidature")).rule, "alerte-offres", subject);
  }
  const indeed = filterMail(
    mail("Product Owner H/F – Assystem", "Votre parcours pourrait correspondre pour l'offre d'emploi suivante : …"),
  );
  assert.equal(indeed.rule, "alerte-offres");
});

test("mail sans rapport : écarté", () => {
  assert.deepEqual(filterMail(mail("Confirmation de commande", "Merci pour votre achat.")), {
    keep: false,
    rule: "aucun-mot-cle",
  });
});
