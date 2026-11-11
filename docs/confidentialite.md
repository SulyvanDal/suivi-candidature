# Règles de confidentialité

*Suivi de candidatures* est un outil personnel, installé et exécuté sur l'ordinateur de la
personne qui l'utilise. Il n'existe aucun serveur ni service en ligne associé à l'application.

## Données Gmail consultées

- Accès en **lecture seule** (`https://www.googleapis.com/auth/gmail.readonly`) : l'application
  ne peut ni envoyer, ni modifier, ni supprimer de mail.
- Elle lit les mails reçus et envoyés à partir d'une date de début choisie par la personne, pour
  repérer ceux qui concernent ses candidatures et les alertes d'offres d'emploi.

## Où vont les données

- **Sur l'ordinateur de la personne** : les informations extraites (entreprise, poste, statut,
  dates, annonces) sont enregistrées dans une base locale. Les jetons d'accès Google restent dans
  un fichier local, lisible par elle seule.
- **API Anthropic (Claude)** : le texte des mails retenus par un pré-filtre local, ainsi que la
  description publique des annonces d'emploi, est envoyé à l'API d'Anthropic pour être classé et
  pour en extraire les informations utiles. Cet envoi est soumis aux conditions d'utilisation de
  l'API d'Anthropic.
- **Nulle part ailleurs** : aucune donnée n'est vendue, partagée avec des tiers, utilisée à des
  fins publicitaires ni envoyée au développeur de l'application.

L'utilisation des données reçues des API Google respecte les
[règles relatives aux données utilisateur des services d'API Google](https://developers.google.com/terms/api-services-user-data-policy),
y compris les exigences d'utilisation limitée (*Limited Use*).

## Conservation et suppression

Les données restent sur l'ordinateur tant que la personne ne les supprime pas (dossiers `data/`
et `secrets/` de l'application). L'accès à Gmail peut être retiré à tout moment depuis
[myaccount.google.com/permissions](https://myaccount.google.com/permissions).

## Contact

Questions : [issues du dépôt](https://github.com/SulyvanDal/suivi-candidature/issues).
