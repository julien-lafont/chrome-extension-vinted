/**
 * Le bail du cycle de rafraîchissement (`watch.lease`) — voir
 * docs/specs/suivi-prix.md §2 et §3.2.
 *
 * Trois onglets Vinted ouverts, c'est trois content scripts : sans bail, le
 * débit serait triplé sans que personne ne l'ait demandé. Les deux comportements
 * qui comptent : un seul onglet à la fois tient le bail, et un bail expiré
 * (onglet fermé en plein cycle) ne bloque personne à vie.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadContentScript, createSharedBackend, settle, settleFetches, meta } from './harness.ts';
import { makeItem } from './factories.ts';

after(settleFetches);

describe('bail du cycle', () => {
  test('un seul onglet obtient le bail, l’autre n’émet aucune requête', async () => {
    // Un seul article dans la file : la boucle s'arrête après lui, sans le
    // délai irrégulier de §3.3 entre deux articles — ce test n'a que faire de
    // la cadence, et un délai de plusieurs dizaines de secondes resterait actif
    // bien après la fin du test si un second article restait à traiter.
    const backend = createSharedBackend({ a: makeItem({ id: 'a', url: meta.itemUrl }) });

    const pageA = await loadContentScript('item', { shared: backend });
    const pageB = await loadContentScript('item', { shared: backend });

    const resA = await pageA.startWatch(['a']);
    assert.equal(resA.accepted, true, 'le premier onglet doit obtenir le bail');

    const resB = await pageB.startWatch(['a']);
    assert.equal(resB.accepted, false, 'le second onglet doit être refusé');

    await settle(50);

    assert.equal(
      pageB.pendingFetches().length,
      0,
      "l'onglet refusé ne doit émettre aucune requête"
    );
    assert.ok(pageA.pendingFetches().length > 0, "l'onglet qui tient le bail doit avoir démarré");
  });

  test('un bail expiré est repris', async () => {
    const backend = createSharedBackend({ a: makeItem({ id: 'a', url: meta.itemUrl }) });

    // Bail tenu par un onglet fermé en plein cycle, jamais renouvelé.
    backend.store.watch = {
      lastSweepAt: 0,
      bucket: { tokens: 12, at: Date.now() },
      lease: { tabId: 'onglet-ferme', until: Date.now() - 1000 },
    };

    const page = await loadContentScript('item', { shared: backend });
    const response = await page.startWatch(['a']);

    assert.equal(response.accepted, true, 'un bail expiré ne doit bloquer personne');
  });
});
