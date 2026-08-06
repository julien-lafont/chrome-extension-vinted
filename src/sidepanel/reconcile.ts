/**
 * Vinted Smart Bookmarks — mise à jour de la liste sans la reconstruire.
 *
 * Le panneau se re-rendait en vidant son conteneur (`listEl.textContent = ''`)
 * avant de recréer chaque ligne. Deux conséquences, toutes deux silencieuses :
 *
 *   — **la position de défilement retombe à zéro.** Vider un conteneur qui défile
 *     remet son `scrollTop` à 0, et le panneau se re-rend à *chaque* écriture du
 *     storage. Un cycle de suivi de prix en produit une par article vérifié :
 *     l'utilisateur qui parcourait sa liste était renvoyé en haut toutes les
 *     quelques secondes, sans rien pour l'expliquer ;
 *   — **les vignettes repassent par le chargement**, puisque chaque `<img>` est
 *     un nœud neuf.
 *
 * `reconcile()` aligne les enfants sur la liste attendue en déplaçant le moins de
 * nœuds possible. Un nœud déjà à sa place n'est pas touché : il ne quitte jamais
 * le document, donc la hauteur de la liste ne s'effondre pas et le défilement
 * tient.
 *
 * Le module ne connaît que des nœuds : c'est l'appelant qui décide lesquels
 * réutiliser d'un rendu à l'autre (voir `renderedItems` dans `sidepanel.ts`).
 */

/**
 * Aligne les enfants de `container` sur `nodes`, dans cet ordre.
 *
 * Tout enfant absent de `nodes` est retiré : articles disparus, message de liste
 * vide d'un rendu précédent, fantôme laissé par un glisser interrompu.
 *
 * @param nodes les nœuds voulus, dans l'ordre d'affichage ; ils peuvent déjà
 *   appartenir au conteneur, y être dans un autre ordre, ou être neufs
 */
export function reconcile(container: Element, nodes: readonly Node[]): void {
  const wanted = new Set(nodes);

  // Les retraits d'abord. Sans cette passe, un article supprimé au milieu ferait
  // *déplacer* tous ceux qui le suivent : le résultat serait le même à l'écran,
  // mais chaque déplacement est un détachement du document, exactement ce qu'on
  // cherche à éviter.
  for (const child of [...container.childNodes]) {
    if (!wanted.has(child)) child.remove();
  }

  let cursor: ChildNode | null = container.firstChild;

  for (const node of nodes) {
    if (cursor === node) {
      cursor = cursor.nextSibling;
      continue;
    }

    // `cursor` n'est jamais le nœud à poser (cas traité juste au-dessus) et
    // reste donc un point d'insertion valide, que `node` soit neuf ou déjà
    // présent plus loin dans la liste.
    container.insertBefore(node, cursor);
  }
}
