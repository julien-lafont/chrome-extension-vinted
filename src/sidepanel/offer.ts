/**
 * Vinted Favoris — offres.
 *
 * Deux responsabilités :
 *   1. composer un message de négociation adapté à la remise demandée ;
 *   2. piloter l'onglet Vinted qui va réellement déposer l'offre.
 *
 * Le pilotage passe par le content script `offer-agent.js` : le panneau ouvre
 * (ou réutilise) un onglet sur la fiche article, attend que l'agent réponde,
 * puis lui transmet prix et message.
 */

import { parsePrice } from './sorting.js';

// --- Composition du message --------------------------------------------------

/**
 * Les leviers retenus sont ceux qui font accepter une offre sur Vinted :
 * montrer qu'on a regardé l'article, annoncer un achat immédiat, chiffrer une
 * seule fois, et laisser la porte ouverte plutôt que de poser un ultimatum.
 */
const OPENINGS = [
  'Bonjour ! Votre {title} me plaît beaucoup',
  'Bonjour, je viens de repérer votre {title}',
  'Bonjour ! Je craque un peu sur votre {title}',
  'Bonjour, votre {title} correspond exactement à ce que je cherche',
];

const HOOKS = {
  small: [
    ", et l'annonce est très bien faite.",
    ', les photos donnent vraiment envie.',
    ", c'est exactement la pièce qu'il me manquait.",
  ],
  medium: [
    ', et son état a l\'air impeccable sur les photos.',
    ", je le cherchais depuis un moment dans cette taille.",
    ', la coupe et la couleur sont parfaites pour moi.',
  ],
  large: [
    ", même si mon budget du moment est un peu serré.",
    ', je le garde en favori depuis quelques jours.',
    ", il me tente beaucoup mais je dois surveiller mes dépenses.",
  ],
};

const PITCHES = {
  small: [
    "Est-ce que {price} vous conviendrait ? J'achète dans la foulée si c'est bon pour vous.",
    'Seriez-vous d\'accord pour {price} ? Je valide immédiatement dans ce cas.',
    'Je vous propose {price}, réglés tout de suite si vous acceptez.',
  ],
  medium: [
    'Seriez-vous ouvert(e) à {price} ? Je valide dès votre accord, sans négocier davantage.',
    'Est-ce que {price} serait envisageable ? Je paie immédiatement et je laisse un avis dès réception.',
    'Je me permets de proposer {price} : achat réglé dans la minute si cela vous va.',
  ],
  large: [
    'Je me permets de tenter {price} — je comprends tout à fait si c\'est trop bas, dites-moi simplement ce qui vous irait.',
    "Auriez-vous la possibilité de descendre à {price} ? Si c'est trop, n'hésitez pas à me faire une contre-proposition.",
    'Est-ce que {price} serait jouable de votre côté ? Je suis preneur(se) immédiatement, et ouvert(e) à un compromis sinon.',
  ],
};

const CLOSINGS = [
  'Bonne journée et merci !',
  'Merci d\'avance pour votre retour, bonne journée !',
  'Quoi qu\'il en soit, merci pour votre réponse. Belle journée !',
];

const pick = (list) => list[Math.floor(Math.random() * list.length)];

/** Trois registres selon l'effort demandé au vendeur. */
function bandFor(discountPercent) {
  if (discountPercent <= 10) return 'small';
  if (discountPercent <= 25) return 'medium';
  return 'large';
}

export function formatEuro(value) {
  return new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format(value);
}

/**
 * @param {object} item article ciblé
 * @param {number} offerPrice prix proposé, en euros
 * @returns {string} message prêt à envoyer, ~4 lignes
 */
/**
 * Le titre Vinted est souvent bavard ("Jean Levi's 501 bleu délavé taille 32
 * coupe droite vintage") : on coupe au dernier mot entier avant la limite.
 * La majuscule initiale tombe pour s'insérer après « votre », sauf sur les
 * marques écrites en capitales (COS, NIKE) qu'on laisse intactes.
 */
function shortTitle(rawTitle) {
  const title = (rawTitle || 'article').trim();

  const cut =
    title.length <= 48
      ? title
      : `${title.slice(0, 45).replace(/\s+\S*$/, '')}…`;

  return /^[A-ZÀ-Ý]{2,}/.test(cut) ? cut : cut.charAt(0).toLowerCase() + cut.slice(1);
}

export function composeMessage(item, offerPrice) {
  const original = parsePrice(item);
  const discount =
    original && original > 0 ? Math.round(((original - offerPrice) / original) * 100) : 15;
  const band = bandFor(Math.max(0, discount));

  const opening = pick(OPENINGS).replace('{title}', shortTitle(item.title));
  const hook = pick(HOOKS[band]);
  const pitch = pick(PITCHES[band]).replace('{price}', formatEuro(offerPrice));
  const closing = pick(CLOSINGS);

  return `${opening}${hook}\n\n${pitch}\n\n${closing}`;
}

/** Prix suggéré : remise appliquée puis arrondie à l'euro inférieur. */
export function suggestPrice(item, discountPercent) {
  const original = parsePrice(item);
  if (!original) return null;
  return Math.max(1, Math.floor(original * (1 - discountPercent / 100)));
}

// --- Pilotage de l'onglet Vinted ---------------------------------------------

const AGENT_TIMEOUT_MS = 15000;
const PING_INTERVAL_MS = 400;
/** Laisse à Vinted le temps d'amorcer sa navigation avant de re-sonder l'onglet. */
const SETTLE_MS = 800;

/**
 * Erreurs qui signalent que la page a disparu sous nos pieds — navigation,
 * rechargement, extension mise à jour — et non que l'action a échoué.
 */
const CHANNEL_LOST =
  /message channel closed|Receiving end does not exist|context invalidated|No tab with id|Could not establish connection/i;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function sendToTab(tabId, message) {
  return chrome.tabs.sendMessage(tabId, message);
}

/** Onglet déjà ouvert sur cette fiche article, sinon nouvel onglet. */
async function openItemTab(item) {
  const tabs = await chrome.tabs.query({ url: 'https://www.vinted.fr/items/*' });
  const existing = tabs.find((tab) => tab.url && tab.url.includes(`/items/${item.id}`));

  if (existing) {
    await chrome.tabs.update(existing.id, { active: true });
    return existing.id;
  }

  const created = await chrome.tabs.create({ url: item.url, active: true });
  return created.id;
}

/**
 * Attend que l'agent réponde depuis une page stabilisée.
 * Sert aussi bien au premier chargement qu'après la navigation déclenchée par
 * l'envoi de l'offre.
 * @returns {Promise<object|null>} la réponse au ping, ou null au bout du délai
 */
async function waitForAgent(tabId, timeout = AGENT_TIMEOUT_MS) {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    try {
      const pong = await sendToTab(tabId, { type: 'VF_OFFER_PING' });
      if (pong && pong.ready && pong.readyState === 'complete') return pong;
    } catch {
      // Content script pas encore injecté, ou page en cours de navigation.
    }
    await wait(PING_INTERVAL_MS);
  }

  return null;
}

/** L'offre est partie ; seul le message a échoué. On ne masque ni l'un ni l'autre. */
const offerOnly = (offer, note) => ({
  ok: true,
  step: 'offre',
  detail: `${offer.detail} En revanche, le message n'est pas parti : ${note}`,
  messagePending: true,
});

/**
 * Dépose l'offre, puis — si demandé — envoie le message au vendeur.
 *
 * Les deux étapes sont deux allers-retours distincts avec l'agent. Les enchaîner
 * côté page condamnait le message : valider une offre fait naviguer Vinted vers la
 * conversation, ce qui détruit le content script avant sa réponse. Le panneau
 * attend donc que l'onglet se stabilise entre les deux.
 *
 * @returns {Promise<{ok: boolean, step: string, detail?: string, messagePending?: boolean}>}
 */
export async function submitOffer(item, { price, message, sendMessage }) {
  const tabId = await openItemTab(item);

  if (!(await waitForAgent(tabId))) {
    return {
      ok: false,
      step: 'chargement',
      detail: "La page de l'article n'a pas répondu. Recharge l'onglet Vinted puis réessaie.",
    };
  }

  let offer;
  try {
    offer = await sendToTab(tabId, { type: 'VF_MAKE_OFFER', itemId: item.id, price });
  } catch (err) {
    const detail = String((err && err.message) || err);
    if (!CHANNEL_LOST.test(detail)) {
      return { ok: false, step: 'communication', detail };
    }
    // La page a navigué avant que l'agent réponde : c'est le comportement normal
    // de Vinted une fois l'offre acceptée par le formulaire.
    offer = { ok: true, step: 'offre', detail: `Offre de ${price} € envoyée.` };
  }

  if (!offer.ok || !sendMessage) return offer;

  await wait(SETTLE_MS);
  if (!(await waitForAgent(tabId, 10000))) {
    return offerOnly(offer, "la page n'a plus répondu après l'envoi de l'offre.");
  }

  try {
    const sent = await sendToTab(tabId, { type: 'VF_SEND_MESSAGE', itemId: item.id, message });
    if (sent && sent.ok) {
      return { ok: true, step: 'offre + message', detail: `${offer.detail} ${sent.detail}` };
    }
    return offerOnly(offer, (sent && sent.detail) || 'raison inconnue.');
  } catch (err) {
    return offerOnly(offer, String((err && err.message) || err));
  }
}
