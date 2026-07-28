/**
 * Bouton « Débloquer le débit » de la bande de développement.
 *
 * Un backoff de §3.5 se compte en 30 min × 2^n : après trois coups de frein,
 * plus rien n'est vérifiable de la session. La remise à zéro doit lever les
 * quatre garde-fous de débit d'un coup — et surtout ne pas emporter le bail au
 * passage, sous peine de faire tourner deux cycles en parallèle.
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeChrome, uninstallFakeChrome, type FakeChrome } from './fake-chrome.ts';
import { resetRateLimits } from '../src/sidepanel/watch.ts';
import { RATE } from '../src/shared/watch.ts';
import type { WatchState } from '../src/shared/types.ts';

let fake: FakeChrome;
let warn: typeof console.warn;

/** État maximalement bloqué : seau vide, budget consommé, silence en cours. */
function blocked(now: number): WatchState {
  return {
    lastSweepAt: now - 3600_000,
    bucket: { tokens: 0, at: now },
    throttledUntil: now + 2 * 3600_000,
    throttleStrikes: 3,
    dailyBudget: { day: new Date(now).toISOString().slice(0, 10), used: 9999 },
    lease: { tabId: 'un-autre-onglet', until: now + 60_000 },
  };
}

beforeEach(() => {
  // `resetRateLimits` journalise dans la console du panneau ; ici elle sortirait
  // au milieu du rapport de tests.
  warn = console.warn;
  console.warn = () => {};
});

afterEach(() => {
  console.warn = warn;
  uninstallFakeChrome();
});

describe('remise à zéro des compteurs de débit', () => {
  test('lève le freinage, remplit le seau et efface le budget du jour', async () => {
    const now = Date.now();
    fake = installFakeChrome({ watch: blocked(now) });

    await resetRateLimits();

    const next = fake.db.watch as WatchState;
    assert.equal(next.bucket.tokens, RATE.capacity, 'le seau doit être rempli');
    assert.equal(next.throttledUntil, undefined, 'la fenêtre de silence doit être levée');
    assert.equal(next.throttleStrikes, undefined, 'les coups de frein doivent repartir de zéro');
    assert.equal(next.dailyBudget, undefined, 'le budget du jour doit être effacé');
  });

  test('ne touche ni au bail ni à la date du dernier cycle', async () => {
    const now = Date.now();
    const before = blocked(now);
    fake = installFakeChrome({ watch: before });

    await resetRateLimits();

    const next = fake.db.watch as WatchState;
    assert.deepEqual(next.lease, before.lease, 'le bail appartient à un autre onglet');
    assert.equal(next.lastSweepAt, before.lastSweepAt);
  });

  test('rend compte de ce qui bloquait, pour que le clic ait un retour visible', async () => {
    const now = Date.now();
    fake = installFakeChrome({ watch: blocked(now) });

    const report = await resetRateLimits();

    assert.equal(report.freine, true);
    assert.equal(report.coupsDeFrein, 3);
    assert.equal(report.budgetDuJour, 9999);
    assert.equal(report.jetons, 0);
  });

  test('fonctionne sans état préalable — aucun cycle n’a encore tourné', async () => {
    fake = installFakeChrome({});

    await resetRateLimits();

    const next = fake.db.watch as WatchState;
    assert.equal(next.bucket.tokens, RATE.capacity);
    assert.equal(next.lastSweepAt, 0);
  });
});
