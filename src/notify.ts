// Notification macOS (Centre de notifications), pour signaler un problème de la synchronisation
// automatique (#12). Jamais de contenu de mail dans une notification.

import { execFile } from "node:child_process";

/** Échappe une chaîne pour l'insérer entre guillemets dans un script AppleScript. */
export function appleScriptString(text: string): string {
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function notify(title: string, message: string): Promise<void> {
  const script = `display notification ${appleScriptString(message)} with title ${appleScriptString(title)}`;
  return new Promise((resolve) => {
    // Une notification qui échoue ne doit pas masquer l'erreur d'origine : on ignore l'échec.
    execFile("osascript", ["-e", script], () => resolve());
  });
}
