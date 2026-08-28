/**
 * Vinted Smart Bookmarks — la liste d'articles du panneau.
 *
 * Une ligne par article, clonée de `#item-template`, et la mise à jour de la
 * liste d'un rendu au suivant. C'est le rendu le plus fourni du panneau : photo,
 * titre, métadonnées, prix et variation, vendeur, quatre actions.
 *
 * Extrait de `sidepanel.ts` pour la raison qui vaut déjà pour `gallery.ts`,
 * `item-render.ts` et `price-history.ts` : `sidepanel.ts` cherche ses éléments
 * (`required('list')`) dès son chargement, si bien que l'importer hors du panneau
 * lève avant d'avoir rien pu appeler — rien de ce qu'il contenait n'était
 * atteignable par un test. Ici, tout arrive par paramètre : les nœuds au
 * `initItemList()`, les gestes par des rappels. Aucun accès à `chrome`, aucun
 * effet au chargement.
 *
 * Deux choses ne sont pas cosmétiques et sont commentées à leur place : la
 * conservation des nœuds d'un rendu à l'autre (`renderedItems`), et le fait que
 * `renderEmpty()` soit le seul endroit qui vide la liste.
 */
import { elsewhereSearches } from './elsewhere.ts';
import { within } from './dom.ts';
import { renderOffer, renderPriceAndStatus, renderSeller } from './item-render.ts';
import { reconcile } from './reconcile.ts';
import { brandSearchUrl, similarSearchUrl } from './search.ts';
import type { SavedItem } from '../shared/types.ts';

/** Les nœuds de `sidepanel.html` que la liste pilote. */
export type ItemListElements = {
  list: HTMLElement;
  template: HTMLTemplateElement;
};

/** Ce que la liste ne décide pas elle-même : ouvrir, déplacer, retirer. */
export type ItemListHooks = {
  /** Les photos de l'article, dans la visionneuse du panneau. */
  openPhotos: (item: SavedItem) => void;
  /** Une URL dans un nouvel onglet — `chrome.tabs` ne se voit pas d'ici. */
  openTab: (url: string) => void;
  /** Le menu de rangement, ancré sur le bouton cliqué. */
  openMoveMenu: (item: SavedItem, anchor: HTMLElement) => void;
  /** Retrait demandé depuis la ligne ; l'annulation est offerte par l'appelant. */
  onRemove: (item: SavedItem) => void;
  /** Clic sur la pastille de collection : le panneau bascule sur cet onglet. */
  openCollection: (collectionId: string) => void;
};

/** La collection à annoncer sur une ligne, ou `null` — voir `renderItems()`. */
export type CollectionBadge = { id: string; name: string };

let el: ItemListElements;
let hooks: ItemListHooks;

export function initItemList(elements: ItemListElements, callbacks: ItemListHooks): void {
  el = elements;
  hooks = callbacks;
  renderedItems.clear();
}

/**
 * Nœuds déjà rendus, par identifiant d'article, avec l'empreinte de l'article
 * qu'ils affichent.
 */
const renderedItems = new Map<string, { el: HTMLElement; fingerprint: string }>();

/**
 * Message qui remplace la liste : collection vide, ou recherche sans résultat.
 *
 * Seul endroit qui vide la liste d'un bloc — il n'y a alors plus de position de
 * défilement à préserver. Les nœuds restent en cache, prêts à être réinsérés si
 * l'utilisateur efface sa recherche.
 */
export function renderEmpty(message: string, hint: string): void {
  const div = document.createElement('div');
  div.className = 'empty';
  const strong = document.createElement('strong');
  strong.textContent = message;
  div.append(strong, document.createTextNode(hint));

  el.list.textContent = '';
  el.list.append(div);
}

/**
 * Affiche exactement ces articles, dans cet ordre.
 *
 * L'empreinte qui décide de réutiliser un nœud est l'article **sérialisé en
 * entier**, et non une liste de champs choisis : un champ ajouté au modèle et
 * oublié dans cette liste laisserait un nœud figé sur une valeur périmée, sans
 * rien pour le signaler. Sérialiser tout coûte quelques millisecondes et n'a
 * rien à maintenir. Un cycle de suivi de prix n'écrit qu'un article à la fois :
 * les autres lignes sont conservées telles quelles — voir `reconcile.ts` pour ce
 * que cette conservation préserve.
 *
 * @param badgeOf collection à annoncer sur la ligne, ou `null`. Elle **entre
 *   dans l'empreinte** : elle ne se déduit pas de l'article seul (il faudrait le
 *   nom de la collection et l'onglet affiché), et sans elle un renommage ou un
 *   changement d'onglet laisserait des pastilles périmées sur les lignes
 *   réutilisées.
 */
export function renderItems(
  items: readonly SavedItem[],
  badgeOf: (item: SavedItem) => CollectionBadge | null = () => null
): void {
  const nodes = items.map((item) => {
    const badge = badgeOf(item);
    const fingerprint = JSON.stringify([item, badge]);
    const previous = renderedItems.get(item.id);
    if (previous && previous.fingerprint === fingerprint) return previous.el;

    const node = renderItem(item, badge);
    renderedItems.set(item.id, { el: node, fingerprint });
    return node;
  });

  reconcile(el.list, nodes);

  // Les articles sortis de la liste (retirés, filtrés, rangés ailleurs) n'ont
  // plus de nœud à retrouver : sans cette purge, le cache grossirait à chaque
  // recherche tapée au clavier.
  const shown = new Set(items.map((item) => item.id));
  for (const id of renderedItems.keys()) {
    if (!shown.has(id)) renderedItems.delete(id);
  }
}

function renderItem(item: SavedItem, badge: CollectionBadge | null = null): HTMLElement {
  const node = el.template.content.cloneNode(true) as DocumentFragment;
  const article = within<HTMLElement>(node, '.item');
  article.dataset.id = item.id;

  const thumb = within<HTMLButtonElement>(node, '.item-thumb');
  const img = within<HTMLImageElement>(node, '.item-thumb img');
  if (item.imageUrl) {
    img.src = item.imageUrl;
    img.alt = item.title || '';
  }

  // La galerie n'existe que sur les articles dont la fiche a été lue : les
  // autres ouvrent l'onglet Vinted.
  const photos = item.images?.length ?? 0;

  if (photos) {
    thumb.title = photos > 1 ? `Voir les ${photos} photos` : 'Voir la photo';
    thumb.addEventListener('click', () => {
      hooks.openPhotos(item);
    });
  } else {
    thumb.title = 'Ouvrir sur Vinted';
    thumb.addEventListener('click', () => {
      hooks.openTab(item.url);
    });
  }

  if (photos > 1) {
    const count = within<HTMLElement>(node, '.item-photo-count');
    count.textContent = String(photos);
    count.hidden = false;
  }

  const title = within<HTMLAnchorElement>(node, '.item-title');
  title.href = item.url;
  title.textContent = item.title || `Article ${item.id}`;

  // "Nike · 42 · Neuf avec étiquette · ♥ 12 · Baskets", en sautant les champs
  // absents. La marque devient un lien vers le catalogue quand on peut la
  // filtrer.
  const meta: Node[] = [];

  if (item.brand) {
    const brandUrl = brandSearchUrl(item);
    if (brandUrl) {
      const link = document.createElement('a');
      link.className = 'item-brand';
      link.href = brandUrl;
      link.target = '_blank';
      link.rel = 'noreferrer';
      link.textContent = item.brand;
      link.title = item.category?.exact
        ? `Voir les ${item.brand} dans « ${item.category.name} »`
        : `Voir tous les articles ${item.brand}`;
      meta.push(link);
    } else {
      meta.push(document.createTextNode(item.brand));
    }
  }

  for (const value of [item.size, item.condition]) {
    if (value) meta.push(document.createTextNode(value));
  }

  const likes = item.favouriteCount;
  if (typeof likes === 'number') meta.push(document.createTextNode(`♥ ${likes}`));

  // La catégorie ferme la ligne plutôt que de l'ouvrir : c'est la plus large des
  // informations affichées, et la mettre en tête repousserait la marque, qui est
  // ce qu'on lit en premier. Le fil complet reste en infobulle — « Chaussures »
  // seul ne dit pas s'il s'agit d'homme, de femme ou d'enfant.
  const category = item.category;
  if (category?.name) {
    const categoryEl = document.createElement('span');
    categoryEl.className = 'item-category';
    categoryEl.textContent = category.name;

    const trail = category.path.length ? category.path.join(' › ') : category.name;
    // Une catégorie approchée vient de la page de catalogue d'où l'article a été
    // enregistré : elle décrit la page, pas forcément l'article (voir
    // `categoryOf()` dans `content/extract.ts`). L'infobulle le dit plutôt que
    // la ligne, qui n'a pas la place de nuancer.
    categoryEl.title = category.exact ? trail : `${trail} (catégorie de la page, approchée)`;
    meta.push(categoryEl);
  }

  const metaEl = within(node, '.item-meta');
  metaEl.textContent = '';
  meta.forEach((part, index) => {
    if (index) metaEl.append(document.createTextNode(' · '));
    metaEl.append(part);
  });

  // Enregistré depuis une carte : la fiche est en cours de lecture et va
  // compléter l'article (catégorie, taille, état…). L'article est déjà là et
  // reste manipulable — seule la ligne de métadonnées signale l'attente.
  if (item.pending) {
    article.classList.add('item--pending');

    const loader = document.createElement('span');
    loader.className = 'item-loading';
    loader.textContent = meta.length ? ' · complément…' : 'Lecture de la fiche…';
    loader.title = 'Lecture de la fiche article pour compléter les informations';
    metaEl.append(loader);
  }

  // Pastille de collection : elle ne s'affiche que là où elle apprend quelque
  // chose — dans « Mes favoris », qui mélange classés et non classés. Sous
  // l'onglet d'une collection, tout y est rangé, la répéter à chaque ligne
  // n'ajouterait que du bruit (c'est l'appelant qui rend `null`).
  if (badge) {
    within<HTMLElement>(node, '.item-where').hidden = false;
    within(node, '.item-collection-name').textContent = badge.name;

    const chip = within<HTMLButtonElement>(node, '.item-collection');
    chip.title = `Classé dans « ${badge.name} » — ouvrir cette collection`;
    chip.setAttribute('aria-label', chip.title);
    chip.addEventListener('click', () => {
      hooks.openCollection(badge.id);
    });
  }

  renderPriceAndStatus(node, article, item);
  renderOffer(node, item, hooks.openTab);
  renderSeller(node, item);

  within(node, '.item-similar').addEventListener('click', () => {
    hooks.openTab(similarSearchUrl(item));
  });

  const elsewhere = elsewhereSearches(item)[0];
  const elsewhereBtn = within<HTMLButtonElement>(node, '.item-elsewhere');
  elsewhereBtn.title =
    elsewhere.kind === 'lens'
      ? 'Rechercher cette photo sur Google Lens'
      : 'Rechercher ce modèle sur Google (pas de photo lisible)';
  elsewhereBtn.addEventListener('click', () => {
    hooks.openTab(elsewhere.url);
  });

  // Le bouton sert d'ancre au menu. Il est capturé plutôt que relu depuis
  // `event.currentTarget`, qui n'est typé que `EventTarget | null` et obligeait
  // à un garde d'exécution pour une valeur qu'on tient déjà.
  const moveBtn = within<HTMLButtonElement>(node, '.item-move');
  moveBtn.addEventListener('click', () => {
    hooks.openMoveMenu(item, moveBtn);
  });
  within(node, '.item-remove').addEventListener('click', () => {
    hooks.onRemove(item);
  });

  // L'article seul, détaché du fragment cloné : c'est lui que la réconciliation
  // garde en cache et replace, pas les nœuds de texte qui l'entourent.
  return article;
}
