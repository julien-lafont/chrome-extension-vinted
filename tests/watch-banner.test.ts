/**
 * Marquage de l'onglet qui porte le cycle — `docs/specs/suivi-prix.md` §6.10.
 *
 * `watch-ui.ts` ne touche qu'au DOM qu'il trouve : on le monte donc sur un jsdom
 * nu, sans le content script ni le harness complet. La question posée est celle
 * de l'utilisateur qui a trois onglets Vinted ouverts : « lequel rafraîchit ? »
 *
 * Le titre compte plus que le bandeau : c'est la seule des deux marques qui se
 * lise **sans quitter l'onglet où l'on est**, donc la seule qui serve à trouver
 * le porteur dans la barre d'onglets.
 */
import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { showSweepProgress } from '../src/content/watch-ui.ts';

let dom: JSDOM;

before(() => {
  dom = new JSDOM('<!doctype html><html><head><title>Vinted</title></head><body></body></html>', {
    url: 'https://www.vinted.fr/catalog',
  });
  // `watch-ui.ts` parle au `document` de la page, comme toutes les surcouches du
  // content script (voir `noise-ui.ts`).
  (globalThis as { document?: Document }).document = dom.window.document;
});

after(() => {
  delete (globalThis as { document?: Document }).document;
});

beforeEach(() => {
  showSweepProgress(null);
  dom.window.document.title = 'Vinted';
});

const bar = (): HTMLElement | null =>
  dom.window.document.querySelector<HTMLElement>('.vf-sweep-bar');

const title = (): string => dom.window.document.title;

describe('bandeau du cycle', () => {
  test('apparaît avec l’avancement, et marque le titre de l’onglet', () => {
    showSweepProgress({ done: 3, total: 48 });

    assert.match(bar()?.textContent ?? '', /3\/48/);
    assert.equal(title(), '🔄 Vinted', 'le titre doit désigner l’onglet porteur');
  });

  test('n’ajoute qu’un seul nœud, quel que soit le nombre d’articles vérifiés', () => {
    // Le cycle appelle cette fonction à chaque article : le bandeau est réécrit
    // des dizaines de fois. Un nœud par appel serait une pile de bandeaux, et
    // sur un onglet Vinted, une écriture DOM gratuite réveille le
    // `MutationObserver` de `content.ts` (règle 3 du projet).
    showSweepProgress({ done: 1, total: 48 });
    showSweepProgress({ done: 2, total: 48 });
    showSweepProgress({ done: 3, total: 48 });

    assert.equal(dom.window.document.querySelectorAll('.vf-sweep-bar').length, 1);
    assert.match(bar()?.textContent ?? '', /3\/48/);
  });

  test('n’empile pas les marques de titre en passant de la pause à la reprise', () => {
    showSweepProgress({ done: 3, total: 48 });
    showSweepProgress({ done: 3, total: 48, paused: true });
    showSweepProgress({ done: 3, total: 48 });
    showSweepProgress({ done: 4, total: 48, paused: true });

    assert.equal(title(), '⏸ Vinted');
  });

  test('en pause : le dit, et arrête l’animation', () => {
    showSweepProgress({ done: 7, total: 48, paused: true });

    assert.match(bar()?.textContent ?? '', /pause/i);
    assert.ok(
      bar()?.classList.contains('vf-sweep-paused'),
      'une icône qui tourne sur un cycle à l’arrêt dit le contraire de ce qui se passe'
    );
    assert.equal(title(), '⏸ Vinted');
  });

  test('la fin du cycle ne laisse aucune trace', () => {
    showSweepProgress({ done: 48, total: 48 });
    showSweepProgress(null);

    assert.equal(bar(), null);
    assert.equal(title(), 'Vinted', 'le titre doit redevenir celui de Vinted');
  });

  test('le titre suit la navigation de Vinted plutôt qu’un titre mémorisé', () => {
    // Vinted est une application monopage : le titre change pendant un cycle qui
    // dure. Restaurer une valeur capturée au démarrage réafficherait le nom d'un
    // article qu'on a quitté depuis.
    showSweepProgress({ done: 1, total: 48 });
    dom.window.document.title = '🔄 Veste Barbour — Vinted';
    showSweepProgress({ done: 2, total: 48 });

    assert.equal(title(), '🔄 Veste Barbour — Vinted');

    showSweepProgress(null);
    assert.equal(title(), 'Veste Barbour — Vinted');
  });

  test('le bandeau est inerte aux clics', () => {
    // Il recouvre la barre de recherche de Vinted le temps du cycle : intercepter
    // un clic qui la visait serait un effet de bord pur.
    showSweepProgress({ done: 1, total: 48 });

    const target = bar();
    assert.ok(target);
    // `pointer-events: none` vit dans content.css ; ce qui est vérifiable ici est
    // qu'aucun gestionnaire n'est câblé — pas de bouton, pas d'action.
    assert.equal(target.querySelector('button'), null);
  });

  test('la jauge suit l’avancement, et ne dépasse jamais', () => {
    const fill = (): HTMLElement | null =>
      dom.window.document.querySelector<HTMLElement>('.vf-sweep-fill');

    showSweepProgress({ done: 12, total: 48 });
    assert.equal(fill()?.style.width, '25%');

    showSweepProgress({ done: 48, total: 48 });
    assert.equal(fill()?.style.width, '100%');

    // Une file recomposée en cours de route peut faire passer `done` au-delà de
    // `total` ; une jauge à 130 % déborderait du bandeau.
    showSweepProgress({ done: 60, total: 48 });
    assert.equal(fill()?.style.width, '100%');

    // Et zéro article n'est pas une division par zéro.
    showSweepProgress({ done: 0, total: 0 });
    assert.equal(fill()?.style.width, '0%');
  });
});
