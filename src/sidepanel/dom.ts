/**
 * Vinted Smart Bookmarks — les deux accès au DOM du panneau.
 *
 * Un élément absent de `sidepanel.html` n'est pas un cas à gérer mais un bug du
 * HTML : sans ses conteneurs, le panneau n'a rien à afficher. Échouer ici, avec
 * l'identifiant fautif dans le message, vaut mieux que propager des `null`
 * jusqu'au premier accès — l'erreur y désignerait une ligne qui n'a rien fait de
 * mal.
 *
 * Les deux fonctions vivaient en double, `sidepanel.ts` et `filters.ts` pour
 * `required()`, `sidepanel.ts` et `item-render.ts` pour `within()`, chacune avec
 * son propre message. C'est le genre de duplication qui ne fait de mal que le
 * jour où l'une des copies évolue seule.
 */

/** L'élément d'identifiant `id`, dont l'absence serait un bug de `sidepanel.html`. */
export function required<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`sidepanel.html : élément #${id} introuvable`);
  return el as T;
}

/** Même intention, pour un descendant d'un nœud déjà obtenu. */
export function within<T extends Element>(root: ParentNode, selector: string): T {
  const el = root.querySelector<T>(selector);
  if (!el) throw new Error(`sidepanel.html : ${selector} introuvable`);
  return el;
}
