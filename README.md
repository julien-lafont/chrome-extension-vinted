# Vinted Favoris

Extension Chrome (Manifest V3) pour enregistrer des articles Vinted en local et les
retrouver dans un panneau latéral : collections, tri, et envoi d'offres au vendeur.

Aucun serveur, aucun compte, aucune donnée qui sort du navigateur. Fonctionne sur
`vinted.fr`.

## Installation

1. Ouvrir `chrome://extensions`
2. Activer le **Mode développeur** (en haut à droite)
3. **Charger l'extension non empaquetée** → sélectionner ce dossier
4. Épingler l'extension dans la barre d'outils

Après toute modification du code : bouton ↻ sur la carte de l'extension dans
`chrome://extensions`, **puis recharger l'onglet Vinted**.

## Utilisation

- **Page de recherche** — un bouton marque-page apparaît en haut à droite de chaque
  article (le favori natif de Vinted reste en bas à droite, aucune collision).
- **Fiche article** — un bouton « Enregistrer » flotte en bas à droite de l'écran,
  et le même marque-page apparaît sur les cartes des blocs du bas de page
  (« Dressing du membre », « Articles similaires »).
- **Panneau latéral** — clic sur l'icône de l'extension.

Les boutons se synchronisent entre tous les onglets Vinted ouverts.

### Collections

Les onglets en haut du panneau regroupent les articles. Tout nouvel article arrive
dans **Mes favoris**, la collection par défaut, qui ne peut pas être supprimée.

- `+` crée une collection (« Jeans », « Chemises », « Cadeau Julien »…)
- clic droit sur un onglet : le renommer
- pour classer un article : glisser sa poignée sur l'onglet visé, ou passer par
  l'icône dossier de la ligne
- une **croix** apparaît sur un onglet dès que sa collection est vide : elle la
  supprime. Une collection qui contient encore des articles n'affiche pas de croix
  — il faut la vider d'abord, ce qui évite de déplacer des articles sans le
  vouloir. **Mes favoris** n'en affiche jamais.

### Tri et ordre manuel

Six modes : **Personnalisé**, **Date d'ajout**, **Prix**, **État**, **Likes**,
**Taille**. Le bouton à droite du sélecteur inverse le sens, avec un libellé adapté
au mode (« Moins cher » plutôt que « Croissant »).

L'ordre personnalisé se règle en glissant la poignée `⠿` à gauche d'un article. Le
glisser fonctionne quel que soit le mode actif : partir d'un tri automatique bascule
simplement en ordre personnalisé, en figeant l'ordre affiché. L'ordre est propre à
chaque collection.

Réordonner **avec une recherche active** ne déplace que les articles visibles : les
articles masqués par le filtre gardent leur position dans l'ordre complet.

Échelles utilisées :

| Tri | Ordre |
|---|---|
| État | Satisfaisant → Bon → Très bon → Neuf sans étiquette → Neuf avec étiquette |
| Taille | Alphabétiques (XXXS → XXXL) d'abord, puis numériques (34, 36, 38…) |

Un article dépourvu de la donnée triée finit **toujours** en bas de liste, dans les
deux sens, et l'en-tête indique combien d'articles sont dans ce cas. Certains tris
sont aujourd'hui incomplets — voir [limites connues](docs/limitations.md).

### Explorer une marque

La **marque** d'un article, soulignée en pointillé dans la ligne de métadonnées,
ouvre le catalogue Vinted filtré sur cette marque **dans la catégorie de
l'article**. Rien d'autre n'est filtré : ni prix, ni taille, ni état — c'est une
exploration de la marque, pas la recherche d'un équivalent.

Si la catégorie de l'article n'est pas connue avec certitude, le filtre porte sur
la marque seule plutôt que de risquer une catégorie erronée.

### Rechercher un article similaire

L'icône loupe d'un article ouvre le catalogue Vinted pré-filtré :

| Critère | Valeur |
|---|---|
| Marque et taille | celles de l'article |
| Catégorie | celle de l'article, si elle est connue avec certitude |
| Prix | de la **moitié** au **double** du prix enregistré (−50 % / +100 %) |
| État | Neuf avec étiquette, Neuf sans étiquette, Très bon état |

Les trois états sont **fixes**, quel que soit celui de l'article d'origine : on
cherche une bonne affaire, pas son équivalent abîmé.

Les deux bornes s'ajustent séparément dans `src/sidepanel/search.js` :
`PRICE_DOWN` (0,5 = −50 %) et `PRICE_UP` (1 = +100 %). Elles sont arrondies vers
l'extérieur, pour ne pas exclure un article situé pile sur la limite.

Marque et taille passent aujourd'hui par la recherche textuelle : Vinted ne filtre
que par identifiant numérique, et les favoris ne stockent que des libellés. La
recherche est donc approximative sur ces deux critères — « 42 » remonte aussi bien
une pointure qu'un tour de taille. La catégorie corrige beaucoup ce flou quand elle
est disponible. Voir [vinted-dom.md](docs/vinted-dom.md#url-de-recherche-du-catalogue).

### Offres au vendeur

L'icône étiquette d'un article ouvre la fenêtre d'offre :

1. le prix est pré-rempli à la dernière remise utilisée (raccourcis −10 / −15 / −20 / −30 %) ;
2. un message de négociation est composé pour ce prix — **Régénérer** en propose une
   autre formulation, et toute modification manuelle est conservée ;
3. **Envoyer l'offre** ouvre (ou réutilise) l'onglet de l'article et pilote la page :
   bouton « Faire une offre » → saisie du prix → validation, puis envoi du message
   dans la conversation si la case est cochée.

Le registre du message s'adapte à l'effort demandé au vendeur : au-delà de 25 % de
remise, il reconnaît explicitement que la demande est basse et invite à une
contre-proposition, ce qui vaut mieux qu'un chiffre sec.

L'offre part réellement à la validation — le récapitulatif affiché avant l'envoi est
le point de contrôle. Chaque étape ratée est signalée nommément (bouton introuvable,
champ inactif, modale non refermée) plutôt que par un échec générique.

### Export et diagnostic

Le pied du panneau propose un **export JSON** de tous les favoris, et un
**Diagnostic** à lancer quand quelque chose ne fonctionne plus — il dit en une
lecture si Vinted a changé son DOM ou si le clic n'atteint pas le bouton.

## Documentation

| Document | Contenu |
|---|---|
| [architecture.md](docs/architecture.md) | Fichiers, modèle de données, stockage, concurrence |
| [vinted-dom.md](docs/vinted-dom.md) | Ancres DOM Vinted et procédure quand elles cassent |
| [pitfalls.md](docs/pitfalls.md) | Clics fantômes, boucle de repeint, glisser-déposer |
| [diagnostic.md](docs/diagnostic.md) | Lecture du rapport de diagnostic |
| [testing.md](docs/testing.md) | Lancer les tests, harness, fixtures |
| [limitations.md](docs/limitations.md) | Limites connues |

## Tests

```bash
cd tests && npm install && npm test
```
