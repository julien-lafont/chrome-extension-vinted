# Architecture

## Fichiers

```
src/manifest.ts                    manifeste typé ; version lue depuis package.json
icons/                             icônes générées (marque-page sur fond teal)
src/
  background/service-worker.ts     ouvre le panneau au clic sur l'icône
  content/content.ts               extraction + injection des boutons
  content/content.css              styles des boutons injectés
  content/offer-agent.ts           pilotage de la modale d'offre Vinted
  sidepanel/sidepanel.ts           orchestration de l'interface
  sidepanel/store.ts               lecture/écriture chrome.storage.local
  sidepanel/sorting.ts             clés et modes de tri
  sidepanel/dnd.ts                 réorganisation par glisser-déposer
  sidepanel/offer.ts               composition du message + pilotage de l'onglet
  sidepanel/search.ts              URLs de catalogue (similaires, marque)
  shared/types.ts                  modèle de données (SavedItem, Collection, Settings)
  shared/messages.ts               protocole panneau ↔ content scripts
  shared/price.ts                  lecture d'un prix affiché par Vinted
  shared/errors.ts                 message lisible d'une erreur attrapée
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

## Les deux content scripts

`content.ts` s'exécute sur tout `https://www.vinted.fr/*` : il injecte les boutons
d'enregistrement et lit les métadonnées des articles.

`offer-agent.ts` est **distinct**, déclaré sur `https://www.vinted.fr/items/*`
seulement. Les deux ne partagent aucun état : l'agent reste inerte tant que le panneau
ne lui envoie pas de message. Cette séparation évite qu'un bug du pilotage d'offre — le
code le plus fragile, puisqu'il dépend d'ancres non vérifiées — n'empêche
l'enregistrement des favoris de fonctionner.

## Stockage

Trois clés dans `chrome.storage.local`.

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
    savedAt: 1753500000000,
    source: 'catalog', // ou "detail"
    collectionId: 'col-lq3x8f-4b2', // absent = collection par défaut
  },
};

collections = {
  default: { id: 'default', name: 'Mes favoris', createdAt: 0, order: [] },
  'col-lq3x8f-4b2': {
    id: 'col-lq3x8f-4b2',
    name: 'Jeans',
    createdAt: 1753500000000,
    order: ['9496908003', '9481120044'],
  },
};

settings = {
  activeCollectionId: 'default',
  sortMode: 'custom', // custom | savedAt | price | condition | likes | size
  sortDir: 'asc',
  offer: { discount: 15, autoMessage: true },
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

clic sur une fiche
  → extractFromDetail(document), écriture unique, pas de requête
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

L'appartenance à une collection vit sur l'**article** (`collectionId`), l'ordre manuel
vit sur la **collection** (`order`).

C'est ce qui permet au content script d'écrire dans `savedItems` sans rien savoir des
collections. Un article sans `collectionId` — ou pointant vers une collection supprimée
— retombe sur la collection par défaut, sans migration ni réparation. `order` ne
référence que les articles déjà réordonnés à la main ; un ajout récent apparaît en tête
tant qu'on ne l'a pas déplacé.

**Une collection ne se supprime que vide** (`deleteCollection`), et jamais celle par
défaut. La vérification est faite dans le storage après relecture, pas seulement à
l'affichage : la croix est rendue à partir d'un état qui peut dater d'avant qu'un autre
onglet y classe un article. Le panneau se contente d'afficher la croix quand le compteur
est à zéro ; c'est le store qui tranche, et qui renvoie
`{ ok: false, reason: 'not-empty' }` le cas échéant. Aucun article n'est donc jamais
déplacé par une suppression.

## Concurrence

Plusieurs onglets Vinted peuvent écrire en même temps. Toute écriture relit donc le
storage juste avant d'écrire, plutôt que de partir d'un état en cache.
`chrome.storage.onChanged` propage ensuite le changement à tous les onglets et au
panneau, qui repeignent leur état.

Attention : `onChanged` notifie **aussi** l'onglet qui vient d'écrire. C'est le chaînon
qui a provoqué la boucle de repeint décrite dans [pitfalls.md](pitfalls.md).

## Quota

`chrome.storage.local` offre 10 Mo. On ne stocke que des URLs d'images, jamais les
images elles-mêmes : plusieurs milliers d'articles tiennent sans problème.
