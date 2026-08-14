/**
 * Vinted Smart Bookmarks — panneau latéral.
 *
 * Lit chrome.storage.local et se resynchronise dès qu'un onglet Vinted écrit.
 * Les articles sont regroupés en collections, ordonnables à la main.
 */

import {
  ITEMS_KEY,
  COLLECTIONS_KEY,
  SETTINGS_KEY,
  NOISE_KEY,
  DEFAULT_COLLECTION_ID,
  OFFERS_VIEW_ID,
  isInTab,
  isView,
  migrateStorage,
  readAll,
  sortCollections,
  classifiedIn,
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
import { required } from './dom.ts';
import { initGallery, openGallery } from './gallery.ts';
import { initItemList, renderEmpty, renderItems } from './item-list.ts';
import type { CollectionBadge } from './item-list.ts';
import { refreshOfferAges } from './item-render.ts';
import { maybeScanOffers, offersReport } from './offers.ts';
import { isLiveOffer } from '../shared/offers.ts';
import { renderCollectionsBar } from './collections-bar.ts';
import { closeMenu, initMenus, menuButton, menuSeparator, menuTitle, openMenu } from './menus.ts';
import { initWatch, maybeStartSilentSweep, resetRateLimits } from './watch.ts';
import { initPriceHistory } from './price-history.ts';
import { setFilters } from './filters.ts';

import type { CollectionMap, Collection, SavedItem, Settings, SortMode } from '../shared/types.ts';

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

/** La vue « Sous offres » est active — un filtre, pas une collection (offres.md §5). */
const inOffersView = () => settings.activeCollectionId === OFFERS_VIEW_ID;

/**
 * Articles de l'onglet actif, avant tri et avant filtre de recherche.
 *
 * « Mes favoris » n'est pas un rangement mais un récapitulatif : tout s'y
 * affiche, classé ou non, sauf ce qui est archivé (`isInTab()`). Même principe
 * dans la vue « Sous offres », où les articles sont **empruntés** à leurs
 * collections, qu'ils ne quittent pas.
 */
function itemsOfActiveCollection(): SavedItem[] {
  if (inOffersView()) return items.filter(isLiveOffer);

  const activeId = settings.activeCollectionId;
  return items.filter((item) => isInTab(item, activeId, collections));
}

/**
 * Ordre manuel de la liste affichée. La vue n'en a pas — rien ne s'y réordonne —
 * et retomber sur celui d'une collection quelconque y mélangerait deux logiques :
 * on la classe donc de l'offre la plus récente à la plus ancienne, ce qui est
 * l'ordre dans lequel on les traite.
 */
function customOrderForActive(visible: SavedItem[]): string[] {
  if (!inOffersView()) return activeCollection()?.order ?? [];

  return [...visible]
    .sort((a, b) => (b.offer?.at ?? 0) - (a.offer?.at ?? 0))
    .map((item) => item.id);
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
  renderCollectionsBar(
    collectionsEl,
    { collections, items, activeCollectionId: settings.activeCollectionId },
    {
      onSelect: (collectionId) => {
        void saveSettings({ activeCollectionId: collectionId }).then((next) => {
          settings = next;
          render();
        });
      },
      onDelete: (collection) => void removeCollection(collection),
      onContextMenu: openCollectionMenu,
      onCreate: () => openCollectionDialog(null),
    }
  );
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
  const where =
    settings.activeCollectionId === DEFAULT_COLLECTION_ID
      ? 'dans tes favoris'
      : 'dans cette collection';
  watchbarEl.append(
    document.createTextNode(`${gone.length} vendu${gone.length > 1 ? 's' : ''} ${where}`)
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
  if (!result.moved.length) return;

  const count = result.moved.length;
  flash(`${count} article${count > 1 ? 's' : ''} archivé${count > 1 ? 's' : ''}`, () => {
    void restoreArchived(result);
  });
}

// --- Rendu : liste ------------------------------------------------------------

initItemList(
  { list: listEl, template },
  {
    openPhotos: openGallery,
    openTab: (url) => void chrome.tabs.create({ url, active: true }),
    openMoveMenu: (item, anchor) => openMoveMenu(item, anchor),
    onRemove: (item) => {
      void removeItem(item.id);
      flash('Article retiré', () => void restoreItem(item));
    },
    openCollection: (collectionId) => {
      void saveSettings({ activeCollectionId: collectionId }).then((next) => {
        settings = next;
        render();
      });
    },
  }
);

/**
 * La pastille de collection d'une ligne, ou `null` quand elle n'apprendrait
 * rien : sous l'onglet d'une collection, tout ce qui s'affiche y est rangé.
 *
 * Elle n'apparaît donc que dans « Mes favoris » — qui montre le classé comme le
 * non classé — et dans la vue « Sous offres », où les articles viennent de
 * partout.
 */
function collectionBadge(item: SavedItem): CollectionBadge | null {
  const collection = classifiedIn(item, collections);
  if (!collection || collection.id === settings.activeCollectionId) return null;
  return { id: collection.id, name: collection.name };
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
    customOrderForActive(visible)
  );

  visibleOrdered = ordered;
  openAllEl.disabled = ordered.length === 0;
  openAllLabelEl.textContent = ordered.length ? `Tout ouvrir (${ordered.length})` : 'Tout ouvrir';

  if (!inCollection.length) {
    if (inOffersView()) {
      renderEmpty(
        'Aucune offre en cours',
        'Les offres refusées ou acceptées restent visibles sur leur article, dans sa collection.'
      );
      return;
    }

    if (settings.activeCollectionId === DEFAULT_COLLECTION_ID) {
      renderEmpty(
        'Aucun favori',
        "Ouvre Vinted et clique sur l'icône en haut à droite d'un article."
      );
      return;
    }

    renderEmpty('Collection vide', 'Glisse un article sur cet onglet pour le classer ici.');
    return;
  }

  if (!ordered.length) {
    renderEmpty('Aucun résultat', 'Essaie un autre terme de recherche.');
    return;
  }

  renderItems(ordered, collectionBadge);
}

// --- Glisser-déposer ----------------------------------------------------------

enableDragAndDrop(listEl, {
  // Jamais dans une vue : son ordre est celui des offres, et un dépôt y écrirait
  // un ordre personnalisé sur une collection qui n'existe pas.
  canDrag: () => settings.sortMode === 'custom' && !isView(settings.activeCollectionId),

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

  /**
   * Déposer sur « Mes favoris » déclasse : l'article y figure déjà, le seul sens
   * possible du geste est « retire-le de sa collection ». Même sémantique que
   * l'entrée « Aucune collection » du menu de rangement.
   */
  onDropToCollection: (itemId, collectionId) => {
    dragging = false;

    const target = collectionId === DEFAULT_COLLECTION_ID ? null : collectionId;
    const item = items.find((candidate) => candidate.id === itemId);

    // Comparé au classement de l'article, pas à l'onglet affiché : depuis « Mes
    // favoris », déposer sur « Mes favoris » est un geste utile pour un article
    // classé ailleurs, et un geste vide pour les autres.
    if (!item || (classifiedIn(item, collections)?.id ?? null) === target) {
      render();
      return;
    }

    void moveItemToCollection(itemId, target);
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

initMenus(menuEl);

/**
 * Le menu de rangement d'une ligne.
 *
 * « Mes favoris » n'y figure plus comme destination — l'article y est déjà, quoi
 * qu'il arrive. À sa place, « Aucune collection » : le seul geste qui manquait
 * depuis que le classement est facultatif, retirer l'étiquette sans retirer
 * l'article.
 */
function openMoveMenu(item: SavedItem, anchor: HTMLElement): void {
  const currentId = classifiedIn(item, collections)?.id ?? null;

  openMenu(anchor, (menu) => {
    menu.append(menuTitle('Ranger dans'));

    menu.append(
      menuButton(
        'Aucune collection',
        () => {
          void moveItemToCollection(item.id, null);
        },
        { current: currentId === null }
      )
    );

    for (const collection of sortCollections(collections)) {
      if (collection.id === DEFAULT_COLLECTION_ID) continue;
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

    menu.append(
      menuSeparator(),
      menuButton('Nouvelle collection…', () => openCollectionDialog(null, item.id))
    );
  });
}

/**
 * Supprime une collection et revient sur « Mes favoris » si c'était l'onglet actif.
 *
 * Une collection pleine se supprime désormais : ses articles restent dans le
 * récapitulatif, simplement déclassés. Ce n'est plus une perte, mais ça reste un
 * geste qu'on ne fait pas par mégarde — d'où la confirmation, avec le nombre en
 * toutes lettres et ce qu'il advient des articles.
 */
async function removeCollection(collection: Collection): Promise<void> {
  const size = items.filter((item) => classifiedIn(item, collections)?.id === collection.id).length;

  if (
    size > 0 &&
    !confirm(
      `Supprimer la collection « ${collection.name} » ?\n\n` +
        `Ses ${size} article${size > 1 ? 's' : ''} rest${size > 1 ? 'ent' : 'e'} dans « Mes favoris », sans collection.`
    )
  ) {
    return;
  }

  const result = await deleteCollection(collection.id);

  if (!result.ok) {
    await reload();
    flash(`« ${collection.name} » n'a pas pu être supprimée.`);
    return;
  }

  if (settings.activeCollectionId === collection.id) {
    settings = await saveSettings({ activeCollectionId: DEFAULT_COLLECTION_ID });
  }

  if (result.freed) {
    flash(
      `${result.freed} article${result.freed > 1 ? 's' : ''} désormais sans collection, dans « Mes favoris »`
    );
  }
}

function openCollectionMenu(collection: Collection, anchor: HTMLElement): void {
  openMenu(anchor, (menu) => {
    menu.append(menuButton('Renommer…', () => openCollectionDialog(collection)));
  });
}

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
    onFlash: (message) => flash(message),
  }
);

// Silencieux : si aucun onglet Vinted n'est ouvert, ou si le dernier cycle est
// récent, ne fait rien et ne le signale pas (§5.2).
void maybeStartSilentSweep();

// --- Offres en cours — docs/specs/offres.md ------------------------------------

void maybeScanOffers();

/**
 * L'ancienneté des offres est calculée à l'affichage, jamais stockée : ce
 * minuteur la recompose pour que « il y a 3 h » ne reste pas figé sur un panneau
 * ouvert depuis le matin.
 *
 * Il ne touche **que le texte des badges** — pas de relecture du storage, pas de
 * rendu de liste. Un `render()` toutes les 5 minutes détruirait les nœuds sous
 * la souris, interromprait un glisser, et remonterait la liste en cours de
 * lecture, tout cela pour changer un mot.
 */
const OFFER_AGE_REFRESH_MS = 5 * 60 * 1000;
setInterval(() => {
  refreshOfferAges(listEl);
}, OFFER_AGE_REFRESH_MS);

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
    // `null` là où l'article n'est classé nulle part — il reste dans « Mes
    // favoris », qui n'est pas une collection dont on puisse être membre.
    items: items.map((item) => ({
      ...item,
      collectionId: classifiedIn(item, collections)?.id ?? null,
    })),
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `vinted-smart-bookmarks-${new Date().toISOString().slice(0, 10)}.json`;
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
    sansLikes: items.filter((item) => typeof item.favouriteCount !== 'number').length,
    sansTaille: items.filter((item) => !item.size).length,
    sansEtat: items.filter((item) => !item.condition).length,
    sansCategorie: items.filter((item) => !item.category?.url).length,
    // Non classés : présents dans « Mes favoris » et dans aucune collection.
    // C'est l'état normal d'un article fraîchement enregistré, pas une anomalie.
    sansCollection: items.filter((item) => !classifiedIn(item, collections)).length,
    // Fiche encore en cours de lecture : ces articles n'ont que les données de
    // leur carte. Un compte qui ne redescend jamais signale un fetch qui échoue.
    enAttenteDeFiche: items.filter((item) => item.pending).length,
    // Catégorie héritée de la page de navigation, donc possiblement plus large
    // que celle de l'article : enregistré depuis une page catégorie, pas une fiche.
    categorieApprochee: items.filter((item) => item.category && !item.category.exact).length,
  };

  // Offres : leur nombre, et où en est le balayage de l'inbox — voir
  // docs/specs/offres.md §4.
  report.offres = await offersReport(items);

  // Les articles enregistrés, tels quels. Les compteurs ci-dessus disent *combien*
  // d'articles n'ont pas telle donnée ; seul le contenu dit *ce qui* a été
  // enregistré à la place — un état rangé dans la taille, un prix suffixé, un
  // champ absent parce que l'article date d'avant son extraction.
  //
  // En dernière clé du rapport : le reste doit rester lisible sans défiler.
  report.articles = items.map((item) => ({
    ...item,
    collectionId: classifiedIn(item, collections)?.id ?? null,
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

// Nettoyage ponctuel du storage (`shared/migrate.ts`). Sans effet une fois fait,
// et surtout : rien de ce qui s'affiche n'en dépend — l'écriture qu'il produit
// déclenche un `onChanged`, donc un `reload()`, il n'y a rien à attendre ici.
void migrateStorage();

void reload();
