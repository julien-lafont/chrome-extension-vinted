# Architecture

## Fichiers

```
src/manifest.ts                    manifeste typé ; version lue depuis package.json
icons/                             icônes générées (marque-page sur fond teal)
src/
  background/service-worker.ts     ouvre le panneau au clic sur l'icône
  background/saved-pulse.ts        badge + pulsation de l'icône à l'enregistrement
  content/content.ts               injection des boutons, enrichissement, suivi, filtrage
  content/extract.ts               lecture du DOM Vinted → SavedItem (pur, testé seul)
  content/content.css              styles des boutons injectés et du menu de collection
  content/collection-picker.ts     choix de collection à la capture (appui long)
  content/tab-default.ts           collection épinglée sur l'onglet, et sa pastille
  content/ui.ts                    activation à deux gestes, pile de pastilles
  content/noise-ui.ts              filtrage : annulation, pastille, menu de la fiche
  content/offers-scan.ts           balayage de l'inbox : offres en cours (réseau)
  sidepanel/sidepanel.ts           orchestration : état, rendu global, écouteurs
  sidepanel/dom.ts                 required() / within() — accès au DOM du panneau
  sidepanel/item-list.ts           la liste d'articles : une ligne, et leur mise à jour
  sidepanel/item-render.ts         prix, état, offre et vendeur d'une ligne
  sidepanel/collections-bar.ts     la barre d'onglets des collections
  sidepanel/offers.ts              déclenche le balayage des offres sur un onglet
  sidepanel/menus.ts               le menu contextuel (contenu bâti par l'appelant)
  sidepanel/store.ts               lecture/écriture chrome.storage.local
  sidepanel/reconcile.ts           mise à jour de la liste sans la reconstruire
  sidepanel/sorting.ts             clés et modes de tri
  sidepanel/dnd.ts                 réorganisation par glisser-déposer
  sidepanel/search.ts              URLs de catalogue (similaires, marque)
  sidepanel/elsewhere.ts           URLs de recherche externe (Lens, texte Google)
  sidepanel/gallery.ts             visionneuse des photos d'un article
  sidepanel/filters.ts             modale de gestion des règles de filtrage
  shared/types.ts                  modèle de données (SavedItem, Collection, Settings)
  shared/storage.ts                clés, forme du storage, écritures sérialisées
  shared/collections.ts            clé `collections` : lecture, création, rangement
  shared/migrate.ts                nettoyages de storage, versionnés (jamais requis pour lire)
  shared/noise.ts                  règles de filtrage du catalogue (pur, testé)
  shared/noise-storage.ts          clé `noise` : relecture puis écriture
  shared/offers.ts                 offres lues dans l'API des conversations (pur)
  shared/messages.ts               protocole panneau ↔ content scripts
  shared/photos.ts                 photos d'une fiche, du flux RSC ou du DOM
  shared/hydration.ts              identifiants lus dans le flux RSC (repli du DOM)
  shared/seller.ts                 réputation du vendeur ; pays, lu sur son profil
  shared/countries.ts              code pays → drapeau et nom (aucune table de noms)
  shared/size-ids.ts               libellé de taille → identifiant de catalogue
  shared/price.ts                  lecture d'un prix affiché par Vinted
  shared/errors.ts                 message lisible d'une erreur attrapée
  shared/icons.ts                  chemins des icônes (manifeste + setIcon)
scripts/build-config.ts            entrées, formats et options esbuild
scripts/build.ts                   produit dist/, valide le manifeste
tests/                             voir testing.md
```

TypeScript, bundlé par **esbuild**. `pnpm build` produit `dist/`, et c'est ce dossier
que Chrome charge — jamais la racine.

Les formats de sortie sont contraints par la plateforme, pas par goût :

- **content scripts → IIFE.** Chrome n'accepte aucun `import` à l'exécution dans un
  content script. esbuild les résout à la compilation et enferme le tout dans une
  fonction anonyme, ce qui isole au passage nos variables de celles de la page Vinted.
- **panneau et service worker → modules ES.** Les deux tournent dans un contexte
  d'extension qui les supporte.

L'appariement entrées ↔ format vit dans `scripts/build-config.ts`, et
`tests/build-output.test.ts` le verrouille : le mettre en `esm` ferait échouer
l'injection **sans un mot** en console.

### Ce que le bundler a rendu possible

`src/shared/` n'existait pas avant. Un content script ne pouvant rien importer, le
modèle de données vivait décrit par des commentaires de part et d'autre, et le parseur
de prix était dupliqué — avec, dans les deux cas, le risque qu'un champ renommé d'un
côté soit encore lu de l'autre sans erreur nulle part. Ce code est désormais unique.

Le manifeste est également passé en TypeScript (`src/manifest.ts`) : sa version est lue
depuis `package.json`, si bien qu'un tag de release et le manifeste ne peuvent plus
diverger.

## Le content script

`content.ts` s'exécute sur tout `https://www.vinted.fr/*` : il injecte les boutons
d'enregistrement et lit les métadonnées des articles.

## Stockage

Six clés dans `chrome.storage.local` : `savedItems`, `collections`, `settings`, `watch`
(état du cycle de rafraîchissement — voir `docs/specs/suivi-prix.md`), `noise` (règles
de filtrage du catalogue — voir `docs/specs/filtrage-bruit.md`) et `offers` (avancement
du balayage des offres — voir `docs/specs/offres.md`).

```js
savedItems = {
  9496908003: {
    id: '9496908003',
    url: 'https://www.vinted.fr/items/9496908003-nike-air-zoom-...',
    title: 'Nike Air Zoom mercurial superfly 11 Élite (PAS 1€)',
    brand: 'Nike',
    size: '42', // "" si l'article n'en a pas (sacs, accessoires)
    condition: 'Neuf avec étiquette',
    price: '1,00 €',
    priceValue: 1, // null si le prix est illisible
    favouriteCount: 9, // 0 = aucun favori, null = donnée absente
    pending: true, // fiche en cours de lecture ; absent = article complet
    category: {
      // null si la page n'a pas de fil d'Ariane
      id: '584',
      name: 'Hauts et t-shirts',
      path: ['Hommes', 'Vêtements', 'Vêtements de sport', 'Hauts et t-shirts'],
      url: 'https://www.vinted.fr/catalog/584-hauts-et-t-shirts',
      exact: true, // false = catégorie de la page, pas de l'article
    },
    imageUrl: 'https://images1.vinted.net/...webp',
    images: [
      // toutes les photos de la fiche ; absent tant qu'elle n'a pas été lue.
      // Jamais un tableau vide.
      {
        thumb: 'https://images1.vinted.net/t/.../310x430/....webp?s=...',
        url: 'https://images1.vinted.net/t/.../f800/....webp?s=...', // 600×800
        full: 'https://images1.vinted.net/tc/.../....webp?s=...', // 1200×1600
        width: 600,
        height: 800,
        dominantColor: '#cd98c1',
      },
    ],
    // Les champs suivants ne viennent que de la fiche : absents tant qu'elle
    // n'a pas été lue. Seul `sellerCountry` fait exception : la fiche ne le
    // porte nulle part, il vient d'une lecture de /member/{id}.
    brandId: '53', // seul filtre de marque accepté par le catalogue
    sizeId: '208', // résolu après coup, voir shared/size-ids.ts
    sellerId: '3165663897', // le profil est /member/{sellerId}
    sellerName: 'emma07297',
    sellerRating: 4.7, // note sur 5 ; null quand le vendeur n'a aucun avis
    sellerFeedbackCount: 39, // 0 est une valeur, null veut dire « pas lu »
    sellerCountry: 'FR', // ISO alpha-2 ; lu sur /member/{id}, jamais relu
    description: 'Veste Nike Dri-FIT…', // tronquée, encore inexploitée
    savedAt: 1753500000000,
    source: 'catalog', // ou "detail"
    // Collection où l'article est classé **en plus** d'être dans « Mes favoris »,
    // qui récapitule tout. Absent = non classé, l'état d'un article fraîchement
    // enregistré — voir docs/specs/favoris-recapitulatif.md.
    collectionId: 'col-lq3x8f-4b2',
    // Suivi de prix et de disponibilité, absents tant que l'article n'a jamais
    // été vérifié — voir docs/specs/suivi-prix.md.
    lastCheckedAt: 1753500000000,
    status: undefined, // 'sold' | 'gone', absent = actif
    priceHistory: [{ at: 1753500000000, price: 1 }],
    missCount: 0,
    // Offre en cours, absente tant qu'aucune n'a été trouvée dans l'inbox — la
    // fiche article n'en dit rien. Une seule, jamais d'historique. Voir
    // docs/specs/offres.md.
    offer: {
      by: 'me', // ou 'seller' : le vendeur a fixé un prix de son côté
      price: 399,
      at: 1753500000000, // envoi de l'offre, jamais la date du scan
      status: 'pending', // 'accepted' | 'rejected' | 'cancelled'
      conversationId: '24027793606', // /inbox/{id}
    },
  },
};

collections = {
  // « Mes favoris » n'est plus une collection mais la vue de tout ce qui est
  // enregistré : son entrée ne subsiste que pour porter l'ordre manuel global.
  default: { id: 'default', name: 'Mes favoris', createdAt: 0, order: [] },
  'col-lq3x8f-4b2': {
    id: 'col-lq3x8f-4b2',
    name: 'Jeans',
    createdAt: 1753500000000,
    order: ['9496908003', '9481120044'],
  },
  // Créée à la demande par « Archiver » (§6.5 de la spec), jamais à l'avance.
  archives: { id: 'archives', name: 'Archives', createdAt: 1753500000000, order: [] },
};

settings = {
  activeCollectionId: 'default',
  schemaVersion: 2, // absent = 1 ; ne conditionne qu'un nettoyage, jamais la lecture
  sortMode: 'custom', // custom | savedAt | price | condition | likes | size
  sortDir: 'asc',
  hideSold: false,
  revealHidden: false, // mode révision du filtrage — préférence, pas une règle
};

// État du cycle de rafraîchissement, écrit par le content script d'un onglet
// Vinted — jamais par le service worker. Voir docs/specs/suivi-prix.md.
watch = {
  lastSweepAt: 1753500000000,
  bucket: { tokens: 12, at: 1753500000000 },
};

// Écrit par le panneau (modale « Filtres ») comme par la page (bouton d'écart).
// `hidden` est borné et évincé par ancienneté : c'est le seul endroit du projet
// où perdre une donnée est sans conséquence.
noise = {
  hidden: { 9496908003: 1753500000000 },
  recent: [{ id: '9496908003', title: 'Veste Barbour', at: 1753500000000 }],
  sellers: { 286459945: { name: 'destock_pro', at: 1753500000000 } },
  brands: ['shein', 'zara'],
  words: ['lot', 'inspire'],
};
```

`savedItems` est un objet indexé par ID, pas un tableau : savoir si un article est déjà
enregistré est l'opération la plus fréquente du content script, elle doit être en O(1).

## Une seule source de vérité : la fiche article

Une carte de catalogue ne porte ni catégorie, ni couleur, et sa taille comme son état ne
viennent que d'un libellé d'accessibilité. Plutôt que d'entretenir deux extractions de
qualité inégale, **tout article finit lu depuis sa fiche** :

```
clic sur une carte
  → écriture immédiate : données de la carte + pending: true   (le panneau affiche)
  → fetch(fiche) en tâche de fond, une à la fois
  → extractFromDetail(doc) — la même fonction que sur la page ouverte
  → fusion, pending retiré                                     (le panneau complète)
  → résolution de l'identifiant de taille, écriture séparée    (search.ts s'en sert)

clic sur une fiche
  → extractFromDetail(document), écriture unique — la fiche est déjà là
  → résolution de l'identifiant de taille, écriture séparée
```

`fetch()` plutôt qu'un onglet : même origine, cookies inclus, aucun JS de Vinted
exécuté, rien de visible. Le HTML servi contient déjà tout ce qu'on lit — c'est aussi ce
qui permet aux fixtures de test d'être produites par simple requête HTTP.

Trois garde-fous, chacun couvert par un test :

- **l'article n'est jamais ressuscité** : si l'utilisateur le retire pendant la requête,
  le résultat est jeté ;
- **une fiche qui décrit un autre article est refusée** (Vinted redirige les articles
  retirés ou fusionnés) ;
- **une valeur vide n'écrase jamais une valeur de la carte** : si une ancre de fiche
  casse, on garde ce que la carte affichait. `0` reste une valeur.

`pending` n'est qu'un état d'affichage : il disparaît que la fiche ait été lue ou non.
Un `enAttenteDeFiche` qui ne redescend jamais, dans le [Diagnostic](diagnostic.md),
signale des requêtes qui échouent.

`category.url` est une URL de catalogue directement ouvrable : c'est ce qui permet de
relancer la recherche plus tard. `exact` dit d'où elle vient — voir
[limitations.md](limitations.md#catégorie).

## Répartition des responsabilités

Le classement d'un article vit sur l'**article** (`collectionId`), l'ordre manuel vit
sur la **collection** (`order`).

C'est ce qui permet au content script d'écrire dans `savedItems` sans rien savoir des
collections. Un article sans `collectionId` — ou pointant vers une collection supprimée
— est simplement **non classé**, sans migration ni réparation : il reste affiché dans «
Mes favoris », qui récapitule tout ce qui est enregistré (voir
[favoris-recapitulatif.md](specs/favoris-recapitulatif.md)). Une collection ne remplace
donc pas les favoris, elle s'y ajoute, et les compteurs de la barre d'onglets se
recouvrent.

Deux fonctions portent cette lecture, et elles sont les seules : `classifiedIn()` rend
la collection d'un article ou `null`, `isInTab()` dit s'il s'affiche sous un onglet
donné — la liste et les compteurs passent par la même, faute de quoi ils finiraient par
diverger.

Depuis la capture avec choix de collection (appui long sur un bouton injecté), le
content script écrit **aussi** sur la clé `collections`. Les deux mondes partagent alors
la même primitive, `assignCollection()` de `shared/collections.ts`, que `store.ts`
réexporte sous le nom `moveItemToCollection` : deux implémentations du même rangement
auraient fini par diverger sur `order`. `order` ne référence que les articles déjà
réordonnés à la main ; un ajout récent apparaît en tête tant qu'on ne l'a pas déplacé.

### La collection par défaut de l'onglet

L'épingle du menu de rangement (`content/tab-default.ts`) fait du clic court un
enregistrement direct dans une collection choisie. C'est un **radio, pas une bascule** :
une collection est toujours épinglée, et c'est « Mes favoris » tant qu'on n'a rien
choisi — puisque c'est là que les clics courts atterrissent de fait. La collection par
défaut ne s'écrit donc jamais : elle _est_ l'absence de valeur. Retirer une épingle,
c'est y revenir, et la pastille ne s'affiche que pour un écart à cet état normal.

Cet état-là **ne vit pas dans `chrome.storage.local`** mais dans le `sessionStorage` de
la page, sous `vf:defaultCollection` : la portée voulue est l'onglet, et c'est
exactement ce que `sessionStorage` donne — conservé au rechargement comme à travers la
navigation SPA, jamais partagé avec les autres onglets, effacé à la fermeture. Le
storage de l'extension ferait l'inverse, et un défaut oublié y survivrait des semaines.

Le clic court écrit alors `savedItems` **et** `collections` dans un seul `set` (voir
`toggleItem()` dans `content.ts`), via la même primitive d'ordre que le rangement manuel
: `placeInOrder()` de `shared/collections.ts`. Une collection épinglée puis supprimée
depuis le panneau ne laisse pas de référence morte — `syncTabDefault()` retire l'épingle
à la notification du storage.

**Une collection se supprime même pleine** (`deleteCollection`) — jamais « Mes favoris
», qui n'en est pas une. Ses articles ne sont pas perdus : ils redeviennent non classés
et restent dans le récapitulatif, le champ étant effacé sur chacun dans la même section
critique que la suppression. La règle « seulement si vide » qui valait avant protégeait
d'une perte qui ne peut plus se produire ; c'est désormais le panneau qui demande
confirmation, en annonçant le nombre d'articles concernés.

## Concurrence

Toute écriture passe par `update()` de [`shared/storage.ts`](../src/shared/storage.ts),
qui relit le storage, applique la transformation et réécrit — **sans qu'aucune autre
écriture du même contexte ne puisse s'intercaler entre les trois**. Les mutations sont
sérialisées dans une file unique, une seule pour toutes les clés : une file par clé
ferait prendre deux verrous aux opérations qui touchent `savedItems` et `collections`,
et deux verrous pris dans un ordre variable finissent en interblocage.

La relecture seule ne suffisait pas. `chrome.storage.local.get()` rend une promesse :
entre le `get` et le `set`, la boucle d'événements passe la main, et deux écritures
lancées dans le même onglet s'entrelacent —

```
enrichissement  get(savedItems) ──────────────► set({a, b'})
clic utilisateur       get(savedItems) ──► set({a, b, c})
                                               ▲ écrase c
```

— ce qui fait disparaître l'article tout juste enregistré, sans erreur en console. Le
content script fait tourner en parallèle une file d'enrichissement, un cycle de suivi de
prix et les gestes de l'utilisateur : le cas n'a rien de théorique.
`tests/storage.test.ts` le reproduit.

Ce que cela ne couvre pas : deux onglets Vinted sont deux contextes JavaScript, chacun
avec sa file. `chrome.storage` n'offre ni transaction ni comparaison-échange ; la
relecture juste avant l'écriture reste ce qui s'en approche le plus, et c'est ce que
`update()` impose par construction.

`chrome.storage.onChanged` propage ensuite le changement à tous les onglets et au
panneau, qui repeignent leur état. Attention : `onChanged` notifie **aussi** l'onglet
qui vient d'écrire. C'est le chaînon qui a provoqué la boucle de repeint décrite dans
[pitfalls.md](pitfalls.md).

## La galerie de photos

`images` porte toutes les photos de la fiche, lues par `shared/photos.ts`. Deux
particularités valent d'être connues avant d'y toucher :

- **rien n'est dérivé.** Les URLs Vinted se terminent par une signature (`?s=…`) liée à
  l'URL exacte : réécrire `f800` en autre chose pour obtenir une autre taille produit
  un 404. Les trois tailles viennent donc toutes de la page, telles quelles ;
- **le champ n'est jamais un tableau vide.** `mergeDetail()` ignore `undefined` mais
  recopierait un `[]` : une fiche devenue illisible effacerait alors une galerie déjà
  lue. `extractPhotos()` rend `undefined` quand il n'a rien trouvé.

Un article dont la fiche n'a jamais pu être lue n'a pas de galerie : sa miniature ouvre
l'onglet Vinted. Rien ne va la chercher après coup — il faudrait refetcher la fiche,
pour un gain que le prochain enregistrement apporte de lui-même.

## Identifiants : deux sources par champ

Marque et vendeur se lisent deux fois, et l'ordre n'est pas indifférent :

| Champ      | Source préférée                           | Repli               |
| ---------- | ----------------------------------------- | ------------------- |
| `brandId`  | maillon `/brand/53-nike` du fil d'Ariane  | `brand_id` du flux  |
| `sellerId` | lien `/member/{id}` de la cellule vendeur | `seller_id` du flux |

Le DOM rendu côté serveur passe devant parce qu'il est du **contenu** pour Vinted — le
fil d'Ariane sert son référencement — là où le flux d'hydratation n'est qu'un détail
d'implémentation de son rendu React, libre de changer sans préavis. Le repli existe
quand même : un article sans marque référencée n'a pas de maillon de marque.

**La réputation du vendeur inverse cet ordre**, et c'est la seule exception :

| Champ                 | Source préférée                      | Repli                          |
| --------------------- | ------------------------------------ | ------------------------------ |
| `sellerRating`        | `feedback_reputation` du flux (0..1) | `aria-label` du bloc d'étoiles |
| `sellerFeedbackCount` | `feedback_count` du flux             | dernier enfant du même bloc    |

Le DOM ne leur donne ici aucun `data-testid` : la note ne se lit que dans un libellé
d'accessibilité traduit (« Le membre est noté 4.7 sur 5 »), et le compteur dans un nœud
qui n'est identifiable que par sa classe — ce que la règle 4 interdit. Le flux, lui,
nomme les deux valeurs et ne dépend pas de la langue.

Les cinq clés du flux (`favourite_count`, `brand_id`, `seller_id`, `feedback_count`,
`feedback_reputation`) sont lues en **une seule passe** par `shared/hydration.ts` : une
fiche porte ~240 scripts, dont un de 1 Mo.

`sellerCountry` n'a, lui, **aucune source sur la fiche** : le pays n'est ni dans le DOM,
ni dans le JSON-LD, ni dans le flux. Il se lit sur `/member/{sellerId}`, dans une
requête séparée faite après l'enrichissement — même principe que `sizeId`, l'article
n'attend pas ce champ pour être complet. Le pays d'un compte ne changeant pas, il n'est
**jamais relu** : un article qui a déjà la réponse (`null` compris, profil sans
localisation) ne redemande rien, et un cache mémoire évite de relire le même profil pour
cinq pièces du même dressing. Voir `shared/seller.ts` et `completeSellerCountry()`.

`brandId` n'est pas un confort d'affichage : c'est le seul filtre de marque que le
catalogue accepte (`brand_ids[]` ignore un nom), donc la condition pour que « rechercher
un article similaire » cherche vraiment la même marque.

`sizeId` n'a lui aucune source dans la page : il est **résolu**, depuis le libellé et la
catégorie, par la seule requête d'API du projet — et dans une écriture séparée, après
celle de la fiche. L'article n'attend pas ce champ pour être complet : `pending` est
déjà levé, la taille exacte le rejoint. Voir `shared/size-ids.ts` et `completeSizeId()`.

Comme la galerie, ces champs ne sont jamais rattrapés : un article dont la fiche n'a pas
répondu les acquiert au prochain enregistrement, pas avant.

## Quota

`chrome.storage.local` offre 10 Mo. On ne stocke que des URLs d'images, jamais les
images elles-mêmes : plusieurs milliers d'articles tiennent sans problème. La galerie
ajoute environ 1,3 Ko par article de trois photos — 5 Ko pour un article qui en porte
douze, et la description jusqu'à 1,2 Ko de plus (elle est tronquée pour cette raison).
