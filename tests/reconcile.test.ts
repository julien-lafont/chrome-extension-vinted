/**
 * La liste du panneau se met-elle à jour sans être détruite ?
 *
 * La propriété qui compte n'est pas l'ordre final — un `textContent = ''` suivi
 * d'une reconstruction le produit aussi — mais le fait qu'un nœud **déjà à sa
 * place ne quitte jamais le document**. C'est ce qui préserve la position de
 * défilement et évite de recharger les vignettes, et c'est donc ce que ces tests
 * mesurent, en comptant les retraits observés par un `MutationObserver`.
 *
 * jsdom ne calcule aucune mise en page : `scrollTop` y vaut toujours 0 et ne
 * prouverait rien. Compter les détachements est la formulation vérifiable de la
 * même garantie — et l'ancien rendu, qui vidait la liste, la fait tomber.
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { reconcile } from '../src/sidepanel/reconcile.ts';

let dom: JSDOM;
let list: HTMLElement;

/** Retraits d'enfants directs observés depuis l'appel — voir l'en-tête. */
function watchRemovals(): () => number {
  let removed = 0;
  const observer = new dom.window.MutationObserver((records) => {
    for (const record of records) removed += record.removedNodes.length;
  });
  observer.observe(list, { childList: true });

  return () => {
    // Les enregistrements sont livrés en micro-tâche : les prendre à la main
    // évite d'attendre, et rend le compte déterministe.
    const pending = observer.takeRecords();
    for (const record of pending) removed += record.removedNodes.length;
    observer.disconnect();
    return removed;
  };
}

/** Un nœud d'article, reconnaissable à son identifiant. */
function node(id: string): HTMLElement {
  const el = dom.window.document.createElement('article');
  el.className = 'item';
  el.dataset.id = id;
  return el;
}

const ids = (): string[] => [...list.children].map((el) => (el as HTMLElement).dataset.id ?? '');

beforeEach(() => {
  dom = new JSDOM('<main id="list"></main>');
  const el = dom.window.document.getElementById('list');
  assert.ok(el);
  list = el;
});

describe('réconciliation de la liste', () => {
  test('pose les nœuds dans l ordre sur une liste vide', () => {
    const nodes = ['a', 'b', 'c'].map(node);
    reconcile(list, nodes);

    assert.deepEqual(ids(), ['a', 'b', 'c']);
  });

  test('un rendu identique ne détache aucun nœud', () => {
    const nodes = ['a', 'b', 'c'].map(node);
    reconcile(list, nodes);

    const removals = watchRemovals();
    reconcile(list, nodes);

    assert.equal(removals(), 0, 'un nœud a été retiré alors que rien ne changeait');
    assert.deepEqual(ids(), ['a', 'b', 'c']);
  });

  test('insérer au milieu ne touche pas aux nœuds voisins', () => {
    const [a, b, c] = ['a', 'b', 'c'].map(node);
    assert.ok(a && b && c);
    reconcile(list, [a, b, c]);

    const removals = watchRemovals();
    const inserted = node('nouveau');
    reconcile(list, [a, inserted, b, c]);

    assert.equal(removals(), 0);
    assert.deepEqual(ids(), ['a', 'nouveau', 'b', 'c']);
    // Identité, pas seulement égalité de contenu : ce sont les mêmes éléments,
    // donc les mêmes images déjà chargées et les mêmes écouteurs.
    assert.equal(list.children[0], a);
    assert.equal(list.children[3], c);
  });

  test('retirer un article ne détache que le sien', () => {
    const [a, b, c] = ['a', 'b', 'c'].map(node);
    assert.ok(a && b && c);
    reconcile(list, [a, b, c]);

    const removals = watchRemovals();
    reconcile(list, [a, c]);

    assert.equal(removals(), 1);
    assert.deepEqual(ids(), ['a', 'c']);
    assert.equal(b.parentNode, null, "l'article retiré est bien sorti de la liste");
  });

  test('un réordonnancement déplace sans recréer', () => {
    const [a, b, c] = ['a', 'b', 'c'].map(node);
    assert.ok(a && b && c);
    reconcile(list, [a, b, c]);

    reconcile(list, [c, a, b]);

    assert.deepEqual(ids(), ['c', 'a', 'b']);
    assert.equal(list.children[0], c, 'le nœud déplacé doit être le même');
    assert.equal(list.children[1], a);
  });

  test('ce qui reste en fin de liste est retiré', () => {
    // Cas réel : le message « Collection vide » d'un rendu précédent, ou le
    // fantôme laissé par un glisser interrompu.
    const stale = dom.window.document.createElement('div');
    stale.className = 'empty';
    list.append(stale);

    reconcile(list, ['a'].map(node));

    assert.deepEqual(ids(), ['a']);
    assert.equal(list.children.length, 1);
  });

  test('vider la liste la vide vraiment', () => {
    reconcile(list, ['a', 'b'].map(node));
    reconcile(list, []);

    assert.equal(list.children.length, 0);
  });
});
