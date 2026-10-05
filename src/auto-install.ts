// Installation de la synchronisation automatique quotidienne (#12) via launchd, le planificateur
// de macOS :
//   npm run auto:installer      ajoute l'agent (~/Library/LaunchAgents) et l'active
//   npm run auto:desinstaller   le désactive et le supprime
//   npm run auto:statut         indique s'il est actif et affiche le dernier journal
//
// Si le Mac dort à l'heure prévue, macOS lance la tâche au réveil ; s'il est éteint, la journée est
// sautée et la synchronisation suivante rattrape tout (elle est incrémentale).

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const LABEL = "com.suivi-candidature.sync";
/** Heure de lancement (décision utilisateur : 8 h). */
export const HOUR = 8;

const PROJECT_DIR = resolve(dirname(new URL(import.meta.url).pathname), "..");
const PLIST_PATH = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Contenu du fichier launchd. launchd n'a presque pas de PATH : on y ajoute le dossier de node. */
export function buildPlist(projectDir: string, nodeDir: string, hour: number): string {
  const script = join(projectDir, "scripts", "sync-auto.sh");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>${xml(script)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(projectDir)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xml(nodeDir)}:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>${hour}</integer>
    <key>Minute</key>
    <integer>0</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>${xml(join(projectDir, "data", "logs", "launchd.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${xml(join(projectDir, "data", "logs", "launchd.log"))}</string>
</dict>
</plist>
`;
}

const domain = () => `gui/${process.getuid?.() ?? execFileSync("id", ["-u"]).toString().trim()}`;

function isLoaded(): boolean {
  try {
    execFileSync("launchctl", ["print", `${domain()}/${LABEL}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function install(): void {
  mkdirSync(dirname(PLIST_PATH), { recursive: true });
  mkdirSync(join(PROJECT_DIR, "data", "logs"), { recursive: true });
  if (isLoaded()) execFileSync("launchctl", ["bootout", `${domain()}/${LABEL}`]);
  writeFileSync(PLIST_PATH, buildPlist(PROJECT_DIR, dirname(process.execPath), HOUR));
  execFileSync("launchctl", ["bootstrap", domain(), PLIST_PATH]);
  console.log(`Synchronisation automatique installée : tous les jours à ${HOUR} h.`);
  console.log(`Fichier : ${PLIST_PATH}`);
  console.log("Journaux : data/logs/ · Retrait : npm run auto:desinstaller");
}

function uninstall(): void {
  if (isLoaded()) execFileSync("launchctl", ["bootout", `${domain()}/${LABEL}`]);
  rmSync(PLIST_PATH, { force: true });
  console.log("Synchronisation automatique désinstallée.");
}

function status(): void {
  const installed = existsSync(PLIST_PATH);
  console.log(`Installée : ${installed ? "oui" : "non"} · Active : ${isLoaded() ? "oui" : "non"} · Heure : ${HOUR} h`);
  const logsDir = join(PROJECT_DIR, "data", "logs");
  const logs = existsSync(logsDir) ? readdirSync(logsDir).filter((f) => f.startsWith("sync-")).sort() : [];
  if (logs.length === 0) return console.log("Aucune synchronisation automatique pour l'instant.");
  const last = logs.at(-1)!;
  console.log(`Dernier journal (${last}) :`);
  console.log(readFileSync(join(logsDir, last), "utf8").trim().split("\n").slice(-5).join("\n"));
}

// Lancé directement (et non importé par les tests).
if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  const command = process.argv[2];
  if (command === "installer") install();
  else if (command === "desinstaller") uninstall();
  else if (command === "statut") status();
  else console.log("Usage : npm run auto:installer | auto:desinstaller | auto:statut");
}
