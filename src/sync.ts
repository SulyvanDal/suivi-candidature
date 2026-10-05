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

export interface SyncResult {
  mode: "initiale" | "incrementale" | "rattrapage";
  /** Mails traités pendant ce passage, du plus ancien au plus récent. */
  processed: string[];
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

  for (const id of toProcess) {
    await onMessage(id);
    markProcessed(db, id);
  }

  saveSyncState(db, nextHistoryId);
  return { mode, processed: toProcess };
}

/** Implémentation réelle de MailSource avec l'API Gmail. */
export function gmailSource(api: gmail_v1.Gmail): MailSource {
  return {
    async currentHistoryId() {
      const { data } = await api.users.getProfile({ userId: "me" });
      if (!data.historyId) throw new Error("Gmail n'a pas renvoyé de historyId.");
      return data.historyId;
    },

    async listIdsSince(since) {
      // Spams et corbeille sont exclus par défaut ; on exclut aussi les brouillons.
      const q = `after:${Math.floor(since.getTime() / 1000)} -in:drafts`;
      const ids: string[] = [];
      let pageToken: string | undefined;
      do {
        const { data } = await api.users.messages.list({ userId: "me", q, maxResults: 500, pageToken });
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
          const { data } = await api.users.history.list({
            userId: "me",
            startHistoryId,
            historyTypes: ["messageAdded"],
            maxResults: 500,
            pageToken,
          });
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

export function httpStatus(err: unknown): number | undefined {
  const e = err as { status?: number; response?: { status?: number } };
  return e?.status ?? e?.response?.status;
}
