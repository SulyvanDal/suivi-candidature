// Simulation du filtre des annonces (#20) : npm run offres:simuler -- --days 14
//
// Relit les alertes d'offres de la période, en extrait les annonces, applique les deux variantes du
// filtre sur l'intitulé, puis ouvre les pages des annonces retenues pour mesurer ce qui est lisible
// et estimer le coût du filtre par Claude. N'écrit rien en base et n'appelle pas Claude.
// Ouvrir une annonce passe par le lien de suivi de la plateforme : elle peut compter ce « clic ».

import { gmail } from "@googleapis/gmail";
import { getAuthorizedClient } from "./auth.js";
import { loadTitleRules, openDb } from "./db.js";
import { extractMail, htmlTextWithLinks } from "./extract.js";
import { filterMail } from "./filter.js";
import { type PageResult, readOfferPage } from "./offer-page.js";
import { extractOffers, type Offer, platformOf, titleFilter } from "./offers.js";
import { withRetry } from "./retry.js";
import { gmailSource } from "./sync.js";

// Listes du filtre sur l'intitulé : celles de la base (valeurs de départ dans la migration 7).
const db = openDb();
const RULES = loadTitleRules(db);
db.close();

// Estimation du coût du filtre 2 (Claude Haiku 4.5, en dollars par million de jetons).
const PRICE_PER_MTOK = { input: 1, output: 5 };
/** Consignes + profil du candidat, envoyés avec chaque annonce. */
const PROMPT_TOKENS = 600;
const OUTPUT_TOKENS = 120;
const CHARS_PER_TOKEN = 3.5;
/** Hypothèse de l'utilisateur : le volume d'annonces va doubler. */
const VOLUME_FACTOR = 2;

const daysArg = process.argv.indexOf("--days");
const days = daysArg > 0 ? Number(process.argv[daysArg + 1]) : 14;

// --- 1. Alertes de la période -------------------------------------------------------------------

const api = gmail({ version: "v1", auth: await getAuthorizedClient() });
const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
const ids = await gmailSource(api).listIdsSince(since);

const offers: Offer[] = [];
const alertsByPlatform = new Map<string, { alerts: number; offers: number; empty: number }>();
await pool(ids, 5, async (id) => {
  const { data } = await withRetry(() => api.users.messages.get({ userId: "me", id, format: "full" }));
  const mail = extractMail(data);
  if (filterMail(mail).rule !== "alerte-offres") return;
  const platform = platformOf(mail.from);
  const key = platform ?? `ignorée : ${mail.from.replace(/.*@/, "").replace(/>.*/, "")}`;
  const stats = alertsByPlatform.get(key) ?? { alerts: 0, offers: 0, empty: 0 };
  stats.alerts++;
  if (platform) {
    const found = extractOffers(platform, htmlTextWithLinks(data), mail.subject);
    stats.offers += found.length;
    if (found.length === 0) stats.empty++;
    offers.push(...found);
  }
  alertsByPlatform.set(key, stats);
});

// --- 2. Filtre sur l'intitulé, deux variantes ---------------------------------------------------

const loose = titleFilter(RULES, "exclusion");
const strict = titleFilter(RULES, "garder-exclure");
const decisions = offers.map((o) => ({ offer: o, loose: loose(o), strict: strict(o) }));

console.log("Annonces (A = exclusion seule, B = garder + exclure) :\n");
for (const { offer: o, loose: a, strict: b } of [...decisions].sort((x, y) => x.offer.title.localeCompare(y.offer.title))) {
  const mark = (d: typeof a) => (d.keep ? "✓" : "·");
  const why = !a.keep ? `exclu (${a.match})` : b.keep ? `poste (${b.match})` : "aucun poste";
  console.log(
    `  A${mark(a)} B${mark(b)}  ${why.padEnd(26)} ${o.title.slice(0, 60).padEnd(60)} | ${(o.company ?? "?").slice(0, 25).padEnd(25)} | ${o.contract ?? "?"}`,
  );
}

// --- 3. Lecture des pages des annonces retenues par la variante la plus large (A) ---------------

const toRead = decisions.filter((d) => d.loose.keep).map((d) => d.offer);
console.log(`\nLecture de ${toRead.length} page(s) d'annonce…`);
const pages = new Map<Offer, PageResult>();
// Une page à la fois avec une pause : en rafale, Hellowork répond 403.
await pool(toRead, 1, async (o) => {
  pages.set(o, await readOfferPage(o.url));
  await new Promise((r) => setTimeout(r, 1000));
});

// --- 4. Bilan ------------------------------------------------------------------------------------

console.log(`\n=== Bilan sur ${days} jour(s) ===\n`);
console.log("Alertes par plateforme :");
for (const [key, s] of alertsByPlatform) {
  console.log(
    `  ${key.padEnd(32)} ${String(s.alerts).padStart(3)} alerte(s), ${String(s.offers).padStart(4)} annonce(s)` +
      (s.empty ? `  ⚠ ${s.empty} alerte(s) sans annonce reconnue` : ""),
  );
}

const fold = (s: string | null) => (s ?? "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();
const distinct = new Set(offers.map((o) => `${fold(o.title)}|${fold(o.company)}`)).size;
console.log(`\n${offers.length} annonce(s), dont ${offers.length - distinct} doublon(s) (même intitulé, même entreprise).`);

const keptA = decisions.filter((d) => d.loose.keep);
const keptB = decisions.filter((d) => d.strict.keep);
console.log(`Filtre 1, variante A (exclusion seule)    : ${keptA.length} gardée(s)`);
console.log(`Filtre 1, variante B (garder + exclure)   : ${keptB.length} gardée(s)`);

console.log("\nPages d'annonce (variante A) :");
const byHost = new Map<string, { ok: number; failed: Map<string, number>; chars: number }>();
for (const [offer, p] of pages) {
  const host = new URL(p.status === "a_reessayer" ? offer.url : p.url).host;
  const h = byHost.get(host) ?? { ok: 0, failed: new Map(), chars: 0 };
  if (p.status === "lue") {
    h.ok++;
    h.chars += p.description.length;
  } else {
    const why = `${p.status === "a_reessayer" ? "à réessayer" : "non vérifiée"} (${p.error})`;
    h.failed.set(why, (h.failed.get(why) ?? 0) + 1);
  }
  byHost.set(host, h);
}
for (const [host, h] of byHost) {
  const failed = [...h.failed].map(([r, n]) => `${n} ${r}`).join(", ");
  console.log(
    `  ${host.padEnd(32)} ${h.ok} lue(s)` +
      (h.ok ? ` (description : ${Math.round(h.chars / h.ok)} car. en moyenne)` : "") +
      (failed ? ` · ${failed}` : ""),
  );
}

// Coût : seules les annonces lisibles sont envoyées à Claude (les autres gardées avec une pastille).
const cost = (kept: typeof decisions) => {
  let input = 0;
  let n = 0;
  for (const { offer } of kept) {
    const p = pages.get(offer);
    if (p?.status !== "lue") continue;
    n++;
    input += PROMPT_TOKENS + p.description.length / CHARS_PER_TOKEN;
  }
  const dollars = (input * PRICE_PER_MTOK.input + n * OUTPUT_TOKENS * PRICE_PER_MTOK.output) / 1e6;
  return { n, dollars };
};
console.log(`\nCoût estimé du filtre 2 (Claude Haiku), volume ×${VOLUME_FACTOR} :`);
for (const [label, kept] of [["A", keptA], ["B", keptB]] as const) {
  const { n, dollars } = cost(kept);
  const period = dollars * VOLUME_FACTOR;
  console.log(
    `  Variante ${label} : ${n * VOLUME_FACTOR} annonce(s) lue(s) par Claude en ${days} j → ${period.toFixed(2)} $` +
      ` (≈ ${((period * 30) / days).toFixed(2)} $ par mois)`,
  );
}

// --- Outils ---------------------------------------------------------------------------------------

/** Traite les éléments avec au plus `size` tâches en parallèle. */
async function pool<T>(items: T[], size: number, task: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (next < items.length) await task(items[next++]);
    }),
  );
}
