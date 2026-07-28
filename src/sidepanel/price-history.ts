/**
 * Popover d'historique de prix (§6.4 de docs/specs/suivi-prix.md).
 *
 * Réutilise tel quel le mécanisme `.menu` du menu « déplacer vers » —
 * `position: fixed`, ombre, fermeture au clic extérieur et à Échap,
 * repositionnement si le bas du panneau est atteint. Aucun nouveau mécanisme
 * de superposition n'est introduit ; le module reste indépendant de
 * `sidepanel.ts` (même principe que `gallery.ts`), avec ses propres écouteurs.
 */
import type { PricePoint, SavedItem } from '../shared/types.ts';
import { formatEuro } from './offer.ts';
import { formatAgo } from './watch.ts';

const WIDTH = 220;
const HEIGHT = 64;
const PAD = 6;

let el: HTMLElement;

const isOpen = (): boolean => !el.hidden;

function closePriceHistory(): void {
  el.hidden = true;
  el.textContent = '';
}

function dateLabel(at: number): string {
  return new Date(at).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' });
}

/**
 * Coordonnées d'un tracé en escalier (`stepAfter`) : entre deux relevés, le
 * prix était constant, il n'a pas glissé — une interpolation linéaire
 * inventerait des valeurs intermédiaires qui n'ont jamais existé. L'axe
 * horizontal est le temps réel, pas l'index des points : des relevés espacés
 * de quatre mois ne doivent pas paraître régulièrement répartis.
 */
function stepPath(points: PricePoint[]): string {
  const ats = points.map((p) => p.at);
  const prices = points.map((p) => p.price);
  const minAt = Math.min(...ats);
  const maxAt = Math.max(...ats);
  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);

  const innerW = WIDTH - PAD * 2;
  const innerH = HEIGHT - PAD * 2;

  const x = (at: number): number =>
    PAD + (maxAt === minAt ? 0 : ((at - minAt) / (maxAt - minAt)) * innerW);
  const y = (price: number): number =>
    PAD +
    (maxPrice === minPrice
      ? innerH / 2
      : (1 - (price - minPrice) / (maxPrice - minPrice)) * innerH);

  const first = points[0];
  if (!first) return '';

  const coords: [number, number][] = [[x(first.at), y(first.price)]];
  let previous = first;

  for (const point of points.slice(1)) {
    coords.push([x(point.at), y(previous.price)], [x(point.at), y(point.price)]);
    previous = point;
  }

  return coords.map(([px, py]) => `${px.toFixed(1)},${py.toFixed(1)}`).join(' ');
}

function renderChart(points: PricePoint[]): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${WIDTH} ${HEIGHT}`);
  svg.setAttribute('class', 'price-history-chart');
  svg.setAttribute('aria-hidden', 'true');

  const polyline = document.createElementNS(svg.namespaceURI, 'polyline');
  polyline.setAttribute('points', stepPath(points));
  polyline.setAttribute('fill', 'none');
  polyline.setAttribute('stroke', 'currentColor');
  polyline.setAttribute('stroke-width', '2');
  polyline.setAttribute('stroke-linejoin', 'round');
  polyline.setAttribute('stroke-linecap', 'round');
  svg.append(polyline);

  return svg;
}

/**
 * Une ligne par relevé : date, prix, et variation — **par rapport au premier
 * point**, la même référence que la pastille de la liste (§6.3). Un chineur
 * qui ouvre l'historique veut savoir ce que la fiche a fait depuis qu'il l'a
 * repérée, pas seulement depuis le relevé d'avant.
 */
function renderRows(points: PricePoint[]): HTMLElement {
  const rows = document.createElement('div');
  rows.className = 'price-history-rows';

  const reference = points[0];

  for (const point of points) {
    const row = document.createElement('div');
    row.className = 'price-history-row';

    const date = document.createElement('span');
    date.textContent = dateLabel(point.at);
    row.append(date);

    const price = document.createElement('span');
    price.textContent = formatEuro(point.price);
    row.append(price);

    if (reference && point !== reference && reference.price > 0) {
      const pct = Math.round(((point.price - reference.price) / reference.price) * 100);
      if (pct !== 0) {
        const delta = document.createElement('span');
        delta.className = `price-history-delta ${pct < 0 ? 'drop' : 'rise'}`;
        delta.textContent = `${pct > 0 ? '+' : ''}${pct} %`;
        row.append(delta);
      }
    }

    rows.append(row);
  }

  return rows;
}

/** Repositionne sous l'ancre, recalé pour rester dans le panneau — comme `.menu`. */
function position(anchor: HTMLElement): void {
  const rect = anchor.getBoundingClientRect();
  const popRect = el.getBoundingClientRect();

  const left = Math.max(8, Math.min(rect.left, window.innerWidth - popRect.width - 8));
  const top =
    rect.bottom + popRect.height + 8 > window.innerHeight
      ? Math.max(8, rect.top - popRect.height - 4)
      : rect.bottom + 4;

  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
}

/**
 * Ouvre le popover sous `anchor`. N'ouvre rien pour un article à un seul point
 * de prix (ou aucun) : pas d'historique à montrer, et un prix qui n'est pas
 * cliquable ne doit pas en avoir l'air — c'est à l'appelant de ne pas rendre
 * le bouton dans ce cas (voir `sidepanel.ts`), ce garde-fou n'est qu'une
 * seconde ligne de défense.
 */
export function openPriceHistory(item: SavedItem, anchor: HTMLElement): void {
  const points = item.priceHistory;
  if (!points || points.length < 2) return;

  el.textContent = '';

  const title = document.createElement('p');
  title.className = 'menu-title';
  title.textContent = 'Historique du prix';
  el.append(title, renderChart(points), renderRows(points));

  if (item.lastCheckedAt) {
    const footer = document.createElement('p');
    footer.className = 'price-history-footer';
    footer.textContent = `Vérifié ${formatAgo(item.lastCheckedAt)}`;
    el.append(footer);
  }

  el.hidden = false;
  position(anchor);
}

/** Câble le popover. À appeler une fois, au démarrage du panneau. */
export function initPriceHistory(element: HTMLElement): void {
  el = element;

  document.addEventListener('pointerdown', (event) => {
    if (!isOpen()) return;
    const target = event.target;
    if (target instanceof Node && !el.contains(target)) closePriceHistory();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && isOpen()) closePriceHistory();
  });
}
