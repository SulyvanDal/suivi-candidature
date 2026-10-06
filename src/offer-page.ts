// Lecture de la page d'une annonce (#22) : seule la description du poste est gardée.
//
// Les plateformes décrivent leurs annonces dans des données structurées schema.org (JobPosting,
// balise <script type="application/ld+json">), sans menus ni pied de page. Sans elles, on ne lit
// pas la page entière : l'annonce est « non vérifiée » (pas de filtre par Claude).

import type { DatabaseSync } from "node:sqlite";
import { convert } from "html-to-text";

/** Au-delà, la description est coupée (comme le texte des mails envoyé à Claude). */
export const MAX_DESCRIPTION_CHARS = 8000;
/** Pause entre deux pages : en rafale, Hellowork répond 403. */
const PAUSE_MS = 1000;

export type PageResult =
  /** Description lue ; `url` = adresse finale de l'annonce, sans le lien de suivi. */
  | { status: "lue"; url: string; description: string }
  /** Échec définitif : accès refusé, page disparue, pas de description. */
  | { status: "non_verifiee"; url: string; error: string }
  /** Échec passager (réseau, délai, serveur) : nouvel essai à la synchronisation suivante. */
  | { status: "a_reessayer"; error: string };

export async function readOfferPage(url: string, fetchPage: typeof fetch = fetch): Promise<PageResult> {
  let res: Response;
  try {
    res = await fetchPage(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(20_000),
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", "Accept-Language": "fr-FR,fr" },
    });
  } catch (err) {
    const timeout = err instanceof Error && err.name === "TimeoutError";
    return { status: "a_reessayer", error: timeout ? "délai dépassé" : "erreur réseau" };
  }
  const finalUrl = res.url || url;
  if (res.status === 429 || res.status >= 500) return { status: "a_reessayer", error: `HTTP ${res.status}` };
  if (!res.ok) return { status: "non_verifiee", url: finalUrl, error: `HTTP ${res.status}` };

  const description = jobPostingText(await res.text());
  if (!description) return { status: "non_verifiee", url: finalUrl, error: "pas de description structurée" };
  return { status: "lue", url: finalUrl, description };
}

interface JobPosting {
  "@type"?: string | string[];
  description?: string;
  experienceRequirements?: string | { monthsOfExperience?: number; description?: string };
}

/** Description de l'annonce (données JobPosting) en texte, plafonnée ; null si absente. */
export function jobPostingText(html: string): string | null {
  // Hellowork écrit le type de la balise « application/ld&#x2B;json ».
  for (const m of html.matchAll(/<script[^>]*application\/ld(?:\+|&#x2B;|&#43;)json[^>]*>([\s\S]*?)<\/script>/gi)) {
    let data: unknown;
    try {
      data = JSON.parse(m[1]);
    } catch {
      continue; // JSON invalide : balise suivante.
    }
    const job = candidates(data).find((i) => [i["@type"]].flat().includes("JobPosting"));
    if (!job?.description) continue;

    let text = convert(job.description, {
      wordwrap: false,
      selectors: [
        { selector: "a", options: { ignoreHref: true } },
        { selector: "img", format: "skip" },
      ],
    }).replace(/\n{3,}/g, "\n\n").trim();
    const xp = experience(job.experienceRequirements);
    if (xp) text += `\n\nExpérience demandée : ${xp}`;
    return text.length > MAX_DESCRIPTION_CHARS ? `${text.slice(0, MAX_DESCRIPTION_CHARS)}…` : text;
  }
  return null;
}

/** Objets d'une balise ld+json : l'objet lui-même, un tableau, ou un « @graph ». */
function candidates(data: unknown): JobPosting[] {
  if (Array.isArray(data)) return data.flatMap(candidates);
  if (!data || typeof data !== "object") return [];
  const graph = (data as { "@graph"?: unknown })["@graph"];
  return [data as JobPosting, ...(graph ? candidates(graph) : [])];
}

function experience(x: JobPosting["experienceRequirements"]): string | null {
  if (!x) return null;
  if (typeof x === "string") return x;
  if (x.monthsOfExperience !== undefined) return `${x.monthsOfExperience} mois`;
  return x.description ?? null;
}

/**
 * Lit, une par une, les pages des annonces gardées par le filtre sur l'intitulé et pas encore lues.
 * Ne lève pas d'erreur pour une page : un échec passager laisse l'annonce en attente.
 */
export async function readPendingPages(
  db: DatabaseSync,
  read: (url: string) => Promise<PageResult> = readOfferPage,
  pauseMs = PAUSE_MS,
): Promise<{ read: number; unverified: number; retry: number }> {
  const pending = db
    .prepare("SELECT id, url FROM offers WHERE title_keep = 1 AND page_status IS NULL ORDER BY id")
    .all() as { id: number; url: string }[];
  const stats = { read: 0, unverified: 0, retry: 0 };
  const now = () => new Date().toISOString();

  for (const [i, { id, url }] of pending.entries()) {
    if (i > 0 && pauseMs > 0) await new Promise((r) => setTimeout(r, pauseMs));
    const r = await read(url);
    if (r.status === "a_reessayer") {
      stats.retry++;
      db.prepare("UPDATE offers SET page_error = ? WHERE id = ?").run(r.error, id);
    } else {
      if (r.status === "lue") stats.read++;
      else stats.unverified++;
      db.prepare(
        `UPDATE offers SET page_status = ?, page_url = ?, description = ?, page_error = ?, page_read_at = ?
         WHERE id = ?`,
      ).run(r.status, r.url, r.status === "lue" ? r.description : null, r.status === "lue" ? null : r.error, now(), id);
    }
  }
  return stats;
}
