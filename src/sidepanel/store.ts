/**
 * Vinted Favoris — accès au stockage.
 *
 * Trois clés dans chrome.storage.local :
 *   savedItems  { [id]: item }                        écrit aussi par le content script
 *   collections { [id]: { id, name, createdAt, order } }  order = ordre personnalisé (ids)
 *   settings    { activeCollectionId, sortMode, sortDir, offer }
 *
 * Un article appartient à une collection via `item.collectionId`. Le content
 * script ne renseigne pas ce champ : un article sans collection connue retombe
 * donc sur la collection par défaut, sans migration nécessaire.
 */

import type { Collection, CollectionMap, ItemMap, SavedItem, Settings } from '../shared/types.ts';

export const ITEMS_KEY = 'savedItems';
export const COLLECTIONS_KEY = 'collections';
export const SETTINGS_KEY = 'settings';

export const DEFAULT_COLLECTION_ID = 'default';

const DEFAULT_SETTINGS: Settings = {
  activeCollectionId: DEFAULT_COLLECTION_ID,
  sortMode: 'custom',
  sortDir: 'asc',
  offer: { discount: 15, autoMessage: true },
};

function makeDefaultCollection(): Collection {
  return {
    id: DEFAULT_COLLECTION_ID,
    name: 'Mes favoris',
    createdAt: 0, // toujours en tête de la liste des collections
    order: [],
  };
}

/** Identifiant court, lisible dans le storage : "col-lq3x8f-4b2". */
function newId(): string {
  return `col-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
}

/**
 * `chrome.storage.local.get` renvoie un objet indexé non typé. Toutes les
 * conversions vers le modèle passent par ici, plutôt que d'éparpiller des
 * assertions dans chaque lecture : le jour où le schéma stocké évolue, c'est le
 * seul endroit où poser une migration.
 */
type StoredShape = {
  [ITEMS_KEY]: ItemMap;
  [COLLECTIONS_KEY]: CollectionMap;
  [SETTINGS_KEY]: Partial<Settings>;
};

async function read<K extends keyof StoredShape>(...keys: K[]): Promise<Partial<StoredShape>> {
  return await chrome.storage.local.get(keys);
}

// --- Lecture -----------------------------------------------------------------

export type Snapshot = {
  items: SavedItem[];
  collections: CollectionMap;
  settings: Settings;
};

export async function readAll(): Promise<Snapshot> {
  const res = await read(ITEMS_KEY, COLLECTIONS_KEY, SETTINGS_KEY);

  const collections: CollectionMap = { ...(res[COLLECTIONS_KEY] || {}) };
  if (!collections[DEFAULT_COLLECTION_ID]) {
    collections[DEFAULT_COLLECTION_ID] = makeDefaultCollection();
  }

  const settings = { ...DEFAULT_SETTINGS, ...(res[SETTINGS_KEY] || {}) };
  settings.offer = { ...DEFAULT_SETTINGS.offer, ...(settings.offer || {}) };

  // La collection active a pu être supprimée depuis une autre fenêtre.
  if (!collections[settings.activeCollectionId]) {
    settings.activeCollectionId = DEFAULT_COLLECTION_ID;
  }

  return {
    items: Object.values(res[ITEMS_KEY] || {}),
    collections,
    settings,
  };
}

/** Collections triées : la collection par défaut d'abord, puis par date de création. */
export function sortCollections(collections: CollectionMap): Collection[] {
  return Object.values(collections).sort(
    (a, b) => (a.createdAt || 0) - (b.createdAt || 0) || a.name.localeCompare(b.name, 'fr')
  );
}

/** La collection d'un article, en retombant sur la collection par défaut. */
export function collectionOf(item: SavedItem, collections: CollectionMap): string {
  const id = item.collectionId;
  return id && collections[id] ? id : DEFAULT_COLLECTION_ID;
}

// --- Écriture ----------------------------------------------------------------

/**
 * Relit puis réécrit une clé de façon atomique côté extension : le content
 * script écrit sur `savedItems` en parallèle, on ne veut pas écraser son travail.
 */
async function update<K extends keyof StoredShape>(
  key: K,
  mutate: (current: NonNullable<StoredShape[K]>) => StoredShape[K]
): Promise<StoredShape[K]> {
  const res = await read(key);
  const current = (res[key] || {}) as NonNullable<StoredShape[K]>;
  const next = mutate(current);
  await chrome.storage.local.set({ [key]: next });
  return next;
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const res = await read(SETTINGS_KEY);
  const next: Settings = { ...DEFAULT_SETTINGS, ...(res[SETTINGS_KEY] || {}), ...patch };
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

export async function createCollection(name: string): Promise<Collection> {
  const collection = { id: newId(), name: name.trim(), createdAt: Date.now(), order: [] };
  await update(COLLECTIONS_KEY, (current) => ({ ...current, [collection.id]: collection }));
  return collection;
}

export async function renameCollection(id: string, name: string): Promise<void> {
  await update(COLLECTIONS_KEY, (current) => {
    const collection = current[id];
    if (!collection) return current;
    return { ...current, [id]: { ...collection, name: name.trim() } };
  });
}

export type DeleteResult =
  { ok: true } | { ok: false; reason: 'default' | 'not-empty' | 'unknown' };

/**
 * Supprime une collection **vide**.
 *
 * La règle est appliquée ici et pas seulement à l'affichage : le bouton est rendu
 * à partir d'un état qui peut dater, un autre onglet Vinted ayant pu y classer un
 * article entre-temps. On relit donc juste avant d'écrire, et on renonce plutôt
 * que de déplacer des articles à l'insu de l'utilisateur.
 *
 */
export async function deleteCollection(id: string): Promise<DeleteResult> {
  if (id === DEFAULT_COLLECTION_ID) return { ok: false, reason: 'default' };

  const res = await read(ITEMS_KEY, COLLECTIONS_KEY);
  const collections = res[COLLECTIONS_KEY] || {};
  if (!collections[id]) return { ok: false, reason: 'unknown' };

  const items = Object.values(res[ITEMS_KEY] || {});
  if (items.some((item) => item.collectionId === id)) {
    return { ok: false, reason: 'not-empty' };
  }

  const next = { ...collections };
  delete next[id];
  await chrome.storage.local.set({ [COLLECTIONS_KEY]: next });

  // Aucun article à rapatrier : la collection était vide. Une référence résiduelle
  // vers une collection disparue retomberait de toute façon sur celle par défaut.
  return { ok: true };
}

export async function moveItemToCollection(itemId: string, collectionId: string): Promise<void> {
  await update(ITEMS_KEY, (current) => {
    const item = current[itemId];
    if (!item) return current;
    return { ...current, [itemId]: { ...item, collectionId } };
  });

  // L'article quitte l'ordre personnalisé de son ancienne collection.
  await update(COLLECTIONS_KEY, (current) => {
    const next: CollectionMap = {};
    for (const [id, collection] of Object.entries(current)) {
      const order = (collection.order || []).filter((entry) => entry !== itemId);
      next[id] =
        id === collectionId
          ? { ...collection, order: [itemId, ...order] }
          : { ...collection, order };
    }
    return next;
  });
}

/**
 * Enregistre l'ordre personnalisé d'une collection (ids dans l'ordre affiché) et
 * bascule le tri en mode manuel.
 *
 * Les deux clés partent dans un seul `set` : deux écritures successives
 * déclencheraient deux rendus, et le premier — mode déjà manuel, ordre pas
 * encore écrit — ferait reculer la carte tout juste déposée avant qu'elle
 * reprenne sa place.
 *
 * @returns les réglages écrits
 */
export async function commitCustomOrder(
  collectionId: string,
  orderedIds: string[]
): Promise<Settings> {
  const res = await read(COLLECTIONS_KEY, SETTINGS_KEY);

  const collections: CollectionMap = res[COLLECTIONS_KEY] || {};
  const collection: Collection = collections[collectionId] || {
    id: collectionId,
    name: 'Mes favoris',
    createdAt: Date.now(),
    order: [],
  };

  const settings: Settings = {
    ...DEFAULT_SETTINGS,
    ...(res[SETTINGS_KEY] || {}),
    sortMode: 'custom',
    sortDir: 'asc',
  };

  await chrome.storage.local.set({
    [COLLECTIONS_KEY]: { ...collections, [collectionId]: { ...collection, order: orderedIds } },
    [SETTINGS_KEY]: settings,
  });

  return settings;
}

export async function removeItem(itemId: string): Promise<void> {
  await update(ITEMS_KEY, (current) => {
    const next = { ...current };
    delete next[itemId];
    return next;
  });

  await update(COLLECTIONS_KEY, (current) => {
    const next: CollectionMap = {};
    for (const [id, collection] of Object.entries(current)) {
      next[id] = { ...collection, order: (collection.order || []).filter((e) => e !== itemId) };
    }
    return next;
  });
}

/**
 * Remet un article retiré par erreur. Utilisé par le « Annuler » du panneau
 * (fenêtre de quelques secondes après un retrait) : on réécrit l'article tel
 * quel et on le replace en tête de l'ordre personnalisé de sa collection.
 */
export async function restoreItem(item: SavedItem): Promise<void> {
  await update(ITEMS_KEY, (current) => ({ ...current, [item.id]: item }));

  const collectionId = item.collectionId || DEFAULT_COLLECTION_ID;
  await update(COLLECTIONS_KEY, (current) => {
    const collection = current[collectionId];
    if (!collection || (collection.order || []).includes(item.id)) return current;
    return { ...current, [collectionId]: { ...collection, order: [item.id, ...collection.order] } };
  });
}
