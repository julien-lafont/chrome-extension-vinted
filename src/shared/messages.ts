/**
 * Protocole de messages entre le panneau latéral et le content script.
 *
 * `chrome.runtime.sendMessage` est typé `any` des deux côtés : rien n'empêche le
 * panneau d'envoyer un champ que le content script ne lit pas, ni de lire une
 * réponse dont la forme a changé. Les deux extrémités partagent donc les types
 * d'ici.
 *
 * Les noms de `type` sont préfixés `VF_` pour ne pas entrer en collision avec
 * les messages d'autres extensions installées sur la même page.
 */

// --- Panneau → content script principal ---------------------------------------

export type DiagnoseRequest = { type: 'VF_DIAGNOSE' };

/**
 * Lance un cycle de vérification sur les articles donnés. Le content script
 * répond tout de suite (accepté ou non) ; la progression et le résultat se
 * lisent ensuite dans `chrome.storage.local` (clé `watch`), jamais par un
 * second message — voir `docs/specs/suivi-prix.md` §2.
 */
export type WatchStartRequest = { type: 'VF_WATCH_START'; ids: string[] };
export type WatchCancelRequest = { type: 'VF_WATCH_CANCEL' };

export type WatchStartResponse = {
  accepted: boolean;
  /** Raison du refus, en français : sert directement à l'affichage du bouton. */
  reason?: string;
};

/** Union de tout ce qu'un content script peut recevoir. */
export type ExtensionMessage = DiagnoseRequest | WatchStartRequest | WatchCancelRequest;
