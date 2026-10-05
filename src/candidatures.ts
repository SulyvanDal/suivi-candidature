// Candidatures, recalculées entièrement à partir des événements (mails classés par Claude).
//
// Pour chaque événement, dans l'ordre chronologique :
// 1. même fil Gmail qu'un mail déjà rattaché → même candidature ;
// 2. même entreprise et même poste (noms rapprochés) → même candidature, de préférence en cours ;
// 3. sinon : candidature_envoyee / entretien / offre / refus créent une candidature,
//    un événement « autre » seul n'est pas rattaché.
// Plusieurs candidatures possibles → la plus récente, marquée « à vérifier ».

import type { DatabaseSync } from "node:sqlite";
import type { EventType } from "./classify.js";

export interface CandidatureEvent {
  gmailId: string;
  threadId: string | null;
  date: Date;
  type: Exclude<EventType, "hors_sujet">;
  company: string | null;
  jobTitle: string | null;
  location: string | null;
  channel: string | null;
  offerUrl: string | null;
}

export type Status = "Envoyée" | "Entretien" | "Offre" | "Refus";

export interface Candidature {
  /** gmail_id du premier mail : identifiant stable (référencé par les corrections manuelles). */
  id: string;
  company: string | null;
  jobTitle: string | null;
  location: string | null;
  channel: string | null;
  offerUrl: string | null;
  status: Status;
  appliedAt: Date;
  lastEventAt: Date;
  lastEventType: CandidatureEvent["type"];
  toCheck: boolean;
  events: string[];
}

export interface Link {
  candidatureId: string | null;
  toCheck: boolean;
}

const STATUS_OF: Partial<Record<CandidatureEvent["type"], Status>> = {
  candidature_envoyee: "Envoyée",
  entretien: "Entretien",
  offre: "Offre",
  refus: "Refus",
};

const isOpen = (c: Candidature) => c.status !== "Refus" && c.status !== "Offre";

// --- Rapprochement des noms ---------------------------------------------------------------

/** Mots qui ne distinguent pas une entreprise d'une autre. */
const COMPANY_STOPWORDS = new Set(["groupe", "group", "sa", "sas", "sarl", "the", "france"]);

function companyTokens(name: string): string[] {
  return name
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t && !COMPANY_STOPWORDS.has(t));
}

const startsWith = (long: string[], short: string[]) =>
  short.length > 0 && short.length <= long.length && short.every((t, i) => long[i] === t);

/** Skysoft ≈ SkySoft-ATM, Team.is ≈ Teamis, SII ≈ SII Group, Guarani ≈ Guarani Bordeaux. */
export function sameCompany(a: string, b: string): boolean {
  const [ta, tb] = [companyTokens(a), companyTokens(b)];
  if (ta.length === 0 || tb.length === 0) return false;
  return ta.join("") === tb.join("") || startsWith(ta, tb) || startsWith(tb, ta);
}

function normalizeJob(title: string): string {
  return title
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\b(h\/f|f\/h)\b/g, " ")
    .replace(/\([a-z]{1,5}\)|[·.](e|ne|trice)\b/g, " ") // écriture inclusive : (e), (trice), ·e
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Un intitulé contient l'autre, sans « (H/F) » ni écriture inclusive. */
export function sameJob(a: string, b: string): boolean {
  const [na, nb] = [normalizeJob(a), normalizeJob(b)];
  return na.length > 0 && nb.length > 0 && (na.includes(nb) || nb.includes(na));
}

/**
 * Correspondance entre un événement et une candidature :
 * - « forte » : entreprise et poste concordent (ou entreprise inconnue d'un côté, poste concordant) ;
 * - « faible » : même entreprise, poste inconnu d'un côté ;
 * - null : incompatibles.
 */
function match(c: Candidature, e: CandidatureEvent): "forte" | "faible" | null {
  const jobs = c.jobTitle && e.jobTitle ? sameJob(c.jobTitle, e.jobTitle) : null;
  if (c.company && e.company) {
    if (!sameCompany(c.company, e.company)) return null;
    if (jobs === null) return "faible";
    return jobs ? "forte" : null;
  }
  // Entreprise inconnue d'un côté (ex. Indeed Apply) : il faut un intitulé identique, pas seulement
  // contenu (« chef de projet » ne doit pas rejoindre « Chef de projet informatique » d'une autre entreprise).
  return c.jobTitle && e.jobTitle && normalizeJob(c.jobTitle) === normalizeJob(e.jobTitle) ? "forte" : null;
}

// --- Recalcul ------------------------------------------------------------------------------

export function buildCandidatures(events: CandidatureEvent[]): {
  candidatures: Candidature[];
  links: Map<string, Link>;
} {
  const candidatures: Candidature[] = [];
  const links = new Map<string, Link>();
  const byThread = new Map<string, Candidature>();
  const sorted = [...events].sort((a, b) => a.date.getTime() - b.date.getTime());

  for (const e of sorted) {
    let target: Candidature | undefined;
    let toCheck = false;

    // 1. Même fil de discussion.
    if (e.threadId) target = byThread.get(e.threadId);

    // 2. Même entreprise et même poste.
    if (!target) {
      const strong = candidatures.filter((c) => match(c, e) === "forte");
      const pool = strong.length > 0 ? strong : candidatures.filter((c) => match(c, e) === "faible");
      const open = pool.filter(isOpen);
      // Un nouvel envoi ne rejoint jamais une candidature close : c'est une nouvelle candidature.
      const choices = open.length > 0 ? open : e.type === "candidature_envoyee" ? [] : pool;
      if (choices.length > 0) {
        target = choices.reduce((a, b) => (b.lastEventAt > a.lastEventAt ? b : a));
        toCheck = choices.length > 1;
      }
    }

    // 3. Création, ou mail « autre » non rattaché.
    if (!target) {
      const status = STATUS_OF[e.type];
      if (!status) {
        links.set(e.gmailId, { candidatureId: null, toCheck: false });
        continue;
      }
      target = {
        id: e.gmailId,
        company: null,
        jobTitle: null,
        location: null,
        channel: null,
        offerUrl: null,
        status,
        appliedAt: e.date,
        lastEventAt: e.date,
        lastEventType: e.type,
        toCheck: false,
        events: [],
      };
      candidatures.push(target);
    }

    apply(target, e);
    target.toCheck ||= toCheck;
    if (e.threadId) byThread.set(e.threadId, target);
    links.set(e.gmailId, { candidatureId: target.id, toCheck });
  }

  return { candidatures, links };
}

function apply(c: Candidature, e: CandidatureEvent): void {
  // Première valeur non vide.
  c.company ??= e.company;
  c.jobTitle ??= e.jobTitle;
  c.location ??= e.location;
  c.channel ??= e.channel;
  c.offerUrl ??= e.offerUrl;
  // Le dernier événement qui change le statut l'emporte.
  const status = STATUS_OF[e.type];
  if (status) c.status = status;
  c.lastEventAt = e.date;
  c.lastEventType = e.type;
  c.events.push(e.gmailId);
}

// --- Base de données ------------------------------------------------------------------------

/** Recalcule les candidatures à partir des mails classés, et remplace les tables calculées. */
export function rebuildCandidatures(db: DatabaseSync): { candidatures: Candidature[]; links: Map<string, Link> } {
  const rows = db
    .prepare(
      `SELECT gmail_id, thread_id, received_at, event_type, company, job_title, location, channel, offer_url
       FROM mail_results WHERE event_type IS NOT NULL AND event_type <> 'hors_sujet'`,
    )
    .all() as Record<string, string | null>[];

  const events: CandidatureEvent[] = rows.map((r) => ({
    gmailId: r.gmail_id!,
    threadId: r.thread_id,
    date: new Date(r.received_at!),
    type: r.event_type as CandidatureEvent["type"],
    company: r.company,
    jobTitle: r.job_title,
    location: r.location,
    channel: r.channel,
    offerUrl: r.offer_url,
  }));

  const result = buildCandidatures(events);
  // Corrections manuelles (table corrections) : à appliquer ici avec #13.

  db.exec("BEGIN");
  try {
    db.exec("DELETE FROM candidatures; DELETE FROM mail_links;");
    const insertC = db.prepare(
      `INSERT INTO candidatures (id, company, job_title, location, channel, offer_url, status,
         applied_at, last_event_at, last_event_type, to_check) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const c of result.candidatures) {
      insertC.run(
        c.id,
        c.company,
        c.jobTitle,
        c.location,
        c.channel,
        c.offerUrl,
        c.status,
        c.appliedAt.toISOString(),
        c.lastEventAt.toISOString(),
        c.lastEventType,
        c.toCheck ? 1 : 0,
      );
    }
    const insertL = db.prepare("INSERT INTO mail_links (gmail_id, candidature_id, to_check) VALUES (?, ?, ?)");
    for (const [gmailId, l] of result.links) insertL.run(gmailId, l.candidatureId, l.toCheck ? 1 : 0);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return result;
}
