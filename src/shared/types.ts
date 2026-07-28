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

/**
 * Une photo de la fiche article, dans les trois tailles qu'affiche la galerie.
 *
 * Les trois URLs sont **livrées telles quelles par Vinted**, jamais dérivées : le
 * `?s=…` qui les termine est une signature liée à l'URL exacte, et réécrire le
 * segment de taille (`f800` → autre chose) produit un 404. Voir
 * `docs/vinted-dom.md`.
 *
 * `full` est nettement plus lourd que `url` (1200×1600 contre 600×800, ~4× le
 * poids) : la galerie n'affiche `url` et ne charge `full` que sur demande.
 */
export type ItemPhoto = {
  /** Miniature de la bande de navigation (310×430). */
  thumb: string;
  /** Taille d'affichage courante (`f800`, 600×800). */
  url: string;
  /** Qualité maximale (`full_size_url`, 1200×1600). */
  full: string;
  /** Dimensions de l'original, quand la source les donne : réserve le ratio. */
  width?: number;
  height?: number;
  /** Couleur dominante, affichée en fond pendant le chargement. */
  dominantColor?: string;
};

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

  /**
   * Identifiant Vinted de la marque, en chaîne comme `category.id`.
   *
   * C'est **le seul filtre de marque que le catalogue accepte** : `brand_ids[]`
   * ignore un nom. Il ne vient que de la fiche (fil d'Ariane ou flux
   * d'hydratation) : `undefined` sur un article dont la fiche n'a jamais été lue,
   * `null` sur une fiche sans marque référencée. Voir `search.ts`.
   */
  brandId?: string | null;

  /**
   * Identifiant Vinted de la taille, l'autre filtre exact du catalogue
   * (`size_ids[]`).
   *
   * Contrairement à `brandId`, il n'est **écrit dans aucune page** : il est
   * résolu depuis le libellé et la catégorie, par une requête à l'API du site,
   * après l'enregistrement — voir `shared/size-ids.ts` et `completeSizeId()`.
   * Absent quand la catégorie n'est pas exacte, quand le libellé est ambigu, ou
   * quand l'API n'a pas répondu : la recherche retombe alors sur le texte.
   */
  sizeId?: string | null;

  /** Identifiant du vendeur. `sellerUrl` s'en déduit : `/member/{sellerId}`. */
  sellerId?: string | null;
  /** Pseudo affiché du vendeur, quand il est lisible sur la fiche. */
  sellerName?: string | null;

  /**
   * Description rédigée par le vendeur, tronquée à {@link DESCRIPTION_MAX}.
   *
   * Enregistrée mais **encore inexploitée** : c'est là que vivent les mesures
   * (« épaules 46, longueur 68 »), les défauts et la provenance, que ni les
   * attributs ni le titre ne portent. La capturer maintenant évite d'avoir à
   * relire toutes les fiches le jour où la recherche s'en servira.
   */
  description?: string | null;

  /**
   * Toutes les photos de la fiche, dans l'ordre de Vinted. Absent tant que la
   * fiche n'a pas été lue — une carte de catalogue n'expose que sa miniature —
   * et absent aussi sur les articles enregistrés avant la 0.3 : la galerie ne
   * s'affiche que là où le champ existe, rien ne le recalcule. **Jamais `[]`**,
   * voir `extractPhotos()`.
   */
  images?: ItemPhoto[];

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

  // --- Suivi de prix et de disponibilité, voir docs/specs/suivi-prix.md -------

  /** Horodatage de la dernière vérification aboutie (fiche lue, quel qu'en soit le verdict). */
  lastCheckedAt?: number;

  /**
   * `undefined` = actif, ou jamais infirmé. `sold` vient du badge « Vendu » de la
   * fiche, `gone` de deux absences consécutives — jamais d'une seule (voir
   * `shared/watch.ts`). Un article marqué n'est jamais supprimé d'office : c'est
   * l'utilisateur qui archive (`archiveSold()`).
   */
  status?: 'sold' | 'gone';

  /**
   * Points de prix, du plus ancien au plus récent, **seulement quand la valeur
   * change**. Le premier point est toujours conservé — c'est la référence du
   * « −15 % depuis l'ajout ». Au-delà de {@link PRICE_HISTORY_MAX} on évince les
   * plus anciens *intermédiaires*, jamais le premier.
   */
  priceHistory?: PricePoint[];

  /** Absences consécutives (404/410). Remis à 0 dès qu'une lecture aboutit. */
  missCount?: number;
};

/** Un relevé de prix, horodaté. Voir `SavedItem.priceHistory`. */
export type PricePoint = { at: number; price: number };

/**
 * Longueur maximale de `SavedItem.priceHistory`. ~20 octets le point → 300
 * articles × 24 points ≈ 150 Ko sur les 10 Mo disponibles.
 */
export const PRICE_HISTORY_MAX = 24;

/**
 * État du cycle de rafraîchissement, clé `watch` de `chrome.storage.local`.
 * Pas un port, pas un message de progression : le panneau écoute déjà
 * `chrome.storage.onChanged`, la progression s'affiche gratuitement et survit à
 * la fermeture du panneau comme à l'arrêt du service worker.
 */
export type WatchState = {
  /** Fin du dernier cycle complet. Base du déclencheur « > 1 h » (§5.2). */
  lastSweepAt: number;
  /**
   * Verrou d'onglet, avec bail : un onglet fermé en plein cycle ne bloque pas à
   * vie. `tabId` n'est pas un id d'onglet Chrome — inaccessible depuis un
   * content script — mais un identifiant d'instance généré au chargement.
   */
  lease?: { tabId: string; until: number };
  progress?: { done: number; total: number; startedAt: number };
  /** Fenêtre de silence après un 429 ou un challenge. Aucune requête avant. */
  throttledUntil?: number;
  /**
   * Nombre de coups de frein consécutifs subis, remis à 0 au premier cycle qui
   * aboutit sans en subir. Sert à faire croître `throttledUntil` en
   * 30 min × 2^n plutôt que de reposer un délai fixe à chaque signal.
   */
  throttleStrikes?: number;
  /** Seau à jetons, partagé entre tous les onglets — voir §3.2. */
  bucket: { tokens: number; at: number };
  /**
   * Plafond quotidien (~80 fiches, §3.2), au-delà du seau à jetons : une liste de
   * 300 articles s'étale ainsi sur plusieurs jours plutôt que de vider le seau
   * en une seule session prolongée. `day` est une clé `YYYY-MM-DD` en UTC.
   */
  dailyBudget?: { day: string; used: number };
};

/**
 * Longueur retenue d'une description. Les plus bavardes dépassent 2 000
 * caractères ; `chrome.storage.local` plafonne à 10 Mo, et une liste de plusieurs
 * milliers d'articles doit y tenir. Le début porte l'essentiel — les mesures et
 * l'état sont annoncés en tête, jamais après le récit.
 */
export const DESCRIPTION_MAX = 1200;

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
  /** Masque les articles `sold`/`gone` de la liste, sans les compter pour autant (§6.5). */
  hideSold: boolean;
};

/** Les deux clés du storage sont indexées par id, pas stockées en tableau. */
export type ItemMap = Record<string, SavedItem>;
export type CollectionMap = Record<string, Collection>;
