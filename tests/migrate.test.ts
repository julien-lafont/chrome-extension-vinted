/**
 * Mise à niveau du storage vers le modèle « Mes favoris récapitule tout ».
 *
 * Ce que ces tests protègent avant tout, c'est le fait que **la migration ne
 * soit pas nécessaire pour lire** : un storage resté en version 1 doit afficher
 * exactement la même chose qu'un storage migré. Une migration dont dépendrait
 * l'affichage transformerait le moindre échec d'écriture en extension cassée.
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { SCHEMA_VERSION, migrateStorage } from '../src/shared/migrate.ts';
import { DEFAULT_COLLECTION_ID, classifiedIn, readAll } from '../src/sidepanel/store.ts';
import { makeItem } from './factories.ts';
import { installFakeChrome, uninstallFakeChrome } from './fake-chrome.ts';
import type { CollectionMap, ItemMap, Settings } from '../src/shared/types.ts';

/** Un storage tel que l'écrivaient les versions où « Mes favoris » était une collection. */
const legacy = () => ({
  savedItems: {
    1: makeItem({ id: '1', collectionId: DEFAULT_COLLECTION_ID }),
    2: makeItem({ id: '2', collectionId: 'col-jeans' }),
    3: makeItem({ id: '3', collectionId: 'col-supprimee' }),
    4: makeItem({ id: '4' }),
  },
  collections: {
    [DEFAULT_COLLECTION_ID]: {
      id: DEFAULT_COLLECTION_ID,
      name: 'Mes favoris',
      createdAt: 0,
      order: ['4', '1'],
    },
    'col-jeans': { id: 'col-jeans', name: 'Jeans', createdAt: 1, order: ['2'] },
  },
  settings: { activeCollectionId: DEFAULT_COLLECTION_ID },
});

describe('migration du modèle de collections', () => {
  beforeEach(() => {
    uninstallFakeChrome();
  });

  test('un storage hérité s’affiche correctement AVANT toute migration', async () => {
    installFakeChrome(legacy());

    const { items, collections } = await readAll();
    const byId = new Map(items.map((item) => [item.id, item]));

    assert.equal(classifiedIn(byId.get('1')!, collections), null, '« default » = non classé');
    assert.equal(classifiedIn(byId.get('2')!, collections)?.id, 'col-jeans');
    assert.equal(classifiedIn(byId.get('3')!, collections), null, 'référence morte = non classé');
    assert.equal(classifiedIn(byId.get('4')!, collections), null);
  });

  test('elle efface les collectionId qui ne veulent plus rien dire', async () => {
    const fake = installFakeChrome(legacy());

    const cleaned = await migrateStorage();

    assert.equal(cleaned, 2, '« default » et la référence morte, pas les deux autres');

    const items = fake.db.savedItems as ItemMap;
    assert.equal(items['1']?.collectionId, undefined);
    assert.equal(items['2']?.collectionId, 'col-jeans', 'un classement réel est conservé');
    assert.equal(items['3']?.collectionId, undefined);
    assert.equal(items['4']?.collectionId, undefined);
  });

  test("l'ordre manuel de « Mes favoris » survit — c'est celui de la vue globale", async () => {
    const fake = installFakeChrome(legacy());

    await migrateStorage();

    const collections = fake.db.collections as CollectionMap;
    assert.deepEqual(collections[DEFAULT_COLLECTION_ID]?.order, ['4', '1']);
    assert.deepEqual(collections['col-jeans']?.order, ['2']);
  });

  test('elle est idempotente : deux passages ne changent rien de plus', async () => {
    const fake = installFakeChrome(legacy());

    assert.equal(await migrateStorage(), 2);
    const after = structuredClone(fake.db.savedItems);

    assert.equal(await migrateStorage(), 0, 'la version enregistrée coupe court');
    assert.deepEqual(fake.db.savedItems, after);
    assert.equal((fake.db.settings as Settings).schemaVersion, SCHEMA_VERSION);
  });

  test('sur un storage vide, elle ne fait que poser la version', async () => {
    const fake = installFakeChrome();

    assert.equal(await migrateStorage(), 0);
    assert.equal((fake.db.settings as Settings).schemaVersion, SCHEMA_VERSION);
    assert.equal(fake.db.savedItems, undefined, 'aucune clé inventée');
  });

  test('les autres réglages sont conservés', async () => {
    const fake = installFakeChrome({
      settings: { activeCollectionId: 'col-jeans', sortMode: 'price', hideSold: true },
    });

    await migrateStorage();

    const settings = fake.db.settings as Settings;
    assert.equal(settings.activeCollectionId, 'col-jeans');
    assert.equal(settings.sortMode, 'price');
    assert.equal(settings.hideSold, true);
  });
});
