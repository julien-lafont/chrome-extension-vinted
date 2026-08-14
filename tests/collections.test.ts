/**
 * Suppression d'une collection, et place d'« Archives ».
 *
 * La règle a changé avec le récapitulatif : une collection se supprime **même
 * pleine**, parce que ses articles ne sont plus perdus — ils restent dans « Mes
 * favoris », simplement déclassés. Ce que ces tests éprouvent, c'est justement
 * qu'aucun article ne disparaît, et qu'aucune référence morte ne subsiste.
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  ARCHIVE_COLLECTION_ID,
  DEFAULT_COLLECTION_ID,
  archiveSold,
  sortCollections,
  readAll,
  createCollection,
  deleteCollection,
  moveItemToCollection,
  classifiedIn,
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

    assert.deepEqual(res, { ok: true, freed: 0 });
    const { collections } = await readAll();
    assert.deepEqual(Object.keys(collections), [DEFAULT_COLLECTION_ID]);
  });

  test('une collection habitée se supprime, et ses articles restent dans les favoris', async () => {
    fakeStorage({ savedItems: { 1: makeItem({ id: '1' }) } });
    const jeans = await createCollection('Jeans');
    await moveItemToCollection('1', jeans.id);

    const res = await deleteCollection(jeans.id);

    assert.deepEqual(res, { ok: true, freed: 1 });

    const { items, collections } = await readAll();
    assert.ok(!collections[jeans.id], 'la collection doit disparaître');
    assert.equal(items.length, 1, "l'article est conservé");
    assert.equal(
      classifiedIn(firstItem(items), collections),
      null,
      "l'article n'est plus classé nulle part"
    );
    assert.equal(
      firstItem(items).collectionId,
      undefined,
      'le champ est effacé, pas laissé sur une référence morte'
    );
  });

  test('la collection par défaut ne se supprime jamais : ce n’est plus une collection', async () => {
    fakeStorage();
    await readAll(); // matérialise la collection par défaut

    const res = await deleteCollection(DEFAULT_COLLECTION_ID);

    assert.deepEqual(res, { ok: false, reason: 'default' });
    const { collections } = await readAll();
    assert.ok(collections[DEFAULT_COLLECTION_ID]);
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

  test('seuls les articles de la collection supprimée sont déclassés', async () => {
    fakeStorage({
      savedItems: { 1: makeItem({ id: '1' }), 2: makeItem({ id: '2' }) },
    });
    const jeans = await createCollection('Jeans');
    const vestes = await createCollection('Vestes');
    await moveItemToCollection('1', jeans.id);
    await moveItemToCollection('2', vestes.id);

    assert.deepEqual(await deleteCollection(jeans.id), { ok: true, freed: 1 });

    const { items, collections } = await readAll();
    const byId = new Map(items.map((item) => [item.id, item]));
    assert.equal(classifiedIn(byId.get('1') as SavedItem, collections), null);
    assert.equal(classifiedIn(byId.get('2') as SavedItem, collections)?.id, vestes.id);
  });
});

/**
 * « Archives » n'est pas une collection parmi d'autres : c'est le dépôt de ce
 * qui est vendu ou parti. Sa place dans la barre d'onglets ne doit pas dépendre
 * de sa date de création — qui est celle du premier archivage, donc postérieure
 * à la plupart des collections mais antérieure à toutes celles créées ensuite.
 */
describe('place d’« Archives »', () => {
  test('elle passe toujours en dernier, quelle que soit sa date', async () => {
    fakeStorage({ savedItems: { 1: makeItem({ id: '1', status: 'sold' }) } });
    const vestes = await createCollection('Vestes');
    await moveItemToCollection('1', vestes.id);

    // Archivage : « Archives » naît ici, donc après « Vestes » mais avant la
    // collection créée juste en dessous.
    await archiveSold(vestes.id);

    const bottes = await createCollection('Bottes');

    const { collections } = await readAll();
    const order = sortCollections(collections).map((c) => c.id);

    assert.equal(order[0], DEFAULT_COLLECTION_ID, 'la collection par défaut reste en tête');
    assert.equal(order.at(-1), ARCHIVE_COLLECTION_ID, '« Archives » doit fermer la marche');
    assert.ok(
      order.indexOf(bottes.id) < order.indexOf(ARCHIVE_COLLECTION_ID),
      'une collection créée après l’archivage passe quand même avant « Archives »'
    );
  });
});
