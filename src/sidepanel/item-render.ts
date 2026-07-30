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
import { offerLabel } from '../shared/offers.ts';
import { priceDropRatio, isMeaningfulDrop } from '../shared/watch.ts';
import type { SavedItem } from '../shared/types.ts';
import { formatEuro } from '../shared/price.ts';
import { formatAgo } from './watch.ts';
import { openPriceHistory } from './price-history.ts';
import { within } from './dom.ts';

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
 * Le badge d'offre, à la suite du prix — `docs/specs/offres.md` §5.
 *
 * Trois choses s'y jouent :
 *
 * - **il n'apparaît que s'il y a une offre.** Comme le badge de variation, il
 *   n'ajoute aucune ligne à un article ordinaire ;
 * - **l'ancienneté est calculée, jamais stockée.** Seule la date d'envoi vit en
 *   storage ; le texte se recompose ici, et {@link refreshOfferAges} le refait
 *   toutes les 5 minutes sans relire quoi que ce soit ;
 * - **une offre éteinte reste affichée**, grisée. « Refusée à 42 € il y a trois
 *   semaines » est précisément ce qui évite de refaire la même offre au même
 *   vendeur ; seule la vue « Sous offres » s'en tient aux offres vivantes.
 *
 * @param onOpen ouvre une URL dans un onglet — le badge mène à la conversation
 */
export function renderOffer(
  node: ParentNode,
  item: SavedItem,
  onOpen: (url: string) => void
): void {
  const offer = item.offer;
  if (!offer) return;

  const el = within<HTMLButtonElement>(node, '.item-offer');
  el.hidden = false;
  el.className = `item-offer ${offer.status === 'pending' ? 'item-offer--live' : 'item-offer--dead'}`;

  // Le texte fixe et la date vivent dans le dataset : le rafraîchissement
  // périodique recompose la ligne sans rien avoir à relire du modèle.
  el.dataset.offerAt = String(offer.at);
  el.dataset.offerText = `${offerLabel(offer)} ${formatEuro(offer.price)}`;
  paintOfferAge(el);

  const who = offer.by === 'me' ? 'Ton offre' : 'Proposition du vendeur';
  el.title = `${who} — ouvrir la conversation`;
  el.addEventListener('click', () => {
    onOpen(`https://www.vinted.fr/inbox/${offer.conversationId}`);
  });
}

function paintOfferAge(el: HTMLElement): void {
  const at = Number(el.dataset.offerAt);
  const text = el.dataset.offerText ?? '';
  el.textContent = Number.isFinite(at) && at > 0 ? `${text} · ${formatAgo(at)}` : text;
}

/**
 * Recalcule l'ancienneté de tous les badges d'offre affichés.
 *
 * Appelé toutes les 5 minutes par le panneau. **Ne touche qu'au texte** : pas de
 * lecture du storage, pas de rendu de liste, donc rien qui puisse bouger sous la
 * souris ni interrompre un glisser en cours.
 */
export function refreshOfferAges(root: ParentNode): void {
  for (const el of root.querySelectorAll<HTMLElement>('.item-offer[data-offer-at]')) {
    paintOfferAge(el);
  }
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
