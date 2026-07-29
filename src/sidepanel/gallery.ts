/**
 * Visionneuse des photos d'un article, dans le panneau.
 *
 * Le panneau n'affiche qu'une miniature par article : la fiche Vinted en porte
 * souvent trois à cinq, et les consulter obligeait à ouvrir l'onglet. La
 * visionneuse les montre sur place, en un clic sur la miniature.
 *
 * Deux qualités par photo (voir `shared/photos.ts`) : `url` (600×800) s'affiche
 * tout de suite, `full` (1200×1600, ~4× le poids) le remplace dès qu'il est
 * chargé. L'inverse — attendre la pleine résolution — ferait patienter devant un
 * cadre vide à chaque photo, pour un gain invisible sur la largeur d'un panneau.
 *
 * La fermeture n'est pas câblée ici : `.overlay` est déjà fermé par `Escape`, un
 * clic sur le fond et tout `[data-close]` — voir la fin de `sidepanel.ts`.
 */
import type { ItemPhoto, SavedItem } from '../shared/types.ts';
import { lensUrl } from './elsewhere.ts';

/** Les nœuds de `sidepanel.html` que la visionneuse pilote. */
export type GalleryElements = {
  overlay: HTMLElement;
  image: HTMLImageElement;
  stage: HTMLElement;
  thumbs: HTMLElement;
  title: HTMLElement;
  counter: HTMLElement;
  link: HTMLAnchorElement;
  elsewhere: HTMLAnchorElement;
  zoom: HTMLAnchorElement;
  prev: HTMLButtonElement;
  next: HTMLButtonElement;
};

let el: GalleryElements;
let photos: ItemPhoto[] = [];
let index = 0;

/**
 * Marque de l'article affiché, transmise à la recherche Lens de la photo
 * courante (voir `show()`). `undefined` si l'article n'en a pas — Lens reste
 * alors une recherche purement visuelle.
 */
let currentBrand: string | undefined;

/**
 * Chargements de pleine résolution en vol, indexés par position.
 *
 * Sans cette trace, changer de photo pendant qu'un `full` charge le fait
 * apparaître **par-dessus la photo suivante** : l'événement `load` arrive après
 * la navigation, et rien ne dit à quelle photo il se rapporte.
 */
const upgrades = new Map<number, HTMLImageElement>();

/** Le geste tactile n'est un balayage qu'au-delà de cette distance. */
const SWIPE_PX = 40;

function show(next: number): void {
  if (!photos.length) return;

  index = (next + photos.length) % photos.length;
  const photo = photos[index];
  if (!photo) return;

  for (const pending of upgrades.values()) pending.src = '';
  upgrades.clear();

  el.image.src = photo.url;
  el.image.alt = `Photo ${index + 1} sur ${photos.length}`;
  el.stage.style.background = photo.dominantColor ?? 'var(--surface)';

  // La recherche vise la photo affichée à l'écran, pas la meilleure de
  // l'article (voir bestPhoto() dans elsewhere.ts) : ici, c'est justement le
  // choix de l'utilisateur qui fait foi.
  el.elsewhere.href = lensUrl(photo.url, currentBrand);

  // Pleine résolution, en dehors du panneau : `target="_blank"` sur un lien
  // suffit, pas besoin d'attendre l'upgrade in-place de l'image affichée.
  el.zoom.href = photo.full;

  // Réserver le ratio évite que le cadre saute d'une photo à l'autre. Le flux
  // d'hydratation donne les dimensions ; le repli DOM, non.
  el.stage.style.aspectRatio =
    photo.width && photo.height ? `${photo.width}/${photo.height}` : '3/4';

  el.counter.textContent = `${index + 1} / ${photos.length}`;
  const single = photos.length < 2;
  el.prev.hidden = single;
  el.next.hidden = single;

  for (const [position, thumb] of [...el.thumbs.children].entries()) {
    thumb.classList.toggle('is-current', position === index);
    if (position === index) thumb.setAttribute('aria-current', 'true');
    else thumb.removeAttribute('aria-current');
  }

  upgrade(index, photo);
  preload(index + 1);
}

/**
 * Substitue la pleine résolution une fois qu'elle est arrivée — et seulement si
 * l'utilisateur regarde toujours cette photo-là. Un échec (URL signée expirée,
 * réseau coupé) ne fait rien : la version affichée reste à l'écran.
 */
function upgrade(position: number, photo: ItemPhoto): void {
  if (photo.full === photo.url) return;

  const loader = new Image();
  upgrades.set(position, loader);

  loader.addEventListener('load', () => {
    if (index === position) el.image.src = photo.full;
    upgrades.delete(position);
  });
  loader.addEventListener('error', () => upgrades.delete(position));

  loader.src = photo.full;
}

/**
 * La photo suivante en taille d'affichage : la navigation paraît instantanée.
 *
 * Rien à précharger quand il n'y en a qu'une — la position suivante boucle sur
 * la photo courante, et on redemanderait l'image déjà à l'écran.
 */
function preload(position: number): void {
  if (photos.length < 2) return;

  const photo = photos[position % photos.length];
  if (photo) new Image().src = photo.url;
}

function renderThumbs(): void {
  el.thumbs.textContent = '';
  el.thumbs.hidden = photos.length < 2;

  photos.forEach((photo, position) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'gallery-thumb';
    button.title = `Photo ${position + 1}`;

    const img = document.createElement('img');
    img.src = photo.thumb;
    img.alt = '';
    img.draggable = false;
    button.append(img);

    button.addEventListener('click', () => {
      show(position);
    });
    el.thumbs.append(button);
  });
}

/** Ouvre la visionneuse sur la photo `start` (la première par défaut). */
export function openGallery(item: SavedItem, start = 0): void {
  photos = item.images ?? [];
  if (!photos.length) return;

  el.title.textContent = item.title || `Article ${item.id}`;
  el.link.href = item.url;
  currentBrand = item.brand?.trim() || undefined;

  renderThumbs();
  show(start);

  el.overlay.hidden = false;
  el.next.focus({ preventScroll: true });
}

const isOpen = (): boolean => !el.overlay.hidden;

/**
 * Câble la visionneuse. À appeler une fois, au démarrage du panneau : les
 * éléments sont ceux de `sidepanel.html`, et les écouteurs vivent aussi
 * longtemps que le panneau.
 */
export function initGallery(elements: GalleryElements): void {
  el = elements;

  el.prev.addEventListener('click', () => {
    show(index - 1);
  });
  el.next.addEventListener('click', () => {
    show(index + 1);
  });

  // Les flèches ne servent qu'à la visionneuse ouverte : ailleurs, elles
  // appartiennent à la liste et au champ de recherche.
  document.addEventListener('keydown', (event) => {
    if (!isOpen()) return;
    if (event.key === 'ArrowLeft') show(index - 1);
    else if (event.key === 'ArrowRight') show(index + 1);
    else return;
    event.preventDefault();
  });

  let startX: number | null = null;

  el.stage.addEventListener('pointerdown', (event) => {
    startX = event.clientX;
  });

  el.stage.addEventListener('pointerup', (event) => {
    if (startX === null) return;
    const dx = event.clientX - startX;
    startX = null;
    if (Math.abs(dx) >= SWIPE_PX) show(dx < 0 ? index + 1 : index - 1);
  });

  // Un pointeur qui quitte la scène en cours de geste ne doit pas laisser un
  // point de départ périmé, qui ferait défiler au prochain relâchement.
  el.stage.addEventListener('pointercancel', () => {
    startX = null;
  });
  el.stage.addEventListener('pointerleave', () => {
    startX = null;
  });
}
