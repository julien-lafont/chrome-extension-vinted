/**
 * Onglet en arrière-plan pendant un cycle — `docs/specs/suivi-prix.md` §3.6.
 *
 * La spec dit « suspendre » ; le code **abandonnait**. Un onglet effleuré une
 * seconde suffisait à perdre le cycle entier, sans rien afficher : le compteur
 * disparaissait, et le prochain clic repartait de zéro. Ces tests fixent le
 * comportement attendu — pause, battement de cœur, reprise là où on en était.
 *
 * Un seul article dans la file, comme `watch-lease.test.ts` : la boucle n'a
 * alors pas à passer par le délai irrégulier de §3.3, dont la queue de
 * distribution (10 à 30 s, une fois sur cent) resterait armée après le test.
 */
import { test, describe, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { loadContentScript, createSharedBackend, settle, settleFetches, meta } from './harness.ts';
import { makeItem } from './factories.ts';

after(settleFetches);

/** Une page chargée dont on pilote la visibilité, comme un utilisateur ses onglets. */
async function loadWithVisibility(hidden: boolean) {
  const page = await loadContentScript('item', {
    shared: createSharedBackend({ a: makeItem({ id: 'a', url: meta.itemUrl }) }),
  });

  let state = hidden ? 'hidden' : 'visible';
  Object.defineProperty(page.document, 'visibilityState', {
    configurable: true,
    get: () => state,
  });

  return {
    page,
    /** Bascule l'onglet et notifie la page, comme le fait le navigateur. */
    setVisible: async (visible: boolean): Promise<void> => {
      state = visible ? 'visible' : 'hidden';
      page.document.dispatchEvent(new page.window.Event('visibilitychange'));
      await settle(120);
    },
    /**
     * **À appeler avant de quitter un test qui laisse un cycle en pause.** Une
     * pause est une chaîne de minuteurs bien vivante (elle bat toutes les 20 s
     * pendant un quart d'heure) : sans annulation, le process de test resterait
     * ouvert jusqu'à son terme, `settleFetches()` n'y pouvant rien — il ne solde
     * que des requêtes, et une pause n'en émet aucune.
     */
    stop: async (): Promise<void> => {
      await page.cancelWatch();
      await settle(120);
    },
  };
}

let log: typeof console.log;

before(() => {
  // Le content script journalise chaque décision du cycle ; ici, en plein
  // rapport de tests.
  log = console.log;
  console.log = () => {};
  after(() => {
    console.log = log;
  });
});

describe('cycle sur un onglet caché', () => {
  test('se met en pause au lieu d’abandonner, et le dit en storage', async () => {
    const { page, stop } = await loadWithVisibility(true);

    const response = await page.startWatch(['a']);
    assert.equal(response.accepted, true, 'l’ordre est accepté : c’est le cycle qui attend');
    await settle(150);

    assert.equal(
      page.pendingFetches().length,
      0,
      'aucune requête ne doit partir d’un onglet en arrière-plan (§3.6)'
    );

    const progress = page.watchState()?.progress;
    assert.ok(progress, 'le cycle doit rester annoncé — sans quoi il est perdu, pas suspendu');
    assert.equal(progress.paused, true);
    assert.ok(progress.at > 0, 'le battement de cœur distingue « en pause » de « onglet fermé »');

    // La marque de §6.10 est posée par le cycle lui-même, dans l'onglet qui le
    // porte : c'est ce qui répond à « lequel de mes onglets Vinted attend ? »
    // Vérifié ici, à travers le content script, et non seulement sur
    // `watch-ui.ts` — c'est le câblage qui manquait.
    assert.match(page.document.title, /^⏸ /, 'le titre doit désigner l’onglet en pause');
    assert.ok(page.document.querySelector('.vf-sweep-bar'), 'le bandeau doit être posé');

    await stop();
  });

  test('reprend dès le retour au premier plan', async () => {
    const { page, setVisible } = await loadWithVisibility(true);

    await page.startWatch(['a']);
    await settle(150);
    assert.equal(page.pendingFetches().length, 0);

    await setVisible(true);

    assert.equal(page.pendingFetches().length, 1, 'la fiche doit être demandée au retour');
    assert.equal(page.watchState()?.progress?.paused, false);
    assert.match(page.document.title, /^🔄 /, 'la marque du titre doit repasser en « en cours »');
  });

  test('une annulation pendant la pause arrête le cycle sans attendre le battement', async () => {
    const { page } = await loadWithVisibility(true);

    await page.startWatch(['a']);
    await settle(150);

    await page.cancelWatch();
    await settle(150);

    assert.equal(
      page.watchState()?.progress,
      undefined,
      'le cycle annulé ne doit plus être annoncé'
    );
    assert.equal(page.pendingFetches().length, 0, 'et rien ne doit partir malgré tout');
    assert.equal(page.document.querySelector('.vf-sweep-bar'), null);
    // Alternation plutôt qu'une classe de caractères : `🔄` est une paire de
    // substitution, et `[🔄⏸]` sans le drapeau `u` filtrerait ses deux moitiés
    // séparément (ce que `no-misleading-character-class` refuse, à raison).
    assert.doesNotMatch(page.document.title, /^(🔄|⏸) /, 'la page redevient une page ordinaire');
  });
});
