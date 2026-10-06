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
- `npm run sync` : synchronisation incrémentale (premier passage depuis le 01/06/2026, puis
  `historyId`) : extraction, pré-filtre, classification par Claude, enregistrement ; affiche
  le bilan, le coût et les mails liés à une candidature. Appelle Claude (payant).
- `npm run extract -- <id>` : affiche le texte extrait d'un mail.
- `npm run filter -- --days 14` : simulation du pré-filtre (décision et règle par mail), sans
  rien écrire ni envoyer.
- `npm run offres:simuler -- --days 14` : simulation de la veille des offres (#20) : annonces des
  alertes, filtre sur l'intitulé, lecture des pages, coût estimé. Sans Claude ; ouvre les liens de
  suivi des plateformes (comptés comme des clics).
- `npm run eval:offres` : évalue le tri des annonces sur le jeu annoté (appelle Claude, ~0,17 $).
- `npm run eval:classify` : évalue la classification et l'extraction sur le jeu annoté
  (appelle Claude, ~0,18 $).
- `npm run reanalyse` : repasse à Claude les mails déjà gardés par le pré-filtre et met la base
  à jour (appelle Claude, ~0,55 $). **Toujours demander confirmation avant toute commande payante.**
  Seule exception autorisée par l'utilisateur (05/10/2026) : la synchronisation automatique
  quotidienne (#12, `sync -- --auto`), plafonnée à 50 mails envoyés à Claude par jour.
- `npm run auto:installer` / `auto:desinstaller` / `auto:statut` : synchronisation automatique
  quotidienne via launchd (#12), lancée par l'utilisateur. Journaux : `data/logs/` (comptes uniquement).
- `npm run ui` : interface web locale sur http://127.0.0.1:4321 (gratuit, lecture seule de la base).
- `npm run candidatures` : recalcule les candidatures et les affiche (gratuit, n'appelle pas Claude).
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
- Synchronisation (`src/sync.ts`) : historyId lu avant le listing initial ; un mail n'est marqué
  traité qu'après succès, le historyId n'est enregistré qu'en fin de passage ; 404 sur
  `history.list` → rattrapage par date (dernière synchro − 1 jour). Spams, corbeille et
  brouillons exclus, mails envoyés gardés. Gmail est injecté (`MailSource`) pour les tests.
- Extraction du texte (`src/extract.ts`, `html-to-text`) : `text/plain` préféré sauf s'il fait
  moins de 200 caractères ; HTML glissé dans `text/plain` par certains ATS converti ; URLs de plus
  de 100 caractères (liens de suivi) raccourcies à leur domaine ; `multipart/report` (mail non
  distribué) réduit à sa première partie. Citations des réponses conservées (à traiter dans #8).
  Tests sur des mails fabriqués uniquement : ne jamais commiter de vrais mails.
- Pré-filtre (`src/filter.ts`, règles dans `src/filter-rules.ts`) : exclusions nommées
  (`non-distribue`, `offre-fermee`, `alerte-offres`) puis mots-clés en mots entiers, accents
  significatifs (« poste » ≠ « posté »). **Pas de liste d'expéditeurs à maintenir** (décision
  utilisateur) : objet et contenu uniquement. En cas de doute on garde, Claude triera.
- Tous les appels Gmail passent par `withRetry` (`src/retry.ts`) : le quota « unités par minute
  par utilisateur » est vite atteint (constaté avec 10 téléchargements en parallèle).
- Classification (`src/classify.ts`) : **Claude Haiku 4.5** (choix utilisateur, coût), sortie
  structurée zod, types `candidature_envoyee | entretien | offre | refus | autre | hors_sujet`.
  Citations retirées et texte plafonné à 8 000 caractères avant envoi. Clé dans
  `secrets/anthropic-api-key`. Résultats dans la table `mail_results` (règle du pré-filtre + type).
- Extraction (#9, même appel) : entreprise (jamais la plateforme ni l'ATS), poste, lieu, canal,
  lien de l'offre ; null si absent, jamais deviné. Garde-fous dans `sanitize` : rien pour un mail
  hors sujet, lien gardé seulement s'il figure en entier dans le texte envoyé.
- Évaluation : `npm run eval:classify` sur `data/annotations-classification.json` (hors git,
  annoté avec l'utilisateur, 68 mails) : type 67/68, entreprise 35/36, poste 30/30, lieu 18/18,
  canal 5/5. Erreurs restantes : approche LinkedIn d'une recruteuse classée `entretien`, Hays
  (cabinet) sans entreprise.
  Ne pas sur-ajuster le prompt sur quelques mails : préférer une règle en aval (#10) ou #15.
- Candidatures (`src/candidatures.ts`, #10) : **recalculées entièrement** à partir des événements
  à chaque sync (tables `candidatures` et `mail_links`), identifiant stable = gmail_id du premier
  mail. Rattachement : même fil Gmail → même entreprise + même poste (noms rapprochés, de
  préférence candidature en cours ; entreprise inconnue → intitulé identique exigé) → sinon
  création (sauf `autre`, non rattaché). Nouvel envoi après refus = nouvelle candidature.
  Corrections manuelles (table `corrections`, jamais effacée, relue à chaque recalcul ; la plus
  récente par mail l'emporte) : `creer` (le mail compte comme un envoi), `rattacher` (forcé, même
  vers une candidature créée plus tard), `ignorer`, écrites depuis la page « À classer » (#17) ;
  `champ`, `statut` (option A : vaut jusqu'au prochain mail qui change le statut),
  `pas_candidature`, écrites depuis la page d'une candidature (#18). Annulation = suppression de
  la ligne, depuis la page « Corrections ». Fusion et retrait d'un mail : reportés (#19).
  Principe utilisateur : ne développer que ce qui sert maintenant, noter le reste en issue.
- Synchronisation automatique (#12) : launchd **toutes les heures** → `scripts/sync-auto.sh 8` →
  `sync-run.ts --auto`. Le script ne fait qu'une synchronisation par jour à partir de 8 h (marqueur
  `data/logs/.terminee-<date>`) ; seule l'absence de réseau (code 4, `isOffline`, sans notification)
  mène à un nouvel essai l'heure suivante (Mac au réveil, en vacances). Jamais de navigateur
  (`AuthorizationRequiredError`), plafond par jour (`src/budget.ts`, le reste attend le lendemain
  grâce à la reprise de #5), journal sans contenu de mail, notification macOS **uniquement en cas de
  problème** (autorisation expirée, plafond, erreur). Node via le lien stable Homebrew `opt/node/bin`.
  L'interface affiche la date de la dernière synchronisation complète (`sync_state.last_sync_at`).
- Interface (`src/ui/`, #13 découpée en #16 consultation, #17 À classer, #18 édition) :
  **Hono + HTML généré côté serveur + htmx** (choix utilisateur ; migration vers React possible
  plus tard). `app.ts` (routes, testable via `app.request` sans serveur), `queries.ts` (lectures,
  statut « Sans réponse » calculé à l'affichage : Envoyée + rien depuis 21 jours), `views.ts`
  (gabarit `html` de Hono, échappement automatique), `server.ts` (127.0.0.1 uniquement).
  htmx servi depuis node_modules : aucune ressource chargée depuis Internet. Écritures protégées
  par le middleware CSRF de Hono (formulaires acceptés seulement depuis l'interface). Style validé par
  l'utilisateur : doux et chaleureux (beige, sauge, terracotta), polices Apple, liste aérée.
- Veille des offres (fiche [docs/fiche-offres.md](docs/fiche-offres.md), milestone 8) : pendant la
  synchronisation, les alertes `alerte-offres` d'une plateforme connue (`src/offers.ts` : Hellowork,
  Indeed, Welcome to the Jungle, reconnues à l'expéditeur pour choisir l'extracteur ; Job Watch
  ignoré) donnent des annonces, lues dans le HTML avec les liens complets (`htmlTextWithLinks`).
  Table `offers` : doublons (intitulé + entreprise sans casse ni accents) jamais réenregistrés,
  annonces écartées gardées (compteur, doublons). Filtre sur l'intitulé « garder + exclure » (mots
  entiers, accents ignorés, `*` en fin de mot), listes dans `offer_terms`. Pages (#22,
  `src/offer-page.ts`) lues en fin de synchronisation, une par seconde (403 en rafale) : seule la
  description des données schema.org `JobPosting` (Hellowork écrit `ld&#x2B;json`), jamais la page
  entière ; échec définitif → `non_verifiee` (403 Indeed, offre expirée, annonce APEC relayée ; pas
  de traitement spécial des expirées, décision utilisateur), passager → retenté. Tri (#23,
  `src/offer-judge.ts`) : **Claude extrait, le code décide** (Haiku comparait mal les durées :
  35-37/53 en le laissant juger, 50/53 ainsi). Faits : type de poste, expérience minimale chiffrée,
  poste explicitement senior, techno de niche ; `decide` compare au plafond (4 ans produit/projet,
  2 ans développeur, égalité gardée, réglages `plafond_*`), « confirmé » sans durée gardé. Profil
  du candidat dans `settings` (jamais dans le code), 100 annonces jugées par jour au plus, sur la
  journée entière. Champ `experienceRequirements` ignoré (Hellowork y met « 12 mois » par défaut).
  Page « Offres à regarder » (#24, `/offres`, bouton dans l'en-tête avec le nombre de nouvelles) :
  annonces gardées par Claude + non vérifiées, sans les ignorées ; « Consulter » (formulaire
  `target=_blank` → `seen_at`, redirection vers `page_url` sinon le lien de suivi, http(s) seulement),
  « Ignorer » (`ignored_at`) ; compteurs des écartées sur 7 jours et des annonces en cours de tri.
  Suite : #25 édition des listes, du profil et des plafonds.
- `data/suivi.db` contient les **vraies données** depuis le premier passage du 05/10/2026
  (1 419 mails, 246 envoyés à Claude, 94 liés à une candidature, 0,49 $).
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
6. Restitution et automatisation : #11 tableau dans le terminal (abandonné, couvert par
   `npm run candidatures`), #12 exécution quotidienne (`launchd`), #13 interface : #16 consultation,
   #17 mails à classer, #18 édition
7. Améliorations : #14 marquer les offres fermées (mails Hellowork « n'est plus disponible »),
   #15 listes d'expéditeurs bloqués / toujours gardés, gérées depuis l'interface (en base, pas dans le code),
   #19 fusionner / détacher
8. Veille des offres : #20 fiche (terminée), #21 extraction et stockage des annonces, #22 description
   de la page, #23 filtre par Claude, #24 page « Offres à regarder », #25 édition des listes
