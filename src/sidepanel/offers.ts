/**
 * Vinted Smart Bookmarks — déclenchement du balayage des offres, côté panneau.
 *
 * Même architecture que le suivi de prix (`watch.ts`) : le panneau n'émet
 * aucune requête vers Vinted, il élit un onglet et lui passe l'ordre. La raison
 * est ici plus forte encore qu'un souci de discrétion — l'API des conversations
 * répond 403 sans cookies de session, et le panneau n'en a pas.
 *
 * Ce module ne lit ni n'affiche les offres : elles arrivent sur les articles,
 * par `chrome.storage.onChanged`, comme le reste.
 */
import { SCAN_EVERY_MS, isLiveOffer } from '../shared/offers.ts';
import { OFFERS_KEY, read } from '../shared/storage.ts';
import type { SavedItem } from '../shared/types.ts';
import { findVintedTab } from './watch.ts';

/**
 * Lance un balayage à l'ouverture du panneau, si le dernier remonte à plus de
 * {@link SCAN_EVERY_MS}. Silencieux de bout en bout : sans onglet Vinted il n'y
 * a rien à faire, et rien à dire non plus — l'utilisateur n'y pourrait rien
 * d'utile, et les offres déjà connues restent affichées.
 *
 * Le rattrapage initial (`backfillBefore`) court-circuite le délai : tant que
 * l'historique n'a pas été lu jusqu'au bout, chaque ouverture du panneau en
 * avance d'une tranche plutôt que d'attendre un quart d'heure de plus.
 */
export async function maybeScanOffers(): Promise<void> {
  const res = await read(OFFERS_KEY);
  const state = res[OFFERS_KEY];
  const now = Date.now();

  if (state) {
    if (state.throttledUntil && state.throttledUntil > now) return;
    if (state.backfillBefore === undefined && now - state.lastScanAt < SCAN_EVERY_MS) return;
  }

  const tab = await findVintedTab();
  if (!tab?.id) return;

  // Content script pas encore injecté (onglet ouvert avant la dernière mise à
  // jour de l'extension) : rien d'actionnable, et le prochain scan retentera.
  await chrome.tabs.sendMessage(tab.id, { type: 'VF_OFFERS_SCAN' }).catch(() => undefined);
}

/**
 * Section « offres » du rapport de diagnostic.
 *
 * Elle répond à la seule question qu'on se pose vraiment quand un badge manque :
 * le balayage tourne-t-il, et jusqu'où a-t-il lu ? Un compte inconnu désigne une
 * session expirée, un rattrapage en cours explique une offre ancienne encore
 * absente, et une date de dernier balayage figée dit que rien ne part.
 */
export async function offersReport(items: readonly SavedItem[]): Promise<Record<string, unknown>> {
  const state = (await read(OFFERS_KEY))[OFFERS_KEY];
  const date = (at: number): string => new Date(at).toLocaleString('fr-FR');

  return {
    avecOffre: items.filter((item) => item.offer).length,
    enAttente: items.filter(isLiveOffer).length,
    compte: state?.userId ?? 'inconnu — session expirée ?',
    dernierBalayage: state?.lastScanAt ? date(state.lastScanAt) : 'jamais',
    rattrapage: state?.backfillBefore
      ? `en cours, conversations d'avant le ${date(state.backfillBefore)}`
      : 'terminé',
    freineJusqua: state?.throttledUntil ? date(state.throttledUntil) : 'non',
  };
}
