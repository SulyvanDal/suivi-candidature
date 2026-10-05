// Simulation du pré-filtre sur les mails récents : npm run filter -- --days 14
// N'écrit rien en base et n'envoie rien à Claude.

import { gmail } from "@googleapis/gmail";
import { getAuthorizedClient } from "./auth.js";
import { extractMail } from "./extract.js";
import { filterMail } from "./filter.js";
import { withRetry } from "./retry.js";
import { gmailSource } from "./sync.js";

const daysArg = process.argv.indexOf("--days");
const days = daysArg > 0 ? Number(process.argv[daysArg + 1]) : 7;

const api = gmail({ version: "v1", auth: await getAuthorizedClient() });
const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
const ids = await gmailSource(api).listIdsSince(since);

// Contenu complet de chaque mail, 5 téléchargements à la fois (limite de débit Gmail).
const mails = new Array<ReturnType<typeof extractMail>>(ids.length);
let next = 0;
await Promise.all(
  Array.from({ length: 5 }, async () => {
    while (next < ids.length) {
      const i = next++;
      const { data } = await withRetry(() =>
        api.users.messages.get({ userId: "me", id: ids[i], format: "full" }),
      );
      mails[i] = extractMail(data);
    }
  }),
);

const counts = new Map<string, number>();
for (const mail of mails.reverse()) {
  const d = filterMail(mail);
  const label = d.rule + (d.match ? `(${d.match})` : "");
  counts.set(d.rule, (counts.get(d.rule) ?? 0) + 1);
  console.log(
    `${d.keep ? "GARDÉ  " : "écarté "} ${label.padEnd(28)} ${mail.from.slice(0, 40).padEnd(40)} | ${mail.subject.slice(0, 90)}`,
  );
}

console.log(`\n${mails.length} mail(s) sur ${days} jour(s) :`);
for (const [rule, n] of counts) console.log(`  ${rule.padEnd(15)} ${n}`);
