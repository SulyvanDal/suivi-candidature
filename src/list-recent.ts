// Affiche les mails reçus au cours des dernières 24 h : identifiant, date, expéditeur, objet.
// Seuls les en-têtes sont demandés à Gmail : le corps des mails n'est jamais téléchargé.

import { gmail } from "@googleapis/gmail";
import { getAuthorizedClient } from "./auth.js";

const auth = await getAuthorizedClient();
const api = gmail({ version: "v1", auth });

// Gmail accepte un horodatage Unix (en secondes) dans le filtre after:,
// ce qui est plus précis que newer_than:1d.
const since = Math.floor(Date.now() / 1000) - 24 * 60 * 60;

// 1. Liste des identifiants, page par page. Spams et corbeille sont exclus par défaut.
const ids: string[] = [];
let pageToken: string | undefined;
do {
  const { data } = await api.users.messages.list({
    userId: "me",
    q: `after:${since}`,
    pageToken,
  });
  for (const message of data.messages ?? []) {
    if (message.id) ids.push(message.id);
  }
  pageToken = data.nextPageToken ?? undefined;
} while (pageToken);

if (ids.length === 0) {
  console.log("Aucun mail reçu au cours des dernières 24 h.");
}

// 2. En-têtes de chaque mail (format metadata = pas de corps).
for (const id of ids) {
  const { data } = await api.users.messages.get({
    userId: "me",
    id,
    format: "metadata",
    metadataHeaders: ["From", "Subject"],
  });

  const header = (name: string) =>
    data.payload?.headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";

  // internalDate = date de réception par Gmail (ms), plus fiable que l'en-tête Date
  // qui est fourni par l'expéditeur.
  const date = new Date(Number(data.internalDate)).toLocaleString("fr-FR");

  console.log(`${id}  ${date}  ${header("From")}  ${header("Subject") || "(sans objet)"}`);
}

if (ids.length > 0) console.log(`\n${ids.length} mail(s).`);
