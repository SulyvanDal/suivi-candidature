// Lance une synchronisation : chaque nouveau mail est extrait, pré-filtré, puis classé par
// Claude s'il est gardé ; le résultat est enregistré en base, puis les candidatures sont recalculées.
//
//   npm run sync           mode manuel : détail des mails, autorisation dans le navigateur si besoin
//   npm run sync -- --auto mode automatique (#12, lancé par launchd) : jamais de navigateur,
//                          plafond de mails envoyés à Claude, journal sans contenu de mail,
//                          notification macOS en cas de problème uniquement (pas pour une absence
//                          de réseau : launchd réessaie à l'heure suivante)
//
// Codes de sortie : 0 terminé, 1 erreur, 2 autorisation à renouveler, 3 plafond atteint, 4 pas de réseau.

import { gmail } from "@googleapis/gmail";
import { AuthorizationRequiredError, getAuthorizedClient } from "./auth.js";
import { DailyBudgetReachedError, withBudget } from "./budget.js";
import { rebuildCandidatures } from "./candidatures.js";
import { classifyMail, createClient, MODEL } from "./classify.js";
import { openDb } from "./db.js";
import { notify } from "./notify.js";
import { readPendingPages } from "./offer-page.js";
import { processMessage, type ProcessedMail } from "./pipeline.js";
import { isOffline } from "./retry.js";
import { fetchFullMessage, gmailSource, syncNewMessages } from "./sync.js";

// Coût de Claude Haiku 4.5, en dollars par million de jetons (entrée / sortie).
const PRICE_PER_MTOK = { input: 1, output: 5 };
/** Plafond quotidien en mode automatique (décision utilisateur : 50 mails, ~0,15 $ au plus). */
const DAILY_CLAUDE_LIMIT = 50;

const auto = process.argv.includes("--auto");
const stamp = () => new Date().toLocaleString("fr-FR", { timeZone: "Europe/Paris" });
const NOTIFY_TITLE = "Suivi de candidatures";

async function main(): Promise<number> {
  const api = gmail({ version: "v1", auth: await getAuthorizedClient({ interactive: !auto }) });
  const claude = createClient();
  const db = openDb();
  const budget = withBudget(classifyMail, auto ? DAILY_CLAUDE_LIMIT : Infinity);

  const processed: ProcessedMail[] = [];
  const tokens = { input: 0, output: 0 };
  let mode = "interrompue";
  let gone: string[] = [];
  let budgetReached = false;

  try {
    try {
      ({ mode, gone } = await syncNewMessages(db, gmailSource(api), async (id) => {
        const p = await processMessage(id, {
          db,
          model: MODEL,
          fetchMessage: (messageId) => fetchFullMessage(api, messageId),
          classify: (mail) => budget.call(claude, mail),
        });
        processed.push(p);
        if (p.result) {
          tokens.input += p.result.usage.inputTokens;
          tokens.output += p.result.usage.outputTokens;
          if (p.result.truncated && !auto) console.log(`  (texte coupé à l'envoi : ${p.mail.id} « ${p.mail.subject} »)`);
        }
        if (!auto && processed.length % 50 === 0) console.log(`  … ${processed.length} mails traités`);
      }));
    } catch (err) {
      // Plafond atteint : on garde ce qui a été traité, le reste attend la prochaine synchronisation.
      if (!(err instanceof DailyBudgetReachedError)) throw err;
      budgetReached = true;
    }

    // Pages des annonces gardées (#22), après les mails : un échec n'empêche pas leur traitement.
    if (!auto) console.log("Lecture des pages d'annonce…");
    const pages = await readPendingPages(db);

    const kept = processed.filter((p) => p.result);
    const relevant = kept.filter((p) => p.result!.classification.type !== "hors_sujet");
    const cost = (tokens.input * PRICE_PER_MTOK.input + tokens.output * PRICE_PER_MTOK.output) / 1e6;
    const { candidatures } = rebuildCandidatures(db);
    const toCheck = candidatures.filter((c) => c.toCheck).length;
    const offers = { added: 0, kept: 0 };
    for (const p of processed) {
      offers.added += p.offers?.added ?? 0;
      offers.kept += p.offers?.kept ?? 0;
    }

    if (auto) {
      // Journal : uniquement des comptes (ni objets, ni expéditeurs, ni secrets).
      console.log(
        `${stamp()} · synchronisation ${mode} · ${processed.length} mail(s), ${kept.length} envoyé(s) à Claude, ` +
          `${relevant.length} lié(s) à une candidature · ${cost.toFixed(3)} $ · ${candidatures.length} candidature(s) · ` +
          `${offers.added} annonce(s), ${offers.kept} gardée(s) · ` +
          `pages : ${pages.read} lue(s), ${pages.unverified} non vérifiée(s), ${pages.retry} à réessayer` +
          (gone.length ? ` · ${gone.length} mail(s) disparu(s) ignoré(s)` : "") +
          (budgetReached ? " · PLAFOND ATTEINT" : ""),
      );
    } else {
      console.log(`\nSynchronisation ${mode} : ${processed.length} nouveau(x) mail(s).`);
      if (gone.length) console.log(`  ${gone.length} mail(s) supprimé(s) de Gmail entre-temps : ignoré(s).`);
      console.log(`  Pré-filtre : ${kept.length} gardé(s), ${processed.length - kept.length} écarté(s).`);
      console.log(`  Claude : ${relevant.length} lié(s) à une candidature, ${kept.length - relevant.length} hors sujet.`);
      console.log(`  Annonces des alertes : ${offers.added} nouvelle(s), ${offers.kept} gardée(s) par le filtre sur l'intitulé.`);
      console.log(
        `  Pages d'annonce : ${pages.read} lue(s), ${pages.unverified} non vérifiée(s)` +
          (pages.retry ? `, ${pages.retry} à réessayer plus tard` : "") +
          ".",
      );
      console.log(`  Coût estimé : ${cost.toFixed(3)} $ (${tokens.input} jetons en entrée, ${tokens.output} en sortie).`);
      if (relevant.length > 0) console.log("\nMails liés à une candidature :");
      for (const { mail, result } of relevant) {
        const date = mail.date.toLocaleDateString("fr-FR");
        console.log(`  ${date}  ${result!.classification.type.padEnd(20)} ${mail.from.slice(0, 35).padEnd(35)} | ${mail.subject}`);
      }
      console.log(`\n${candidatures.length} candidature(s) suivie(s)${toCheck ? `, ${toCheck} à vérifier` : ""} (détail : npm run ui).`);
    }

    if (budgetReached) {
      if (auto) {
        await notify(NOTIFY_TITLE, `Plafond de ${DAILY_CLAUDE_LIMIT} mails atteint : la suite sera traitée demain.`);
      }
      return 3;
    }
    return 0;
  } finally {
    db.close();
  }
}

try {
  process.exitCode = await main();
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof AuthorizationRequiredError) {
    console.log(`${stamp()} · ${message} Lancer « npm run sync » pour réautoriser.`);
    if (auto) await notify(NOTIFY_TITLE, "Autorisation Gmail expirée : lance « npm run sync » pour réautoriser.");
    process.exitCode = 2;
  } else if (isOffline(err)) {
    // Pas de réseau (Mac qui se réveille, en déplacement) : pas de notification, le mode automatique
    // réessaie à l'heure suivante.
    console.log(`${stamp()} · Pas de réseau : ${message}`);
    process.exitCode = 4;
  } else {
    console.log(`${stamp()} · Synchronisation échouée : ${message}`);
    if (auto) await notify(NOTIFY_TITLE, "Synchronisation échouée : voir le journal dans data/logs.");
    process.exitCode = 1;
  }
}
