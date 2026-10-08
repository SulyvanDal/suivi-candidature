// Évalue le barème de priorité (#26) sans appeler Claude : npm run eval:priorite
// Compare la priorité calculée à partir des faits déjà relevés (npm run offres:retrier) à la
// priorité attendue dans data/annotations-priorite.json (hors de git) : [{ id, prio: 1 | 2, note? }].
// Gratuit : on peut ajuster les points et relancer autant de fois que nécessaire.

import { readFileSync } from "node:fs";
import { openDb } from "./db.js";
import { recomputeVerdicts } from "./offer-judge.js";

interface Annotation {
  id: number;
  prio: 1 | 2;
  note?: string;
}

const annotations: Annotation[] = JSON.parse(readFileSync("data/annotations-priorite.json", "utf8"));
const db = openDb();
// Priorités recalculées avec le barème actuel du code, à partir des faits enregistrés.
recomputeVerdicts(db);

let ok = 0;
let missing = 0;
const errors: string[] = [];
const confusion = { prioManquee: 0, prioEnTrop: 0 };
for (const a of annotations) {
  const row = db
    .prepare("SELECT title, company, location, priority, priority_details, priority_points FROM offers WHERE id = ?")
    .get(a.id) as
    | { title: string; company: string | null; location: string | null; priority: number | null; priority_details: string | null; priority_points: number | null }
    | undefined;
  if (!row || row.priority === null) {
    missing++;
    continue;
  }
  if (row.priority === a.prio) {
    ok++;
    continue;
  }
  if (a.prio === 1) confusion.prioManquee++;
  else confusion.prioEnTrop++;
  errors.push(
    `  #${a.id} ${row.title} — ${row.company ?? "?"} (${row.location ?? "?"})\n` +
      `     attendu ${a.prio}${a.note ? ` (${a.note})` : ""}, calculé ${row.priority} : ${row.priority_points} point(s) — ${row.priority_details || "aucun critère"}`,
  );
}
db.close();

console.log(`Accord : ${ok}/${annotations.length - missing}${missing ? ` (${missing} annonce(s) sans faits de priorité : lancer npm run offres:retrier)` : ""}`);
console.log(`  Priorités 1 manquées : ${confusion.prioManquee}`);
console.log(`  Priorités 1 en trop  : ${confusion.prioEnTrop}`);
if (errors.length) console.log(`\nDésaccords :\n${errors.join("\n")}`);
