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

/**
 * « Y a-t-il un content script à jour dans cet onglet ? »
 *
 * Sert au panneau à distinguer deux situations que `chrome.tabs.sendMessage`
 * rend identiques (une erreur laconique) : un onglet Vinted ouvert avant le
 * chargement de l'extension, où il faut demander un Cmd+R, et un onglet
 * fraîchement créé où il suffit d'attendre l'injection.
 *
 * Message à part, et non un repli sur `VF_DIAGNOSE` : sonder ne doit rien
 * coûter, là où le diagnostic parcourt le DOM entier.
 */
export type PingRequest = { type: 'VF_PING' };

export type PingResponse = { ok: true };

export type WatchStartResponse = {
  accepted: boolean;
  /** Raison du refus, en français : sert directement à l'affichage du bouton. */
  reason?: string;
};

/**
 * Lance un balayage des offres (`docs/specs/offres.md` §4). Comme le cycle de
 * suivi, le content script répond tout de suite et le résultat se lit ensuite
 * dans `chrome.storage.local` — les offres sur leurs articles, l'avancement du
 * balayage sur la clé `offers`.
 *
 * Message distinct de `VF_WATCH_START`, et non un ajout à son cycle : le suivi
 * de prix est freiné par un budget quotidien et une fenêtre d'une heure, dont
 * les offres n'ont pas à hériter — elles coûtent une requête JSON là où il
 * télécharge des fiches entières.
 */
export type OffersScanRequest = { type: 'VF_OFFERS_SCAN' };

export type OffersScanResponse = {
  accepted: boolean;
  /** Raison du refus, en français. */
  reason?: string;
};

/** Union de tout ce qu'un content script peut recevoir. */
export type ExtensionMessage =
  DiagnoseRequest | PingRequest | WatchStartRequest | WatchCancelRequest | OffersScanRequest;
