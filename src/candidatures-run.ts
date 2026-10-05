// Recalcule les candidatures et les affiche : npm run candidatures
// N'appelle pas Claude (gratuit). Rattrape au passage le fil Gmail des mails qui n'en ont pas
// (mails traités avant #10), en ne lisant que leurs métadonnées.

import { gmail } from "@googleapis/gmail";
import { getAuthorizedClient } from "./auth.js";
import { rebuildCandidatures } from "./candidatures.js";
import { openDb } from "./db.js";
import { withRetry } from "./retry.js";

const db = openDb();

try {
  const missing = (
    db
      .prepare(
        `SELECT gmail_id FROM mail_results
         WHERE thread_id IS NULL AND event_type IS NOT NULL AND event_type <> 'hors_sujet'`,
      )
      .all() as { gmail_id: string }[]
  ).map((r) => r.gmail_id);

  if (missing.length > 0) {
    console.log(`Rattrapage du fil Gmail pour ${missing.length} mail(s)…`);
    const api = gmail({ version: "v1", auth: await getAuthorizedClient() });
    const update = db.prepare("UPDATE mail_results SET thread_id = ? WHERE gmail_id = ?");
    for (const id of missing) {
      const { data } = await withRetry(() => api.users.messages.get({ userId: "me", id, format: "minimal" }));
      update.run(data.threadId ?? null, id);
    }
  }

  const { candidatures, links } = rebuildCandidatures(db);
  const unlinked = [...links.values()].filter((l) => l.candidatureId === null).length;
  const toCheck = candidatures.filter((c) => c.toCheck).length;

  console.log(`\n${candidatures.length} candidature(s), ${links.size - unlinked} mail(s) rattaché(s), ${unlinked} non rattaché(s), ${toCheck} à vérifier.\n`);
  const byStatus = new Map<string, number>();
  for (const c of candidatures) byStatus.set(c.status, (byStatus.get(c.status) ?? 0) + 1);
  console.log([...byStatus].map(([s, n]) => `${s} : ${n}`).join("  ·  "), "\n");

  for (const c of [...candidatures].sort((a, b) => b.lastEventAt.getTime() - a.lastEventAt.getTime())) {
    const date = (d: Date) => d.toLocaleDateString("fr-FR");
    console.log(
      `${date(c.appliedAt)}  ${c.status.padEnd(9)} ${(c.company ?? "?").slice(0, 28).padEnd(28)} ${(c.jobTitle ?? "?").slice(0, 55).padEnd(55)} ${String(c.events.length).padStart(2)} mail(s), dernier ${date(c.lastEventAt)}${c.toCheck ? "  ⚠ à vérifier" : ""}`,
    );
  }
} finally {
  db.close();
}
