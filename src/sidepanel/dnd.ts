/**
 * Vinted Smart Bookmarks — réorganisation par glisser-déposer.
 *
 * Pointer Events plutôt que l'API HTML5 drag-and-drop : celle-ci ne donne aucun
 * retour visuel exploitable dans un panneau étroit et gère mal le défilement.
 *
 * Principe : l'élément saisi passe en `position: fixed` et suit le pointeur ;
 * un bloc vide de même hauteur (le « fantôme ») garde sa place dans le flux et
 * se déplace entre les voisins. Au relâchement, l'élément reprend la place du
 * fantôme et on lit le nouvel ordre directement dans le DOM.
 */

const SCROLL_ZONE = 48; // px depuis le bord de la liste où le défilement auto s'amorce
const SCROLL_SPEED = 12; // px par frame, à pleine vitesse
const MOVE_THRESHOLD = 4; // px en deçà desquels la saisie reste un clic, pas un glisser

/** Ce que `pickSlot` a besoin de connaître d'un voisin : un DOMRect en fournit plus. */
export type SlotBox = { top: number; height: number };

export type DragHandlers = {
  /** Le mode de tri autorise-t-il déjà l'ordre manuel. */
  canDrag: () => boolean;
  /** Appelé au premier mouvement, si le tri doit basculer en manuel. */
  onStart: () => void;
  /** Nouvel ordre affiché. */
  onDrop: (ids: string[]) => void;
  onDropToCollection: (itemId: string, collectionId: string) => void;
  /** Saisie relâchée sans mouvement : c'était un clic. */
  onCancel: () => void;
};

/** État d'un glisser en cours. `null` hors glisser. */
type DragState = {
  el: HTMLElement;
  ghost: HTMLElement;
  handle: HTMLElement;
  pointerId: number;
  grabOffsetY: number;
  startY: number;
  lastY: number;
  moved: boolean;
  dropTab: HTMLElement | null;
};

/**
 * Emplacement où déposer la carte saisie, parmi les `n + 1` positions possibles
 * entre `n` voisins.
 *
 * Tout le calcul se fait dans la disposition qu'aurait la liste **sans** le
 * fantôme. Celui-ci occupe la hauteur d'une carte et repousse vers le bas tout ce
 * qui le suit : comparer aux positions courantes obligerait à parcourir une carte
 * entière pour gagner un seul rang, au lieu d'une demi-carte.
 *
 * Raisonner par emplacement, et non par « voisin à dépasser », gère aussi les
 * cartes de hauteurs inégales — un titre peut tenir sur une ou deux lignes.
 *
 * @param center centre vertical de la carte saisie, en coordonnées écran
 * @param height hauteur du fantôme, donc de la carte saisie
 * @param ghostIndex emplacement actuellement occupé par le fantôme (0..n)
 * @param boxes voisins, dans l'ordre d'affichage
 * @returns index de l'emplacement retenu (0..n)
 */
export function pickSlot(
  center: number,
  height: number,
  ghostIndex: number,
  boxes: readonly SlotBox[]
): number {
  // Dernier emplacement : sous le dernier voisin.
  const last = boxes.at(-1);
  if (!last) return 0;

  // Centre qu'aurait la carte déposée à chaque emplacement. Les voisins situés
  // après le fantôme remonteraient de sa hauteur s'il disparaissait.
  const slots = boxes.map((box, i) => box.top - (i >= ghostIndex ? height : 0) + height / 2);

  const lastShift = boxes.length - 1 >= ghostIndex ? height : 0;
  slots.push(last.top - lastShift + last.height + height / 2);

  let best = 0;
  for (let i = 1; i < slots.length; i += 1) {
    if (Math.abs(center - slots[i]!) < Math.abs(center - slots[best]!)) best = i;
  }
  return best;
}

/**
 * Un article lâché sur un onglet de collection (`[data-drop-collection]`) y est
 * déplacé au lieu d'être réordonné : c'est le geste le plus direct pour classer.
 *
 * @param listEl conteneur des `.item[data-id]`
 */
export function enableDragAndDrop(
  listEl: HTMLElement,
  { canDrag, onStart, onDrop, onDropToCollection, onCancel }: DragHandlers
): void {
  let drag: DragState | null = null;
  let scrollRaf = 0;
  let scrollDelta = 0;

  function itemsInDom(): HTMLElement[] {
    return [...listEl.querySelectorAll<HTMLElement>('.item')];
  }

  function stopAutoScroll() {
    if (scrollRaf) cancelAnimationFrame(scrollRaf);
    scrollRaf = 0;
    scrollDelta = 0;
  }

  /** Défilement continu tant que le pointeur reste près d'un bord de la liste. */
  function tickAutoScroll() {
    scrollRaf = 0;
    if (!drag || !scrollDelta) return;

    const before = listEl.scrollTop;
    listEl.scrollTop += scrollDelta;
    if (listEl.scrollTop !== before) reposition(drag.lastY);

    scrollRaf = requestAnimationFrame(tickAutoScroll);
  }

  function updateAutoScroll(clientY: number): void {
    const rect = listEl.getBoundingClientRect();
    const fromTop = clientY - rect.top;
    const fromBottom = rect.bottom - clientY;

    // Pointeur remonté sur l'en-tête (dépôt vers une collection) : on ne défile plus.
    if (fromTop < -8 || fromBottom < -8) {
      scrollDelta = 0;
    } else if (fromTop < SCROLL_ZONE) {
      scrollDelta = -Math.ceil(Math.min(1, (SCROLL_ZONE - fromTop) / SCROLL_ZONE) * SCROLL_SPEED);
    } else if (fromBottom < SCROLL_ZONE) {
      scrollDelta = Math.ceil(Math.min(1, (SCROLL_ZONE - fromBottom) / SCROLL_ZONE) * SCROLL_SPEED);
    } else {
      scrollDelta = 0;
    }

    if (scrollDelta && !scrollRaf) scrollRaf = requestAnimationFrame(tickAutoScroll);
    if (!scrollDelta) stopAutoScroll();
  }

  /**
   * Onglet de collection sous le pointeur. L'élément saisi étant en
   * `pointer-events: none`, elementFromPoint voit bien ce qu'il y a dessous.
   */
  function collectionUnder(clientX: number, clientY: number): HTMLElement | null {
    const el = document.elementFromPoint(clientX, clientY);
    return el?.closest<HTMLElement>('[data-drop-collection]') ?? null;
  }

  function setDropTarget(tab: HTMLElement | null): void {
    if (!drag || drag.dropTab === tab) return;
    if (drag.dropTab) drag.dropTab.classList.remove('drop-target');
    if (tab) tab.classList.add('drop-target');
    drag.dropTab = tab;
  }

  /** Déplace le fantôme à l'emplacement visé par la carte saisie. */
  function reposition(clientY: number): void {
    if (!drag) return;
    const { el, ghost, grabOffsetY } = drag;
    const top = clientY - grabOffsetY;
    el.style.top = `${top}px`;

    const nodes = [...listEl.querySelectorAll<HTMLElement>('.item, .item-ghost')].filter(
      (n) => n !== el
    );
    // Le rang du fantôme parmi les nœuds vaut aussi l'emplacement qu'il occupe.
    const ghostIndex = nodes.indexOf(ghost);
    const siblings = nodes.filter((n) => n !== ghost);
    if (!siblings.length || ghostIndex === -1) return;

    const height = ghost.offsetHeight;
    const boxes = siblings.map((node) => node.getBoundingClientRect());
    const best = pickSlot(top + el.offsetHeight / 2, height, ghostIndex, boxes);

    if (best === ghostIndex) return;

    const target = siblings[best];
    if (best === siblings.length || !target) {
      listEl.append(ghost);
    } else {
      listEl.insertBefore(ghost, target);
    }
  }

  function onPointerMove(event: PointerEvent): void {
    if (!drag) return;
    event.preventDefault();

    // Sous le seuil, la saisie peut encore n'être qu'un clic : on ne bascule pas
    // le mode de tri et on n'enregistrera aucun ordre.
    if (!drag.moved) {
      if (Math.abs(event.clientY - drag.startY) < MOVE_THRESHOLD) return;
      drag.moved = true;
      if (!canDrag()) onStart();
    }

    drag.lastY = event.clientY;
    reposition(event.clientY);
    setDropTarget(collectionUnder(event.clientX, event.clientY));
    updateAutoScroll(event.clientY);
  }

  function finish(): void {
    if (!drag) return;

    const { el, ghost, handle, pointerId, dropTab, moved } = drag;
    stopAutoScroll();

    listEl.insertBefore(el, ghost);
    ghost.remove();
    if (dropTab) dropTab.classList.remove('drop-target');

    el.classList.remove('dragging');
    el.removeAttribute('style');
    listEl.classList.remove('is-dragging');
    document.body.classList.remove('vf-grabbing');

    try {
      handle.releasePointerCapture(pointerId);
    } catch {
      // Le pointeur peut déjà avoir été relâché (sortie de fenêtre) — sans effet.
    }

    handle.removeEventListener('pointermove', onPointerMove);
    handle.removeEventListener('pointerup', finish);
    handle.removeEventListener('pointercancel', finish);

    const itemId = el.dataset.id;
    // `.item` porte toujours un data-id (posé au rendu) ; les nœuds sans id
    // seraient de toute façon inexploitables pour enregistrer un ordre.
    const ids = itemsInDom()
      .map((node) => node.dataset.id)
      .filter((id): id is string => id !== undefined);
    drag = null;

    // Simple clic sur la poignée : rien n'a bougé, rien à enregistrer.
    if (!moved) {
      onCancel();
      return;
    }

    const target = dropTab?.dataset.dropCollection;
    if (itemId && target) {
      onDropToCollection(itemId, target);
    } else {
      onDrop(ids);
    }
  }

  listEl.addEventListener('pointerdown', (event: PointerEvent) => {
    const handle =
      event.target instanceof Element ? event.target.closest<HTMLElement>('.item-drag') : null;
    if (!handle || event.button !== 0) return;

    const el = handle.closest<HTMLElement>('.item');
    if (!el) return;

    event.preventDefault();

    const rect = el.getBoundingClientRect();

    const ghost = document.createElement('div');
    ghost.className = 'item-ghost';
    ghost.style.height = `${rect.height}px`;

    drag = {
      el,
      ghost,
      handle,
      pointerId: event.pointerId,
      grabOffsetY: event.clientY - rect.top,
      startY: event.clientY,
      lastY: event.clientY,
      moved: false,
      dropTab: null,
    };

    listEl.insertBefore(ghost, el);
    el.classList.add('dragging');
    el.style.position = 'fixed';
    el.style.left = `${rect.left}px`;
    el.style.top = `${rect.top}px`;
    el.style.width = `${rect.width}px`;

    listEl.classList.add('is-dragging');
    document.body.classList.add('vf-grabbing');

    handle.setPointerCapture(event.pointerId);
    handle.addEventListener('pointermove', onPointerMove);
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);
  });
}
