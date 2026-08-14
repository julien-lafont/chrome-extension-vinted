/**
 * Vinted Smart Bookmarks — choix de collection depuis la page Vinted.
 *
 * Le menu qu'ouvre l'appui long (ou Alt+clic) sur un bouton injecté : la liste
 * des collections, plus une création à la volée. Il ne décide de rien sur
 * l'article — le geste l'a déjà enregistré, voir `content.ts` — il ne fait que
 * le **ranger**.
 *
 * Le menu vit dans le DOM de Vinted, pas dans le panneau : il hérite donc de sa
 * feuille de style. Toutes les propriétés qui comptent (police, taille, couleur,
 * interlignage) sont posées explicitement dans `content.css`, jamais laissées à
 * l'héritage.
 *
 * Contraintes du projet qui s'appliquent ici :
 *   — règle 1 : chaque entrée répond à `pointerdown`, `click` ne sert qu'au
 *     clavier (`detail === 0`) ;
 *   — règle 2 : `user-select: none`, enfants transparents aux événements, aucun
 *     `transform` au survol (voir `content.css`) ;
 *   — règle 6 : toute écriture relit d'abord — c'est le rôle de
 *     `shared/collections.ts`, que ce module se contente d'appeler.
 */
import {
  ARCHIVE_COLLECTION_ID,
  DEFAULT_COLLECTION_ID,
  assignCollection,
  createCollection,
  readCollections,
  sortCollections,
} from '../shared/collections.ts';
import type { Collection } from '../shared/types.ts';
import { errorText } from '../shared/errors.ts';
import { PIN_FILLED, PIN_OUTLINE } from './tab-default.ts';
import { onActivate } from './ui.ts';

/** Classes des surcouches posées sur `document.body` — le scan les ignore. */
export const OVERLAY_SELECTOR = '.vf-picker, .vf-toast';

export type PickerOptions = {
  itemId: string;
  /** Titre de l'article, affiché en tête du menu pour lever tout doute sur la cible. */
  itemTitle: string;
  /**
   * Collection actuelle, marquée `aria-current`. `null` — ou `'default'`, qui
   * dit la même chose dans un storage hérité — quand l'article n'est classé
   * nulle part : c'est alors « Aucune collection » qui porte la marque.
   */
  currentCollectionId: string | null;
  /** Position du bouton d'où part le geste, en coordonnées viewport. */
  anchor: { top: number; bottom: number; left: number; right: number };
  /** Collection épinglée sur cet onglet, `null` si aucune — voir `tab-default.ts`. */
  pinnedCollectionId: string | null;
  /**
   * Épingle une collection sur l'onglet, ou dépingle avec `null`.
   *
   * Le menu ne l'écrit pas lui-même : `content.ts` a du travail à faire dans la
   * foulée (pastille, libellés des boutons injectés), et c'est déjà lui qui tient
   * l'état de la page.
   */
  onPin: (collectionId: string | null) => void;
};

type OpenPicker = { root: HTMLElement; close: () => void };

let open: OpenPicker | null = null;

export function isPickerOpen(): boolean {
  return open !== null;
}

export function closePicker(): void {
  open?.close();
}

/** Marge minimale entre le menu et les bords de la fenêtre. */
const EDGE = 8;
const WIDTH = 240;

function position(root: HTMLElement, anchor: PickerOptions['anchor']): void {
  const view = {
    width: window.innerWidth || document.documentElement.clientWidth || WIDTH + 2 * EDGE,
    height: window.innerHeight || document.documentElement.clientHeight || 400,
  };

  // Aligné sur le bord droit du bouton, sous lui. En bas de fenêtre, il passe
  // au-dessus : la hauteur n'est connue qu'une fois le menu dans le document,
  // d'où le calcul après insertion.
  const height = root.offsetHeight || 0;
  const belowFits = anchor.bottom + EDGE + height <= view.height;

  const top = belowFits
    ? anchor.bottom + EDGE
    : Math.max(EDGE, Math.min(anchor.top - EDGE - height, view.height - EDGE - height));
  const left = Math.max(EDGE, Math.min(anchor.right - WIDTH, view.width - EDGE - WIDTH));

  root.style.top = `${Math.round(top)}px`;
  root.style.left = `${Math.round(left)}px`;
}

/**
 * Confirmation brève, en bas de fenêtre. Le panneau latéral est souvent fermé
 * quand on chine : sans ce retour, un rangement ne se voit nulle part.
 */
export function toast(message: string): void {
  document.querySelectorAll(`.vf-toast`).forEach((el) => {
    el.remove();
  });

  const el = document.createElement('div');
  el.className = 'vf-toast';
  el.setAttribute('role', 'status');
  el.textContent = message;
  document.body.appendChild(el);

  setTimeout(() => {
    el.remove();
  }, 2600);
}

function entry(label: string, current: boolean, run: () => void): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'vf-picker-item';
  btn.textContent = label;
  if (current) btn.setAttribute('aria-current', 'true');
  onActivate(btn, run);
  return btn;
}

/**
 * L'épingle d'une ligne : « range ici, et fais-en le défaut de cet onglet ».
 *
 * **Un radio, pas une bascule.** Une collection est toujours épinglée : sans
 * choix explicite, c'est « Mes favoris », puisque c'est là que les clics courts
 * atterrissent de fait. Montrer toutes les épingles vides dans cet état
 * laisserait croire à une destination indéterminée, et le geste d'épinglage
 * n'aurait rien à quoi se comparer.
 *
 * **Frère du bouton de rangement, pas son enfant** — la règle 2 pose
 * `pointer-events: none` sur les enfants des boutons injectés, une épingle
 * imbriquée ne recevrait donc jamais le moindre clic. Elle vit dans une ligne
 * qui porte les deux.
 *
 * Visible en permanence, en retrait : au survol seulement, elle serait
 * introuvable au doigt, et c'est précisément sur mobile que l'appui long est le
 * geste naturel.
 */
function paintPin(btn: HTMLButtonElement, collection: Collection, pinnedId: string): void {
  const pinned = collection.id === pinnedId;
  // La collection par défaut est l'état naturel de l'onglet : son épingle ne se
  // retire pas, il n'y a rien derrière elle.
  const natural = collection.id === DEFAULT_COLLECTION_ID;

  btn.innerHTML = pinned ? PIN_FILLED : PIN_OUTLINE;
  btn.setAttribute('aria-pressed', String(pinned));

  if (pinned) {
    btn.title = natural
      ? `Sur cet onglet, un clic enregistre dans « ${collection.name} », sans collection`
      : `Revenir à « Mes favoris » sur cet onglet`;
  } else if (natural) {
    // La ligne « Aucune collection » : y ranger, c'est déclasser.
    btn.title = `Retirer de sa collection, et enregistrer sans collection sur cet onglet`;
  } else {
    btn.title = `Ranger ici, et enregistrer par défaut dans « ${collection.name} » sur cet onglet`;
  }

  btn.setAttribute('aria-label', btn.title);
}

function pin(collection: Collection, pinnedId: string, run: () => void): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'vf-picker-pin';
  paintPin(btn, collection, pinnedId);
  onActivate(btn, run);
  return btn;
}

/** Une ligne du menu : la collection, et son épingle. */
function row(item: HTMLElement, pinButton: HTMLElement): HTMLElement {
  const line = document.createElement('div');
  line.className = 'vf-picker-row';
  line.append(item, pinButton);
  return line;
}

/**
 * Ouvre le menu de rangement. Un seul à la fois : rouvrir remplace le précédent.
 *
 * @returns une fois le menu affiché — pas une fois le choix fait.
 */
export async function openCollectionPicker(options: PickerOptions): Promise<void> {
  closePicker();

  // Relu à chaque ouverture : le panneau a pu créer une collection depuis, et un
  // menu qui ne la propose pas envoie l'utilisateur la recréer en double.
  //
  // « Archives » en est écartée : c'est le dépôt de ce qui est vendu ou parti,
  // pas une destination de rangement. Y capturer un article qu'on vient de
  // trouver n'aurait aucun sens, et la proposer à chaque geste ferait du bruit.
  const collections = sortCollections(await readCollections()).filter(
    (collection) => collection.id !== ARCHIVE_COLLECTION_ID
  );

  const root = document.createElement('div');
  root.className = 'vf-picker';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'Ranger dans une collection');

  const title = document.createElement('p');
  title.className = 'vf-picker-title';
  title.textContent = 'Ranger dans…';
  root.appendChild(title);

  const subtitle = document.createElement('p');
  subtitle.className = 'vf-picker-subtitle';
  subtitle.textContent = options.itemTitle || 'Article enregistré';
  root.appendChild(subtitle);

  const list = document.createElement('div');
  list.className = 'vf-picker-list';
  root.appendChild(list);

  const done = (name: string, pinned: boolean): void => {
    closePicker();
    toast(pinned ? `« ${name} » par défaut sur cet onglet` : `Rangé dans « ${name} »`);
  };

  /**
   * Range l'article, ou le déclasse si la ligne est « Aucune collection ».
   *
   * Déclasser ne le retire de rien : « Mes favoris » récapitule tout ce qui est
   * enregistré, l'article y reste — le toast le dit, parce que rien à l'écran ne
   * le montrerait autrement (le panneau est souvent fermé quand on chine).
   */
  const rangeInto = (id: string, name: string, pinned = false): void => {
    const unclassify = id === DEFAULT_COLLECTION_ID;

    // L'écriture n'est pas attendue : le menu se ferme tout de suite, et le
    // storage notifiera les onglets et le panneau de lui-même.
    void assignCollection(options.itemId, unclassify ? null : id).catch((err: unknown) => {
      console.error('[Vinted Smart Bookmarks] rangement échoué :', errorText(err));
    });

    if (!unclassify) {
      done(name, pinned);
      return;
    }

    closePicker();
    toast('Sans collection — toujours dans « Mes favoris »');
  };

  // Aucune épingle explicite veut dire « Mes favoris » : c'est là que part un
  // clic court, autant le montrer. L'état vit ici le temps que le menu est
  // ouvert — retirer une épingle en rallume une autre, et les deux lignes
  // doivent se repeindre sans qu'on rouvre le menu.
  let pinnedId = options.pinnedCollectionId || DEFAULT_COLLECTION_ID;
  const pins: { collection: Collection; btn: HTMLButtonElement }[] = [];

  const repaintPins = (): void => {
    for (const { collection, btn } of pins) paintPin(btn, collection, pinnedId);
  };

  for (const collection of collections) {
    const pinButton: HTMLButtonElement = pin(collection, pinnedId, () => {
      if (collection.id === pinnedId) {
        // L'épingle déjà posée : la retirer, c'est revenir à « Mes favoris ».
        // Sur « Mes favoris » elle-même, il n'y a rien derrière — le geste ne
        // fait rien, comme un radio déjà coché.
        if (pinnedId === DEFAULT_COLLECTION_ID) return;

        pinnedId = DEFAULT_COLLECTION_ID;
        options.onPin(null);
        // On ne ferme pas : ce n'est pas un rangement, et le geste peut encore
        // se terminer par le choix d'une collection.
        repaintPins();
        return;
      }

      pinnedId = collection.id;
      // La collection par défaut ne s'écrit pas : elle *est* l'absence d'épingle.
      // L'enregistrer comme un choix laisserait un état redondant à maintenir.
      options.onPin(collection.id === DEFAULT_COLLECTION_ID ? null : collection.id);
      rangeInto(collection.id, collection.name, collection.id !== DEFAULT_COLLECTION_ID);
    });

    pins.push({ collection, btn: pinButton });

    // « Mes favoris » n'est plus une destination : tout y est déjà. Sa ligne
    // devient le geste inverse — retirer l'article de sa collection — et c'est
    // elle qui porte la marque quand il n'est classé nulle part.
    const isDefault = collection.id === DEFAULT_COLLECTION_ID;
    const current = isDefault
      ? !options.currentCollectionId || options.currentCollectionId === DEFAULT_COLLECTION_ID
      : collection.id === options.currentCollectionId;

    list.appendChild(
      row(
        entry(isDefault ? 'Aucune collection' : collection.name, current, () => {
          rangeInto(collection.id, collection.name);
        }),
        pinButton
      )
    );
  }

  const separator = document.createElement('hr');
  separator.className = 'vf-picker-sep';
  root.appendChild(separator);

  // Création à la volée : un champ plutôt qu'un `prompt()`, qui bloque la page
  // et sort du monde isolé.
  const form = document.createElement('form');
  form.className = 'vf-picker-new';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'vf-picker-input';
  input.placeholder = 'Nouvelle collection…';
  input.maxLength = 40;
  input.setAttribute('aria-label', 'Nom de la nouvelle collection');

  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.className = 'vf-picker-create';
  submit.textContent = 'Créer';

  // Une collection créée en pleine session est presque toujours celle où va
  // atterrir la suite de la chine : elle mérite la même épingle que les autres.
  // Une collection qui n'existe pas encore : jamais épinglée, d'où le contour, et
  // un libellé écrit à la main — le nom est encore dans le champ de saisie.
  const pinNew = pin({ id: '', name: '', createdAt: 0, order: [] }, DEFAULT_COLLECTION_ID, () => {
    create(true);
  });
  pinNew.title = 'Créer, y ranger, et enregistrer par défaut ici sur cet onglet';
  pinNew.setAttribute('aria-label', pinNew.title);

  form.append(input, submit, pinNew);
  root.appendChild(form);

  let creating = false;

  function create(pinned: boolean): void {
    const name = input.value.trim();
    if (!name || creating) return;

    // Double soumission : la création est asynchrone, deux Entrée rapides
    // produiraient deux collections homonymes.
    creating = true;

    void (async () => {
      try {
        const collection = await createCollection(name);
        await assignCollection(options.itemId, collection.id);
        if (pinned) options.onPin(collection.id);
        done(collection.name, pinned);
      } catch (err) {
        creating = false;
        console.error('[Vinted Smart Bookmarks] création de collection échouée :', errorText(err));
      }
    })();
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    event.stopPropagation();
    create(false);
  });

  // La frappe ne doit pas remonter à Vinted, dont les raccourcis clavier
  // globaux réagiraient au moindre caractère.
  form.addEventListener('keydown', (event) => {
    event.stopPropagation();
  });

  document.body.appendChild(root);
  position(root, options.anchor);

  // --- Fermeture ---

  const onPointerDown = (event: Event): void => {
    const target = event.target;
    if (target instanceof Node && root.contains(target)) return;
    closePicker();
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    closePicker();
  };

  // Le menu est en position fixe : un scroll le laisserait flotter loin de son
  // bouton. Plutôt que de le suivre, on ferme.
  const onScroll = (): void => {
    closePicker();
  };

  // En capture : Vinted arrête certains événements avant qu'ils atteignent
  // `document` en phase de bouillonnement.
  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('scroll', onScroll, { capture: true, passive: true });
  window.addEventListener('resize', onScroll, true);

  open = {
    root,
    close: () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll, true);
      root.remove();
      open = null;
    },
  };

  // Le clavier doit pouvoir enchaîner sans souris ; `preventScroll` évite que la
  // page saute au moment où le menu apparaît.
  list.querySelector<HTMLButtonElement>('.vf-picker-item')?.focus({ preventScroll: true });
}
