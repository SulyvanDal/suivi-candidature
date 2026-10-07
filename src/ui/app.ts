// Application Hono : routes de l'interface. Séparée du démarrage pour être testable sans serveur.

import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { type Context, Hono } from "hono";
import { csrf } from "hono/csrf";
import {
  addCorrection,
  cancelCorrection,
  EDITABLE_FIELDS,
  rebuildCandidatures,
  type Status,
} from "../candidatures.js";
import {
  addOfferTerm,
  getSetting,
  getSyncState,
  ignoreOffer,
  loadTitleRules,
  markOfferSeen,
  PROFILE_KEY,
  removeOfferTerm,
  setSetting,
  type TermKind,
  toggleOfferPriority,
} from "../db.js";
import { CEILING_KEYS, loadCeilings, recomputeVerdicts } from "../offer-judge.js";
import {
  DISPLAY_STATUSES,
  type DisplayStatus,
  countOffers,
  getCandidature,
  listCandidatures,
  listCorrections,
  listOffersToSee,
  listToClassify,
  offerStats,
} from "./queries.js";
import {
  correctionsPage,
  detailPage,
  listPage,
  notFoundPage,
  offerSettingsPage,
  offersPage,
  toClassifyPage,
} from "./views.js";

const STATUSES: Status[] = ["Envoyée", "Entretien", "Offre", "Refus"];

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
    const lastSync = getSyncState(db)?.lastSyncAt;
    return c.html(
      listPage(
        listCandidatures(db, now()),
        filter,
        listToClassify(db).length,
        lastSync ? new Date(lastSync) : null,
        countOffers(db),
      ),
    );
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

  // Édition (#18) : seules les informations réellement changées deviennent des corrections.
  app.get("/candidatures/:id/modifier", (c) => {
    const found = getCandidature(db, c.req.param("id"), now());
    if (!found) return c.html(notFoundPage(), 404);
    return c.html(detailPage(found.candidature, found.mails, true));
  });

  app.post("/candidatures/:id/modifier", async (c) => {
    const id = c.req.param("id");
    const found = getCandidature(db, id, now());
    if (!found) return c.html(notFoundPage(), 404);
    const body = await c.req.parseBody();
    const current = found.candidature;

    for (const field of EDITABLE_FIELDS) {
      if (typeof body[field] !== "string") continue;
      const value = (body[field] as string).trim() || null;
      if (value !== current[field]) addCorrection(db, { kind: "champ", candidatureId: id, field, value });
    }
    const status = body.status as Status;
    if (STATUSES.includes(status) && status !== current.rawStatus) {
      addCorrection(db, { kind: "statut", candidatureId: id, value: status, at: now() });
    }
    rebuildCandidatures(db);
    return c.redirect(`/candidatures/${id}`, 303);
  });

  app.post("/candidatures/:id/pas-candidature", (c) => {
    const id = c.req.param("id");
    const found = getCandidature(db, id, now());
    if (!found) return c.html(notFoundPage(), 404);
    const { company, jobTitle } = found.candidature;
    const label = [company ?? "Entreprise inconnue", jobTitle].filter(Boolean).join(" · ");
    addCorrection(db, { kind: "pas_candidature", candidatureId: id }, label);
    rebuildCandidatures(db);
    return c.redirect("/", 303);
  });

  // Offres à regarder (#24).
  app.get("/offres", (c) => c.html(offersPage(listOffersToSee(db), offerStats(db, now()))));

  app.post("/offres/:id/consulter", (c) => {
    const url = markOfferSeen(db, Number(c.req.param("id")), now());
    if (!url) return c.text("Annonce inconnue", 404);
    // L'adresse vient d'un mail : on ne redirige que vers une page web.
    if (!/^https?:\/\//i.test(url)) return c.text("Adresse d'annonce invalide", 400);
    return c.redirect(url, 303);
  });

  app.post("/offres/:id/prioritaire", (c) => {
    if (!toggleOfferPriority(db, Number(c.req.param("id")), now())) return c.text("Annonce inconnue", 404);
    return c.redirect("/offres", 303);
  });

  app.post("/offres/:id/ignorer", (c) => {
    if (!ignoreOffer(db, Number(c.req.param("id")), now())) return c.text("Annonce inconnue", 404);
    return c.redirect("/offres", 303);
  });

  // Réglages des offres (#25). Les messages passent par l'adresse (codes fixes, jamais de texte libre).
  const MESSAGES: Record<string, string> = {
    terme: "Terme refusé : il doit faire entre 1 et 60 caractères.",
    profil: "Le profil ne peut pas être vide : sans lui, les annonces ne seraient plus triées.",
    plafond: "Plafond refusé : un nombre d'années entre 0 et 30 est attendu.",
    plafonds: "Plafonds enregistrés.",
    "profil-ok": "Profil enregistré.",
  };
  app.get("/offres/reglages", (c) => {
    const rules = loadTitleRules(db);
    return c.html(
      offerSettingsPage({
        keep: rules.keep,
        exclude: rules.exclude,
        profile: getSetting(db, PROFILE_KEY) ?? "",
        ceilings: loadCeilings(db),
        message: MESSAGES[c.req.query("message") ?? ""] ?? null,
      }),
    );
  });

  const termForm = async (c: Context) => {
    const body = await c.req.parseBody();
    const kind: TermKind | null = body.kind === "poste" || body.kind === "exclu" ? body.kind : null;
    const term = typeof body.term === "string" ? body.term.trim().replace(/\s+/g, " ") : "";
    return { kind, term };
  };
  app.post("/offres/reglages/termes/ajouter", async (c) => {
    const { kind, term } = await termForm(c);
    if (!kind) return c.text("Liste inconnue", 400);
    if (!term || term.length > 60) return c.redirect("/offres/reglages?message=terme", 303);
    addOfferTerm(db, kind, term);
    return c.redirect("/offres/reglages", 303);
  });
  app.post("/offres/reglages/termes/retirer", async (c) => {
    const { kind, term } = await termForm(c);
    if (!kind) return c.text("Liste inconnue", 400);
    removeOfferTerm(db, kind, term);
    return c.redirect("/offres/reglages", 303);
  });

  app.post("/offres/reglages/profil", async (c) => {
    const profile = String((await c.req.parseBody()).profil ?? "").trim();
    if (!profile) return c.redirect("/offres/reglages?message=profil", 303);
    setSetting(db, PROFILE_KEY, profile);
    return c.redirect("/offres/reglages?message=profil-ok", 303);
  });

  app.post("/offres/reglages/plafonds", async (c) => {
    const body = await c.req.parseBody();
    const values = [body.produit_projet, body.developpeur].map((v) => Number(String(v ?? "").replace(",", ".")));
    if ([body.produit_projet, body.developpeur].some((v) => String(v ?? "").trim() === "") ||
        values.some((v) => !Number.isFinite(v) || v < 0 || v > 30)) {
      return c.redirect("/offres/reglages?message=plafond", 303);
    }
    setSetting(db, CEILING_KEYS.produitProjet, String(values[0]));
    setSetting(db, CEILING_KEYS.developpeur, String(values[1]));
    // Les faits relevés par Claude sont gardés : les décisions se recalculent sans le rappeler.
    recomputeVerdicts(db);
    return c.redirect("/offres/reglages?message=plafonds", 303);
  });

  app.get("/corrections", (c) => c.html(correctionsPage(listCorrections(db))));

  app.post("/corrections/:id/annuler", (c) => {
    if (!cancelCorrection(db, Number(c.req.param("id")))) return c.text("Correction inconnue", 404);
    rebuildCandidatures(db);
    return c.redirect("/corrections", 303);
  });

  app.get("/htmx.js", (c) => c.body(HTMX, 200, { "Content-Type": "text/javascript; charset=utf-8" }));
  app.get("/style.css", (c) => c.body(CSS, 200, { "Content-Type": "text/css; charset=utf-8" }));

  return app;
}
