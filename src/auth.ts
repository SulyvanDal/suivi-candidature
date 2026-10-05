// Authentification OAuth2 auprès de Google pour lire Gmail.
//
// Vue d'ensemble :
// - Premier lancement : on ouvre le navigateur sur la page de consentement Google,
//   on récupère un « code d'autorisation » via un mini serveur local, puis on
//   l'échange contre des jetons qu'on enregistre dans secrets/token.json.
// - Lancements suivants : on recharge les jetons. Le refresh token permet d'obtenir
//   de nouveaux access tokens sans repasser par le navigateur.

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { CodeChallengeMethod, OAuth2Client, type Credentials } from "google-auth-library";

// Lecture seule des mails, et rien d'autre.
const SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"];

const CREDENTIALS_PATH = "secrets/credentials.json";
const TOKEN_PATH = "secrets/token.json";

// Délai laissé pour accepter l'autorisation dans le navigateur.
const CONSENT_TIMEOUT_MS = 5 * 60 * 1000;

/** Renvoie un client OAuth2 prêt à appeler les API Google. */
export async function getAuthorizedClient(): Promise<OAuth2Client> {
  const { clientId, clientSecret } = await readClientCredentials();

  const saved = await readSavedTokens();
  if (saved) {
    // Étape A : des jetons existent déjà → pas de navigateur.
    const client = new OAuth2Client({ clientId, clientSecret });
    client.setCredentials(saved);
    persistRefreshedTokens(client);

    try {
      // getAccessToken() renvoie l'access token en cours, ou en obtient un nouveau
      // auprès de Google grâce au refresh token s'il a expiré (durée de vie ≈ 1 h).
      // On l'appelle ici pour détecter tout de suite un refresh token invalide.
      await client.getAccessToken();
      return client;
    } catch (err) {
      // « invalid_grant » : Google refuse le refresh token (7 jours écoulés en mode
      // test, accès révoqué, mot de passe changé…). Seule solution : redemander
      // l'autorisation.
      if (!isInvalidGrant(err)) throw err;
      console.log("Autorisation expirée ou révoquée : nouvelle autorisation nécessaire.");
      await rm(TOKEN_PATH, { force: true });
    }
  }

  // Étape B : aucun jeton utilisable → flux d'autorisation complet.
  return authorizeInBrowser(clientId, clientSecret);
}

/** Flux d'autorisation complet, avec le navigateur. */
async function authorizeInBrowser(clientId: string, clientSecret: string): Promise<OAuth2Client> {
  // 1. Mini serveur HTTP local qui recevra la redirection de Google.
  //    Port 0 = le système choisit un port libre. Les clients « Application de
  //    bureau » acceptent n'importe quel port sur 127.0.0.1.
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const redirectUri = `http://127.0.0.1:${port}`;

  try {
    const client = new OAuth2Client({ clientId, clientSecret, redirectUri });

    // 2. PKCE : on génère un secret aléatoire (codeVerifier) qui reste ici, et on
    //    n'envoie à Google que son empreinte SHA-256 (codeChallenge). Au moment de
    //    l'échange du code (étape 6), on devra présenter le secret d'origine : un
    //    tiers qui intercepterait le code ne pourrait donc rien en faire.
    const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();

    // 3. state : valeur aléatoire que Google nous renverra telle quelle. On vérifie
    //    au retour qu'elle correspond, pour rejeter une redirection qui ne vient
    //    pas de la demande qu'on vient de lancer.
    const state = randomBytes(16).toString("hex");

    // 4. URL de la page de consentement Google.
    const authUrl = client.generateAuthUrl({
      scope: SCOPES,
      access_type: "offline", // demande un refresh token, en plus de l'access token
      prompt: "consent", // force l'affichage du consentement → refresh token garanti
      state,
      code_challenge_method: CodeChallengeMethod.S256,
      code_challenge: codeChallenge,
    });

    // 5. Ouverture du navigateur, puis attente de la redirection de Google
    //    vers http://127.0.0.1:<port>/?code=…&state=…
    const codePromise = waitForAuthorizationCode(server, state);
    openInBrowser(authUrl);
    console.log("Autorisation demandée dans le navigateur. En attente de ta réponse…");
    const code = await codePromise;

    // 6. Échange du code d'autorisation (+ secret PKCE) contre les jetons :
    //    - access_token  : sert aux appels à l'API, valable environ 1 h ;
    //    - refresh_token : sert à obtenir de nouveaux access tokens sans navigateur.
    const { tokens } = await client.getToken({ code, codeVerifier });
    if (!tokens.refresh_token) {
      throw new Error("Google n'a pas renvoyé de refresh token : relance le script.");
    }

    // 7. On enregistre les jetons pour les prochains lancements.
    client.setCredentials(tokens);
    await saveTokens(tokens);
    persistRefreshedTokens(client);
    console.log("Autorisation enregistrée.");
    return client;
  } finally {
    server.close();
  }
}

/** Attend la requête de redirection de Google et en extrait le code d'autorisation. */
function waitForAuthorizationCode(
  server: ReturnType<typeof createServer>,
  expectedState: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Délai dépassé : aucune autorisation reçue.")),
      CONSENT_TIMEOUT_MS,
    );

    server.on("request", (req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      // Le navigateur peut aussi demander /favicon.ico : on l'ignore.
      if (url.pathname !== "/") {
        res.writeHead(404).end();
        return;
      }

      const finish = (message: string) => {
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" }).end(message);
        clearTimeout(timer);
      };

      // Refus de l'utilisateur, ou autre erreur côté Google.
      const error = url.searchParams.get("error");
      if (error) {
        finish("Autorisation refusée. Tu peux fermer cet onglet.");
        reject(new Error(`Autorisation refusée par Google (${error}).`));
        return;
      }

      if (url.searchParams.get("state") !== expectedState) {
        finish("Réponse invalide. Tu peux fermer cet onglet.");
        reject(new Error("Paramètre state inattendu : réponse rejetée."));
        return;
      }

      const code = url.searchParams.get("code");
      if (!code) {
        finish("Réponse incomplète. Tu peux fermer cet onglet.");
        reject(new Error("Aucun code d'autorisation dans la réponse de Google."));
        return;
      }

      finish("Autorisation reçue. Tu peux fermer cet onglet et revenir au terminal.");
      resolve(code);
    });
  });
}

/**
 * Quand la bibliothèque renouvelle l'access token, elle émet l'événement « tokens ».
 * On fusionne avec les jetons existants (Google ne renvoie généralement pas le
 * refresh token lors d'un renouvellement) et on réécrit le fichier.
 */
function persistRefreshedTokens(client: OAuth2Client): void {
  client.on("tokens", (tokens) => {
    saveTokens({ ...client.credentials, ...tokens }).catch((err) => {
      console.error("Impossible d'enregistrer les jetons renouvelés :", err.message);
    });
  });
}

/** Ouvre l'URL dans le navigateur par défaut (macOS) ; l'affiche seulement en cas d'échec. */
function openInBrowser(url: string): void {
  execFile("open", [url], (err) => {
    if (err) {
      console.log("Impossible d'ouvrir le navigateur. Ouvre cette adresse manuellement :");
      console.log(url);
    }
  });
}

/** Lit l'identifiant et le secret du client OAuth téléchargés depuis la console Google. */
async function readClientCredentials(): Promise<{ clientId: string; clientSecret: string }> {
  let raw: string;
  try {
    raw = await readFile(CREDENTIALS_PATH, "utf8");
  } catch {
    throw new Error(`Fichier ${CREDENTIALS_PATH} introuvable : voir le README.`);
  }
  // Le fichier d'un client « Application de bureau » a la forme { "installed": { … } }.
  const { installed } = JSON.parse(raw);
  if (!installed?.client_id || !installed?.client_secret) {
    throw new Error(
      `${CREDENTIALS_PATH} ne ressemble pas à un client « Application de bureau ».`,
    );
  }
  return { clientId: installed.client_id, clientSecret: installed.client_secret };
}

async function readSavedTokens(): Promise<Credentials | null> {
  try {
    return JSON.parse(await readFile(TOKEN_PATH, "utf8"));
  } catch {
    return null;
  }
}

/** Écrit les jetons avec les droits 600 : lisibles et modifiables par toi seul. */
async function saveTokens(tokens: Credentials): Promise<void> {
  await mkdir("secrets", { recursive: true });
  await writeFile(TOKEN_PATH, JSON.stringify(tokens, null, 2), { mode: 0o600 });
}

function isInvalidGrant(err: unknown): boolean {
  const e = err as { message?: string; response?: { data?: { error?: string } } };
  return e?.response?.data?.error === "invalid_grant" || e?.message === "invalid_grant";
}
