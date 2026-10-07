import assert from "node:assert/strict";
import { test } from "node:test";
import { getSyncState, isProcessed, openDb } from "./db.js";
import { HistoryExpiredError, MailFailedError, MessageGoneError, START_DATE, syncNewMessages, type MailSource } from "./sync.js";

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

test("mail supprimé de Gmail entre le listing et le téléchargement : ignoré, la synchro aboutit", async () => {
  const db = openDb(":memory:");
  const { source } = fakeSource({ listIdsSince: async () => ["a", "disparu", "b"] });

  const result = await syncNewMessages(db, source, async (id) => {
    if (id === "disparu") throw new MessageGoneError("introuvable");
  });

  assert.deepEqual(result.processed, ["a", "b"]);
  assert.deepEqual(result.gone, ["disparu"]);
  assert.ok(isProcessed(db, "disparu"), "pas retenté au passage suivant");
  assert.equal(getSyncState(db)?.historyId, "h1");
});

test("autre erreur pendant le traitement : la synchro s'arrête toujours (rien n'est ignoré à tort)", async () => {
  const db = openDb(":memory:");
  const { source } = fakeSource({ listIdsSince: async () => ["a"] });

  await assert.rejects(
    syncNewMessages(db, source, async () => {
      throw Object.assign(new Error("modèle introuvable"), { status: 404 });
    }),
  );
  assert.equal(isProcessed(db, "a"), false);
  assert.equal(getSyncState(db), null);
});

test("mail en échec : marqué traité, les suivants passent et le historyId est enregistré", async () => {
  const db = openDb(":memory:");
  const seen: string[] = [];
  const { source } = fakeSource({ currentHistoryId: async () => "h9", listIdsSince: async () => ["a", "b", "c"] });

  const result = await syncNewMessages(db, source, async (id) => {
    if (id === "b") throw new MailFailedError("Claude n'a pas pu classer ce mail.");
    seen.push(id);
  });

  assert.deepEqual(seen, ["a", "c"]);
  assert.deepEqual(result.processed, ["a", "c"]);
  assert.deepEqual(result.failed, ["b"]);
  assert.ok(isProcessed(db, "b"));
  assert.equal(getSyncState(db)?.historyId, "h9");
});

test("erreur passagère (réseau, Claude indisponible) : le passage s'arrête, rien n'est perdu", async () => {
  const db = openDb(":memory:");
  const { source } = fakeSource({ listIdsSince: async () => ["a", "b"] });

  await assert.rejects(
    syncNewMessages(db, source, async (id) => {
      if (id === "a") throw new Error("529 overloaded");
    }),
    /overloaded/,
  );
  assert.equal(isProcessed(db, "a"), false);
  assert.equal(getSyncState(db), null);
});
