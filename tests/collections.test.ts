/**
 * Une collection ne se supprime que si elle est vide.
 *
 * La règle vit dans le storage, pas seulement dans l'affichage : le bouton est
 * rendu à partir d'un état qui peut dater d'avant qu'un autre onglet Vinted y
 * classe un article. Supprimer alors la collection déplacerait ces articles à
 * l'insu de l'utilisateur.
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_COLLECTION_ID,
  readAll,
  createCollection,
  deleteCollection,
  moveItemToCollection,
  collectionOf,
} from '../src/sidepanel/store.ts';
import type { SavedItem } from '../src/shared/types.ts';
import { makeItem } from './factories.ts';
import { installFakeChrome, uninstallFakeChrome, type FakeStore } from './fake-chrome.ts';

const fakeStorage = (initial: FakeStore = {}): void => {
  installFakeChrome(initial);
};

/** Premier article enregistré, dont les tests vérifient qu'il n'a pas bougé. */
function firstItem(items: SavedItem[]): SavedItem {
  const item = items[0];
  assert.ok(item, 'aucun article enregistré');
  return item;
}

describe('suppression d une collection', () => {
  beforeEach(() => {
    uninstallFakeChrome();
  });

  test('une collection vide disparaît', async () => {
    fakeStorage();
    const jeans = await createCollection('Jeans');

    const res = await deleteCollection(jeans.id);

    assert.deepEqual(res, { ok: true });
    const { collections } = await readAll();
    assert.deepEqual(Object.keys(collections), [DEFAULT_COLLECTION_ID]);
  });

  test('une collection habitée est refusée, et ses articles ne bougent pas', async () => {
    fakeStorage({ savedItems: { 1: makeItem({ id: '1' }) } });
    const jeans = await createCollection('Jeans');
    await moveItemToCollection('1', jeans.id);

    const res = await deleteCollection(jeans.id);

    assert.deepEqual(res, { ok: false, reason: 'not-empty' });

    const { items, collections } = await readAll();
    assert.ok(collections[jeans.id], 'la collection doit survivre');
    assert.equal(
      collectionOf(firstItem(items), collections),
      jeans.id,
      "l'article ne doit pas être déplacé"
    );
  });

  test('la collection par défaut ne se supprime jamais, même vide', async () => {
    fakeStorage();
    await readAll(); // matérialise la collection par défaut

    const res = await deleteCollection(DEFAULT_COLLECTION_ID);

    assert.deepEqual(res, { ok: false, reason: 'default' });
    const { collections } = await readAll();
    assert.ok(collections[DEFAULT_COLLECTION_ID]);
  });

  test('une collection vidée redevient supprimable', async () => {
    fakeStorage({ savedItems: { 1: makeItem({ id: '1' }) } });
    const jeans = await createCollection('Jeans');
    await moveItemToCollection('1', jeans.id);

    assert.deepEqual(await deleteCollection(jeans.id), { ok: false, reason: 'not-empty' });

    // L'article repart ailleurs : la collection est de nouveau vide.
    await moveItemToCollection('1', DEFAULT_COLLECTION_ID);
    assert.deepEqual(await deleteCollection(jeans.id), { ok: true });

    const { items, collections } = await readAll();
    assert.ok(!collections[jeans.id]);
    assert.equal(
      collectionOf(firstItem(items), collections),
      DEFAULT_COLLECTION_ID,
      "l'article est conservé"
    );
  });

  test('supprimer une collection inconnue ne casse rien', async () => {
    fakeStorage();
    const res = await deleteCollection('col-inexistante');

    assert.deepEqual(res, { ok: false, reason: 'unknown' });
  });

  test('les autres collections sont intactes après une suppression', async () => {
    fakeStorage();
    const jeans = await createCollection('Jeans');
    const cadeaux = await createCollection('Cadeau Julien');

    await deleteCollection(jeans.id);

    const { collections } = await readAll();
    assert.equal(collections[cadeaux.id]?.name, 'Cadeau Julien');
    assert.ok(collections[DEFAULT_COLLECTION_ID]);
  });
});
