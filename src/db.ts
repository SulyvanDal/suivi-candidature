// Base de données locale (SQLite, intégré à Node) : état de la synchronisation Gmail.
//
// Le schéma évolue par migrations : la base garde son numéro de version dans
// PRAGMA user_version, et au démarrage on applique les migrations manquantes, dans l'ordre.

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const DEFAULT_DB_PATH = "data/suivi.db";

// Migrations, dans l'ordre. Ne jamais modifier une migration déjà livrée :
// en ajouter une nouvelle à la fin.
const MIGRATIONS: string[] = [
  // 1 — Synchronisation (#4)
  `
  -- Mails déjà traités : évite de les traiter deux fois.
  CREATE TABLE processed_messages (
    gmail_id     TEXT PRIMARY KEY,
    processed_at TEXT NOT NULL      -- date ISO 8601
  );

  -- État de la synchronisation : une seule ligne.
  CREATE TABLE sync_state (
    id           INTEGER PRIMARY KEY CHECK (id = 1),
    history_id   TEXT,              -- texte : Gmail le renvoie sous forme de chaîne (entier 64 bits)
    last_sync_at TEXT
  );
  `,
  // 2 — Résultat du traitement de chaque mail : pré-filtre puis classification (#8)
  `
  CREATE TABLE mail_results (
    gmail_id      TEXT PRIMARY KEY,
    received_at   TEXT NOT NULL,     -- date ISO 8601
    sent          INTEGER NOT NULL,  -- 1 = envoyé par moi
    filter_rule   TEXT NOT NULL,     -- règle du pré-filtre (mot-cle, offre-fermee…)
    filter_match  TEXT,
    event_type    TEXT,              -- classification Claude ; NULL si écarté par le pré-filtre
    justification TEXT,
    model         TEXT,
    processed_at  TEXT NOT NULL
  );
  `,
  // 3 — Informations de candidature extraites par Claude (#9)
  `
  ALTER TABLE mail_results ADD COLUMN company   TEXT;
  ALTER TABLE mail_results ADD COLUMN job_title TEXT;
  ALTER TABLE mail_results ADD COLUMN location  TEXT;
  ALTER TABLE mail_results ADD COLUMN channel   TEXT;
  ALTER TABLE mail_results ADD COLUMN offer_url TEXT;
  `,
];

/** Ouvre la base (en la créant si besoin) et applique les migrations manquantes. */
export function openDb(path: string = DEFAULT_DB_PATH): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  migrate(db);
  return db;
}

function migrate(db: DatabaseSync): void {
  const { user_version: current } = db.prepare("PRAGMA user_version").get() as {
    user_version: number;
  };

  for (let version = current + 1; version <= MIGRATIONS.length; version++) {
    // Chaque migration et son numéro de version sont appliqués ensemble, ou pas du tout.
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[version - 1]);
      db.exec(`PRAGMA user_version = ${version}`);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
}

export function isProcessed(db: DatabaseSync, gmailId: string): boolean {
  return db.prepare("SELECT 1 FROM processed_messages WHERE gmail_id = ?").get(gmailId) !== undefined;
}

/** Marque un mail comme traité. Sans effet s'il l'est déjà. */
export function markProcessed(db: DatabaseSync, gmailId: string): void {
  db.prepare(
    "INSERT OR IGNORE INTO processed_messages (gmail_id, processed_at) VALUES (?, ?)",
  ).run(gmailId, new Date().toISOString());
}

export interface MailResult {
  gmailId: string;
  receivedAt: Date;
  sent: boolean;
  filterRule: string;
  filterMatch?: string;
  eventType?: string;
  justification?: string;
  model?: string;
  company?: string | null;
  jobTitle?: string | null;
  location?: string | null;
  channel?: string | null;
  offerUrl?: string | null;
}

export function saveMailResult(db: DatabaseSync, r: MailResult): void {
  db.prepare(
    `INSERT OR REPLACE INTO mail_results
       (gmail_id, received_at, sent, filter_rule, filter_match, event_type, justification, model,
        company, job_title, location, channel, offer_url, processed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    r.gmailId,
    r.receivedAt.toISOString(),
    r.sent ? 1 : 0,
    r.filterRule,
    r.filterMatch ?? null,
    r.eventType ?? null,
    r.justification ?? null,
    r.model ?? null,
    r.company ?? null,
    r.jobTitle ?? null,
    r.location ?? null,
    r.channel ?? null,
    r.offerUrl ?? null,
    new Date().toISOString(),
  );
}

export interface SyncState {
  historyId: string;
  lastSyncAt: string;
}

/** Renvoie l'état de la dernière synchronisation, ou null si aucune n'a encore eu lieu. */
export function getSyncState(db: DatabaseSync): SyncState | null {
  const row = db.prepare("SELECT history_id, last_sync_at FROM sync_state WHERE id = 1").get() as
    | { history_id: string; last_sync_at: string }
    | undefined;
  return row ? { historyId: row.history_id, lastSyncAt: row.last_sync_at } : null;
}

export function saveSyncState(db: DatabaseSync, historyId: string): void {
  db.prepare(
    `INSERT INTO sync_state (id, history_id, last_sync_at) VALUES (1, ?, ?)
     ON CONFLICT (id) DO UPDATE SET history_id = excluded.history_id,
                                    last_sync_at = excluded.last_sync_at`,
  ).run(historyId, new Date().toISOString());
}
