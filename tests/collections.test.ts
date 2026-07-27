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
} from '../src/sidepanel/store.js';

/** chrome.storage.local en mémoire, avec la sérialisation du vrai. */
function fakeStorage(initial = {}) {
  const db = structuredClone(initial);

  globalThis.chrome = {
    storage: {
      local: {
        async get(keys) {
          const list = Array.isArray(keys) ? keys : [keys];
          const out = {};
          for (const k of list) if (k in db) out[k] = structuredClone(db[k]);
          return out;
        },
        async set(obj) {
          Object.assign(db, structuredClone(obj));
        },
      },
      onChanged: { addListener() {} },
    },
  };

  return db;
}

const ITEM = (id, collectionId) => ({ id, title: `Article ${id}`, savedAt: Number(id), collectionId });

describe('suppression d une collection', () => {
  beforeEach(() => {
    delete globalThis.chrome;
  });

  test('une collection vide disparaît', async () => {
    fakeStorage();
    const jeans = await createCollection('Jeans');

    const res = await deleteCollection(jeans.id);

    assert.equal(res.ok, true);
    const { collections } = await readAll();
    assert.deepEqual(Object.keys(collections), [DEFAULT_COLLECTION_ID]);
  });

  test('une collection habitée est refusée, et ses articles ne bougent pas', async () => {
    fakeStorage({ savedItems: { 1: ITEM('1') } });
    const jeans = await createCollection('Jeans');
    await moveItemToCollection('1', jeans.id);

    const res = await deleteCollection(jeans.id);

    assert.equal(res.ok, false);
    assert.equal(res.reason, 'not-empty');

    const { items, collections } = await readAll();
    assert.ok(collections[jeans.id], 'la collection doit survivre');
    assert.equal(collectionOf(items[0], collections), jeans.id, "l'article ne doit pas être déplacé");
  });

  test('la collection par défaut ne se supprime jamais, même vide', async () => {
    fakeStorage();
    await readAll(); // matérialise la collection par défaut

    const res = await deleteCollection(DEFAULT_COLLECTION_ID);

    assert.equal(res.ok, false);
    assert.equal(res.reason, 'default');
    const { collections } = await readAll();
    assert.ok(collections[DEFAULT_COLLECTION_ID]);
  });

  test('une collection vidée redevient supprimable', async () => {
    fakeStorage({ savedItems: { 1: ITEM('1') } });
    const jeans = await createCollection('Jeans');
    await moveItemToCollection('1', jeans.id);

    assert.equal((await deleteCollection(jeans.id)).reason, 'not-empty');

    // L'article repart ailleurs : la collection est de nouveau vide.
    await moveItemToCollection('1', DEFAULT_COLLECTION_ID);
    assert.equal((await deleteCollection(jeans.id)).ok, true);

    const { items, collections } = await readAll();
    assert.ok(!collections[jeans.id]);
    assert.equal(collectionOf(items[0], collections), DEFAULT_COLLECTION_ID, "l'article est conservé");
  });

  test('supprimer une collection inconnue ne casse rien', async () => {
    fakeStorage();
    const res = await deleteCollection('col-inexistante');

    assert.equal(res.ok, false);
    assert.equal(res.reason, 'unknown');
  });

  test('les autres collections sont intactes après une suppression', async () => {
    fakeStorage();
    const jeans = await createCollection('Jeans');
    const cadeaux = await createCollection('Cadeau Julien');

    await deleteCollection(jeans.id);

    const { collections } = await readAll();
    assert.equal(collections[cadeaux.id].name, 'Cadeau Julien');
    assert.ok(collections[DEFAULT_COLLECTION_ID]);
  });
});
