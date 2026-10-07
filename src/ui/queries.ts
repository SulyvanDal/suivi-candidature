// Lectures en base pour l'interface (aucune écriture ici).

import type { DatabaseSync } from "node:sqlite";
import type { Status } from "../candidatures.js";

/** Délai sans nouvelles au-delà duquel une candidature envoyée passe « Sans réponse » (fiche). */
export const NO_RESPONSE_DAYS = 21;

export type DisplayStatus = Status | "Sans réponse";
export const DISPLAY_STATUSES: DisplayStatus[] = ["Envoyée", "Sans réponse", "Entretien", "Offre", "Refus"];

/** « Sans réponse » n'est pas stocké : il dépend de la date du jour. */
export function displayStatus(status: Status, lastEventAt: Date, now: Date): DisplayStatus {
  const days = (now.getTime() - lastEventAt.getTime()) / (24 * 60 * 60 * 1000);
  return status === "Envoyée" && days > NO_RESPONSE_DAYS ? "Sans réponse" : status;
}

export interface CandidatureRow {
  id: string;
  company: string | null;
  jobTitle: string | null;
  location: string | null;
  channel: string | null;
  offerUrl: string | null;
  status: DisplayStatus;
  /** Statut enregistré (sans « Sans réponse »), pour le formulaire de modification. */
  rawStatus: Status;
  /** Informations corrigées à la main : company, jobTitle, location, channel, offerUrl, status. */
  manual: string[];
  appliedAt: Date;
  lastEventAt: Date;
  lastEventType: string;
  toCheck: boolean;
  mailCount: number;
}

export interface MailRow {
  gmailId: string;
  threadId: string | null;
  date: Date;
  type: string;
  sent: boolean;
  correspondent: string | null;
  subject: string | null;
  justification: string | null;
  toCheck: boolean;
}

type Row = Record<string, string | number | null>;

function toCandidature(r: Row, now: Date): CandidatureRow {
  const lastEventAt = new Date(r.last_event_at as string);
  return {
    id: r.id as string,
    company: r.company as string | null,
    jobTitle: r.job_title as string | null,
    location: r.location as string | null,
    channel: r.channel as string | null,
    offerUrl: r.offer_url as string | null,
    status: displayStatus(r.status as Status, lastEventAt, now),
    rawStatus: r.status as Status,
    manual: r.manual ? String(r.manual).split(",") : [],
    appliedAt: new Date(r.applied_at as string),
    lastEventAt,
    lastEventType: r.last_event_type as string,
    toCheck: r.to_check === 1,
    mailCount: r.mail_count as number,
  };
}

const SELECT_CANDIDATURES = `
  SELECT c.*, (SELECT COUNT(*) FROM mail_links l WHERE l.candidature_id = c.id) AS mail_count
  FROM candidatures c`;

/** Toutes les candidatures, la plus récemment active en premier. */
export function listCandidatures(db: DatabaseSync, now: Date): CandidatureRow[] {
  const rows = db.prepare(`${SELECT_CANDIDATURES} ORDER BY c.last_event_at DESC`).all() as Row[];
  return rows.map((r) => toCandidature(r, now));
}

export function getCandidature(
  db: DatabaseSync,
  id: string,
  now: Date,
): { candidature: CandidatureRow; mails: MailRow[] } | null {
  const row = db.prepare(`${SELECT_CANDIDATURES} WHERE c.id = ?`).get(id) as Row | undefined;
  if (!row) return null;
  const mails = db
    .prepare(
      `SELECT r.gmail_id, r.thread_id, r.received_at, r.event_type, r.sent, r.correspondent, r.subject,
              r.justification, l.to_check
       FROM mail_links l JOIN mail_results r USING (gmail_id)
       WHERE l.candidature_id = ? ORDER BY r.received_at`,
    )
    .all(id) as Row[];
  return {
    candidature: toCandidature(row, now),
    mails: mails.map((m) => ({
      gmailId: m.gmail_id as string,
      threadId: m.thread_id as string | null,
      date: new Date(m.received_at as string),
      type: m.event_type as string,
      sent: m.sent === 1,
      correspondent: m.correspondent as string | null,
      subject: m.subject as string | null,
      justification: m.justification as string | null,
      toCheck: m.to_check === 1,
    })),
  };
}

export interface MailToClassify {
  gmailId: string;
  threadId: string | null;
  date: Date;
  sent: boolean;
  correspondent: string | null;
  subject: string | null;
  company: string | null;
}

/** Mails liés à une candidature d'après Claude, mais rattachés à aucune : à classer à la main. */
export function listToClassify(db: DatabaseSync): MailToClassify[] {
  const rows = db
    .prepare(
      `SELECT r.gmail_id, r.thread_id, r.received_at, r.sent, r.correspondent, r.subject, r.company
       FROM mail_links l JOIN mail_results r USING (gmail_id)
       WHERE l.candidature_id IS NULL ORDER BY r.received_at`,
    )
    .all() as Row[];
  return rows.map((r) => ({
    gmailId: r.gmail_id as string,
    threadId: r.thread_id as string | null,
    date: new Date(r.received_at as string),
    sent: r.sent === 1,
    correspondent: r.correspondent as string | null,
    subject: r.subject as string | null,
    company: r.company as string | null,
  }));
}

export interface CorrectionRow {
  id: number;
  createdAt: Date;
  description: string;
}

const FIELD_LABELS: Record<string, string> = {
  company: "entreprise",
  jobTitle: "poste",
  location: "lieu",
  channel: "canal",
  offerUrl: "lien de l'offre",
};

/** Toutes les corrections manuelles, la plus récente en premier, décrites en clair. */
export function listCorrections(db: DatabaseSync): CorrectionRow[] {
  const rows = db
    .prepare(
      `SELECT k.id, k.kind, k.target, k.field, k.value, k.created_at,
              m.subject AS mail_subject,
              t.company AS target_company, t.job_title AS target_job,
              v.company AS value_company, v.job_title AS value_job
       FROM corrections k
       LEFT JOIN mail_results m ON m.gmail_id = k.target
       LEFT JOIN candidatures t ON t.id = k.target
       LEFT JOIN candidatures v ON v.id = k.value
       ORDER BY k.id DESC`,
    )
    .all() as Row[];
  const name = (company: unknown, job: unknown) =>
    company || job ? `${company ?? "Entreprise inconnue"}${job ? ` · ${job}` : ""}` : "candidature introuvable";
  const mail = (r: Row) => `le mail « ${r.mail_subject || "sans objet"} »`;
  return rows.map((r) => {
    let description: string;
    switch (r.kind) {
      case "creer":
        description = `Candidature créée à partir du mail « ${r.mail_subject || "sans objet"} »`;
        break;
      case "rattacher":
        description = `${mail(r)} rattaché à ${name(r.value_company, r.value_job)}`;
        break;
      case "ignorer":
        description = `${mail(r)} ignoré`;
        break;
      case "champ":
        description = `${name(r.target_company, r.target_job)} : ${FIELD_LABELS[r.field as string] ?? r.field} → ${r.value ?? "vide"}`;
        break;
      case "statut":
        description = `${name(r.target_company, r.target_job)} : statut → ${r.value}`;
        break;
      case "pas_candidature":
        description = `${r.value ?? "Candidature"} : ce n'est pas une candidature`;
        break;
      default:
        description = `Correction ${r.kind}`;
    }
    return { id: r.id as number, createdAt: new Date(r.created_at as string), description: description[0].toUpperCase() + description.slice(1) };
  });
}

// --- Offres à regarder (#24) ---------------------------------------------------------------------

export interface OfferRow {
  id: number;
  title: string;
  company: string | null;
  location: string | null;
  contract: string | null;
  receivedAt: Date;
  justification: string | null;
  /** Page illisible : pas de tri par Claude. */
  unverified: boolean;
  /** Pas encore consultée. */
  isNew: boolean;
  /** Marquée prioritaire à la main (#27). */
  prioritized: boolean;
}

/** Gardées par Claude, ou non vérifiées (gardées par l'intitulé, page illisible) ; sans les ignorées. */
const TO_SEE = `title_keep = 1 AND ignored_at IS NULL AND (verdict = 'garder' OR page_status = 'non_verifiee')`;

export function listOffersToSee(db: DatabaseSync): OfferRow[] {
  const rows = db
    .prepare(
      `SELECT id, title, company, location, contract, received_at, justification, page_status, seen_at, prioritized_at
       FROM offers WHERE ${TO_SEE} ORDER BY prioritized_at IS NULL, received_at DESC, id`,
    )
    .all() as {
    id: number;
    title: string;
    company: string | null;
    location: string | null;
    contract: string | null;
    received_at: string;
    justification: string | null;
    page_status: string | null;
    seen_at: string | null;
    prioritized_at: string | null;
  }[];
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    company: r.company,
    location: r.location,
    contract: r.contract,
    receivedAt: new Date(r.received_at),
    justification: r.page_status === "non_verifiee" ? null : r.justification,
    unverified: r.page_status === "non_verifiee",
    isNew: r.seen_at === null,
    prioritized: r.prioritized_at !== null,
  }));
}

/** Annonces de la liste, et celles pas encore consultées (bouton de la page principale). */
export function countOffers(db: DatabaseSync): { total: number; new: number } {
  return db
    .prepare(`SELECT count(*) AS total, count(*) FILTER (WHERE seen_at IS NULL) AS new FROM offers WHERE ${TO_SEE}`)
    .get() as { total: number; new: number };
}

export interface OfferStats {
  /** Écartées ces 7 derniers jours par le filtre sur l'intitulé, puis par Claude. */
  rejectedByTitle: number;
  rejectedByClaude: number;
  /** Gardées par l'intitulé, en attente de lecture de la page ou du tri par Claude. */
  pending: number;
}

export function offerStats(db: DatabaseSync, now: Date): OfferStats {
  const since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const count = (where: string, ...params: string[]) =>
    (db.prepare(`SELECT count(*) AS n FROM offers WHERE ${where}`).get(...params) as { n: number }).n;
  return {
    rejectedByTitle: count("title_keep = 0 AND received_at >= ?", since),
    rejectedByClaude: count("verdict = 'ecarter' AND received_at >= ?", since),
    pending: count(
      "title_keep = 1 AND ignored_at IS NULL AND (page_status IS NULL OR (page_status = 'lue' AND verdict IS NULL))",
    ),
  };
}
