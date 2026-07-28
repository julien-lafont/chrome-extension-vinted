/**
 * Vinted Favoris — accès au stockage.
 *
 * Trois clés dans chrome.storage.local :
 *   savedItems  { [id]: item }                        écrit aussi par le content script
 *   collections { [id]: { id, name, createdAt, order } }  écrit aussi par le content script
 *   settings    { activeCollectionId, sortMode, sortDir, offer }
 *
 * Un article appartient à une collection via `item.collectionId`. Le content
 * script ne renseigne ce champ qu'à la capture avec choix de collection (appui
 * long) : un article sans collection connue retombe sur la collection par
 * défaut, sans migration nécessaire.
 *
 * Ce qui touche à la clé `collections` vit dans `shared/collections.ts` depuis
 * que le content script y écrit lui aussi, et n'est que réexporté ici — le
 * panneau continue de tout importer depuis ce fichier.
 */

import {
  ARCHIVE_COLLECTION_ID,
  COLLECTIONS_KEY,
  DEFAULT_COLLECTION_ID,
  ITEMS_KEY,
  assignCollection,
  collectionOf,
  createCollection,
  makeArchiveCollection,
  makeDefaultCollection,
  sortCollections,
} from '../shared/collections.ts';
import type { Collection, CollectionMap, ItemMap, SavedItem, Settings } from '../shared/types.ts';

export {
  ARCHIVE_COLLECTION_ID,
  COLLECTIONS_KEY,
  DEFAULT_COLLECTION_ID,
  ITEMS_KEY,
  collectionOf,
  createCollection,
  sortCollections,
};

export const SETTINGS_KEY = 'settings';

/** Le rangement d'un article est le même geste depuis le panneau et depuis une carte. */
export const moveItemToCollection = assignCollection;

const DEFAULT_SETTINGS: Settings = {
  activeCollectionId: DEFAULT_COLLECTION_ID,
  sortMode: 'custom',
  sortDir: 'asc',
  offer: { discount: 15, autoMessage: true },
  hideSold: false,
};

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

/** Ce qu'un archivage a déplacé, de quoi l'annuler — §6.5. */
export type ArchiveResult = { movedIds: string[]; sourceCollectionId: string };

/**
 * Déplace les articles `sold`/`gone` d'**une** collection vers « Archives »,
 * créée à la demande au premier usage. Pas une suppression, et réversible via
 * `restoreArchived()` — sur le modèle exact de l'annulation de retrait
 * ci-dessus, en un seul `set` pour les mêmes raisons que `commitCustomOrder` :
 * deux écritures successives (articles, puis collections) déclencheraient deux
 * rendus, et le premier verrait des articles déjà déplacés dans une
 * « Archives » qui n'existe pas encore.
 */
export async function archiveSold(collectionId: string): Promise<ArchiveResult> {
  const res = await read(ITEMS_KEY, COLLECTIONS_KEY);
  const items = res[ITEMS_KEY] || {};
  const collections: CollectionMap = { ...(res[COLLECTIONS_KEY] || {}) };

  const targets = Object.values(items).filter(
    (item) =>
      collectionOf(item, collections) === collectionId &&
      (item.status === 'sold' || item.status === 'gone')
  );
  if (!targets.length) return { movedIds: [], sourceCollectionId: collectionId };

  if (!collections[ARCHIVE_COLLECTION_ID]) {
    collections[ARCHIVE_COLLECTION_ID] = makeArchiveCollection();
  }

  const movedIds = targets.map((item) => item.id);
  const moved = new Set(movedIds);

  const nextItems: ItemMap = { ...items };
  for (const id of movedIds) {
    const item = nextItems[id];
    if (item) nextItems[id] = { ...item, collectionId: ARCHIVE_COLLECTION_ID };
  }

  const nextCollections: CollectionMap = {};
  for (const [id, collection] of Object.entries(collections)) {
    const order = (collection.order || []).filter((entryId) => !moved.has(entryId));
    nextCollections[id] =
      id === ARCHIVE_COLLECTION_ID
        ? { ...collection, order: [...movedIds, ...order] }
        : { ...collection, order };
  }

  await chrome.storage.local.set({ [ITEMS_KEY]: nextItems, [COLLECTIONS_KEY]: nextCollections });
  return { movedIds, sourceCollectionId: collectionId };
}

/** Annule un archivage : remet chaque article dans la collection d'où il venait. */
export async function restoreArchived({
  movedIds,
  sourceCollectionId,
}: ArchiveResult): Promise<void> {
  if (!movedIds.length) return;

  const res = await read(ITEMS_KEY, COLLECTIONS_KEY);
  const items = res[ITEMS_KEY] || {};
  const collections = res[COLLECTIONS_KEY] || {};
  const moved = new Set(movedIds);

  const nextItems: ItemMap = { ...items };
  for (const id of movedIds) {
    const item = nextItems[id];
    if (!item) continue;
    const patched: SavedItem = { ...item, collectionId: sourceCollectionId };
    // Absent = collection par défaut (voir `collectionOf()`) : ne pas écrire
    // une valeur qui vaudrait la même chose, pour rester cohérent avec ce que
    // le content script produit lui-même (il ne renseigne jamais ce champ).
    if (sourceCollectionId === DEFAULT_COLLECTION_ID) delete patched.collectionId;
    nextItems[id] = patched;
  }

  const nextCollections: CollectionMap = {};
  for (const [id, collection] of Object.entries(collections)) {
    const order = (collection.order || []).filter((entryId) => !moved.has(entryId));
    nextCollections[id] =
      id === sourceCollectionId
        ? { ...collection, order: [...movedIds, ...order] }
        : { ...collection, order };
  }

  await chrome.storage.local.set({ [ITEMS_KEY]: nextItems, [COLLECTIONS_KEY]: nextCollections });
}
