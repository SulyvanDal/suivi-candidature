import assert from "node:assert/strict";
import { test } from "node:test";
import { getSyncState, isProcessed, openDb } from "./db.js";
import { HistoryExpiredError, START_DATE, syncNewMessages, type MailSource } from "./sync.js";

/** Faux Gmail : chaque test décrit ce que la boîte renvoie, et on note les appels. */
function fakeSource(overrides: Partial<MailSource> = {}) {
  const calls = { listIdsSince: [] as Date[], listAddedSince: [] as string[] };
  const source: MailSource = {
    currentHistoryId: async () => "h1",
    listIdsSince: async () => [],
    listAddedSince: async (historyId) => ({ added: [], historyId }),
    ...overrides,
  };
  // On enregistre les appels même quand une méthode est remplacée.
  const { listIdsSince, listAddedSince } = source;
  source.listIdsSince = (since) => (calls.listIdsSince.push(since), listIdsSince(since));
  source.listAddedSince = (h) => (calls.listAddedSince.push(h), listAddedSince(h));
  return { source, calls };
}

const noop = async () => {};

test("premier passage : liste depuis le 1er juin et mémorise le historyId", async () => {
  const db = openDb(":memory:");
  const { source, calls } = fakeSource({
    currentHistoryId: async () => "h100",
    listIdsSince: async () => ["a", "b"],
  });

  const result = await syncNewMessages(db, source, noop);

  assert.equal(result.mode, "initiale");
  assert.deepEqual(result.processed, ["a", "b"]);
  assert.deepEqual(calls.listIdsSince, [START_DATE]);
  assert.equal(getSyncState(db)?.historyId, "h100");
  assert.ok(isProcessed(db, "a") && isProcessed(db, "b"));
});

test("second lancement sans nouveau mail : rien n'est retraité", async () => {
  const db = openDb(":memory:");
  await syncNewMessages(db, fakeSource({ listIdsSince: async () => ["a"] }).source, noop);

  const { source, calls } = fakeSource();
  const result = await syncNewMessages(db, source, noop);

  assert.equal(result.mode, "incrementale");
  assert.deepEqual(result.processed, []);
  assert.deepEqual(calls.listAddedSince, ["h1"]);
});

test("passage incrémental : nouveaux mails, sans spam, corbeille, brouillons ni doublons", async () => {
  const db = openDb(":memory:");
  await syncNewMessages(db, fakeSource({ listIdsSince: async () => ["a"] }).source, noop);

  const { source } = fakeSource({
    listAddedSince: async () => ({
      added: [
        { id: "a", labelIds: ["INBOX"] }, // déjà traité
        { id: "c", labelIds: ["INBOX", "UNREAD"] },
        { id: "d", labelIds: ["SPAM"] },
        { id: "e", labelIds: ["DRAFT"] },
        { id: "f", labelIds: ["TRASH"] },
        { id: "g", labelIds: ["SENT"] }, // mail envoyé : gardé
        { id: "c", labelIds: ["INBOX"] }, // doublon
      ],
      historyId: "h2",
    }),
  });
  const seen: string[] = [];
  const result = await syncNewMessages(db, source, async (id) => void seen.push(id));

  assert.deepEqual(result.processed, ["c", "g"]);
  assert.deepEqual(seen, ["c", "g"]);
  assert.equal(getSyncState(db)?.historyId, "h2");
});

test("historyId trop ancien : rattrapage par date depuis la dernière synchro moins un jour", async () => {
  const db = openDb(":memory:");
  await syncNewMessages(db, fakeSource({ listIdsSince: async () => ["a"] }).source, noop);
  const lastSyncAt = Date.parse(getSyncState(db)!.lastSyncAt);

  const { source, calls } = fakeSource({
    currentHistoryId: async () => "h9",
    listAddedSince: async () => {
      throw new HistoryExpiredError();
    },
    listIdsSince: async () => ["a", "z"],
  });
  const result = await syncNewMessages(db, source, noop);

  assert.equal(result.mode, "rattrapage");
  assert.deepEqual(result.processed, ["z"]);
  assert.equal(calls.listIdsSince[0].getTime(), lastSyncAt - 24 * 60 * 60 * 1000);
  assert.equal(getSyncState(db)?.historyId, "h9");
});

test("plantage en cours de route : le passage suivant reprend sans rien perdre ni refaire", async () => {
  const db = openDb(":memory:");
  const { source } = fakeSource({ listIdsSince: async () => ["a", "b", "c"] });

  await assert.rejects(
    syncNewMessages(db, source, async (id) => {
      if (id === "b") throw new Error("panne");
    }),
  );
  assert.equal(isProcessed(db, "a"), true);
  assert.equal(isProcessed(db, "b"), false);
  assert.equal(getSyncState(db), null); // historyId pas enregistré

  const seen: string[] = [];
  await syncNewMessages(db, source, async (id) => void seen.push(id));
  assert.deepEqual(seen, ["b", "c"]);
});
