/**
 * Vinted Favoris — agent d'offre.
 *
 * Content script distinct de `content.js` : il ne fait rien tant que le panneau
 * latéral ne lui demande pas de déposer une offre sur la fiche article courante.
 *
 * Le pilotage reproduit le parcours manuel : bouton « Faire une offre » →
 * saisie du prix dans la modale → validation, puis en option l'envoi du message
 * au vendeur via la messagerie.
 *
 * Vinted ne garantit aucun `data-testid` : chaque étape essaie plusieurs ancres,
 * de la plus stable (testid) à la plus permissive (libellé visible). Le
 * diagnostic `VF_OFFER_DIAGNOSE` indique, page ouverte, ce que l'agent trouve.
 */
(() => {
  'use strict';

  const STEP_TIMEOUT_MS = 8000;
  const POLL_MS = 120;

  // ---------------------------------------------------------------------------
  // Utilitaires DOM
  // ---------------------------------------------------------------------------

  const visible = (el) => {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && getComputedStyle(el).visibility !== 'hidden';
  };

  const norm = (value) =>
    String(value || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '') // « acceptée » et « acceptee » se valent
      .trim();

  /** Premier élément visible correspondant à l'un des sélecteurs, dans l'ordre. */
  function findBySelectors(selectors, root = document) {
    for (const selector of selectors) {
      for (const el of root.querySelectorAll(selector)) {
        if (visible(el)) return el;
      }
    }
    return null;
  }

  /** Bouton visible dont le libellé contient l'une des expressions données. */
  function findByLabel(labels, root = document) {
    const candidates = root.querySelectorAll('button, a[role="button"], [role="button"]');
    for (const el of candidates) {
      if (!visible(el)) continue;
      const text = norm(el.textContent) || norm(el.getAttribute('aria-label'));
      if (labels.some((label) => text.includes(label))) return el;
    }
    return null;
  }

  /** Attend qu'un getter renvoie une valeur exploitable, sinon null au bout du délai. */
  function waitFor(getter, timeout = STEP_TIMEOUT_MS) {
    return new Promise((resolve) => {
      const deadline = Date.now() + timeout;

      const tick = () => {
        let value = null;
        try {
          value = getter();
        } catch {
          value = null; // DOM en cours de remplacement par React
        }
        if (value) return resolve(value);
        if (Date.now() > deadline) return resolve(null);
        setTimeout(tick, POLL_MS);
      };

      tick();
    });
  }

  /**
   * Écrit dans un champ contrôlé par React : passer par `value` seul est ignoré,
   * il faut appeler le setter natif du prototype puis émettre l'événement.
   */
  function setNativeValue(field, value) {
    const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(prototype.prototype, 'value').set;

    field.focus();
    setter.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // ---------------------------------------------------------------------------
  // Ancres de la page Vinted
  // ---------------------------------------------------------------------------

  const ANCHORS = {
    offerButton: {
      selectors: [
        '[data-testid="item-make-offer-button"]',
        '[data-testid$="--make-offer-button"]',
        '[data-testid*="make-offer"]',
      ],
      labels: ['faire une offre', 'proposer un prix', 'make an offer'],
    },
    offerModal: {
      selectors: [
        '[data-testid="offer-modal"]',
        '[data-testid*="offer-modal"]',
        '[role="dialog"]',
        '.web_ui__Dialog__content',
      ],
    },
    priceInput: {
      selectors: [
        '[data-testid="offer-price-input"]',
        '[data-testid*="offer"] input',
        'input[name*="offer" i]',
        'input[inputmode="decimal"]',
        'input[type="number"]',
        'input[type="text"]',
      ],
    },
    offerSubmit: {
      selectors: [
        '[data-testid="offer-modal-submit-button"]',
        '[data-testid$="--submit-button"]',
        'button[type="submit"]',
      ],
      labels: ["envoyer l'offre", 'envoyer une offre', 'proposer', 'envoyer', 'confirmer'],
    },
    messageButton: {
      selectors: [
        '[data-testid="item-ask-seller-button"]',
        '[data-testid*="ask-seller"]',
        '[data-testid*="message-button"]',
      ],
      labels: ['poser une question', 'contacter', 'envoyer un message'],
    },
    messageInput: {
      selectors: [
        '[data-testid="conversation-new-message-input"]',
        '[data-testid*="message-input"] textarea',
        '[data-testid*="message"] textarea',
        'textarea',
      ],
    },
    messageSubmit: {
      selectors: [
        '[data-testid="conversation-reply-button"]',
        '[data-testid*="send-message"]',
        'button[type="submit"]',
      ],
      labels: ['envoyer', 'send'],
    },
  };

  /** Résout une ancre : sélecteurs d'abord, libellés en repli. */
  function resolve(anchor, root = document) {
    return (
      findBySelectors(anchor.selectors || [], root) ||
      (anchor.labels ? findByLabel(anchor.labels, root) : null)
    );
  }

  const currentItemId = () => {
    const m = location.pathname.match(/\/items\/(\d+)/);
    return m ? m[1] : null;
  };

  // ---------------------------------------------------------------------------
  // Dépôt de l'offre
  // ---------------------------------------------------------------------------

  const fail = (step, detail) => ({ ok: false, step, detail });

  async function placeOffer(price) {
    const button = await waitFor(() => resolve(ANCHORS.offerButton), 6000);
    if (!button) {
      return fail(
        'bouton « Faire une offre »',
        "Introuvable sur cette fiche. Le vendeur n'accepte peut-être pas les offres, ou l'article est vendu."
      );
    }

    button.click();

    const modal = await waitFor(() => {
      const found = findBySelectors(ANCHORS.offerModal.selectors);
      // Une modale sans champ de saisie est encore en cours d'ouverture.
      return found && findBySelectors(ANCHORS.priceInput.selectors, found) ? found : null;
    });
    if (!modal) return fail('modale d\'offre', "La fenêtre d'offre ne s'est pas ouverte.");

    const input = findBySelectors(ANCHORS.priceInput.selectors, modal);
    if (!input) return fail('champ prix', 'Champ de saisie du prix introuvable dans la modale.');

    setNativeValue(input, String(price));

    // React réactive le bouton d'envoi de façon asynchrone après la saisie.
    const submit = await waitFor(() => {
      const found = resolve(ANCHORS.offerSubmit, modal);
      return found && !found.disabled ? found : null;
    }, 4000);
    if (!submit) {
      return fail(
        'validation',
        `Prix saisi (${price} €) mais le bouton d'envoi est resté inactif. Termine à la main dans l'onglet Vinted.`
      );
    }

    submit.click();

    // Modale refermée = offre partie. Sinon Vinted affiche une erreur de saisie.
    const closed = await waitFor(() => {
      const stillOpen = findBySelectors(ANCHORS.offerModal.selectors);
      return stillOpen && findBySelectors(ANCHORS.priceInput.selectors, stillOpen) ? null : true;
    }, 6000);

    if (!closed) {
      return fail(
        'confirmation',
        "L'offre a été soumise mais Vinted n'a pas refermé la fenêtre. Vérifie dans l'onglet."
      );
    }

    return { ok: true, step: 'offre', detail: `Offre de ${price} € envoyée.` };
  }

  // ---------------------------------------------------------------------------
  // Envoi du message
  // ---------------------------------------------------------------------------

  /**
   * La page courante parle-t-elle bien de cet article ?
   *
   * Après une offre, Vinted bascule sur la conversation : on n'est plus sur la
   * fiche, et rien ne garantit que la discussion affichée soit la bonne. Écrire
   * sans vérifier reviendrait à risquer d'envoyer le message à un autre vendeur —
   * on préfère renoncer et le dire.
   */
  function pageMatchesItem(itemId) {
    if (!itemId) return true;
    if (currentItemId() === String(itemId)) return true;
    // Une conversation renvoie toujours vers l'article dont elle parle.
    return Boolean(document.querySelector(`a[href*="/items/${itemId}"]`));
  }

  async function sendMessage(message, itemId) {
    if (!pageMatchesItem(itemId)) {
      return fail(
        'conversation',
        "La page affichée ne renvoie pas à cet article : message non envoyé, pour ne pas l'adresser à la mauvaise personne."
      );
    }

    // Après une offre, Vinted bascule souvent déjà sur la conversation.
    let field = findBySelectors(ANCHORS.messageInput.selectors);

    if (!field) {
      const button = resolve(ANCHORS.messageButton);
      if (!button) return fail('bouton message', 'Aucun accès à la messagerie sur cette page.');
      button.click();
      field = await waitFor(() => findBySelectors(ANCHORS.messageInput.selectors));
    }

    if (!field) return fail('zone de message', 'Zone de saisie du message introuvable.');

    setNativeValue(field, message);

    const form = field.closest('form') || document;
    const submit = await waitFor(() => {
      const found = resolve(ANCHORS.messageSubmit, form);
      return found && !found.disabled ? found : null;
    }, 4000);

    if (!submit) {
      return fail(
        'envoi du message',
        "Message pré-rempli dans la conversation, mais le bouton d'envoi est resté inactif."
      );
    }

    submit.click();
    return { ok: true, step: 'message', detail: 'Message envoyé.' };
  }

  // ---------------------------------------------------------------------------
  // Orchestration
  // ---------------------------------------------------------------------------

  /**
   * Dépôt de l'offre seul.
   *
   * L'envoi du message fait l'objet d'un second appel, piloté par le panneau.
   * Enchaîner les deux ici condamnait le message : la validation de l'offre fait
   * naviguer Vinted vers la conversation, ce qui détruit ce content script avant
   * qu'il ait pu répondre — le canal se fermait sur « asynchronous response …
   * message channel closed », l'offre étant pourtant partie.
   */
  async function run({ itemId, price }) {
    if (itemId && currentItemId() !== String(itemId)) {
      return fail('navigation', "L'onglet n'affiche pas la fiche de cet article.");
    }
    return placeOffer(price);
  }

  function diagnose() {
    const modal = findBySelectors(ANCHORS.offerModal.selectors);
    const describe = (el) =>
      !el ? 'ABSENT' : `${el.tagName.toLowerCase()}${el.dataset.testid ? `[${el.dataset.testid}]` : ''}`;

    return {
      url: location.href,
      itemId: currentItemId(),
      boutonOffre: describe(resolve(ANCHORS.offerButton)),
      modaleOuverte: describe(modal),
      champPrix: describe(modal && findBySelectors(ANCHORS.priceInput.selectors, modal)),
      boutonMessage: describe(resolve(ANCHORS.messageButton)),
      zoneMessage: describe(findBySelectors(ANCHORS.messageInput.selectors)),
    };
  }

  // ---------------------------------------------------------------------------
  // Messages du panneau latéral
  // ---------------------------------------------------------------------------

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message) return false;

    if (message.type === 'VF_OFFER_PING') {
      // `url` et `readyState` disent au panneau si la page a navigué et si elle
      // est stabilisée : il attend ce moment pour enchaîner sur le message.
      sendResponse({
        ready: true,
        itemId: currentItemId(),
        url: location.href,
        readyState: document.readyState,
        canMessage: Boolean(findBySelectors(ANCHORS.messageInput.selectors)),
      });
      return false;
    }

    if (message.type === 'VF_OFFER_DIAGNOSE') {
      sendResponse(diagnose());
      return false;
    }

    if (message.type === 'VF_SEND_MESSAGE') {
      sendMessage(message.message, message.itemId)
        .then(sendResponse)
        .catch((err) => sendResponse(fail('exception', String((err && err.message) || err))));
      return true; // réponse asynchrone
    }

    if (message.type === 'VF_MAKE_OFFER') {
      run(message)
        .then(sendResponse)
        .catch((err) => sendResponse(fail('exception', String((err && err.message) || err))));
      return true; // réponse asynchrone
    }

    return false;
  });
})();
