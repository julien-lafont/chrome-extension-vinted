/**
 * Suivi de prix et de disponibilité — logique pure, sans accès Chrome.
 *
 * Tout ce qui décide (verdict d'une vérification, débit, ordre de la file) vit
 * ici plutôt que dans le content script, pour rester testable sans jsdom. Voir
 * `docs/specs/suivi-prix.md`.
 */

import { PRICE_HISTORY_MAX } from './types.ts';
import type { PricePoint, SavedItem, WatchProgress, WatchState } from './types.ts';

// ---------------------------------------------------------------------------
// Signe de vie d'un cycle — §3.6
// ---------------------------------------------------------------------------

/**
 * Au-delà de ce silence, le cycle annoncé par `progress` est réputé mort.
 *
 * Quatre minutes tiennent large : entre deux articles il y a au pire le délai
 * de §3.3 (jusqu'à ~60 s de « lecture » depuis que les délais ont doublé) plus
 * le délai d'expiration d'une fiche (15 s), et pendant une pause le porteur bat
 * toutes les 20 s. Deux minutes ne laissaient plus qu'une marge d'une minute :
 * un cycle bien vivant, arrêté sur une longue « lecture », y passait pour mort.
 */
export const SWEEP_STALE_MS = 4 * 60 * 1000;

/**
 * Un `progress` sans porteur vivant — onglet fermé, page rechargée ou content
 * script tué en plein cycle. Sans cette relecture, le bouton reste figé sur
 * « 12/48 » pour toujours : le panneau y voit un cycle en cours, donc chaque clic
 * suivant est compris comme une annulation, et plus rien ne se rafraîchit
 * jusqu'à ce que quelqu'un vide le storage à la main.
 *
 * Une pause (§3.6) n'est pas un cycle mort : le porteur y bat toujours `at`.
 * C'est bien l'absence de battement qui tranche, jamais le drapeau `paused`.
 */
export function isSweepStale(progress: WatchProgress | undefined, now: number): boolean {
  if (!progress) return false;
  return now - (progress.at ?? progress.startedAt) > SWEEP_STALE_MS;
}

/** Un cycle réellement en cours : annoncé, et dont le porteur donne signe de vie. */
export function isSweepRunning(
  state: Pick<WatchState, 'progress'> | undefined,
  now: number
): boolean {
  return Boolean(state?.progress && !isSweepStale(state.progress, now));
}

// ---------------------------------------------------------------------------
// Historique de prix
// ---------------------------------------------------------------------------

/**
 * Ajoute un point à l'historique, **seulement si le prix a changé**. Le premier
 * point n'a rien à comparer et est donc toujours posé : c'est lui qui sert de
 * référence au badge de variation (§6.3).
 *
 * Au-delà de {@link PRICE_HISTORY_MAX}, on évince le plus ancien point
 * *intermédiaire* — jamais le premier, jamais le dernier qu'on vient d'ajouter.
 */
export function pushPricePoint(
  history: PricePoint[] | undefined,
  price: number,
  at: number
): PricePoint[] {
  const points = history ?? [];
  const last = points.at(-1);
  if (last && last.price === price) return points;

  const next = [...points, { at, price }];
  if (next.length <= PRICE_HISTORY_MAX) return next;

  const [first, , ...rest] = next;
  return first ? [first, ...rest] : next;
}

export type PriceChange = { ratio: number; fromPrice: number; toPrice: number };

/**
 * Variation entre le premier point de l'historique — la référence, le prix au
 * moment de l'enregistrement — et le dernier. C'est la question du chineur
 * (« depuis que je l'ai repéré ? »), pas celle du point précédent.
 *
 * @returns `null` s'il n'y a rien à comparer (un seul point, ou aucun). Un
 *   `ratio` négatif est une baisse.
 */
export function priceDropRatio(history: PricePoint[] | undefined): PriceChange | null {
  if (!history || history.length < 2) return null;

  const first = history[0];
  const last = history.at(-1);
  if (!first || !last || first.price <= 0) return null;

  return {
    ratio: (last.price - first.price) / first.price,
    fromPrice: first.price,
    toPrice: last.price,
  };
}

/**
 * Une baisse mérite-t-elle d'être signalée (badge §6.3, résumé de fin de cycle
 * §6.7) ? Les deux seuils sont cumulatifs : Vinted encourage les
 * micro-ajustements, un « −1 % » sur trente lignes est du bruit qui
 * décrédibilise le « −30 % » d'à côté ; et un fort pourcentage sur un article
 * bon marché (30 % d'un article à 5 €, soit 1,50 €) reste, en valeur, du bruit
 * du même genre.
 */
export function isMeaningfulDrop(from: number, to: number): boolean {
  const drop = from - to;
  if (drop <= 0) return false;
  return drop / from >= 0.05 && drop >= 3;
}

// ---------------------------------------------------------------------------
// Verdict d'une vérification — §4, conservateur
// ---------------------------------------------------------------------------

export type CheckOutcome =
  | { kind: 'active'; price: number; priceText: string }
  | { kind: 'sold' }
  | { kind: 'notFound' }
  | { kind: 'unreadable' }
  | { kind: 'idMismatch' }
  | { kind: 'failure' };

/**
 * Applique le verdict d'une vérification de fiche. La règle en cas de doute :
 * ne rien écrire.
 *
 * - `failure` (timeout, réseau, 429, 5xx) et `idMismatch` (fiche d'un autre
 *   article — garde-fou déjà présent dans `enrichFromDetail()`) ne touchent à
 *   rien, **pas même `lastCheckedAt`** : l'échec est compté ailleurs (télémétrie
 *   de debug), jamais interprété comme un signal sur l'article.
 * - `sold` est un signal explicite (badge « Vendu ») : une occurrence suffit.
 * - `notFound` (404/410) incrémente `missCount` ; `status: 'gone'` n'arrive qu'à
 *   la deuxième absence, sur deux cycles distincts — Vinted peut renvoyer un 404
 *   transitoire sans que l'article ait bougé.
 * - `unreadable` (réponse sans aucune ancre connue) n'écrit **que**
 *   `lastCheckedAt` : rien à conclure sur l'article, mais il a bel et bien été
 *   interrogé. Sans cette date, il resterait le plus périmé de la file et
 *   repasserait en tête à chaque cycle, indéfiniment.
 * - `active` remet `missCount` à 0, met à jour `price`/`priceValue` — sans quoi
 *   la ligne resterait figée sur le prix d'enregistrement même après un
 *   changement détecté — et pousse un point de prix si besoin.
 */
export function applyCheckResult(
  item: SavedItem,
  outcome: CheckOutcome,
  now: number
): Partial<SavedItem> {
  if (outcome.kind === 'failure' || outcome.kind === 'idMismatch') return {};

  if (outcome.kind === 'sold') {
    return { lastCheckedAt: now, status: 'sold', missCount: 0 };
  }

  // Une page servie mais illisible ne dit rien : ni que l'article existe encore
  // (`missCount` ne bouge pas), ni qu'il a disparu (aucun `status`). Vinted rend
  // parfois la fiche d'un article dont les informations ne sont plus servies,
  // puis renvoie vers le dressing du vendeur — cas transitoire, observé le
  // 29/07/2026 sur un article de nouveau lisible le lendemain.
  if (outcome.kind === 'unreadable') return { lastCheckedAt: now };

  if (outcome.kind === 'notFound') {
    const missCount = (item.missCount ?? 0) + 1;
    return missCount >= 2
      ? { lastCheckedAt: now, missCount, status: 'gone' }
      : { lastCheckedAt: now, missCount };
  }

  const priorPrice = typeof item.priceValue === 'number' ? item.priceValue : null;
  const hasHistory = Boolean(item.priceHistory && item.priceHistory.length);

  // Le tout premier point ne doit jamais être celui qu'on vient de lire : sans
  // amorçage, un article dont le prix a déjà changé avant sa toute première
  // vérification enregistrerait le nouveau prix comme s'il avait toujours été
  // celui-là, et le badge de variation n'aurait plus rien à montrer.
  const base =
    !hasHistory && priorPrice !== null && priorPrice !== outcome.price
      ? [{ at: item.savedAt ?? now, price: priorPrice }]
      : item.priceHistory;

  return {
    lastCheckedAt: now,
    missCount: 0,
    price: outcome.priceText,
    priceValue: outcome.price,
    priceHistory: pushPricePoint(base, outcome.price, now),
  };
}

/**
 * Un article éligible à une vérification : ni en attente de sa première fiche
 * (rien à comparer), ni dans un état déjà définitif — revérifier un article
 * vendu ou disparu ne ferait que consommer le débit pour un verdict qui ne
 * changera pas.
 */
export function dueForCheck(item: SavedItem): boolean {
  if (item.pending) return false;
  if (item.status === 'sold' || item.status === 'gone') return false;
  return true;
}

/** Taille des tranches à l'intérieur desquelles l'ordre est mélangé — §3.4. */
const SHUFFLE_SLICE = 10;

/**
 * Ordre de la file de vérification : le plus périmé d'abord (jamais vérifié en
 * tête, `lastCheckedAt` absent valant 0), puis mélange à l'intérieur de
 * tranches d'une dizaine pour ne pas rejouer toujours le même motif côté
 * serveur, sans perdre la priorité globale.
 *
 * @param random source d'aléa injectable, pour des tests déterministes.
 */
export function orderForCheck(items: SavedItem[], random: () => number = Math.random): SavedItem[] {
  const sorted = items
    .filter(dueForCheck)
    .sort((a, b) => (a.lastCheckedAt ?? 0) - (b.lastCheckedAt ?? 0));

  for (let start = 0; start < sorted.length; start += SHUFFLE_SLICE) {
    const end = Math.min(start + SHUFFLE_SLICE, sorted.length);
    for (let i = end - 1; i > start; i -= 1) {
      const j = start + Math.floor(random() * (i - start + 1));
      const a = sorted[i];
      const b = sorted[j];
      if (a && b) {
        sorted[i] = b;
        sorted[j] = a;
      }
    }
  }

  return sorted;
}

// ---------------------------------------------------------------------------
// Débit — §3.2
// ---------------------------------------------------------------------------

/**
 * Pointe de 24 requêtes, régime de croisière de 24 par minute.
 *
 * Divisé par deux le 30 juillet 2026 : au régime précédent (48/48), Vinted
 * renvoyait des 429. Voir §3.2 de `docs/specs/suivi-prix.md`.
 */
export const RATE = { capacity: 24, refillPerMinute: 24 } as const;

export type TokenBucket = { tokens: number; at: number };

function refillBucket(bucket: TokenBucket, now: number): TokenBucket {
  const elapsedMinutes = Math.max(0, now - bucket.at) / 60000;
  const tokens = Math.min(RATE.capacity, bucket.tokens + elapsedMinutes * RATE.refillPerMinute);
  return { tokens, at: now };
}

/**
 * Consomme un jeton s'il y en a un. Le seau est partagé entre tous les onglets
 * Vinted via le storage : chaque appelant doit le relire juste avant, comme
 * toute écriture partagée (règle 6 du CLAUDE.md).
 */
export function takeToken(bucket: TokenBucket, now: number): { ok: boolean; bucket: TokenBucket } {
  const refilled = refillBucket(bucket, now);
  if (refilled.tokens < 1) return { ok: false, bucket: refilled };
  return { ok: true, bucket: { tokens: refilled.tokens - 1, at: refilled.at } };
}

/** Plafond quotidien, en complément du seau — voir `WatchState.dailyBudget`. */
export const DAILY_CAP = 5000;

function dayKey(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/**
 * Consomme une unité du budget du jour. Le jour change sous nos pieds (le
 * cycle peut tourner à cheval sur minuit) : un budget d'un autre jour repart de
 * zéro plutôt que de refuser à tort.
 */
export function takeDailyBudget(
  budget: WatchState['dailyBudget'],
  now: number
): { ok: boolean; budget: NonNullable<WatchState['dailyBudget']> } {
  const today = dayKey(now);
  const current = budget && budget.day === today ? budget : { day: today, used: 0 };
  if (current.used >= DAILY_CAP) return { ok: false, budget: current };
  return { ok: true, budget: { day: today, used: current.used + 1 } };
}

// ---------------------------------------------------------------------------
// Backoff sur signal — §3.5
// ---------------------------------------------------------------------------

export function isThrottled(state: Pick<WatchState, 'throttledUntil'>, now: number): boolean {
  return Boolean(state.throttledUntil && state.throttledUntil > now);
}

/**
 * 10 min × 2^n avec jitter. `strikes` est le nombre de coups de frein déjà
 * subis d'affilée ; l'appelant l'incrémente à chaque signal et le remet à 0 au
 * premier cycle qui aboutit sans en subir.
 *
 * La base est courte **volontairement** : c'est le débit du §3.2 qui protège
 * du 429, pas la longueur du silence. Un premier réessai à une heure laissait
 * l'utilisateur sans rafraîchissement toute une soirée pour un seul coup de
 * frein passager ; l'escalade en 2^n reste là pour le cas où Vinted freine
 * vraiment (10, 20, 40, 80 min…).
 */
export function nextThrottle(now: number, strikes: number): number {
  const base = 10 * 60 * 1000 * 2 ** Math.max(0, strikes);
  return now + base + Math.random() * base * 0.2;
}

// ---------------------------------------------------------------------------
// Cadence irrégulière — §3.3
// ---------------------------------------------------------------------------

/** Box-Muller : transforme deux tirages uniformes en une gaussienne centrée réduite. */
function gauss(): number {
  const u1 = Math.random() || Number.EPSILON;
  const u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/**
 * Délai avant la prochaine requête du cycle. Un humain qui parcourt des fiches
 * n'a pas de période : on tire un délai log-normal (médiane ~1 s) et, une fois
 * sur 50, on ajoute une pause de 20 à 60 s — la « lecture » d'une fiche. Le
 * coût en durée totale est réel mais le cycle tourne en fond, personne ne
 * l'attend.
 *
 * Toutes ces valeurs ont été doublées le 30 juillet 2026, en même temps que
 * `RATE` était divisé par deux, en réponse à des 429.
 */
export function nextDelay(): number {
  const base = Math.exp(Math.log(1000) + gauss() * 0.55);
  return Math.random() < 0.02 ? base + 20000 + Math.random() * 40000 : base;
}
