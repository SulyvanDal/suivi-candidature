// Pré-filtre : ne garder pour l'analyse par Claude que les mails probablement liés à une
// candidature. Priorité : ne perdre aucune candidature ; en cas de doute, on garde.
//
// 1. Exclusions explicites (alertes d'offres, offres fermées, mails non distribués).
// 2. Mots-clés de candidature dans l'objet ou le texte → gardé.
// 3. Sinon → écarté.

import type { ExtractedMail } from "./extract.js";
import { EXCLUSIONS, KEYWORDS } from "./filter-rules.js";

export interface FilterDecision {
  keep: boolean;
  /** Nom de la règle appliquée. */
  rule: string;
  /** Pour « mot-cle » : le mot trouvé. */
  match?: string;
}

// Les accents sont gardés : ils distinguent « poste » de « posté ».
// Limites de mots compatibles avec les lettres accentuées (\b ne les reconnaît pas).
const KEYWORDS_RE = new RegExp(
  `(?<![\\p{L}\\p{N}])(${KEYWORDS.map((k) =>
    k.toLowerCase().replace(/\*$/, "\\p{L}*").replace(/ /g, "\\s+"),
  ).join("|")})(?![\\p{L}\\p{N}])`,
  "u",
);

export function filterMail(mail: Pick<ExtractedMail, "from" | "subject" | "text">): FilterDecision {
  for (const rule of EXCLUSIONS) {
    if (
      rule.from?.test(mail.from) ||
      rule.subject?.test(mail.subject) ||
      rule.text?.test(mail.text)
    ) {
      return { keep: false, rule: rule.name };
    }
  }

  const found = KEYWORDS_RE.exec(`${mail.subject}\n${mail.text}`.toLowerCase());
  if (found) return { keep: true, rule: "mot-cle", match: found[1] };

  return { keep: false, rule: "aucun-mot-cle" };
}
