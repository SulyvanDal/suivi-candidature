// Rattrapage des offres fermées (#14) pour les mails « n'est plus disponible » reçus avant : ils sont relus
// dans Gmail, l'offre concernée est notée, puis les candidatures sont recalculées.
//   npm run offres-fermees:rattraper
// Gratuit : ces mails sont écartés par le pré-filtre, Claude n'est jamais appelé. À lancer une fois.

import { gmail } from "@googleapis/gmail";
import { getAuthorizedClient } from "./auth.js";
import { rebuildCandidatures } from "./candidatures.js";
import { MODEL } from "./classify.js";
import { openDb } from "./db.js";
import { processMessage } from "./pipeline.js";
import { fetchFullMessage } from "./sync.js";

const api = gmail({ version: "v1", auth: await getAuthorizedClient() });
const db = openDb();

try {
  const ids = (
    db.prepare("SELECT gmail_id FROM mail_results WHERE filter_rule = 'offre-fermee' ORDER BY received_at").all() as {
      gmail_id: string;
    }[]
  ).map((r) => r.gmail_id);
  console.log(`${ids.length} mail(s) « offre plus disponible » à relire.`);

  const before = new Map(
    (db.prepare("SELECT id, status FROM candidatures").all() as { id: string; status: string }[]).map((r) => [r.id, r.status]),
  );
  for (const id of ids) {
    try {
      await processMessage(id, {
        db,
        model: MODEL,
        fetchMessage: (messageId) => fetchFullMessage(api, messageId),
        // Garde-fou : un mail que le pré-filtre garderait désormais n'est pas envoyé à Claude.
        classify: async () => {
          throw new Error("gardé par le pré-filtre, non envoyé à Claude");
        },
      });
    } catch (err) {
      console.log(`  ✖ ${id} : ${(err as Error).message}`);
    }
  }

  const offers = (db.prepare("SELECT COUNT(*) AS n FROM closed_offers").get() as { n: number }).n;
  const { candidatures, closedLinks } = rebuildCandidatures(db);
  console.log(`${offers} offre(s) fermée(s) lue(s), ${closedLinks.length} rattachée(s) à une candidature.`);

  const refused = candidatures.filter((c) => c.status === "Refus" && before.get(c.id) === "Envoyée");
  console.log(`\n${refused.length} candidature(s) passée(s) de Envoyée à Refus :`);
  for (const c of refused) console.log(`  ${c.company ?? "Entreprise inconnue"} · ${c.jobTitle ?? "poste non précisé"}`);
} finally {
  db.close();
}
