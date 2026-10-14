// Écrit en base les mots-clés de départ de la configuration (#36) : npm run config:initialiser
// Ensuite, c'est la base qui fait foi : les listes se modifient dans l'interface (réglages des offres).
//
// Une base neuve contient déjà des mots-clés (ceux de la migration 7). Si la base diffère de la
// configuration, la commande affiche les différences et ne remplace qu'avec --remplacer.

import { resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { type Config, loadConfig } from "./config.js";
import { addOfferTerm, loadTitleRules, openDb, type TermKind } from "./db.js";

export interface TermsDiff {
  kind: TermKind;
  added: string[];
  removed: string[];
}

/** Différences entre les mots-clés en base et ceux de la configuration. */
export function termsDiff(db: DatabaseSync, config: Config): TermsDiff[] {
  const current = loadTitleRules(db);
  const pairs: [TermKind, string[], string[]][] = [
    ["poste", current.keep, config.motsClesDeDepart.postes],
    ["exclu", current.exclude, config.motsClesDeDepart.exclus],
  ];
  return pairs
    .map(([kind, inDb, wanted]) => ({
      kind,
      added: wanted.filter((t) => !inDb.includes(t)),
      removed: inDb.filter((t) => !wanted.includes(t)),
    }))
    .filter((d) => d.added.length > 0 || d.removed.length > 0);
}

/** Remplace les mots-clés en base par ceux de la configuration. */
export function replaceTerms(db: DatabaseSync, config: Config): void {
  db.exec("BEGIN");
  try {
    db.exec("DELETE FROM offer_terms");
    for (const t of config.motsClesDeDepart.postes) addOfferTerm(db, "poste", t);
    for (const t of config.motsClesDeDepart.exclus) addOfferTerm(db, "exclu", t);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

// Lancé directement (et non importé par les tests).
if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  const config = loadConfig();
  const db = openDb();
  const diff = termsDiff(db, config);
  const label = (k: TermKind) => (k === "poste" ? "Postes recherchés" : "Mots exclus");
  if (diff.length === 0) {
    console.log("Mots-clés déjà conformes à la configuration : rien à faire.");
  } else if (!process.argv.includes("--remplacer")) {
    console.log("Les mots-clés en base diffèrent de la configuration :");
    for (const d of diff) {
      console.log(`  ${label(d.kind)} :`);
      if (d.added.length) console.log(`    à ajouter : ${d.added.join(", ")}`);
      if (d.removed.length) console.log(`    à retirer : ${d.removed.join(", ")}`);
    }
    console.log("\nRelancer avec --remplacer pour écrire ceux de la configuration (ceux de la base seront perdus).");
    process.exitCode = 1;
  } else {
    replaceTerms(db, config);
    console.log(
      `Mots-clés remplacés : ${config.motsClesDeDepart.postes.length} poste(s) recherché(s), ` +
        `${config.motsClesDeDepart.exclus.length} mot(s) exclu(s).`,
    );
  }
  db.close();
}
