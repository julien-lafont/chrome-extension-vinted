/**
 * L'offre et le message partent-ils, et que dit-on quand un seul des deux passe ?
 *
 * Valider une offre fait naviguer Vinted vers la conversation, ce qui détruit le
 * content script avant qu'il ait répondu. Chrome lève alors « a listener indicated
 * an asynchronous response … message channel closed » — une erreur qui signale une
 * page disparue, pas une action échouée. La traiter comme un échec faisait perdre
 * le message alors que l'offre était bien partie.
 * Voir docs/pitfalls.md.
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { submitOffer } from '../src/sidepanel/offer.ts';
import type { ExtensionMessage } from '../src/shared/messages.ts';
import { makeItem } from './factories.ts';

const CHANNEL_CLOSED =
  'A listener indicated an asynchronous response by returning true, but the message channel closed before a response was received';

const ITEM = makeItem({
  id: '123',
  title: 'Jean brut',
  price: '40,00 €',
  url: 'https://www.vinted.fr/items/123-jean',
});

/**
 * Ce qu'un faux onglet peut répondre : une valeur (y compris une `Error`, que
 * `fakeTab` relance), ou une fonction qui la calcule depuis le message reçu.
 * `unknown` absorbe les deux cas — les distinguer dans le type n'apporterait rien.
 */
type Reply = unknown;

/**
 * Onglet Vinted simulé : `replies` donne la réponse (ou l'erreur) par type de
 * message. Le faux ne couvre que `chrome.tabs`, seule partie de l'API que
 * `submitOffer` utilise — d'où la conversion, faite ici et commentée.
 */
function fakeTab(replies: Partial<Record<ExtensionMessage['type'], Reply>>): string[] {
  const sent: string[] = [];

  const fake = {
    tabs: {
      query: () => Promise.resolve([{ id: 7, url: 'https://www.vinted.fr/items/123-jean' }]),
      update: () => Promise.resolve({}),
      create: () => Promise.resolve({ id: 7 }),
      sendMessage: (_tabId: number, message: ExtensionMessage) => {
        sent.push(message.type);
        const reply = replies[message.type];
        if (reply instanceof Error) throw reply;
        if (typeof reply === 'function') return Promise.resolve(reply(message));
        return Promise.resolve(reply);
      },
    },
  };

  (globalThis as { chrome?: unknown }).chrome = fake;

  return sent;
}

const PONG = { ready: true, readyState: 'complete', itemId: '123' };
const OFFER_OK = { ok: true, step: 'offre', detail: 'Offre de 34 € envoyée.' };

describe('envoi d une offre', () => {
  beforeEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  test('offre puis message : les deux partent', async () => {
    const sent = fakeTab({
      VF_OFFER_PING: PONG,
      VF_MAKE_OFFER: OFFER_OK,
      VF_SEND_MESSAGE: { ok: true, step: 'message', detail: 'Message envoyé.' },
    });

    const res = await submitOffer(ITEM, { price: 34, message: 'Bonjour !', sendMessage: true });

    assert.equal(res.ok, true);
    assert.equal(res.step, 'offre + message');
    assert.ok(sent.includes('VF_SEND_MESSAGE'), 'le message doit être demandé');
  });

  test('la page navigue avant la réponse : l offre compte quand même', async () => {
    const sent = fakeTab({
      VF_OFFER_PING: PONG,
      VF_MAKE_OFFER: new Error(CHANNEL_CLOSED),
      VF_SEND_MESSAGE: { ok: true, step: 'message', detail: 'Message envoyé.' },
    });

    const res = await submitOffer(ITEM, { price: 34, message: 'Bonjour !', sendMessage: true });

    assert.equal(res.ok, true, 'une navigation ne doit pas être lue comme un échec');
    assert.notEqual(res.step, 'communication');
    assert.ok(sent.includes('VF_SEND_MESSAGE'), 'le message doit être tenté malgré la navigation');
    assert.equal(res.step, 'offre + message');
  });

  test('message bloqué : l offre reste signalée comme envoyée', async () => {
    fakeTab({
      VF_OFFER_PING: PONG,
      VF_MAKE_OFFER: OFFER_OK,
      VF_SEND_MESSAGE: { ok: false, step: 'conversation', detail: 'Zone de saisie introuvable.' },
    });

    const res = await submitOffer(ITEM, { price: 34, message: 'Bonjour !', sendMessage: true });

    assert.equal(res.ok, true, "l'offre est partie : ne pas la présenter comme un échec");
    assert.equal(res.messagePending, true, 'le panneau doit proposer de copier le message');
    assert.match(res.detail ?? '', /Offre de 34 € envoyée/);
    assert.match(res.detail ?? '', /Zone de saisie introuvable/);
  });

  test('sans message demandé, rien n est envoyé au vendeur', async () => {
    const sent = fakeTab({ VF_OFFER_PING: PONG, VF_MAKE_OFFER: OFFER_OK });

    const res = await submitOffer(ITEM, { price: 34, message: 'Bonjour !', sendMessage: false });

    assert.equal(res.ok, true);
    assert.ok(!sent.includes('VF_SEND_MESSAGE'), 'la case décochée doit être respectée');
  });

  test('une vraie panne de communication reste un échec', async () => {
    fakeTab({
      VF_OFFER_PING: PONG,
      VF_MAKE_OFFER: new Error('Something else went wrong'),
    });

    const res = await submitOffer(ITEM, { price: 34, message: 'Bonjour !', sendMessage: true });

    assert.equal(res.ok, false);
    assert.equal(res.step, 'communication');
  });

  test('un refus de l agent est rapporté tel quel', async () => {
    fakeTab({
      VF_OFFER_PING: PONG,
      VF_MAKE_OFFER: { ok: false, step: 'bouton « Faire une offre »', detail: 'Introuvable.' },
    });

    const res = await submitOffer(ITEM, { price: 34, message: 'Bonjour !', sendMessage: true });

    assert.equal(res.ok, false);
    assert.match(res.step, /Faire une offre/);
  });
});
