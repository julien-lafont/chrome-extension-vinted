/**
 * Vinted Favoris — panneau latéral.
 *
 * Lit chrome.storage.local et se resynchronise dès qu'un onglet Vinted écrit.
 * Les articles sont regroupés en collections, ordonnables à la main, et chacun
 * peut faire l'objet d'une offre déposée automatiquement sur la fiche Vinted.
 */

import {
  ITEMS_KEY,
  COLLECTIONS_KEY,
  SETTINGS_KEY,
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
} from './store.js';

import {
  SORT_MODES,
  DIR_LABELS,
  defaultDirFor,
  sortItems,
  mergeVisibleOrder,
  countMissing,
  parsePrice,
} from './sorting.js';

import { enableDragAndDrop } from './dnd.js';
import { similarSearchUrl, brandSearchUrl } from './search.js';
import { composeMessage, suggestPrice, submitOffer, formatEuro } from './offer.js';

const listEl = document.getElementById('list');
const countEl = document.getElementById('count');
const searchEl = document.getElementById('search');
const reportEl = document.getElementById('report');
const collectionsEl = document.getElementById('collections');
const sortEl = document.getElementById('sort');
const sortDirEl = document.getElementById('sort-dir');
const sortDirLabelEl = document.getElementById('sort-dir-label');
const hintEl = document.getElementById('hint');
const menuEl = document.getElementById('move-menu');
const template = document.getElementById('item-template');

/** État courant, rechargé intégralement à chaque écriture du storage. */
let items = [];
let collections = {};
let settings = {};
let filter = '';

/** Un rendu pendant un glisser détruirait l'élément saisi : on le diffère. */
let dragging = false;
let renderPending = false;

/** Message transitoire affiché sous la barre de tri, prioritaire sur les indices. */
let notice = '';
let noticeTimer = 0;

/** Affiche un message le temps d'être lu. Survit aux rendus, contrairement au DOM. */
function flash(message) {
  notice = message;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    notice = '';
    render();
  }, 5000);
  render();
}

// --- Chargement ---------------------------------------------------------------

async function reload() {
  const data = await readAll();
  items = data.items;
  collections = data.collections;
  settings = data.settings;
  render();
}

const activeCollection = () =>
  collections[settings.activeCollectionId] || collections[DEFAULT_COLLECTION_ID];

/** Articles de la collection active, avant tri et avant filtre de recherche. */
function itemsOfActiveCollection() {
  const activeId = settings.activeCollectionId;
  return items.filter((item) => collectionOf(item, collections) === activeId);
}

function matches(item) {
  if (!filter) return true;
  return [item.title, item.brand, item.size, item.condition, item.price]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .includes(filter);
}

// --- Rendu : collections ------------------------------------------------------

function renderCollections() {
  collectionsEl.textContent = '';

  const counts = new Map();
  for (const item of items) {
    const id = collectionOf(item, collections);
    counts.set(id, (counts.get(id) || 0) + 1);
  }

  for (const collection of sortCollections(collections)) {
    const size = counts.get(collection.id) || 0;

    // Conteneur plutôt que bouton : un bouton ne peut pas en contenir un autre,
    // et l'onglet accueille la croix de suppression.
    const tab = document.createElement('div');
    tab.className = 'tab';
    tab.dataset.dropCollection = collection.id;
    if (collection.id === settings.activeCollectionId) tab.classList.add('active');

    const select = document.createElement('button');
    select.type = 'button';
    select.className = 'tab-select';
    select.title = `${collection.name} — clic droit pour renommer`;

    const name = document.createElement('span');
    name.className = 'tab-name';
    name.textContent = collection.name;

    const count = document.createElement('span');
    count.className = 'tab-count';
    count.textContent = String(size);

    select.append(name, count);
    select.addEventListener('click', async () => {
      settings = await saveSettings({ activeCollectionId: collection.id });
      render();
    });

    tab.append(select);

    // Supprimable seulement une fois vidée : la collection par défaut, jamais.
    if (collection.id !== DEFAULT_COLLECTION_ID && size === 0) {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'tab-delete';
      remove.textContent = '×';
      remove.title = `Supprimer la collection « ${collection.name} »`;
      remove.setAttribute('aria-label', remove.title);
      remove.addEventListener('click', () => removeCollection(collection));
      tab.append(remove);
    }

    tab.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      openCollectionMenu(collection, tab);
    });

    collectionsEl.append(tab);
  }

  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'tab-add';
  add.textContent = '+';
  add.title = 'Nouvelle collection';
  add.addEventListener('click', () => openCollectionDialog(null));
  collectionsEl.append(add);
}

// --- Rendu : barre de tri -----------------------------------------------------

function renderSortbar(visibleItems) {
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
    const labels = DIR_LABELS[settings.sortMode] || { asc: 'Croissant', desc: 'Décroissant' };
    sortDirLabelEl.textContent = labels[settings.sortDir] || labels.asc;
  }

  // Prévient plutôt que de laisser croire à un tri silencieusement incomplet.
  const missing = countMissing(visibleItems, settings.sortMode);
  if (notice) {
    hintEl.hidden = false;
    hintEl.textContent = notice;
  } else if (isCustom) {
    hintEl.hidden = false;
    hintEl.textContent = 'Glisse la poignée à gauche d\'un article pour le déplacer.';
  } else if (missing) {
    hintEl.hidden = false;
    hintEl.textContent = `${missing} article${missing > 1 ? 's' : ''} sans donnée pour ce tri, placé${
      missing > 1 ? 's' : ''
    } en fin de liste.`;
  } else {
    hintEl.hidden = true;
  }
}

// --- Rendu : liste ------------------------------------------------------------

function renderEmpty(message, hint) {
  const div = document.createElement('div');
  div.className = 'empty';
  const strong = document.createElement('strong');
  strong.textContent = message;
  div.append(strong, document.createTextNode(hint));
  listEl.append(div);
}

function renderItem(item) {
  const node = template.content.cloneNode(true);
  const article = node.querySelector('.item');
  article.dataset.id = item.id;

  const thumb = node.querySelector('.item-thumb');
  thumb.href = item.url;
  const img = node.querySelector('.item-thumb img');
  if (item.imageUrl) {
    img.src = item.imageUrl;
    img.alt = item.title || '';
  }

  const title = node.querySelector('.item-title');
  title.href = item.url;
  title.textContent = item.title || `Article ${item.id}`;

  // "Nike · 42 · Neuf avec étiquette", en sautant les champs absents. La marque
  // devient un lien vers le catalogue quand on peut la filtrer.
  const meta = [];

  if (item.brand) {
    const brandUrl = brandSearchUrl(item);
    if (brandUrl) {
      const link = document.createElement('a');
      link.className = 'item-brand';
      link.href = brandUrl;
      link.target = '_blank';
      link.rel = 'noreferrer';
      link.textContent = item.brand;
      link.title =
        item.category && item.category.exact
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

  const metaEl = node.querySelector('.item-meta');
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

  node.querySelector('.item-price').textContent = item.price || '';

  node.querySelector('.item-similar').addEventListener('click', () => {
    chrome.tabs.create({ url: similarSearchUrl(item), active: true });
  });
  node.querySelector('.item-offer').addEventListener('click', () => openOfferDialog(item));
  node.querySelector('.item-move').addEventListener('click', (event) => {
    openMoveMenu(item, event.currentTarget);
  });
  node.querySelector('.item-remove').addEventListener('click', () => removeItem(item.id));

  return node;
}

function render() {
  if (dragging) {
    renderPending = true;
    return;
  }

  renderCollections();

  const inCollection = itemsOfActiveCollection();
  const visible = inCollection.filter(matches);
  countEl.textContent = String(inCollection.length);

  renderSortbar(inCollection);

  const ordered = sortItems(
    visible,
    settings.sortMode,
    settings.sortDir,
    (activeCollection() || {}).order || []
  );

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

  onDrop: async (ids) => {
    dragging = false;

    const collectionId = settings.activeCollectionId;
    // La recherche peut masquer des articles : ils gardent leur place dans l'ordre complet.
    const order = mergeVisibleOrder((collections[collectionId] || {}).order || [], ids);

    // L'état local prend l'ordre déposé avant l'écriture : un rendu déclenché
    // entre-temps (autre onglet, autre écriture) affiche déjà le bon ordre.
    const collection = collections[collectionId];
    if (collection) collections = { ...collections, [collectionId]: { ...collection, order } };
    settings = { ...settings, sortMode: 'custom', sortDir: 'asc' };

    await commitCustomOrder(collectionId, order);
  },

  onDropToCollection: async (itemId, collectionId) => {
    dragging = false;
    if (collectionId === settings.activeCollectionId) {
      render();
      return;
    }
    await moveItemToCollection(itemId, collectionId);
  },

  onCancel: () => {
    dragging = false;
    render();
  },
});

// Marqué dès la saisie de la poignée : une écriture du storage arrivant en plein
// glisser ne doit pas re-rendre la liste sous la main de l'utilisateur.
listEl.addEventListener('pointerdown', (event) => {
  if (event.button === 0 && event.target.closest('.item-drag')) dragging = true;
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

function closeMenu() {
  menuEl.hidden = true;
  menuEl.textContent = '';
}

/** Ouvre `menuEl` sous l'élément d'ancrage, recalé pour rester dans le panneau. */
function openMenu(anchor, build) {
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

function menuButton(label, onClick, { current = false, danger = false } = {}) {
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

function openMoveMenu(item, anchor) {
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
          () => moveItemToCollection(item.id, collection.id),
          { current: collection.id === currentId }
        )
      );
    }

    const separator = document.createElement('hr');
    separator.className = 'menu-sep';
    menu.append(separator, menuButton('Nouvelle collection…', () => openCollectionDialog(null, item.id)));
  });
}

/**
 * Supprime une collection vide et revient sur celle par défaut si c'était l'active.
 *
 * Le refus du storage n'est pas théorique : un autre onglet Vinted a pu y classer
 * un article depuis le dernier rendu. On le dit alors, plutôt que de laisser un
 * clic sans effet visible.
 */
async function removeCollection(collection) {
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

function openCollectionMenu(collection, anchor) {
  openMenu(anchor, (menu) => {
    menu.append(menuButton('Renommer…', () => openCollectionDialog(collection)));
  });
}

document.addEventListener('pointerdown', (event) => {
  if (!menuEl.hidden && !menuEl.contains(event.target)) closeMenu();
});

// --- Modale : collection ------------------------------------------------------

const collectionDialog = document.getElementById('collection-dialog');
const collectionForm = document.getElementById('collection-form');
const collectionNameEl = document.getElementById('collection-name');
const collectionTitleEl = document.getElementById('collection-dialog-title');
const collectionSubmitEl = document.getElementById('collection-submit');

/** Collection en cours de renommage, sinon null (création). */
let editingCollection = null;
/** Article à déplacer dans la collection dès sa création, sinon null. */
let pendingItemForNewCollection = null;

function openCollectionDialog(collection, itemId = null) {
  editingCollection = collection;
  pendingItemForNewCollection = itemId;

  collectionTitleEl.textContent = collection ? 'Renommer la collection' : 'Nouvelle collection';
  collectionSubmitEl.textContent = collection ? 'Renommer' : 'Créer';
  collectionNameEl.value = collection ? collection.name : '';

  collectionDialog.hidden = false;
  collectionNameEl.focus();
  collectionNameEl.select();
}

collectionForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const name = collectionNameEl.value.trim();
  if (!name) return;

  collectionDialog.hidden = true;

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
});

// --- Modale : offre -----------------------------------------------------------

const offerDialog = document.getElementById('offer-dialog');
const offerForm = document.getElementById('offer-form');
const offerItemEl = document.getElementById('offer-item');
const offerPriceEl = document.getElementById('offer-price');
const offerOriginalEl = document.getElementById('offer-original');
const offerPresetsEl = document.getElementById('offer-presets');
const offerMessageEl = document.getElementById('offer-message');
const offerSendMessageEl = document.getElementById('offer-send-message');
const offerStatusEl = document.getElementById('offer-status');
const offerSubmitEl = document.getElementById('offer-submit');

/** Article visé par la modale d'offre. */
let offerItem = null;
/** Le message suit le prix tant que l'utilisateur ne l'a pas retouché lui-même. */
let messageEdited = false;

function setOfferStatus(text, kind) {
  offerStatusEl.hidden = !text;
  offerStatusEl.textContent = text || '';
  offerStatusEl.className = `offer-status${kind ? ` ${kind}` : ''}`;
}

function markPreset(discount) {
  for (const chip of offerPresetsEl.querySelectorAll('.chip')) {
    chip.classList.toggle('active', Number(chip.dataset.discount) === discount);
  }
}

/** Réécrit le message pour le prix actuellement saisi. */
function refreshOfferMessage() {
  const price = Number(offerPriceEl.value);
  if (!offerItem || !Number.isFinite(price) || price <= 0) return;
  offerMessageEl.value = composeMessage(offerItem, price);
}

function openOfferDialog(item) {
  offerItem = item;
  const original = parsePrice(item);
  const discount = settings.offer.discount;

  offerItemEl.textContent = item.title || `Article ${item.id}`;
  offerOriginalEl.textContent = original ? `Prix affiché : ${formatEuro(original)}` : 'Prix inconnu';

  const suggested = suggestPrice(item, discount);
  offerPriceEl.value = suggested != null ? suggested : '';
  offerPriceEl.max = original ? String(Math.ceil(original)) : '';
  markPreset(original ? discount : null);

  offerSendMessageEl.checked = Boolean(settings.offer.autoMessage);
  offerSubmitEl.disabled = false;
  offerSubmitEl.textContent = "Envoyer l'offre";
  setOfferStatus('');

  // Nouvel article : le message repart d'une génération, pas du texte précédent.
  messageEdited = false;
  refreshOfferMessage();

  offerDialog.hidden = false;
  offerPriceEl.focus();
  offerPriceEl.select();
}

offerPresetsEl.addEventListener('click', (event) => {
  const chip = event.target.closest('.chip');
  if (!chip || !offerItem) return;

  const discount = Number(chip.dataset.discount);
  const suggested = suggestPrice(offerItem, discount);
  if (suggested == null) {
    setOfferStatus("Prix de l'article inconnu : saisis un montant à la main.", 'error');
    return;
  }

  offerPriceEl.value = suggested;
  markPreset(discount);
  refreshOfferMessage();
  saveSettings({ offer: { ...settings.offer, discount } });
});

offerMessageEl.addEventListener('input', () => {
  messageEdited = true;
});
offerPriceEl.addEventListener('input', () => {
  markPreset(null);
  if (!messageEdited) refreshOfferMessage();
});
document.getElementById('offer-regen').addEventListener('click', () => {
  messageEdited = false;
  refreshOfferMessage();
});

document.getElementById('offer-copy').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  try {
    await navigator.clipboard.writeText(offerMessageEl.value);
    button.textContent = 'Copié';
  } catch {
    // Presse-papier refusé : la sélection permet au moins un copier manuel.
    offerMessageEl.select();
    button.textContent = 'Sélectionné';
  }
  setTimeout(() => {
    button.textContent = 'Copier';
  }, 1500);
});

offerForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!offerItem) return;

  const price = Number(offerPriceEl.value);
  if (!Number.isFinite(price) || price <= 0) {
    setOfferStatus('Saisis un prix valide.', 'error');
    return;
  }

  offerSubmitEl.disabled = true;
  offerSubmitEl.textContent = 'Envoi…';
  setOfferStatus("Ouverture de l'article sur Vinted…");

  await saveSettings({
    offer: { ...settings.offer, autoMessage: offerSendMessageEl.checked },
  });

  const result = await submitOffer(offerItem, {
    price,
    message: offerMessageEl.value,
    sendMessage: offerSendMessageEl.checked,
  });

  offerSubmitEl.disabled = false;
  offerSubmitEl.textContent = "Envoyer l'offre";

  if (result && result.ok) {
    // Offre partie mais message bloqué : on le dit, et on laisse le texte sous la
    // main pour un envoi manuel plutôt que de le perdre.
    if (result.messagePending) {
      setOfferStatus(`${result.detail} Utilise « Copier » pour l'envoyer à la main.`, 'warn');
      return;
    }
    setOfferStatus(result.detail || 'Offre envoyée.', 'ok');
    return;
  }

  setOfferStatus(
    `Échec à l'étape « ${(result && result.step) || 'inconnue'} ». ${
      (result && result.detail) || ''
    }`.trim(),
    'error'
  );
});

// --- Fermeture des modales ----------------------------------------------------

for (const overlay of document.querySelectorAll('.overlay')) {
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) overlay.hidden = true;
  });
}

for (const button of document.querySelectorAll('[data-close]')) {
  button.addEventListener('click', () => {
    button.closest('.overlay').hidden = true;
  });
}

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  closeMenu();
  for (const overlay of document.querySelectorAll('.overlay:not([hidden])')) {
    overlay.hidden = true;
  }
});

// --- Export -------------------------------------------------------------------

function exportJson() {
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
async function runDiagnostic() {
  reportEl.hidden = false;
  reportEl.textContent = 'Analyse en cours…';

  const report = {};

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const onVinted = tab && tab.url && tab.url.startsWith('https://www.vinted.fr/');

  if (!onVinted) {
    report.page =
      'Aucun onglet www.vinted.fr actif — analyse du DOM impossible. Ouvre une page de recherche ou une fiche article, puis relance le diagnostic.';
  } else {
    try {
      report.catalogue = await chrome.tabs.sendMessage(tab.id, { type: 'VF_DIAGNOSE' });
    } catch {
      report.catalogue = 'Content script injoignable. Recharge la page Vinted (Cmd+R).';
    }

    try {
      report.offre = await chrome.tabs.sendMessage(tab.id, { type: 'VF_OFFER_DIAGNOSE' });
    } catch {
      report.offre = 'Agent d\'offre injoignable. Recharge la page Vinted (Cmd+R).';
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
    sansCategorie: items.filter((item) => !(item.category && item.category.url)).length,
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

searchEl.addEventListener('input', (event) => {
  filter = event.target.value.trim().toLowerCase();
  render();
});

sortEl.addEventListener('change', async () => {
  const mode = sortEl.value;
  settings = await saveSettings({ sortMode: mode, sortDir: defaultDirFor(mode) });
  render();
});

sortDirEl.addEventListener('click', async () => {
  settings = await saveSettings({ sortDir: settings.sortDir === 'asc' ? 'desc' : 'asc' });
  render();
});

document.getElementById('export').addEventListener('click', exportJson);
document.getElementById('diagnose').addEventListener('click', runDiagnostic);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes[ITEMS_KEY] || changes[COLLECTIONS_KEY] || changes[SETTINGS_KEY]) reload();
});

reload();
