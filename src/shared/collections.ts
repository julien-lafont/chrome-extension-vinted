/**
 * Vinted Favoris — les collections, côté storage.
 *
 * Ce module existe pour la même raison que le reste de `src/shared/` : deux
 * mondes écrivent désormais sur la clé `collections`. Le panneau le faisait
 * seul (glisser-déposer, menu « Déplacer vers ») ; depuis la capture avec choix
 * de collection, le content script y écrit aussi. Deux implémentations de la
 * même écriture auraient divergé — l'une réordonnant `order`, l'autre pas.
 *
 * `sidepanel/store.ts` réexporte ce qui suit : le panneau continue de tout
 * importer depuis `store.ts`, il n'a pas à savoir où vit la primitive.
 */
import { COLLECTIONS_KEY, ITEMS_KEY, read, update } from './storage.ts';
import type { Collection, CollectionMap } from './types.ts';

export { COLLECTIONS_KEY, ITEMS_KEY };

export const DEFAULT_COLLECTION_ID = 'default';

export function makeDefaultCollection(): Collection {
  return {
    id: DEFAULT_COLLECTION_ID,
    name: 'Mes favoris',
    createdAt: 0, // toujours en tête de la liste des collections
    order: [],
  };
}

/**
 * Collection d'archivage, créée à la demande au premier archivage — jamais à
 * l'avance. Ce n'est pas une destination de rangement mais un dépôt : elle est
 * écartée du choix de collection à la capture, et le panneau la rend à part
 * (une icône, sans compteur, tout à droite).
 */
export const ARCHIVE_COLLECTION_ID = 'archives';

export function makeArchiveCollection(): Collection {
  return { id: ARCHIVE_COLLECTION_ID, name: 'Archives', createdAt: Date.now(), order: [] };
}

/**
 * Vue « Sous offres » — `docs/specs/offres.md` §5.
 *
 * **Ce n'est pas une collection**, et rien dans ce module ne la traite comme
 * telle : elle n'existe pas dans `CollectionMap`, `collectionOf()` ne la rend
 * jamais, et un article sous offre reste rangé là où l'utilisateur l'a mis. Elle
 * ne vit que comme valeur de `settings.activeCollectionId`, que le panneau
 * interprète alors comme un filtre plutôt que comme un rangement.
 *
 * Le préfixe `view:` la distingue à coup sûr d'un identifiant de collection
 * (`col-…`, `default`, `archives`), y compris dans un storage déjà écrit.
 */
export const OFFERS_VIEW_ID = 'view:offers';

/** Une vue parallèle, pas une collection : rien ne s'y range, rien ne s'y dépose. */
export function isView(id: string): boolean {
  return id.startsWith('view:');
}

/** Identifiant court, lisible dans le storage : "col-lq3x8f-4b2". */
export function newCollectionId(): string {
  return `col-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
}

/**
 * Collections triées : la collection par défaut d'abord, « Archives » toujours
 * en dernier, le reste par date de création.
 *
 * La place d'« Archives » est fixée ici plutôt qu'à l'affichage : sa date de
 * création est celle du premier archivage, si bien qu'une collection créée après
 * elle la doublait dans la barre d'onglets. Ce n'est pas une collection parmi
 * d'autres, c'est le fond du tiroir — sa place ne dépend pas du calendrier.
 */
export function sortCollections(collections: CollectionMap): Collection[] {
  const rank = (c: Collection): number => (c.id === ARCHIVE_COLLECTION_ID ? 1 : 0);

  return Object.values(collections).sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (a.createdAt || 0) - (b.createdAt || 0) ||
      a.name.localeCompare(b.name, 'fr')
  );
}

/** La collection d'un article, en retombant sur la collection par défaut. */
export function collectionOf(item: { collectionId?: string }, collections: CollectionMap): string {
  const id = item.collectionId;
  return id && collections[id] ? id : DEFAULT_COLLECTION_ID;
}

/**
 * Les collections telles qu'elles sont rangées, la collection par défaut
 * garantie présente — elle n'est écrite en storage qu'au premier rangement,
 * ce qui laisserait un menu vide sur une installation neuve.
 */
export async function readCollections(): Promise<CollectionMap> {
  const res = await read(COLLECTIONS_KEY);
  return withDefault(res[COLLECTIONS_KEY]);
}

/** La carte des collections complétée de celle par défaut, sans toucher au storage. */
export function withDefault(stored: CollectionMap | undefined): CollectionMap {
  const collections: CollectionMap = { ...(stored || {}) };
  if (!collections[DEFAULT_COLLECTION_ID]) {
    collections[DEFAULT_COLLECTION_ID] = makeDefaultCollection();
  }
  return collections;
}

/** Crée une collection. Relit d'abord : un autre onglet a pu en créer une entre-temps. */
export async function createCollection(name: string): Promise<Collection> {
  const collection: Collection = {
    id: newCollectionId(),
    name: name.trim(),
    createdAt: Date.now(),
    order: [],
  };

  await update([COLLECTIONS_KEY], (current) => ({
    [COLLECTIONS_KEY]: { ...(current[COLLECTIONS_KEY] || {}), [collection.id]: collection },
  }));

  return collection;
}

/**
 * Les collections avec `itemId` en tête de l'ordre de `collectionId`, retiré de
 * l'ordre de toutes les autres.
 *
 * Pur, et exporté pour ça : deux appelants rangent un article, `assignCollection()`
 * ci-dessous et le clic court quand l'onglet a une collection par défaut (voir
 * `content.ts`). Le second écrit `savedItems` et `collections` dans le même `set`
 * et ne peut donc pas passer par le premier — sans cette fonction, l'ordre
 * personnalisé aurait deux implémentations, dont une oublierait le retrait des
 * autres collections.
 */
export function placeInOrder(
  collections: CollectionMap,
  itemId: string,
  collectionId: string
): CollectionMap {
  const next: CollectionMap = {};

  for (const [id, collection] of Object.entries(collections)) {
    const order = (collection.order || []).filter((entry) => entry !== itemId);
    next[id] =
      id === collectionId ? { ...collection, order: [itemId, ...order] } : { ...collection, order };
  }

  return next;
}

/**
 * Range un article dans une collection : pose `collectionId` et replace l'id en
 * tête de l'ordre personnalisé de la cible, en le retirant de toutes les autres.
 *
 * Les deux clés partent dans un **seul** `set`. Deux écritures successives
 * déclencheraient deux rendus du panneau, et le premier montrerait un article
 * déjà déplacé dont l'ordre n'a pas encore suivi — même raison que
 * `commitCustomOrder()` et `archiveSold()`.
 *
 * Relecture avant écriture (règle 6 du projet) : plusieurs onglets Vinted
 * écrivent sur `savedItems` en parallèle.
 */
export async function assignCollection(itemId: string, collectionId: string): Promise<void> {
  await update([ITEMS_KEY, COLLECTIONS_KEY], (current) => {
    const items = current[ITEMS_KEY] || {};
    const item = items[itemId];
    // L'article a pu être retiré depuis un autre onglet pendant que le menu était
    // ouvert : ne pas le ressusciter par un rangement.
    if (!item) return null;

    const collections = withDefault(current[COLLECTIONS_KEY]);
    // Collection disparue entre l'ouverture du menu et le choix : rien à faire
    // plutôt qu'écrire une référence morte.
    if (!collections[collectionId]) return null;

    return {
      [ITEMS_KEY]: { ...items, [itemId]: { ...item, collectionId } },
      [COLLECTIONS_KEY]: placeInOrder(collections, itemId, collectionId),
    };
  });
}
