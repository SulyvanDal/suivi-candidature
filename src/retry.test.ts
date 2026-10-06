import assert from "node:assert/strict";
import { test } from "node:test";
import { isOffline, isRateLimited, withRetry } from "./retry.js";

test("reconnaît l'absence de réseau, y compris dans la cause, et seulement elle", () => {
  // Message réel du 06/10/2026 au réveil du Mac.
  const msg = "request to https://oauth2.googleapis.com/token failed, reason: getaddrinfo ENOTFOUND oauth2.googleapis.com";
  assert.equal(isOffline(new Error(msg)), true);
  assert.equal(isOffline(Object.assign(new Error("fetch failed"), { cause: { code: "ENETUNREACH" } })), true);
  assert.equal(isOffline(Object.assign(new Error("Not Found"), { status: 404 })), false);
  assert.equal(isOffline(new Error("invalid_grant")), false);
});

const rateLimitError = () =>
  Object.assign(new Error("Quota exceeded for quota metric 'Total Query Cost'"), { status: 403 });

test("reconnaît les erreurs de limite de débit, et seulement elles", () => {
  assert.equal(isRateLimited(rateLimitError()), true);
  assert.equal(isRateLimited(Object.assign(new Error("Too Many Requests"), { status: 429 })), true);
  assert.equal(isRateLimited(Object.assign(new Error("Forbidden"), { status: 403 })), false);
  assert.equal(isRateLimited(Object.assign(new Error("Not Found"), { status: 404 })), false);
});

test("réessaie après une limite de débit, puis réussit", async () => {
  let calls = 0;
  const result = await withRetry(async () => {
    if (++calls < 2) throw rateLimitError();
    return "ok";
  });
  assert.equal(result, "ok");
  assert.equal(calls, 2);
});

test("ne réessaie pas les autres erreurs", async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(async () => {
      calls++;
      throw Object.assign(new Error("Not Found"), { status: 404 });
    }),
  );
  assert.equal(calls, 1);
});

test("abandonne après le nombre maximal de tentatives", async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(async () => {
      calls++;
      throw rateLimitError();
    }, 2),
  );
  assert.equal(calls, 2);
});
