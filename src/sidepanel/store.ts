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
 * Un article est classé dans une collection via `item.collectionId`, **en plus**
 * d'apparaître dans « Mes favoris », qui récapitule tout ce qui est enregistré.
 * Le content script ne renseigne ce champ qu'à la capture avec choix de
 * collection (appui long) : un article sans collection connue est simplement non
 * classé, sans migration nécessaire pour l'afficher.
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
  classifiedIn,
  createCollection,
  isInTab,
  isView,
  makeArchiveCollection,
  makeDefaultCollection,
  sortCollections,
} from '../shared/collections.ts';
import { migrateStorage } from '../shared/migrate.ts';
import { normalizeNoise } from '../shared/noise.ts';
import type { NoiseFilters } from '../shared/noise.ts';
import { patchNoise } from '../shared/noise-storage.ts';
import { NOISE_KEY, SETTINGS_KEY, read, update } from '../shared/storage.ts';
import type { Collection, CollectionMap, ItemMap, SavedItem, Settings } from '../shared/types.ts';

export {
  ARCHIVE_COLLECTION_ID,
  COLLECTIONS_KEY,
  DEFAULT_COLLECTION_ID,
  ITEMS_KEY,
  NOISE_KEY,
  OFFERS_VIEW_ID,
  SETTINGS_KEY,
  classifiedIn,
  createCollection,
  isInTab,
  isView,
  migrateStorage,
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
  { ok: true; freed: number } | { ok: false; reason: 'default' | 'unknown' };

/**
 * Supprime une collection, **même pleine**.
 *
 * Ce qu'elle contenait n'est pas perdu : depuis que « Mes favoris » récapitule
 * tout, un article déclassé y reste affiché — la collection n'est qu'une
 * étiquette, la retirer ne retire rien. La règle « seulement si vide » qui valait
 * avant protégeait d'une perte qui ne peut plus se produire ; c'est au panneau de
 * demander confirmation quand il reste des articles.
 *
 * Le champ est effacé sur chaque article dans la **même** section critique :
 * `classifiedIn()` lirait de toute façon une référence morte comme « non
 * classé », mais un identifiant qui ne désigne plus rien finit par être lu comme
 * s'il désignait quelque chose (export, diagnostic).
 *
 * @returns le nombre d'articles déclassés au passage
 */
export async function deleteCollection(id: string): Promise<DeleteResult> {
  if (id === DEFAULT_COLLECTION_ID) return { ok: false, reason: 'default' };

  // Le verdict se décide sur l'état relu, dans la même section critique que
  // l'écriture : un autre onglet a pu supprimer la collection entre-temps.
  let result: DeleteResult = { ok: true, freed: 0 };

  await update([ITEMS_KEY, COLLECTIONS_KEY], (current) => {
    const collections = current[COLLECTIONS_KEY] || {};
    if (!collections[id]) {
      result = { ok: false, reason: 'unknown' };
      return null;
    }

    const items = current[ITEMS_KEY] || {};
    const nextItems: ItemMap = {};
    let freed = 0;

    for (const [itemId, item] of Object.entries(items)) {
      if (item.collectionId !== id) {
        nextItems[itemId] = item;
        continue;
      }
      const next: SavedItem = { ...item };
      delete next.collectionId;
      nextItems[itemId] = next;
      freed += 1;
    }

    result = { ok: true, freed };

    const nextCollections = { ...collections };
    delete nextCollections[id];
    return { [ITEMS_KEY]: nextItems, [COLLECTIONS_KEY]: nextCollections };
  });

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

/**
 * Ce qu'un archivage a déplacé, de quoi l'annuler — §6.5.
 *
 * L'origine est notée **par article**, et pas une fois pour toute l'opération :
 * depuis « Mes favoris », l'archivage balaie tous les vendus, quelle que soit
 * leur collection. Une origine unique les rendrait tous à la même — c'est-à-dire
 * les déclasserait en bloc, en silence, sur un simple « Annuler ».
 */
export type ArchivedItem = { id: string; from: string | null };
export type ArchiveResult = { moved: ArchivedItem[] };

/**
 * Déplace vers « Archives » — créée à la demande au premier usage — les articles
 * `sold`/`gone` **affichés sous l'onglet courant** : ceux d'une collection
 * donnée, ou tous depuis « Mes favoris ».
 *
 * Pas une suppression, et réversible via `restoreArchived()` — sur le modèle
 * exact de l'annulation de retrait ci-dessus, en un seul `set` pour les mêmes
 * raisons que `commitCustomOrder` : deux écritures successives (articles, puis
 * collections) déclencheraient deux rendus, et le premier verrait des articles
 * déjà déplacés dans une « Archives » qui n'existe pas encore.
 */
export async function archiveSold(tabId: string): Promise<ArchiveResult> {
  const result: ArchiveResult = { moved: [] };

  await update([ITEMS_KEY, COLLECTIONS_KEY], (current) => {
    const items = current[ITEMS_KEY] || {};
    const collections: CollectionMap = { ...(current[COLLECTIONS_KEY] || {}) };

    const targets = Object.values(items).filter(
      (item) =>
        isInTab(item, tabId, collections) && (item.status === 'sold' || item.status === 'gone')
    );
    if (!targets.length) return null;

    if (!collections[ARCHIVE_COLLECTION_ID]) {
      collections[ARCHIVE_COLLECTION_ID] = makeArchiveCollection();
    }

    result.moved = targets.map((item) => ({
      id: item.id,
      from: classifiedIn(item, collections)?.id ?? null,
    }));

    const movedIds = result.moved.map((entry) => entry.id);
    const moved = new Set(movedIds);

    const nextItems = { ...items };
    for (const id of movedIds) {
      const item = nextItems[id];
      if (item) nextItems[id] = { ...item, collectionId: ARCHIVE_COLLECTION_ID };
    }

    // Les archivés quittent « Mes favoris » : leur place dans l'ordre global
    // part avec eux, et `restoreArchived()` la leur rend.
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

/** Annule un archivage : remet chaque article là où il était classé, ou nulle part. */
export async function restoreArchived({ moved }: ArchiveResult): Promise<void> {
  if (!moved.length) return;
  const back = new Map(moved.map((entry) => [entry.id, entry.from]));

  await update([ITEMS_KEY, COLLECTIONS_KEY], (current) => {
    const items = current[ITEMS_KEY] || {};
    const collections = current[COLLECTIONS_KEY] || {};

    const nextItems = { ...items };
    // Où chaque article revient **vraiment** : la collection d'origine a pu être
    // supprimée pendant les cinq secondes d'annulation, auquel cas l'article
    // revient non classé plutôt que sur une référence morte.
    const target = new Map<string, string | null>();

    for (const [id, from] of back) {
      const item = nextItems[id];
      if (!item) continue;

      const to = from && collections[from] ? from : null;
      target.set(id, to);

      const patched: SavedItem = { ...item, collectionId: to ?? undefined };
      // Non classé s'écrit par l'absence du champ, jamais par `'default'` : c'est
      // la seule forme que le content script produit, et deux écritures pour un
      // même état finissent par se lire différemment quelque part.
      if (!to) delete patched.collectionId;
      nextItems[id] = patched;
    }

    // Chaque article reprend la tête de l'ordre d'où il venait — celui de sa
    // collection s'il en avait une, celui de la vue globale sinon.
    const nextCollections: CollectionMap = {};
    for (const [id, collection] of Object.entries(collections)) {
      const order = (collection.order || []).filter((entryId) => !back.has(entryId));
      const returning = [...target]
        .filter(([, to]) => (to ?? DEFAULT_COLLECTION_ID) === id)
        .map(([itemId]) => itemId);

      nextCollections[id] = returning.length
        ? { ...collection, order: [...returning, ...order] }
        : { ...collection, order };
    }

    return { [ITEMS_KEY]: nextItems, [COLLECTIONS_KEY]: nextCollections };
  });
}
