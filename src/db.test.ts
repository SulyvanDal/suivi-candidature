import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { getSyncState, isProcessed, markProcessed, openDb, saveSyncState } from "./db.js";

// Chaque test travaille dans un dossier temporaire, supprimé à la fin.
const tmp = mkdtempSync(join(tmpdir(), "suivi-db-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

test("crée la base, son dossier et le schéma", () => {
  const db = openDb(join(tmp, "nouveau", "suivi.db"));
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => row.name);
  assert.deepEqual(tables, ["mail_results", "processed_messages", "sync_state"]);
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
