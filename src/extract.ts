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
  /** Date de réception par Gmail. */
  date: Date;
  from: string;
  to: string;
  subject: string;
  text: string;
}

/** En dessous, une version text/plain est jugée trop pauvre et on préfère le HTML. */
const MIN_PLAIN_LENGTH = 200;

export function extractMail(message: gmail_v1.Schema$Message): ExtractedMail {
  const payload = message.payload ?? {};
  return {
    id: message.id ?? "",
    date: new Date(Number(message.internalDate)),
    from: header(payload, "From"),
    to: header(payload, "To"),
    subject: header(payload, "Subject"),
    text: clean(partText(payload)),
  };
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
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    // Jeu de caractères inconnu : UTF-8 par défaut.
    return new TextDecoder("utf-8").decode(bytes);
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
  return text
    .replace(/https?:\/\/[^\s<>\[\]"]+/g, (url) =>
      url.length > MAX_URL_LENGTH ? `${new URL(url).origin}/…` : url,
    )
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
