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
import type { Collection, CollectionMap, ItemMap } from './types.ts';

export const ITEMS_KEY = 'savedItems';
export const COLLECTIONS_KEY = 'collections';

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

type Stored = { [ITEMS_KEY]?: ItemMap; [COLLECTIONS_KEY]?: CollectionMap };

/**
 * Les collections telles qu'elles sont rangées, la collection par défaut
 * garantie présente — elle n'est écrite en storage qu'au premier rangement,
 * ce qui laisserait un menu vide sur une installation neuve.
 */
export async function readCollections(): Promise<CollectionMap> {
  const res: Stored = await chrome.storage.local.get(COLLECTIONS_KEY);
  const collections: CollectionMap = { ...(res[COLLECTIONS_KEY] || {}) };
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

  const res: Stored = await chrome.storage.local.get(COLLECTIONS_KEY);
  await chrome.storage.local.set({
    [COLLECTIONS_KEY]: { ...(res[COLLECTIONS_KEY] || {}), [collection.id]: collection },
  });

  return collection;
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
  const res: Stored = await chrome.storage.local.get([ITEMS_KEY, COLLECTIONS_KEY]);

  const items: ItemMap = res[ITEMS_KEY] || {};
  const item = items[itemId];
  // L'article a pu être retiré depuis un autre onglet pendant que le menu était
  // ouvert : ne pas le ressusciter par un rangement.
  if (!item) return;

  const collections: CollectionMap = { ...(res[COLLECTIONS_KEY] || {}) };
  if (!collections[DEFAULT_COLLECTION_ID]) {
    collections[DEFAULT_COLLECTION_ID] = makeDefaultCollection();
  }
  // Collection disparue entre l'ouverture du menu et le choix : rien à faire
  // plutôt qu'écrire une référence morte.
  if (!collections[collectionId]) return;

  const nextCollections: CollectionMap = {};
  for (const [id, collection] of Object.entries(collections)) {
    const order = (collection.order || []).filter((entry) => entry !== itemId);
    nextCollections[id] =
      id === collectionId ? { ...collection, order: [itemId, ...order] } : { ...collection, order };
  }

  await chrome.storage.local.set({
    [ITEMS_KEY]: { ...items, [itemId]: { ...item, collectionId } },
    [COLLECTIONS_KEY]: nextCollections,
  });
}
