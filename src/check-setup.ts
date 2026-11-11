// Vérification de l'installation, pour la synchronisation des mails (#40) : npm run verifier
//
// Gratuite et sans effet : jamais de navigateur, aucun appel payant (le profil Gmail et la fiche
// d'un modèle chez Anthropic sont gratuits), base ouverte en lecture seule. Chaque point est marqué
//   ✓ en place   · pour information   ! à surveiller   ✗ à corriger (code de sortie 1)
// avec, si besoin, la commande qui y remédie.
//
//   npm run verifier                     vérification complète
//   npm run verifier -- --notification   envoie aussi une notification de test

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import Anthropic from "@anthropic-ai/sdk";
import { gmail } from "@googleapis/gmail";
import type { Credentials } from "google-auth-library";
import {
  AuthorizationRequiredError,
  CREDENTIALS_PATH,
  getAuthorizedClient,
  readClientCredentials,
  SCOPES,
  TOKEN_PATH,
} from "./auth.js";
import { buildPlist, HOUR, isLoaded, PLIST_PATH, PROJECT_DIR, stableNodeDir } from "./auto-install.js";
import { API_KEY_PATH, createClient, MODEL } from "./classify.js";
import { type Config, CONFIG_PATH, loadConfig, startDate } from "./config.js";
import { DEFAULT_DB_PATH, getSetting, getSyncState, loadTitleRules, PROFILE_KEY, SCHEMA_VERSION } from "./db.js";
import { notify } from "./notify.js";
import type { TitleRules } from "./offers.js";
import { isOffline, withRetry } from "./retry.js";

type Level = "ok" | "info" | "attention" | "probleme";

export interface Check {
  level: Level;
  text: string;
  /** Commande ou geste qui règle le point. */
  fix?: string;
}

const check = (level: Level) => (text: string, fix?: string): Check => ({ level, text, ...(fix ? { fix } : {}) });
const ok = check("ok");
const info = check("info");
const attention = check("attention");
const probleme = check("probleme");

const SYMBOLS: Record<Level, string> = { ok: "✓", info: "·", attention: "!", probleme: "✗" };

const PARIS = "Europe/Paris";
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Jour AAAA-MM-JJ à Paris, comme dans le nom des journaux. */
const dayKey = (d: Date) => new Intl.DateTimeFormat("sv-SE", { timeZone: PARIS }).format(d);
/** « 2026-11-11 » → « 11/11 ». */
const shortDay = (key: string) => `${key.slice(8, 10)}/${key.slice(5, 7)}`;
/** « 2026-11-11 » → « 11/11/2026 ». */
const longDay = (key: string) => key.split("-").reverse().join("/");
const dateTime = (d: Date) => d.toLocaleString("fr-FR", { timeZone: PARIS, dateStyle: "short", timeStyle: "short" });
const hourOf = (d: Date) =>
  Number(
    new Intl.DateTimeFormat("fr-FR", { timeZone: PARIS, hour: "numeric", hourCycle: "h23" })
      .formatToParts(d)
      .find((p) => p.type === "hour")?.value,
  );
const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

// --- Autorisation Gmail -----------------------------------------------------------------------

/** Durée de vie d'un access token Google (expires_in = 3599 s). */
const ACCESS_TOKEN_LIFETIME_MS = HOUR_MS;

/**
 * Fin de validité de l'autorisation Gmail, ou null si elle n'expire pas (application En production).
 * En mode Test, chaque réponse de Google donne le temps restant au refresh token
 * (refresh_token_expires_in, en secondes) ; l'access token reçu en même temps est daté par la
 * bibliothèque (expiry_date = réponse + 1 h), d'où l'heure de la réponse.
 */
export function authorizationExpiry(tokens: Credentials & { refresh_token_expires_in?: number }): Date | null {
  if (!tokens.refresh_token_expires_in || !tokens.expiry_date) return null;
  return new Date(tokens.expiry_date - ACCESS_TOKEN_LIFETIME_MS + tokens.refresh_token_expires_in * 1000);
}

/** Alerte à moins de 2 jours : réautoriser avant l'expiration repart pour 7 jours. */
export function expiryCheck(expiry: Date | null, now = new Date()): Check {
  if (!expiry) return ok("Autorisation Gmail sans date d'expiration (application En production)");
  const text = `Autorisation Gmail valable jusqu'au ${shortDay(dayKey(expiry))} vers ${hourOf(expiry)} h (mode Test : 7 jours)`;
  return expiry.getTime() - now.getTime() < 2 * DAY_MS
    ? attention(text, `pour la renouveler dès maintenant : rm ${TOKEN_PATH} puis npm run list`)
    : ok(text);
}

/** Fichiers de secrets/ lisibles par d'autres comptes du Mac (droits attendus : 600). */
export function permissionsCheck(files: { path: string; mode: number }[]): Check {
  const open = files.filter((f) => (f.mode & 0o077) !== 0).map((f) => f.path);
  return open.length === 0
    ? ok("Fichiers de secrets/ lisibles par toi seul (droits 600)")
    : attention(`Fichiers lisibles par d'autres comptes du Mac : ${open.join(", ")}`, `chmod 600 ${open.join(" ")}`);
}

// --- Base ---------------------------------------------------------------------------------------

/** Dernière synchronisation complète ; sans synchronisation, le premier passage à faire. */
export function lastSyncCheck(lastSyncAt: string | null, start: Date | null, now = new Date()): Check {
  if (!lastSyncAt) {
    // Simulations gratuites d'abord, sur toute la période du premier passage.
    const days = start ? Math.ceil((now.getTime() - start.getTime()) / DAY_MS) : 14;
    const since = start ? ` depuis le ${longDay(dayKey(start))}` : "";
    return attention(
      "Aucune synchronisation pour l'instant",
      `npm run filter -- --days ${days} et npm run offres:simuler -- --days ${days} pour voir ce qui partirait ` +
        `chez Claude, puis npm run sync (payant) : premier passage${since}`,
    );
  }
  const last = new Date(lastSyncAt);
  const text = `Dernière synchronisation complète : ${dateTime(last)}`;
  const hours = (now.getTime() - last.getTime()) / HOUR_MS;
  return hours > 36 ? attention(`${text}, il y a ${Math.round(hours / 24)} jour(s)`) : ok(text);
}

/**
 * Mots-clés du filtre sur l'intitulé. Une base neuve contient ceux d'origine de l'outil : si aucun
 * poste de la configuration n'y figure, config:initialiser n'a pas été lancé.
 */
export function termsCheck(rules: TitleRules, wanted: Config["motsClesDeDepart"]): Check {
  const counts = `${rules.keep.length} poste(s) recherché(s), ${rules.exclude.length} mot(s) exclu(s)`;
  if (wanted.postes.length > 0 && !wanted.postes.some((t) => rules.keep.includes(t))) {
    return probleme(
      `Mots-clés : ${counts}, dont aucun poste de la configuration`,
      "npm run config:initialiser -- --remplacer",
    );
  }
  const same = (a: string[], b: string[]) => [...a].sort().join("\n") === [...b].sort().join("\n");
  const conform = same(rules.keep, wanted.postes) && same(rules.exclude, wanted.exclus);
  return ok(`Mots-clés : ${counts}, ${conform ? "conformes à la configuration" : "différents de la configuration de départ"}`);
}

// --- Synchronisation automatique ----------------------------------------------------------------

const LOG_NAME = /^sync-(\d{4}-\d{2}-\d{2})\.log$/;
/** Ligne de journal : « 09/11/2026 08:00:17 · message ». */
const STAMPED = /^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2} · (.*)$/;

/** « Autorisation Gmail expirée ou révoquée. Lancer… » → « autorisation Gmail expirée ou révoquée ». */
function causeOf(message: string): string {
  const cause = message.split(/\.\s|\s:(?:\s|$)/)[0].replace(/\.$/, "");
  return cause.charAt(0).toLowerCase() + cause.slice(1);
}

/**
 * Bilan des journaux (nom du fichier → contenu) sur les `days` derniers jours, à partir de la
 * première synchronisation automatique. Aujourd'hui ne compte que si elle a déjà été lancée.
 */
export function logsCheck(logs: Map<string, string>, now = new Date(), days = 7): Check {
  const keys = [...logs.keys()].flatMap((name) => name.match(LOG_NAME)?.[1] ?? []).sort();
  if (keys.length === 0) return info(`Aucun journal pour l'instant : première synchronisation automatique à ${HOUR} h`);

  const [y, m, d] = dayKey(now).split("-").map(Number);
  const missed: { day: string; cause: string }[] = [];
  let counted = 0;
  for (let i = days - 1; i >= 0; i--) {
    // Calcul en UTC à partir de la date : pas de jour sauté ni doublé au changement d'heure.
    const key = new Date(Date.UTC(y, m - 1, d - i)).toISOString().slice(0, 10);
    if (key < keys[0]) continue;
    const lines = (logs.get(`sync-${key}.log`) ?? "").split("\n").flatMap((l) => l.match(STAMPED)?.[1] ?? []);
    if (i === 0 && lines.length === 0) continue;
    counted++;
    if (lines.some((l) => l.startsWith("synchronisation "))) continue;
    missed.push({ day: key, cause: lines.length ? causeOf(lines.at(-1)!) : "aucun lancement : Mac éteint ou en veille ?" });
  }

  if (counted === 0) return info("Aucune synchronisation automatique lancée pour l'instant");
  const period = counted === 1 ? "le dernier jour" : `les ${counted} derniers jours`;
  if (missed.length === 0) return ok(`Synchronisée chaque jour sur ${period}`);
  const byCause = new Map<string, string[]>();
  for (const { day, cause } of missed) byCause.set(cause, [...(byCause.get(cause) ?? []), shortDay(day)]);
  const detail = [...byCause].map(([cause, list]) => `${list.join(", ")} (${cause})`).join(" ; ");
  return attention(`Synchronisée ${counted - missed.length} jour(s) sur ${counted} ; manqués : ${detail}`);
}

// --- Vérifications (accès aux fichiers, à Gmail, à Anthropic) ---------------------------------

function configCheck(): { config: Config | null; result: Check } {
  try {
    const config = loadConfig();
    const families = config.familles.map((f) => `« ${f.nom} »`).join(" et ");
    return { config, result: ok(`${CONFIG_PATH} : début le ${longDay(config.debutRecherche)}, familles ${families}`) };
  } catch (err) {
    return { config: null, result: probleme(messageOf(err)) };
  }
}

function secretsChecks(): Check[] {
  const files = [CREDENTIALS_PATH, TOKEN_PATH, API_KEY_PATH]
    .filter((path) => existsSync(path))
    .map((path) => ({ path, mode: statSync(path).mode }));
  return files.length ? [permissionsCheck(files)] : [];
}

async function gmailChecks(): Promise<Check[]> {
  try {
    await readClientCredentials();
  } catch (err) {
    return [probleme(messageOf(err))];
  }
  const checks = [ok(`${CREDENTIALS_PATH} : client « Application de bureau »`)];
  try {
    // Jamais de navigateur ici : sans autorisation valable, on le signale seulement.
    const auth = await getAuthorizedClient({ interactive: false });
    // Adresse du compte autorisé : c'est lui dont les mails seront lus.
    const { data } = await withRetry(() => gmail({ version: "v1", auth }).users.getProfile({ userId: "me" }));
    const account = `Compte Gmail autorisé : ${data.emailAddress ?? "adresse inconnue"}`;
    const scopes = auth.credentials.scope?.split(" ") ?? [];
    checks.push(
      scopes.join(" ") === SCOPES.join(" ")
        ? ok(`${account}, en lecture seule`)
        : probleme(`${account}, avec des permissions inattendues (${scopes.join(", ")})`, `rm ${TOKEN_PATH} puis npm run list`),
    );
    checks.push(expiryCheck(authorizationExpiry(auth.credentials)));
  } catch (err) {
    if (err instanceof AuthorizationRequiredError) {
      checks.push(probleme(err.message, "npm run list (ouvre le navigateur pour autoriser la lecture de Gmail)"));
    } else if (isOffline(err)) {
      checks.push(attention("Google injoignable (pas de réseau ?) : autorisation non vérifiée"));
    } else {
      checks.push(probleme(`Accès à Gmail impossible : ${messageOf(err)}`));
    }
  }
  return checks;
}

async function claudeCheck(): Promise<Check> {
  let client: Anthropic;
  try {
    client = createClient();
  } catch (err) {
    return probleme(messageOf(err), "README, étape « Clé d'API Anthropic »");
  }
  try {
    // Fiche du modèle : gratuite, mais refusée si la clé n'est pas valable.
    await client.models.retrieve(MODEL);
    return ok(`Clé d'API acceptée, modèle ${MODEL} accessible (crédit restant : console.anthropic.com)`);
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) {
      return probleme("Clé d'API refusée par Anthropic", `remplacer la clé dans ${API_KEY_PATH}`);
    }
    if (err instanceof Anthropic.PermissionDeniedError || err instanceof Anthropic.NotFoundError) {
      return probleme(`Modèle ${MODEL} inaccessible avec cette clé`);
    }
    if (err instanceof Anthropic.APIConnectionError) {
      return attention("Anthropic injoignable (pas de réseau ?) : clé non vérifiée");
    }
    return probleme(`Vérification de la clé impossible : ${messageOf(err)}`);
  }
}

function baseChecks(config: Config | null, now: Date): Check[] {
  if (!existsSync(DEFAULT_DB_PATH)) {
    return [
      attention(
        `Pas encore de base (${DEFAULT_DB_PATH})`,
        "npm run config:initialiser -- --remplacer : la crée avec les mots-clés de la configuration",
      ),
    ];
  }
  // Lecture seule : la vérification ne crée rien et n'applique aucune migration.
  const db = new DatabaseSync(DEFAULT_DB_PATH, { readOnly: true, timeout: 5000 });
  try {
    const { user_version: version } = db.prepare("PRAGMA user_version").get() as { user_version: number };
    if (version < SCHEMA_VERSION) {
      return [info(`Base en version ${version} sur ${SCHEMA_VERSION} : mise à jour au prochain lancement (copie de sécurité avant)`)];
    }
    const profile = getSetting(db, PROFILE_KEY)?.trim();
    return [
      lastSyncCheck(getSyncState(db)?.lastSyncAt ?? null, config ? startDate(config) : null, now),
      profile
        ? ok(`Profil du candidat saisi (${profile.length} caractères)`)
        : attention(
            "Profil du candidat absent : les annonces ne seront pas triées par Claude",
            "le saisir dans l'interface (npm run ui), page Réglages des offres",
          ),
      ...(config ? [termsCheck(loadTitleRules(db), config.motsClesDeDepart)] : []),
    ];
  } finally {
    db.close();
  }
}

function readLogs(): Map<string, string> {
  const dir = join(PROJECT_DIR, "data", "logs");
  const logs = new Map<string, string>();
  if (!existsSync(dir)) return logs;
  for (const name of readdirSync(dir).filter((f) => LOG_NAME.test(f))) logs.set(name, readFileSync(join(dir, name), "utf8"));
  return logs;
}

async function autoChecks(now: Date): Promise<Check[]> {
  const checks: Check[] = [];
  if (!existsSync(PLIST_PATH)) {
    checks.push(attention("Synchronisation automatique non installée", "npm run auto:installer, après la première synchronisation"));
  } else if (!isLoaded()) {
    checks.push(probleme("Synchronisation automatique installée mais inactive", "npm run auto:installer"));
  } else if (readFileSync(PLIST_PATH, "utf8") !== buildPlist(PROJECT_DIR, stableNodeDir(process.execPath), HOUR)) {
    // Dossier du projet déplacé, autre Node.js, ou fichier launchd d'une version précédente de l'outil.
    checks.push(attention("Synchronisation automatique active, mais son fichier launchd est à réinstaller", "npm run auto:installer"));
  } else {
    checks.push(ok(`Synchronisation automatique active : à ${HOUR} h ou au réveil, nouvel essai toutes les heures sans réseau`));
  }
  if (existsSync(PLIST_PATH)) checks.push(logsCheck(readLogs(), now));

  // Un problème n'est signalé que par une notification : macOS doit l'autoriser (osascript
  // apparaît sous « Éditeur de script »), ce qu'aucun programme ne peut lire.
  if (process.argv.includes("--notification")) {
    await notify("Suivi de candidatures", "Notification de test : les problèmes de synchronisation s'afficheront ainsi.");
    checks.push(
      info("Notification de test envoyée : si elle n'apparaît pas, autoriser « Éditeur de script » dans Réglages Système → Notifications"),
    );
  } else {
    checks.push(info("Notifications (seul signal d'un problème) non testées", "npm run verifier -- --notification"));
  }
  return checks;
}

// --- Affichage ----------------------------------------------------------------------------------

function print(title: string, checks: Check[]): void {
  console.log(`\n${title}`);
  for (const c of checks) {
    const [first, ...rest] = c.text.split("\n");
    console.log(`  ${SYMBOLS[c.level]} ${first}`);
    for (const line of rest) console.log(`    ${line}`);
    if (c.fix) console.log(`      → ${c.fix}`);
  }
}

async function main(): Promise<number> {
  const now = new Date();
  console.log("Vérification de l'installation : synchronisation des mails (gratuit, rien n'est modifié)");
  const all: Check[] = [];
  const section = (title: string, checks: Check[]) => {
    print(title, checks);
    all.push(...checks);
  };

  const { config, result } = configCheck();
  section("Fichiers", [result, ...secretsChecks()]);
  section("Gmail", await gmailChecks());
  section("Claude", [await claudeCheck()]);
  section("Base", baseChecks(config, now));
  section("Synchronisation automatique", await autoChecks(now));

  const problems = all.filter((c) => c.level === "probleme").length;
  const warnings = all.filter((c) => c.level === "attention").length;
  console.log(
    problems + warnings === 0
      ? "\nBilan : tout est en place."
      : `\nBilan : ${problems} point(s) à corriger (✗), ${warnings} à surveiller (!).`,
  );
  return problems > 0 ? 1 : 0;
}

// Lancé directement (et non importé par les tests).
if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  process.exitCode = await main();
}
