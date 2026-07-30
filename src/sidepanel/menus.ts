/**
 * Vinted Favoris — le menu contextuel du panneau.
 *
 * Un seul nœud (`#move-menu`) sert tous les menus : « Déplacer vers » sur une
 * ligne d'article, « Renommer » sur un onglet de collection. Il est rempli à
 * l'ouverture et vidé à la fermeture, ce qui évite d'entretenir un menu par
 * point d'appel et garantit qu'il n'y en a jamais deux à l'écran.
 *
 * Le contenu est bâti par l'appelant (`build`), la mécanique est ici : le
 * remplissage, le placement, et la fermeture au premier clic en dehors.
 */
let menuEl: HTMLElement;

/**
 * Installe le menu et le referme dès qu'on clique ailleurs.
 *
 * `pointerdown` et non `click` — règle 1 du projet : un clic disparaît dès qu'une
 * sélection de texte démarre, et un menu qui reste ouvert par-dessus le panneau
 * bloque tout ce qu'il recouvre.
 */
export function initMenus(element: HTMLElement): void {
  menuEl = element;

  document.addEventListener('pointerdown', (event) => {
    const target = event.target;
    if (!menuEl.hidden && target instanceof Node && !menuEl.contains(target)) closeMenu();
  });
}

export function closeMenu(): void {
  menuEl.hidden = true;
  menuEl.textContent = '';
}

/**
 * Ouvre le menu sous l'élément d'ancrage, recalé pour rester dans le panneau.
 *
 * Le panneau latéral est étroit et court : un menu ancré près du bord droit
 * dépasserait, et un menu ancré en bas de liste s'ouvrirait hors de l'écran. Il
 * bascule donc au-dessus de son ancre quand la place manque en dessous, et reste
 * à 8 px des bords dans tous les cas.
 */
export function openMenu(anchor: HTMLElement, build: (menu: HTMLElement) => void): void {
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

/**
 * Une entrée de menu. Referme toujours avant d'agir : l'action peut ouvrir une
 * modale ou déclencher un rendu, et un menu resté ouvert par-dessus se
 * retrouverait ancré sur un élément qui n'existe plus.
 */
export function menuButton(
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

/** Le titre d'une section de menu, non cliquable. */
export function menuTitle(label: string): HTMLElement {
  const title = document.createElement('p');
  title.className = 'menu-title';
  title.textContent = label;
  return title;
}

/** Le séparateur entre deux groupes d'entrées. */
export function menuSeparator(): HTMLElement {
  const separator = document.createElement('hr');
  separator.className = 'menu-sep';
  return separator;
}
