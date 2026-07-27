/**
 * Chemins des icônes, **relatifs à `dist/`**.
 *
 * Le manifeste les déclare, et le service worker en a besoin pour rendre
 * l'icône d'origine après l'avoir animée (`chrome.action.setIcon`). Les deux
 * lisent la même constante : une icône renommée ne peut plus laisser la barre
 * d'outils figée sur la dernière image de l'animation.
 */
export const ICON_PATHS = {
  16: 'icons/icon16.png',
  48: 'icons/icon48.png',
  128: 'icons/icon128.png',
} as const;
