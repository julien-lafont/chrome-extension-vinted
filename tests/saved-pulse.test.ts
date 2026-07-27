/**
 * L'icône de la barre d'outils confirme l'enregistrement.
 *
 * Le point sensible n'est pas l'animation — invisible en test, Node n'ayant pas
 * `OffscreenCanvas` — mais **ce qui la déclenche**. Un clic sur une carte de
 * catalogue écrit deux fois dans le storage : l'article en attente, puis la
 * fiche complétée. Réagir à toute écriture ferait clignoter l'icône une seconde
 * fois sans qu'il ne se soit rien passé, et sur un retrait par-dessus le marché.
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  BADGE_MS,
  countAdded,
  pulseSaved,
  watchSavedItems,
} from '../src/background/saved-pulse.ts';
import { installFakeChrome, uninstallFakeChrome } from './fake-chrome.ts';
import { makeItem } from './factories.ts';

/** Laisse se vider la file des microtâches (les promesses déjà résolues du faux chrome). */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('ce qui déclenche l effet', () => {
  test('un article apparu compte', () => {
    assert.equal(countAdded({ oldValue: {}, newValue: { a: 1 } }), 1);
  });

  test('le tout premier enregistrement compte, sans ancienne valeur', () => {
    assert.equal(countAdded({ newValue: { a: 1 } }), 1);
  });

  test('deux articles apparus comptent pour deux', () => {
    assert.equal(countAdded({ oldValue: {}, newValue: { a: 1, b: 2 } }), 2);
  });

  test('seul le nouvel article compte quand un ancien est déjà là', () => {
    assert.equal(countAdded({ oldValue: { a: 1 }, newValue: { a: 1, b: 2 } }), 1);
  });

  test("l'enrichissement de la fiche ne compte pas", () => {
    const change = {
      oldValue: { a: { id: 'a', pending: true } },
      newValue: { a: { id: 'a', title: 'Jean' } },
    };
    assert.equal(countAdded(change), 0);
  });

  test('un retrait ne compte pas', () => {
    assert.equal(countAdded({ oldValue: { a: 1, b: 2 }, newValue: { a: 1 } }), 0);
  });

  test('une autre clé du storage ne compte pas', () => {
    assert.equal(countAdded(undefined), 0);
  });
});

describe('badge', () => {
  beforeEach(() => {
    uninstallFakeChrome();
  });

  afterEach(() => {
    uninstallFakeChrome();
  });

  test("s'affiche puis s'efface tout seul", async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { action } = installFakeChrome();

    const done = pulseSaved(1);
    await flush();

    assert.deepEqual(action.badgeText, ['✓'], 'le badge doit être posé sans attendre');

    t.mock.timers.tick(BADGE_MS);
    await done;

    assert.deepEqual(action.badgeText, ['✓', ''], 'le badge doit finir par disparaître');
    assert.equal(action.badgeColors.length, 1);
  });

  test('deux articles enregistrés en même temps donnent « +2 »', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { action } = installFakeChrome();

    const done = pulseSaved(2);
    await flush();
    t.mock.timers.tick(BADGE_MS);
    await done;

    assert.equal(action.badgeText[0], '+2');
  });

  test('une seconde sauvegarde prolonge le badge au lieu de le couper', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { action } = installFakeChrome();

    const first = pulseSaved(1);
    await flush();

    // Un second article, une demi-seconde plus tard : les deux échéances sont
    // décalées d'autant.
    t.mock.timers.tick(500);
    const second = pulseSaved(1);
    await flush();

    // La première arrive à échéance : elle ne doit pas effacer le badge que la
    // seconde vient de poser.
    t.mock.timers.tick(BADGE_MS - 500);
    await first;
    assert.deepEqual(action.badgeText, ['✓', '✓'], 'le badge de la seconde a été effacé trop tôt');

    t.mock.timers.tick(500);
    await second;
    assert.deepEqual(action.badgeText, ['✓', '✓', '']);
  });
});

describe('branchement sur le storage', () => {
  beforeEach(() => {
    uninstallFakeChrome();
  });

  afterEach(() => {
    uninstallFakeChrome();
  });

  test('enregistrer un article depuis un onglet Vinted allume le badge', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { action } = installFakeChrome({ savedItems: {} }, { notify: true });
    watchSavedItems();

    const item = makeItem({ id: '42' });
    await chrome.storage.local.set({ savedItems: { [item.id]: item } });
    await flush();

    assert.deepEqual(action.badgeText, ['✓']);

    t.mock.timers.tick(BADGE_MS);
    await flush();
  });

  test("modifier un article déjà enregistré n'allume rien", async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const item = makeItem({ id: '42', pending: true });
    const { action } = installFakeChrome({ savedItems: { [item.id]: item } }, { notify: true });
    watchSavedItems();

    await chrome.storage.local.set({ savedItems: { [item.id]: { ...item, pending: false } } });
    await flush();

    assert.deepEqual(action.badgeText, []);
  });
});
