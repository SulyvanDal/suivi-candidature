// Synchronisation incrémentale : trouver les mails arrivés depuis le dernier passage.
//
// Gmail numérote chaque changement de la boîte (historyId, croissant). On mémorise le
// dernier numéro vu, et au passage suivant on demande à Gmail ce qui a été ajouté depuis.
// - Premier passage : listing par date depuis START_DATE.
// - Passages suivants : users.history.list depuis le historyId mémorisé.
// - historyId trop ancien (404) : retour au listing par date, depuis la dernière synchro.

import type { DatabaseSync } from "node:sqlite";
import type { gmail_v1 } from "@googleapis/gmail";
import { getSyncState, isProcessed, markProcessed, saveSyncState } from "./db.js";
import { httpStatus, withRetry } from "./retry.js";

/** Début de la recherche d'emploi (fiche fonctionnelle) : minuit, heure de Paris. */
export const START_DATE = new Date("2026-06-01T00:00:00+02:00");

/** Marge de recouvrement lors d'un retour au listing par date. */
const FALLBACK_MARGIN_MS = 24 * 60 * 60 * 1000;

/** Libellés des mails à ignorer. Les mails envoyés (SENT) sont gardés. */
const EXCLUDED_LABELS = new Set(["SPAM", "TRASH", "DRAFT"]);

/** Accès à Gmail utilisé par la synchronisation (remplaçable par un faux dans les tests). */
export interface MailSource {
  /** historyId actuel de la boîte. */
  currentHistoryId(): Promise<string>;
  /** Identifiants des mails reçus ou envoyés depuis une date, du plus ancien au plus récent. */
  listIdsSince(since: Date): Promise<string[]>;
  /**
   * Mails ajoutés depuis un historyId, dans l'ordre chronologique, et nouveau historyId.
   * Lève HistoryExpiredError si le historyId est trop ancien.
   */
  listAddedSince(historyId: string): Promise<{
    added: { id: string; labelIds: string[] }[];
    historyId: string;
  }>;
}

export class HistoryExpiredError extends Error {}

/** Mail listé par Gmail mais introuvable au téléchargement (supprimé entre-temps). */
export class MessageGoneError extends Error {}

/**
 * Échec propre à un mail (extraction impossible, Claude n'a pas pu le classer) : le mail est
 * enregistré avec l'erreur et la synchronisation continue. Les erreurs passagères (réseau,
 * serveur, plafond) ne doivent pas prendre cette forme : elles arrêtent le passage.
 */
export class MailFailedError extends Error {}

export interface SyncResult {
  mode: "initiale" | "incrementale" | "rattrapage";
  /** Mails traités pendant ce passage, du plus ancien au plus récent. */
  processed: string[];
  /** Mails disparus de Gmail avant d'être lus : ignorés. */
  gone: string[];
  /** Mails en échec (MailFailedError) : enregistrés avec l'erreur, à repasser par « reanalyse ». */
  failed: string[];
}

/**
 * Traite chaque nouveau mail avec onMessage, puis le marque comme traité.
 * Le historyId n'est enregistré qu'à la fin : après un plantage, le passage suivant
 * repart de l'ancien point et saute les mails déjà traités.
 */
export async function syncNewMessages(
  db: DatabaseSync,
  source: MailSource,
  onMessage: (id: string) => Promise<void>,
): Promise<SyncResult> {
  const state = getSyncState(db);
  let mode: SyncResult["mode"];
  let candidates: string[];
  let nextHistoryId: string;

  if (!state) {
    // Premier passage. Le historyId est lu AVANT le listing : un mail arrivé pendant
    // le listing sera rattrapé au passage suivant.
    mode = "initiale";
    nextHistoryId = await source.currentHistoryId();
    candidates = await source.listIdsSince(START_DATE);
  } else {
    try {
      mode = "incrementale";
      const { added, historyId } = await source.listAddedSince(state.historyId);
      candidates = added
        .filter((m) => !m.labelIds.some((label) => EXCLUDED_LABELS.has(label)))
        .map((m) => m.id);
      nextHistoryId = historyId;
    } catch (err) {
      if (!(err instanceof HistoryExpiredError)) throw err;
      mode = "rattrapage";
      nextHistoryId = await source.currentHistoryId();
      const since = new Date(Date.parse(state.lastSyncAt) - FALLBACK_MARGIN_MS);
      candidates = await source.listIdsSince(since);
    }
  }

  // Sans doublons, et sans les mails déjà traités.
  const toProcess = [...new Set(candidates)].filter((id) => !isProcessed(db, id));

  const processed: string[] = [];
  const gone: string[] = [];
  const failed: string[] = [];
  for (const id of toProcess) {
    try {
      await onMessage(id);
      processed.push(id);
    } catch (err) {
      // Mail supprimé depuis son arrivée, ou impossible à traiter : on passe au suivant, sinon
      // chaque passage suivant retomberait dessus sans jamais aboutir.
      if (err instanceof MessageGoneError) gone.push(id);
      else if (err instanceof MailFailedError) failed.push(id);
      else throw err;
    }
    markProcessed(db, id);
  }

  saveSyncState(db, nextHistoryId);
  return { mode, processed, gone, failed };
}

/** Télécharge un mail complet ; lève MessageGoneError s'il n'existe plus (404). */
export async function fetchFullMessage(api: gmail_v1.Gmail, id: string): Promise<gmail_v1.Schema$Message> {
  try {
    return (await withRetry(() => api.users.messages.get({ userId: "me", id, format: "full" }))).data;
  } catch (err) {
    if (httpStatus(err) === 404) throw new MessageGoneError(`Mail ${id} introuvable.`);
    throw err;
  }
}

/** Implémentation réelle de MailSource avec l'API Gmail. */
export function gmailSource(api: gmail_v1.Gmail): MailSource {
  return {
    async currentHistoryId() {
      const { data } = await withRetry(() => api.users.getProfile({ userId: "me" }));
      if (!data.historyId) throw new Error("Gmail n'a pas renvoyé de historyId.");
      return data.historyId;
    },

    async listIdsSince(since) {
      // Spams et corbeille sont exclus par défaut ; on exclut aussi les brouillons.
      const q = `after:${Math.floor(since.getTime() / 1000)} -in:drafts`;
      const ids: string[] = [];
      let pageToken: string | undefined;
      do {
        const { data } = await withRetry(() =>
          api.users.messages.list({ userId: "me", q, maxResults: 500, pageToken }),
        );
        for (const m of data.messages ?? []) if (m.id) ids.push(m.id);
        pageToken = data.nextPageToken ?? undefined;
      } while (pageToken);
      // Gmail renvoie les plus récents d'abord : on remet dans l'ordre chronologique.
      return ids.reverse();
    },

    async listAddedSince(startHistoryId) {
      const added: { id: string; labelIds: string[] }[] = [];
      let historyId = startHistoryId;
      let pageToken: string | undefined;
      try {
        do {
          const { data } = await withRetry(() =>
            api.users.history.list({
              userId: "me",
              startHistoryId,
              historyTypes: ["messageAdded"],
              maxResults: 500,
              pageToken,
            }),
          );
          for (const record of data.history ?? []) {
            for (const { message } of record.messagesAdded ?? []) {
              if (message?.id) added.push({ id: message.id, labelIds: message.labelIds ?? [] });
            }
          }
          if (data.historyId) historyId = data.historyId;
          pageToken = data.nextPageToken ?? undefined;
        } while (pageToken);
      } catch (err) {
        if (httpStatus(err) === 404) throw new HistoryExpiredError("historyId trop ancien");
        throw err;
      }
      return { added, historyId };
    },
  };
}
