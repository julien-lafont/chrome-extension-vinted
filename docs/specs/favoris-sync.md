# Sync favoris

Lie les articles enregistrés par l'extension au **cœur natif de Vinted**. Sans elle, les
deux listes font doublon : on met un article en favori chez Vinted, on l'enregistre dans
l'extension, et il faut penser aux deux.

**Désactivée par défaut**, et c'est le seul réglage qui fasse **écrire l'extension sur
le compte Vinted**. Tant qu'il est éteint, rien ne part vers le site — la promesse du
projet (« rien ne sort sans un clic explicite ») tient, le clic étant ici l'activation.

Bascule : pied de page du panneau, à côté de « Masquer les pubs ».

## 1. Les quatre règles

| Ce qui arrive                        | Ce qui suit                                        |
| ------------------------------------ | -------------------------------------------------- |
| cœur posé sur Vinted                 | enregistré dans la collection épinglée de l'onglet |
| enregistré dans l'extension          | cœur posé sur Vinted                               |
| cœur retiré sur Vinted               | déplacé vers « Archives »                          |
| supprimé ou archivé dans l'extension | cœur retiré sur Vinted                             |

Chaque règle est **inerte quand l'état visé est déjà atteint**. C'est ce qui rend les
allers-retours convergents : la règle 2 déclenchée par la règle 1 ne trouve rien à
faire.

## 2. Deux invariants, dont tout le reste découle

### 2.1 Rien n'est rétroactif

La synchro n'agit que sur une **transition constatée** : un cœur qu'on a vu changer, un
geste qu'on a vu faire. Jamais sur un écart entre deux listes.

À l'activation, les deux mondes sont divergents par construction — des favoris Vinted
posés avant l'installation, des articles enregistrés jamais mis en favori. Les aligner
d'office supprimerait des articles sur la foi d'un état qu'on n'a jamais vu changer. Or
« l'utilisateur a retiré ce favori » et « ce favori n'a jamais existé » produisent
exactement les mêmes données, et rien ne les distingue après coup.

Trois conséquences, toutes visibles dans le code :

- allumer le réglage ne déclenche **aucune** écriture ;
- une carte vue pour la première fois n'est pas une transition, même si son cœur est
  éteint. Sans cette règle, défiler le catalogue archiverait une à une toutes les pièces
  de la collection ([`fav-sync.ts`](../../src/content/fav-sync.ts), `note()`) ;
- une intention n'est mise en file que si le réglage est **déjà** allumé
  ([`fav-sync-storage.ts`](../../src/shared/fav-sync-storage.ts), `enabled()`) : sinon
  elle attendrait l'activation pour partir, ce qui reviendrait au même.

### 2.2 « Archives » est hors du périmètre

Un article archivé est un article dont l'extension et Vinted s'accordent à dire qu'il
n'est plus un favori. C'est ce qui **ferme la boucle** : archiver retire le cœur, ce qui
ferait constater un retrait, qui rearchiverait, indéfiniment. L'exclusion transforme le
cycle en point fixe.

C'est aussi ce qui rend le retrait non destructif. Un cœur décoché par erreur ne coûte
pas l'historique de prix ni la date d'ajout : l'article est au fond du tiroir, et le
remettre en favori l'en ressort (`restore`, distinct de `save` — voir
`effectOfFavourite()`).

**Le marque-page injecté dit la même chose que le cœur.** Un article archivé s'y affiche
_vide_, et le clic qui le remplit **reprend** l'article — il ne le recrée pas, et
surtout il ne le supprime pas, ce que ferait une bascule sur un article encore présent
en storage. Voir `isFavourite()` et `unarchiveItem()` dans `content.ts` ; le prédicat
est le même que `wantedFavourite()`, et ce n'est pas une coïncidence : ce que le bouton
montre est exactement ce que Vinted doit montrer.

## 3. Lire : `aria-pressed`, et rien d'autre

Le cœur est le même composant partout ; les ancres sont dans
[vinted-dom.md](../vinted-dom.md#api-des-favoris--lire-et-écrire).

On observe le **résultat**, jamais le geste. Intercepter le clic dirait l'intention, pas
ce qui s'est produit : la requête de Vinted peut échouer, et le favori peut bouger sans
clic sur cette page — un autre onglet, l'application mobile, la page « Favoris ».

D'où un `MutationObserver` dédié, en `attributeFilter: ['aria-pressed']`. Le
`MutationObserver` principal de `content.ts` ne surveille que `childList` : il ne
verrait rien passer. Aucun risque de boucle de repeint (règle 3 du projet) — ce module
ne fait que lire, et n'écrit jamais cet attribut.

**Absent ≠ `false`.** Sur une fiche, le bouton arrive `disabled` et nu le temps de
l'hydratation. Le lire comme « pas en favori » ferait constater le retrait de tous les
favoris à chaque chargement de page.

## 4. Écrire : deux chemins, et pourquoi

### 4.1 Cliquer le cœur de Vinted — partout où il est à l'écran

Ce chemin vaut pour les gestes faits dans la page **et pour le vidage de la file** : si
la carte visée est à l'écran, `drainFavourites()` clique son cœur au lieu d'appeler
l'API. Sans cela, un article retiré depuis le panneau se dé-favorisait bien côté serveur
mais restait rouge dans la page ouverte jusqu'au rechargement — Vinted seul sait
repeindre son bouton. La lecture de la liste des favoris est donc **paresseuse** : le
cas courant ne coûte aucune requête.

`setHeart()` clique **le bouton de Vinted**. Vinted fait alors sa propre requête, avec
son propre jeton, et repeint son icône, son compteur et son libellé. Trois avantages qui
ne se rattrapent pas autrement :

- aucune API à appeler, aucun jeton à extraire, aucun rendu à réimplémenter — et donc
  rien de tout cela à réparer au prochain déploiement de Vinted ;
- **l'utilisateur voit le cœur rougir** à l'instant où il enregistre. C'est la demande
  d'origine, et c'est ce qui rend la synchro compréhensible sans documentation ;
- le compteur de favoris suit, ce qu'un appel d'API ne donnerait pas.

Le bouton est une **bascule** : on ne le clique jamais sans avoir comparé `aria-pressed`
à l'état voulu, sous peine de retirer le favori qu'on venait poser.

Un cas à ne pas manquer : l'appui long retire l'article sur son propre `pointerdown`
(règle 1 du projet), ce qui décoche le cœur ; le rangement qui suit le rallume.

### 4.2 La file d'intentions — pour tout le reste

Deux gestes ne peuvent pas passer par un clic : une **suppression ou un archivage depuis
le panneau**, où l'article n'est sur aucune page, et un **cœur pas encore hydraté**,
dont l'état est illisible. Ils partent dans la clé `favsync`, qu'un onglet Vinted vide
par l'API.

```js
favsync = {
  pending: [{ id: '9778177557', want: false, at: 1787684090000 }],
  lastDrainAt: 1787684092000,
  lease: { tabId: 'lq3x8f-4b2', until: 1787684150000 },
  throttledUntil: undefined,
};
```

`want` est un **état voulu**, pas un geste. L'API ne sait qu'inverser (§4.3) : ne garder
que « bascule » rendrait la file inexploitable dès qu'elle est doublée. Une intention
plus récente sur le même article **remplace** la précédente — le dernier geste dit à lui
seul ce que veut l'utilisateur.

### 4.3 L'ordre du vidage n'est pas négociable

```
bail → jeton → liste réelle des favoris → comparaison → bascules
```

`POST /api/v2/user_favourites/toggle` **inverse** un favori : même requête, même corps
pour l'ajout et pour le retrait, et une réponse qui ne dit pas lequel a été pris. D'où :

- **la liste d'abord.** Basculer sans avoir lu l'état réel, c'est une chance sur deux de
  faire l'inverse de ce qui est demandé ;
- **un échec de lecture arrête tout.** Le traduire par « rien n'est en favori » mettrait
  toute la collection en favori. La file reste intacte, le prochain onglet retentera ;
- **un bail entre onglets.** Deux onglets qui basculent le même article reviennent au
  point de départ _en croyant avoir agi_. Le bail n'économise pas des requêtes, il évite
  une corruption. Même mécanique que le cycle de suivi ([suivi-prix.md](suivi-prix.md))
  : identifiant d'instance, et expiration pour qu'un onglet fermé ne bloque pas à vie ;
- **un plafond de 25 bascules par vidage.** Plafond de dégâts, pas de débit : un défaut
  qui produirait mille intentions fausses ne doit pas pouvoir vider les favoris d'un
  compte en une passe. Le reste attend le vidage suivant.

Le jeton anti-CSRF et le cookie `anon_id` sont tous deux obligatoires — sans le premier,
l'API répond 403. Voir [vinted-dom.md](../vinted-dom.md#api-des-favoris--lire-et-écrire)
pour leur emplacement.

### 4.4 Ce qui déclenche un vidage

Au chargement d'une page Vinted si la file n'est pas vide, et à chaque **ajout** dans la
file. Un ajout, et non une écriture quelconque de la clé : le vidage écrit lui-même
dessus — il prend puis rend le bail, il retire ce qu'il a fait — et `onChanged` notifie
aussi celui qui vient d'écrire. Réagir à toutes les écritures relancerait un vidage à la
fin de chaque vidage, et le premier arrêt sans effet (jeton absent, freinage) tournerait
en boucle serrée. Voir `gainedIntent()` dans `content.ts`.

Les vidages sont groupés (2 s) : un archivage en masse ne doit produire qu'une lecture
de la liste des favoris, pas une par article.

## 5. Les deux rattrapages explicites

Clic droit sur « Sync favoris » :

| Entrée                                          | Ce qu'elle fait                           |
| ----------------------------------------------- | ----------------------------------------- |
| Importer mes favoris Vinted                     | enregistre les favoris absents du panneau |
| Mettre en favoris tous mes articles enregistrés | pose les cœurs manquants chez Vinted      |

Ils lèvent le §2.1 — ils comparent bien les deux listes — mais seulement parce que
l'utilisateur les déclenche, et surtout parce qu'ils sont **additifs des deux côtés**.
Aucun ne supprime, aucun n'archive, aucun ne retire un cœur. C'est ce qui les rend sûrs
là où un « aligner les deux listes » symétrique ne le serait pas : celui-là effacerait
ce qu'il ne comprend pas, et un écart ne dit jamais qui a bougé.

Quatre règles qui les gouvernent :

- **l'import n'écrase jamais un article connu**, même archivé. Réimporter remplacerait
  un article complet — catégorie, photos, historique de prix — par les six champs d'une
  carte, et ferait remonter dans les favoris ce qu'on avait mis au fond du tiroir ;
- **les articles importés arrivent en qualité « carte »** (`pending: true`) : l'API des
  favoris ne porte ni catégorie ni fil d'Ariane, et leur fiche les complète ensuite,
  exactement comme un clic sur le catalogue ;
- **un favori vendu est importé quand même**, marqué `status: 'sold'` par sa fiche. Un
  clic sur une carte de catalogue, lui, est _annulé_ quand la fiche révèle la vente
  (`discardSoldItem()`) — l'utilisateur ne pouvait pas le savoir. Ici il le sait : il a
  demandé ses favoris, et un favori gardé après la vente l'a souvent été exprès.
  Appliquer la garde du catalogue à l'import le faisait « oublier » des articles, sans
  un mot — le compte annonçait trois, le panneau en montrait deux ;
- **la poussée exclut « Archives »**, comme partout ailleurs. Les pousser les ferait
  remonter chez Vinted, puis la synchro constaterait un cœur posé et les en sortirait :
  le geste défairait un rangement voulu ;
- **la liste réelle se lit d'abord**, pour la raison habituelle : basculer un article
  déjà en favori l'en retirerait.

La poussée est plafonnée à **200 cœurs par exécution** (600 ms chacun, soit deux
minutes). C'est un plafond d'attente, pas de dégâts — d'où l'écart avec les 25 du vidage
automatique, qui borne lui les conséquences d'un défaut. Au-delà, le panneau annonce ce
qui reste et il suffit de relancer.

Ni l'un ni l'autre ne passe par la file d'intentions : celle-ci sert à porter un geste
jusqu'à un onglet, alors qu'ici l'onglet est déjà là et l'utilisateur attend le compte —
c'est aussi pourquoi le content script répond **à la fin** et non à l'acceptation.

Le réglage n'a pas besoin d'être allumé : ce sont des actions ponctuelles, pas des
règles.

## 6. Ce que la synchro ne fait pas

- **elle ne rattrape pas d'elle-même.** Un favori posé depuis l'application mobile
  n'arrive dans l'extension que si un onglet Vinted montre la carte au moment où l'état
  change — ou au prochain import manuel. C'est la contrepartie assumée du §2.1 ;
- **elle ne touche pas aux collections**, sauf « Archives ». Un article déplacé de «
  Jeans » vers « Vestes » ne change rien pour Vinted, et n'entre donc pas en file ;
- **elle ne lit pas les favoris pour enrichir**. La liste sert à savoir ce qui est en
  favori, rien d'autre : la fiche article reste la seule source de vérité d'un article
  enregistré (voir [architecture.md](../architecture.md)).

## 7. Diagnostic

Le rapport du panneau porte cinq compteurs, dans `debug` :

| Compteur          | Ce qu'il dit                                           |
| ----------------- | ------------------------------------------------------ |
| `favApplied`      | transitions du cœur Vinted appliquées au storage       |
| `favUnresolved`   | transitions vues sans retrouver l'article dans la page |
| `favClicked`      | cœurs Vinted cliqués par l'extension                   |
| `favDeferred`     | gestes partis en file faute de cœur cliquable          |
| `favToggled`      | bascules émises par l'API                              |
| `favDrainStopped` | pourquoi le dernier vidage s'est arrêté                |
| `soldKept`        | favoris importés que leur fiche dit vendus             |

Les deux lectures qui reviennent :

- `favDeferred` qui monte sans `favToggled` : la file ne part pas. `favDrainStopped` dit
  pourquoi — `jeton absent` désigne une session expirée, `occupé` un autre onglet,
  `freiné` un 429 récent ;
- `favUnresolved` qui monte : l'extraction d'une carte casse, pas la synchro. Voir
  [vinted-dom.md](../vinted-dom.md).

## 8. Où c'est écrit

| Fichier                      | Rôle                                               |
| ---------------------------- | -------------------------------------------------- |
| `shared/fav-sync.ts`         | les décisions, pures : effet, état voulu, file     |
| `shared/fav-sync-storage.ts` | la clé `favsync` : relecture puis écriture         |
| `content/fav-sync.ts`        | observation des cœurs, et clic sur celui de Vinted |
| `content/fav-drain.ts`       | le vidage par l'API — la seule écriture distante   |
| `tests/fav-sync.test.ts`     | décision, lecture du DOM, bout en bout             |
| `tests/fav-drain.test.ts`    | le vidage, sans navigateur                         |
