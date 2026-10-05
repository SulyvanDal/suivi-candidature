// Évalue la classification sur un jeu de mails annotés à la main : npm run eval:classify
// Annotations : data/annotations-classification.json (hors de git), [{ id, expected, note }].
// Chaque lancement appelle réellement Claude : il coûte quelques centimes.

import { readFileSync } from "node:fs";
import { gmail } from "@googleapis/gmail";
import { getAuthorizedClient } from "./auth.js";
import { classifyMail, createClient, MODEL } from "./classify.js";
import { extractMail } from "./extract.js";
import { withRetry } from "./retry.js";

const ANNOTATIONS_PATH = "data/annotations-classification.json";
const PRICE_PER_MTOK = { input: 1, output: 5 }; // Claude Haiku 4.5

const annotations: { id: string; expected: string; note?: string }[] = JSON.parse(
  readFileSync(ANNOTATIONS_PATH, "utf8"),
);

const api = gmail({ version: "v1", auth: await getAuthorizedClient() });
const claude = createClient();

let correct = 0;
const tokens = { input: 0, output: 0 };
const errors: string[] = [];

for (const { id, expected, note } of annotations) {
  const { data } = await withRetry(() => api.users.messages.get({ userId: "me", id, format: "full" }));
  const { classification, usage } = await classifyMail(claude, extractMail(data));
  tokens.input += usage.inputTokens;
  tokens.output += usage.outputTokens;

  if (classification.type === expected) {
    correct++;
  } else {
    errors.push(
      `✖ ${id}  attendu ${expected}, obtenu ${classification.type}\n    ${note ?? ""}\n    → ${classification.justification}`,
    );
  }
}

console.log(`Modèle : ${MODEL}`);
console.log(`Exactitude : ${correct}/${annotations.length} (${Math.round((100 * correct) / annotations.length)} %)`);
const cost = (tokens.input * PRICE_PER_MTOK.input + tokens.output * PRICE_PER_MTOK.output) / 1e6;
console.log(`Coût : ${cost.toFixed(3)} $ (${tokens.input} jetons en entrée, ${tokens.output} en sortie)\n`);
for (const e of errors) console.log(e);
