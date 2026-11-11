import assert from "node:assert/strict";
import { test } from "node:test";
import { authorizationExpiry, expiryCheck, lastSyncCheck, logsCheck, permissionsCheck, termsCheck } from "./check-setup.js";

test("autorisation : fin de validité = heure de la dernière réponse de Google + temps restant", () => {
  const response = Date.parse("2026-11-09T07:00:01Z");
  const expiry = authorizationExpiry({ expiry_date: response + 3600_000, refresh_token_expires_in: 198248 });
  assert.equal(expiry?.toISOString(), "2026-11-11T14:04:09.000Z");
  assert.equal(authorizationExpiry({ expiry_date: response + 3600_000 }), null, "En production : pas d'expiration");
});

test("autorisation : alerte à moins de 2 jours, avec la commande pour la renouveler", () => {
  const expiry = new Date("2026-11-11T14:04:09Z"); // 15 h à Paris
  const soon = expiryCheck(expiry, new Date("2026-11-10T08:00:00Z"));
  assert.equal(soon.level, "attention");
  assert.match(soon.text, /jusqu'au 11\/11 vers 15 h/);
  assert.equal(soon.fix, "pour la renouveler dès maintenant : rm secrets/token.json puis npm run list");
  assert.equal(expiryCheck(expiry, new Date("2026-11-05T08:00:00Z")).level, "ok");
  assert.match(expiryCheck(null).text, /sans date d'expiration/);
});

test("secrets : seuls les fichiers lisibles par d'autres comptes sont signalés", () => {
  const files = [
    { path: "secrets/token.json", mode: 0o100600 },
    { path: "secrets/anthropic-api-key", mode: 0o100644 },
  ];
  const result = permissionsCheck(files);
  assert.equal(result.level, "attention");
  assert.equal(result.fix, "chmod 600 secrets/anthropic-api-key");
  assert.equal(permissionsCheck(files.slice(0, 1)).level, "ok");
});

test("dernière synchronisation : premier passage à simuler d'abord, sur toute la période", () => {
  const start = new Date("2026-10-04T22:00:00Z"); // 05/10/2026 à minuit, Paris
  const now = new Date("2026-11-09T09:00:00Z");
  const none = lastSyncCheck(null, start, now);
  assert.equal(none.level, "attention");
  assert.match(none.fix ?? "", /npm run filter -- --days 36 et npm run offres:simuler -- --days 36/);
  assert.match(none.fix ?? "", /npm run sync \(payant\) : premier passage depuis le 05\/10\/2026/);

  const recent = lastSyncCheck("2026-11-09T07:00:17Z", start, now);
  assert.deepEqual(recent, { level: "ok", text: "Dernière synchronisation complète : 09/11/2026 08:00" });
  const old = lastSyncCheck("2026-11-06T07:00:00Z", start, now);
  assert.equal(old.level, "attention");
  assert.match(old.text, /il y a 3 jour\(s\)$/);
});

test("mots-clés : ceux d'origine de l'outil (aucun poste de la configuration) sont à remplacer", () => {
  const wanted = { postes: ["chef de projet", "product owner"], exclus: ["stage"] };
  const original = termsCheck({ keep: ["data analyst"], exclude: ["stage"] }, wanted);
  assert.equal(original.level, "probleme");
  assert.equal(original.fix, "npm run config:initialiser -- --remplacer");

  const same = termsCheck({ keep: ["product owner", "chef de projet"], exclude: ["stage"] }, wanted);
  assert.deepEqual(same, { level: "ok", text: "Mots-clés : 2 poste(s) recherché(s), 1 mot(s) exclu(s), conformes à la configuration" });
  const edited = termsCheck({ keep: ["product owner", "data analyst"], exclude: [] }, wanted);
  assert.equal(edited.level, "ok", "modifiés dans l'interface : normal");
  assert.match(edited.text, /différents de la configuration de départ/);
});

const success = (day: string) => `${day} 08:00:17 · synchronisation incrementale · 9 mail(s), 1 envoyé(s) à Claude\n`;
const expired = (day: string) =>
  `${day} 08:26:46 · Autorisation Gmail expirée ou révoquée. Lancer « npm run sync » pour réautoriser.\n`;
const offline = (day: string) =>
  `${day} 08:12:55 · Pas de réseau : request to https://oauth2.googleapis.com/token failed, reason: getaddrinfo ENOTFOUND\n`;

test("journaux : jours manqués regroupés par cause, aujourd'hui compté seulement une fois lancé", () => {
  const logs = new Map([
    ["sync-2026-11-02.log", expired("02/11/2026")], // hors des 7 derniers jours
    ["sync-2026-11-03.log", expired("03/11/2026")],
    ["sync-2026-11-04.log", expired("04/11/2026")],
    ["sync-2026-11-05.log", offline("05/11/2026") + success("05/11/2026")], // réussie à l'essai suivant
    // 06/11 : aucun journal
    ["sync-2026-11-07.log", offline("07/11/2026")],
    ["sync-2026-11-08.log", success("08/11/2026")],
    [".terminee-2026-11-08", ""],
  ]);
  const beforeEight = new Date("2026-11-09T06:30:00Z");
  assert.deepEqual(logsCheck(logs, beforeEight), {
    level: "attention",
    text:
      "Synchronisée 2 jour(s) sur 6 ; manqués : 03/11, 04/11 (autorisation Gmail expirée ou révoquée) ; " +
      "06/11 (aucun lancement : Mac éteint ou en veille ?) ; 07/11 (pas de réseau)",
  });

  logs.set("sync-2026-11-09.log", success("09/11/2026"));
  assert.match(logsCheck(logs, new Date("2026-11-09T08:00:00Z")).text, /^Synchronisée 3 jour\(s\) sur 7 ;/);
});

test("journaux : chaque jour depuis l'installation, ou aucun journal encore", () => {
  const logs = new Map([
    ["sync-2026-11-08.log", success("08/11/2026")],
    ["sync-2026-11-09.log", success("09/11/2026")],
  ]);
  assert.deepEqual(logsCheck(logs, new Date("2026-11-09T10:00:00Z")), {
    level: "ok",
    text: "Synchronisée chaque jour sur les 2 derniers jours",
  });
  assert.equal(logsCheck(new Map(), new Date()).level, "info");
});
