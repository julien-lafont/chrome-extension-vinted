/**
 * Lecture des offres dans l'API des conversations Vinted — `docs/specs/offres.md`.
 *
 * Ce module est **pur** : il reçoit du JSON déjà téléchargé et rend des offres.
 * Aucun `fetch`, aucun `chrome`, aucune horloge implicite. C'est la même
 * séparation que `content/extract.ts` face à `content.ts`, et pour la même
 * raison : c'est ici que Vinted cassera quelque chose, et un test doit pouvoir
 * l'éprouver en une seconde sur des réponses réelles.
 *
 * La fiche article ne dit rien d'une offre en cours (vérifié le 29/07/2026 :
 * dans les 2,6 Mo servis, les seules occurrences de `offer` sont des chaînes de
 * traduction). L'inbox est la seule source, et elle demande de la prudence : la
 * même conversation décrit les offres faites **et** reçues, sur ce qu'on achète
 * comme sur ce qu'on vend.
 */
import type { ItemOffer, OfferStatus } from './types.ts';

// --- Ce qu'on lit dans les réponses, et rien de plus ---------------------------
//
// Tout est optionnel : ces objets viennent d'un tiers qui ne nous doit rien, et
// une clé disparue doit produire « pas d'offre », jamais une exception.

type Amount = { amount?: unknown };

type OfferEntity = {
  user_id?: unknown;
  status?: unknown;
  current?: unknown;
  price?: Amount;
};

type ConversationMessage = {
  entity_type?: unknown;
  created_at_ts?: unknown;
  entity?: OfferEntity;
};

type Transaction = {
  status?: unknown;
  buyer_id?: unknown;
  current_user_side?: unknown;
  item_id?: unknown;
  item_ids?: unknown;
  item_is_closed?: unknown;
};

type ConversationResponse = {
  conversation?: {
    id?: unknown;
    messages?: ConversationMessage[];
    transaction?: Transaction;
  };
};

type InboxResponse = {
  conversations?: { id?: unknown; updated_at?: unknown }[];
  pagination?: { total_pages?: unknown };
};

type CurrentUserResponse = { user?: { id?: unknown } };

/**
 * Codes de statut d'une demande d'offre, relevés le 29/07/2026 sur 55
 * conversations. `status_title` les double en clair (« En attente », « Refusée »)
 * mais il est **traduit** : on ne s'y ancre pas, règle 4 appliquée à l'API.
 *
 * Un code absent de cette table ne produit **aucune** offre : mieux vaut ne rien
 * afficher qu'un badge faux sur un état que Vinted aurait ajouté depuis.
 */
const STATUS_BY_CODE: Record<number, OfferStatus> = {
  10: 'pending',
  20: 'accepted',
  30: 'rejected',
  40: 'cancelled',
};

/**
 * Code de `transaction.status` d'une transaction encore ouverte. Les autres
 * valeurs observées (450, 500, 510, 520) désignent toutes une fin — vente
 * conclue, article parti, commande annulée — sans qu'on sache les distinguer
 * finement, ce qui n'est pas nécessaire ici : seul « encore en cours » compte.
 */
const TRANSACTION_OPEN = 1;

// --- Lectures élémentaires -----------------------------------------------------

/** Les identifiants Vinted arrivent en nombre ; le storage les indexe en chaîne. */
function idOf(raw: unknown): string | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  return null;
}

/** `{ amount: "399.0" }` → 399. Une chaîne, toujours — jamais un nombre. */
function amountOf(price: Amount | undefined): number | null {
  const raw = price?.amount;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== 'string') return null;
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : null;
}

/** `created_at_ts` est une date ISO avec fuseau (« 2026-07-29T19:58:42+02:00 »). */
function timeOf(raw: unknown): number | null {
  if (typeof raw !== 'string') return null;
  const at = Date.parse(raw);
  return Number.isFinite(at) ? at : null;
}

// --- Inbox ---------------------------------------------------------------------

/** Une conversation telle que la liste la donne : de quoi décider de la lire. */
export type InboxEntry = { id: string; updatedAt: number };

export type InboxPage = {
  entries: InboxEntry[];
  /** `1` par défaut : une pagination absente vaut « cette page est la seule ». */
  totalPages: number;
};

/**
 * Les conversations d'une page d'inbox, **dans l'ordre servi** — du plus
 * récemment modifié au plus ancien. Cet ordre n'est pas cosmétique : tout le
 * balayage incrémental en dépend (§4 de la spec).
 *
 * `/api/v2/inbox` ne porte ni `item_id` ni offre : c'est un index, pas une
 * source. `/api/v2/conversations?page=…`, lui, répond 404 — ce n'est pas la
 * liste, contrairement à ce que la symétrie des noms laisse croire.
 */
export function parseInboxPage(payload: unknown): InboxPage {
  const data = (payload ?? {}) as InboxResponse;
  const entries: InboxEntry[] = [];

  for (const raw of data.conversations ?? []) {
    const id = idOf(raw?.id);
    const updatedAt = timeOf(raw?.updated_at);
    // Une conversation sans date ne peut ni être ordonnée ni servir de borne :
    // la retenir ferait avancer le curseur sur une valeur inconnue.
    if (id && updatedAt !== null) entries.push({ id, updatedAt });
  }

  const pages = data.pagination?.total_pages;
  return { entries, totalPages: typeof pages === 'number' && pages > 0 ? pages : 1 };
}

/** L'identifiant du compte connecté, seul moyen de distinguer les deux côtés. */
export function parseCurrentUserId(payload: unknown): string | null {
  return idOf(((payload ?? {}) as CurrentUserResponse).user?.id);
}

// --- Conversation --------------------------------------------------------------

/** Une offre et les articles qu'elle engage — plusieurs seulement pour un lot. */
export type ConversationOffer = {
  conversationId: string;
  itemIds: string[];
  offer: ItemOffer;
};

/**
 * L'offre courante d'une conversation, du point de vue de l'acheteur.
 *
 * Rend `null` — ce qui vaut « aucune offre à afficher » et efface une offre
 * connue — dans tous les cas douteux : conversation où l'on vend, transaction
 * sans article, aucun message d'offre, statut inconnu.
 *
 * L'offre ne porte **pas** de date de vérification : le balayage incrémental ne
 * relit pas les conversations inchangées, un tel champ ne pourrait donc jamais
 * dire « confirmée à l'instant » sans mentir. Ce que le scan a fait et quand se
 * lit dans la clé `offers` (`OffersScanState.lastScanAt`).
 *
 * @param userId identifiant du compte connecté ; sans lui, rien n'est décidable
 */
export function offerFromConversation(payload: unknown, userId: string): ConversationOffer | null {
  const conversation = ((payload ?? {}) as ConversationResponse).conversation;
  if (!conversation) return null;

  const conversationId = idOf(conversation.id);
  const transaction = conversation.transaction;
  if (!conversationId || !transaction) return null;

  // Côté acheteur seulement. `current_user_side` est explicite quand il est là ;
  // `buyer_id` le remplace sur les conversations anciennes qui ne le portent pas.
  const side = transaction.current_user_side;
  const isBuyer =
    typeof side === 'string' ? side === 'buyer' : idOf(transaction.buyer_id) === userId;
  if (!isBuyer) return null;

  const itemIds = itemIdsOf(transaction);
  if (!itemIds.length) return null;

  const closed = transaction.item_is_closed === true;
  const open = transaction.status === TRANSACTION_OPEN && !closed;

  const mine = latestOwnRequest(conversation.messages ?? [], userId);
  const theirs = latestSellerOffer(conversation.messages ?? [], userId, open);

  // La plus récente des deux décrit l'état courant : une contre-offre postérieure
  // à mon offre refusée est bien là où en est la négociation.
  const offer = pickLatest(mine, theirs);
  if (!offer) return null;

  return {
    conversationId,
    itemIds,
    offer: {
      ...offer,
      // Un article fermé n'a plus d'offre en attente, quel que soit le code lu :
      // le vendeur a conclu ailleurs, et « en attente » serait un faux espoir.
      status: closed && offer.status === 'pending' ? 'cancelled' : offer.status,
      conversationId,
    },
  };
}

/**
 * Les articles d'une transaction. `item_ids` fait foi — `item_id` est `null` sur
 * toutes les conversations d'avant avril 2026, et s'y fier seul rendrait muette
 * la moitié de l'historique. Les deux sont lus, et dédoublonnés.
 */
function itemIdsOf(transaction: Transaction): string[] {
  const ids = new Set<string>();

  if (Array.isArray(transaction.item_ids)) {
    for (const raw of transaction.item_ids) {
      const id = idOf(raw);
      if (id) ids.add(id);
    }
  }

  const single = idOf(transaction.item_id);
  if (single) ids.add(single);

  return [...ids];
}

/** Une offre en construction : ce qui se lit d'un message, avant l'article. */
type PartialOffer = Pick<ItemOffer, 'by' | 'price' | 'at' | 'status'>;

function pickLatest(a: PartialOffer | null, b: PartialOffer | null): PartialOffer | null {
  if (!a) return b;
  if (!b) return a;
  return b.at > a.at ? b : a;
}

/**
 * Ma dernière demande d'offre.
 *
 * `current: false` marque une offre remplacée par une plus récente du même
 * auteur ; on l'écarte. Le champ ne vaut **pas** par conversation : dans la
 * conversation 22149099255, mon `offer_message` et l'`offer_request_message` du
 * membre sont tous deux `current`. Filtrer sur `!== false` plutôt que sur
 * `=== true` laisse passer une réponse où Vinted cesserait de servir le champ.
 */
function latestOwnRequest(messages: ConversationMessage[], userId: string): PartialOffer | null {
  let best: PartialOffer | null = null;

  for (const message of messages) {
    if (message?.entity_type !== 'offer_request_message') continue;

    const entity = message.entity;
    if (!entity || idOf(entity.user_id) !== userId) continue;
    if (entity.current === false) continue;

    const status = typeof entity.status === 'number' ? STATUS_BY_CODE[entity.status] : undefined;
    const price = amountOf(entity.price);
    const at = timeOf(message.created_at_ts);
    if (!status || price === null || at === null) continue;

    if (!best || at > best.at) best = { by: 'me', price, at, status };
  }

  return best;
}

/**
 * La dernière proposition du vendeur (« Fixer le prix à 205 € »).
 *
 * Ces entités **n'ont pas de statut** : Vinted n'en met que sur les demandes
 * d'offre. Il se déduit donc de la transaction, et c'est le point le plus
 * incertain du relevé — d'où un repli conservateur : « en attente » n'est retenu
 * que sur une transaction explicitement ouverte, tout le reste est éteint.
 */
function latestSellerOffer(
  messages: ConversationMessage[],
  userId: string,
  open: boolean
): PartialOffer | null {
  let best: PartialOffer | null = null;

  for (const message of messages) {
    if (message?.entity_type !== 'offer_message') continue;

    const entity = message.entity;
    if (!entity) continue;

    // Sur ce qu'on achète, un `offer_message` de soi-même n'existe pas ; la garde
    // vaut pour les conversations mixtes, où l'on a aussi fixé un prix.
    const author = idOf(entity.user_id);
    if (!author || author === userId) continue;
    if (entity.current === false) continue;

    const price = amountOf(entity.price);
    const at = timeOf(message.created_at_ts);
    if (price === null || at === null) continue;

    if (!best || at > best.at) {
      best = { by: 'seller', price, at, status: open ? 'pending' : 'cancelled' };
    }
  }

  return best;
}

/**
 * Deux offres décrivent-elles le même état ?
 *
 * Sert au scan à ne rien réécrire pour rien : le panneau se repeint à chaque
 * `onChanged`, et l'empreinte d'une ligne est l'article sérialisé en entier.
 */
export function sameOffer(a: ItemOffer, b: ItemOffer): boolean {
  return (
    a.by === b.by &&
    a.price === b.price &&
    a.at === b.at &&
    a.status === b.status &&
    a.conversationId === b.conversationId
  );
}

// --- Ce que le panneau en fait -------------------------------------------------

/**
 * Fraîcheur en deçà de laquelle le panneau ne relance pas de balayage à son
 * ouverture. Une demi-heure : une offre acceptée ou refusée pendant qu'on
 * chine n'a pas besoin d'être connue à la minute, et l'incrémental ne coûte
 * qu'une requête — c'est la fréquence, pas le volume, qu'il faut tenir.
 */
export const SCAN_EVERY_MS = 30 * 60 * 1000;

/** Une offre en attente, sur un article ni vendu ni retiré : ce que compte la vue. */
export function isLiveOffer(item: { offer?: ItemOffer; status?: 'sold' | 'gone' }): boolean {
  return item.offer?.status === 'pending' && !item.status;
}

/** Libellé du badge, sans l'ancienneté que le panneau lui accole. */
export function offerLabel(offer: ItemOffer): string {
  if (offer.status === 'accepted') return 'Offre acceptée';
  if (offer.status === 'rejected') return 'Offre refusée';
  if (offer.status === 'cancelled') return 'Offre annulée';
  return offer.by === 'me' ? 'Offre' : 'Vendeur';
}
