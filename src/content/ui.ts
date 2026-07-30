/**
 * Vinted Favoris — les briques communes aux surcouches posées dans la page.
 *
 * Trois modules injectent des éléments dans le DOM de Vinted
 * (`collection-picker`, `noise-ui`, `tab-default`). Deux choses leur étaient
 * communes, et le sont désormais pour de bon :
 *
 * **L'activation à deux gestes.** `pointerdown` pour la souris, `click` réservé
 * au clavier — c'est la règle 1 du projet, et elle ne tient qu'à ce câblage. Une
 * copie par module, c'est une copie qui finit par dériver, et le bouton concerné
 * cesse alors de répondre dès qu'une sélection de texte démarre : sans erreur en
 * console, comme toujours ici.
 *
 * **La pile de pastilles.** Le comptage du filtrage et la collection par défaut
 * de l'onglet flottent tous deux en bas à gauche. Deux éléments `position: fixed`
 * au même endroit se recouvrent : ils partagent donc un conteneur qui les empile.
 */

/**
 * Câble une commande sur les deux gestes.
 *
 * Un clic souris émet `pointerdown` **et** `click` : le second doit être
 * neutralisé sans re-déclencher l'action, d'où le test sur `detail` (nul pour une
 * activation clavier, ≥ 1 pour un vrai clic).
 */
export function onActivate(el: HTMLElement, run: () => void): void {
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

export function button(className: string, label: string, run: () => void): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = className;
  btn.textContent = label;
  onActivate(btn, run);
  return btn;
}

/** Le conteneur des pastilles flottantes. Le `MutationObserver` l'ignore. */
export const PILLS_SELECTOR = '.vf-pills';

/**
 * La pile de pastilles, créée à la première demande.
 *
 * Retrouvée par le DOM plutôt que gardée dans une variable : les deux modules qui
 * l'utilisent ont chacun leur cycle de vie, et le conteneur doit être le même
 * quel que soit celui qui affiche sa pastille en premier.
 */
export function pillStack(): HTMLElement {
  const existing = document.querySelector<HTMLElement>(PILLS_SELECTOR);
  if (existing) return existing;

  const stack = document.createElement('div');
  stack.className = 'vf-pills';
  document.body.appendChild(stack);
  return stack;
}
