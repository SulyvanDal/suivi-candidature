import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { getSetting, getSyncState, isProcessed, loadTitleRules, markProcessed, openDb, PROFILE_KEY, saveSyncState, setSetting } from "./db.js";

// Chaque test travaille dans un dossier temporaire, supprimé à la fin.
const tmp = mkdtempSync(join(tmpdir(), "suivi-db-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

test("crée la base, son dossier et le schéma", () => {
  const db = openDb(join(tmp, "nouveau", "suivi.db"));
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => row.name);
  assert.deepEqual(tables, [
    "candidatures",
    "corrections",
    "mail_links",
    "mail_results",
    "offer_terms",
    "offers",
    "processed_messages",
    "settings",
    "sync_state",
  ]);
  db.close();
});

test("rouvre une base existante sans erreur ni perte de données", () => {
  const path = join(tmp, "existante.db");
  const first = openDb(path);
  markProcessed(first, "abc");
  first.close();

  const second = openDb(path);
  assert.equal(isProcessed(second, "abc"), true);
  second.close();
});

test("deux programmes ouverts : on lit pendant que l'autre écrit (mode WAL)", () => {
  const path = join(tmp, "partagee.db");
  const sync = openDb(path);
  const ui = openDb(path);
  assert.equal((ui.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode, "wal");

  sync.exec("BEGIN IMMEDIATE");
  markProcessed(sync, "en-cours");
  // Lecture pendant la transaction d'écriture : pas de « database is locked », état d'avant.
  assert.equal(isProcessed(ui, "en-cours"), false);
  sync.exec("COMMIT");
  assert.equal(isProcessed(ui, "en-cours"), true);
  sync.close();
  ui.close();
});

test("migration en attente : la base est sauvegardée avant, une base neuve ne l'est pas", () => {
  const dir = join(tmp, "sauvegarde");
  const path = join(dir, "suivi.db");
  const db = openDb(path);
  assert.equal(existsSync(join(dir, "backups")), false);
  markProcessed(db, "precieux");
  // Base ramenée au schéma d'avant la migration 12.
  db.exec("ALTER TABLE offers DROP COLUMN prioritized_at; PRAGMA user_version = 11");
  db.close();

  openDb(path).close();
  const files = readdirSync(join(dir, "backups"));
  assert.equal(files.length, 1);
  assert.match(files[0], /^suivi-.*-v11\.db$/);
  const copy = new DatabaseSync(join(dir, "backups", files[0]));
  assert.equal((copy.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 11);
  assert.ok(copy.prepare("SELECT 1 FROM processed_messages WHERE gmail_id = 'precieux'").get());
  copy.close();

  // Base à jour : pas de nouvelle sauvegarde.
  openDb(path).close();
  assert.equal(readdirSync(join(dir, "backups")).length, 1);
});

test("mémorise les mails traités", () => {
  const db = openDb(":memory:");
  assert.equal(isProcessed(db, "m1"), false);
  markProcessed(db, "m1");
  markProcessed(db, "m1"); // deuxième appel sans effet
  assert.equal(isProcessed(db, "m1"), true);
  assert.equal(isProcessed(db, "m2"), false);
  db.close();
});

test("lit et met à jour l'état de synchronisation", () => {
  const db = openDb(":memory:");
  assert.equal(getSyncState(db), null);

  saveSyncState(db, "12345");
  assert.equal(getSyncState(db)?.historyId, "12345");

  saveSyncState(db, "67890");
  const state = getSyncState(db);
  assert.equal(state?.historyId, "67890");
  assert.ok(state && !Number.isNaN(Date.parse(state.lastSyncAt)));
  db.close();
});

test("listes de départ du filtre sur l'intitulé (#21)", () => {
  const rules = loadTitleRules(openDb(":memory:"));
  assert.ok(rules.keep.includes("chef de projet*"));
  assert.ok(rules.keep.includes("product owner"));
  assert.ok(rules.exclude.includes("intérim"));
  assert.equal(rules.keep.length + rules.exclude.length, 19);
});

test("réglages : lecture, écriture, remplacement", () => {
  const db = openDb(":memory:");
  assert.equal(getSetting(db, PROFILE_KEY), null);
  setSetting(db, PROFILE_KEY, "v1");
  setSetting(db, PROFILE_KEY, "v2");
  assert.equal(getSetting(db, PROFILE_KEY), "v2");
});
