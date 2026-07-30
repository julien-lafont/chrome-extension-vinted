/**
 * Le balayage des offres lit-il **le moins possible**, et écrit-il **seulement**
 * ce qui a changé ?
 *
 * Trois garanties s'éprouvent ici, chacune coûteuse à découvrir en production :
 *
 *  1. l'incrémental s'arrête à la première conversation déjà vue — sans quoi
 *     chaque scan relit toute l'inbox, soit une requête par conversation ;
 *  2. un article non enregistré ou une offre inchangée ne déclenchent aucune
 *     écriture, donc aucun repeint du panneau ;
 *  3. un 429 arrête tout et **n'efface rien** : interpréter un coup de frein
 *     comme « plus d'offre » retirerait tous les badges d'un coup.
 *
 * Voir `docs/specs/offres.md` §4.
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { scanOffers } from '../src/content/offers-scan.ts';
import { ITEMS_KEY, OFFERS_KEY } from '../src/shared/storage.ts';
import type { ItemMap, OffersScanState } from '../src/shared/types.ts';
import { makeItem } from './factories.ts';
import { installFakeChrome, uninstallFakeChrome, type FakeChrome } from './fake-chrome.ts';

const ME = 77742929;
const NOW = Date.parse('2026-07-30T12:00:00+02:00');

/** Une conversation d'achat avec une offre de moi, en attente. */
function conversationWithOffer(
  id: number,
  itemId: number,
  { price = '399.0', ts = '2026-07-29T19:58:42+02:00', status = 10 } = {}
) {
  return {
    conversation: {
      id,
      messages: [
        {
          entity_type: 'offer_request_message',
          created_at_ts: ts,
          entity: {
            user_id: ME,
            status,
            current: true,
            price: { amount: price, currency_code: 'EUR' },
          },
        },
      ],
      transaction: {
        status: 1,
        buyer_id: ME,
        current_user_side: 'buyer',
        item_id: itemId,
        item_ids: [itemId],
        item_is_closed: false,
      },
    },
  };
}

/** Conversation sans la moindre offre : ce que le scan doit traduire par « rien ». */
function conversationWithoutOffer(id: number, itemId: number) {
  return {
    conversation: {
      id,
      messages: [{ entity_type: 'status_message', created_at_ts: '2026-07-28T12:10:18+02:00' }],
      transaction: {
        status: 1,
        buyer_id: ME,
        current_user_side: 'buyer',
        item_id: itemId,
        item_ids: [itemId],
        item_is_closed: false,
      },
    },
  };
}

type Route = { status?: number; body?: unknown };

/**
 * `fetch` de test : sert une réponse par URL et **journalise chaque appel**.
 * C'est le journal qui porte l'essentiel des assertions — ce qui n'a pas été
 * demandé compte autant que ce qui a été écrit.
 */
function fakeFetch(routes: Record<string, Route>) {
  const calls: string[] = [];

  const impl = ((url: string) => {
    const path = String(url);
    calls.push(path);

    const route = routes[path];
    if (!route) return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });

    const status = route.status ?? 200;
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(route.body ?? {}),
    });
  }) as unknown as typeof fetch;

  return { impl, calls };
}

const inbox = (entries: { id: number; updated_at: string }[], totalPages = 1) => ({
  conversations: entries,
  pagination: { total_pages: totalPages },
});

const deps = (fetchImpl: typeof fetch) => ({
  fetchImpl,
  now: () => NOW,
  wait: () => Promise.resolve(),
  isVisible: () => true,
});

const items = (fake: FakeChrome): ItemMap => (fake.db[ITEMS_KEY] || {}) as ItemMap;
const scanState = (fake: FakeChrome): OffersScanState => fake.db[OFFERS_KEY] as OffersScanState;

describe('scanOffers', () => {
  let fake: FakeChrome;

  beforeEach(() => {
    fake = installFakeChrome({
      [ITEMS_KEY]: {
        '9488279818': makeItem({ id: '9488279818' }),
        '7387980053': makeItem({ id: '7387980053' }),
      },
    });
  });

  afterEach(() => {
    uninstallFakeChrome();
  });

  test('premier scan : lit le compte, balaie l’inbox et pose l’offre', async () => {
    const { impl, calls } = fakeFetch({
      '/api/v2/users/current': { body: { user: { id: ME } } },
      '/api/v2/inbox?page=1&per_page=20': {
        body: inbox([{ id: 24027793606, updated_at: '2026-07-29T19:58:42+02:00' }]),
      },
      '/api/v2/conversations/24027793606': { body: conversationWithOffer(24027793606, 9488279818) },
    });

    const summary = await scanOffers(deps(impl));

    assert.equal(summary.read, 1);
    assert.equal(summary.written, 1);
    assert.deepEqual(items(fake)['9488279818']?.offer, {
      by: 'me',
      price: 399,
      at: Date.parse('2026-07-29T19:58:42+02:00'),
      status: 'pending',
      conversationId: '24027793606',
    });

    // L'identifiant du compte n'est demandé qu'une fois, et mémorisé.
    assert.equal(calls.filter((url) => url.includes('users/current')).length, 1);
    assert.equal(scanState(fake).userId, String(ME));
    // Historique entièrement lu : plus de rattrapage à faire.
    assert.equal(scanState(fake).backfillBefore, undefined);
    assert.equal(scanState(fake).cursor, Date.parse('2026-07-29T19:58:42+02:00'));
  });

  test('scan suivant : s’arrête à la première conversation déjà vue', async () => {
    fake.db[OFFERS_KEY] = {
      userId: String(ME),
      lastScanAt: NOW - 60000,
      cursor: Date.parse('2026-07-28T00:00:00+02:00'),
    } satisfies OffersScanState;

    const { impl, calls } = fakeFetch({
      '/api/v2/inbox?page=1&per_page=20': {
        body: inbox(
          [
            { id: 1, updated_at: '2026-07-29T10:00:00+02:00' }, // nouvelle
            { id: 2, updated_at: '2026-07-27T10:00:00+02:00' }, // déjà vue → stop
            { id: 3, updated_at: '2026-07-26T10:00:00+02:00' },
          ],
          3
        ),
      },
      '/api/v2/conversations/1': { body: conversationWithOffer(1, 9488279818) },
    });

    await scanOffers(deps(impl));

    // Une seule conversation détaillée, et surtout : pas de seconde page.
    assert.deepEqual(calls, ['/api/v2/inbox?page=1&per_page=20', '/api/v2/conversations/1']);
  });

  test('le rattrapage descend sous sa borne, sans relire l’incrémental', async () => {
    fake.db[OFFERS_KEY] = {
      userId: String(ME),
      lastScanAt: NOW - 60000,
      cursor: Date.parse('2026-07-29T00:00:00+02:00'),
      backfillBefore: Date.parse('2026-07-27T00:00:00+02:00'),
    } satisfies OffersScanState;

    const { impl, calls } = fakeFetch({
      '/api/v2/inbox?page=1&per_page=20': {
        body: inbox([
          { id: 1, updated_at: '2026-07-28T10:00:00+02:00' }, // entre le curseur et la borne : déjà vue
          { id: 2, updated_at: '2026-07-26T10:00:00+02:00' }, // sous la borne : à rattraper
        ]),
      },
      '/api/v2/conversations/2': { body: conversationWithOffer(2, 7387980053) },
    });

    await scanOffers(deps(impl));

    assert.deepEqual(calls, ['/api/v2/inbox?page=1&per_page=20', '/api/v2/conversations/2']);
    assert.equal(items(fake)['7387980053']?.offer?.conversationId, '2');
    // Fin de l'inbox atteinte : le rattrapage est clos.
    assert.equal(scanState(fake).backfillBefore, undefined);
  });

  test('un article non enregistré n’écrit rien', async () => {
    const { impl } = fakeFetch({
      '/api/v2/users/current': { body: { user: { id: ME } } },
      '/api/v2/inbox?page=1&per_page=20': {
        body: inbox([{ id: 9, updated_at: '2026-07-29T19:58:42+02:00' }]),
      },
      // 111 n'est pas dans les favoris : l'inbox parle aussi de ce qu'on vend.
      '/api/v2/conversations/9': { body: conversationWithOffer(9, 111) },
    });

    const summary = await scanOffers(deps(impl));

    assert.equal(summary.read, 1);
    assert.equal(summary.written, 0);
    assert.equal(items(fake)['9488279818']?.offer, undefined);
  });

  test('une offre inchangée ne réécrit pas l’article', async () => {
    const offer = {
      by: 'me',
      price: 399,
      at: Date.parse('2026-07-29T19:58:42+02:00'),
      status: 'pending',
      conversationId: '24027793606',
    } as const;

    fake.db[ITEMS_KEY] = {
      '9488279818': makeItem({ id: '9488279818', offer: { ...offer } }),
    };

    const { impl } = fakeFetch({
      '/api/v2/users/current': { body: { user: { id: ME } } },
      '/api/v2/inbox?page=1&per_page=20': {
        body: inbox([{ id: 24027793606, updated_at: '2026-07-29T19:58:42+02:00' }]),
      },
      '/api/v2/conversations/24027793606': { body: conversationWithOffer(24027793606, 9488279818) },
    });

    const summary = await scanOffers(deps(impl));

    assert.equal(summary.read, 1);
    // Aucune écriture : le panneau ne se repeint pas pour une offre identique.
    assert.equal(summary.written, 0);
  });

  test('une offre disparue de sa conversation est effacée', async () => {
    fake.db[ITEMS_KEY] = {
      '9488279818': makeItem({
        id: '9488279818',
        offer: {
          by: 'me',
          price: 399,
          at: Date.parse('2026-07-29T19:58:42+02:00'),
          status: 'pending',
          conversationId: '77',
        },
      }),
      // Posée par une autre conversation : elle ne doit pas être emportée.
      '7387980053': makeItem({
        id: '7387980053',
        offer: {
          by: 'me',
          price: 42,
          at: Date.parse('2026-07-20T10:00:00+02:00'),
          status: 'pending',
          conversationId: '88',
        },
      }),
    };

    const { impl } = fakeFetch({
      '/api/v2/users/current': { body: { user: { id: ME } } },
      '/api/v2/inbox?page=1&per_page=20': {
        body: inbox([{ id: 77, updated_at: '2026-07-29T19:58:42+02:00' }]),
      },
      '/api/v2/conversations/77': { body: conversationWithoutOffer(77, 9488279818) },
    });

    await scanOffers(deps(impl));

    assert.equal(items(fake)['9488279818']?.offer, undefined);
    assert.equal(items(fake)['7387980053']?.offer?.conversationId, '88');
  });

  test('un 429 arrête le scan, pose le silence et n’efface aucune offre', async () => {
    fake.db[ITEMS_KEY] = {
      '9488279818': makeItem({
        id: '9488279818',
        offer: {
          by: 'me',
          price: 399,
          at: Date.parse('2026-07-29T19:58:42+02:00'),
          status: 'pending',
          conversationId: '24027793606',
        },
      }),
    };

    const { impl } = fakeFetch({
      '/api/v2/users/current': { body: { user: { id: ME } } },
      '/api/v2/inbox?page=1&per_page=20': {
        body: inbox([{ id: 24027793606, updated_at: '2026-07-29T19:58:42+02:00' }]),
      },
      '/api/v2/conversations/24027793606': { status: 429 },
    });

    const summary = await scanOffers(deps(impl));

    assert.equal(summary.stopped, 'freiné');
    assert.ok((scanState(fake).throttledUntil ?? 0) > NOW);
    assert.ok(items(fake)['9488279818']?.offer, 'l’offre connue survit au coup de frein');
  });

  test('pendant la fenêtre de silence, aucune requête n’est émise', async () => {
    fake.db[OFFERS_KEY] = {
      userId: String(ME),
      lastScanAt: NOW - 60000,
      throttledUntil: NOW + 60000,
    } satisfies OffersScanState;

    const { impl, calls } = fakeFetch({});
    const summary = await scanOffers(deps(impl));

    assert.equal(summary.stopped, 'freiné');
    assert.deepEqual(calls, []);
  });

  test('un onglet passé en arrière-plan interrompt le balayage', async () => {
    const { impl, calls } = fakeFetch({
      '/api/v2/users/current': { body: { user: { id: ME } } },
      '/api/v2/inbox?page=1&per_page=20': {
        body: inbox([{ id: 1, updated_at: '2026-07-29T19:58:42+02:00' }]),
      },
    });

    const summary = await scanOffers({ ...deps(impl), isVisible: () => false });

    assert.equal(summary.stopped, 'onglet caché');
    assert.ok(!calls.some((url) => url.includes('conversations/')));
  });

  test('sans identifiant de compte, le scan ne lit aucune conversation', async () => {
    // Session expirée : l'API répond 403. Rien n'est décidable sans savoir qui
    // l'on est — une offre reçue passerait pour une offre faite.
    const { impl, calls } = fakeFetch({ '/api/v2/users/current': { status: 403 } });

    const summary = await scanOffers(deps(impl));

    assert.equal(summary.stopped, 'compte inconnu');
    assert.deepEqual(calls, ['/api/v2/users/current']);
  });
});
