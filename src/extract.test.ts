import assert from "node:assert/strict";
import { test } from "node:test";
import type { gmail_v1 } from "@googleapis/gmail";
import { extractMail } from "./extract.js";

// Mails fabriqués pour les tests : aucun vrai mail dans le dépôt.

type Part = gmail_v1.Schema$MessagePart;

function textPart(mimeType: string, content: string, charset = "utf-8"): Part {
  const encoding = charset.toLowerCase() === "iso-8859-1" ? "latin1" : "utf8";
  return {
    mimeType,
    headers: [{ name: "Content-Type", value: `${mimeType}; charset="${charset}"` }],
    body: { data: Buffer.from(content, encoding).toString("base64url") },
  };
}

function multipart(mimeType: string, ...parts: Part[]): Part {
  return { mimeType, parts };
}

function message(payload: Part): gmail_v1.Schema$Message {
  return {
    id: "m1",
    internalDate: String(Date.UTC(2026, 9, 5, 8, 30)),
    payload: {
      ...payload,
      headers: [
        ...(payload.headers ?? []),
        { name: "From", value: "Recrutement <jobs@exemple.com>" },
        { name: "To", value: "moi@exemple.com" },
        { name: "Subject", value: "Votre candidature" },
      ],
    },
  };
}

const LONG_PLAIN = "Bonjour,\n\nNous avons bien reçu votre candidature. ".repeat(6);

test("en-têtes et date de réception", () => {
  const mail = extractMail(message(textPart("text/plain", "Bonjour")));
  assert.equal(mail.id, "m1");
  assert.equal(mail.from, "Recrutement <jobs@exemple.com>");
  assert.equal(mail.to, "moi@exemple.com");
  assert.equal(mail.subject, "Votre candidature");
  assert.equal(mail.date.toISOString(), "2026-10-05T08:30:00.000Z");
});

test("texte seul, avec espaces et lignes vides normalisés", () => {
  const mail = extractMail(message(textPart("text/plain", "  Bonjour,\r\n\r\n\r\n\r\nÀ bientôt    ! ")));
  assert.equal(mail.text, "Bonjour,\n\nÀ bientôt !");
});

test("HTML seul : converti en texte, liens gardés, images ignorées", () => {
  const html = `<p>Bonjour&nbsp;Sulyvan,</p><img src="logo.png" alt="Logo">
    <p>Voir <a href="https://exemple.com/offre/42">l'offre</a>.</p>`;
  const mail = extractMail(message(textPart("text/html", html)));
  assert.match(mail.text, /Bonjour Sulyvan,/);
  assert.match(mail.text, /l'offre \[https:\/\/exemple\.com\/offre\/42\]/);
  assert.doesNotMatch(mail.text, /logo|Logo/);
});

test("alternative avec un texte riche : le texte est préféré au HTML", () => {
  const mail = extractMail(
    message(
      multipart(
        "multipart/alternative",
        textPart("text/plain", LONG_PLAIN),
        textPart("text/html", "<p>Version HTML</p>"),
      ),
    ),
  );
  assert.match(mail.text, /bien reçu votre candidature/);
  assert.doesNotMatch(mail.text, /Version HTML/);
});

test("alternative avec un texte pauvre : le HTML est préféré", () => {
  const mail = extractMail(
    message(
      multipart(
        "multipart/alternative",
        textPart("text/plain", "Afficher dans le navigateur"),
        multipart("multipart/related", textPart("text/html", "<p>Entretien le 12 octobre</p>")),
      ),
    ),
  );
  assert.equal(mail.text, "Entretien le 12 octobre");
});

test("pièce jointe ignorée, contenus d'un multipart/mixed mis bout à bout", () => {
  const attachment: Part = { ...textPart("text/plain", "CONTENU DU CV"), filename: "cv.txt" };
  const mail = extractMail(
    message(
      multipart(
        "multipart/mixed",
        textPart("text/plain", "Première partie"),
        attachment,
        textPart("text/plain", "Seconde partie"),
      ),
    ),
  );
  assert.equal(mail.text, "Première partie\n\nSeconde partie");
});

test("HTML glissé dans la partie text/plain (certains ATS) : converti", () => {
  const plain =
    "Bonjour&nbsp;Sulyvan,<br />\n<span>Nous avons bien re&ccedil;u votre candidature pour le poste de " +
    "D&eacute;veloppeur junior.</span><br /><br /><span>Apr&egrave;s &eacute;tude de votre dossier, " +
    "nous ne pouvons pas y donner suite.</span><br /><span>Nous vous souhaitons une bonne " +
    "continuation dans vos recherches.</span>";
  const mail = extractMail(
    message(
      multipart("multipart/alternative", textPart("text/plain", plain), textPart("text/html", "<p>x</p>")),
    ),
  );
  assert.match(mail.text, /^Bonjour Sulyvan,\nNous avons bien reçu votre candidature/);
  assert.match(mail.text, /Après étude/);
  assert.doesNotMatch(mail.text, /<span>|&eacute;/);
});

test("URLs de suivi trop longues raccourcies à leur domaine, URLs courtes gardées", () => {
  const tracking = `https://cts.indeed.com/v3/${"A".repeat(300)}`;
  const mail = extractMail(
    message(textPart("text/plain", `Voir l'emploi: ${tracking}\nOffre : https://exemple.com/offre/42`)),
  );
  assert.equal(mail.text, "Voir l'emploi: https://cts.indeed.com/…\nOffre : https://exemple.com/offre/42");
});

test("mail non distribué : seule la partie lisible est gardée", () => {
  const mail = extractMail(
    message(
      multipart(
        "multipart/report",
        textPart("text/plain", "Delivery has failed to these recipients."),
        textPart("message/delivery-status", "Diagnostic technique"),
        textPart("text/plain", "Mail d'origine"),
      ),
    ),
  );
  assert.equal(mail.text, "Delivery has failed to these recipients.");
});

test("UTF-8 annoncé à tort comme ISO-8859-1 : décodé en UTF-8", () => {
  const part = textPart("text/plain", "Route de Pré-Bois, nous-mêmes");
  part.headers = [{ name: "Content-Type", value: 'text/plain; charset="iso-8859-1"' }];
  assert.equal(extractMail(message(part)).text, "Route de Pré-Bois, nous-mêmes");
});

test("mail envoyé repéré par le libellé SENT", () => {
  const sent = { ...message(textPart("text/plain", "x")), labelIds: ["SENT"] };
  assert.equal(extractMail(sent).sent, true);
  assert.equal(extractMail(message(textPart("text/plain", "x"))).sent, false);
});

test("jeu de caractères ISO-8859-1 décodé correctement", () => {
  const mail = extractMail(message(textPart("text/plain", "Désolé, poste pourvu.", "iso-8859-1")));
  assert.equal(mail.text, "Désolé, poste pourvu.");
});
