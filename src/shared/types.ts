/**
 * Modèle de données, partagé par le content script et le panneau latéral.
 *
 * Avant le passage au bundler, ces deux mondes ne pouvaient rien partager : un
 * content script n'a pas d'`import` à l'exécution. Le modèle vivait donc en
 * double, décrit par des commentaires de part et d'autre — et c'est exactement
 * là que naissent les désaccords silencieux (un champ renommé d'un côté, lu de
 * l'autre, sans erreur nulle part). Il n'existe plus qu'ici.
 *
 * Trois clés dans `chrome.storage.local` : `savedItems`, `collections`,
 * `settings`. Voir `docs/architecture.md`.
 */

/**
 * Catégorie d'un article, reconstruite depuis le fil d'Ariane de la fiche.
 *
 * `exact` distingue les deux provenances : le fil d'Ariane d'une **fiche**
 * décrit l'article (exact), celui d'une page de **catalogue** décrit la page
 * (approché). `id` et `url` manquent quand la catégorie vient du JSON-LD, qui la
 * nomme sans l'identifier : de quoi l'afficher, pas de quoi relancer une recherche.
 */
export type ItemCategory = {
  id: string | null;
  name: string;
  path: string[];
  url: string | null;
  exact: boolean;
};

/** D'où vient l'extraction. La fiche fait foi ; la carte est un état transitoire. */
export type ItemSource = 'catalog' | 'detail';

/** Un article enregistré, tel qu'il est écrit dans `savedItems`. */
export type SavedItem = {
  id: string;
  url: string;
  title: string;
  brand: string;
  size: string;
  condition: string;
  /** Prix tel qu'affiché par Vinted : « 12,00 € ». */
  price: string;
  /** Prix numérique, quand il a pu être lu. Le tri retombe sur `price` sinon. */
  priceValue: number | null;
  favouriteCount: number | null;
  category: ItemCategory | null;
  imageUrl: string;
  source: ItemSource;

  /** Posé à l'écriture en storage, pas à l'extraction. */
  savedAt?: number;
  /** Absent = collection par défaut. Le content script ne renseigne jamais ce champ. */
  collectionId?: string;
  /** `true` tant que la fiche est en cours de lecture (l'article n'a que sa carte). */
  pending?: boolean;

  /**
   * Champs des versions antérieures, encore présents dans le storage des
   * utilisateurs installés avant fin juillet 2026. Rien ne les recalcule : le tri
   * et la recherche les lisent en repli. Voir `docs/limitations.md`.
   */
  likes?: number;
  brandId?: string | number;
  sizeId?: string | number;
};

/** Une collection. `order` porte l'ordre personnalisé (des ids d'articles). */
export type Collection = {
  id: string;
  name: string;
  createdAt: number;
  order: string[];
};

export type SortMode = 'custom' | 'savedAt' | 'price' | 'condition' | 'likes' | 'size';

/** Les modes autres que `custom` sont les seuls à exposer une clé de tri. */
export type KeyedSortMode = Exclude<SortMode, 'custom'>;

export type SortDir = 'asc' | 'desc';

export type OfferSettings = {
  /** Remise proposée, en pourcentage du prix affiché. */
  discount: number;
  autoMessage: boolean;
};

export type Settings = {
  activeCollectionId: string;
  sortMode: SortMode;
  sortDir: SortDir;
  offer: OfferSettings;
};

/** Les deux clés du storage sont indexées par id, pas stockées en tableau. */
export type ItemMap = Record<string, SavedItem>;
export type CollectionMap = Record<string, Collection>;
