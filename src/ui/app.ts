// Application Hono : routes de l'interface. Séparée du démarrage pour être testable sans serveur.

import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { DISPLAY_STATUSES, type DisplayStatus, getCandidature, listCandidatures } from "./queries.js";
import { detailPage, listPage, notFoundPage } from "./views.js";

// htmx est servi depuis node_modules : la page ne charge rien depuis Internet.
const HTMX = readFileSync("node_modules/htmx.org/dist/htmx.min.js", "utf8");
const CSS = readFileSync(new URL("./style.css", import.meta.url), "utf8");

export function createApp(db: DatabaseSync, now: () => Date = () => new Date()): Hono {
  const app = new Hono();

  app.get("/", (c) => {
    const statut = c.req.query("statut");
    const filter = DISPLAY_STATUSES.includes(statut as DisplayStatus) ? (statut as DisplayStatus) : null;
    return c.html(listPage(listCandidatures(db, now()), filter));
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
