/**
 * Deux écritures lancées en même temps ne doivent pas s'écraser l'une l'autre.
 *
 * Le scénario est celui du content script : la file d'enrichissement termine une
 * fiche pendant que l'utilisateur enregistre un article. Les deux relisent
 * `savedItems`, les deux le réécrivent — et sans sérialisation, la seconde
 * écriture part d'un état lu **avant** la première et l'efface, sans erreur en
 * console.
 *
 * Le faux storage tourne ici avec une latence : c'est elle qui rend
 * l'entrelacement déterministe plutôt que dépendant de l'ordonnancement des
 * micro-tâches. Neutraliser la file d'attente de `shared/storage.ts` (remplacer
 * le `queue.then(…)` d'`update()` par un lire-transformer-écrire direct) fait
 * tomber trois de ces six cas — la garantie est bien celle-là, et pas un
 * artefact du faux storage.
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { ITEMS_KEY, read, update } from '../src/shared/storage.ts';
import type { ItemMap } from '../src/shared/types.ts';
import { makeItem } from './factories.ts';
import { installFakeChrome, uninstallFakeChrome, type FakeChrome } from './fake-chrome.ts';

const items = (fake: FakeChrome): ItemMap => (fake.db[ITEMS_KEY] || {}) as ItemMap;

describe('écritures concurrentes du storage', () => {
  let fake: FakeChrome;

  beforeEach(() => {
    fake = installFakeChrome({ [ITEMS_KEY]: { a: makeItem({ id: 'a' }) } }, { latency: 5 });
  });

  afterEach(() => {
    uninstallFakeChrome();
  });

  test('deux ajouts simultanés se retrouvent tous les deux en storage', async () => {
    const add = (id: string): Promise<unknown> =>
      update([ITEMS_KEY], (current) => ({
        [ITEMS_KEY]: { ...(current[ITEMS_KEY] || {}), [id]: makeItem({ id }) },
      }));

    // Lancés sans `await` intermédiaire : c'est exactement ce que fait le content
    // script quand un clic tombe pendant que la file d'enrichissement écrit.
    await Promise.all([add('b'), add('c')]);

    assert.deepEqual(Object.keys(items(fake)).sort(), ['a', 'b', 'c']);
  });

  test('un retrait concurrent d un ajout ne ressuscite pas l article retiré', async () => {
    const remove = update([ITEMS_KEY], (current) => {
      const next = { ...(current[ITEMS_KEY] || {}) };
      delete next.a;
      return { [ITEMS_KEY]: next };
    });

    const add = update([ITEMS_KEY], (current) => ({
      [ITEMS_KEY]: { ...(current[ITEMS_KEY] || {}), b: makeItem({ id: 'b' }) },
    }));

    await Promise.all([remove, add]);

    assert.deepEqual(Object.keys(items(fake)), ['b']);
  });

  test('les mutations voient l état écrit par celle qui précède', async () => {
    const seen: string[][] = [];

    const append = (id: string): Promise<unknown> =>
      update([ITEMS_KEY], (current) => {
        const map = current[ITEMS_KEY] || {};
        seen.push(Object.keys(map).sort());
        return { [ITEMS_KEY]: { ...map, [id]: makeItem({ id }) } };
      });

    await Promise.all([append('b'), append('c')]);

    // La file étant FIFO, la seconde mutation lit ce que la première a écrit.
    assert.deepEqual(seen, [['a'], ['a', 'b']]);
  });

  test('rendre null renonce à l écriture sans bloquer la file', async () => {
    const skipped = await update([ITEMS_KEY], () => null);
    assert.deepEqual(Object.keys(skipped[ITEMS_KEY] || {}), ['a']);

    await update([ITEMS_KEY], (current) => ({
      [ITEMS_KEY]: { ...(current[ITEMS_KEY] || {}), b: makeItem({ id: 'b' }) },
    }));

    assert.deepEqual(Object.keys(items(fake)).sort(), ['a', 'b']);
  });

  test('une mutation qui lève ne retient pas les suivantes', async () => {
    const failing = update([ITEMS_KEY], () => {
      throw new Error('mutation fautive');
    });

    await assert.rejects(failing, /mutation fautive/);

    await update([ITEMS_KEY], (current) => ({
      [ITEMS_KEY]: { ...(current[ITEMS_KEY] || {}), b: makeItem({ id: 'b' }) },
    }));

    assert.deepEqual(Object.keys(items(fake)).sort(), ['a', 'b']);
  });

  test('seules les clés rendues par la mutation sont écrites', async () => {
    fake.db.collections = {
      default: { id: 'default', name: 'Mes favoris', createdAt: 0, order: [] },
    };

    await update([ITEMS_KEY, 'collections'], (current) => ({
      [ITEMS_KEY]: { ...(current[ITEMS_KEY] || {}), b: makeItem({ id: 'b' }) },
    }));

    const after = await read('collections');
    assert.deepEqual(Object.keys(after.collections || {}), ['default']);
  });
});
