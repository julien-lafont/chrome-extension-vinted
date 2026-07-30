/**
 * Vinted Favoris — l'interface du filtrage, dans la page Vinted.
 *
 * Trois surcouches, et rien d'autre :
 *   — le panneau d'annulation qui remplace visuellement une carte écartée (§4.2) ;
 *   — la pastille flottante de comptage, avec son « Afficher » (§4.4) ;
 *   — le menu de la fiche article, seul endroit où le vendeur est certain (§4.5).
 *
 * Comme `collection-picker.ts`, ce module vit dans le DOM de Vinted et hérite
 * donc de sa feuille de style : tout ce qui compte est posé explicitement dans
 * `content.css`. Les règles 1 et 2 du projet s'appliquent intégralement —
 * `pointerdown` pour la souris, `click` réservé au clavier, `user-select: none`,
 * aucun `transform` au survol.
 *
 * Ce module ne décide de rien : il rapporte des intentions à `content.ts`, qui
 * seul écrit en storage.
 */
import { errorText } from '../shared/errors.ts';
import { PILLS_SELECTOR, button, pillStack } from './ui.ts';

/** Classes de nos surcouches. Le `MutationObserver` de `content.ts` les ignore. */
export const NOISE_OVERLAY_SELECTOR = `.vf-undo, .vf-pill, .vf-noise-menu, ${PILLS_SELECTOR}`;

/**
 * Durée du repli différé. Assez pour rattraper un clic de travers, assez court
 * pour ne pas laisser un trou dans la grille pendant qu'on parcourt la page.
 *
 * **À tenir en phase avec l'animation `vf-undo-countdown` de `content.css`** :
 * une feuille de style ne peut pas lire cette constante, et une barre qui finit
 * avant ou après le repli est le genre de détail qui fait douter du reste.
 */
export const DISMISS_DELAY_MS = 2000;

// --- Panneau d'annulation -----------------------------------------------------

export type DismissPanelOptions = {
  /**
   * La **carte** — le conteneur qui porte le `data-testid` de l'article.
   *
   * C'est la clé du panneau, et ce n'est pas `host` : celui-ci est un descendant
   * (le conteneur d'image), et `applyFilters()` raisonne sur la carte. Les
   * confondre rendait la garde toujours fausse, donc la carte était masquée dans
   * la foulée du clic — le panneau d'annulation disparaissait avant d'avoir été
   * lu. Invisible en jsdom, où la feuille de style n'est pas appliquée.
   */
  card: HTMLElement;
  /** L'hôte positionné où le panneau se superpose : celui qui porte le marque-page. */
  host: HTMLElement;
  /** Marque lisible sur la carte, `''` si absente : l'entrée n'est alors pas proposée. */
  brand: string;
  /**
   * Le vendeur, quand il est connu — `null` sinon (§7 de la spec).
   *
   * Le pseudo est souvent vide sur une carte : le flux d'hydratation ne donne que
   * l'identifiant, et le nom ne se lit que sur la fiche. On affiche alors « ce
   * vendeur » tout court plutôt qu'un nombre à onze chiffres, qui n'apprendrait
   * rien à personne.
   */
  seller: { id: string; name: string } | null;
  /** Annulation : l'article redevient visible, la règle est retirée. */
  onUndo: () => void;
  /** Le repli est consommé : la carte disparaît pour de bon. */
  onExpire: () => void;
  onMuteBrand: () => void;
  onMuteSeller: () => void;
};

type OpenPanel = {
  root: HTMLElement;
  host: HTMLElement;
  timer: number;
  dispose: (expire: boolean) => void;
};

/** Un panneau par carte : la carte est la clé, et elle survit au panneau. */
const panels = new WeakMap<HTMLElement, OpenPanel>();

/**
 * Replie une carte sur son panneau d'annulation.
 *
 * L'instant du clic est le **seul** où l'on sait pourquoi on écarte : « encore du
 * Shein », « encore ce revendeur ». La raison est présente à l'esprit à ce
 * moment-là, et jamais plus ensuite. Proposer la règle générale ici évite d'avoir
 * à ouvrir un écran de réglages pour la formuler, ce que personne ne fait.
 */
export function showDismissPanel(options: DismissPanelOptions): void {
  closeDismissPanel(options.card, false);

  const root = document.createElement('div');
  root.className = 'vf-undo';
  root.setAttribute('role', 'status');

  const head = document.createElement('div');
  head.className = 'vf-undo-head';

  const label = document.createElement('span');
  label.className = 'vf-undo-label';
  label.textContent = 'Écarté';
  head.appendChild(label);

  head.appendChild(
    button('vf-undo-cancel', 'Annuler', () => {
      closeDismissPanel(options.card, false);
      options.onUndo();
    })
  );
  root.appendChild(head);

  /**
   * Une règle générale, formulée en toutes lettres : « Masquer tous les produits
   * **Adidas** ». La phrase porte l'action, le lien ne porte que ce sur quoi elle
   * s'applique — « la marque Adidas » cliquable laissait croire qu'on ouvrait une
   * page de marque.
   */
  const ruleRow = (prefix: string, label: string, run: () => void): HTMLElement => {
    const row = document.createElement('p');
    row.className = 'vf-undo-rule-row';
    row.append(document.createTextNode(prefix), button('vf-undo-rule', label, run));
    return row;
  };

  // Les entrées dont la donnée manque ne sont pas affichées plutôt que
  // désactivées : sur une liste de deux, une entrée grise n'apprend rien.
  const rules: HTMLElement[] = [];
  if (options.brand) {
    rules.push(
      ruleRow('Masquer tous les produits ', options.brand, () => {
        closeDismissPanel(options.card, true);
        options.onMuteBrand();
      })
    );
  }
  if (options.seller) {
    const name = options.seller.name;
    rules.push(
      ruleRow('Masquer tous les produits de ', name || 'ce vendeur', () => {
        closeDismissPanel(options.card, true);
        options.onMuteSeller();
      })
    );
  }

  if (rules.length) {
    const list = document.createElement('div');
    list.className = 'vf-undo-rules';
    list.append(...rules);
    root.appendChild(list);
  }

  // Le compte à rebours est une **animation CSS**, jamais un setInterval qui
  // réécrirait un texte dix fois par seconde : une barre animée par le
  // compositeur coûte zéro mutation, là où un compteur en JavaScript réveillerait
  // le MutationObserver à chaque frame, sur chaque carte écartée. C'est la règle 3
  // appliquée là où on ne l'attend pas.
  const bar = document.createElement('div');
  bar.className = 'vf-undo-bar';
  root.appendChild(bar);

  options.host.classList.add('vf-dimmed');
  options.host.appendChild(root);

  const timer = setTimeout(() => {
    closeDismissPanel(options.card, true);
  }, DISMISS_DELAY_MS) as unknown as number;

  panels.set(options.card, {
    root,
    host: options.host,
    timer,
    dispose: (expire) => {
      if (expire) options.onExpire();
    },
  });
}

/**
 * @param card la carte, jamais l'hôte — c'est la clé du panneau
 * @param expire `true` quand le repli va au bout ; `false` sur annulation ou nettoyage
 */
export function closeDismissPanel(card: HTMLElement, expire: boolean): void {
  const panel = panels.get(card);
  if (!panel) return;

  clearTimeout(panel.timer);
  panels.delete(card);
  panel.root.remove();
  panel.host.classList.remove('vf-dimmed');
  panel.dispose(expire);
}

/** Une carte en cours de repli ne doit pas être masquée : son annulation est à l'écran. */
export function hasDismissPanel(card: HTMLElement): boolean {
  return panels.has(card);
}

// --- Pastille de comptage -----------------------------------------------------

let pill: HTMLElement | null = null;

/**
 * Rend la pastille flottante, ou la retire quand plus rien n'est masqué.
 *
 * Flottante et non « en haut de la page » comme le proposait l'audit : ancrer un
 * bandeau en tête des résultats demanderait une ancre pour la grille, or Vinted
 * n'en expose aucune de stable à cet endroit. Une pastille `position: fixed` ne
 * dépend d'aucune ancre, ne peut être cassée par aucune refonte, et suit le
 * défilement — ce qui compte, puisque le compteur monte à mesure que le scroll
 * infini charge des pages. Le précédent existe : `.vf-detail-btn` est fixe pour
 * exactement cette raison.
 *
 * Posée dans la pile de `ui.ts` et non directement sur le corps de page : la
 * collection par défaut de l'onglet occupe le même coin, et deux éléments fixes
 * aux mêmes coordonnées se recouvrent.
 *
 * Idempotent, comme tout ce qui touche au DOM ici : on ne réécrit que ce qui
 * change réellement.
 */
export function renderPill(count: number, revealed: boolean, onToggle: () => void): void {
  if (!count) {
    pill?.remove();
    pill = null;
    return;
  }

  if (!pill?.isConnected) {
    pill = document.createElement('div');
    pill.className = 'vf-pill';

    const icon = document.createElement('span');
    icon.className = 'vf-pill-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = '⦸';

    const text = document.createElement('span');
    text.className = 'vf-pill-count';

    pill.append(icon, text, button('vf-pill-toggle', '', onToggle));
    pillStack().appendChild(pill);
  }

  const text = pill.querySelector<HTMLElement>('.vf-pill-count');
  const toggle = pill.querySelector<HTMLElement>('.vf-pill-toggle');
  const label = `${count} masqué${count > 1 ? 's' : ''}`;
  const action = revealed ? 'Replier' : 'Afficher';

  if (text && text.textContent !== label) text.textContent = label;
  if (toggle && toggle.textContent !== action) toggle.textContent = action;
}

// --- Menu de la fiche article -------------------------------------------------

export type NoiseMenuOptions = {
  anchor: DOMRect;
  brand: string;
  /** Sur une fiche, le pseudo est lisible : on peut le nommer. */
  seller: { id: string; name: string } | null;
  onDismiss: () => void;
  onMuteBrand: () => void;
  onMuteSeller: () => void;
};

type OpenMenu = { close: () => void };
let menu: OpenMenu | null = null;

export function isNoiseMenuOpen(): boolean {
  return menu !== null;
}

export function closeNoiseMenu(): void {
  menu?.close();
}

const EDGE = 8;
const MENU_WIDTH = 240;

/**
 * Le menu de la fiche : « écarter », « masquer la marque », « masquer le
 * vendeur ». Il n'existe que là, parce que la fiche est le seul endroit où
 * l'identifiant du vendeur est certain.
 *
 * Positionné **au-dessus** de son bouton : celui-ci flotte en bas à droite, et un
 * menu déroulé vers le bas sortirait de la fenêtre.
 */
export function openNoiseMenu(options: NoiseMenuOptions): void {
  closeNoiseMenu();

  const root = document.createElement('div');
  root.className = 'vf-noise-menu';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'Masquer');

  const wrap = (run: () => void) => () => {
    closeNoiseMenu();
    try {
      run();
    } catch (err) {
      console.error('[Vinted Favoris] filtrage échoué :', errorText(err));
    }
  };

  root.appendChild(button('vf-noise-item', 'Écarter cet article', wrap(options.onDismiss)));
  if (options.brand) {
    root.appendChild(
      button('vf-noise-item', `Masquer la marque ${options.brand}`, wrap(options.onMuteBrand))
    );
  }
  if (options.seller) {
    const name = options.seller.name;
    root.appendChild(
      button(
        'vf-noise-item',
        name ? `Masquer ${name}` : 'Masquer ce vendeur',
        wrap(options.onMuteSeller)
      )
    );
  }

  document.body.appendChild(root);

  const view = {
    width: window.innerWidth || document.documentElement.clientWidth || MENU_WIDTH + 2 * EDGE,
    height: window.innerHeight || document.documentElement.clientHeight || 400,
  };
  const height = root.offsetHeight || 0;
  const top = Math.max(
    EDGE,
    Math.min(options.anchor.top - EDGE - height, view.height - EDGE - height)
  );
  const left = Math.max(EDGE, Math.min(options.anchor.left, view.width - EDGE - MENU_WIDTH));
  root.style.top = `${Math.round(top)}px`;
  root.style.left = `${Math.round(left)}px`;

  const onPointerDown = (event: Event): void => {
    const target = event.target;
    if (target instanceof Node && root.contains(target)) return;
    closeNoiseMenu();
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    closeNoiseMenu();
  };
  // En position fixe : un scroll le laisserait flotter loin de son bouton.
  const onScroll = (): void => {
    closeNoiseMenu();
  };

  // En capture : Vinted arrête certains événements avant `document`.
  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('scroll', onScroll, { capture: true, passive: true });
  window.addEventListener('resize', onScroll, true);

  menu = {
    close: () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll, true);
      root.remove();
      menu = null;
    },
  };

  root.querySelector<HTMLButtonElement>('.vf-noise-item')?.focus({ preventScroll: true });
}
