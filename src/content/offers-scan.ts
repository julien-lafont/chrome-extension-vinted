/**
 * Balayage des offres — `docs/specs/offres.md` §4.
 *
 * Tourne dans le content script d'un onglet Vinted, jamais dans le service
 * worker : l'API des conversations répond **403 sans cookies de session**, et un
 * service worker n'en a pas. Même raison de fond que pour le suivi de prix
 * (§1 de `suivi-prix.md`), en plus contraignante encore — ici ce n'est pas une
 * question de discrétion, c'est la seule façon d'obtenir une réponse.
 *
 * Ce module ne lit rien lui-même : `shared/offers.ts` interprète, il se contente
 * d'aller chercher, de décider quoi aller chercher, et d'écrire. La logique de
 * débit est distincte de celle du cycle de suivi, et ne partage pas son seau à
 * jetons : quelques kilo-octets de JSON ici, plusieurs mégaoctets de HTML
 * là-bas — deux ordres de grandeur, deux budgets.
 */
import {
  offerFromConversation,
  parseCurrentUserId,
  parseInboxPage,
  sameOffer,
} from '../shared/offers.ts';
import { ITEMS_KEY, OFFERS_KEY, read, update } from '../shared/storage.ts';
import type { ItemMap, ItemOffer, OffersScanState } from '../shared/types.ts';

/**
 * Conversations détaillées au plus par scan. C'est le rattrapage initial qu'il
 * borne (§4) : une inbox de trois ans s'étale sur plusieurs passages plutôt que
 * de tenir la page pendant une minute. L'incrémental, lui, n'en atteint jamais
 * le plafond — il ne lit que ce qui a bougé.
 */
const MAX_DETAILS_PER_SCAN = 20;

/** Pages d'inbox parcourues au plus, garde-fou contre une pagination folle. */
const MAX_PAGES = 25;

/** Espacement des requêtes. Le rythme d'un humain qui parcourt sa messagerie. */
const SCAN_DELAY_MS = 800;

/** Au-delà, la requête est abandonnée : une offre n'est jamais urgente. */
const TIMEOUT_MS = 8000;

/**
 * Silence après un 429 ou un 403, aligné sur la base du cycle de suivi (§3.5 de
 * suivi-prix.md). Pas d'escalade ici : un scan ne coûte qu'une requête en régime
 * courant, il n'y a rien à faire décroître.
 */
const THROTTLE_MS = 10 * 60 * 1000;

const PER_PAGE = 20;

/** Ce qu'un scan a fait, pour le diagnostic du panneau. */
export type ScanSummary = {
  /** Conversations effectivement détaillées (une requête chacune). */
  read: number;
  /** Articles dont l'offre a changé. */
  written: number;
  /** Pourquoi le scan s'est arrêté, quand ce n'est pas « plus rien à lire ». */
  stopped?: 'freiné' | 'budget' | 'onglet caché' | 'compte inconnu' | 'réseau';
};

/** Ce que les tests remplacent ; en production, tout vient de la page. */
export type ScanDeps = {
  fetchImpl?: typeof fetch;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
  /** §3.6 : un onglet passé en arrière-plan n'émet plus de requêtes. */
  isVisible?: () => boolean;
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Réponse JSON, ou l'échec qualifié : `blocked` arrête tout et pose le silence. */
type Fetched = { data?: unknown; blocked?: boolean; failed?: boolean };

async function getJson(url: string, fetchImpl: typeof fetch): Promise<Fetched> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetchImpl(url, {
      credentials: 'include',
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });

    // Signal de freinage : jamais interprété comme « cette conversation n'existe
    // plus », sous peine d'effacer toutes les offres au premier coup de frein.
    if (response.status === 429 || response.status === 403) return { blocked: true };
    if (!response.ok) return { failed: true };

    return { data: await response.json() };
  } catch {
    return { failed: true };
  } finally {
    clearTimeout(timer);
  }
}

async function readState(): Promise<OffersScanState> {
  const res = await read(OFFERS_KEY);
  return res[OFFERS_KEY] ?? { lastScanAt: 0 };
}

async function patchState(patch: Partial<OffersScanState>): Promise<void> {
  await update([OFFERS_KEY], (stored) => ({
    [OFFERS_KEY]: { ...(stored[OFFERS_KEY] ?? { lastScanAt: 0 }), ...patch },
  }));
}

/**
 * Applique ce qu'une conversation dit des articles enregistrés.
 *
 * Trois précautions, chacune pour un cas observé dans un relevé réel :
 *
 * - **un article non enregistré est ignoré** — l'inbox parle aussi de ce qu'on
 *   vend et de ce qu'on a acheté il y a deux ans, rien de tout cela n'a à
 *   apparaître dans les favoris ;
 * - **une offre plus ancienne n'écrase pas une plus récente** venue d'une autre
 *   conversation : un même article peut en avoir plusieurs, et le balayage
 *   descend du plus récent au plus ancien ;
 * - **une offre inchangée ne se réécrit pas.** Le panneau se repeint à chaque
 *   `onChanged`, et l'empreinte d'une ligne est l'article sérialisé en entier :
 *   réécrire à l'identique repeindrait la liste pour rien.
 *
 * @returns le nombre d'articles modifiés
 */
async function applyConversation(
  conversationId: string,
  found: { itemIds: string[]; offer: ItemOffer } | null
): Promise<number> {
  let written = 0;

  await update([ITEMS_KEY], (stored) => {
    const items: ItemMap = stored[ITEMS_KEY] ?? {};
    const next: ItemMap = { ...items };
    let changed = false;

    if (found) {
      for (const itemId of found.itemIds) {
        const item = items[itemId];
        if (!item) continue;

        const previous = item.offer;
        if (previous) {
          if (sameOffer(previous, found.offer)) continue;
          if (previous.conversationId !== conversationId && previous.at >= found.offer.at) continue;
        }

        next[itemId] = { ...item, offer: found.offer };
        changed = true;
      }
    } else {
      // Plus d'offre dans cette conversation : ce qu'elle avait posé n'a plus
      // lieu d'être. On n'efface que ce qu'elle a écrit — une offre venue d'une
      // autre conversation reste.
      for (const [itemId, item] of Object.entries(items)) {
        if (item.offer?.conversationId !== conversationId) continue;
        const copy = { ...item };
        delete copy.offer;
        next[itemId] = copy;
        changed = true;
      }
    }

    if (!changed) return null;
    written = Object.keys(next).filter((id) => next[id] !== items[id]).length;
    return { [ITEMS_KEY]: next };
  });

  return written;
}

/**
 * Un balayage complet des offres.
 *
 * Deux phases, dans le même parcours de l'inbox (triée du plus récemment
 * modifié au plus ancien) :
 *
 * - **l'incrémental** : les conversations plus récentes que `cursor`. Toute
 *   évolution d'une offre remonte sa conversation en tête, c'est ce qui rend
 *   cette borne suffisante. En régime courant : une requête, zéro détail ;
 * - **le rattrapage** : sous `backfillBefore`, l'historique jamais lu, par
 *   tranches de {@link MAX_DETAILS_PER_SCAN}.
 */
export async function scanOffers(deps: ScanDeps = {}): Promise<ScanSummary> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  const wait = deps.wait ?? sleep;
  const isVisible = deps.isVisible ?? (() => document.visibilityState === 'visible');

  const summary: ScanSummary = { read: 0, written: 0 };
  const state = await readState();

  if (state.throttledUntil && state.throttledUntil > now()) {
    summary.stopped = 'freiné';
    return summary;
  }

  const userId = state.userId ?? (await fetchUserId(fetchImpl));
  if (!userId) {
    summary.stopped = 'compte inconnu';
    return summary;
  }
  if (userId !== state.userId) await patchState({ userId });

  const cursor = state.cursor ?? 0;
  // Premier scan : aucun curseur, donc tout l'historique est à rattraper. Une
  // fois le rattrapage terminé, `backfillBefore` disparaît et ne revient pas.
  const backfill =
    state.backfillBefore ?? (state.cursor === undefined ? Number.POSITIVE_INFINITY : null);

  let budget = MAX_DETAILS_PER_SCAN;
  let newestSeen = cursor;
  let oldestRead: number | null = null;
  let reachedEnd = false;
  let totalPages = 1;

  scan: for (let page = 1; page <= Math.min(totalPages, MAX_PAGES); page += 1) {
    const inbox = await getJson(`/api/v2/inbox?page=${page}&per_page=${PER_PAGE}`, fetchImpl);

    if (inbox.blocked) {
      await throttle(now());
      summary.stopped = 'freiné';
      return summary;
    }
    if (inbox.failed) {
      summary.stopped = 'réseau';
      break;
    }

    const { entries, totalPages: pages } = parseInboxPage(inbox.data);
    totalPages = Math.min(pages, MAX_PAGES);

    if (!entries.length) {
      reachedEnd = true;
      break;
    }

    for (const entry of entries) {
      if (entry.updatedAt > newestSeen) newestSeen = entry.updatedAt;

      const isNew = entry.updatedAt > cursor;
      const isBackfill = backfill !== null && entry.updatedAt < backfill;

      if (!isNew && !isBackfill) {
        // Sans rattrapage en cours, la première conversation déjà vue clôt le
        // scan : toutes les suivantes sont plus anciennes encore. Avec un
        // rattrapage, il faut au contraire continuer à descendre jusqu'à sa zone.
        if (backfill === null) {
          reachedEnd = true;
          break scan;
        }
        continue;
      }

      if (!isVisible()) {
        summary.stopped = 'onglet caché';
        break scan;
      }
      if (budget <= 0) {
        summary.stopped = 'budget';
        break scan;
      }
      budget -= 1;

      const detail = await getJson(`/api/v2/conversations/${entry.id}`, fetchImpl);

      if (detail.blocked) {
        await throttle(now());
        summary.stopped = 'freiné';
        return summary;
      }

      // Une conversation illisible (réseau, 404) n'efface rien : `applyConversation`
      // n'est appelé que sur une réponse comprise, sans quoi une coupure passagère
      // retirerait les badges de toutes les offres en cours.
      if (!detail.failed) {
        summary.read += 1;
        summary.written += await applyConversation(
          entry.id,
          offerFromConversation(detail.data, userId)
        );
        if (isBackfill) oldestRead = entry.updatedAt;
      }

      await wait(SCAN_DELAY_MS);
    }

    if (page >= totalPages) reachedEnd = true;
  }

  await patchState({
    lastScanAt: now(),
    cursor: newestSeen,
    ...backfillPatch(backfill, oldestRead, reachedEnd),
  });

  return summary;
}

/**
 * Où en est le rattrapage à la fin du scan.
 *
 * `undefined` le clôt définitivement : l'historique a été lu jusqu'au bout, seul
 * l'incrémental reste. Tant qu'il reste des conversations sous la borne, celle-ci
 * descend d'un cran à chaque passage.
 */
function backfillPatch(
  backfill: number | null,
  oldestRead: number | null,
  reachedEnd: boolean
): Partial<OffersScanState> {
  if (backfill === null) return {};
  if (reachedEnd) return { backfillBefore: undefined };
  if (oldestRead !== null) return { backfillBefore: oldestRead };
  return {};
}

async function throttle(now: number): Promise<void> {
  await patchState({ throttledUntil: now + THROTTLE_MS });
}

async function fetchUserId(fetchImpl: typeof fetch): Promise<string | null> {
  const res = await getJson('/api/v2/users/current', fetchImpl);
  return res.data ? parseCurrentUserId(res.data) : null;
}
