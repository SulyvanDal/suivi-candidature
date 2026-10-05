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
