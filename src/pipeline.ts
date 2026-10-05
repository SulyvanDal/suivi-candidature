// Traitement d'un mail : extraction du texte → pré-filtre → classification par Claude → base.

import type { DatabaseSync } from "node:sqlite";
import type { gmail_v1 } from "@googleapis/gmail";
import type { ClassificationResult } from "./classify.js";
import { saveMailResult } from "./db.js";
import { extractMail, type ExtractedMail } from "./extract.js";
import { filterMail, type FilterDecision } from "./filter.js";

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
}

export async function processMessage(id: string, deps: PipelineDeps): Promise<ProcessedMail> {
  const mail = extractMail(await deps.fetchMessage(id));
  const decision = filterMail(mail);
  // Seuls les mails gardés par le pré-filtre sont envoyés à Claude.
  const result = decision.keep ? await deps.classify(mail) : undefined;

  saveMailResult(deps.db, {
    gmailId: id,
    receivedAt: mail.date,
    sent: mail.sent,
    filterRule: decision.rule,
    filterMatch: decision.match,
    eventType: result?.classification.type,
    justification: result?.classification.justification,
    model: result ? deps.model : undefined,
  });
  return { mail, decision, result };
}
