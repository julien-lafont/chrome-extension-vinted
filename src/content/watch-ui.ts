/**
 * Vinted Favoris — la trace, dans la page, du cycle de rafraîchissement.
 *
 * Le cycle tourne dans **un** onglet Vinted (`docs/specs/suivi-prix.md` §1 et
 * §3.2), et rien ne disait lequel. Avec trois onglets ouverts, « reviens sur ton
 * onglet Vinted » ne désignait rien de précis : l'utilisateur ne pouvait pas
 * savoir sur lequel revenir, ni voir qu'il était déjà au bon endroit.
 *
 * Deux marques, complémentaires par nature :
 *
 * - **le titre de l'onglet** (`🔄`, `⏸` en pause) — la seule qui se lise sans
 *   quitter l'onglet où l'on est, donc la seule qui serve à *trouver* le porteur
 *   dans la barre d'onglets ;
 * - **un bandeau en haut de la page**, qui dit l'avancement une fois qu'on y est.
 *
 * Le bandeau a d'abord été une pastille en bas à gauche, dans la pile des autres
 * (`ui.ts`) : trop discrète pour une information qu'on cherche activement — quand
 * on se demande quel onglet travaille, il faut le voir en arrivant, pas le
 * chercher. Le bandeau **recouvre** l'en-tête de Vinted le temps du cycle plutôt
 * que de décaler la page : décaler demanderait de toucher au `padding` du `body`,
 * et la mise en page collante de Vinted s'en accommode mal.
 *
 * Comme les autres surcouches, ce module vit dans le DOM de Vinted et n'hérite de
 * rien : tout est posé dans `content.css`. Le bandeau est **inerte aux clics**
 * (`pointer-events: none`) — il masque la barre de recherche pendant le cycle, il
 * ne doit pas en plus avaler les clics qui la visent, et les règles 1 et 2 du
 * projet n'ont alors plus prise sur lui.
 */

/** L'avancement à afficher ; `null` efface tout (fin de cycle). */
export type SweepDisplay = { done: number; total: number; paused?: boolean };

/**
 * Le bandeau, pour le `MutationObserver` de `content.ts` : posé sur `document.body`
 * comme les autres surcouches, il doit être exclu des deux listes (règle 3), sans
 * quoi chaque article vérifié déclencherait un scan complet de la page.
 */
export const SWEEP_BAR_SELECTOR = '.vf-sweep-bar';

/**
 * Préfixes possibles du titre. Le retrait balaie **toute** la liste avant de
 * poser la marque courante : sans ça, passer de la pause à la reprise
 * empilerait `🔄 ⏸ Vinted`.
 */
const TITLE_MARKS = ['🔄 ', '⏸ '];

/**
 * Marque le titre de l'onglet, ou le démarque (`null`).
 *
 * On retire nos préfixes du titre **courant** plutôt que de restaurer un titre
 * mémorisé au démarrage : Vinted est une application monopage, et le titre change
 * légitimement pendant un cycle qui dure. Restaurer une valeur capturée dix
 * minutes plus tôt réafficherait le nom d'un article qu'on a quitté depuis.
 *
 * Écrire dans `document.title` ne réveille pas le `MutationObserver` de
 * `content.ts` — il surveille `document.body`, et `<title>` vit dans `<head>`.
 * L'écriture reste conditionnelle par principe (règle 3).
 */
function markTitle(mark: string | null): void {
  let title = document.title;
  for (const prefix of TITLE_MARKS) {
    if (title.startsWith(prefix)) title = title.slice(prefix.length);
  }

  const next = mark ? mark + title : title;
  if (document.title !== next) document.title = next;
}

/**
 * Affiche (ou efface) la trace du cycle dans cet onglet. Idempotent : appelé à
 * chaque article vérifié et à chaque battement de pause, il ne touche au DOM que
 * si le texte a changé.
 *
 * À n'appeler **que depuis l'onglet qui porte le cycle** — c'est tout le propos.
 * Un onglet qui se contente de regarder ne doit rien afficher, sans quoi la marque
 * ne désignerait plus personne.
 */
export function showSweepProgress(state: SweepDisplay | null): void {
  const existing = document.querySelector<HTMLElement>(SWEEP_BAR_SELECTOR);

  if (!state) {
    existing?.remove();
    markTitle(null);
    return;
  }

  markTitle(state.paused ? (TITLE_MARKS[1] ?? null) : (TITLE_MARKS[0] ?? null));

  const bar = existing ?? document.createElement('div');
  if (!existing) {
    bar.className = 'vf-sweep-bar';
    // Le panneau annonce déjà l'avancement à la synthèse vocale ; un second
    // signal, sur la page de Vinted et réécrit à chaque article, ne serait que
    // du bruit.
    bar.setAttribute('aria-hidden', 'true');

    const icon = document.createElement('span');
    icon.className = 'vf-sweep-icon';
    icon.textContent = '🔄';

    const text = document.createElement('span');
    text.className = 'vf-sweep-text';

    // La jauge dit l'avancement d'un coup d'œil, là où « 12/48 » demande une
    // division. Sa largeur est un style en ligne : les attributs ne sont pas
    // observés par le `MutationObserver`, elle ne coûte donc aucun scan.
    const gauge = document.createElement('span');
    gauge.className = 'vf-sweep-gauge';
    const fill = document.createElement('span');
    fill.className = 'vf-sweep-fill';
    gauge.appendChild(fill);

    bar.append(icon, text, gauge);
    document.body.appendChild(bar);
  }

  // L'icône ne tourne que pendant le travail effectif : une animation qui
  // continue sur un cycle à l'arrêt dit le contraire de ce qui se passe.
  bar.classList.toggle('vf-sweep-paused', Boolean(state.paused));

  const label = state.paused
    ? `Rafraîchissement en pause — ${state.done}/${state.total} vérifiés, reprise dès que cet onglet revient au premier plan`
    : `Rafraîchissement des favoris — ${state.done}/${state.total}`;

  const text = bar.querySelector<HTMLElement>('.vf-sweep-text');
  if (text && text.textContent !== label) text.textContent = label;

  const ratio = state.total > 0 ? Math.min(1, state.done / state.total) : 0;
  const width = `${Math.round(ratio * 100)}%`;
  const fill = bar.querySelector<HTMLElement>('.vf-sweep-fill');
  if (fill && fill.style.width !== width) fill.style.width = width;
}
