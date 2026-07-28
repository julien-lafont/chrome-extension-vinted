/**
 * Rendu de la ligne d'article : prix, badge de variation et état vendu/gone —
 * §6.2 et §6.3 de `docs/specs/suivi-prix.md`.
 *
 * Extrait de `sidepanel.ts` pour rester testable sans `chrome` : ce module ne
 * touche qu'au DOM qu'on lui passe, comme `gallery.ts` et `price-history.ts`.
 * `watch-render.test.ts` clone `#item-template` et vérifie directement ce que
 * cette fonction y écrit.
 */
import { priceDropRatio, isMeaningfulDrop } from '../shared/watch.ts';
import type { SavedItem } from '../shared/types.ts';
import { formatEuro } from './offer.ts';
import { formatAgo } from './watch.ts';
import { openPriceHistory } from './price-history.ts';

/** Même intention que `required()` dans `sidepanel.ts`, pour un descendant d'un nœud déjà obtenu. */
function within<T extends Element>(root: ParentNode, selector: string): T {
  const el = root.querySelector<T>(selector);
  if (!el) throw new Error(`sidepanel.html : ${selector} introuvable`);
  return el;
}

/**
 * Le badge n'apparaît que lorsqu'il y a quelque chose à dire : c'est la
 * contrainte qui gouverne toute cette section, le suivi n'ajoute aucune ligne
 * à un article normal. Un article vendu ou disparu n'affiche plus le badge de
 * variation — le badge d'état prend toute la place utile.
 */
export function renderPriceAndStatus(
  node: ParentNode,
  article: HTMLElement,
  item: SavedItem
): void {
  within(node, '.item-price-value').textContent = item.price || '';

  const wasEl = within<HTMLElement>(node, '.item-price-was');
  const deltaEl = within<HTMLButtonElement>(node, '.item-price-delta');
  const statusEl = within<HTMLElement>(node, '.item-status-badge');

  if (item.status === 'sold' || item.status === 'gone') {
    article.classList.add(item.status === 'sold' ? 'item--sold' : 'item--gone');

    statusEl.hidden = false;
    statusEl.textContent = item.status === 'sold' ? 'Vendu' : 'Retiré';

    const offer = within<HTMLButtonElement>(node, '.item-offer');
    offer.disabled = true;
    offer.setAttribute('aria-disabled', 'true');
    offer.title = 'Article vendu';
    return;
  }

  const change = priceDropRatio(item.priceHistory);
  if (!change) return;

  const isDrop = change.ratio < 0;
  if (isDrop && !isMeaningfulDrop(change.fromPrice, change.toPrice)) return; // §6.3 : sous le seuil, on ne dit rien
  if (!isDrop && change.ratio === 0) return; // prix revenu à l'identique : rien à montrer

  const percent = Math.round(Math.abs(change.ratio) * 100);
  if (!percent) return;

  wasEl.hidden = false;
  wasEl.textContent = formatEuro(change.fromPrice);

  deltaEl.hidden = false;
  deltaEl.className = `item-price-delta ${isDrop ? 'item-price-delta--drop' : 'item-price-delta--rise'}`;
  deltaEl.textContent = `${isDrop ? '−' : '+'}${percent} %`;
  deltaEl.title = item.lastCheckedAt ? `Vérifié ${formatAgo(item.lastCheckedAt)}` : '';
  deltaEl.setAttribute(
    'aria-label',
    `Prix en ${isDrop ? 'baisse' : 'hausse'} de ${percent} % depuis l'ajout`
  );
  deltaEl.addEventListener('click', () => {
    openPriceHistory(item, deltaEl);
  });
}
