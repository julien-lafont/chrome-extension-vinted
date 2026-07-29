/**
 * Rendu de la ligne d'article : prix, badge de variation, état vendu/gone —
 * §6.2 et §6.3 de `docs/specs/suivi-prix.md` — et la ligne du vendeur.
 *
 * Extrait de `sidepanel.ts` pour rester testable sans `chrome` : ce module ne
 * touche qu'au DOM qu'on lui passe, comme `gallery.ts` et `price-history.ts`.
 * `watch-render.test.ts` et `seller-render.test.ts` clonent `#item-template` et
 * vérifient directement ce que ces fonctions y écrivent.
 */
import { countryName, flagEmoji } from '../shared/countries.ts';
import { priceDropRatio, isMeaningfulDrop } from '../shared/watch.ts';
import type { SavedItem } from '../shared/types.ts';
import { formatEuro } from '../shared/price.ts';
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

/**
 * Le vendeur et sa réputation, sur leur propre ligne : drapeau, pseudo
 * cliquable vers son dressing, note, nombre d'évaluations.
 *
 * Le pseudo commande l'affichage, pas l'identifiant : « 286459945 » sur une
 * ligne d'article n'apprend rien à personne. L'identifiant, lui, ne sert qu'à
 * construire le lien — un vendeur nommé mais non identifié (fiche partiellement
 * lue) reste donc affiché, simplement sans lien.
 *
 * **Aucun jugement n'est porté** : ni couleur, ni seuil, ni avertissement. Les
 * informations brutes côte à côte suffisent — « marque désirable, prix très
 * bas, compte sans évaluation » se lit tout seul, et un avertissement se
 * tromperait sur les vendeurs neufs parfaitement honnêtes.
 *
 * Ces champs n'existent que sur les articles dont la fiche a été lue depuis la
 * 0.4 : rien ne les recalcule, la ligne reste absente pour les autres.
 */
export function renderSeller(node: ParentNode, item: SavedItem): void {
  const name = item.sellerName?.trim();
  if (!name) return;

  within<HTMLElement>(node, '.item-seller-line').hidden = false;

  const el = within<HTMLAnchorElement>(node, '.item-seller');
  el.textContent = name;

  if (item.sellerId) {
    el.href = `https://www.vinted.fr/member/${item.sellerId}`;
    el.title = `Voir le dressing de ${name}`;
  }

  const country = item.sellerCountry;
  if (country) {
    const flag = within<HTMLElement>(node, '.item-seller-flag');
    flag.hidden = false;
    // Le drapeau seul serait muet pour un lecteur d'écran, et illisible sous
    // Windows, qui n'en a pas les glyphes : le nom du pays double l'emoji.
    flag.textContent = flagEmoji(country);
    flag.title = countryName(country);
    flag.setAttribute('aria-label', countryName(country));
  }

  // Une note sans évaluation n'existe pas, et zéro évaluation est justement ce
  // qu'il faut voir : les deux champs se rendent donc ensemble, jamais l'un
  // pour l'autre. `null` (fiche lue avant la 0.4, ou ancre cassée) ne dit rien
  // et n'affiche rien.
  const count = item.sellerFeedbackCount;
  if (count == null) return;

  const reviews = within<HTMLElement>(node, '.item-seller-reviews');
  reviews.hidden = false;
  reviews.textContent = count === 0 ? 'aucune évaluation' : `${count} avis`;

  if (item.sellerRating == null) return;

  const rating = within<HTMLElement>(node, '.item-seller-rating');
  rating.hidden = false;
  // L'étoile suit le chiffre plutôt que de le précéder : le point médian
  // (CSS) ouvre déjà le segment, une seconde ponctuation devant le nombre
  // le rendrait moins net à lire.
  rating.textContent = `${formatRating(item.sellerRating)} ★`;
  rating.setAttribute('aria-label', `Noté ${formatRating(item.sellerRating)} sur 5`);
}

/** Note à la française — « 4,7 », et « 5 » plutôt que « 5,0 ». */
function formatRating(rating: number): string {
  return rating.toLocaleString('fr-FR', { maximumFractionDigits: 1 });
}
