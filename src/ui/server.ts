// Démarre l'interface : npm run ui
// Recalcule les candidatures (lecture de la base uniquement : ni Gmail ni Claude), puis sert
// l'interface sur 127.0.0.1, inaccessible depuis le réseau, et ouvre le navigateur.

import { execFile } from "node:child_process";
import { serve } from "@hono/node-server";
import { rebuildCandidatures } from "../candidatures.js";
import { openDb } from "../db.js";
import { createApp } from "./app.js";

const PORT = Number(process.env.PORT ?? 4321);

const db = openDb();
rebuildCandidatures(db);

serve({ fetch: createApp(db).fetch, hostname: "127.0.0.1", port: PORT }, ({ port }) => {
  const url = `http://127.0.0.1:${port}`;
  console.log(`Interface : ${url}  (Ctrl+C pour arrêter)`);
  execFile("open", [url], (err) => {
    if (err) console.log("Ouvre cette adresse dans ton navigateur.");
  });
});
