/**
 * L'offre courante d'une conversation est-elle lue — et **refusée** quand rien
 * ne la rend sûre ?
 *
 * Les charges utiles reproduisent les réponses relevées le 29/07/2026 sur un
 * compte réel (55 conversations, 3 ans d'historique), réduites aux champs lus et
 * anonymisées. Chaque cas nommé « conv … » vient d'une conversation existante :
 * ce sont ces formes-là qu'il faut continuer de lire, pas des formes plausibles.
 *
 * Voir `docs/specs/offres.md` §1 et §3.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  isLiveOffer,
  offerFromConversation,
  offerLabel,
  parseCurrentUserId,
  parseInboxPage,
} from '../src/shared/offers.ts';

/** Le compte connecté, dans tous les cas ci-dessous. */
const ME = '77742929';

const at = (iso: string): number => Date.parse(iso);

/** Une transaction d'achat ordinaire, encore ouverte. */
function buying(overrides: Record<string, unknown> = {}) {
  return {
    status: 1,
    buyer_id: 77742929,
    seller_id: 35422672,
    current_user_side: 'buyer',
    item_id: 9488279818,
    item_ids: [9488279818],
    is_bundle: false,
    item_is_closed: false,
    ...overrides,
  };
}

/** Demande d'offre : ce que l'acheteur envoie. Le statut est numérique. */
function offerRequest({
  userId = 77742929,
  status = 10,
  price = '399.0',
  ts = '2026-07-29T19:58:42+02:00',
  current = true,
}: Partial<{
  userId: number;
  status: number;
  price: string;
  ts: string;
  current: boolean;
}> = {}) {
  return {
    entity_type: 'offer_request_message',
    created_at_ts: ts,
    entity: {
      user_id: userId,
      status,
      status_title: 'En attente',
      current,
      title: 'Rappel : tu as fait une offre à ce membre',
      price: { amount: price, currency_code: 'EUR' },
      original_price: { amount: '650.0', currency_code: 'EUR' },
    },
  };
}

/** Proposition du vendeur (« Fixer le prix à … ») : aucun statut, jamais. */
function sellerOffer({
  userId = 35422672,
  price = '205.0',
  ts = '2026-07-26T18:34:28+02:00',
}: Partial<{ userId: number; price: string; ts: string }> = {}) {
  return {
    entity_type: 'offer_message',
    created_at_ts: ts,
    entity: {
      user_id: userId,
      current: true,
      price: { amount: price, currency_code: 'EUR' },
      original_price: { amount: '210.0', currency_code: 'EUR' },
    },
  };
}

function conversation(messages: unknown[], transaction = buying(), id = 24027793606) {
  return { conversation: { id, messages, transaction }, code: 0 };
}

describe('offerFromConversation', () => {
  test('conv 24027793606 : mon offre en attente, prix et date du message', () => {
    const result = offerFromConversation(conversation([offerRequest()]), ME);

    assert.ok(result);
    assert.deepEqual(result.itemIds, ['9488279818']);
    assert.equal(result.conversationId, '24027793606');
    assert.deepEqual(result.offer, {
      by: 'me',
      price: 399,
      // La date d'envoi de l'offre, pas celle du scan : le titre « Rappel : tu as
      // fait une offre » est un libellé d'affichage, pas un nouvel événement.
      at: at('2026-07-29T19:58:42+02:00'),
      status: 'pending',
      conversationId: '24027793606',
    });
  });

  test('les quatre codes de statut connus', () => {
    const cases: [number, string][] = [
      [10, 'pending'],
      [20, 'accepted'],
      [30, 'rejected'],
      [40, 'cancelled'],
    ];

    for (const [code, expected] of cases) {
      const result = offerFromConversation(conversation([offerRequest({ status: code })]), ME);
      assert.equal(result?.offer.status, expected, `statut ${code}`);
    }
  });

  test('un code de statut inconnu ne produit aucune offre', () => {
    // Mieux vaut une ligne muette qu'un badge affirmant un état qu'on ne
    // comprend pas : Vinted peut en ajouter sans prévenir.
    const result = offerFromConversation(conversation([offerRequest({ status: 55 })]), ME);
    assert.equal(result, null);
  });

  test('conv 23997676955 : une conversation où je vends est ignorée', () => {
    const vente = conversation(
      [offerRequest({ userId: 35422672, status: 40, price: '55.0' })],
      buying({ current_user_side: 'seller', buyer_id: 35422672, seller_id: 77742929 })
    );

    assert.equal(offerFromConversation(vente, ME), null);
  });

  test('sans current_user_side, buyer_id départage les deux côtés', () => {
    const sansCote = buying({ current_user_side: undefined });
    assert.ok(offerFromConversation(conversation([offerRequest()], sansCote), ME));

    const vente = buying({ current_user_side: undefined, buyer_id: 35422672 });
    assert.equal(offerFromConversation(conversation([offerRequest()], vente), ME), null);
  });

  test('conv 19169160459 : item_id null, item_ids fait foi', () => {
    // Toutes les conversations d'avant avril 2026 sont dans ce cas.
    const ancienne = buying({ item_id: null, item_ids: [7387980053] });
    const result = offerFromConversation(conversation([offerRequest()], ancienne), ME);

    assert.deepEqual(result?.itemIds, ['7387980053']);
  });

  test('conv 8050387231 : un lot marque chacun de ses articles', () => {
    const lot = buying({
      is_bundle: true,
      item_id: null,
      item_ids: [2403931160, 3098952636, 3098995891],
    });
    const result = offerFromConversation(conversation([offerRequest()], lot), ME);

    assert.deepEqual(result?.itemIds, ['2403931160', '3098952636', '3098995891']);
  });

  test('conv 23962713612 : la dernière de mes offres gagne, `current: false` est écartée', () => {
    const result = offerFromConversation(
      conversation([
        offerRequest({
          status: 40,
          price: '45.0',
          ts: '2026-07-26T18:24:34+02:00',
          current: false,
        }),
        offerRequest({ status: 30, price: '48.0', ts: '2026-07-26T18:26:33+02:00' }),
      ]),
      ME
    );

    assert.equal(result?.offer.price, 48);
    assert.equal(result?.offer.status, 'rejected');
  });

  test('conv 23962918496 : la contre-offre du vendeur, plus récente, décrit l’état courant', () => {
    const result = offerFromConversation(
      conversation([
        offerRequest({ status: 30, price: '150.0', ts: '2026-07-26T18:33:37+02:00' }),
        sellerOffer({ price: '205.0', ts: '2026-07-26T18:34:28+02:00' }),
      ]),
      ME
    );

    assert.equal(result?.offer.by, 'seller');
    assert.equal(result?.offer.price, 205);
    // L'entité n'a pas de statut : il vient de la transaction, ouverte ici.
    assert.equal(result?.offer.status, 'pending');
  });

  test('une proposition du vendeur sur une transaction close est éteinte', () => {
    const close = buying({ status: 500, item_is_closed: true });
    const result = offerFromConversation(conversation([sellerOffer()], close), ME);

    assert.equal(result?.offer.by, 'seller');
    assert.equal(result?.offer.status, 'cancelled');
  });

  test('un article fermé dégrade mon offre en attente', () => {
    // Le vendeur a conclu ailleurs : « en attente » serait un faux espoir.
    const close = buying({ item_is_closed: true });
    const result = offerFromConversation(conversation([offerRequest()], close), ME);

    assert.equal(result?.offer.status, 'cancelled');
  });

  test('les conversations sans offre ne rendent rien', () => {
    const cases: unknown[] = [
      null,
      {},
      { conversation: {} },
      conversation([]),
      // Uniquement des messages système : « Vendu », « Commande envoyée »…
      conversation([{ entity_type: 'status_message', created_at_ts: '2026-07-28T12:10:18+02:00' }]),
      // Une transaction sans article ne peut être rattachée à rien.
      conversation([offerRequest()], buying({ item_id: null, item_ids: [] })),
    ];

    for (const payload of cases) {
      assert.equal(offerFromConversation(payload, ME), null);
    }
  });

  test('un message d’offre incomplet est ignoré, pas deviné', () => {
    const cases = [
      { ...offerRequest(), created_at_ts: undefined },
      { ...offerRequest(), entity: { ...offerRequest().entity, price: undefined } },
      { ...offerRequest(), entity: { ...offerRequest().entity, user_id: undefined } },
    ];

    for (const message of cases) {
      assert.equal(offerFromConversation(conversation([message]), ME), null);
    }
  });
});

describe('parseInboxPage', () => {
  const page = {
    conversations: [
      { id: 24027793606, updated_at: '2026-07-29T19:58:42+02:00' },
      { id: 23997683988, updated_at: '2026-07-28T12:11:44+02:00' },
      // Sans date : inordonnable, donc inutilisable comme borne.
      { id: 23997676955 },
    ],
    pagination: { page: 1, per_page: 20, total_entries: 55, total_pages: 3 },
  };

  test('rend les conversations dans l’ordre servi, du plus récent au plus ancien', () => {
    const { entries, totalPages } = parseInboxPage(page);

    assert.deepEqual(
      entries.map((entry) => entry.id),
      ['24027793606', '23997683988']
    );
    assert.equal(entries[0]?.updatedAt, at('2026-07-29T19:58:42+02:00'));
    assert.equal(totalPages, 3);
  });

  test('une pagination absente vaut une page unique', () => {
    assert.equal(parseInboxPage({ conversations: [] }).totalPages, 1);
    assert.deepEqual(parseInboxPage(null), { entries: [], totalPages: 1 });
  });
});

describe('parseCurrentUserId', () => {
  test('lit user.id, et rien d’autre', () => {
    assert.equal(parseCurrentUserId({ user: { id: 77742929, login: 'julien' } }), '77742929');
    assert.equal(parseCurrentUserId({ user: {} }), null);
    assert.equal(parseCurrentUserId({}), null);
    assert.equal(parseCurrentUserId(null), null);
  });
});

describe('affichage', () => {
  test('isLiveOffer : en attente, et sur un article encore vivant', () => {
    const offer = { by: 'me', price: 10, at: 0, status: 'pending', conversationId: '1' } as const;

    assert.equal(isLiveOffer({ offer }), true);
    assert.equal(isLiveOffer({ offer, status: 'sold' }), false);
    assert.equal(isLiveOffer({ offer: { ...offer, status: 'rejected' } }), false);
    assert.equal(isLiveOffer({}), false);
  });

  test('offerLabel distingue les deux côtés et les états éteints', () => {
    const base = { price: 10, at: 0, conversationId: '1' } as const;

    assert.equal(offerLabel({ ...base, by: 'me', status: 'pending' }), 'Offre');
    assert.equal(offerLabel({ ...base, by: 'seller', status: 'pending' }), 'Vendeur');
    assert.equal(offerLabel({ ...base, by: 'me', status: 'rejected' }), 'Offre refusée');
    assert.equal(offerLabel({ ...base, by: 'seller', status: 'accepted' }), 'Offre acceptée');
    assert.equal(offerLabel({ ...base, by: 'me', status: 'cancelled' }), 'Offre annulée');
  });
});
