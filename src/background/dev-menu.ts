/**
 * Entrée « Ouvrir en mode développeur » du clic droit sur l'icône de
 * l'extension.
 *
 * C'est le seul chemin vers la bande d'outils de mise au point du panneau
 * (`shared/dev-mode.ts`) : elle ne s'affiche plus d'elle-même. Le menu
 * contextuel est le bon support parce qu'il n'occupe aucune place dans
 * l'interface tant qu'on ne le déplie pas.
 */
import { setDevMode } from '../shared/dev-mode.ts';

export const DEV_MENU_ID = 'open-dev-mode';

export function installDevMenu(): void {
  // Les entrées de menu survivent à l'arrêt du service worker mais pas à une
  // mise à jour de l'extension : elles se (re)créent à l'installation. Le
  // `removeAll` évite le « duplicate id » qui ferait échouer la création
  // silencieusement après une mise à jour.
  chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.removeAll(() => {
      chrome.contextMenus.create({
        id: DEV_MENU_ID,
        title: 'Ouvrir en mode développeur',
        contexts: ['action'],
      });
    });
  });

  chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId !== DEV_MENU_ID) return;
    openDevPanel(tab?.windowId);
  });
}

/**
 * Ouvre le panneau en mode développeur.
 *
 * `sidePanel.open()` est appelé **sans await préalable** : Chrome ne l'autorise
 * qu'en réponse directe à un geste de l'utilisateur, et attendre l'écriture du
 * drapeau ferait perdre ce contexte (« may only be called in response to a user
 * gesture »). Les deux partent donc de front, et le panneau rattrape l'ordre
 * quel qu'il soit : il lit le drapeau au démarrage *et* écoute ses changements
 * (`sidepanel/dev-bar.ts`).
 */
function openDevPanel(windowId: number | undefined): void {
  void setDevMode(true);

  if (windowId === undefined) {
    // Sans onglet porteur (cas de repli), le geste est déjà perdu : le mode
    // restera armé pour la prochaine ouverture du panneau.
    return;
  }

  chrome.sidePanel
    .open({ windowId })
    .catch((err) => console.error('[Vinted Smart Bookmarks] sidePanel.open', err));
}
