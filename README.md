# Suivi de candidatures

Outil personnel qui tient à jour le suivi de mes candidatures à partir de mes mails Gmail,
et trie les annonces reçues dans mes alertes d'offres d'emploi.

```
Gmail → pré-filtre → texte du mail → Claude (classement, extraction) → base SQLite → interface web
                   ↘ alertes d'offres → annonces → filtre sur l'intitulé → page de l'annonce → Claude (tri)
```

Tout tourne en local sur un Mac : la base reste sur la machine, seuls les mails retenus par le
pré-filtre et les annonces à trier sont envoyés à l'API Claude.

## Ce que fait l'outil

**Candidatures**
- Lit les mails reçus et envoyés depuis le 1er juin 2026, puis uniquement les nouveaux.
- Écarte sans frais les mails sans rapport (alertes, newsletters, mails non distribués…) par un
  pré-filtre sur l'objet et le contenu.
- Fait classer les autres par Claude : candidature envoyée, entretien, offre, refus, autre
  échange, hors sujet ; et en extrait l'entreprise, le poste, le lieu, le canal, le lien de l'offre.
- Regroupe les mails en candidatures (entreprise + poste) avec leur statut : Envoyée, Entretien,
  Offre, Refus, et « Sans réponse » après 3 semaines sans nouvelles.

**Veille des offres**
- Extrait les annonces des alertes Hellowork, Indeed et Welcome to the Jungle (doublons ignorés).
- Garde celles dont l'intitulé contient un poste recherché et aucun mot exclu.
- Lit la description sur la page de l'annonce (Indeed bloque la lecture : annonce « non vérifiée »).
- Fait relever par Claude le type de poste, l'expérience minimale demandée, un éventuel profil
  senior ou une technologie de niche ; le code décide ensuite avec mes plafonds d'expérience.
- Propose une priorité (1 ou 2) en comptant des points : poste orienté data / IA, stack proche,
  type d'employeur, culture IA, Bordeaux, taille de l'entreprise, secteur.

**Interface** (http://127.0.0.1:4321)
- *Mes candidatures* : liste filtrable par statut, fiche de chaque candidature avec ses mails,
  corrections à la main (champs, statut, « ce n'est pas une candidature »), date de la dernière
  synchronisation.
- *À classer* : mails liés à une démarche mais sans candidature reconnue (créer, rattacher, ignorer).
- *Corrections* : historique des corrections manuelles, annulables.
- *Offres à regarder* : annonces retenues avec la justification de Claude, pastilles « nouveau »,
  « non vérifiée » et « prio » (détail des points au survol), étoile pour les marquer prioritaires à
  la main (elles passent en tête), boutons Consulter et Ignorer.
- *Réglages des offres* : postes recherchés, mots exclus, profil envoyé à Claude, plafonds
  d'expérience.

**Automatisation** : une synchronisation par jour, à 8 h ou au réveil du Mac, avec un nouvel
essai toutes les heures en l'absence de réseau. Notification macOS uniquement en cas de problème.

## Installation

Prérequis : macOS, Node.js (avec le module intégré `node:sqlite`), un compte Gmail, une clé
d'API Anthropic.

```sh
npm install
```

### 1. Accès à Gmail (console Google Cloud)

Sur https://console.cloud.google.com, connecté avec le compte Gmail à lire :

1. **Créer un projet** (par exemple `suivi-candidature`).
2. **Activer l'API Gmail** : *API et services → Bibliothèque → Gmail API → Activer*.
3. **Configurer l'écran de consentement** : *Google Auth Platform* → **Commencer** :
   nom de l'application, e-mail d'assistance, audience **Externe**, puis **Créer**. Ensuite :
   - **Accès aux données** : ajouter uniquement `https://www.googleapis.com/auth/gmail.readonly` ;
   - **Audience** : publier l'application (**En production**) sans demander de validation.
     En mode **Test**, l'autorisation expire au bout de 7 jours (voir [Limites](#limites)).
4. **Créer l'identifiant client** : *Clients → Créer un client → Application de bureau*.
   Télécharger le JSON **immédiatement** : le code secret n'est visible qu'à la création.
5. **Déposer le fichier** : `secrets/credentials.json`, puis `chmod 600 secrets/credentials.json`.

### 2. Clé d'API Anthropic

Déposer la clé seule dans `secrets/anthropic-api-key`, puis `chmod 600 secrets/anthropic-api-key`.

Le dossier `secrets/` est exclu de git ; il contiendra aussi `token.json`, créé à la première
autorisation. Aucun secret n'est jamais affiché dans le terminal.

### 3. Première autorisation et premier passage

```sh
npm run list   # ouvre le navigateur pour autoriser la lecture de Gmail, puis liste les mails des 24 h
npm run sync   # premier passage depuis le 1er juin 2026 (payant, voir Coûts)
npm run ui     # interface sur http://127.0.0.1:4321
```

À la première autorisation, Google affiche « application non validée » : *Paramètres avancés →
Accéder à … (non sécurisé)*, puis accepter la lecture des mails. C'est normal pour une
application personnelle non soumise à validation.

### 4. Synchronisation quotidienne

```sh
npm run auto:installer    # installe l'agent launchd (8 h ou au réveil, essai toutes les heures)
npm run auto:statut       # état de l'agent et dernier journal
npm run auto:desinstaller
```

Journaux dans `data/logs/` : uniquement des comptes, jamais le contenu d'un mail. Au plus
50 mails classés et 100 annonces triées par Claude par jour ; le reste attend le lendemain.

## Commandes

| Commande | Rôle | Coût |
|---|---|---|
| `npm run sync` | Synchronisation : mails, annonces, pages, tri ; affiche le bilan et le coût | payant |
| `npm run ui` | Interface web locale (127.0.0.1 uniquement) | gratuit |
| `npm run candidatures` | Recalcule les candidatures et les affiche dans le terminal | gratuit |
| `npm run list` | Mails des dernières 24 h (lance l'autorisation si nécessaire) | gratuit |
| `npm run extract -- <id>` | Texte extrait d'un mail | gratuit |
| `npm run filter -- --days 14` | Simulation du pré-filtre, sans rien écrire | gratuit |
| `npm run offres:simuler -- --days 14` | Simulation de la veille des offres, sans rien écrire ni appeler Claude | gratuit |
| `npm run reanalyse` | Repasse à Claude les mails déjà retenus | ~0,55 $ |
| `npm run eval:classify` | Évalue le classement des mails sur un jeu annoté (hors git) | ~0,18 $ |
| `npm run eval:offres` | Évalue le tri des annonces sur un jeu annoté (hors git) | ~0,17 $ |
| `npm run offres:retrier` | Donne une priorité aux annonces gardées qui n'en ont pas encore | ~0,20 $ |
| `npm run eval:priorite` | Compare la priorité calculée aux annonces marquées d'une étoile | gratuit |
| `npm test` / `npm run typecheck` | Tests automatiques / vérification des types | gratuit |

## Coûts

Claude Haiku 4.5 (1 $ par million de jetons en entrée, 5 $ en sortie). Premier passage sur
quatre mois de mails : environ 0,50 $. Ensuite, quelques centimes par jour : une poignée de mails
et une quinzaine d'annonces à trier.

## Confidentialité

- Accès Gmail en lecture seule (`gmail.readonly`), rien d'autre.
- Envoyés à Claude : les mails retenus par le pré-filtre (texte plafonné, citations retirées),
  les descriptions d'annonces et le profil du candidat.
- La base `data/suivi.db` (vraies données, profil compris) et les jeux d'évaluation restent en
  local, exclus de git, comme `secrets/`.
- Ouvrir une annonce passe par le lien de suivi de la plateforme, qui enregistre ce clic.

## Limites

- **Application en mode Test** : l'autorisation Gmail expire au bout de **7 jours** ; il faut
  alors relancer `npm run list` (la synchronisation automatique notifie le problème). La publier
  **En production sans validation** supprime cette limite (usage personnel, moins de
  100 utilisateurs : pas d'audit nécessaire).
- L'autorisation est aussi révoquée en cas de changement de mot de passe, de révocation de
  l'accès ou de 6 mois sans utilisation.
- Indeed bloque la lecture des annonces : elles restent « non vérifiées » (non triées par Claude).
- Le classement par Claude se trompe parfois : les pages *À classer* et les corrections
  manuelles servent à rattraper ces erreurs, sans jamais être écrasées par une analyse suivante.

## Organisation du code

| Fichier | Rôle |
|---|---|
| `src/auth.ts` | Flux OAuth2 vers Gmail (PKCE, `state`, jetons), commenté étape par étape |
| `src/sync.ts`, `src/sync-run.ts` | Synchronisation incrémentale (`historyId`) et bilan |
| `src/extract.ts`, `src/filter.ts` | Texte des mails, pré-filtre |
| `src/classify.ts`, `src/candidatures.ts` | Classement par Claude, regroupement en candidatures |
| `src/offers.ts`, `src/offer-page.ts`, `src/offer-judge.ts` | Annonces des alertes, lecture des pages, tri |
| `src/db.ts` | Base SQLite et migrations versionnées |
| `src/ui/` | Interface (Hono, HTML généré côté serveur, htmx servi en local) |
| `scripts/sync-auto.sh`, `src/auto-install.ts` | Synchronisation quotidienne via launchd |

Besoin fonctionnel : [docs/fiche-fonctionnelle.md](docs/fiche-fonctionnelle.md) et
[docs/fiche-offres.md](docs/fiche-offres.md). Suivi du travail : issues GitHub.
