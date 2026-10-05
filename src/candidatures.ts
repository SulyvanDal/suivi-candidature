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
  /** Date du mail qui a fixé le statut (pour savoir si un statut manuel est plus récent). */
  statusAt: Date;
  /** Informations corrigées à la main (#18) : company, jobTitle…, et « status ». */
  manual: string[];
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

/** Décisions manuelles sur un mail (#17) : la plus récente pour un mail l'emporte. */
export type MailCorrection =
  | { kind: "creer"; gmailId: string }
  | { kind: "rattacher"; gmailId: string; candidatureId: string }
  | { kind: "ignorer"; gmailId: string };

export const EDITABLE_FIELDS = ["company", "jobTitle", "location", "channel", "offerUrl"] as const;
export type EditableField = (typeof EDITABLE_FIELDS)[number];

/** Décisions manuelles sur une candidature (#18), appliquées une fois les candidatures construites. */
export type CandidatureCorrection =
  | { kind: "champ"; candidatureId: string; field: EditableField; value: string | null }
  // Option A : le statut manuel vaut jusqu'au prochain mail qui change le statut.
  | { kind: "statut"; candidatureId: string; value: Status; at: Date }
  | { kind: "pas_candidature"; candidatureId: string };

export type Correction = MailCorrection | CandidatureCorrection;

const isMailCorrection = (c: Correction): c is MailCorrection =>
  c.kind === "creer" || c.kind === "rattacher" || c.kind === "ignorer";

export function buildCandidatures(
  events: CandidatureEvent[],
  corrections: Correction[] = [],
): {
  candidatures: Candidature[];
  links: Map<string, Link>;
} {
  const decided = new Map(corrections.filter(isMailCorrection).map((c) => [c.gmailId, c]));
  const candidatures: Candidature[] = [];
  const byId = new Map<string, Candidature>();
  const links = new Map<string, Link>();
  const byThread = new Map<string, Candidature>();
  // Rattachements forcés vers une candidature pas encore créée : traités à la fin.
  const deferred: { e: CandidatureEvent; candidatureId: string }[] = [];
  const sorted = [...events].sort((a, b) => a.date.getTime() - b.date.getTime());

  const attach = (target: Candidature, e: CandidatureEvent, toCheck: boolean) => {
    apply(target, e);
    target.toCheck ||= toCheck;
    if (e.threadId) byThread.set(e.threadId, target);
    links.set(e.gmailId, { candidatureId: target.id, toCheck });
  };

  for (const e of sorted) {
    const decision = decided.get(e.gmailId);

    // Décisions manuelles : elles passent avant les règles automatiques.
    if (decision?.kind === "ignorer") continue;
    if (decision?.kind === "rattacher") {
      const forced = byId.get(decision.candidatureId);
      if (forced) attach(forced, e, false);
      else deferred.push({ e, candidatureId: decision.candidatureId });
      continue;
    }
    const forceCreate = decision?.kind === "creer";

    let target: Candidature | undefined;
    let toCheck = false;

    // 1. Même fil de discussion.
    if (!forceCreate && e.threadId) target = byThread.get(e.threadId);

    // 2. Même entreprise et même poste.
    if (!forceCreate && !target) {
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

    // 3. Création (un mail « créer » compte comme un envoi), ou mail « autre » non rattaché.
    if (!target) {
      const status = forceCreate ? "Envoyée" : STATUS_OF[e.type];
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
        statusAt: e.date,
        manual: [],
      };
      candidatures.push(target);
      byId.set(target.id, target);
    }

    attach(target, e, toCheck);
  }

  // Candidature cible disparue : le mail redevient « à classer ».
  for (const { e, candidatureId } of deferred) {
    const forced = byId.get(candidatureId);
    if (forced) attach(forced, e, false);
    else links.set(e.gmailId, { candidatureId: null, toCheck: false });
  }

  // Corrections sur les candidatures (#18), dans l'ordre où elles ont été faites.
  let result = candidatures;
  for (const c of corrections) {
    if (isMailCorrection(c)) continue;
    const target = byId.get(c.candidatureId);
    if (!target) continue; // candidature disparue : correction sans effet
    if (c.kind === "champ") {
      target[c.field] = c.value;
      if (!target.manual.includes(c.field)) target.manual.push(c.field);
    } else if (c.kind === "statut") {
      // Un mail arrivé après la correction et qui change le statut reprend la main.
      if (c.at >= target.statusAt) {
        target.status = c.value;
        if (!target.manual.includes("status")) target.manual.push("status");
      }
    } else {
      // « Ce n'est pas une candidature » : elle disparaît avec ses mails (ni rattachés ni à classer).
      result = result.filter((x) => x !== target);
      byId.delete(target.id);
      for (const gmailId of target.events) links.delete(gmailId);
    }
  }

  return { candidatures: result, links };
}

function apply(c: Candidature, e: CandidatureEvent): void {
  // Première valeur non vide.
  c.company ??= e.company;
  c.jobTitle ??= e.jobTitle;
  c.location ??= e.location;
  c.channel ??= e.channel;
  c.offerUrl ??= e.offerUrl;
  // Un mail plus ancien rattaché après coup ne fait pas reculer le dernier événement.
  if (e.date < c.appliedAt) c.appliedAt = e.date;
  if (e.date >= c.lastEventAt) {
    const status = STATUS_OF[e.type];
    if (status) {
      c.status = status;
      c.statusAt = e.date;
    }
    c.lastEventAt = e.date;
    c.lastEventType = e.type;
  }
  c.events.push(e.gmailId);
}

// --- Base de données ------------------------------------------------------------------------

const FIELD_COLUMNS: Record<EditableField, string> = {
  company: "company",
  jobTitle: "job_title",
  location: "location",
  channel: "channel",
  offerUrl: "offer_url",
};
const STATUSES: Status[] = ["Envoyée", "Entretien", "Offre", "Refus"];

/** Corrections manuelles, dans l'ordre d'enregistrement. */
export function loadCorrections(db: DatabaseSync): Correction[] {
  const rows = db
    .prepare("SELECT kind, target, field, value, created_at FROM corrections ORDER BY id")
    .all() as { kind: string; target: string; field: string | null; value: string | null; created_at: string }[];
  const corrections: Correction[] = [];
  for (const r of rows) {
    if (r.kind === "creer" || r.kind === "ignorer") corrections.push({ kind: r.kind, gmailId: r.target });
    else if (r.kind === "rattacher") corrections.push({ kind: "rattacher", gmailId: r.target, candidatureId: r.value ?? "" });
    else if (r.kind === "champ" && EDITABLE_FIELDS.includes(r.field as EditableField))
      corrections.push({ kind: "champ", candidatureId: r.target, field: r.field as EditableField, value: r.value });
    else if (r.kind === "statut" && STATUSES.includes(r.value as Status))
      corrections.push({ kind: "statut", candidatureId: r.target, value: r.value as Status, at: new Date(r.created_at) });
    else if (r.kind === "pas_candidature") corrections.push({ kind: "pas_candidature", candidatureId: r.target });
  }
  return corrections;
}

/**
 * Enregistre une décision manuelle. Elle survit à tous les recalculs.
 * `label` décrit la cible pour la page Corrections (utile quand la candidature a disparu).
 */
export function addCorrection(db: DatabaseSync, correction: Correction, label: string | null = null): void {
  const insert = db.prepare(
    "INSERT INTO corrections (kind, target, field, value, created_at) VALUES (?, ?, ?, ?, ?)",
  );
  const now = new Date().toISOString();
  switch (correction.kind) {
    case "creer":
    case "ignorer":
      insert.run(correction.kind, correction.gmailId, null, null, now);
      break;
    case "rattacher":
      insert.run("rattacher", correction.gmailId, null, correction.candidatureId, now);
      break;
    case "champ":
      insert.run("champ", correction.candidatureId, correction.field, correction.value, now);
      break;
    case "statut":
      insert.run("statut", correction.candidatureId, null, correction.value, correction.at.toISOString());
      break;
    case "pas_candidature":
      insert.run("pas_candidature", correction.candidatureId, null, label, now);
      break;
  }
}

/** Annule une correction : elle est supprimée, et le prochain recalcul fait comme si elle n'avait pas existé. */
export function cancelCorrection(db: DatabaseSync, id: number): boolean {
  return Number(db.prepare("DELETE FROM corrections WHERE id = ?").run(id).changes) > 0;
}

export { FIELD_COLUMNS };

/** Recalcule les candidatures à partir des mails classés et des corrections manuelles,
 *  et remplace les tables calculées. */
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

  const result = buildCandidatures(events, loadCorrections(db));

  db.exec("BEGIN");
  try {
    db.exec("DELETE FROM candidatures; DELETE FROM mail_links;");
    const insertC = db.prepare(
      `INSERT INTO candidatures (id, company, job_title, location, channel, offer_url, status,
         applied_at, last_event_at, last_event_type, to_check, manual) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        c.manual.join(","),
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
