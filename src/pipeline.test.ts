import assert from "node:assert/strict";
import { test } from "node:test";
import type { gmail_v1 } from "@googleapis/gmail";
import { openDb } from "./db.js";
import { ClassificationRefusedError } from "./classify.js";
import { processMessage } from "./pipeline.js";
import { MailFailedError } from "./sync.js";

// Mails fabriqués, faux Gmail et faux Claude.

function gmailMessage(id: string, subject: string, text: string, labelIds = ["INBOX"]): gmail_v1.Schema$Message {
  return {
    id,
    labelIds,
    internalDate: String(Date.UTC(2026, 9, 5)),
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: "RH <rh@exemple.com>" },
        { name: "Subject", value: subject },
      ],
      body: { data: Buffer.from(text).toString("base64url") },
    },
  };
}

function deps(messages: gmail_v1.Schema$Message[]) {
  const db = openDb(":memory:");
  const classified: string[] = [];
  return {
    db,
    classified,
    deps: {
      db,
      model: "modele-test",
      fetchMessage: async (id: string) => messages.find((m) => m.id === id)!,
      classify: async (mail: { id: string }) => {
        classified.push(mail.id);
        return {
          classification: {
            type: "entretien" as const,
            justification: "Invitation.",
            entreprise: "Exemple SA",
            poste: "Product Owner",
            lieu: null,
            canal: "mail direct",
            lien_offre: null,
          },
          truncated: false,
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    },
  };
}

test("mail gardé par le pré-filtre : classé par Claude et enregistré", async () => {
  const t = deps([gmailMessage("a", "Entretien", "Je vous propose un entretien jeudi.")]);
  await processMessage("a", t.deps);

  assert.deepEqual(t.classified, ["a"]);
  const row = t.db.prepare("SELECT * FROM mail_results WHERE gmail_id = 'a'").get() as Record<string, unknown>;
  assert.equal(row.filter_rule, "mot-cle");
  assert.equal(row.event_type, "entretien");
  assert.equal(row.model, "modele-test");
  assert.equal(row.sent, 0);
  assert.equal(row.company, "Exemple SA");
  assert.equal(row.job_title, "Product Owner");
  assert.equal(row.location, null);
});

test("mail écarté par le pré-filtre : pas envoyé à Claude, mais sa règle est enregistrée", async () => {
  const t = deps([gmailMessage("b", "L'offre de Chef de projet n'est plus disponible", "…", ["INBOX"])]);
  await processMessage("b", t.deps);

  assert.deepEqual(t.classified, []);
  const row = t.db.prepare("SELECT * FROM mail_results WHERE gmail_id = 'b'").get() as Record<string, unknown>;
  assert.equal(row.filter_rule, "offre-fermee");
  assert.equal(row.event_type, null);
});

// Alerte d'offres fabriquée, au format HTML de Hellowork.
function alertMessage(id: string, from: string, offers: [title: string, company: string, contract: string][]) {
  const html = offers
    .map(
      ([title, company, contract], i) =>
        `<p><a href="https://emails.hellowork.com/clic/${id}-${i}">${title}</a></p><p>${company}</p><p>Paris - 75</p>` +
        `<p>${contract}</p><p><a href="https://emails.hellowork.com/clic/${id}-${i}-voir">Voir l’offre</a></p>`,
    )
    .join("");
  return {
    id,
    labelIds: ["INBOX"],
    internalDate: String(Date.UTC(2026, 9, 6)),
    payload: {
      mimeType: "text/html",
      headers: [
        { name: "From", value: from },
        { name: "Subject", value: `Camille, ${offers.length} offres récentes proches de votre recherche` },
      ],
      body: { data: Buffer.from(`<html><body>${html}</body></html>`).toString("base64url") },
    },
  } satisfies gmail_v1.Schema$Message;
}

const HELLOWORK = "Hellowork Alert <alerte@emails.hellowork.com>";
const offerRows = (db: ReturnType<typeof openDb>) =>
  db.prepare("SELECT title, company, contract, title_keep, title_rule, gmail_id FROM offers ORDER BY id").all();

test("alerte d'offres : pas envoyée à Claude, annonces enregistrées avec la décision du filtre sur l'intitulé", async () => {
  const t = deps([
    alertMessage("al1", HELLOWORK, [
      ["Product Owner H/F", "Exemple", "CDI"],
      ["Chef de Projet H/F", "Intérim Plus", "Intérim"],
      ["Data Scientist H/F", "Autre", "CDI"],
    ]),
  ]);
  const p = await processMessage("al1", t.deps);

  assert.deepEqual(t.classified, []);
  assert.deepEqual(p.offers, { found: 3, added: 3, kept: 1 });
  assert.deepEqual(
    offerRows(t.db).map((r) => ({ ...r })),
    [
      { title: "Product Owner H/F", company: "Exemple", contract: "CDI", title_keep: 1, title_rule: "poste-recherche", gmail_id: "al1" },
      { title: "Chef de Projet H/F", company: "Intérim Plus", contract: "Intérim", title_keep: 0, title_rule: "exclu", gmail_id: "al1" },
      { title: "Data Scientist H/F", company: "Autre", contract: "CDI", title_keep: 0, title_rule: "aucun-poste", gmail_id: "al1" },
    ],
  );
});

test("alerte d'offres : une annonce déjà vue (casse et accents ignorés) n'est pas enregistrée deux fois", async () => {
  const t = deps([
    alertMessage("al1", HELLOWORK, [["Product Owner H/F", "Société Exemple", "CDI"]]),
    alertMessage("al2", HELLOWORK, [
      ["PRODUCT OWNER H/F", "Societe exemple", "CDI"],
      ["Développeur React H/F", "Exemple", "CDI"],
    ]),
  ]);
  await processMessage("al1", t.deps);
  const p = await processMessage("al2", t.deps);

  assert.deepEqual(p.offers, { found: 2, added: 1, kept: 1 });
  assert.deepEqual(
    offerRows(t.db).map((r) => [r.title, r.gmail_id]),
    [
      ["Product Owner H/F", "al1"],
      ["Développeur React H/F", "al2"],
    ],
  );
});

test("alerte d'une plateforme qu'on ne sait pas lire (Job Watch) : ignorée", async () => {
  const t = deps([alertMessage("jw", "Job Watch <noreply@jobwatch.ch>", [["Product Owner", "Exemple", "CDI"]])]);
  const p = await processMessage("jw", t.deps);

  assert.equal(p.decision.rule, "alerte-offres");
  assert.equal(p.offers, undefined);
  assert.equal(offerRows(t.db).length, 0);
});

test("Claude ne peut pas classer le mail : enregistré avec l'erreur, sans classification", async () => {
  const t = deps([gmailMessage("a", "Entretien", "Je vous propose un entretien jeudi.")]);
  t.deps.classify = async () => {
    throw new ClassificationRefusedError("Classification refusée pour le mail a.");
  };

  await assert.rejects(processMessage("a", t.deps), MailFailedError);
  const row = t.db.prepare("SELECT filter_rule, event_type, error FROM mail_results WHERE gmail_id = 'a'").get();
  assert.deepEqual({ ...row }, { filter_rule: "mot-cle", event_type: null, error: "Classification refusée pour le mail a." });
});

test("Claude indisponible : l'erreur remonte telle quelle, rien n'est enregistré", async () => {
  const t = deps([gmailMessage("a", "Entretien", "Je vous propose un entretien jeudi.")]);
  t.deps.classify = async () => {
    throw new Error("529 overloaded");
  };

  await assert.rejects(processMessage("a", t.deps), /overloaded/);
  assert.equal(t.db.prepare("SELECT 1 FROM mail_results WHERE gmail_id = 'a'").get(), undefined);
});

test("mail illisible (date absente) : enregistré en « erreur », sans appel à Claude", async () => {
  const message = gmailMessage("a", "Entretien", "Je vous propose un entretien jeudi.");
  delete message.internalDate;
  const t = deps([message]);

  await assert.rejects(processMessage("a", t.deps), MailFailedError);
  assert.deepEqual(t.classified, []);
  const row = t.db.prepare("SELECT filter_rule, error FROM mail_results WHERE gmail_id = 'a'").get();
  assert.deepEqual({ ...row }, { filter_rule: "erreur", error: "Extraction impossible : date du mail illisible" });
});

test("mail repassé avec succès : l'erreur précédente est effacée", async () => {
  const t = deps([gmailMessage("a", "Entretien", "Je vous propose un entretien jeudi.")]);
  const classify = t.deps.classify;
  t.deps.classify = async () => {
    throw new ClassificationRefusedError("refus");
  };
  await assert.rejects(processMessage("a", t.deps), MailFailedError);

  t.deps.classify = classify;
  await processMessage("a", t.deps);
  const row = t.db.prepare("SELECT event_type, error FROM mail_results WHERE gmail_id = 'a'").get();
  assert.deepEqual({ ...row }, { event_type: "entretien", error: null });
});
