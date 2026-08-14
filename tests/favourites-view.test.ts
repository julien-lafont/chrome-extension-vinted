/**
 * « Mes favoris » récapitule tout ce qui est enregistré.
 *
 * C'est le changement de modèle le plus lourd de conséquences : ranger un
 * article dans une collection ne le sort plus des favoris, et « non classé »
 * devient un état ordinaire plutôt qu'un défaut. Trois choses s'éprouvent ici,
 * et chacune est un bug silencieux si elle casse :
 *
 *   — la **lecture** (`classifiedIn`, `isInTab`), y compris des trois formes
 *     héritées qui disent « non classé » ;
 *   — l'**ordre global** de la vue, que le rangement ne doit plus toucher ;
 *   — l'**archivage**, seule exception au récapitulatif, et son annulation qui
 *     doit rendre chaque article à sa propre collection.
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  ARCHIVE_COLLECTION_ID,
  DEFAULT_COLLECTION_ID,
  archiveSold,
  classifiedIn,
  commitCustomOrder,
  createCollection,
  isInTab,
  moveItemToCollection,
  readAll,
  restoreArchived,
} from '../src/sidepanel/store.ts';
import { makeItem } from './factories.ts';
import { installFakeChrome, uninstallFakeChrome } from './fake-chrome.ts';
import type { CollectionMap, SavedItem } from '../src/shared/types.ts';

const collections = (extra: CollectionMap = {}): CollectionMap => ({
  [DEFAULT_COLLECTION_ID]: {
    id: DEFAULT_COLLECTION_ID,
    name: 'Mes favoris',
    createdAt: 0,
    order: [],
  },
  ...extra,
});

describe('lecture du classement', () => {
  const jeans = { id: 'col-jeans', name: 'Jeans', createdAt: 1, order: [] };

  test('un article sans collectionId est non classé', () => {
    const map = collections({ [jeans.id]: jeans });
    assert.equal(classifiedIn(makeItem({ id: '1' }), map), null);
  });

  test("l'ancien `collectionId: 'default'` se lit encore comme non classé", () => {
    const map = collections({ [jeans.id]: jeans });
    const item = makeItem({ id: '1', collectionId: DEFAULT_COLLECTION_ID });

    assert.equal(classifiedIn(item, map), null);
    assert.ok(isInTab(item, DEFAULT_COLLECTION_ID, map), 'il reste dans les favoris');
  });

  test('une référence vers une collection supprimée se lit comme non classé', () => {
    const map = collections();
    const item = makeItem({ id: '1', collectionId: 'col-disparue' });

    assert.equal(classifiedIn(item, map), null);
    assert.ok(isInTab(item, DEFAULT_COLLECTION_ID, map));
    assert.ok(!isInTab(item, 'col-disparue', map));
  });

  test('un article classé apparaît dans sa collection ET dans les favoris', () => {
    const map = collections({ [jeans.id]: jeans });
    const item = makeItem({ id: '1', collectionId: jeans.id });

    assert.equal(classifiedIn(item, map)?.name, 'Jeans');
    assert.ok(isInTab(item, jeans.id, map));
    assert.ok(isInTab(item, DEFAULT_COLLECTION_ID, map), 'le récapitulatif le montre aussi');
  });

  test('un article archivé sort des favoris — sinon archiver ne rangerait rien', () => {
    const map = collections({
      [ARCHIVE_COLLECTION_ID]: {
        id: ARCHIVE_COLLECTION_ID,
        name: 'Archives',
        createdAt: 2,
        order: [],
      },
    });
    const item = makeItem({ id: '1', collectionId: ARCHIVE_COLLECTION_ID });

    assert.ok(isInTab(item, ARCHIVE_COLLECTION_ID, map));
    assert.ok(!isInTab(item, DEFAULT_COLLECTION_ID, map));
  });
});

describe('rangement', () => {
  beforeEach(() => {
    uninstallFakeChrome();
  });

  test('ranger un article ne le retire pas de l’ordre global des favoris', async () => {
    installFakeChrome({
      savedItems: {
        1: makeItem({ id: '1' }),
        2: makeItem({ id: '2' }),
        3: makeItem({ id: '3' }),
      },
    });

    // Ordre manuel posé dans « Mes favoris » (glisser-déposer).
    await commitCustomOrder(DEFAULT_COLLECTION_ID, ['3', '1', '2']);

    const jeans = await createCollection('Jeans');
    await moveItemToCollection('1', jeans.id);

    const { collections: map } = await readAll();
    assert.deepEqual(
      map[DEFAULT_COLLECTION_ID]?.order,
      ['3', '1', '2'],
      "l'article classé garde sa place dans la vue globale"
    );
    assert.deepEqual(map[jeans.id]?.order, ['1'], 'et prend la tête de sa collection');
  });

  test('déclasser efface le champ plutôt que d’écrire « default »', async () => {
    installFakeChrome({ savedItems: { 1: makeItem({ id: '1' }) } });
    const jeans = await createCollection('Jeans');
    await moveItemToCollection('1', jeans.id);

    await moveItemToCollection('1', null);

    const { items, collections: map } = await readAll();
    const item = items[0] as SavedItem;
    assert.equal(item.collectionId, undefined);
    assert.deepEqual(map[jeans.id]?.order, [], 'et quitte l’ordre de son ancienne collection');
  });

  test('ranger dans « Mes favoris » déclasse, quel que soit le chemin', async () => {
    installFakeChrome({ savedItems: { 1: makeItem({ id: '1' }) } });
    const jeans = await createCollection('Jeans');
    await moveItemToCollection('1', jeans.id);

    // Le dépôt sur l'onglet « Mes favoris » comme le menu de la page passent par
    // la même primitive, avec l'identifiant de la vue.
    await moveItemToCollection('1', DEFAULT_COLLECTION_ID);

    const { items } = await readAll();
    assert.equal((items[0] as SavedItem).collectionId, undefined);
  });
});

describe('archivage depuis le récapitulatif', () => {
  beforeEach(() => {
    uninstallFakeChrome();
  });

  test('il balaie les vendus de toutes les collections', async () => {
    installFakeChrome({
      savedItems: {
        1: makeItem({ id: '1', status: 'sold' }),
        2: makeItem({ id: '2', status: 'sold' }),
        3: makeItem({ id: '3' }),
      },
    });
    const jeans = await createCollection('Jeans');
    await moveItemToCollection('1', jeans.id);

    const result = await archiveSold(DEFAULT_COLLECTION_ID);

    assert.deepEqual(
      result.moved.map((entry) => entry.id).sort(),
      ['1', '2'],
      'les deux vendus, classés ou non'
    );

    const { items, collections: map } = await readAll();
    for (const item of items) {
      if (item.id === '3') continue;
      assert.equal(classifiedIn(item, map)?.id, ARCHIVE_COLLECTION_ID);
      assert.ok(!isInTab(item, DEFAULT_COLLECTION_ID, map), 'un archivé quitte les favoris');
    }
  });

  test("l'annulation rend chaque article à sa propre collection", async () => {
    installFakeChrome({
      savedItems: {
        1: makeItem({ id: '1', status: 'sold' }),
        2: makeItem({ id: '2', status: 'sold' }),
      },
    });
    const jeans = await createCollection('Jeans');
    await moveItemToCollection('1', jeans.id);

    const result = await archiveSold(DEFAULT_COLLECTION_ID);
    await restoreArchived(result);

    const { items, collections: map } = await readAll();
    const byId = new Map(items.map((item) => [item.id, item]));

    assert.equal(
      classifiedIn(byId.get('1') as SavedItem, map)?.id,
      jeans.id,
      'celui qui était classé retrouve sa collection'
    );
    assert.equal(
      classifiedIn(byId.get('2') as SavedItem, map),
      null,
      "et l'autre reste non classé — pas rangé d'office"
    );
    assert.deepEqual(map[jeans.id]?.order, ['1'], 'il reprend la tête de son ordre');
    assert.deepEqual(map[DEFAULT_COLLECTION_ID]?.order, ['2'], "l'autre celle de la vue globale");
  });

  test('une collection disparue pendant l’annulation ne laisse pas de référence morte', async () => {
    const fake = installFakeChrome({ savedItems: { 1: makeItem({ id: '1', status: 'sold' }) } });
    const jeans = await createCollection('Jeans');
    await moveItemToCollection('1', jeans.id);

    const result = await archiveSold(jeans.id);

    // La collection est supprimée pendant les cinq secondes d'annulation.
    delete (fake.db.collections as CollectionMap)[jeans.id];

    await restoreArchived(result);

    const { items, collections: map } = await readAll();
    const item = items[0] as SavedItem;
    assert.equal(item.collectionId, undefined, "l'article revient non classé");
    assert.ok(isInTab(item, DEFAULT_COLLECTION_ID, map), 'et bien dans les favoris');
  });
});
