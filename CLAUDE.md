# CLAUDE.md

Instructions pour Claude Code sur ce dépôt.

## Projet

Outil personnel de suivi de candidatures, alimenté par les mails reçus sur Gmail.

Cible à terme :
```
Gmail (nouveaux mails) → filtrage → extraction du texte → API Claude (classement / extraction) → base de données
```

Besoin fonctionnel (champs, statuts, mails pris en compte, premier passage depuis le
01/06/2026, consultation) : [docs/fiche-fonctionnelle.md](docs/fiche-fonctionnelle.md).
S'y référer avant toute issue qui touche au fonctionnel.

## Phase actuelle : prototype d'accès Gmail (jetable)

Seul objectif : prouver que du code TypeScript peut s'authentifier sur le compte Gmail
de l'utilisateur et lister les mails reçus au cours des dernières 24 h.

Critères de réussite :
- Une commande dans le terminal affiche, pour chaque mail des dernières 24 h :
  identifiant, date, expéditeur, objet.
- Une seconde exécution ne redemande pas l'autorisation.

Hors périmètre de cette phase : base de données, appel à l'API Claude, interface,
lecture du corps des mails.

## Commandes

- `npm run list` : liste les mails des dernières 24 h (lance l'autorisation si nécessaire).
- `npm test` : tests automatiques (`node:test`, fichiers `src/**/*.test.ts`).
- `npm run typecheck` : vérification des types.

## Contraintes

- TypeScript sur Node.js.
- Bibliothèques **officielles de Google uniquement** pour l'accès à Gmail
  (`google-auth-library`, `@googleapis/gmail`).
- Permission OAuth : `https://www.googleapis.com/auth/gmail.readonly`, rien d'autre.
  (`gmail.metadata` serait plus restreint mais interdit le paramètre de recherche `q`.)
- Appels Gmail en `format: "metadata"` uniquement : ne jamais télécharger le corps des mails
  pendant cette phase.
- Identifiants et jetons dans `secrets/` (exclu de git) :
  - `secrets/credentials.json` : identifiant client OAuth, déposé par l'utilisateur ;
  - `secrets/token.json` : jetons générés par le script, droits `600`.
- Ne jamais afficher un secret ou un jeton dans la console, ni l'écrire dans le code.
- Code minimal et lisible. **Commenter chaque étape de l'authentification** :
  l'utilisateur veut comprendre le flux.

## Façon de travailler

- Le travail est découpé en **petits blocs = une issue GitHub chacun**, regroupés par
  feature dans des milestones (voir la [feuille de route](#feuille-de-route)).
  Traiter une issue à la fois, dans l'ordre des dépendances indiquées.
- Avant d'écrire du code pour une issue, expliquer l'approche et
  **attendre la validation de l'utilisateur**.
- Les commits référencent l'issue concernée (`Refs #4`, ou `Closes #4` quand elle est terminée).
- Label `pour moi` : tâche ou décision de l'utilisateur. Label `code` : développement.
- Répartition :
  - l'utilisateur gère la console Google Cloud (projet, activation de l'API,
    écran de consentement, création des identifiants) ;
  - Claude écrit le code, la documentation et indique où déposer les fichiers.
- Échanges en français.

## Choix techniques retenus

- Client OAuth de type **Application de bureau** ; redirection vers `http://127.0.0.1:<port libre>`.
- Flux implémenté directement avec `google-auth-library` (pas `@google-cloud/local-auth`,
  qui masque le flux) : serveur local de redirection, PKCE, vérification de `state`,
  `access_type=offline`.
- Si `token.json` existe, la bibliothèque rafraîchit l'access token toute seule ; en cas de
  `invalid_grant`, supprimer le jeton et relancer le flux avec un message explicite.
- Filtre des 24 h : `q = "after:<horodatage Unix>"`, avec pagination.
- Module d'authentification (`src/auth.ts`) écrit pour être réutilisé par l'application complète.
- Exécution TypeScript via `tsx`.
- Base locale : `node:sqlite` (intégré à Node), fichier `data/suivi.db` (exclu de git),
  module `src/db.ts`. Le schéma évolue par migrations versionnées avec `PRAGMA user_version` :
  ne jamais modifier une migration livrée, en ajouter une à la fin.
- L'URL d'autorisation est ouverte dans le navigateur (commande macOS `open`) ; elle n'est
  affichée dans le terminal que si l'ouverture échoue.

## Limites connues

- Application en mode **Test** : le refresh token expire au bout de **7 jours**.
- Usage personnel (< 100 utilisateurs) : pas de validation Google ni d'audit nécessaire.
  Pour l'application complète, envisager le passage **En production sans validation**,
  qui supprime l'expiration des 7 jours (à vérifier dans la console le moment venu).

## Feuille de route

Suivie dans les issues GitHub (`gh issue list`) :

1. Spécification : #1 fiche fonctionnelle (terminée)
2. Accès Gmail durable : #2 constater l'expiration en mode Test, #3 passer En production
3. Synchronisation : #4 stockage SQLite, #5 synchronisation incrémentale (`historyId`)
4. Extraction du texte : #6 corps des mails → texte, #7 pré-filtre
5. Analyse par Claude : #8 classification, #9 extraction structurée, #10 rattachement aux candidatures
6. Restitution et automatisation : #11 tableau dans le terminal, #12 exécution quotidienne (`launchd`),
   #13 interface avec édition manuelle
