/**
 * Vinted Smart Bookmarks — les collections, côté storage.
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
import type { Collection, CollectionMap, SavedItem } from './types.ts';

export { COLLECTIONS_KEY, ITEMS_KEY };

/**
 * « Mes favoris » — **un récapitulatif, plus une destination de rangement**.
 *
 * Son onglet montre tout ce qui est enregistré, classé ou non, à la seule
 * exception d'« Archives » (voir `isInTab()`). Ranger un article dans « Jeans »
 * ne l'en fait donc plus sortir : la collection s'ajoute au favori, elle ne s'y
 * substitue pas.
 *
 * L'entrée reste malgré tout dans `CollectionMap`, pour une raison unique :
 * elle porte l'**ordre manuel de la vue globale** (`order`), qui n'aurait
 * nulle part où vivre autrement. Rien d'autre ne s'y range — un article
 * « non classé » est un article **sans** `collectionId`, jamais un article
 * pointant ici. Les versions antérieures écrivaient `collectionId: 'default'`
 * pour dire la même chose : `classifiedIn()` le lit encore comme « non classé »
 * et `shared/migrate.ts` nettoie le résidu.
 */
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
 * telle : elle n'existe pas dans `CollectionMap`, `classifiedIn()` ne la rend
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

/**
 * La collection où l'article est rangé, ou `null` s'il ne l'est nulle part.
 *
 * Trois formes disent « non classé », et c'est ce qui rend la bascule vers le
 * récapitulatif rétrocompatible **sans migration** :
 *   — `collectionId` absent : ce que le content script écrit depuis toujours ;
 *   — `collectionId === 'default'` : ce qu'écrivaient les versions où « Mes
 *     favoris » était une collection comme les autres ;
 *   — `collectionId` pointant vers une collection supprimée : référence morte,
 *     jamais réparée en storage (voir `docs/architecture.md`).
 */
export function classifiedIn(
  item: { collectionId?: string },
  collections: CollectionMap
): Collection | null {
  const id = item.collectionId;
  if (!id || id === DEFAULT_COLLECTION_ID) return null;
  return collections[id] || null;
}

/**
 * L'article apparaît-il sous cet onglet de collection ?
 *
 * Une seule fonction pour la liste **et** pour les compteurs de la barre : deux
 * lectures séparées finiraient par diverger, et un compteur qui annonce 12 sur
 * une liste qui en montre 9 est le genre d'écart qu'on ne remarque pas tout de
 * suite.
 *
 * « Mes favoris » montre tout **sauf les archivés** : archiver, c'est sortir de
 * la vue ce qui est vendu ou parti — les y laisser reparaître viderait le geste
 * de son sens.
 */
export function isInTab(
  item: { collectionId?: string },
  tabId: string,
  collections: CollectionMap
): boolean {
  const current = classifiedIn(item, collections);
  if (tabId === DEFAULT_COLLECTION_ID) return current?.id !== ARCHIVE_COLLECTION_ID;
  return current?.id === tabId;
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
 * l'ordre des autres collections — **sauf celui de « Mes favoris »**.
 *
 * Cette exception est le cœur du récapitulatif : `default.order` est l'ordre
 * manuel de la vue globale, où l'article reste affiché quoi qu'il arrive. L'en
 * retirer à chaque rangement ferait sauter la carte en tête de « Mes favoris »
 * pour la seule raison qu'on l'a classée ailleurs.
 *
 * `collectionId` à `null` (ou à « Mes favoris », qui veut dire la même chose)
 * déclasse : l'article ne quitte que les ordres des collections réelles.
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
  collectionId: string | null
): CollectionMap {
  const target = collectionId === DEFAULT_COLLECTION_ID ? null : collectionId;
  const next: CollectionMap = {};

  for (const [id, collection] of Object.entries(collections)) {
    if (id === DEFAULT_COLLECTION_ID) {
      next[id] = collection;
      continue;
    }

    const order = (collection.order || []).filter((entry) => entry !== itemId);
    next[id] =
      id === target ? { ...collection, order: [itemId, ...order] } : { ...collection, order };
  }

  return next;
}

/**
 * Range un article dans une collection, ou l'en sort avec `null`.
 *
 * Ranger pose `collectionId` et replace l'id en tête de l'ordre personnalisé de
 * la cible ; déclasser **efface le champ** plutôt que d'y écrire `'default'` —
 * l'absence est la seule forme que le content script produit, et deux écritures
 * pour un même état finissent par se lire différemment quelque part.
 *
 * Les deux clés partent dans un **seul** `set`. Deux écritures successives
 * déclencheraient deux rendus du panneau, et le premier montrerait un article
 * déjà déplacé dont l'ordre n'a pas encore suivi — même raison que
 * `commitCustomOrder()` et `archiveSold()`.
 *
 * Relecture avant écriture (règle 6 du projet) : plusieurs onglets Vinted
 * écrivent sur `savedItems` en parallèle.
 */
export async function assignCollection(itemId: string, collectionId: string | null): Promise<void> {
  await update([ITEMS_KEY, COLLECTIONS_KEY], (current) => {
    const items = current[ITEMS_KEY] || {};
    const item = items[itemId];
    // L'article a pu être retiré depuis un autre onglet pendant que le menu était
    // ouvert : ne pas le ressusciter par un rangement.
    if (!item) return null;

    const collections = withDefault(current[COLLECTIONS_KEY]);
    const target = collectionId === DEFAULT_COLLECTION_ID ? null : collectionId;
    // Collection disparue entre l'ouverture du menu et le choix : rien à faire
    // plutôt qu'écrire une référence morte.
    if (target && !collections[target]) return null;

    const next: SavedItem = { ...item, collectionId: target ?? undefined };
    if (!target) delete next.collectionId;

    return {
      [ITEMS_KEY]: { ...items, [itemId]: next },
      [COLLECTIONS_KEY]: placeInOrder(collections, itemId, target),
    };
  });
}
