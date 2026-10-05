import assert from "node:assert/strict";
import { test } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import { classifyMail, ClassificationRefusedError, MODEL, prepareText } from "./classify.js";
import type { ExtractedMail } from "./extract.js";

// Faux client Claude : aucun appel payant pendant les tests. Mails fabriqués uniquement.

const mail = (overrides: Partial<ExtractedMail> = {}): ExtractedMail => ({
  id: "m1",
  date: new Date("2026-10-05T08:30:00Z"),
  from: "Recrutement <jobs@exemple.com>",
  to: "moi@exemple.com",
  subject: "Votre candidature",
  sent: false,
  text: "Nous ne pouvons pas donner suite.",
  ...overrides,
});

function fakeClient(response: object) {
  const calls: any[] = [];
  const client = {
    messages: {
      parse: async (params: any) => {
        calls.push(params);
        return response;
      },
    },
  } as unknown as Anthropic;
  return { client, calls };
}

const okResponse = {
  stop_reason: "end_turn",
  parsed_output: { type: "refus", justification: "Réponse négative." },
  usage: { input_tokens: 500, output_tokens: 40 },
};

test("envoie le mail à Haiku avec une sortie structurée, renvoie la classification", async () => {
  const { client, calls } = fakeClient(okResponse);
  const result = await classifyMail(client, mail({ sent: true }));

  assert.deepEqual(result.classification, { type: "refus", justification: "Réponse négative." });
  assert.deepEqual(result.usage, { inputTokens: 500, outputTokens: 40 });
  assert.equal(calls[0].model, MODEL);
  assert.ok(calls[0].output_config.format, "sortie structurée demandée");
  const content: string = calls[0].messages[0].content;
  assert.match(content, /^<mail>/);
  assert.match(content, /Sens : envoyé par la personne/);
  assert.match(content, /Objet : Votre candidature/);
});

test("refus de Claude : erreur dédiée", async () => {
  const { client } = fakeClient({ ...okResponse, stop_reason: "refusal", parsed_output: null });
  await assert.rejects(classifyMail(client, mail()), ClassificationRefusedError);
});

test("réponse inexploitable : erreur", async () => {
  const { client } = fakeClient({ ...okResponse, stop_reason: "max_tokens", parsed_output: null });
  await assert.rejects(classifyMail(client, mail()), /inexploitable/);
});

test("citations retirées : « a écrit » (sur deux lignes), lignes en >", () => {
  const text = "Merci pour votre retour.\n\nLe jeu. 1 oct. 2026 à 14:11, X <x@y.fr>\na écrit :\n\n> Bonjour,\n> refus";
  assert.equal(prepareText(text, "Re: Candidature").text, "Merci pour votre retour.");
  assert.equal(prepareText("Ok\n> cité\nFin", "Re: x").text, "Ok\nFin");
});

test("citations retirées : bloc Outlook From / Sent", () => {
  const text = "Voici le document.\n\nFrom: Moi <moi@x.fr>\nSent: Tuesday, 29 September 2026\nTo: Lui";
  assert.equal(prepareText(text, "RE: Immersion").text, "Voici le document.");
});

test("mail transféré : le message cité est gardé", () => {
  const text = "Pour info\n\nFrom: RH <rh@x.fr>\nSent: Monday\nNous vous proposons un entretien.";
  assert.match(prepareText(text, "Fwd: Entretien").text, /proposons un entretien/);
});

test("texte trop long : coupé et signalé", () => {
  const { text, truncated } = prepareText("a".repeat(9000), "Objet");
  assert.equal(truncated, true);
  assert.ok(text.length < 8100);
  assert.match(text, /\[… texte coupé\]$/);
});
