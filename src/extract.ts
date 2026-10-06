// Extraction du texte d'un mail Gmail (format "full").
//
// Un mail est un arbre de parties MIME. On le parcourt en ignorant les pièces jointes :
// - multipart/alternative : plusieurs versions du même contenu → on choisit la meilleure ;
// - autres multipart (mixed, related…) : contenus différents → mis bout à bout ;
// - text/plain : décodé tel quel ; text/html : converti en texte.

import type { gmail_v1 } from "@googleapis/gmail";
import { convert } from "html-to-text";

type Part = gmail_v1.Schema$MessagePart;

export interface ExtractedMail {
  id: string;
  /** Fil de discussion Gmail. */
  threadId: string | null;
  /** Date de réception par Gmail. */
  date: Date;
  from: string;
  to: string;
  subject: string;
  /** Envoyé par moi (libellé SENT). */
  sent: boolean;
  text: string;
}

/** En dessous, une version text/plain est jugée trop pauvre et on préfère le HTML. */
const MIN_PLAIN_LENGTH = 200;

export function extractMail(message: gmail_v1.Schema$Message): ExtractedMail {
  const payload = message.payload ?? {};
  return {
    id: message.id ?? "",
    threadId: message.threadId ?? null,
    date: new Date(Number(message.internalDate)),
    from: header(payload, "From"),
    to: header(payload, "To"),
    subject: header(payload, "Subject"),
    sent: message.labelIds?.includes("SENT") ?? false,
    text: clean(partText(payload)),
  };
}

/** HTML brut du mail (première partie text/html), avec les liens intacts ; "" s'il n'y en a pas. */
export function mailHtml(message: gmail_v1.Schema$Message): string {
  const find = (part: Part): string => {
    if (part.filename) return "";
    if (part.mimeType?.toLowerCase() === "text/html") return decodeBody(part);
    for (const child of part.parts ?? []) {
      const found = find(child);
      if (found) return found;
    }
    return "";
  };
  return find(message.payload ?? {});
}

function partText(part: Part): string {
  // Pièce jointe (y compris un .txt joint) : ignorée.
  if (part.filename) return "";

  const type = (part.mimeType ?? "").toLowerCase();
  const children = part.parts ?? [];

  if (type === "multipart/alternative") {
    const plainPart = children.find((c) => c.mimeType?.toLowerCase() === "text/plain");
    const plain = plainPart ? clean(partText(plainPart)) : "";
    if (plain.length >= MIN_PLAIN_LENGTH) return plain;
    // Sinon, la version la plus riche : par convention, la dernière (souvent le HTML).
    const richer = children
      .filter((c) => c !== plainPart)
      .map(partText)
      .filter((t) => clean(t).length > 0)
      .at(-1);
    return richer ?? plain;
  }
  if (type === "multipart/report") {
    // Mail non distribué : seule la première partie (le message lisible) est utile ;
    // les suivantes sont le diagnostic technique et le mail d'origine.
    return children[0] ? partText(children[0]) : "";
  }
  if (type.startsWith("multipart/")) {
    return children.map(partText).filter(Boolean).join("\n\n");
  }
  if (type === "text/plain") {
    // Certains ATS (Hellotalent, SmartRecruiters…) mettent du HTML dans la partie texte.
    // Leurs retours à la ligne sont parfois de vrais sauts de ligne, sans <br> : on les conserve.
    const text = decodeBody(part);
    return looksLikeHtml(text) ? htmlToText(text.replace(/(?<!<br\s*\/?>)\r?\n/gi, "<br>\n")) : text;
  }
  if (type === "text/html") return htmlToText(decodeBody(part));
  return "";
}

function looksLikeHtml(text: string): boolean {
  return /<(br|p|div|span|a|table|td)\b[^>]*>|&(nbsp|eacute|agrave|rsquo|#\d+);/i.test(text);
}

/** Décode le contenu d'une partie : base64url, puis jeu de caractères indiqué dans son en-tête. */
function decodeBody(part: Part): string {
  // Sans data (contenu très volumineux déplacé en pièce jointe par Gmail) : ignoré.
  if (!part.body?.data) return "";
  const bytes = Buffer.from(part.body.data, "base64url");
  const charset = /charset="?([^";\s]+)"?/i.exec(header(part, "Content-Type"))?.[1] ?? "utf-8";
  // Certains expéditeurs annoncent ISO-8859-1 mais envoient de l'UTF-8 (« PrÃ©-Bois »).
  // Une suite d'octets non-ASCII valide en UTF-8 n'arrive quasiment jamais par hasard :
  // si c'est le cas, on la décode en UTF-8.
  const validUtf8 = tryDecode("utf-8", bytes, true);
  if (validUtf8 !== null && /[^\x00-\x7f]/.test(validUtf8)) return validUtf8;
  return tryDecode(charset, bytes, false) ?? new TextDecoder("utf-8").decode(bytes);
}

/** Décode, ou renvoie null si le jeu de caractères est inconnu (ou les octets invalides en mode strict). */
function tryDecode(charset: string, bytes: Buffer, fatal: boolean): string | null {
  try {
    return new TextDecoder(charset, { fatal }).decode(bytes);
  } catch {
    return null;
  }
}

function htmlToText(html: string): string {
  return convert(html, {
    wordwrap: false,
    selectors: [
      { selector: "img", format: "skip" },
      // Liens gardés sous la forme « texte [url] » (utile pour le lien de l'offre).
      { selector: "a", options: { hideLinkHrefIfSameAsText: true } },
    ],
  });
}

/** Au-delà, une URL est un lien de suivi illisible : raccourcie à son domaine. */
const MAX_URL_LENGTH = 100;

/** Normalise les espaces et les lignes vides, raccourcit les URLs de suivi. */
function clean(text: string): string {
  return normalize(
    text.replace(/https?:\/\/[^\s<>\[\]"]+/g, (url) =>
      url.length > MAX_URL_LENGTH ? `${new URL(url).origin}/…` : url,
    ),
  );
}

/** Texte de la partie HTML avec les liens complets (« texte [url] ») : pour lire les alertes d'offres. */
export function htmlTextWithLinks(message: gmail_v1.Schema$Message): string {
  return normalize(htmlToText(mailHtml(message)));
}

function normalize(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[​-‍͏﻿­]/g, "") // caractères invisibles des mails marketing
    .replace(/ /g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function header(part: Part, name: string): string {
  return part.headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";
}
