// Règles du pré-filtre. Ce sont des données : on peut les ajuster sans toucher à la logique.
//
// Pas de liste d'expéditeurs à maintenir : seuls l'objet et le contenu comptent
// (exception : postmaster / mailer-daemon, adresses standard des mails non distribués).

export interface ExclusionRule {
  /** Nom de la règle, affiché en simulation et réutilisable (ex. #14 pour offre-fermee). */
  name: string;
  from?: RegExp;
  subject?: RegExp;
  text?: RegExp;
}

/** Vérifiées en premier, dans l'ordre : la première qui correspond écarte le mail. */
export const EXCLUSIONS: ExclusionRule[] = [
  {
    name: "non-distribue",
    from: /\b(mailer-daemon|postmaster)@/i,
    subject:
      /^(undeliverable|undelivered|non distribuable|non remis|delivery status notification|mail delivery (failed|subsystem)|returned mail)/i,
  },
  {
    name: "offre-fermee",
    subject: /n.est plus disponible|ne sont plus disponibles/i,
  },
  {
    name: "alerte-offres",
    subject:
      /nouvelles offres|offres? récentes|nouveautés du jour|sélection d.offres|\brecrute (un|une|des)\b|offres? d.emploi rien que pour vous/i,
    text: /pourrait correspondre pour l.offre d.emploi suivante/i,
  },
];

/**
 * Mots-clés de candidature, recherchés en mots entiers dans l'objet et le texte,
 * sans tenir compte des majuscules. Les accents comptent (« poste » ≠ « posté »).
 * Un « * » final accepte toutes les terminaisons (postul* → postule, postulé, postuler…).
 */
export const KEYWORDS: string[] = [
  "candidature*",
  "postul*",
  "entretien*",
  "recrutement*",
  "recruteur*",
  "cv",
  "donner suite",
  "poste",
  "your application",
  "application for",
  "job application",
  "interview*",
  "recruiter*",
  "hiring",
];
