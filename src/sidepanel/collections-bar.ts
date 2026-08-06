/**
 * Vinted Smart Bookmarks — la barre d'onglets des collections.
 *
 * Un onglet par collection, son compteur d'articles, sa croix de suppression
 * quand elle est vide, et le `+` de création. « Archives » y tient une place à
 * part, décrite plus bas.
 *
 * Extrait de `sidepanel.ts` comme `item-list.ts`, et pour la même raison : ce
 * module ne touche qu'au DOM qu'on lui passe et n'agit que par rappels, donc il
 * se charge et s'éprouve hors du panneau.
 */
import {
  ARCHIVE_COLLECTION_ID,
  DEFAULT_COLLECTION_ID,
  OFFERS_VIEW_ID,
  collectionOf,
  sortCollections,
} from '../shared/collections.ts';
import { isLiveOffer } from '../shared/offers.ts';
import type { Collection, CollectionMap, SavedItem } from '../shared/types.ts';

/** Ce que la barre affiche, à l'instant du rendu. */
export type CollectionsBarState = {
  collections: CollectionMap;
  /** Tous les articles connus : la barre en tire les compteurs par collection. */
  items: readonly SavedItem[];
  activeCollectionId: string;
};

/** Ce que la barre ne décide pas elle-même. */
export type CollectionsBarHooks = {
  onSelect: (collectionId: string) => void;
  onDelete: (collection: Collection) => void;
  /** Clic droit sur un onglet : le menu de renommage, ancré dessus. */
  onContextMenu: (collection: Collection, anchor: HTMLElement) => void;
  onCreate: () => void;
};

export function renderCollectionsBar(
  container: HTMLElement,
  state: CollectionsBarState,
  hooks: CollectionsBarHooks
): void {
  container.textContent = '';

  const counts = new Map<string, number>();
  for (const item of state.items) {
    const id = collectionOf(item, state.collections);
    counts.set(id, (counts.get(id) || 0) + 1);
  }

  for (const collection of sortCollections(state.collections)) {
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
    if (collection.id === state.activeCollectionId) tab.classList.add('active');

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
      hooks.onSelect(collection.id);
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
        hooks.onDelete(collection);
      });
      tab.append(remove);
    }

    // Renommer « Archives » n'aurait aucun effet visible : son onglet ne montre
    // que son icône.
    if (!isArchive) {
      tab.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        hooks.onContextMenu(collection, tab);
      });
    }

    // Le `+` reste au bout des collections ordinaires ; « Archives » est poussée
    // contre le bord droit (voir `.tab-archive` dans la feuille de style).
    if (isArchive) container.append(edgeSpacer(), tab);
    else container.append(tab);
  }

  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'tab-add';
  add.textContent = '+';
  add.title = 'Nouvelle collection';
  add.addEventListener('click', () => {
    hooks.onCreate();
  });

  // Avant « Archives », qui doit rester le dernier élément de la barre.
  const archive = container.querySelector('.tab-archive');
  container.insertBefore(add, archive?.previousElementSibling ?? null);

  const offers = offersTab(state, hooks);
  if (offers) {
    // Le ressort n'existe que si « Archives » l'a posé : sans elle, c'est à
    // l'onglet des offres de se pousser contre le bord droit.
    if (!archive) container.append(edgeSpacer());
    container.insertBefore(offers, archive ?? null);
  }
}

/**
 * L'onglet « Sous offres » — `docs/specs/offres.md` §5.
 *
 * **Une vue, pas une collection** : aucun `data-drop-collection` (rien ne s'y
 * dépose), aucun menu de renommage, aucune suppression. Il se place juste avant
 * « Archives », les deux formant le bout de la barre : ce qui ne se range pas.
 *
 * Il n'existe **que s'il a quelque chose à montrer** — une barre d'onglets où
 * s'ajoute une icône permanente pour une fonctionnalité qu'on n'utilise pas est
 * une barre plus étroite pour rien. L'onglet disparaît donc avec la dernière
 * offre, et le panneau retombe alors sur la collection par défaut.
 *
 * Sa pastille compte les offres **en attente sur des articles encore vivants** :
 * c'est la seule information qu'on pilote du regard, et une offre sur un article
 * vendu n'appelle aucune décision.
 */
function offersTab(state: CollectionsBarState, hooks: CollectionsBarHooks): HTMLElement | null {
  const withOffer = state.items.filter((item) => item.offer);
  if (!withOffer.length) return null;

  const live = withOffer.filter(isLiveOffer).length;

  const tab = document.createElement('div');
  tab.className = 'tab tab-offers';
  if (state.activeCollectionId === OFFERS_VIEW_ID) tab.classList.add('active');

  const select = document.createElement('button');
  select.type = 'button';
  select.className = 'tab-select';
  select.title = live
    ? `Sous offres — ${live} offre${live > 1 ? 's' : ''} en cours`
    : 'Sous offres — aucune offre en cours';
  select.setAttribute('aria-label', select.title);

  const name = document.createElement('span');
  name.className = 'tab-name';
  name.textContent = '💸';
  select.append(name);

  // Zéro s'affiche : la pastille dit alors « plus rien en cours », ce qui est une
  // information — contrairement à « Archives », dont le nombre ne se pilote pas.
  const count = document.createElement('span');
  count.className = 'tab-count';
  count.textContent = String(live);
  select.append(count);

  select.addEventListener('click', () => {
    hooks.onSelect(OFFERS_VIEW_ID);
  });

  tab.append(select);
  return tab;
}

/**
 * Pousse le bout de la barre — « Sous offres » et « Archives » — contre le bord
 * droit tant que la barre n'est pas pleine.
 *
 * Un élément flexible plutôt qu'un `margin-left: auto` sur l'onglet : la barre
 * défile horizontalement (`overflow-x: auto`), et une marge automatique y
 * calcule sa place sur la largeur visible, pas sur le contenu — l'onglet
 * s'échappait hors de la zone de défilement dès que les collections
 * débordaient. Un ressort, lui, se comprime à zéro et ces onglets reprennent
 * simplement leur place au bout de la file.
 */
function edgeSpacer(): HTMLElement {
  const spacer = document.createElement('span');
  spacer.className = 'tab-spacer';
  spacer.setAttribute('aria-hidden', 'true');
  return spacer;
}
