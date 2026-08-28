/**
 * Synchronisation avec les favoris natifs de Vinted — la partie pure.
 *
 * Voir `docs/specs/favoris-sync.md`. Ce module ne touche ni au DOM, ni au
 * réseau, ni au storage : il décide, et se teste sans navigateur. Ce qui va
 * chercher et ce qui écrit vit dans `content/fav-sync.ts`.
 *
 * Deux asymétries commandent toute la conception.
 *
 * **1. L'API de Vinted est une bascule, pas une affectation.** Le relevé du
 * 25/08/2026 (`docs/vinted-dom.md`) est sans ambiguïté : ajouter et retirer un
 * favori envoient **la même requête, au même corps** —
 * `POST /api/v2/user_favourites/toggle`, `{"type":"item","user_favourites":[id]}`.
 * C'est l'état courant du compte qui décide du sens. Émettre cette requête sans
 * connaître cet état, c'est une chance sur deux de faire l'inverse de ce qu'on
 * voulait. Rien ici ne produit donc un ordre « bascule » : on produit un **état
 * voulu** ({@link PendingFav.want}), et l'appelant ne bascule que ce qui diffère
 * de l'état réel qu'il vient de lire.
 *
 * **2. Rien n'est rétroactif.** La synchro n'agit que sur une **transition
 * constatée** — un cœur qu'on a vu passer de posé à retiré, un article qu'on a
 * vu entrer dans le storage. Jamais sur un écart entre deux listes : au moment
 * où l'on active le réglage, les deux mondes sont divergents par construction, et
 * un alignement d'office supprimerait des articles à partir d'un état qu'on n'a
 * jamais vu changer. C'est la différence entre « l'utilisateur a retiré ce
 * favori » et « ce favori n'a jamais existé », que rien dans les données ne
 * distingue après coup.
 */
import { ARCHIVE_COLLECTION_ID, classifiedIn } from './collections.ts';
import { formatPrice } from './price.ts';
import type { CollectionMap, SavedItem } from './types.ts';

/**
 * Un état voulu chez Vinted, en attente d'un onglet pour l'y porter.
 *
 * `want` est un état, pas un geste : voir l'asymétrie 1 en tête de fichier. Une
 * intention plus récente sur le même article **remplace** la précédente au lieu
 * de s'empiler — deux bascules en attente sur un même identifiant s'annuleraient
 * ou se doubleraient selon l'ordre de vidage, alors que le dernier geste de
 * l'utilisateur dit à lui seul ce qu'il veut.
 */
export type PendingFav = {
  id: string;
  /** `true` = à mettre en favori chez Vinted, `false` = à en retirer. */
  want: boolean;
  /** Date du geste qui a posé l'intention, pas celle du vidage. */
  at: number;
};

/**
 * Clé `favsync` de `chrome.storage.local`. Elle ne porte **pas** l'état des
 * favoris — celui-ci vit chez Vinted, et l'extension ne le duplique jamais —
 * mais seulement ce qui reste à faire.
 */
export type FavSyncState = {
  pending: PendingFav[];
  /** Fin du dernier vidage abouti. */
  lastDrainAt?: number;
  /** Fenêtre de silence après un 429 ou un 403. Aucune requête avant. */
  throttledUntil?: number;
  /**
   * Verrou d'onglet, avec bail — même mécanique que le cycle de suivi.
   *
   * Il n'est pas là pour économiser des requêtes mais pour éviter une
   * **corruption** : deux onglets qui videraient la même intention basculeraient
   * deux fois le même article, et une bascule doublée revient à ne rien faire —
   * en laissant croire que c'est fait. `tabId` est un identifiant d'instance
   * généré au chargement, pas un identifiant d'onglet Chrome, inaccessible
   * depuis un content script.
   */
  lease?: { tabId: string; until: number };
};

/**
 * Plafond de la file. Une intention pèse quelques dizaines d'octets : la borne
 * n'est pas là pour le quota mais pour qu'un onglet resté fermé une semaine ne
 * déclenche pas, à sa réouverture, un millier de requêtes d'un bloc. Au-delà,
 * ce sont les **plus anciennes** qui tombent : la plus récente est celle dont
 * l'utilisateur se souvient encore.
 */
export const MAX_PENDING = 300;

export function emptyFavSync(): FavSyncState {
  return { pending: [] };
}

/** Complète un état relu du storage, où tout peut manquer (installation neuve). */
export function normalizeFavSync(stored: Partial<FavSyncState> | undefined): FavSyncState {
  const pending = Array.isArray(stored?.pending) ? stored.pending : [];

  return {
    pending: pending.filter(
      (entry): entry is PendingFav =>
        Boolean(entry) && typeof entry.id === 'string' && typeof entry.want === 'boolean'
    ),
    ...(stored?.lastDrainAt ? { lastDrainAt: stored.lastDrainAt } : {}),
    ...(stored?.throttledUntil ? { throttledUntil: stored.throttledUntil } : {}),
    // Recopié, et pas seulement décoratif : c'est par cette relecture que le
    // bail d'un autre onglet est vu. L'oublier reviendrait à le libérer à
    // chaque lecture, c'est-à-dire à n'avoir aucun verrou.
    ...(stored?.lease ? { lease: stored.lease } : {}),
  };
}

/**
 * Pose une intention, en remplaçant celle qui portait déjà sur cet article.
 *
 * L'entrée réécrite repart **en queue** : la file est un ordre de traitement, et
 * un geste refait à l'instant n'a pas à hériter du rang d'une intention posée il
 * y a une heure.
 */
export function queueFav(
  state: FavSyncState,
  id: string,
  want: boolean,
  now: number
): FavSyncState {
  const pending = state.pending.filter((entry) => entry.id !== id);
  pending.push({ id, want, at: now });

  return { ...state, pending: pending.slice(-MAX_PENDING) };
}

/** Retire de la file ce qui vient d'être porté chez Vinted (ou jugé inutile). */
export function dropFav(state: FavSyncState, ids: readonly string[]): FavSyncState {
  if (!ids.length) return state;
  const done = new Set(ids);
  return { ...state, pending: state.pending.filter((entry) => !done.has(entry.id)) };
}

/**
 * L'état de favori que l'extension **veut** pour un article, d'après son seul
 * storage.
 *
 * « Archives » est hors du périmètre, et c'est ce qui rend la synchro stable :
 * archiver retire le cœur, ce qui — sans cette exclusion — ferait constater un
 * retrait de favori, qui rearchiverait l'article, indéfiniment. L'exclusion
 * transforme la boucle en point fixe : un article archivé est un article dont
 * l'extension et Vinted s'accordent à dire qu'il n'est plus un favori.
 *
 * Un article absent du storage vaut `false` au même titre qu'un archivé : c'est
 * ce qui permet à une suppression depuis le panneau de retirer le cœur.
 */
export function wantedFavourite(item: SavedItem | undefined, collections: CollectionMap): boolean {
  if (!item) return false;
  return classifiedIn(item, collections)?.id !== ARCHIVE_COLLECTION_ID;
}

/**
 * Ce qu'une transition du cœur Vinted doit produire côté extension.
 *
 * `restore` est le cas qu'on oublie : remettre le cœur sur un article archivé
 * n'est pas un ajout — l'article existe déjà, avec son historique de prix et sa
 * date d'ajout d'origine — mais une sortie du dépôt. Le confondre avec `save`
 * écraserait tout cela par les quelques champs d'une carte de catalogue.
 */
export type FavEffect = 'save' | 'archive' | 'restore' | 'none';

/**
 * @param favourite l'état du cœur **après** la transition constatée
 * @param item l'article tel qu'il est en storage, s'il y est
 */
export function effectOfFavourite(
  favourite: boolean,
  item: SavedItem | undefined,
  collections: CollectionMap
): FavEffect {
  if (!item) {
    // Retirer un cœur d'un article qu'on n'a jamais enregistré ne veut rien dire
    // ici : c'est le cas courant du catalogue, où l'on défait un favori posé
    // avant d'installer l'extension.
    return favourite ? 'save' : 'none';
  }

  const archived = classifiedIn(item, collections)?.id === ARCHIVE_COLLECTION_ID;

  if (favourite) return archived ? 'restore' : 'none';

  // Retrait sur un article déjà archivé : la synchro a déjà ce qu'elle veut, et
  // se taire est ce qui empêche l'aller-retour décrit sur `wantedFavourite()`.
  return archived ? 'none' : 'archive';
}

// ---------------------------------------------------------------------------
// Ce qu'il faut lire chez Vinted pour écrire sans se tromper
// ---------------------------------------------------------------------------

/**
 * Bascules émises au plus par vidage.
 *
 * C'est un plafond de dégâts, pas un budget de débit : chaque bascule écrit sur
 * le compte de l'utilisateur, et un défaut qui produirait mille intentions
 * fausses ne doit pas pouvoir vider ses favoris en une passe. Le reste de la
 * file attend le vidage suivant.
 */
export const MAX_TOGGLES_PER_DRAIN = 25;

/** Durée du bail d'un onglet sur le vidage. Un onglet fermé ne bloque pas à vie. */
export const FAV_LEASE_MS = 60 * 1000;

/**
 * Le jeton anti-CSRF de la page, sans lequel l'API répond 403 (vérifié le
 * 25/08/2026).
 *
 * Il n'y a **pas de balise `<meta>`** : le jeton vit dans un bloc de
 * configuration que Vinted sérialise en JSON *à l'intérieur* d'une chaîne
 * JavaScript, si bien que les guillemets y sont échappés —
 * `\"CSRF_TOKEN\":\"75f6c9fa-…\"`. Le motif accepte les deux formes : rien ne
 * garantit que la prochaine version conserve cet emballage, et l'échappement
 * n'est pas ce qu'on cherche à reconnaître.
 *
 * La valeur est contrainte à la forme d'un UUID plutôt qu'acceptée telle quelle :
 * un motif trop lâche attraperait la première chaîne venue si Vinted renommait
 * la clé, et c'est un en-tête qu'on enverrait alors à chaque requête.
 */
const CSRF_PATTERN = /\\?"CSRF_TOKEN\\?"\s*:\s*\\?"([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})/i;

export function readCsrfToken(doc: Document): string | null {
  for (const script of doc.scripts) {
    const found = CSRF_PATTERN.exec(script.textContent ?? '');
    if (found?.[1]) return found[1];
  }
  return null;
}

/** Une page de `/api/v2/users/{id}/items/favourites`, réduite à ce qu'on en lit. */
export type FavouritesPage = {
  /** Identifiants en chaîne, comme partout dans le modèle. */
  ids: string[];
  /**
   * Les entrées telles quelles, pour l'import — qui en tire un article complet
   * via {@link itemFromFavourite}. Le vidage, lui, ne regarde que `ids` : il n'a
   * besoin que de savoir ce qui est en favori.
   */
  entries: unknown[];
  /**
   * `pagination.total_pages` fait foi : demander un `per_page` que Vinted
   * n'accepte pas ne produit pas d'erreur, il est ramené à sa valeur et la
   * pagination s'ajuste. On suit donc ce que la réponse annonce, jamais ce
   * qu'on a demandé.
   */
  totalPages: number;
};

/**
 * Lit une page de favoris.
 *
 * La réponse porte le même objet que l'API du catalogue (prix, photos, vendeur).
 * Le vidage n'en retient que les identifiants — savoir *ce qui est en favori*
 * lui suffit — là où l'import en tire un article de qualité « carte », que la
 * fiche complétera ensuite : elle reste la seule source de vérité (voir
 * `docs/architecture.md`).
 *
 * @returns `null` si la réponse n'a pas la forme attendue — ce qui doit
 *   **arrêter le vidage** plutôt que de le laisser conclure « rien n'est en
 *   favori » et tout basculer.
 */
export function parseFavouritesPage(data: unknown): FavouritesPage | null {
  if (!data || typeof data !== 'object') return null;

  const body = data as { items?: unknown; pagination?: { total_pages?: unknown } };
  if (!Array.isArray(body.items)) return null;

  const ids: string[] = [];
  const entries: unknown[] = [];

  for (const entry of body.items) {
    const id = (entry as { id?: unknown } | null)?.id;
    if (typeof id !== 'number' && typeof id !== 'string') continue;
    ids.push(String(id));
    entries.push(entry);
  }

  const pages = body.pagination?.total_pages;
  return { ids, entries, totalPages: typeof pages === 'number' && pages > 0 ? pages : 1 };
}

/**
 * Un article de la liste des favoris, converti en {@link SavedItem}.
 *
 * L'entrée de l'API porte à peu près ce qu'une carte de catalogue affiche —
 * titre, marque, taille, état, prix, photo principale, vendeur — mais **ni
 * catégorie ni fil d'Ariane**. C'est donc un article de qualité « carte », qu'on
 * marque `pending` pour que sa fiche le complète : la même règle que partout
 * ailleurs, une seule extraction fait foi et c'est celle de la fiche (voir
 * `docs/architecture.md`).
 *
 * @returns `null` si l'entrée n'a ni identifiant ni URL — sans quoi on
 *   enregistrerait une coquille que rien ne pourra jamais compléter.
 */
export function itemFromFavourite(raw: unknown): SavedItem | null {
  if (!raw || typeof raw !== 'object') return null;

  const entry = raw as {
    id?: unknown;
    title?: unknown;
    url?: unknown;
    brand_title?: unknown;
    size_title?: unknown;
    status?: unknown;
    favourite_count?: unknown;
    price?: { amount?: unknown; currency_code?: unknown };
    photo?: { url?: unknown };
    user?: { id?: number | string; login?: unknown };
  };

  const id = typeof entry.id === 'number' || typeof entry.id === 'string' ? String(entry.id) : null;
  const url = typeof entry.url === 'string' ? entry.url : null;
  if (!id || !url) return null;

  const text = (value: unknown): string => (typeof value === 'string' ? value : '');
  const amount = Number(entry.price?.amount);
  const priceValue = Number.isFinite(amount) ? amount : null;

  return {
    id,
    url,
    title: text(entry.title),
    brand: text(entry.brand_title),
    size: text(entry.size_title),
    condition: text(entry.status),
    price: priceValue === null ? '' : formatPrice(priceValue, text(entry.price?.currency_code)),
    priceValue,
    favouriteCount: typeof entry.favourite_count === 'number' ? entry.favourite_count : null,
    category: null,
    imageUrl: text(entry.photo?.url),
    source: 'catalog',
    ...(entry.user?.id === undefined ? {} : { sellerId: String(entry.user.id) }),
    ...(entry.user?.login ? { sellerName: text(entry.user.login) } : {}),
  };
}
