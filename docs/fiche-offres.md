# Fiche fonctionnelle : offres à regarder

> Validée le 06/10/2026 (#20).

## Contexte

Je reçois des alertes d'offres d'emploi (Hellowork, Indeed, Welcome to the Jungle…). Elles sont
nombreuses et mal ciblées : beaucoup d'annonces trop seniors, en intérim ou hors sujet. Le
pré-filtre les écarte aujourd'hui du suivi des candidatures (règle `alerte-offres`).

## Objectif

Extraire les annonces de ces alertes, ne garder que celles qui correspondent à ma recherche, et
les afficher dans une liste « Offres à regarder » de l'interface.

## Mesure de départ

Simulation sur les alertes du 22/09 au 06/10/2026 (`npm run offres:simuler`) :

| | 14 jours |
|---|---|
| Alertes | 73 lues (Hellowork 61, Indeed 6, Welcome to the Jungle 6) ; Job Watch ignoré |
| Annonces | 1 137, dont la moitié en double |
| Gardées par le filtre 1 | 602 |
| Pages lisibles | Hellowork : la plupart ; Indeed : aucune (accès refusé) |
| Coût estimé du filtre 2 | ≈ 2 $ par mois pour un volume doublé, doublons évités et description seule |

## Fonctionnement

```
alerte d'offres → annonces → doublon ? → filtre 1 (intitulé) → page de l'annonce → filtre 2 (Claude) → liste
```

1. **Alertes lues** : celles que le pré-filtre reconnaît comme alertes (`alerte-offres`), d'une
   plateforme qu'on sait lire : Hellowork, Indeed, Welcome to the Jungle. Les autres (Job Watch,
   qui envoie surtout des formations) sont ignorées. La plateforme est reconnue à l'expéditeur :
   ce n'est pas une liste de tri, seulement le choix du bon extracteur.
2. **Annonces** : intitulé, entreprise, lieu, contrat, lien.
3. **Doublons** : une annonce déjà vue (même intitulé et même entreprise, sans tenir compte des
   majuscules ni des accents) est ignorée. Elle n'apparaît qu'une fois et n'est jamais renvoyée
   à Claude.
4. **Filtre 1, sur l'intitulé** (gratuit) : l'annonce est gardée si son intitulé contient un
   poste recherché et ni l'intitulé ni le contrat ne contiennent un mot exclu. Mots entiers,
   sans tenir compte des accents ; un « * » final accepte toutes les terminaisons.
5. **Page de l'annonce** : on suit le lien et on ne garde **que la description** du poste
   (ni menus, ni pied de page), plafonnée à 8 000 caractères. Si la page est illisible
   (Indeed, protection anti-robot), l'annonce est gardée sans filtre 2, avec une pastille
   « non vérifiée ».
6. **Filtre 2, par Claude** (Haiku) : à partir de mon profil, Claude juge
   - la **séniorité** : poste de type produit / projet de débutant à 4 ans d'expérience demandés,
     poste de développeur de débutant à 2 ans ;
   - la **cohérence** : le poste correspond-il vraiment à l'intitulé et à ce que je cherche ?

   Il répond « garder » ou « écarter », avec une justification courte affichée dans la liste.
7. **Plafond** : 100 annonces envoyées à Claude par jour au plus. Le reste attend le lendemain.

Seules les **nouvelles** alertes sont traitées, à partir de la mise en service : une offre de
juin est sans doute déjà pourvue.

## Listes de départ

Modifiables depuis l'interface (en base, pas dans le code).

- **Postes recherchés** : product owner, proxy po, product manager, product builder,
  ops & product, chef de projet\*, pmo, consultant digital transformation, business analyst,
  amoa, développeu\*, software engineer, ingénieur logiciel.
- **Mots exclus** : stage, alternance, freelance, senior, tech lead, intérim.
- **Profil** : texte de quelques lignes (parcours, postes visés, séniorité), envoyé à Claude
  avec chaque annonce. Il reste en base : il n'est ni dans le code ni dans le dépôt.

## Liste « Offres à regarder »

- Une ligne par annonce gardée : intitulé, entreprise, lieu, contrat, date de l'alerte,
  justification de Claude ; la plus récente en premier.
- Pastille **« nouveau »** tant que je ne l'ai pas consultée.
- Pastille **« non vérifiée »** si la page n'a pas pu être lue (filtre 2 non appliqué).
- **Consulter** : ouvre l'annonce et retire la pastille « nouveau » ; l'offre reste dans la liste.
- **Ignorer** : retire l'offre de la liste.
- Les annonces écartées par les filtres ne sont pas affichées, mais comptées (« 54 écartées
  cette semaine »), pour pouvoir juger si les filtres sont trop sévères.

## Confidentialité

- Envoyés à Claude : le texte de l'annonce (public) et mon profil.
- Ouvrir une annonce passe par le lien de suivi de la plateforme, qui enregistre ce clic.

## Hors périmètre (pour l'instant)

- Lien avec les candidatures (« j'ai postulé à cette offre ») : la candidature est détectée par
  ses propres mails.
- Offres expirées, nettoyage de la liste.
- Nouvelles plateformes : ajoutées au cas par cas quand elles apparaissent.
