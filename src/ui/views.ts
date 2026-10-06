// Pages HTML. Le gabarit `html` de Hono échappe automatiquement les valeurs insérées :
// un objet de mail contenant du HTML s'affiche comme du texte, il ne s'exécute pas.

import { html } from "hono/html";
import type { CandidatureRow, CorrectionRow, DisplayStatus, MailRow, MailToClassify, OfferRow, OfferStats } from "./queries.js";
import { DISPLAY_STATUSES } from "./queries.js";

const TYPE_LABELS: Record<string, string> = {
  candidature_envoyee: "Candidature envoyée",
  entretien: "Entretien",
  offre: "Offre",
  refus: "Refus",
  autre: "Échange",
};

const TZ = "Europe/Paris";
/** « 30 sept. », avec l'année seulement si ce n'est pas l'année en cours. */
function date(d: Date): string {
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString("fr-FR", {
    timeZone: TZ,
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}
/** « 08:43 » */
const time = (d: Date) => d.toLocaleTimeString("fr-FR", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
const longDate =(d: Date) => d.toLocaleDateString("fr-FR", { timeZone: TZ, day: "numeric", month: "long", year: "numeric" });

const statusSlug = (s: DisplayStatus) =>
  s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, "-");
const badge = (s: DisplayStatus) => html`<span class="badge badge-${statusSlug(s)}">${s}</span>`;
const gmailUrl = (m: { threadId: string | null; gmailId: string }) =>
  `https://mail.google.com/mail/u/0/#all/${m.threadId ?? m.gmailId}`;

function layout(title: string, body: unknown) {
  return html`<!doctype html>
    <html lang="fr">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${title}</title>
        <link rel="stylesheet" href="/style.css" />
        <script src="/htmx.js" defer></script>
      </head>
      <body>
        <main>${body}</main>
      </body>
    </html>`;
}

/** Page des mails à classer à la main (#17), ouverte depuis le bouton de la page principale. */
export function toClassifyPage(mails: MailToClassify[], candidatures: CandidatureRow[]) {
  const options = [...candidatures].sort((a, b) =>
    (a.company ?? "").localeCompare(b.company ?? "", "fr", { sensitivity: "base" }),
  );
  // hx-boost : les formulaires sont envoyés sans recharger toute la page (et marchent sans JavaScript).
  return layout(
    "À classer",
    html`<p class="retour"><a href="/">← Mes candidatures</a></p>
    <header class="entete">
      <h1>À classer</h1>
      <p class="sous-titre">
        Ces mails concernent une démarche, mais aucune candidature ne leur correspond. Crée une candidature,
        rattache-les à une existante, ou ignore-les.
      </p>
    </header>
    ${mails.length === 0
      ? html`<p class="vide">0 mail à classer : tout est classé.</p>`
      : html`<section class="a-classer" hx-boost="true"><ul class="liste">
      ${mails.map(
        (m) => html`<li class="mail-a-classer">
          <div class="ligne-principale">
            <span class="entreprise">${m.company ?? "Entreprise inconnue"}</span>
            <span class="mail-date">${date(m.date)}</span>
          </div>
          <div class="mail-objet">${m.subject || "(sans objet)"}</div>
          <div class="mail-sens">
            ${m.sent ? "Envoyé à" : "Reçu de"} ${m.correspondent ?? "?"} ·
            <a href="${gmailUrl(m)}" target="_blank" rel="noreferrer">Ouvrir dans Gmail</a>
          </div>
          <div class="actions">
            <form method="post" action="/a-classer/${m.gmailId}/creer">
              <button type="submit" class="bouton bouton-principal">Créer une candidature</button>
            </form>
            <form method="post" action="/a-classer/${m.gmailId}/rattacher" class="rattacher">
              <select name="candidature" required aria-label="Candidature à laquelle rattacher ce mail">
                <option value="">Rattacher à…</option>
                ${options.map(
                  (c) => html`<option value="${c.id}">
                    ${c.company ?? "Entreprise inconnue"} · ${c.jobTitle ?? "poste non précisé"} (${date(c.appliedAt)})
                  </option>`,
                )}
              </select>
              <button type="submit" class="bouton">Rattacher</button>
            </form>
            <form method="post" action="/a-classer/${m.gmailId}/ignorer">
              <button type="submit" class="bouton bouton-discret">Ignorer</button>
            </form>
          </div>
        </li>`,
      )}
    </ul></section>`}`,
  );
}

/** Page principale : filtres par statut et liste aérée ; bouton vers les mails à classer. */
export function listPage(
  all: CandidatureRow[],
  filter: DisplayStatus | null,
  toClassifyCount = 0,
  lastSync: Date | null = null,
  newOffers = 0,
) {
  const rows = filter ? all.filter((c) => c.status === filter) : all;
  const count = (s: DisplayStatus) => all.filter((c) => c.status === s).length;
  // Les filtres remplacent seulement #contenu (htmx), et fonctionnent aussi sans JavaScript.
  const filterLink = (label: string, value: DisplayStatus | null, n: number) => {
    const href = value ? `/?statut=${encodeURIComponent(value)}` : "/";
    return html`<a
      href="${href}"
      hx-get="${href}"
      hx-target="#contenu"
      hx-select="#contenu"
      hx-swap="outerHTML"
      hx-push-url="true"
      class="filtre${filter === value ? " actif" : ""}"
      >${label} <span class="compteur">${n}</span></a
    >`;
  };

  return layout(
    "Mes candidatures",
    html`<header class="entete entete-liste">
        <div>
          <h1>Mes candidatures</h1>
          <p class="sous-titre">${all.length} candidatures depuis le 1<sup>er</sup> juin</p>
          <p class="mise-a-jour">
            ${lastSync ? `Mis à jour le ${date(lastSync)} à ${time(lastSync)}` : "Jamais synchronisé"}
          </p>
        </div>
        <div class="entete-actions">
          <a class="bouton bouton-discret" href="/corrections">Corrections</a>
          <a class="bouton bouton-offres${newOffers === 0 ? " sans-nouvelle" : ""}" href="/offres"
            >Offres <span class="compteur" title="nouvelles offres">${newOffers}</span></a
          >
          <a class="bouton bouton-a-classer${toClassifyCount === 0 ? " vide-a-classer" : ""}" href="/a-classer"
            >À classer <span class="compteur">${toClassifyCount}</span></a
          >
        </div>
      </header>
      <div id="contenu">
        <nav class="filtres">
          ${filterLink("Toutes", null, all.length)}
          ${DISPLAY_STATUSES.map((s) => filterLink(s, s, count(s)))}
        </nav>
        ${rows.length === 0
          ? html`<p class="vide">Aucune candidature ici.</p>`
          : html`<ul class="liste">
              ${rows.map(
                (c) => html`<li>
                  <a class="ligne" href="/candidatures/${c.id}">
                    <div class="ligne-principale">
                      <span class="entreprise">${c.company ?? "Entreprise inconnue"}</span>
                      ${c.toCheck ? html`<span class="a-verifier" title="Rattachement à vérifier">à vérifier</span>` : ""}
                      ${badge(c.status)}
                    </div>
                    <div class="ligne-secondaire">
                      <span>${c.jobTitle ?? "Poste non précisé"}</span>
                      ${c.location ? html`<span>${c.location}</span>` : ""}
                      <span>Candidature le ${date(c.appliedAt)}</span>
                      <span>${TYPE_LABELS[c.lastEventType] ?? c.lastEventType} le ${date(c.lastEventAt)}</span>
                    </div>
                  </a>
                </li>`,
              )}
            </ul>`}
      </div>`,
  );
}

/** Offres à regarder (#24) : annonces des alertes gardées par les filtres. */
export function offersPage(offers: OfferRow[], stats: OfferStats) {
  const rejected = stats.rejectedByTitle + stats.rejectedByClaude;
  return layout(
    "Offres à regarder",
    html`<p class="retour"><a href="/">← Mes candidatures</a></p>
      <header class="entete entete-liste">
        <div>
          <h1>Offres à regarder</h1>
          <p class="sous-titre">Annonces de tes alertes qui correspondent à ta recherche.</p>
        </div>
        <div class="entete-actions">
          <a class="bouton bouton-discret" href="/offres/reglages">Réglages</a>
        </div>
      </header>
      ${offers.length === 0
        ? html`<p class="vide">Aucune offre à regarder pour l'instant.</p>`
        : html`<ul class="liste offres">
            ${offers.map(
              (o) => html`<li class="offre${o.isNew ? " offre-nouvelle" : ""}">
                <div class="ligne-principale">
                  <span class="entreprise">${o.title}</span>
                  ${o.isNew ? html`<span class="pastille pastille-nouveau">nouveau</span>` : ""}
                  ${o.unverified
                    ? html`<span class="pastille pastille-non-verifiee" title="Page illisible : non triée par Claude"
                        >non vérifiée</span
                      >`
                    : ""}
                  <span class="mail-date">${date(o.receivedAt)}</span>
                </div>
                <div class="ligne-secondaire">
                  <span>${o.company ?? "Entreprise inconnue"}</span>
                  ${o.location ? html`<span>${o.location}</span>` : ""}
                  ${o.contract ? html`<span>${o.contract}</span>` : ""}
                </div>
                ${o.justification ? html`<p class="mail-justification">${o.justification}</p>` : ""}
                <div class="actions">
                  <!-- Nouvel onglet : la consultation est enregistrée, puis l'annonce s'ouvre. -->
                  <form method="post" action="/offres/${o.id}/consulter" target="_blank">
                    <button type="submit" class="bouton bouton-principal">Consulter</button>
                  </form>
                  <form method="post" action="/offres/${o.id}/ignorer" hx-boost="true">
                    <button type="submit" class="bouton bouton-discret">Ignorer</button>
                  </form>
                </div>
              </li>`,
            )}
          </ul>`}
      <p class="offres-stats">
        ${rejected} annonce${rejected > 1 ? "s" : ""} écartée${rejected > 1 ? "s" : ""} ces 7 derniers jours
        (${stats.rejectedByTitle} par l'intitulé, ${stats.rejectedByClaude} par Claude)${stats.pending
          ? ` · ${stats.pending} en cours de tri`
          : ""}.
      </p>`,
  );
}

export interface OfferSettings {
  keep: string[];
  exclude: string[];
  profile: string;
  ceilings: { produitProjet: number; developpeur: number };
  /** Message après une action (erreur ou confirmation). */
  message: string | null;
}

/** Réglages de la veille des offres (#25) : listes du filtre, profil, plafonds. */
export function offerSettingsPage(s: OfferSettings) {
  const termList = (kind: "poste" | "exclu", title: string, terms: string[], placeholder: string) => html`<section
    class="reglage"
  >
    <h2>${title}</h2>
    ${terms.length === 0
      ? html`<p class="vide">Liste vide.</p>`
      : html`<ul class="termes">
          ${terms.map(
            (t) => html`<li class="terme">
              <span>${t}</span>
              <form method="post" action="/offres/reglages/termes/retirer">
                <input type="hidden" name="kind" value="${kind}" />
                <input type="hidden" name="term" value="${t}" />
                <button type="submit" class="retirer" aria-label="Retirer ${t}" title="Retirer">×</button>
              </form>
            </li>`,
          )}
        </ul>`}
    <form class="formulaire ajout-terme" method="post" action="/offres/reglages/termes/ajouter">
      <input type="hidden" name="kind" value="${kind}" />
      <input type="text" name="term" required maxlength="60" placeholder="${placeholder}" aria-label="Terme à ajouter" />
      <button type="submit" class="bouton">Ajouter</button>
    </form>
  </section>`;

  return layout(
    "Réglages des offres",
    html`<p class="retour"><a href="/offres">← Offres à regarder</a></p>
      <header class="entete">
        <h1>Réglages des offres</h1>
        <p class="sous-titre">Ce qui décide des annonces affichées.</p>
      </header>
      ${s.message ? html`<p class="alerte">${s.message}</p>` : ""}
      <div hx-boost="true">
        <p class="aide">
          Filtre sur l'intitulé : mots entiers, accents ignorés, « * » en fin de mot pour toutes les terminaisons
          (« chef de projet* »). Les changements s'appliquent aux prochaines annonces.
        </p>
        ${termList("poste", "Postes recherchés", s.keep, "ex. product owner")}
        ${termList("exclu", "Mots exclus (intitulé ou contrat)", s.exclude, "ex. alternance")}

        <section class="reglage">
          <h2>Plafonds d'expérience demandée</h2>
          <form class="infos formulaire" method="post" action="/offres/reglages/plafonds">
            <label class="info"
              ><span class="libelle">Produit / projet (années)</span
              ><input type="number" name="produit_projet" min="0" max="30" step="0.5" value="${s.ceilings.produitProjet}" required
            /></label>
            <label class="info"
              ><span class="libelle">Développeur (années)</span
              ><input type="number" name="developpeur" min="0" max="30" step="0.5" value="${s.ceilings.developpeur}" required
            /></label>
            <p class="aide-formulaire">Une annonce qui exige plus que le plafond est écartée. Appliqué aussi aux annonces déjà triées.</p>
            <div class="actions"><button type="submit" class="bouton bouton-principal">Enregistrer</button></div>
          </form>
        </section>

        <section class="reglage">
          <h2>Profil envoyé à Claude</h2>
          <form class="formulaire" method="post" action="/offres/reglages/profil">
            <textarea name="profil" rows="14" required aria-label="Profil du candidat">${s.profile}</textarea>
            <p class="aide-formulaire">Sert à reconnaître le type de poste. Appliqué aux prochaines annonces uniquement.</p>
            <div class="actions"><button type="submit" class="bouton bouton-principal">Enregistrer</button></div>
          </form>
        </section>
      </div>`,
  );
}

const EDIT_STATUSES = ["Envoyée", "Entretien", "Offre", "Refus"] as const;
const modified = (c: CandidatureRow, key: string) =>
  c.manual.includes(key) ? html`<span class="modifie" title="Corrigé à la main">modifié</span>` : "";

/** Page d'une candidature : ses informations (éventuellement en mode modification) et ses mails. */
export function detailPage(c: CandidatureRow, mails: MailRow[], editing = false) {
  const field = (label: string, key: string, value: unknown) =>
    html`<div class="info">
      <dt>${label} ${modified(c, key)}</dt>
      <dd>${value ?? html`<span class="manquant">Non précisé</span>`}</dd>
    </div>`;
  const input = (label: string, name: string, value: string | null) =>
    html`<label class="info"
      ><span class="libelle">${label}</span><input type="text" name="${name}" value="${value ?? ""}"
    /></label>`;

  const infos = editing
    ? html`<form class="infos formulaire" method="post" action="/candidatures/${c.id}/modifier">
        ${input("Entreprise", "company", c.company)} ${input("Poste", "jobTitle", c.jobTitle)}
        ${input("Lieu", "location", c.location)} ${input("Canal", "channel", c.channel)}
        ${input("Lien de l'offre", "offerUrl", c.offerUrl)}
        <label class="info"
          ><span class="libelle">Statut</span>
          <select name="status">
            ${EDIT_STATUSES.map((s) => html`<option value="${s}" ${s === c.rawStatus ? "selected" : ""}>${s}</option>`)}
          </select>
        </label>
        <p class="aide-formulaire">
          Un statut changé à la main vaut jusqu'au prochain mail qui change le statut. Laisse un champ vide pour
          « non précisé ».
        </p>
        <div class="actions">
          <button type="submit" class="bouton bouton-principal">Enregistrer</button>
          <a class="bouton bouton-discret" href="/candidatures/${c.id}">Annuler</a>
        </div>
      </form>`
    : html`<dl class="infos">
          ${field("Candidature", "", longDate(c.appliedAt))} ${field("Lieu", "location", c.location)}
          ${field("Canal", "channel", c.channel)}
          ${field("Offre", "offerUrl", c.offerUrl ? html`<a href="${c.offerUrl}" rel="noreferrer">Voir l'annonce</a>` : null)}
        </dl>
        <div class="actions actions-detail">
          <a class="bouton" href="/candidatures/${c.id}/modifier">Modifier</a>
          <form
            method="post"
            action="/candidatures/${c.id}/pas-candidature"
            onsubmit="return confirm('Retirer cette candidature et ignorer ses mails ? (annulable depuis la page Corrections)')"
          >
            <button type="submit" class="bouton bouton-discret">Ce n'est pas une candidature</button>
          </form>
        </div>`;

  return layout(
    `${c.company ?? "Candidature"} · ${c.jobTitle ?? ""}`,
    html`<p class="retour"><a href="/">← Mes candidatures</a></p>
      <header class="entete">
        <div class="titre-detail">
          <h1>${c.company ?? "Entreprise inconnue"}</h1>
          ${badge(c.status)} ${modified(c, "status")} ${modified(c, "company")}
        </div>
        <p class="sous-titre">${c.jobTitle ?? "Poste non précisé"} ${modified(c, "jobTitle")}</p>
      </header>
      ${c.toCheck
        ? html`<p class="alerte">Un mail au moins a été rattaché par défaut à cette candidature : à vérifier.</p>`
        : ""}
      ${infos}
      <h2>Historique</h2>
      <ol class="historique">
        ${mails.map(
          (m) => html`<li class="evenement evenement-${m.type}">
            <div class="evenement-entete">
              <span class="mail-type">${TYPE_LABELS[m.type] ?? m.type}</span>
              <span class="mail-date">${longDate(m.date)}</span>
              ${m.toCheck ? html`<span class="a-verifier">à vérifier</span>` : ""}
            </div>
            <div class="mail-objet">${m.subject || "(sans objet)"}</div>
            <div class="mail-sens">${m.sent ? "Envoyé à" : "Reçu de"} ${m.correspondent ?? "?"}</div>
            ${m.justification ? html`<p class="mail-justification">${m.justification}</p>` : ""}
            <a class="mail-lien" href="${gmailUrl(m)}" target="_blank" rel="noreferrer">Ouvrir dans Gmail</a>
          </li>`,
        )}
      </ol>`,
  );
}

/** Page des corrections manuelles, avec annulation. */
export function correctionsPage(corrections: CorrectionRow[]) {
  return layout(
    "Corrections",
    html`<p class="retour"><a href="/">← Mes candidatures</a></p>
      <header class="entete">
        <h1>Corrections</h1>
        <p class="sous-titre">
          Tes décisions manuelles, la plus récente en premier. Annuler une correction rétablit le classement automatique.
        </p>
      </header>
      ${corrections.length === 0
        ? html`<p class="vide">Aucune correction.</p>`
        : html`<ul class="liste" hx-boost="true">
            ${corrections.map(
              (k) => html`<li class="correction">
                <div>
                  <div>${k.description}</div>
                  <div class="mail-date">${longDate(k.createdAt)}</div>
                </div>
                <form method="post" action="/corrections/${k.id}/annuler">
                  <button type="submit" class="bouton bouton-discret">Annuler</button>
                </form>
              </li>`,
            )}
          </ul>`}`,
  );
}

export function notFoundPage() {
  return layout(
    "Introuvable",
    html`<p class="retour"><a href="/">← Mes candidatures</a></p>
      <p class="vide">Cette candidature est introuvable.</p>`,
  );
}
