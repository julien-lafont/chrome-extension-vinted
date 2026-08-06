/**
 * Vinted Smart Bookmarks — les gestes du panneau sur le stockage.
 *
 * Quatre des cinq clés passent par ici :
 *   savedItems  { [id]: item }                        écrit aussi par le content script
 *   collections { [id]: { id, name, createdAt, order } }  écrit aussi par le content script
 *   settings    { activeCollectionId, sortMode, sortDir }
 *   noise       règles de filtrage du catalogue       écrit aussi par le content script
 *
 * (`watch` est la cinquième : le suivi de prix la lit et l'écrit depuis
 * `sidepanel/watch.ts` et le content script.)
 *
 * Les clés, leur forme et la primitive de lecture-écriture vivent dans
 * `shared/storage.ts` — ce fichier n'exprime que ce que le panneau en fait.
 * Chaque `update()` y relit le storage et s'exécute sans qu'aucune autre
 * écriture ne s'intercale ; c'est ce qui autorise à décider *dans* la mutation
 * (`deleteCollection` refuse une collection qu'un autre onglet vient de remplir).
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
  OFFERS_VIEW_ID,
  assignCollection,
  collectionOf,
  createCollection,
  isView,
  makeArchiveCollection,
  makeDefaultCollection,
  sortCollections,
} from '../shared/collections.ts';
import { normalizeNoise } from '../shared/noise.ts';
import type { NoiseFilters } from '../shared/noise.ts';
import { patchNoise } from '../shared/noise-storage.ts';
import { NOISE_KEY, SETTINGS_KEY, read, update } from '../shared/storage.ts';
import type { Collection, CollectionMap, SavedItem, Settings } from '../shared/types.ts';

export {
  ARCHIVE_COLLECTION_ID,
  COLLECTIONS_KEY,
  DEFAULT_COLLECTION_ID,
  ITEMS_KEY,
  NOISE_KEY,
  OFFERS_VIEW_ID,
  SETTINGS_KEY,
  collectionOf,
  createCollection,
  isView,
  sortCollections,
};

/** Le rangement d'un article est le même geste depuis le panneau et depuis une carte. */
export const moveItemToCollection = assignCollection;

const DEFAULT_SETTINGS: Settings = {
  activeCollectionId: DEFAULT_COLLECTION_ID,
  sortMode: 'custom',
  sortDir: 'asc',
  hideSold: false,
  revealHidden: false,
  hideAds: false,
};

// --- Lecture -----------------------------------------------------------------

export type Snapshot = {
  items: SavedItem[];
  collections: CollectionMap;
  settings: Settings;
  noise: NoiseFilters;
};

export async function readAll(): Promise<Snapshot> {
  const res = await read(ITEMS_KEY, COLLECTIONS_KEY, SETTINGS_KEY, NOISE_KEY);

  const collections: CollectionMap = { ...(res[COLLECTIONS_KEY] || {}) };
  if (!collections[DEFAULT_COLLECTION_ID]) {
    collections[DEFAULT_COLLECTION_ID] = makeDefaultCollection();
  }

  const settings = { ...DEFAULT_SETTINGS, ...(res[SETTINGS_KEY] || {}) };
  const items = Object.values(res[ITEMS_KEY] || {});

  // La collection active a pu être supprimée depuis une autre fenêtre. Une vue
  // (`view:…`) n'est pas dans `collections` et n'a donc rien à y trouver : elle
  // ne survit qu'à la condition d'avoir encore quelque chose à montrer — son
  // onglet disparaît avec la dernière offre, et l'y laisser afficherait une
  // liste vide sans onglet actif visible.
  const activeId = settings.activeCollectionId;
  const viewIsLive = activeId === OFFERS_VIEW_ID && items.some((item) => item.offer);

  if (!viewIsLive && !collections[activeId]) {
    settings.activeCollectionId = DEFAULT_COLLECTION_ID;
  }

  return {
    items,
    collections,
    settings,
    noise: normalizeNoise(res[NOISE_KEY]),
  };
}

/**
 * Réécriture des règles de filtrage : le même geste depuis le panneau et depuis
 * une carte, donc la même primitive — voir `shared/noise-storage.ts`.
 */
export const updateNoise = patchNoise;

// --- Écriture ----------------------------------------------------------------

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  let next: Settings = DEFAULT_SETTINGS;

  await update([SETTINGS_KEY], (current) => {
    next = { ...DEFAULT_SETTINGS, ...(current[SETTINGS_KEY] || {}), ...patch };
    return { [SETTINGS_KEY]: next };
  });

  return next;
}

export async function renameCollection(id: string, name: string): Promise<void> {
  await update([COLLECTIONS_KEY], (current) => {
    const collections = current[COLLECTIONS_KEY] || {};
    const collection = collections[id];
    if (!collection) return null;
    return { [COLLECTIONS_KEY]: { ...collections, [id]: { ...collection, name: name.trim() } } };
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

  // Le verdict se décide sur l'état relu, dans la même section critique que
  // l'écriture : sans cela, un rangement concurrent glisserait un article dans
  // la collection entre le contrôle et la suppression.
  let result: DeleteResult = { ok: true };

  await update([ITEMS_KEY, COLLECTIONS_KEY], (current) => {
    const collections = current[COLLECTIONS_KEY] || {};
    if (!collections[id]) {
      result = { ok: false, reason: 'unknown' };
      return null;
    }

    const items = Object.values(current[ITEMS_KEY] || {});
    if (items.some((item) => item.collectionId === id)) {
      result = { ok: false, reason: 'not-empty' };
      return null;
    }

    const next = { ...collections };
    delete next[id];
    return { [COLLECTIONS_KEY]: next };
  });

  // Aucun article à rapatrier : la collection était vide. Une référence résiduelle
  // vers une collection disparue retomberait de toute façon sur celle par défaut.
  return result;
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
  let settings: Settings = DEFAULT_SETTINGS;

  await update([COLLECTIONS_KEY, SETTINGS_KEY], (current) => {
    const collections: CollectionMap = current[COLLECTIONS_KEY] || {};
    const collection: Collection = collections[collectionId] || {
      id: collectionId,
      name: 'Mes favoris',
      createdAt: Date.now(),
      order: [],
    };

    settings = {
      ...DEFAULT_SETTINGS,
      ...(current[SETTINGS_KEY] || {}),
      sortMode: 'custom',
      sortDir: 'asc',
    };

    return {
      [COLLECTIONS_KEY]: { ...collections, [collectionId]: { ...collection, order: orderedIds } },
      [SETTINGS_KEY]: settings,
    };
  });

  return settings;
}

/**
 * Retire un article et son entrée dans les ordres personnalisés.
 *
 * Les deux clés partent dans un **seul** `set`, pour la raison exposée sur
 * `commitCustomOrder()` : en deux écritures, le rendu déclenché par la première
 * montre une liste dont l'ordre cite encore un article qui n'existe plus.
 */
export async function removeItem(itemId: string): Promise<void> {
  await update([ITEMS_KEY, COLLECTIONS_KEY], (current) => {
    const items = { ...(current[ITEMS_KEY] || {}) };
    delete items[itemId];

    const collections: CollectionMap = {};
    for (const [id, collection] of Object.entries(current[COLLECTIONS_KEY] || {})) {
      collections[id] = {
        ...collection,
        order: (collection.order || []).filter((e) => e !== itemId),
      };
    }

    return { [ITEMS_KEY]: items, [COLLECTIONS_KEY]: collections };
  });
}

/**
 * Remet un article retiré par erreur. Utilisé par le « Annuler » du panneau
 * (fenêtre de quelques secondes après un retrait) : on réécrit l'article tel
 * quel et on le replace en tête de l'ordre personnalisé de sa collection.
 */
export async function restoreItem(item: SavedItem): Promise<void> {
  const collectionId = item.collectionId || DEFAULT_COLLECTION_ID;

  await update([ITEMS_KEY, COLLECTIONS_KEY], (current) => {
    const items = { ...(current[ITEMS_KEY] || {}), [item.id]: item };
    const collections = current[COLLECTIONS_KEY] || {};

    const collection = collections[collectionId];
    if (!collection || (collection.order || []).includes(item.id)) {
      return { [ITEMS_KEY]: items };
    }

    return {
      [ITEMS_KEY]: items,
      [COLLECTIONS_KEY]: {
        ...collections,
        [collectionId]: { ...collection, order: [item.id, ...collection.order] },
      },
    };
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
  const result: ArchiveResult = { movedIds: [], sourceCollectionId: collectionId };

  await update([ITEMS_KEY, COLLECTIONS_KEY], (current) => {
    const items = current[ITEMS_KEY] || {};
    const collections: CollectionMap = { ...(current[COLLECTIONS_KEY] || {}) };

    const targets = Object.values(items).filter(
      (item) =>
        collectionOf(item, collections) === collectionId &&
        (item.status === 'sold' || item.status === 'gone')
    );
    if (!targets.length) return null;

    if (!collections[ARCHIVE_COLLECTION_ID]) {
      collections[ARCHIVE_COLLECTION_ID] = makeArchiveCollection();
    }

    const movedIds = targets.map((item) => item.id);
    const moved = new Set(movedIds);
    result.movedIds = movedIds;

    const nextItems = { ...items };
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

    return { [ITEMS_KEY]: nextItems, [COLLECTIONS_KEY]: nextCollections };
  });

  return result;
}

/** Annule un archivage : remet chaque article dans la collection d'où il venait. */
export async function restoreArchived({
  movedIds,
  sourceCollectionId,
}: ArchiveResult): Promise<void> {
  if (!movedIds.length) return;
  const moved = new Set(movedIds);

  await update([ITEMS_KEY, COLLECTIONS_KEY], (current) => {
    const items = current[ITEMS_KEY] || {};
    const collections = current[COLLECTIONS_KEY] || {};

    const nextItems = { ...items };
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

    return { [ITEMS_KEY]: nextItems, [COLLECTIONS_KEY]: nextCollections };
  });
}
