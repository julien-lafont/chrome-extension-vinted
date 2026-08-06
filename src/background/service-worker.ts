import { watchSavedItems } from './saved-pulse.ts';

// Ouvre le panneau latéral d'un simple clic sur l'icône de l'extension.
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => console.error('[Vinted Smart Bookmarks] setPanelBehavior', err));
});

// Au niveau du module, pas dans `onInstalled` : le service worker est arrêté et
// relancé sans cesse, et une écoute posée seulement à l'installation n'existerait
// plus au premier réveil.
watchSavedItems();

// Un badge a pu survivre à l'arrêt du worker (le `setTimeout` qui l'efface n'a
// alors jamais abouti). Le réveil est la seule occasion de le nettoyer.
chrome.action.setBadgeText({ text: '' }).catch(() => undefined);
