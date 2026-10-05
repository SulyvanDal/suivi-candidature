// Affiche le texte extrait d'un mail : npm run extract -- <identifiant>

import { gmail } from "@googleapis/gmail";
import { getAuthorizedClient } from "./auth.js";
import { extractMail } from "./extract.js";

const id = process.argv[2];
if (!id) {
  console.error("Usage : npm run extract -- <identifiant du mail>");
  process.exit(1);
}

const api = gmail({ version: "v1", auth: await getAuthorizedClient() });
const { data } = await api.users.messages.get({ userId: "me", id, format: "full" });
const mail = extractMail(data);

console.log(`Date    : ${mail.date.toLocaleString("fr-FR")}`);
console.log(`De      : ${mail.from}`);
console.log(`À       : ${mail.to}`);
console.log(`Objet   : ${mail.subject}`);
console.log(`Texte   : ${mail.text.length} caractères\n`);
console.log(mail.text);
