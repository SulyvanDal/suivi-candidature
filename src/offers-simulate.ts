// Simulation du filtre des annonces (#20) : npm run offres:simuler -- --days 14
//
// Relit les alertes d'offres de la période, en extrait les annonces, applique les deux variantes du
// filtre sur l'intitulé, puis ouvre les pages des annonces retenues pour mesurer ce qui est lisible
// et estimer le coût du filtre par Claude. N'écrit rien en base et n'appelle pas Claude.
// Ouvrir une annonce passe par le lien de suivi de la plateforme : elle peut compter ce « clic ».

import { gmail } from "@googleapis/gmail";
import { convert } from "html-to-text";
import { getAuthorizedClient } from "./auth.js";
import { extractMail, htmlTextWithLinks } from "./extract.js";
import { filterMail } from "./filter.js";
import { extractOffers, type Offer, platformOf, type TitleRules, titleFilter } from "./offers.js";
import { withRetry } from "./retry.js";
import { gmailSource } from "./sync.js";

// Listes de l'utilisateur (06/10/2026, docs/fiche-offres.md). Elles seront modifiables depuis l'interface.
const RULES: TitleRules = {
  keep: [
    "product owner",
    "proxy po",
    "product manager",
    "product builder",
    "ops & product",
    "chef de projet*",
    "pmo",
    "consultant digital transformation",
    "business analyst",
    "amoa",
    "développeu*",
    "software engineer",
    "ingénieur logiciel",
  ],
  exclude: ["stage", "alternance", "freelance", "senior", "tech lead", "intérim"],
};

// Estimation du coût du filtre 2 (Claude Haiku 4.5, en dollars par million de jetons).
const PRICE_PER_MTOK = { input: 1, output: 5 };
/** Consignes + profil du candidat, envoyés avec chaque annonce. */
const PROMPT_TOKENS = 600;
const OUTPUT_TOKENS = 120;
/** Texte de l'annonce plafonné, comme pour les mails. */
const MAX_TEXT_CHARS = 8000;
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
const pages = new Map<Offer, Page>();
await pool(toRead, 3, async (o) => {
  pages.set(o, await readPage(o.url));
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
const byHost = new Map<string, { ok: number; blocked: Map<string, number>; chars: number; jsonLd: number }>();
for (const p of pages.values()) {
  const h = byHost.get(p.host) ?? { ok: 0, blocked: new Map(), chars: 0, jsonLd: 0 };
  if (p.ok) {
    h.ok++;
    h.chars += p.chars;
    if (p.source === "json-ld") h.jsonLd++;
  } else h.blocked.set(p.reason, (h.blocked.get(p.reason) ?? 0) + 1);
  byHost.set(p.host, h);
}
for (const [host, h] of byHost) {
  const blocked = [...h.blocked].map(([r, n]) => `${n} ${r}`).join(", ");
  console.log(
    `  ${host.padEnd(32)} ${h.ok} lisible(s)` +
      (h.ok ? ` (${Math.round(h.chars / h.ok)} car. en moyenne, ${h.jsonLd} via données structurées)` : "") +
      (blocked ? ` · bloquée(s) : ${blocked}` : ""),
  );
}

// Coût : seules les annonces lisibles sont envoyées à Claude (les autres gardées avec une pastille).
const cost = (kept: typeof decisions) => {
  let input = 0;
  let n = 0;
  for (const { offer } of kept) {
    const p = pages.get(offer);
    if (!p?.ok) continue;
    n++;
    input += PROMPT_TOKENS + Math.min(p.chars, MAX_TEXT_CHARS) / CHARS_PER_TOKEN;
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

interface Page {
  ok: boolean;
  /** Domaine final, après les redirections du lien de suivi. */
  host: string;
  reason: string;
  chars: number;
  source: "json-ld" | "page" | null;
}

/** Ouvre une annonce (redirections suivies) et mesure le texte utile : données structurées JobPosting si présentes. */
async function readPage(url: string): Promise<Page> {
  let host = new URL(url).host;
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(20_000),
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", "Accept-Language": "fr-FR,fr" },
    });
    host = new URL(res.url).host;
    if (!res.ok) return { ok: false, host, reason: `HTTP ${res.status}`, chars: 0, source: null };
    const html = await res.text();
    const posting = jobPostingDescription(html);
    const text = posting ?? convert(html, { wordwrap: false, selectors: [{ selector: "a", options: { ignoreHref: true } }, { selector: "img", format: "skip" }] });
    if (/captcha|just a moment|verify you are human|access denied/i.test(text.slice(0, 3000)) || text.length < 300) {
      return { ok: false, host, reason: "protection anti-robot", chars: 0, source: null };
    }
    return { ok: true, host, reason: "", chars: text.length, source: posting ? "json-ld" : "page" };
  } catch (err) {
    return { ok: false, host, reason: err instanceof Error && err.name === "TimeoutError" ? "délai dépassé" : "erreur réseau", chars: 0, source: null };
  }
}

/** Description d'une annonce dans les données structurées schema.org (balise ld+json), en texte. */
function jobPostingDescription(html: string): string | null {
  for (const m of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const data = JSON.parse(m[1]);
      const items: unknown[] = [data, ...(Array.isArray(data) ? data : []), ...(data?.["@graph"] ?? [])];
      const job = items.find((i) => (i as { "@type"?: string })?.["@type"] === "JobPosting") as
        | { title?: string; description?: string }
        | undefined;
      if (job?.description) return `${job.title ?? ""}\n${convert(job.description, { wordwrap: false })}`;
    } catch {
      // JSON invalide : on essaie la balise suivante.
    }
  }
  return null;
}

/** Traite les éléments avec au plus `size` tâches en parallèle. */
async function pool<T>(items: T[], size: number, task: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (next < items.length) await task(items[next++]);
    }),
  );
}
