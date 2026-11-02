// Annonces contenues dans les alertes d'offres d'emploi (#20).
//
// Chaque plateforme met ses alertes en forme à sa façon : un extracteur par plateforme, choisi
// d'après le domaine de l'expéditeur. Une alerte d'une plateforme sans extracteur est ignorée.
// Les extracteurs lisent le texte du HTML avec les liens complets (htmlTextWithLinks).

export interface Offer {
  platform: Platform;
  title: string;
  company: string | null;
  location: string | null;
  /** Type de contrat tel qu'affiché (CDI, Intérim, Alternance…). */
  contract: string | null;
  /** Lien de l'annonce (lien de suivi de la plateforme). */
  url: string;
}

export type Platform = "hellowork" | "indeed" | "welcome-to-the-jungle" | "linkedin";

const PLATFORMS: { platform: Platform; from: RegExp }[] = [
  { platform: "hellowork", from: /@emails\.hellowork\.com\b/i },
  { platform: "indeed", from: /@match\.indeed\.com\b/i },
  { platform: "welcome-to-the-jungle", from: /@welcometothejungle\.com\b/i },
  // Alertes de recherche (jobalerts) et « offres similaires à… » (jobs).
  { platform: "linkedin", from: /\b(jobs|jobalerts)-noreply@linkedin\.com\b/i },
];

/** Plateforme de l'alerte d'après l'expéditeur, ou null si on ne sait pas la lire. */
export function platformOf(from: string): Platform | null {
  return PLATFORMS.find((p) => p.from.test(from))?.platform ?? null;
}

/**
 * Pages d'annonce qu'on ne lit pas : LinkedIn exige une connexion, et on ne contourne pas les
 * protections des plateformes (#32). Ces annonces restent « non vérifiées », sans tri par Claude.
 */
export const readsPage = (platform: Platform) => platform !== "linkedin";

export function extractOffers(platform: Platform, text: string, subject = ""): Offer[] {
  if (platform === "hellowork") return hellowork(text);
  if (platform === "indeed") return indeed(text, subject);
  if (platform === "linkedin") return linkedin(text);
  return welcomeToTheJungle(text);
}

/** « Intitulé [https://…] » */
const LINKED = /^(.+?) \[(https?:\/\/[^\s\]]+)\]$/;
const paragraphs = (text: string) => text.split(/\n{2,}/).map((p) => p.trim());

/**
 * Hellowork : pour chaque annonce, des paragraphes successifs
 *   Intitulé [lien] / Entreprise (facultative) / Lieu / Contrat / Salaire (facultatif) / Voir l'offre [lien]
 * Une annonce anonyme n'a pas d'entreprise : les champs se lisent donc en partant du contrat.
 */
function hellowork(text: string): Offer[] {
  const offers: Offer[] = [];
  const paras = paragraphs(text);
  for (let i = 0; i < paras.length; i++) {
    const head = LINKED.exec(paras[i]);
    if (!head || /^voir /i.test(head[1])) continue;
    const end = paras.findIndex((p, j) => j > i && /^voir l.offre \[/i.test(p));
    if (end < 0) continue;
    const fields = paras.slice(i + 1, end);
    if (/€/.test(fields.at(-1) ?? "")) fields.pop(); // salaire
    const [contract, location, company] = fields.reverse();
    offers.push({
      platform: "hellowork",
      title: head[1],
      company: company?.replace(/Super recruteur$/, "").trim() || null,
      location: location ?? null,
      contract: contract ?? null,
      url: head[2],
    });
    i = end;
  }
  return offers;
}

/**
 * Indeed : une annonce par mail. L'intitulé est annoncé dans la phrase d'introduction, puis repris
 * en lien, suivi de l'entreprise et du lieu ; le contrat suit le titre « Type de poste ».
 */
function indeed(text: string, subject: string): Offer[] {
  const paras = paragraphs(text);
  const intro = /offre d.emploi suivante : (.+?)\. Envoyez/i.exec(text)?.[1] ?? subject.split(" – ")[0];
  if (!intro) return [];
  const i = paras.findIndex((p) => LINKED.exec(p)?.[1].toLowerCase() === intro.toLowerCase());
  if (i < 0) return [];
  const contractAt = paras.findIndex((p) => /^type de poste$/i.test(p));
  return [
    {
      platform: "indeed",
      title: intro,
      company: paras[i + 1] ?? null,
      location: paras[i + 2] ?? null,
      contract: contractAt >= 0 ? (paras[contractAt + 1] ?? null) : null,
      url: LINKED.exec(paras[i])![2],
    },
  ];
}

/** Welcome to the Jungle : « Entreprise [lien] Intitulé [lien] Contrat - Lieu » sur une ligne. */
function welcomeToTheJungle(text: string): Offer[] {
  const offers: Offer[] = [];
  const re = /^(.+?) \[(https?:\/\/[^\s\]]+)\] (.+?) \[(https?:\/\/[^\s\]]+)\] (.+?) - (.+)$/gm;
  for (const m of text.matchAll(re)) {
    if (/^voir /i.test(m[3])) continue;
    offers.push({ platform: "welcome-to-the-jungle", title: m[3], company: m[1], location: m[6], contract: m[5], url: m[4] });
  }
  return offers;
}

/**
 * LinkedIn : pour chaque annonce, deux paragraphes successifs
 *   Intitulé [lien …/jobs/view/<numéro>/…] / Entreprise · Lieu
 * Pas de type de contrat. Le lien est réduit à l'adresse de l'annonce : celui du mail porte des
 * paramètres de suivi et un jeton de connexion (otpToken) qu'on n'enregistre pas.
 */
function linkedin(text: string): Offer[] {
  const offers: Offer[] = [];
  const paras = paragraphs(text);
  for (let i = 0; i + 1 < paras.length; i++) {
    const head = LINKED.exec(paras[i]);
    const job = head && /\/jobs\/view\/(\d+)/.exec(head[2]);
    // L'en-tête « Offres similaires à… » pointe aussi vers une annonce, mais sans « Entreprise · Lieu ».
    const where = /^([^[\]]+?) · ([^[\]]+)$/.exec(paras[i + 1]);
    if (!head || !job || !where) continue;
    offers.push({
      platform: "linkedin",
      title: head[1],
      company: where[1],
      location: where[2],
      contract: null,
      url: `https://www.linkedin.com/jobs/view/${job[1]}/`,
    });
    i++;
  }
  return offers;
}

// --- Filtre 1 : mots-clés de l'intitulé -------------------------------------------------------

export interface TitleRules {
  /** Postes recherchés : l'intitulé doit en contenir un (variante « garder + exclure »). */
  keep: string[];
  /** Mots rédhibitoires, cherchés dans l'intitulé et le type de contrat. */
  exclude: string[];
}

export interface TitleDecision {
  keep: boolean;
  rule: "exclu" | "poste-recherche" | "aucun-poste" | "sans-exclusion";
  match?: string;
}

/** Minuscules, sans accents : « Développeur » et « Developpeur » se valent dans un intitulé. */
const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/** Clé de doublon : même intitulé et même entreprise, sans casse, accents ni espaces superflus. */
export const offerKey = (o: Pick<Offer, "title" | "company">) =>
  `${fold(o.title).replace(/\s+/g, " ").trim()}|${fold(o.company ?? "").replace(/\s+/g, " ").trim()}`;

/**
 * Mots ou expressions en mots entiers ; un « * » en fin de mot accepte toutes les terminaisons
 * (« coordinat* de projet* » : coordinateur, coordinatrice de projet, projets…).
 */
function wordsRegex(words: string[]): RegExp {
  // Liste vide : rien ne correspond (sans ça, l'expression vide correspondrait à tout).
  if (words.length === 0) return /(?!)/;
  const parts = words.map((w) =>
    fold(w)
      .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, "\\p{L}*")
      .replace(/ /g, "\\s+"),
  );
  return new RegExp(`(?<![\\p{L}\\p{N}])(${parts.join("|")})(?![\\p{L}\\p{N}])`, "u");
}

/**
 * Deux variantes, comparées par la simulation :
 *   - "exclusion" : tout ce qui ne contient pas de mot exclu passe ;
 *   - "garder-exclure" : il faut en plus un poste recherché dans l'intitulé.
 */
export function titleFilter(rules: TitleRules, mode: "exclusion" | "garder-exclure") {
  const exclude = wordsRegex(rules.exclude);
  const keep = wordsRegex(rules.keep);
  return (offer: Pick<Offer, "title" | "contract">): TitleDecision => {
    const excluded = exclude.exec(fold(`${offer.title}\n${offer.contract ?? ""}`));
    if (excluded) return { keep: false, rule: "exclu", match: excluded[1] };
    if (mode === "exclusion") return { keep: true, rule: "sans-exclusion" };
    const found = keep.exec(fold(offer.title));
    return found ? { keep: true, rule: "poste-recherche", match: found[1] } : { keep: false, rule: "aucun-poste" };
  };
}
