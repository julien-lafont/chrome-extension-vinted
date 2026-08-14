# « Mes favoris », récapitulatif de tout

## 1. Ce qui change

Avant, « Mes favoris » était une collection comme les autres et l'appartenance était
**exclusive** : ranger un article dans « Jeans » le faisait disparaître des favoris. Le
premier onglet du panneau n'était donc pas « tout ce que j'ai gardé » mais « ce que je
n'ai pas encore rangé », ce que rien à l'écran ne disait.

Désormais :

- **« Mes favoris » montre tout** ce qui est enregistré, classé ou non ;
- une collection est une **étiquette facultative** qui s'ajoute au favori ;
- un article peut n'être que dans « Mes favoris » — c'est même son état à la capture ;
- depuis les favoris, une **pastille** sur la ligne dit dans quelle collection l'article
  est rangé, et y mène d'un clic. Pas de pastille = non classé.

Une seule exception : **« Archives » sort du récapitulatif**. Archiver, c'est écarter ce
qui est vendu ou parti ; les laisser reparaître dans les favoris viderait le geste de
son sens.

## 2. Modèle de données

Rien ne change dans la **forme** du storage : `item.collectionId` reste un identifiant
facultatif. C'est sa **lecture** qui change, et elle tient dans deux fonctions de
`shared/collections.ts` :

| Fonction                     | Rend                                                        |
| ---------------------------- | ----------------------------------------------------------- |
| `classifiedIn(item, cols)`   | la collection de l'article, ou `null` s'il n'est pas classé |
| `isInTab(item, tabId, cols)` | l'article s'affiche-t-il sous cet onglet                    |

**Trois formes disent « non classé »**, et c'est ce qui rend la bascule rétrocompatible
sans rien migrer :

1. `collectionId` absent — ce que le content script écrit depuis toujours ;
2. `collectionId === 'default'` — ce qu'écrivaient les versions précédentes lorsqu'on
   rangeait explicitement dans « Mes favoris » ;
3. `collectionId` pointant vers une collection supprimée — référence morte.

L'entrée `collections.default` **reste** en storage : elle ne sert plus qu'à porter
`order`, l'ordre manuel de la vue globale, qui n'aurait nulle part où vivre autrement.

## 3. Rétrocompatibilité

Deux mécanismes, dans cet ordre d'importance.

**La tolérance en lecture** est le vrai filet : un storage jamais migré s'affiche
exactement comme un storage migré. Une version antérieure de l'extension relisant un
storage migré fonctionne aussi — elle retombe sur son propre défaut, qui est le même
onglet.

**La migration** (`shared/migrate.ts`, `settings.schemaVersion` : absent = 1, courant
= 2) n'est qu'un **nettoyage** : elle efface les `collectionId` des formes 2 et 3
ci-dessus, et ne touche à aucun `order`. Elle est idempotente, lancée depuis le panneau
seul (`sidepanel.ts`, sans attente), et **l'affichage n'en dépend pas** : une migration
dont dépendrait la lecture transformerait le moindre échec d'écriture en extension
cassée, alors qu'ici l'échec ne coûte qu'un passage de plus au chargement suivant.

## 4. Conséquences sur les gestes

| Geste                                | Avant                             | Maintenant                                                |
| ------------------------------------ | --------------------------------- | --------------------------------------------------------- |
| Menu d'une ligne                     | « Déplacer vers → Mes favoris »   | « Ranger dans → **Aucune collection** » (déclasse)        |
| Menu de la page (appui long)         | ligne « Mes favoris »             | ligne « **Aucune collection** », même sémantique          |
| Dépôt sur l'onglet « Mes favoris »   | déplacement                       | déclassement                                              |
| Compteur de l'onglet « Mes favoris » | les non classés                   | **tout**, hors archivés (les compteurs se recouvrent)     |
| Croix de suppression d'un onglet     | seulement sur une collection vide | toujours, avec confirmation si elle contient des articles |
| « Archiver » depuis « Mes favoris »  | les vendus des non classés        | les vendus de **toutes** les collections                  |

**Supprimer une collection ne perd plus rien** : ses articles redeviennent non classés
et restent dans les favoris. La règle « seulement si vide » protégeait d'une perte qui
ne peut plus se produire ; le champ est effacé sur chaque article au passage, dans la
même section critique, pour ne pas laisser d'identifiant qui ne désigne plus rien.

**L'archivage note l'origine par article** (`ArchiveResult.moved: { id, from }[]`) et
non une fois pour toute l'opération : lancé depuis les favoris il balaie plusieurs
collections, et une origine unique les rendrait toutes à la même — c'est-à-dire les
déclasserait en bloc sur un simple « Annuler ».

## 5. Ordres personnalisés

`placeInOrder()` retire l'article de l'ordre des autres collections **sauf celui de «
Mes favoris »**. C'est le point le plus facile à casser sans s'en apercevoir : purger
l'ordre global à chaque rangement ferait sauter la carte en tête des favoris pour la
seule raison qu'on l'a classée ailleurs.

Un article qui n'est dans aucun `order` s'affiche en tête, du plus récent au plus ancien
(voir `sortItems`) : un article classé mais jamais réordonné dans la vue globale n'a
donc pas besoin d'y être inscrit.

## 6. Ce que cette spec ne fait pas

- **pas de collections multiples** : un article reste classé dans au plus une collection
  ;
- **pas de filtre « non classés »** dans les favoris — la pastille (ou son absence)
  suffit à repérer ce qui est rangé ;
- **pas de rattrapage** des ordres existants : `default.order` est repris tel quel.
