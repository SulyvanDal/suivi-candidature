// Configuration de la recherche (#36) : ce qui décrit la recherche d'une personne, hors du code.
//
// Un fichier par installation, config/recherche.json, exclu de git (le dépôt est public) ;
// config/exemple.json, versionné, sert de modèle. Le fichier est vérifié au démarrage : une erreur
// donne un message clair plutôt qu'un plantage plus loin.
//
// Le profil du candidat, les mots-clés et les plafonds se règlent ensuite dans l'interface (base) :
// le fichier ne donne que les valeurs de départ (npm run config:initialiser).

import { readFileSync } from "node:fs";
import { z } from "zod";

export const CONFIG_PATH = "config/recherche.json";

const text = z.string().trim().min(1, "texte vide");
const texts = z.array(text);

const FamilySchema = z.object({
  /** Identifiant enregistré en base (job_type, plafond_<cle>) : ne plus le changer ensuite. */
  cle: z
    .string()
    .regex(/^[a-z][a-z0-9_]*$/, "minuscules, chiffres et _ uniquement")
    .refine((c) => c !== "autre", "« autre » est réservé aux postes hors cible"),
  nom: text,
  /** Ce que recouvre la famille, pour Claude (intitulés, métiers…). */
  definition: text,
  /** Expérience maximale demandée, valeur de départ (modifiable dans les réglages). */
  plafondAns: z.number().min(0).max(30),
});

const ConfigSchema = z
  .object({
    /** Début de la recherche : premier passage de la synchronisation (AAAA-MM-JJ). */
    debutRecherche: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "format AAAA-MM-JJ attendu"),
    /** Deux familles de postes (N familles : #35). */
    familles: z
      .array(FamilySchema)
      .length(2, "exactement 2 familles")
      .refine((f) => new Set(f.map((x) => x?.cle)).size === f.length, "les deux familles doivent avoir des clés différentes"),
    /** Exemples de postes hors cible malgré un intitulé proche, pour Claude. */
    horsCible: text,
    /** Règles de classement des mails propres à la personne. */
    mails: z.object({
      /** Démarches autres qu'une candidature (« demande d'immersion »). */
      demarches: texts,
      /** Phrases ajoutées à la définition de « autre ». */
      autre: texts,
      /** Cas ajoutés à la liste « hors sujet ». */
      horsSujet: texts,
    }),
    /** Mots-clés écrits en base par npm run config:initialiser (ensuite : interface). */
    motsClesDeDepart: z.object({ postes: texts, exclus: texts }),
  })
  .strict();

export type Config = z.infer<typeof ConfigSchema>;
export type Family = z.infer<typeof FamilySchema>;

export class ConfigError extends Error {}

/** Vérifie une configuration ; lève ConfigError avec un message lisible (« familles.1.plafondAns : … »). */
export function parseConfig(raw: unknown, source = "configuration"): Config {
  const result = ConfigSchema.safeParse(raw);
  if (result.success) return result.data;
  const problems = result.error.issues.map((i) => `  - ${i.path.join(".") || "(racine)"} : ${i.message}`);
  throw new ConfigError(`${source} invalide :\n${problems.join("\n")}`);
}

export function loadConfig(path = CONFIG_PATH): Config {
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    throw new ConfigError(`Configuration introuvable : copier config/exemple.json vers ${path} et l'adapter.`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (err) {
    throw new ConfigError(`${path} n'est pas un JSON valide : ${err instanceof Error ? err.message : String(err)}`);
  }
  return parseConfig(raw, path);
}

let cached: Config | undefined;

/** Configuration de cette installation, lue une fois. */
export function getConfig(): Config {
  cached ??= loadConfig();
  return cached;
}

/** Début de la recherche à minuit, heure de Paris. */
export function startDate(config: Config): Date {
  const d = new Date(`${config.debutRecherche}T00:00:00+02:00`);
  // Hors heure d'été, Paris est à +01:00.
  const offset = new Intl.DateTimeFormat("en", { timeZone: "Europe/Paris", timeZoneName: "shortOffset" })
    .formatToParts(d)
    .find((p) => p.type === "timeZoneName")?.value;
  return offset === "GMT+1" ? new Date(`${config.debutRecherche}T00:00:00+01:00`) : d;
}
