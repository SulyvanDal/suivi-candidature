// Repasse à Claude les mails déjà gardés par le pré-filtre (après un changement de consignes
// ou de schéma) et met la base à jour : npm run reanalyse
// Appelle réellement Claude : coûte environ 0,002 $ par mail avec Haiku.

import { gmail } from "@googleapis/gmail";
import { getAuthorizedClient } from "./auth.js";
import { classifyMail, createClient, MODEL } from "./classify.js";
import { openDb } from "./db.js";
import { processMessage } from "./pipeline.js";
import { withRetry } from "./retry.js";

const PRICE_PER_MTOK = { input: 1, output: 5 }; // Claude Haiku 4.5

const api = gmail({ version: "v1", auth: await getAuthorizedClient() });
const claude = createClient();
const db = openDb();

try {
  const ids = (
    db.prepare("SELECT gmail_id FROM mail_results WHERE filter_rule = 'mot-cle' ORDER BY received_at").all() as {
      gmail_id: string;
    }[]
  ).map((r) => r.gmail_id);
  console.log(`${ids.length} mail(s) à repasser à ${MODEL}.`);

  const tokens = { input: 0, output: 0 };
  const types = new Map<string, number>();
  let done = 0;
  for (const id of ids) {
    try {
      const { result } = await processMessage(id, {
        db,
        model: MODEL,
        fetchMessage: async (messageId) =>
          (await withRetry(() => api.users.messages.get({ userId: "me", id: messageId, format: "full" }))).data,
        classify: (mail) => classifyMail(claude, mail),
      });
      if (result) {
        tokens.input += result.usage.inputTokens;
        tokens.output += result.usage.outputTokens;
        const t = result.classification.type;
        types.set(t, (types.get(t) ?? 0) + 1);
      }
    } catch (err) {
      // Mail supprimé de Gmail depuis : on le signale et on continue.
      console.log(`  ✖ ${id} : ${(err as Error).message}`);
    }
    if (++done % 50 === 0) console.log(`  … ${done} mails`);
  }

  console.log("\nRépartition :");
  for (const [t, n] of [...types].sort((a, b) => b[1] - a[1])) console.log(`  ${t.padEnd(20)} ${n}`);
  const cost = (tokens.input * PRICE_PER_MTOK.input + tokens.output * PRICE_PER_MTOK.output) / 1e6;
  console.log(`Coût : ${cost.toFixed(3)} $`);
} finally {
  db.close();
}
