import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildPlist, LABEL } from "./auto-install.js";
import { DailyBudgetReachedError, withBudget } from "./budget.js";
import { appleScriptString } from "./notify.js";

test("plafond : les appels passent jusqu'au maximum, puis lèvent une erreur dédiée sans appeler", async () => {
  let calls = 0;
  const budget = withBudget(async (x: number) => (calls++, x * 2), 2);
  assert.equal(await budget.call(1), 2);
  assert.equal(await budget.call(2), 4);
  await assert.rejects(budget.call(3), DailyBudgetReachedError);
  assert.equal(calls, 2);
  assert.equal(budget.used(), 2);
});

test("plafond infini en mode manuel", async () => {
  const budget = withBudget(async () => "ok", Infinity);
  for (let i = 0; i < 100; i++) await budget.call();
  assert.equal(budget.used(), 100);
});

test("notification : guillemets et antislashs échappés pour AppleScript", () => {
  assert.equal(appleScriptString('lance « npm run sync » "vite" \\ fin'), '"lance « npm run sync » \\"vite\\" \\\\ fin"');
});

test("fichier launchd : valide pour macOS, lancé à l'heure demandée avec le dossier de node dans le PATH", () => {
  const plist = buildPlist("/Users/moi/Projet & Co", "/opt/node/bin", 8);
  assert.match(plist, new RegExp(`<string>${LABEL}</string>`));
  assert.match(plist, /<key>Hour<\/key>\s*<integer>8<\/integer>/);
  assert.match(plist, /<string>\/opt\/node\/bin:\/usr\/bin/);
  assert.match(plist, /Projet &amp; Co\/scripts\/sync-auto\.sh/, "caractères spéciaux échappés");

  // Validation par l'outil officiel de macOS.
  const dir = mkdtempSync(join(tmpdir(), "plist-"));
  try {
    const file = join(dir, "test.plist");
    writeFileSync(file, plist);
    assert.match(execFileSync("plutil", ["-lint", file]).toString(), /OK/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
