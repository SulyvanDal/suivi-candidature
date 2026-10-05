// Évalue la classification et l'extraction sur un jeu de mails annotés à la main :
// npm run eval:classify
// Annotations : data/annotations-classification.json (hors de git),
// [{ id, expected, note, fields?: { entreprise?, poste?, lieu?, canal? } }].
// Un champ absent de « fields » n'est pas vérifié ; un champ à null doit rester vide.
// Chaque lancement appelle réellement Claude : il coûte quelques centimes.

import { readFileSync } from "node:fs";
import { gmail } from "@googleapis/gmail";
import { getAuthorizedClient } from "./auth.js";
import { classifyMail, createClient, MODEL, type Classification } from "./classify.js";
import { extractMail } from "./extract.js";
import { withRetry } from "./retry.js";

const ANNOTATIONS_PATH = "data/annotations-classification.json";
const PRICE_PER_MTOK = { input: 1, output: 5 }; // Claude Haiku 4.5
const FIELDS = ["entreprise", "poste", "lieu", "canal"] as const;
type Field = (typeof FIELDS)[number];

interface Annotation {
  id: string;
  expected: string;
  note?: string;
  fields?: Partial<Record<Field, string | null>>;
}

const annotations: Annotation[] = JSON.parse(readFileSync(ANNOTATIONS_PATH, "utf8"));

/** Minuscules, sans accents, sans « (H/F) », ponctuation réduite à des espaces. */
function normalize(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\((h\/f|f\/h)\)|\b(h\/f|f\/h)\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Valeurs proches : l'une contient l'autre une fois normalisées (« Groupe ACENSI » ≈ « Acensi »). */
function matches(expected: string | null, actual: string | null): boolean {
  if (expected === null || actual === null) return expected === actual;
  const [e, a] = [normalize(expected), normalize(actual)];
  return e.includes(a) || a.includes(e);
}

const api = gmail({ version: "v1", auth: await getAuthorizedClient() });
const claude = createClient();

let typeCorrect = 0;
const fieldStats = Object.fromEntries(FIELDS.map((f) => [f, { ok: 0, total: 0 }])) as Record<
  Field,
  { ok: number; total: number }
>;
const tokens = { input: 0, output: 0 };
const errors: string[] = [];

for (const { id, expected, note, fields } of annotations) {
  const { data } = await withRetry(() => api.users.messages.get({ userId: "me", id, format: "full" }));
  const { classification: c, usage } = await classifyMail(claude, extractMail(data));
  tokens.input += usage.inputTokens;
  tokens.output += usage.outputTokens;

  const problems: string[] = [];
  if (c.type === expected) typeCorrect++;
  else problems.push(`type : attendu ${expected}, obtenu ${c.type}`);

  for (const field of FIELDS) {
    if (!fields || !(field in fields)) continue;
    const want = fields[field] ?? null;
    const got = c[field as keyof Classification] as string | null;
    fieldStats[field].total++;
    if (matches(want, got)) fieldStats[field].ok++;
    else problems.push(`${field} : attendu ${JSON.stringify(want)}, obtenu ${JSON.stringify(got)}`);
  }

  if (problems.length > 0) {
    errors.push(`✖ ${id}  ${note ?? ""}\n    ${problems.join("\n    ")}\n    → ${c.justification}`);
  }
}

const pct = (ok: number, total: number) => `${ok}/${total} (${total ? Math.round((100 * ok) / total) : 0} %)`;
console.log(`Modèle : ${MODEL}`);
console.log(`Type        : ${pct(typeCorrect, annotations.length)}`);
for (const f of FIELDS) console.log(`${f.padEnd(12)}: ${pct(fieldStats[f].ok, fieldStats[f].total)}`);
const cost = (tokens.input * PRICE_PER_MTOK.input + tokens.output * PRICE_PER_MTOK.output) / 1e6;
console.log(`Coût : ${cost.toFixed(3)} $ (${tokens.input} jetons en entrée, ${tokens.output} en sortie)\n`);
for (const e of errors) console.log(e);
