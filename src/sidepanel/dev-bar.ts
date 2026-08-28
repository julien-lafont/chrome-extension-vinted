/**
 * Bande de développement du panneau : masquée par défaut, dépliée par le clic
 * droit sur l'icône de l'extension (« Ouvrir en mode développeur »).
 *
 * L'affichage suit `chrome.storage.session` plutôt qu'un état local : le
 * panneau peut être déjà ouvert au moment du clic sur l'entrée de menu, et
 * l'écoute des changements est alors le seul moyen de le voir arriver.
 */
import { DEV_MODE_KEY, readDevMode, setDevMode } from '../shared/dev-mode.ts';

export function initDevBar(bar: HTMLElement, exit: HTMLElement, report: HTMLElement): void {
  const apply = (on: boolean): void => {
    bar.hidden = !on;
    // Le rapport est la sortie de ces boutons : le laisser derrière eux
    // afficherait un pavé de JSON sans plus rien pour l'expliquer ni le refermer.
    if (!on) report.hidden = true;
  };

  // Masquée aussi côté HTML (`hidden`) : sans ça, la bande clignoterait le temps
  // de cette lecture asynchrone à chaque ouverture du panneau.
  void readDevMode().then(apply);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'session') return;
    const change = changes[DEV_MODE_KEY];
    if (change) apply(change.newValue === true);
  });

  // Le repli ne dépend pas de l'écoute ci-dessus : elle passe bien par le
  // contexte écrivain, mais un bouton qui ne répond qu'après un aller-retour de
  // storage se lit comme un bouton mort.
  exit.addEventListener('click', () => {
    apply(false);
    void setDevMode(false);
  });
}
