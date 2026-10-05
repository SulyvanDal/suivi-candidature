// Application Hono : routes de l'interface. Séparée du démarrage pour être testable sans serveur.

import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { csrf } from "hono/csrf";
import { addCorrection, rebuildCandidatures } from "../candidatures.js";
import { DISPLAY_STATUSES, type DisplayStatus, getCandidature, listCandidatures, listToClassify } from "./queries.js";
import { detailPage, listPage, notFoundPage, toClassifyPage } from "./views.js";

// htmx est servi depuis node_modules : la page ne charge rien depuis Internet.
const HTMX = readFileSync("node_modules/htmx.org/dist/htmx.min.js", "utf8");
const CSS = readFileSync(new URL("./style.css", import.meta.url), "utf8");

export function createApp(db: DatabaseSync, now: () => Date = () => new Date()): Hono {
  const app = new Hono();

  // Écritures uniquement depuis l'interface elle-même : une autre page ouverte dans le navigateur
  // ne peut pas envoyer de formulaire à 127.0.0.1 à ta place.
  app.use(csrf());

  app.get("/", (c) => {
    const statut = c.req.query("statut");
    const filter = DISPLAY_STATUSES.includes(statut as DisplayStatus) ? (statut as DisplayStatus) : null;
    return c.html(listPage(listCandidatures(db, now()), filter, listToClassify(db).length));
  });

  app.get("/a-classer", (c) => c.html(toClassifyPage(listToClassify(db), listCandidatures(db, now()))));

  // Classement manuel d'un mail (#17) : la décision est enregistrée, puis tout est recalculé.
  app.post("/a-classer/:id/:action", async (c) => {
    const gmailId = c.req.param("id");
    const action = c.req.param("action");
    const known = db.prepare("SELECT 1 FROM mail_results WHERE gmail_id = ?").get(gmailId);
    if (!known) return c.text("Mail inconnu", 404);

    if (action === "creer" || action === "ignorer") {
      addCorrection(db, { kind: action, gmailId });
    } else if (action === "rattacher") {
      const candidatureId = String((await c.req.parseBody()).candidature ?? "");
      const exists = db.prepare("SELECT 1 FROM candidatures WHERE id = ?").get(candidatureId);
      if (!exists) return c.text("Candidature inconnue", 400);
      addCorrection(db, { kind: "rattacher", gmailId, candidatureId });
    } else {
      return c.text("Action inconnue", 404);
    }
    rebuildCandidatures(db);
    // On reste sur la page tant qu'il reste des mails à classer.
    return c.redirect(listToClassify(db).length > 0 ? "/a-classer" : "/", 303);
  });

  app.get("/candidatures/:id", (c) => {
    const found = getCandidature(db, c.req.param("id"), now());
    if (!found) return c.html(notFoundPage(), 404);
    return c.html(detailPage(found.candidature, found.mails));
  });

  app.get("/htmx.js", (c) => c.body(HTMX, 200, { "Content-Type": "text/javascript; charset=utf-8" }));
  app.get("/style.css", (c) => c.body(CSS, 200, { "Content-Type": "text/css; charset=utf-8" }));

  return app;
}
