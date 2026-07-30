/**
 * Cycle de vérification (`VF_WATCH_START`), sur des fiches authentiques — voir
 * docs/specs/suivi-prix.md §4 et §8.
 *
 * Les cas qui comptent : un badge « Vendu » réel marque l'article sans le
 * supprimer, une fiche qui ne correspond pas à l'id demandé (garde-fou déjà
 * présent dans `enrichFromDetail()`) ne touche à rien, et une réponse illisible
 * ne freine le cycle que si elle se répète — §3.5.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadContentScript, settle, settleFetches, meta, SOLD_ITEM_ID } from './harness.ts';
import { makeItem } from './factories.ts';

after(settleFetches);

describe('badge « Vendu »', () => {
  test('marque status sold sans supprimer l’article', async () => {
    const before = makeItem({ id: SOLD_ITEM_ID, url: meta.soldUrl });
    const page = await loadContentScript('sold', { saved: { [SOLD_ITEM_ID]: before } });

    const response = await page.startWatch([SOLD_ITEM_ID]);
    assert.equal(response.accepted, true, 'le cycle doit être accepté');

    await settle(50);
    await page.respondWithFixture('sold');

    const saved = page.store.savedItems as Record<
      string,
      { status?: string; lastCheckedAt?: number }
    >;
    assert.ok(saved[SOLD_ITEM_ID], "l'article ne doit pas être supprimé");
    assert.equal(saved[SOLD_ITEM_ID]?.status, 'sold');
    assert.equal(typeof saved[SOLD_ITEM_ID]?.lastCheckedAt, 'number');
  });
});

describe('garde-fou id divergent', () => {
  test('une fiche qui décrit un autre article ne touche à rien', async () => {
    // La fiche `item` fixture décrit un article réel, différent de celui
    // qu'on prétend suivre : exactement le scénario d'un article fusionné ou
    // retiré que Vinted redirige ailleurs.
    const before = makeItem({ id: 'fake-999', url: meta.itemUrl });
    const page = await loadContentScript('item', { saved: { 'fake-999': before } });

    const response = await page.startWatch(['fake-999']);
    assert.equal(response.accepted, true);

    await settle(50);
    await page.respondWithFixture('item');

    const saved = page.store.savedItems as Record<string, unknown>;
    assert.deepEqual(saved['fake-999'], before, "l'article ne doit pas être modifié");
  });
});

/**
 * Réponse sans aucune ancre : ni prix, ni titre, ni JSON-LD. C'est ce que
 * renvoie la page d'un article dont Vinted ne sert plus les informations —
 * elle affiche brièvement la fiche puis renvoie vers le dressing du vendeur,
 * côté client. Un challenge Cloudflare a exactement la même allure.
 */
const ANCHORLESS = '<html><body><div>Redirection…</div></body></html>';

type Page = Awaited<ReturnType<typeof loadContentScript>>;

const respondAnchorless = (page: Page) =>
  page.respond({ ok: true, status: 200, text: () => Promise.resolve(ANCHORLESS) });

/** Attend la requête suivante du cycle, séparée de la précédente par §3.3. */
async function waitForFetch(page: Page, tries = 30) {
  for (let i = 0; i < tries; i += 1) {
    const [pending] = page.pendingFetches();
    if (pending) return pending;
    await settle(100);
  }
  return null;
}

/**
 * Cycle démarré sur deux articles, source d'aléa figée : la cadence irrégulière
 * de §3.3 tire un délai log-normal et, une fois sur cent, une pause de 10 à
 * 30 s — sans quoi ce test attendrait parfois la deuxième requête plus
 * longtemps que son propre budget.
 */
async function loadTwoItemCycle(): Promise<Page> {
  const page = await loadContentScript('item', {
    saved: {
      // Deux URL bien distinctes : `soldUrl` est le même article que `itemUrl`,
      // et l'on doit pouvoir dire lequel des deux le cycle a interrogé d'abord
      // — l'ordre de la file est mélangé (§3.4).
      a: makeItem({ id: 'a', url: meta.itemUrl }),
      b: makeItem({ id: 'b', url: meta.photosUrl }),
    },
  });
  page.window.Math.random = () => 0.5;

  assert.equal((await page.startWatch(['a', 'b'])).accepted, true);
  await settle(50);
  return page;
}

describe('réponse illisible', () => {
  test('un seul article illisible est passé, le cycle continue', async () => {
    const page = await loadTwoItemCycle();

    const first = await respondAnchorless(page);
    const skipped = first.url === meta.photosUrl ? 'b' : 'a';

    assert.ok(
      await waitForFetch(page),
      'le second article doit être interrogé : un article illisible ne freine pas le cycle'
    );
    assert.equal(
      page.watchState().throttledUntil,
      undefined,
      'aucune fenêtre de silence ne doit être posée pour un seul article illisible'
    );

    const saved = page.store.savedItems as Record<
      string,
      { lastCheckedAt?: number; status?: string; missCount?: number }
    >;
    assert.equal(typeof saved[skipped]?.lastCheckedAt, 'number', 'il a bien été interrogé');
    assert.equal(saved[skipped]?.status, undefined, 'rien ne permet de le dire disparu');
    assert.equal(saved[skipped]?.missCount, undefined, 'aucune absence ne lui est comptée');
  });

  test('deux illisibles d’affilée freinent le cycle', async () => {
    const page = await loadTwoItemCycle();

    await respondAnchorless(page);
    assert.ok(await waitForFetch(page), 'le cycle doit être allé jusqu’au second article');
    await respondAnchorless(page);

    // Un challenge ne frappe jamais un seul article : c'est la répétition qui
    // le distingue d'une fiche momentanément indisponible.
    assert.ok(
      page.watchState().throttledUntil > Date.now(),
      'la deuxième réponse illisible doit poser la fenêtre de silence'
    );
    assert.equal(page.pendingFetches().length, 0, 'le cycle doit s’être arrêté');
  });
});
