// Traitement d'un mail : extraction du texte → pré-filtre → classification par Claude → base.
// Une alerte d'offres n'est pas classée : ses annonces sont extraites et filtrées sur l'intitulé (#21).

import type { DatabaseSync } from "node:sqlite";
import type { gmail_v1 } from "@googleapis/gmail";
import { ClassificationFailedError, type ClassificationResult } from "./classify.js";
import { loadTitleRules, saveMailResult, saveOffer } from "./db.js";
import { extractMail, type ExtractedMail, htmlTextWithLinks } from "./extract.js";
import { filterMail, type FilterDecision } from "./filter.js";
import { extractOffers, type Offer, platformOf, titleFilter } from "./offers.js";
import { MailFailedError } from "./sync.js";

export interface PipelineDeps {
  db: DatabaseSync;
  fetchMessage(id: string): Promise<gmail_v1.Schema$Message>;
  classify(mail: ExtractedMail): Promise<ClassificationResult>;
  model: string;
}

export interface ProcessedMail {
  mail: ExtractedMail;
  decision: FilterDecision;
  result?: ClassificationResult;
  /** Alerte d'offres : annonces trouvées, nouvelles (hors doublons), et gardées par le filtre. */
  offers?: { found: number; added: number; kept: number };
}

/**
 * Lève MailFailedError si ce mail ne peut pas être traité (il est alors enregistré avec l'erreur) ;
 * toute autre erreur (réseau, Claude indisponible, plafond) remonte telle quelle.
 */
export async function processMessage(id: string, deps: PipelineDeps): Promise<ProcessedMail> {
  const message = await deps.fetchMessage(id);
  let mail: ExtractedMail;
  let decision: FilterDecision;
  try {
    mail = extractMail(message);
    if (Number.isNaN(mail.date.getTime())) throw new Error("date du mail illisible");
    decision = filterMail(mail);
  } catch (err) {
    const error = `Extraction impossible : ${(err as Error).message}`;
    const date = new Date(Number(message.internalDate));
    saveMailResult(deps.db, {
      gmailId: id,
      threadId: message.threadId ?? null,
      receivedAt: Number.isNaN(date.getTime()) ? new Date() : date,
      sent: message.labelIds?.includes("SENT") ?? false,
      filterRule: "erreur",
      error,
    });
    throw new MailFailedError(error);
  }

  // Seuls les mails gardés par le pré-filtre sont envoyés à Claude.
  let result: ClassificationResult | undefined;
  let error: string | undefined;
  try {
    result = decision.keep ? await deps.classify(mail) : undefined;
  } catch (err) {
    // Claude n'a pas pu classer CE mail : enregistré sans classification, « reanalyse » le repassera.
    if (!(err instanceof ClassificationFailedError)) throw err;
    error = err.message;
  }

  saveMailResult(deps.db, {
    gmailId: id,
    threadId: mail.threadId,
    subject: mail.subject,
    correspondent: mail.sent ? mail.to : mail.from,
    receivedAt: mail.date,
    sent: mail.sent,
    filterRule: decision.rule,
    filterMatch: decision.match,
    eventType: result?.classification.type,
    justification: result?.classification.justification,
    model: result ? deps.model : undefined,
    company: result?.classification.entreprise,
    jobTitle: result?.classification.poste,
    location: result?.classification.lieu,
    channel: result?.classification.canal,
    offerUrl: result?.classification.lien_offre,
    error,
  });
  if (error) throw new MailFailedError(error);
  const offers = decision.rule === "alerte-offres" ? saveAlertOffers(deps.db, message, mail) : undefined;
  return { mail, decision, result, offers };
}

/** Annonces d'une alerte : extraites, filtrées sur l'intitulé, enregistrées sauf doublons. */
function saveAlertOffers(db: DatabaseSync, message: gmail_v1.Schema$Message, mail: ExtractedMail) {
  const platform = platformOf(mail.from);
  // Plateforme qu'on ne sait pas lire (Job Watch…) : alerte ignorée.
  if (!platform) return undefined;
  let offers: Offer[];
  try {
    offers = extractOffers(platform, htmlTextWithLinks(message), mail.subject);
  } catch (err) {
    // Alerte au format inattendu : le mail est déjà enregistré, ses annonces sont perdues.
    db.prepare("UPDATE mail_results SET error = ? WHERE gmail_id = ?").run(`Annonces illisibles : ${(err as Error).message}`, mail.id);
    throw new MailFailedError(`Annonces illisibles dans le mail ${mail.id}.`);
  }
  const filter = titleFilter(loadTitleRules(db), "garder-exclure");
  const stats = { found: 0, added: 0, kept: 0 };
  for (const offer of offers) {
    stats.found++;
    const d = filter(offer);
    if (!saveOffer(db, offer, d, { gmailId: mail.id, receivedAt: mail.date })) continue;
    stats.added++;
    if (d.keep) stats.kept++;
  }
  return stats;
}
