// Offres fermées (#14) : Hellowork prévient quand une offre à laquelle on a postulé n'est plus en ligne.
// Ces mails sont écartés du classement par le pré-filtre (règle offre-fermee) : on en lit ici, sans
// Claude, l'offre concernée, et la candidature correspondante passe en Refus (voir candidatures.ts).
//
// Formats constatés :
// - un poste : « Du nouveau pour votre candidature : <intitulé> dans l'entreprise <entreprise>.
//   L'offre n'est plus disponible… » ;
// - groupé : « Dans les entreprises <A> et <B>. Les offres ne sont plus disponibles… » (sans intitulés) ;
// - sinon, l'objet seul : « L'offre de <intitulé> n'est plus disponible ».

import type { ExtractedMail } from "./extract.js";

export interface ClosedOffer {
  company: string | null;
  jobTitle: string | null;
}

const A = "['’]"; // apostrophe droite ou typographique
const SINGLE = new RegExp(
  `Du nouveau pour votre candidature\\s*:\\s*([\\s\\S]+?)\\s+dans l${A}entreprise\\s+([\\s\\S]+?)\\.\\s+L${A}offre n${A}est plus disponible`,
);
const GROUPED = /Dans les entreprises\s+([\s\S]+?)\.\s+Les offres ne sont plus disponibles/;
const SUBJECT = new RegExp(`^L${A}offre de (.+) n${A}est plus disponible$`, "i");

const clean = (s: string) => s.replace(/\s+/g, " ").trim();

/** Offres signalées fermées par le mail ; liste vide si le format n'est pas reconnu. */
export function parseClosedOffers(mail: Pick<ExtractedMail, "subject" | "text">): ClosedOffer[] {
  const single = mail.text.match(SINGLE);
  if (single) return [{ jobTitle: clean(single[1]), company: clean(single[2]) }];

  const grouped = mail.text.match(GROUPED);
  if (grouped) {
    return clean(grouped[1])
      .split(/\s*,\s*|\s+et\s+/)
      .filter(Boolean)
      .map((company) => ({ company, jobTitle: null }));
  }

  const subject = clean(mail.subject).match(SUBJECT);
  return subject ? [{ company: null, jobTitle: subject[1] }] : [];
}
