// Pages HTML. Le gabarit `html` de Hono échappe automatiquement les valeurs insérées :
// un objet de mail contenant du HTML s'affiche comme du texte, il ne s'exécute pas.

import { html } from "hono/html";
import type { CandidatureRow, DisplayStatus, MailRow, MailToClassify } from "./queries.js";
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
const longDate = (d: Date) => d.toLocaleDateString("fr-FR", { timeZone: TZ, day: "numeric", month: "long", year: "numeric" });

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
export function listPage(all: CandidatureRow[], filter: DisplayStatus | null, toClassifyCount = 0) {
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
        </div>
        <a class="bouton bouton-a-classer${toClassifyCount === 0 ? " vide-a-classer" : ""}" href="/a-classer"
          >À classer <span class="compteur">${toClassifyCount}</span></a
        >
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

/** Page d'une candidature : ses informations et ses mails. */
export function detailPage(c: CandidatureRow, mails: MailRow[]) {
  const field = (label: string, value: unknown) =>
    html`<div class="info"><dt>${label}</dt><dd>${value ?? html`<span class="manquant">Non précisé</span>`}</dd></div>`;
  return layout(
    `${c.company ?? "Candidature"} · ${c.jobTitle ?? ""}`,
    html`<p class="retour"><a href="/">← Mes candidatures</a></p>
      <header class="entete">
        <div class="titre-detail">
          <h1>${c.company ?? "Entreprise inconnue"}</h1>
          ${badge(c.status)}
        </div>
        <p class="sous-titre">${c.jobTitle ?? "Poste non précisé"}</p>
      </header>
      ${c.toCheck
        ? html`<p class="alerte">Un mail au moins a été rattaché par défaut à cette candidature : à vérifier.</p>`
        : ""}
      <dl class="infos">
        ${field("Candidature", longDate(c.appliedAt))} ${field("Lieu", c.location)} ${field("Canal", c.channel)}
        ${field("Offre", c.offerUrl ? html`<a href="${c.offerUrl}" rel="noreferrer">Voir l'annonce</a>` : null)}
      </dl>
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

export function notFoundPage() {
  return layout(
    "Introuvable",
    html`<p class="retour"><a href="/">← Mes candidatures</a></p>
      <p class="vide">Cette candidature est introuvable.</p>`,
  );
}
