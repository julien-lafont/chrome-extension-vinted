/**
 * Protocole de messages entre le panneau latéral et les content scripts.
 *
 * `chrome.runtime.sendMessage` est typé `any` des deux côtés : rien n'empêche le
 * panneau d'envoyer un champ que l'agent ne lit pas, ni de lire une réponse dont
 * la forme a changé. L'erreur ne se manifeste alors que par une offre qui ne
 * part pas, sans trace. Les deux extrémités partagent donc les types d'ici.
 *
 * Les noms de `type` sont préfixés `VF_` pour ne pas entrer en collision avec
 * les messages d'autres extensions installées sur la même page.
 */

/** Réponse commune à toutes les actions pilotées : offre, message. */
export type StepResult = {
  ok: boolean;
  /** Étape atteinte, en français : sert directement à l'affichage. */
  step: string;
  detail?: string;
  /** L'offre est partie mais le message a échoué — les deux doivent être dits. */
  messagePending?: boolean;
};

// --- Panneau → agent d'offre --------------------------------------------------

/** Sonde : la page est-elle chargée et l'agent injecté ? */
export type OfferPing = { type: 'VF_OFFER_PING' };

export type OfferPong = {
  ready: true;
  itemId: string | null;
  url: string;
  /** Le panneau attend `'complete'` avant d'enchaîner sur le message. */
  readyState: DocumentReadyState;
  canMessage: boolean;
};

export type MakeOfferRequest = { type: 'VF_MAKE_OFFER'; itemId: string; price: number };
export type SendMessageRequest = { type: 'VF_SEND_MESSAGE'; itemId: string; message: string };

/** Rapport de diagnostic de l'agent : quelles ancres Vinted il trouve, page ouverte. */
export type OfferDiagnoseRequest = { type: 'VF_OFFER_DIAGNOSE' };

export type OfferDiagnoseReport = {
  url: string;
  itemId: string | null;
  boutonOffre: string;
  modaleOuverte: string;
  champPrix: string;
  boutonMessage: string;
  zoneMessage: string;
};

// --- Panneau → content script principal ---------------------------------------

export type DiagnoseRequest = { type: 'VF_DIAGNOSE' };

/** Union de tout ce qu'un content script peut recevoir. */
export type ExtensionMessage =
  OfferPing | MakeOfferRequest | SendMessageRequest | OfferDiagnoseRequest | DiagnoseRequest;
