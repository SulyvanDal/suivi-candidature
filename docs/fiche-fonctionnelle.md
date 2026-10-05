# Fiche fonctionnelle : suivi de candidatures

> Validée le 05/10/2026 (#1).

## Contexte

Je postule à des offres d'emploi via plusieurs canaux. Les réponses arrivent dans Gmail,
mélangées au reste. Je veux un suivi à jour de mes candidatures sans le tenir à la main.

## Objectif

À partir des mails reçus et envoyés sur Gmail, tenir automatiquement la liste de mes
candidatures, avec pour chacune son statut courant et son historique.

## Ce qu'est une candidature

Une candidature = une entreprise + un poste.

| Champ | Description | Source |
|---|---|---|
| Entreprise | Nom de l'entreprise qui recrute | Extrait du mail |
| Poste | Intitulé du poste | Extrait du mail |
| Date de candidature | Date de l'envoi ou de l'accusé de réception | Premier mail rattaché |
| Canal | Plateforme ou moyen utilisé (LinkedIn, Welcome to the Jungle, Indeed, site carrière, mail direct…) | Expéditeur / contenu |
| Lien de l'offre | URL de l'annonce, si présente dans un mail | Extrait du mail |
| Lieu | Ville ou région du poste, si indiquée | Extrait du mail |
| Statut courant | Voir ci-dessous | Dernier événement |
| Dernier événement | Date et type du mail le plus récent | Calculé |

## Statuts

```
Envoyée → Entretien → Offre
   ↘          ↘
   Refus      Refus
```

| Statut | Déclencheur |
|---|---|
| **Envoyée** | Mail automatique « nous avons bien reçu votre candidature », ou candidature envoyée par moi par mail |
| **Entretien** | Invitation ou planification d'un entretien |
| **Offre** | Proposition d'embauche |
| **Refus** | Réponse négative de l'entreprise, avant ou après un entretien |
| **Sans réponse** | Aucun événement depuis 3 semaines (calculé, pas de mail) |

## Mails pris en compte

- Mails **reçus** d'entreprises, de plateformes de recrutement ou des outils de recrutement
  (ATS) propres aux entreprises.
- Mails **envoyés** par moi : candidatures spontanées, réponses, relances.
- Exclus : spam, corbeille, newsletters et alertes d'offres (« 10 nouvelles offres pour vous »),
  qui ne sont pas des candidatures.
- Exclus aussi (décision du 05/10/2026) : candidatures à une formation ou une école (y compris
  en alternance), et approches spontanées de recruteurs pour un poste auquel je n'ai pas postulé.
- Inclus : les demandes d'immersion professionnelle auprès d'une entreprise.

Pas de liste d'expéditeurs ou de plateformes : les mails viennent d'ATS trop variés.
Le pré-filtre (#7) se base donc sur le contenu, avec des filtres texte (mots-clés).
Faire faire ce tri par Claude est une piste pour plus tard.

## Premier passage

Au premier lancement, l'application analyse les mails depuis le **1er juin 2026**.
Ensuite, elle ne traite que les nouveaux mails.

## Consultation du suivi

Pour commencer : un **tableau dans le terminal**, pour tester vite (une ligne par
candidature : entreprise, poste, lieu, statut, date du dernier événement), trié par dernier
événement. Une vraie interface viendra ensuite.

## Corrections manuelles

L'analyse automatique se trompera parfois (mauvais rattachement, statut mal compris).

Pas de commande de correction dans la première version : l'édition se fera plus tard depuis
l'interface. En attendant, le modèle de données doit déjà le permettre : une correction
manuelle ne doit jamais être écrasée par une analyse automatique ultérieure.

## Confidentialité

- Seuls les mails retenus par le pré-filtre sont envoyés à l'API Claude.
- Les données restent en local (base SQLite exclue de git), à part ces appels.

## Critères de réussite

- Sur un mois de vrais mails, chaque candidature réelle apparaît une seule fois, avec le bon statut.
- Aucun mail non lié à une candidature n'apparaît dans le suivi.
- Le suivi se met à jour sans intervention (voir #12).

## Hors périmètre

- Recherche d'offres et envoi de candidatures.
- Autres messageries que Gmail.
- Partage avec d'autres personnes.
