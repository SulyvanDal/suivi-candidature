// Lance une synchronisation : chaque nouveau mail est extrait, pré-filtré, puis classé par
// Claude s'il est gardé ; le résultat est enregistré en base.

import { gmail } from "@googleapis/gmail";
import { getAuthorizedClient } from "./auth.js";
import { rebuildCandidatures } from "./candidatures.js";
import { classifyMail, createClient, MODEL } from "./classify.js";
import { openDb } from "./db.js";
import { processMessage, type ProcessedMail } from "./pipeline.js";
import { withRetry } from "./retry.js";
import { gmailSource, syncNewMessages } from "./sync.js";

// Coût de Claude Haiku 4.5, en dollars par million de jetons (entrée / sortie).
const PRICE_PER_MTOK = { input: 1, output: 5 };

const api = gmail({ version: "v1", auth: await getAuthorizedClient() });
const claude = createClient();
const db = openDb();

const processed: ProcessedMail[] = [];
const tokens = { input: 0, output: 0 };

try {
  const { mode } = await syncNewMessages(db, gmailSource(api), async (id) => {
    const p = await processMessage(id, {
      db,
      model: MODEL,
      fetchMessage: async (messageId) =>
        (await withRetry(() => api.users.messages.get({ userId: "me", id: messageId, format: "full" }))).data,
      classify: (mail) => classifyMail(claude, mail),
    });
    processed.push(p);
    if (p.result) {
      tokens.input += p.result.usage.inputTokens;
      tokens.output += p.result.usage.outputTokens;
      if (p.result.truncated) console.log(`  (texte coupé à l'envoi : ${p.mail.id} « ${p.mail.subject} »)`);
    }
    if (processed.length % 50 === 0) console.log(`  … ${processed.length} mails traités`);
  });

  const kept = processed.filter((p) => p.result);
  const relevant = kept.filter((p) => p.result!.classification.type !== "hors_sujet");
  console.log(`\nSynchronisation ${mode} : ${processed.length} nouveau(x) mail(s).`);
  console.log(`  Pré-filtre : ${kept.length} gardé(s), ${processed.length - kept.length} écarté(s).`);
  console.log(`  Claude : ${relevant.length} lié(s) à une candidature, ${kept.length - relevant.length} hors sujet.`);

  const cost = (tokens.input * PRICE_PER_MTOK.input + tokens.output * PRICE_PER_MTOK.output) / 1e6;
  console.log(`  Coût estimé : ${cost.toFixed(3)} $ (${tokens.input} jetons en entrée, ${tokens.output} en sortie).`);

  if (relevant.length > 0) console.log("\nMails liés à une candidature :");
  for (const { mail, result } of relevant) {
    const date = mail.date.toLocaleDateString("fr-FR");
    console.log(`  ${date}  ${result!.classification.type.padEnd(20)} ${mail.from.slice(0, 35).padEnd(35)} | ${mail.subject}`);
  }

  // Candidatures recalculées à partir de tous les événements (#10).
  const { candidatures } = rebuildCandidatures(db);
  const toCheck = candidatures.filter((c) => c.toCheck).length;
  console.log(`\n${candidatures.length} candidature(s) suivie(s)${toCheck ? `, ${toCheck} à vérifier` : ""} (détail : npm run candidatures).`);
} finally {
  db.close();
}
