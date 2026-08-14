/**
 * Modèle de données, partagé par le content script et le panneau latéral.
 *
 * Avant le passage au bundler, ces deux mondes ne pouvaient rien partager : un
 * content script n'a pas d'`import` à l'exécution. Le modèle vivait donc en
 * double, décrit par des commentaires de part et d'autre — et c'est exactement
 * là que naissent les désaccords silencieux (un champ renommé d'un côté, lu de
 * l'autre, sans erreur nulle part). Il n'existe plus qu'ici.
 *
 * Six clés dans `chrome.storage.local` : `savedItems`, `collections`,
 * `settings`, `noise`, `watch` et `offers`. Voir `docs/architecture.md`.
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
   * Note du vendeur sur 5, une décimale. `null` quand elle n'a pas pu être lue,
   * et **aussi quand le vendeur n'a aucune évaluation** : une note de 0 sur un
   * compte tout neuf se lirait comme un mauvais vendeur, alors qu'elle ne dit
   * rien du tout. Voir `shared/seller.ts`.
   */
  sellerRating?: number | null;

  /**
   * Nombre d'évaluations reçues. **`0` est une valeur** — un compte sans aucun
   * avis est précisément ce qu'on veut voir — là où `null` veut dire « pas lu ».
   * Même distinction que `favouriteCount`.
   */
  sellerFeedbackCount?: number | null;

  /**
   * Pays du vendeur, code ISO 3166-1 alpha-2 en majuscules (`FR`, `DE`).
   *
   * Il ne vient pas de la fiche — elle ne le porte nulle part — mais d'une
   * lecture de `/member/{sellerId}`, faite une fois après l'enregistrement.
   * **Jamais relu ensuite** : le pays d'un compte ne change pas, et `null`
   * (profil sans localisation exposée) est une réponse définitive au même titre
   * qu'un code. Seul `undefined` signifie « profil jamais lu ».
   */
  sellerCountry?: string | null;

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
   * fiche n'a pas été lue — une carte de catalogue n'expose que sa miniature :
   * la galerie ne s'affiche que là où le champ existe. **Jamais `[]`**, voir
   * `extractPhotos()`.
   */
  images?: ItemPhoto[];

  /** Posé à l'écriture en storage, pas à l'extraction. */
  savedAt?: number;
  /**
   * Collection où l'article est **classé en plus** d'être dans « Mes favoris ».
   *
   * Absent = non classé, ce qui est l'état courant : le content script ne
   * renseigne ce champ qu'à la capture avec choix de collection. Un article
   * classé reste visible dans le récapitulatif — voir `classifiedIn()` et
   * `isInTab()` dans `shared/collections.ts`.
   *
   * Deux valeurs héritées se lisent encore comme « non classé » : `'default'`
   * (écrit quand « Mes favoris » était une collection comme les autres) et un
   * identifiant de collection supprimée.
   */
  collectionId?: string;
  /** `true` tant que la fiche est en cours de lecture (l'article n'a que sa carte). */
  pending?: boolean;

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

  // --- Offres, voir docs/specs/offres.md ---------------------------------------

  /**
   * L'offre en cours sur cet article, s'il y en a une. **Pas un historique** :
   * une seule offre, celle qui décrit l'état courant de la négociation.
   *
   * Elle ne vient pas de la fiche — celle-ci n'en porte aucune trace, vérifié le
   * 29/07/2026 — mais de l'API des conversations, balayée par `offers-scan.ts`.
   * Absent tant qu'aucun scan n'a rien trouvé, et effacé dès que la conversation
   * qui l'avait posée n'en montre plus.
   */
  offer?: ItemOffer;
};

/** Qui a proposé le prix. Les deux comptent : `seller` est une balle dans mon camp. */
export type OfferSide = 'me' | 'seller';

/**
 * État d'une offre. Le code numérique de Vinted (10/20/30/40) est traduit ici
 * une fois pour toutes ; `status_title` est traduit par le site et ne sert à
 * rien d'autre qu'à la lecture humaine d'un relevé.
 */
export type OfferStatus = 'pending' | 'accepted' | 'rejected' | 'cancelled';

/** Une offre sur un article suivi. Voir `shared/offers.ts` pour sa lecture. */
export type ItemOffer = {
  by: OfferSide;
  price: number;
  /**
   * Envoi de l'offre (`created_at_ts` du message), **jamais la date du scan** :
   * c'est cette date que le panneau affiche en relatif, et la confondre avec
   * celle de la vérification rajeunirait toutes les offres à chaque passage.
   */
  at: number;
  status: OfferStatus;
  /** Conversation d'origine : le badge y mène d'un clic. */
  conversationId: string;
};

/**
 * État du balayage des offres, clé `offers` de `chrome.storage.local`. Il ne
 * porte **pas** les offres — elles vivent sur leur article — mais de quoi ne pas
 * relire toute l'inbox à chaque fois. Voir `docs/specs/offres.md` §4.
 */
export type OffersScanState = {
  /**
   * Identifiant du compte, lu une fois via `/api/v2/users/current`. Sans lui,
   * impossible de distinguer une offre faite d'une offre reçue : c'est la seule
   * donnée qui départage les deux côtés d'une conversation.
   */
  userId?: string;
  /** Fin du dernier scan abouti. Base du déclencheur du panneau. */
  lastScanAt: number;
  /**
   * `updated_at` le plus récent déjà traité. L'inbox étant triée du plus récent
   * au plus ancien et toute évolution d'offre remontant sa conversation en tête,
   * un scan peut s'arrêter à la première conversation qui ne le dépasse pas.
   */
  cursor?: number;
  /**
   * Borne du balayage historique restant : les conversations plus anciennes que
   * cette date n'ont jamais été lues. Absent = tout l'historique a été vu, seul
   * l'incrémental reste. Voir §4 de la spec — une inbox de 500 conversations
   * s'étale sur plusieurs scans plutôt que de tenir la page une minute.
   */
  backfillBefore?: number;
  /** Fenêtre de silence après un 429 ou un 403. Aucune requête avant. */
  throttledUntil?: number;
};

/** Un relevé de prix, horodaté. Voir `SavedItem.priceHistory`. */
export type PricePoint = { at: number; price: number };

/**
 * Longueur maximale de `SavedItem.priceHistory`. ~20 octets le point → 300
 * articles × 24 points ≈ 150 Ko sur les 10 Mo disponibles.
 */
export const PRICE_HISTORY_MAX = 24;

/**
 * Avancement d'un cycle en cours. Écrit par le content script qui le porte, lu
 * par le panneau — c'est aussi le seul signe de vie de ce cycle.
 *
 * `at` avance à chaque article **et** pendant une pause (§3.6) : un onglet fermé
 * en plein cycle laisserait sinon un `progress` éternel en storage, que le
 * panneau afficherait comme un cycle en cours à jamais — bouton bloqué en
 * « 12/48 », clic interprété comme une annulation, rien qui reparte. Voir
 * `isSweepStale()`.
 */
export type WatchProgress = {
  done: number;
  total: number;
  startedAt: number;
  /** Dernier signe de vie : c'est lui, et non `startedAt`, qui juge la péremption. */
  at: number;
  /** L'onglet porteur est passé en arrière-plan ; le cycle attend son retour (§3.6). */
  paused?: boolean;
};

/**
 * État du cycle de rafraîchissement, clé `watch` de `chrome.storage.local`.
 * Pas un port, pas un message de progression : le panneau écoute déjà
 * `chrome.storage.onChanged`, la progression s'affiche gratuitement et survit à
 * la fermeture du panneau comme à l'arrêt du service worker.
 */
export type WatchState = {
  /** Fin du dernier cycle complet. Base du déclencheur « > 2 h » (§5.2). */
  lastSweepAt: number;
  /**
   * Verrou d'onglet, avec bail : un onglet fermé en plein cycle ne bloque pas à
   * vie. `tabId` n'est pas un id d'onglet Chrome — inaccessible depuis un
   * content script — mais un identifiant d'instance généré au chargement.
   */
  lease?: { tabId: string; until: number };
  progress?: WatchProgress;
  /**
   * L'onglet Chrome qui porte le cycle, écrit par le panneau au moment où il
   * envoie l'ordre — lui seul connaît ces identifiants. Un content script ne peut
   * pas les lire (d'où l'identifiant d'instance de `lease`, qui ne sert qu'à
   * comparer), et le panneau en a besoin pour ramener l'utilisateur sur le bon
   * onglet d'un clic (§6.10).
   */
  host?: { tabId: number; windowId?: number };
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

export type Settings = {
  activeCollectionId: string;
  sortMode: SortMode;
  sortDir: SortDir;
  /** Masque les articles `sold`/`gone` de la liste, sans les compter pour autant (§6.5). */
  hideSold: boolean;
  /**
   * Mode révision du filtrage : les cartes masquées du catalogue sont grisées au
   * lieu d'être retirées. C'est une préférence d'affichage, pas une règle — d'où
   * sa place ici plutôt que dans la clé `noise`. Voir
   * `docs/specs/filtrage-bruit.md` §4.4.
   */
  revealHidden: boolean;
  /**
   * Masque les encarts publicitaires du fil (Braze, `feed-braze--promo-box`
   * notamment). Activable depuis le pied de page, **désactivé par défaut** :
   * rien ne change tant qu'on ne l'a pas demandé. Voir `content.css`,
   * `.vf-hide-ads`.
   */
  hideAds: boolean;
  /**
   * Version du modèle de données déjà appliquée au storage. Absente = 1, l'état
   * d'avant le récapitulatif « Mes favoris ». Voir `shared/migrate.ts` : elle ne
   * conditionne qu'un **nettoyage**, jamais la lecture — un storage resté en 1
   * s'affiche correctement, sans quoi une migration qui échoue casserait
   * l'extension au lieu de la laisser en l'état.
   */
  schemaVersion?: number;
};

/** Les deux clés du storage sont indexées par id, pas stockées en tableau. */
export type ItemMap = Record<string, SavedItem>;
export type CollectionMap = Record<string, Collection>;
