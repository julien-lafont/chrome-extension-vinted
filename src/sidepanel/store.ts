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

export const ITEMS_KEY = 'savedItems';
export const COLLECTIONS_KEY = 'collections';
export const SETTINGS_KEY = 'settings';

export const DEFAULT_COLLECTION_ID = 'default';

const DEFAULT_SETTINGS = {
  activeCollectionId: DEFAULT_COLLECTION_ID,
  sortMode: 'custom',
  sortDir: 'asc',
  offer: { discount: 15, autoMessage: true },
};

function makeDefaultCollection() {
  return {
    id: DEFAULT_COLLECTION_ID,
    name: 'Mes favoris',
    createdAt: 0, // toujours en tête de la liste des collections
    order: [],
  };
}

/** Identifiant court, lisible dans le storage : "col-lq3x8f-4b2". */
function newId() {
  return `col-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
}

// --- Lecture -----------------------------------------------------------------

export async function readAll() {
  const res = await chrome.storage.local.get([ITEMS_KEY, COLLECTIONS_KEY, SETTINGS_KEY]);

  const collections = { ...(res[COLLECTIONS_KEY] || {}) };
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
export function sortCollections(collections) {
  return Object.values(collections).sort(
    (a, b) => (a.createdAt || 0) - (b.createdAt || 0) || a.name.localeCompare(b.name, 'fr')
  );
}

/** La collection d'un article, en retombant sur la collection par défaut. */
export function collectionOf(item, collections) {
  const id = item.collectionId;
  return id && collections[id] ? id : DEFAULT_COLLECTION_ID;
}

// --- Écriture ----------------------------------------------------------------

/**
 * Relit puis réécrit une clé de façon atomique côté extension : le content
 * script écrit sur `savedItems` en parallèle, on ne veut pas écraser son travail.
 */
async function update(key, mutate) {
  const res = await chrome.storage.local.get(key);
  const current = res[key] || {};
  const next = mutate(current);
  await chrome.storage.local.set({ [key]: next });
  return next;
}

export async function saveSettings(patch) {
  const res = await chrome.storage.local.get(SETTINGS_KEY);
  const next = { ...DEFAULT_SETTINGS, ...(res[SETTINGS_KEY] || {}), ...patch };
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

export async function createCollection(name) {
  const collection = { id: newId(), name: name.trim(), createdAt: Date.now(), order: [] };
  await update(COLLECTIONS_KEY, (current) => ({ ...current, [collection.id]: collection }));
  return collection;
}

export async function renameCollection(id, name) {
  await update(COLLECTIONS_KEY, (current) => {
    if (!current[id]) return current;
    return { ...current, [id]: { ...current[id], name: name.trim() } };
  });
}

/** Supprime une collection ; ses articles retournent dans la collection par défaut. */
/**
 * Supprime une collection **vide**.
 *
 * La règle est appliquée ici et pas seulement à l'affichage : le bouton est rendu
 * à partir d'un état qui peut dater, un autre onglet Vinted ayant pu y classer un
 * article entre-temps. On relit donc juste avant d'écrire, et on renonce plutôt
 * que de déplacer des articles à l'insu de l'utilisateur.
 *
 * @returns {Promise<{ok: boolean, reason?: 'default'|'not-empty'|'unknown'}>}
 */
export async function deleteCollection(id) {
  if (id === DEFAULT_COLLECTION_ID) return { ok: false, reason: 'default' };

  const res = await chrome.storage.local.get([ITEMS_KEY, COLLECTIONS_KEY]);
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

export async function moveItemToCollection(itemId, collectionId) {
  await update(ITEMS_KEY, (current) => {
    if (!current[itemId]) return current;
    return { ...current, [itemId]: { ...current[itemId], collectionId } };
  });

  // L'article quitte l'ordre personnalisé de son ancienne collection.
  await update(COLLECTIONS_KEY, (current) => {
    const next = {};
    for (const [id, collection] of Object.entries(current)) {
      const order = (collection.order || []).filter((entry) => entry !== itemId);
      next[id] =
        id === collectionId ? { ...collection, order: [itemId, ...order] } : { ...collection, order };
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
 * @returns {Promise<object>} les réglages écrits
 */
export async function commitCustomOrder(collectionId, orderedIds) {
  const res = await chrome.storage.local.get([COLLECTIONS_KEY, SETTINGS_KEY]);

  const collections = res[COLLECTIONS_KEY] || {};
  const collection = collections[collectionId] || {
    id: collectionId,
    name: 'Mes favoris',
    createdAt: Date.now(),
    order: [],
  };

  const settings = {
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

export async function removeItem(itemId) {
  await update(ITEMS_KEY, (current) => {
    const next = { ...current };
    delete next[itemId];
    return next;
  });

  await update(COLLECTIONS_KEY, (current) => {
    const next = {};
    for (const [id, collection] of Object.entries(current)) {
      next[id] = { ...collection, order: (collection.order || []).filter((e) => e !== itemId) };
    }
    return next;
  });
}
