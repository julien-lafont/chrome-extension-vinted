/**
 * Vinted Favoris — panneau latéral.
 *
 * Lit chrome.storage.local et se resynchronise dès qu'un onglet Vinted écrit.
 * Les articles sont regroupés en collections, ordonnables à la main.
 */

import {
  ITEMS_KEY,
  COLLECTIONS_KEY,
  SETTINGS_KEY,
  NOISE_KEY,
  ARCHIVE_COLLECTION_ID,
  DEFAULT_COLLECTION_ID,
  readAll,
  sortCollections,
  collectionOf,
  saveSettings,
  createCollection,
  renameCollection,
  deleteCollection,
  moveItemToCollection,
  commitCustomOrder,
  removeItem,
  restoreItem,
  archiveSold,
  restoreArchived,
} from './store.ts';

import {
  SORT_MODES,
  DIR_LABELS,
  defaultDirFor,
  sortItems,
  mergeVisibleOrder,
  countMissing,
  parsePrice,
} from './sorting.ts';

import { enableDragAndDrop } from './dnd.ts';
import { initGallery, openGallery } from './gallery.ts';
import { similarSearchUrl, brandSearchUrl } from './search.ts';
import { elsewhereSearches } from './elsewhere.ts';
import { initWatch, maybeStartSilentSweep, resetRateLimits } from './watch.ts';
import { initPriceHistory } from './price-history.ts';
import { renderPriceAndStatus, renderSeller } from './item-render.ts';
import { setFilters } from './filters.ts';

import type { CollectionMap, Collection, SavedItem, Settings, SortMode } from '../shared/types.ts';

/**
 * Élément du panneau dont l'absence serait un bug de `sidepanel.html`, pas un cas
 * à gérer : sans ses conteneurs, le panneau n'a rien à afficher. Échouer ici, avec
 * l'identifiant fautif, vaut mieux que propager des `null` jusqu'au premier accès.
 */
function required<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`sidepanel.html : élément #${id} introuvable`);
  return el as T;
}

/** Même intention que `required`, pour un descendant d'un nœud déjà obtenu. */
function within<T extends Element>(root: ParentNode, selector: string): T {
  const el = root.querySelector<T>(selector);
  if (!el) throw new Error(`sidepanel.html : ${selector} introuvable`);
  return el;
}

const listEl = required('list');
const countEl = required('count');
const searchEl = required<HTMLInputElement>('search');
const reportEl = required('report');
const collectionsEl = required('collections');
const sortEl = required<HTMLSelectElement>('sort');
const sortDirEl = required<HTMLButtonElement>('sort-dir');
const sortDirLabelEl = required('sort-dir-label');
const openAllEl = required<HTMLButtonElement>('open-all');
const openAllLabelEl = required('open-all-label');
const refreshEl = required<HTMLButtonElement>('refresh');
const refreshLabelEl = required('refresh-label');
const watchNoticeEl = required('watch-notice');
const watchbarEl = required('watchbar');
const hintEl = required('hint');
const hideAdsEl = required<HTMLButtonElement>('hide-ads');
const menuEl = required('move-menu');
const template = required<HTMLTemplateElement>('item-template');

/** État courant, rechargé intégralement à chaque écriture du storage. */
let items: SavedItem[] = [];
let collections: CollectionMap = {};
let settings: Settings;
let filter = '';

/** Un rendu pendant un glisser détruirait l'élément saisi : on le diffère. */
let dragging = false;
let renderPending = false;

/** Articles actuellement affichés (collection active + filtre de recherche), pour « Tout ouvrir ». */
let visibleOrdered: SavedItem[] = [];

/** Message transitoire affiché sous la barre de tri, prioritaire sur les indices. */
let notice = '';
let noticeUndo: (() => void) | undefined;
let noticeTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Affiche un message le temps d'être lu. Survit aux rendus, contrairement au DOM.
 * Un `undo` optionnel fait apparaître un bouton « Annuler » à côté du message,
 * actif pendant la même fenêtre de 5 s.
 */
function flash(message: string, undo?: () => void): void {
  notice = message;
  noticeUndo = undo;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    notice = '';
    noticeUndo = undefined;
    render();
  }, 5000);
  render();
}

// --- Chargement ---------------------------------------------------------------

async function reload(): Promise<void> {
  const data = await readAll();
  items = data.items;
  collections = data.collections;
  settings = data.settings;
  // La modale des filtres suit l'état global plutôt que de relire le storage de
  // son côté : une seule source, un seul moment de lecture.
  setFilters(data.noise, data.settings);
  render();
}

const activeCollection = () =>
  collections[settings.activeCollectionId] || collections[DEFAULT_COLLECTION_ID];

/** Articles de la collection active, avant tri et avant filtre de recherche. */
function itemsOfActiveCollection(): SavedItem[] {
  const activeId = settings.activeCollectionId;
  return items.filter((item) => collectionOf(item, collections) === activeId);
}

function matches(item: SavedItem): boolean {
  if (!filter) return true;
  return [item.title, item.brand, item.size, item.condition, item.price]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .includes(filter);
}

// --- Rendu : collections ------------------------------------------------------

function renderCollections(): void {
  collectionsEl.textContent = '';

  const counts = new Map<string, number>();
  for (const item of items) {
    const id = collectionOf(item, collections);
    counts.set(id, (counts.get(id) || 0) + 1);
  }

  for (const collection of sortCollections(collections)) {
    const size = counts.get(collection.id) || 0;

    // « Archives » n'est pas une collection parmi d'autres : c'est le dépôt de
    // ce qui est vendu ou parti. Elle se rend en icône seule, sans compteur —
    // le nombre d'articles archivés n'est pas une information qu'on pilote — et
    // `sortCollections()` la place toujours en dernier.
    const isArchive = collection.id === ARCHIVE_COLLECTION_ID;

    // Conteneur plutôt que bouton : un bouton ne peut pas en contenir un autre,
    // et l'onglet accueille la croix de suppression.
    const tab = document.createElement('div');
    tab.className = isArchive ? 'tab tab-archive' : 'tab';
    tab.dataset.dropCollection = collection.id;
    if (collection.id === settings.activeCollectionId) tab.classList.add('active');

    const select = document.createElement('button');
    select.type = 'button';
    select.className = 'tab-select';
    select.title = isArchive ? 'Archives' : `${collection.name} — clic droit pour renommer`;

    const name = document.createElement('span');
    name.className = 'tab-name';
    name.textContent = isArchive ? '🗄️' : collection.name;
    if (isArchive) select.setAttribute('aria-label', 'Archives');

    select.append(name);

    if (!isArchive) {
      const count = document.createElement('span');
      count.className = 'tab-count';
      count.textContent = String(size);
      select.append(count);
    }

    select.addEventListener('click', () => {
      void saveSettings({ activeCollectionId: collection.id }).then((next) => {
        settings = next;
        render();
      });
    });

    tab.append(select);

    // Supprimable seulement une fois vidée : la collection par défaut, jamais.
    // « Archives » non plus — elle est recréée d'elle-même au prochain archivage,
    // et une croix à côté d'une icône seule ferait un onglet illisible.
    if (collection.id !== DEFAULT_COLLECTION_ID && !isArchive && size === 0) {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'tab-delete';
      remove.textContent = '×';
      remove.title = `Supprimer la collection « ${collection.name} »`;
      remove.setAttribute('aria-label', remove.title);
      remove.addEventListener('click', () => {
        void removeCollection(collection);
      });
      tab.append(remove);
    }

    // Renommer « Archives » n'aurait aucun effet visible : son onglet ne montre
    // que son icône.
    if (!isArchive) {
      tab.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        openCollectionMenu(collection, tab);
      });
    }

    // Le `+` reste au bout des collections ordinaires ; « Archives » est poussée
    // contre le bord droit (voir `.tab-archive` dans la feuille de style).
    if (isArchive) collectionsEl.append(archiveSpacer(), tab);
    else collectionsEl.append(tab);
  }

  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'tab-add';
  add.textContent = '+';
  add.title = 'Nouvelle collection';
  add.addEventListener('click', () => openCollectionDialog(null));

  // Avant « Archives », qui doit rester le dernier élément de la barre.
  const archive = collectionsEl.querySelector('.tab-archive');
  collectionsEl.insertBefore(add, archive?.previousElementSibling ?? null);
}

/**
 * Pousse « Archives » contre le bord droit tant que la barre n'est pas pleine.
 *
 * Un élément flexible plutôt qu'un `margin-left: auto` sur l'onglet : la barre
 * défile horizontalement (`overflow-x: auto`), et une marge automatique y
 * calcule sa place sur la largeur visible, pas sur le contenu — l'onglet
 * s'échappait hors de la zone de défilement dès que les collections
 * débordaient. Un ressort, lui, se comprime à zéro et « Archives » reprend
 * simplement sa place au bout de la file.
 */
function archiveSpacer(): HTMLElement {
  const spacer = document.createElement('span');
  spacer.className = 'tab-spacer';
  spacer.setAttribute('aria-hidden', 'true');
  return spacer;
}

// --- Rendu : barre de tri -----------------------------------------------------

function renderSortbar(visibleItems: SavedItem[]): void {
  if (!sortEl.options.length) {
    for (const mode of SORT_MODES) {
      const option = document.createElement('option');
      option.value = mode.id;
      option.textContent = mode.label;
      sortEl.append(option);
    }
  }

  sortEl.value = settings.sortMode;

  // En ordre personnalisé, le sens n'a pas de signification utile.
  const isCustom = settings.sortMode === 'custom';
  sortDirEl.hidden = isCustom;
  if (!isCustom) {
    const labels = DIR_LABELS[settings.sortMode] ?? { asc: 'Croissant', desc: 'Décroissant' };
    sortDirLabelEl.textContent = labels[settings.sortDir] || labels.asc;
  }

  // Prévient plutôt que de laisser croire à un tri silencieusement incomplet.
  const missing = countMissing(visibleItems, settings.sortMode);
  if (notice) {
    hintEl.hidden = false;
    hintEl.textContent = '';
    hintEl.append(document.createTextNode(notice));
    if (noticeUndo) {
      hintEl.append(document.createTextNode(' · '));
      const undo = document.createElement('button');
      undo.type = 'button';
      undo.className = 'link';
      undo.textContent = 'Annuler';
      undo.addEventListener('click', () => {
        noticeUndo?.();
        clearTimeout(noticeTimer);
        notice = '';
        noticeUndo = undefined;
        render();
      });
      hintEl.append(undo);
    }
  } else if (isCustom) {
    hintEl.hidden = true;
  } else if (missing) {
    hintEl.hidden = false;
    hintEl.textContent = `${missing} article${missing > 1 ? 's' : ''} sans donnée pour ce tri, placé${
      missing > 1 ? 's' : ''
    } en fin de liste.`;
  } else {
    hintEl.hidden = true;
  }
}

/**
 * Ligne d'état des vendus (§6.5) : n'apparaît que lorsque la collection
 * affichée contient au moins un vendu ou disparu — une case à cocher
 * permanente ne servirait à rien 90 % du temps dans une barre déjà chargée.
 */
function renderWatchbar(gone: SavedItem[]): void {
  if (!gone.length) {
    watchbarEl.hidden = true;
    return;
  }

  watchbarEl.hidden = false;
  watchbarEl.textContent = '';
  watchbarEl.append(
    document.createTextNode(
      `${gone.length} vendu${gone.length > 1 ? 's' : ''} dans cette collection`
    )
  );

  watchbarEl.append(document.createTextNode(' · '));
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'link';
  // Le compte reste visible : masquer n'est pas oublier.
  toggle.textContent = settings.hideSold ? 'Afficher' : 'Masquer';
  toggle.addEventListener('click', () => {
    void saveSettings({ hideSold: !settings.hideSold }).then((next) => {
      settings = next;
      render();
    });
  });
  watchbarEl.append(toggle);

  watchbarEl.append(document.createTextNode(' · '));
  const archive = document.createElement('button');
  archive.type = 'button';
  archive.className = 'link';
  archive.textContent = 'Archiver';
  archive.addEventListener('click', () => {
    void archiveSoldFromButton();
  });
  watchbarEl.append(archive);
}

/**
 * Déplace les vendus de la collection active vers « Archives ». Pas une
 * suppression : `flash()` offre 5 s pour l'annuler, sur le modèle exact du
 * retrait d'un article.
 */
async function archiveSoldFromButton(): Promise<void> {
  const result = await archiveSold(settings.activeCollectionId);
  if (!result.movedIds.length) return;

  const count = result.movedIds.length;
  flash(`${count} article${count > 1 ? 's' : ''} archivé${count > 1 ? 's' : ''}`, () => {
    void restoreArchived(result);
  });
}

// --- Rendu : liste ------------------------------------------------------------

function renderEmpty(message: string, hint: string): void {
  const div = document.createElement('div');
  div.className = 'empty';
  const strong = document.createElement('strong');
  strong.textContent = message;
  div.append(strong, document.createTextNode(hint));
  listEl.append(div);
}

function renderItem(item: SavedItem): DocumentFragment {
  const node = template.content.cloneNode(true) as DocumentFragment;
  const article = within<HTMLElement>(node, '.item');
  article.dataset.id = item.id;

  const thumb = within<HTMLButtonElement>(node, '.item-thumb');
  const img = within<HTMLImageElement>(node, '.item-thumb img');
  if (item.imageUrl) {
    img.src = item.imageUrl;
    img.alt = item.title || '';
  }

  // La galerie n'existe que sur les articles dont la fiche a été lue depuis la
  // 0.3 : les autres gardent le comportement d'avant, l'onglet Vinted.
  const photos = item.images?.length ?? 0;

  if (photos) {
    thumb.title = photos > 1 ? `Voir les ${photos} photos` : 'Voir la photo';
    thumb.addEventListener('click', () => {
      openGallery(item);
    });
  } else {
    thumb.title = 'Ouvrir sur Vinted';
    thumb.addEventListener('click', () => {
      void chrome.tabs.create({ url: item.url, active: true });
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

  // "Nike · 42 · Neuf avec étiquette", en sautant les champs absents. La marque
  // devient un lien vers le catalogue quand on peut la filtrer.
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

  const likes = item.favouriteCount ?? item.likes;
  if (typeof likes === 'number') meta.push(document.createTextNode(`♥ ${likes}`));

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

  renderPriceAndStatus(node, article, item);
  renderSeller(node, item);

  within(node, '.item-similar').addEventListener('click', () => {
    void chrome.tabs.create({ url: similarSearchUrl(item), active: true });
  });

  const elsewhere = elsewhereSearches(item)[0];
  const elsewhereBtn = within<HTMLButtonElement>(node, '.item-elsewhere');
  elsewhereBtn.title =
    elsewhere.kind === 'lens'
      ? 'Rechercher cette photo sur Google Lens'
      : 'Rechercher ce modèle sur Google (pas de photo lisible)';
  elsewhereBtn.addEventListener('click', () => {
    void chrome.tabs.create({ url: elsewhere.url, active: true });
  });

  within(node, '.item-move').addEventListener('click', (event) => {
    if (event.currentTarget instanceof HTMLElement) openMoveMenu(item, event.currentTarget);
  });
  within(node, '.item-remove').addEventListener('click', () => {
    void removeItem(item.id);
    flash('Article retiré', () => void restoreItem(item));
  });

  return node;
}

function render(): void {
  if (dragging) {
    renderPending = true;
    return;
  }

  renderCollections();
  hideAdsEl.setAttribute('aria-pressed', String(settings.hideAds));

  const inCollection = itemsOfActiveCollection();
  const isGone = (item: SavedItem) => item.status === 'sold' || item.status === 'gone';
  const visible = inCollection
    .filter(matches)
    .filter((item) => !settings.hideSold || !isGone(item));
  countEl.textContent = String(inCollection.length);

  renderSortbar(inCollection);
  renderWatchbar(inCollection.filter(isGone));

  const ordered = sortItems(
    visible,
    settings.sortMode,
    settings.sortDir,
    activeCollection()?.order ?? []
  );

  visibleOrdered = ordered;
  openAllEl.disabled = ordered.length === 0;
  openAllLabelEl.textContent = ordered.length ? `Tout ouvrir (${ordered.length})` : 'Tout ouvrir';

  listEl.textContent = '';

  if (!inCollection.length) {
    renderEmpty(
      'Collection vide',
      settings.activeCollectionId === DEFAULT_COLLECTION_ID
        ? "Ouvre Vinted et clique sur l'icône en haut à droite d'un article."
        : 'Glisse un article sur cet onglet pour le classer ici.'
    );
    return;
  }

  if (!ordered.length) {
    renderEmpty('Aucun résultat', 'Essaie un autre terme de recherche.');
    return;
  }

  const frag = document.createDocumentFragment();
  for (const item of ordered) frag.append(renderItem(item));
  listEl.append(frag);
}

// --- Glisser-déposer ----------------------------------------------------------

enableDragAndDrop(listEl, {
  canDrag: () => settings.sortMode === 'custom',

  /**
   * Glisser dans un tri automatique bascule en ordre personnalisé : on fige
   * l'ordre affiché pour que rien ne bouge sous la main de l'utilisateur.
   */
  onStart: () => {
    dragging = true;
    // Bascule affichée sans re-rendre la liste : l'élément saisi doit survivre.
    settings = { ...settings, sortMode: 'custom', sortDir: 'asc' };
    sortEl.value = 'custom';
    sortDirEl.hidden = true;
    hintEl.hidden = false;
    hintEl.textContent = 'Ordre personnalisé activé.';
  },

  onDrop: (ids) => {
    dragging = false;

    const collectionId = settings.activeCollectionId;
    // La recherche peut masquer des articles : ils gardent leur place dans l'ordre complet.
    const order = mergeVisibleOrder(collections[collectionId]?.order ?? [], ids);

    // L'état local prend l'ordre déposé avant l'écriture : un rendu déclenché
    // entre-temps (autre onglet, autre écriture) affiche déjà le bon ordre.
    const collection = collections[collectionId];
    if (collection) collections = { ...collections, [collectionId]: { ...collection, order } };
    settings = { ...settings, sortMode: 'custom', sortDir: 'asc' };

    void commitCustomOrder(collectionId, order);
  },

  onDropToCollection: (itemId, collectionId) => {
    dragging = false;
    if (collectionId === settings.activeCollectionId) {
      render();
      return;
    }
    void moveItemToCollection(itemId, collectionId);
  },

  onCancel: () => {
    dragging = false;
    render();
  },
});

// Marqué dès la saisie de la poignée : une écriture du storage arrivant en plein
// glisser ne doit pas re-rendre la liste sous la main de l'utilisateur.
listEl.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  if (event.target instanceof Element && event.target.closest('.item-drag')) dragging = true;
});

document.addEventListener('pointerup', () => {
  if (!dragging) return;
  dragging = false;
  if (renderPending) {
    renderPending = false;
    render();
  }
});

// --- Menus contextuels --------------------------------------------------------

function closeMenu(): void {
  menuEl.hidden = true;
  menuEl.textContent = '';
}

/** Ouvre `menuEl` sous l'élément d'ancrage, recalé pour rester dans le panneau. */
function openMenu(anchor: HTMLElement, build: (menu: HTMLElement) => void): void {
  menuEl.textContent = '';
  build(menuEl);
  menuEl.hidden = false;

  const rect = anchor.getBoundingClientRect();
  const menuRect = menuEl.getBoundingClientRect();

  const left = Math.max(8, Math.min(rect.left, window.innerWidth - menuRect.width - 8));
  const top =
    rect.bottom + menuRect.height + 8 > window.innerHeight
      ? Math.max(8, rect.top - menuRect.height - 4)
      : rect.bottom + 4;

  menuEl.style.left = `${left}px`;
  menuEl.style.top = `${top}px`;
}

function menuButton(
  label: string,
  onClick: () => void,
  { current = false, danger = false }: { current?: boolean; danger?: boolean } = {}
): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = danger ? 'menu-item danger' : 'menu-item';
  btn.textContent = label;
  if (current) btn.setAttribute('aria-current', 'true');
  btn.addEventListener('click', () => {
    closeMenu();
    onClick();
  });
  return btn;
}

function openMoveMenu(item: SavedItem, anchor: HTMLElement): void {
  const currentId = collectionOf(item, collections);

  openMenu(anchor, (menu) => {
    const title = document.createElement('p');
    title.className = 'menu-title';
    title.textContent = 'Déplacer vers';
    menu.append(title);

    for (const collection of sortCollections(collections)) {
      menu.append(
        menuButton(
          collection.name,
          () => {
            void moveItemToCollection(item.id, collection.id);
          },
          { current: collection.id === currentId }
        )
      );
    }

    const separator = document.createElement('hr');
    separator.className = 'menu-sep';
    menu.append(
      separator,
      menuButton('Nouvelle collection…', () => openCollectionDialog(null, item.id))
    );
  });
}

/**
 * Supprime une collection vide et revient sur celle par défaut si c'était l'active.
 *
 * Le refus du storage n'est pas théorique : un autre onglet Vinted a pu y classer
 * un article depuis le dernier rendu. On le dit alors, plutôt que de laisser un
 * clic sans effet visible.
 */
async function removeCollection(collection: Collection): Promise<void> {
  const result = await deleteCollection(collection.id);

  if (!result.ok) {
    const raison =
      result.reason === 'not-empty'
        ? `« ${collection.name} » n'est plus vide : elle ne peut plus être supprimée.`
        : `« ${collection.name} » n'a pas pu être supprimée.`;
    await reload();
    flash(raison);
    return;
  }

  if (settings.activeCollectionId === collection.id) {
    settings = await saveSettings({ activeCollectionId: DEFAULT_COLLECTION_ID });
  }
}

function openCollectionMenu(collection: Collection, anchor: HTMLElement): void {
  openMenu(anchor, (menu) => {
    menu.append(menuButton('Renommer…', () => openCollectionDialog(collection)));
  });
}

document.addEventListener('pointerdown', (event) => {
  const target = event.target;
  if (!menuEl.hidden && target instanceof Node && !menuEl.contains(target)) closeMenu();
});

// --- Modale : collection ------------------------------------------------------

const collectionDialog = required('collection-dialog');
const collectionForm = required<HTMLFormElement>('collection-form');
const collectionNameEl = required<HTMLInputElement>('collection-name');
const collectionTitleEl = required('collection-dialog-title');
const collectionSubmitEl = required('collection-submit');

/** Collection en cours de renommage, sinon null (création). */
let editingCollection: Collection | null = null;
/** Article à déplacer dans la collection dès sa création, sinon null. */
let pendingItemForNewCollection: string | null = null;

function openCollectionDialog(collection: Collection | null, itemId: string | null = null): void {
  editingCollection = collection;
  pendingItemForNewCollection = itemId;

  collectionTitleEl.textContent = collection ? 'Renommer la collection' : 'Nouvelle collection';
  collectionSubmitEl.textContent = collection ? 'Renommer' : 'Créer';
  collectionNameEl.value = collection ? collection.name : '';

  collectionDialog.hidden = false;
  collectionNameEl.focus();
  collectionNameEl.select();
}

collectionForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const name = collectionNameEl.value.trim();
  if (!name) return;

  collectionDialog.hidden = true;

  void (async () => {
    if (editingCollection) {
      await renameCollection(editingCollection.id, name);
      return;
    }

    const collection = await createCollection(name);
    if (pendingItemForNewCollection) {
      await moveItemToCollection(pendingItemForNewCollection, collection.id);
    }
    settings = await saveSettings({ activeCollectionId: collection.id });
    render();
  })();
});

// --- Visionneuse de photos ----------------------------------------------------

initGallery({
  overlay: required('gallery-dialog'),
  image: required<HTMLImageElement>('gallery-image'),
  stage: required('gallery-stage'),
  thumbs: required('gallery-thumbs'),
  title: required('gallery-title'),
  counter: required('gallery-counter'),
  link: required<HTMLAnchorElement>('gallery-link'),
  elsewhere: required<HTMLAnchorElement>('gallery-elsewhere'),
  zoom: required<HTMLAnchorElement>('gallery-zoom'),
  prev: required<HTMLButtonElement>('gallery-prev'),
  next: required<HTMLButtonElement>('gallery-next'),
});

// --- Suivi de prix et de disponibilité -----------------------------------------

initPriceHistory(required('price-history'));

initWatch(
  { button: refreshEl, label: refreshLabelEl, notice: watchNoticeEl },
  {
    visibleIds: () => visibleOrdered.map((item) => item.id),
    getItems: () => items,
    onSweepSummary: (message) => flash(message),
  }
);

// Silencieux : si aucun onglet Vinted n'est ouvert, ou si le dernier cycle est
// récent, ne fait rien et ne le signale pas (§5.2).
void maybeStartSilentSweep();

// --- Fermeture des modales ----------------------------------------------------

for (const overlay of document.querySelectorAll<HTMLElement>('.overlay')) {
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) overlay.hidden = true;
  });
}

for (const button of document.querySelectorAll('[data-close]')) {
  button.addEventListener('click', () => {
    const overlay = button.closest<HTMLElement>('.overlay');
    if (overlay) overlay.hidden = true;
  });
}

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  closeMenu();
  for (const overlay of document.querySelectorAll<HTMLElement>('.overlay:not([hidden])')) {
    overlay.hidden = true;
  }
});

// --- Export -------------------------------------------------------------------

function exportJson(): void {
  const payload = {
    exportedAt: new Date().toISOString(),
    collections: sortCollections(collections).map(({ id, name, order }) => ({ id, name, order })),
    items: items.map((item) => ({ ...item, collectionId: collectionOf(item, collections) })),
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `vinted-favoris-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

// --- Diagnostic ---------------------------------------------------------------

/**
 * Interroge le content script de l'onglet actif : combien de cartes il détecte,
 * quels champs manquent. Sert à valider les sélecteurs en conditions réelles.
 *
 * La seconde moitié du rapport — champs de tri, contenu des articles — se lit
 * dans le storage : elle est produite même sans onglet Vinted, plutôt que de
 * renvoyer l'utilisateur sans rien quand il voulait juste inspecter ses données.
 */
async function runDiagnostic(): Promise<void> {
  reportEl.hidden = false;
  reportEl.textContent = 'Analyse en cours…';

  /** Rapport hétérogène par nature : chaque clé est une section, en français. */
  const report: Record<string, unknown> = {};

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const tabId = tab?.id;
  const onVinted = tabId !== undefined && tab?.url?.startsWith('https://www.vinted.fr/');

  if (!onVinted) {
    report.page =
      'Aucun onglet www.vinted.fr actif — analyse du DOM impossible. Ouvre une page de recherche ou une fiche article, puis relance le diagnostic.';
  } else {
    try {
      report.catalogue = await chrome.tabs.sendMessage(tabId, { type: 'VF_DIAGNOSE' });
    } catch {
      report.catalogue = 'Content script injoignable. Recharge la page Vinted (Cmd+R).';
    }
  }

  // Champs de tri réellement disponibles sur les articles enregistrés.
  report.donneesDeTri = {
    total: items.length,
    sansPrix: items.filter((item) => parsePrice(item) === null).length,
    sansLikes: items.filter((item) => typeof (item.favouriteCount ?? item.likes) !== 'number')
      .length,
    sansTaille: items.filter((item) => !item.size).length,
    sansEtat: items.filter((item) => !item.condition).length,
    sansCategorie: items.filter((item) => !item.category?.url).length,
    // Fiche encore en cours de lecture : ces articles n'ont que les données de
    // leur carte. Un compte qui ne redescend jamais signale un fetch qui échoue.
    enAttenteDeFiche: items.filter((item) => item.pending).length,
    // Catégorie héritée de la page de navigation, donc possiblement plus large
    // que celle de l'article : enregistré depuis une page catégorie, pas une fiche.
    categorieApprochee: items.filter((item) => item.category && !item.category.exact).length,
  };

  // Les articles enregistrés, tels quels. Les compteurs ci-dessus disent *combien*
  // d'articles n'ont pas telle donnée ; seul le contenu dit *ce qui* a été
  // enregistré à la place — un état rangé dans la taille, un prix suffixé, un
  // champ absent parce que l'article date d'avant son extraction.
  //
  // En dernière clé du rapport : le reste doit rester lisible sans défiler.
  report.articles = items.map((item) => ({
    ...item,
    collectionId: collectionOf(item, collections),
  }));

  reportEl.textContent = JSON.stringify(report, null, 2);
}

// --- Écouteurs ----------------------------------------------------------------

searchEl.addEventListener('input', () => {
  filter = searchEl.value.trim().toLowerCase();
  render();
});

sortEl.addEventListener('change', () => {
  // `sortEl` ne contient que les options issues de SORT_MODES : la conversion
  // constate ce que le rendu garantit.
  const mode = sortEl.value as SortMode;
  void saveSettings({ sortMode: mode, sortDir: defaultDirFor(mode) }).then((next) => {
    settings = next;
    render();
  });
});

sortDirEl.addEventListener('click', () => {
  void saveSettings({ sortDir: settings.sortDir === 'asc' ? 'desc' : 'asc' }).then((next) => {
    settings = next;
    render();
  });
});

/**
 * Ouvre dans de nouveaux onglets tous les articles actuellement affichés (collection
 * active + filtre de recherche) : le geste naturel du chineur qui veut comparer ses
 * candidats côte à côte. Confirmation au-delà d'un seuil pour éviter d'ouvrir une
 * grosse collection entière par erreur.
 */
openAllEl.addEventListener('click', () => {
  const toOpen = visibleOrdered;
  if (!toOpen.length) return;
  if (toOpen.length > 12 && !confirm(`Ouvrir ${toOpen.length} onglets ?`)) return;
  for (const item of toOpen) void chrome.tabs.create({ url: item.url, active: false });
});

hideAdsEl.addEventListener('click', () => {
  void saveSettings({ hideAds: !settings.hideAds }).then((next) => {
    settings = next;
    render();
  });
});

required('export').addEventListener('click', exportJson);
required('diagnose').addEventListener('click', () => {
  void runDiagnostic();
});

/**
 * Remise à zéro des garde-fous de débit. Le rapport affiche ce qui a été levé —
 * sans lui, le bouton n'aurait aucun retour visible quand rien ne freinait, et
 * on ne saurait pas distinguer « c'était débloqué » de « le clic n'a rien fait ».
 */
required('reset-rate').addEventListener('click', () => {
  void resetRateLimits().then((before) => {
    reportEl.hidden = false;
    reportEl.textContent = JSON.stringify(
      {
        message:
          'Compteurs de débit remis à zéro (le bail et la date du dernier cycle sont intacts).',
        avant: {
          freine: before.freine,
          coupsDeFreinConsecutifs: before.coupsDeFrein,
          fichesLuesAujourdHui: before.budgetDuJour,
          jetonsRestants: before.jetons,
        },
      },
      null,
      2
    );
  });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes[ITEMS_KEY] || changes[COLLECTIONS_KEY] || changes[SETTINGS_KEY] || changes[NOISE_KEY])
    void reload();
});

void reload();
