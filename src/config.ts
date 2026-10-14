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

/** Une question peut s'écrire sur plusieurs lignes dans le fichier : elles sont réunies. */
const question = z.union([text, z.array(text).min(1)]).transform((v) => (Array.isArray(v) ? v.join("\n") : v));
const key = z.string().regex(/^[a-z][a-z0-9_]*$/, "minuscules, chiffres et _ uniquement");
/** Faits relevés dans tous les cas, gérés par le code. */
export const RESERVED_FACTS = ["type_poste", "experience_min_ans", "profil_senior", "justification"];
const criterionKey = key.refine((k) => !RESERVED_FACTS.includes(k), "clé réservée aux faits de base");
/** Familles concernées ; absent = toutes. */
const families = z.array(key).min(1).optional();

/** Question oui / non posée à Claude : des points si oui, ou l'annonce est écartée. */
const YesNoSchema = z
  .object({
    cle: criterionKey,
    libelle: text,
    familles: families,
    question,
    points: z.number().optional(),
    effet: z.literal("ecarter").optional(),
  })
  .strict()
  .refine((c) => (c.points === undefined) !== (c.effet === undefined), "indiquer soit points, soit effet « ecarter »");

/** Question à choix posée à Claude : des points selon la réponse. */
const ChoiceSchema = z
  .object({
    cle: criterionKey,
    libelle: text.optional(),
    familles: families,
    question,
    choix: z
      .array(
        z
          .object({
            valeur: key,
            /** Si présente, la valeur est détaillée sous la question pour Claude. */
            description: text.optional(),
            /** Affiché dans le détail des points (par défaut : le libellé du critère). */
            libelle: text.optional(),
            points: z.number().default(0),
          })
          .strict(),
      )
      .min(2, "au moins 2 choix"),
  })
  .strict();

/** Critère déduit de l'expérience minimale demandée, sans question à Claude. */
const DerivedSchema = z
  .object({ cle: criterionKey, libelle: text, familles: families, experienceMaxAns: z.number().min(0), points: z.number() })
  .strict();

const CriterionSchema = z.union([ChoiceSchema, DerivedSchema, YesNoSchema]);

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
    /** Faits relevés par Claude en plus des faits de base, et leurs points (#37). */
    criteres: z.array(CriterionSchema),
    /** Priorité 1 à partir du seuil ; points selon le lieu affiché dans l'annonce. */
    priorite: z
      .object({
        seuil: z.number(),
        lieux: z.array(
          z
            .object({
              nom: text,
              /** Expression régulière, sans tenir compte des majuscules. */
              motif: text.refine((m) => {
                try {
                  new RegExp(m, "i");
                  return true;
                } catch {
                  return false;
                }
              }, "expression régulière invalide"),
              points: z.number(),
            })
            .strict(),
        ),
      })
      .strict(),
  })
  .strict()
  .superRefine((config, ctx) => {
    const familyKeys = config.familles.map((f) => f.cle);
    const seen = new Set<string>();
    config.criteres.forEach((c, i) => {
      if (seen.has(c.cle)) ctx.addIssue({ code: "custom", path: ["criteres", i, "cle"], message: `clé « ${c.cle} » en double` });
      seen.add(c.cle);
      for (const f of c.familles ?? []) {
        if (!familyKeys.includes(f)) {
          ctx.addIssue({ code: "custom", path: ["criteres", i, "familles"], message: `famille « ${f} » inconnue` });
        }
      }
    });
  });

export type Config = z.infer<typeof ConfigSchema>;
export type Family = z.infer<typeof FamilySchema>;
export type Criterion = z.infer<typeof CriterionSchema>;
export type ChoiceCriterion = z.infer<typeof ChoiceSchema>;
export type DerivedCriterion = z.infer<typeof DerivedSchema>;
export type YesNoCriterion = z.infer<typeof YesNoSchema>;

export const isChoice = (c: Criterion): c is ChoiceCriterion => "choix" in c;
export const isDerived = (c: Criterion): c is DerivedCriterion => "experienceMaxAns" in c;
export const isYesNo = (c: Criterion): c is YesNoCriterion => !isChoice(c) && !isDerived(c);

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
