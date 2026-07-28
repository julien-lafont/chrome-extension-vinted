/**
 * Vinted Favoris — choix de collection depuis la page Vinted.
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
  assignCollection,
  createCollection,
  readCollections,
  sortCollections,
} from '../shared/collections.ts';
import { errorText } from '../shared/errors.ts';

/** Classes des surcouches posées sur `document.body` — le scan les ignore. */
export const OVERLAY_SELECTOR = '.vf-picker, .vf-toast';

export type PickerOptions = {
  itemId: string;
  /** Titre de l'article, affiché en tête du menu pour lever tout doute sur la cible. */
  itemTitle: string;
  /** Collection actuelle, marquée `aria-current` — souvent la collection par défaut. */
  currentCollectionId: string;
  /** Position du bouton d'où part le geste, en coordonnées viewport. */
  anchor: { top: number; bottom: number; left: number; right: number };
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

/**
 * Câble une entrée de menu sur les deux gestes.
 *
 * `pointerdown` pour la souris (règle 1), `click` uniquement pour le clavier :
 * un clic souris émet les deux, et le second doit être neutralisé sans
 * re-déclencher l'action — d'où le test sur `detail`.
 */
function onActivate(el: HTMLElement, run: () => void): void {
  el.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    event.stopPropagation();
    run();
  });

  el.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    if ((event as MouseEvent).detail === 0) run();
  });
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

  const done = (name: string): void => {
    closePicker();
    toast(`Rangé dans « ${name} »`);
  };

  const rangeInto = (id: string, name: string): void => {
    // L'écriture n'est pas attendue : le menu se ferme tout de suite, et le
    // storage notifiera les onglets et le panneau de lui-même.
    void assignCollection(options.itemId, id).catch((err: unknown) => {
      console.error('[Vinted Favoris] rangement échoué :', errorText(err));
    });
    done(name);
  };

  for (const collection of collections) {
    list.appendChild(
      entry(collection.name, collection.id === options.currentCollectionId, () => {
        rangeInto(collection.id, collection.name);
      })
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

  form.append(input, submit);
  root.appendChild(form);

  let creating = false;
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    event.stopPropagation();

    const name = input.value.trim();
    if (!name || creating) return;

    // Double soumission : la création est asynchrone, deux Entrée rapides
    // produiraient deux collections homonymes.
    creating = true;

    void (async () => {
      try {
        const collection = await createCollection(name);
        await assignCollection(options.itemId, collection.id);
        done(collection.name);
      } catch (err) {
        creating = false;
        console.error('[Vinted Favoris] création de collection échouée :', errorText(err));
      }
    })();
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
