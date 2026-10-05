// Lance une synchronisation et affiche le résultat.
// Pour l'instant, « traiter » un mail = le marquer comme traité (l'analyse viendra avec #6 à #10).

import { gmail } from "@googleapis/gmail";
import { getAuthorizedClient } from "./auth.js";
import { openDb } from "./db.js";
import { httpStatus } from "./retry.js";
import { gmailSource, syncNewMessages } from "./sync.js";

const SHOWN = 20;

const api = gmail({ version: "v1", auth: await getAuthorizedClient() });
const db = openDb();

try {
  const { mode, processed } = await syncNewMessages(db, gmailSource(api), async () => {});
  console.log(`Synchronisation ${mode} : ${processed.length} nouveau(x) mail(s).`);

  // En-têtes des plus récents seulement, pour éviter des milliers d'appels au premier passage.
  const recent = processed.slice(-SHOWN).reverse();
  if (recent.length > 0) console.log(`\n${recent.length} plus récent(s) :`);
  for (const id of recent) {
    try {
      const { data } = await api.users.messages.get({
        userId: "me",
        id,
        format: "metadata",
        metadataHeaders: ["From", "Subject"],
      });
      const header = (name: string) =>
        data.payload?.headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";
      const date = new Date(Number(data.internalDate)).toLocaleString("fr-FR");
      console.log(`${id}  ${date}  ${header("From")}  ${header("Subject") || "(sans objet)"}`);
    } catch (err) {
      // Mail supprimé entre-temps : on l'ignore.
      if (httpStatus(err) !== 404) throw err;
    }
  }
} finally {
  db.close();
}
