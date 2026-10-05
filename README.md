# Suivi de candidatures

Outil personnel de suivi de candidatures, alimenté par les mails reçus sur Gmail.

> **État actuel : prototype.** Il sert uniquement à valider l'accès en lecture à Gmail
> depuis TypeScript.

## Objectif du prototype

Lancer une commande dans le terminal qui affiche, pour chaque mail reçu au cours des
dernières 24 h : identifiant, date, expéditeur, objet. Une seconde exécution ne doit pas
redemander l'autorisation.

Hors périmètre : base de données, API Claude, interface, lecture du corps des mails.

## Configuration côté Google Cloud

Sur https://console.cloud.google.com, connecté avec le compte Gmail à lire :

1. **Créer un projet** (par exemple `suivi-candidature`).
2. **Activer l'API Gmail** : *API et services → Bibliothèque → Gmail API → Activer*.
3. **Configurer l'écran de consentement** : *API et services → Écran de consentement OAuth*.
   Sur un projet neuf, Google indique que *Google Auth Platform* n'est pas encore
   configuré : cliquer sur **Commencer** et suivre l'assistant :
   - nom de l'application et e-mail d'assistance ;
   - audience **Externe** ;
   - coordonnées, acceptation des conditions, puis **Créer**.

   Le menu de gauche affiche ensuite *Présentation, Branding, Audience, Clients, Accès aux données* :
   - **Audience** : vérifier le statut **Test** et ajouter son adresse Gmail
     dans « Utilisateurs test » ;
   - **Accès aux données** : ajouter uniquement `https://www.googleapis.com/auth/gmail.readonly`.
4. **Créer l'identifiant client** : *Clients → Créer un client → Application de bureau*
   (nom libre, par exemple `suivi-candidature-cli`). Ne pas passer par le bouton
   « Créer des identifiants » de la page de l'API Gmail, qui ouvre un ancien assistant.
   Télécharger le JSON **immédiatement** : le code secret n'est visible qu'à la création.
5. **Déposer le fichier** ici : `secrets/credentials.json`, puis le protéger :
   `chmod 600 secrets/credentials.json`.

Le dossier `secrets/` est exclu de git. Il contiendra aussi `token.json`, généré au premier lancement.

## Lancement

Prérequis : Node.js et le fichier `secrets/credentials.json` (voir ci-dessus).

```sh
npm install
npm run list
```

- **Premier lancement** : le navigateur s'ouvre sur la page d'autorisation Google.
  Choisis ton compte, clique sur *Continuer* malgré l'avertissement « application non
  validée », puis accepte la lecture des mails. Reviens ensuite au terminal.
- **Lancements suivants** : la liste s'affiche directement.

Exemple de sortie (une ligne par mail : identifiant, date de réception, expéditeur, objet) :

```
19a2b3c4d5e6f7a8  03/10/2026 14:12:05  Jane Doe <jane@exemple.com>  Votre candidature
```

Pour forcer une nouvelle autorisation, supprime `secrets/token.json`.

Fichiers :
- [src/auth.ts](src/auth.ts) : flux OAuth2 commenté étape par étape ;
- [src/list-recent.ts](src/list-recent.ts) : lecture et affichage des mails.

Vérification des types : `npm run typecheck`.

## Fonctionnement de l'authentification

**Premier lancement :**
1. Lecture de `secrets/credentials.json`.
2. Démarrage d'un mini serveur local sur `127.0.0.1` pour recevoir la réponse de Google.
3. Ouverture du navigateur sur la page d'autorisation Google (protégée par PKCE et `state`).
4. Après acceptation (l'avertissement « application non validée » est normal en mode test),
   Google renvoie un code au serveur local.
5. Le code est échangé contre un access token (≈ 1 h) et un refresh token (durable).
6. Les jetons sont enregistrés dans `secrets/token.json` (lisible par le seul propriétaire).

**Lancements suivants :** le refresh token sert à obtenir un nouvel access token
sans passer par le navigateur.

## Limites

- **Mode test** : le refresh token expire au bout de **7 jours**. Il faut alors refaire
  l'autorisation dans le navigateur.
- **Pas d'audit nécessaire** pour un usage personnel (moins de 100 utilisateurs). Passer
  l'application **En production sans validation** devrait supprimer la limite des 7 jours.
- Le refresh token est aussi invalidé en cas de révocation de l'accès, de changement de
  mot de passe, de 6 mois sans utilisation, ou au-delà de 100 jetons émis pour ce client.

## Suite prévue

```
Gmail (nouveaux mails) → filtrage → extraction du texte → API Claude (classement / extraction) → base de données
```
