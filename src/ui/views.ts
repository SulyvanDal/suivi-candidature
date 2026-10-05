// Pages HTML. Le gabarit `html` de Hono échappe automatiquement les valeurs insérées :
// un objet de mail contenant du HTML s'affiche comme du texte, il ne s'exécute pas.

import { html } from "hono/html";
import type { CandidatureRow, DisplayStatus, MailRow } from "./queries.js";
import { DISPLAY_STATUSES } from "./queries.js";

const TYPE_LABELS: Record<string, string> = {
  candidature_envoyee: "Candidature / accusé",
  entretien: "Entretien",
  offre: "Offre",
  refus: "Refus",
  autre: "Échange",
};

const date = (d: Date) => d.toLocaleDateString("fr-FR", { timeZone: "Europe/Paris" });
const statusClass = (s: DisplayStatus) =>
  `badge badge-${s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, "-")}`;
const gmailUrl = (m: MailRow) => `https://mail.google.com/mail/u/0/#all/${m.threadId ?? m.gmailId}`;

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
        <header><a href="/" class="brand">Suivi de candidatures</a></header>
        <main>${body}</main>
      </body>
    </html>`;
}

/** Page principale : filtres par statut et tableau. */
export function listPage(all: CandidatureRow[], filter: DisplayStatus | null) {
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
    "Candidatures",
    html`<div id="contenu">
      <nav class="filtres">
        ${filterLink("Toutes", null, all.length)}
        ${DISPLAY_STATUSES.map((s) => filterLink(s, s, count(s)))}
      </nav>
      ${rows.length === 0
        ? html`<p class="vide">Aucune candidature.</p>`
        : html`<table>
            <thead>
              <tr>
                <th>Candidature</th>
                <th>Statut</th>
                <th>Entreprise</th>
                <th>Poste</th>
                <th>Lieu</th>
                <th>Dernier événement</th>
              </tr>
            </thead>
            <tbody>
              ${rows.map(
                (c) => html`<tr>
                  <td>${date(c.appliedAt)}</td>
                  <td><span class="${statusClass(c.status)}">${c.status}</span></td>
                  <td>
                    <a href="/candidatures/${c.id}">${c.company ?? "Entreprise inconnue"}</a>
                    ${c.toCheck ? html`<span class="a-verifier" title="Rattachement à vérifier">⚠</span>` : ""}
                  </td>
                  <td>${c.jobTitle ?? "—"}</td>
                  <td>${c.location ?? "—"}</td>
                  <td>${date(c.lastEventAt)} · ${TYPE_LABELS[c.lastEventType] ?? c.lastEventType}</td>
                </tr>`,
              )}
            </tbody>
          </table>`}
    </div>`,
  );
}

/** Page d'une candidature : ses champs et ses mails. */
export function detailPage(c: CandidatureRow, mails: MailRow[]) {
  const field = (label: string, value: unknown) => html`<dt>${label}</dt><dd>${value ?? "—"}</dd>`;
  return layout(
    `${c.company ?? "Candidature"} – ${c.jobTitle ?? ""}`,
    html`<p><a href="/">← Toutes les candidatures</a></p>
      <h1>${c.company ?? "Entreprise inconnue"} <span class="${statusClass(c.status)}">${c.status}</span></h1>
      <p class="poste">${c.jobTitle ?? "Poste inconnu"}</p>
      ${c.toCheck ? html`<p class="alerte">⚠ Un mail au moins a été rattaché par défaut : à vérifier.</p>` : ""}
      <dl>
        ${field("Date de candidature", date(c.appliedAt))} ${field("Lieu", c.location)} ${field("Canal", c.channel)}
        ${field("Lien de l'offre", c.offerUrl ? html`<a href="${c.offerUrl}" rel="noreferrer">${c.offerUrl}</a>` : null)}
      </dl>
      <h2>Mails (${mails.length})</h2>
      <ol class="mails">
        ${mails.map(
          (m) => html`<li>
            <div class="mail-entete">
              <span class="mail-date">${date(m.date)}</span>
              <span class="mail-type">${TYPE_LABELS[m.type] ?? m.type}</span>
              <span class="mail-sens">${m.sent ? "envoyé à" : "reçu de"} ${m.correspondent ?? "?"}</span>
              ${m.toCheck ? html`<span class="a-verifier">⚠ à vérifier</span>` : ""}
            </div>
            <div class="mail-objet">${m.subject || "(sans objet)"}</div>
            ${m.justification ? html`<div class="mail-justification">${m.justification}</div>` : ""}
            <a href="${gmailUrl(m)}" target="_blank" rel="noreferrer">Ouvrir dans Gmail ↗</a>
          </li>`,
        )}
      </ol>`,
  );
}

export function notFoundPage() {
  return layout("Introuvable", html`<p>Candidature introuvable.</p><p><a href="/">← Toutes les candidatures</a></p>`);
}
