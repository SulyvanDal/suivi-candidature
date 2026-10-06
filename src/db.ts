// Base de données locale (SQLite, intégré à Node) : état de la synchronisation Gmail.
//
// Le schéma évolue par migrations : la base garde son numéro de version dans
// PRAGMA user_version, et au démarrage on applique les migrations manquantes, dans l'ordre.

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type Offer, offerKey, type TitleDecision, type TitleRules } from "./offers.js";

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
  // 4 — Candidatures, recalculées à partir des événements (#10)
  `
  ALTER TABLE mail_results ADD COLUMN thread_id TEXT;

  -- Recalculée entièrement à chaque synchronisation.
  CREATE TABLE candidatures (
    id              TEXT PRIMARY KEY,  -- gmail_id du premier mail : identifiant stable
    company         TEXT,
    job_title       TEXT,
    location        TEXT,
    channel         TEXT,
    offer_url       TEXT,
    status          TEXT NOT NULL,     -- Envoyée | Entretien | Offre | Refus
    applied_at      TEXT NOT NULL,
    last_event_at   TEXT NOT NULL,
    last_event_type TEXT NOT NULL,
    to_check        INTEGER NOT NULL DEFAULT 0
  );

  -- Rattachement de chaque mail lié à une candidature (recalculé aussi).
  CREATE TABLE mail_links (
    gmail_id       TEXT PRIMARY KEY,
    candidature_id TEXT,               -- NULL = non rattaché
    to_check       INTEGER NOT NULL DEFAULT 0
  );

  -- Corrections manuelles (#13) : jamais effacées, réappliquées après chaque recalcul.
  CREATE TABLE corrections (
    id         INTEGER PRIMARY KEY,
    kind       TEXT NOT NULL,
    target     TEXT NOT NULL,
    field      TEXT,
    value      TEXT,
    created_at TEXT NOT NULL
  );
  `,
  // 5 — Objet et correspondant de chaque mail, pour l'interface (#16)
  `
  ALTER TABLE mail_results ADD COLUMN subject       TEXT;
  ALTER TABLE mail_results ADD COLUMN correspondent TEXT;  -- expéditeur (reçu) ou destinataire (envoyé)
  `,
  // 6 — Informations corrigées à la main, pour les signaler dans l'interface (#18)
  `
  ALTER TABLE candidatures ADD COLUMN manual TEXT NOT NULL DEFAULT '';  -- ex. "company,status"
  `,
  // 7 — Annonces extraites des alertes d'offres et filtre sur l'intitulé (#21)
  `
  CREATE TABLE offers (
    id           INTEGER PRIMARY KEY,
    dedupe_key   TEXT NOT NULL UNIQUE,  -- intitulé|entreprise sans casse ni accents : doublons ignorés
    gmail_id     TEXT NOT NULL,         -- alerte d'origine
    received_at  TEXT NOT NULL,
    platform     TEXT NOT NULL,
    title        TEXT NOT NULL,
    company      TEXT,
    location     TEXT,
    contract     TEXT,
    url          TEXT NOT NULL,
    title_keep   INTEGER NOT NULL,      -- 1 = gardée par le filtre sur l'intitulé
    title_rule   TEXT NOT NULL,         -- exclu | poste-recherche | aucun-poste
    title_match  TEXT,
    created_at   TEXT NOT NULL
  );

  -- Listes du filtre sur l'intitulé, modifiables depuis l'interface (#25).
  CREATE TABLE offer_terms (
    kind TEXT NOT NULL CHECK (kind IN ('poste', 'exclu')),
    term TEXT NOT NULL,
    PRIMARY KEY (kind, term)
  );
  INSERT INTO offer_terms (kind, term) VALUES
    ('poste', 'product owner'), ('poste', 'proxy po'), ('poste', 'product manager'),
    ('poste', 'product builder'), ('poste', 'ops & product'), ('poste', 'chef de projet*'),
    ('poste', 'pmo'), ('poste', 'consultant digital transformation'), ('poste', 'business analyst'),
    ('poste', 'amoa'), ('poste', 'développeu*'), ('poste', 'software engineer'),
    ('poste', 'ingénieur logiciel'),
    ('exclu', 'stage'), ('exclu', 'alternance'), ('exclu', 'freelance'), ('exclu', 'senior'),
    ('exclu', 'tech lead'), ('exclu', 'intérim');
  `,
  // 8 — Description lue sur la page de l'annonce (#22)
  `
  ALTER TABLE offers ADD COLUMN page_status  TEXT;  -- NULL = à lire | lue | non_verifiee
  ALTER TABLE offers ADD COLUMN page_url     TEXT;  -- adresse finale, sans le lien de suivi
  ALTER TABLE offers ADD COLUMN description  TEXT;
  ALTER TABLE offers ADD COLUMN page_error   TEXT;  -- raison du dernier échec
  ALTER TABLE offers ADD COLUMN page_read_at TEXT;
  `,
  // 9 — Jugement des annonces par Claude, profil du candidat (#23)
  `
  -- Réglages modifiables depuis l'interface (#25) : profil du candidat… Jamais dans le code.
  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  ALTER TABLE offers ADD COLUMN verdict        TEXT;  -- garder | ecarter ; NULL = pas encore jugée
  ALTER TABLE offers ADD COLUMN verdict_reason TEXT;  -- correspond | seniorite | hors_cible
  ALTER TABLE offers ADD COLUMN justification  TEXT;
  ALTER TABLE offers ADD COLUMN model          TEXT;
  ALTER TABLE offers ADD COLUMN judged_at      TEXT;
  `,
  // 10 — Faits extraits par Claude, d'où le code tire la décision (#23)
  `
  ALTER TABLE offers ADD COLUMN job_type       TEXT;     -- produit_projet | developpeur | autre
  ALTER TABLE offers ADD COLUMN experience_min REAL;     -- années minimales exigées ; NULL = non chiffré
  ALTER TABLE offers ADD COLUMN senior         INTEGER;  -- 1 = poste explicitement senior / expert / lead
  ALTER TABLE offers ADD COLUMN niche_tech     INTEGER;  -- 1 = technologie de niche (développeur)
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
  threadId?: string | null;
  subject?: string | null;
  correspondent?: string | null;
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
        company, job_title, location, channel, offer_url, thread_id, subject, correspondent, processed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    r.threadId ?? null,
    r.subject ?? null,
    r.correspondent ?? null,
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

/** Listes du filtre sur l'intitulé (#21). */
export function loadTitleRules(db: DatabaseSync): TitleRules {
  const rows = db.prepare("SELECT kind, term FROM offer_terms ORDER BY term").all() as { kind: string; term: string }[];
  return {
    keep: rows.filter((r) => r.kind === "poste").map((r) => r.term),
    exclude: rows.filter((r) => r.kind === "exclu").map((r) => r.term),
  };
}

/** Enregistre une annonce ; renvoie false si c'est un doublon (déjà enregistrée, rien n'est modifié). */
export function saveOffer(
  db: DatabaseSync,
  offer: Offer,
  decision: TitleDecision,
  alert: { gmailId: string; receivedAt: Date },
): boolean {
  const { changes } = db
    .prepare(
      `INSERT OR IGNORE INTO offers
         (dedupe_key, gmail_id, received_at, platform, title, company, location, contract, url,
          title_keep, title_rule, title_match, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      offerKey(offer),
      alert.gmailId,
      alert.receivedAt.toISOString(),
      offer.platform,
      offer.title,
      offer.company,
      offer.location,
      offer.contract,
      offer.url,
      decision.keep ? 1 : 0,
      decision.rule,
      decision.match ?? null,
      new Date().toISOString(),
    );
  return changes > 0;
}

/** Profil du candidat envoyé à Claude pour juger les annonces (#23). */
export const PROFILE_KEY = "profil_candidat";

export function getSetting(db: DatabaseSync, key: string): string | null {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setSetting(db: DatabaseSync, key: string, value: string): void {
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(
    key,
    value,
  );
}
