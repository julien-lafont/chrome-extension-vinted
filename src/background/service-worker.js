// Ouvre le panneau latéral d'un simple clic sur l'icône de l'extension.
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => console.error('[Vinted Favoris] setPanelBehavior', err));
});
