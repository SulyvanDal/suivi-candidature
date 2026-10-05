import assert from "node:assert/strict";
import { test } from "node:test";
import type { gmail_v1 } from "@googleapis/gmail";
import { openDb } from "./db.js";
import { processMessage } from "./pipeline.js";

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
