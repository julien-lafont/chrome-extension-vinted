/**
 * Rendu de la ligne du vendeur dans le panneau.
 *
 * Ce qui se joue ici n'est pas cosmétique : « aucune évaluation » et « pas
 * d'information » se ressemblent à l'écran alors qu'ils disent l'inverse l'un
 * de l'autre — le premier est justement le signal qu'on cherche sur une pièce
 * chère, le second n'est qu'une fiche pas encore lue. Chaque cas a donc son
 * test.
 *
 * Même montage que `watch-render.test.ts` : `item-render.ts` ne touche qu'au
 * DOM qu'on lui passe, sans `chrome`.
 */
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderSeller } from '../src/sidepanel/item-render.ts';
import type { SavedItem } from '../src/shared/types.ts';
import { makeItem } from './factories.ts';

const PANEL = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'sidepanel');

let template: HTMLTemplateElement;

before(() => {
  const dom = new JSDOM(readFileSync(join(PANEL, 'sidepanel.html'), 'utf8'), {
    url: 'chrome-extension://test/sidepanel.html',
  });

  const found = dom.window.document.getElementById('item-template');
  if (!found) throw new Error('sidepanel.html : #item-template introuvable');
  template = found as unknown as HTMLTemplateElement;
});

/** Clone le template de ligne d'article et y applique le rendu du vendeur. */
function mount(overrides: Partial<SavedItem>): DocumentFragment {
  const node = template.content.cloneNode(true) as DocumentFragment;
  renderSeller(node, makeItem({ id: '1', ...overrides }));
  return node;
}

const el = (node: DocumentFragment, selector: string): HTMLElement => {
  const found = node.querySelector<HTMLElement>(selector);
  if (!found) throw new Error(`${selector} introuvable dans le template`);
  return found;
};

describe('ligne du vendeur', () => {
  test('reste absente tant que la fiche n’a pas été lue', () => {
    // Article enregistré depuis sa carte, fiche pas encore lue : aucun champ
    // vendeur. La ligne ne doit pas apparaître vide.
    const node = mount({});
    assert.equal(el(node, '.item-seller-line').hidden, true);
  });

  test('affiche pseudo, drapeau, note et évaluations', () => {
    const node = mount({
      sellerId: '237208752',
      sellerName: 'ramikljk',
      sellerCountry: 'DE',
      sellerRating: 4.7,
      sellerFeedbackCount: 39,
    });

    assert.equal(el(node, '.item-seller-line').hidden, false);
    assert.equal(el(node, '.item-seller').textContent, 'ramikljk');
    assert.equal(el(node, '.item-seller-flag').textContent, '🇩🇪');
    assert.equal(el(node, '.item-seller-rating').textContent, '4,7 ★');
    assert.equal(el(node, '.item-seller-reviews').textContent, '39 avis');
  });

  test('le pseudo mène au dressing du vendeur', () => {
    const node = mount({ sellerId: '237208752', sellerName: 'ramikljk' });
    const link = el(node, '.item-seller') as HTMLAnchorElement;

    assert.equal(link.href, 'https://www.vinted.fr/member/237208752');
  });

  test('un vendeur nommé mais non identifié reste affiché, sans lien', () => {
    const node = mount({ sellerName: 'ramikljk' });
    const link = el(node, '.item-seller') as HTMLAnchorElement;

    assert.equal(link.textContent, 'ramikljk');
    assert.equal(link.getAttribute('href'), null);
  });

  test('le drapeau porte le nom du pays, que Windows n’affiche pas d’emoji ou non', () => {
    const flag = el(mount({ sellerName: 'x', sellerCountry: 'FR' }), '.item-seller-flag');

    assert.equal(flag.title, 'France');
    assert.equal(flag.getAttribute('aria-label'), 'France');
  });

  test('zéro évaluation se dit, et n’affiche pas une note de zéro', () => {
    // Le cas qui compte : compte récent, aucun avis. Une note « 0 » se
    // lirait comme un mauvais vendeur au lieu d'un vendeur inconnu.
    const node = mount({ sellerName: 'nouveau', sellerFeedbackCount: 0, sellerRating: null });

    assert.equal(el(node, '.item-seller-reviews').textContent, 'aucune évaluation');
    assert.equal(el(node, '.item-seller-rating').hidden, true);
  });

  test('un compteur inconnu n’affiche rien plutôt que zéro', () => {
    const node = mount({ sellerName: 'ramikljk', sellerFeedbackCount: null });

    assert.equal(el(node, '.item-seller-line').hidden, false, 'le pseudo reste affiché');
    assert.equal(el(node, '.item-seller-reviews').hidden, true);
    assert.equal(el(node, '.item-seller-rating').hidden, true);
  });

  test('une note ronde s’écrit sans décimale', () => {
    const node = mount({ sellerName: 'x', sellerRating: 5, sellerFeedbackCount: 12 });
    assert.equal(el(node, '.item-seller-rating').textContent, '5 ★');
  });

  test('sans pays, aucun drapeau', () => {
    const node = mount({ sellerName: 'x', sellerCountry: null });
    assert.equal(el(node, '.item-seller-flag').hidden, true);
  });

  test('note et évaluations suivent le pseudo dans l’ordre du DOM', () => {
    // La mise en page (CSS) tient à cet ordre : le pseudo ne doit pas
    // s'étirer pour repousser le reste en bout de ligne — voir
    // `.item-seller { flex: 0 1 auto }` dans sidepanel.css. Rien ici ne
    // vérifie le rendu visuel, seulement que la structure qui le permet est
    // en place.
    const node = mount({
      sellerName: 'ramikljk',
      sellerRating: 4.7,
      sellerFeedbackCount: 39,
    });

    const line = el(node, '.item-seller-line');
    const order = [...line.children].map((child) => child.className);

    assert.deepEqual(order, [
      'item-seller-flag',
      'item-seller',
      'item-seller-rating',
      'item-seller-reviews',
    ]);
  });
});
