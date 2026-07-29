/**
 * Rendu du suivi de prix dans le panneau — voir docs/specs/suivi-prix.md §8.
 *
 * `item-render.ts` et `price-history.ts` ne touchent qu'au DOM qu'on leur
 * passe, sans `chrome` : comme `gallery.test.ts`, on monte `sidepanel.html`
 * en jsdom et on vérifie directement ce qui est écrit, sans passer par
 * `sidepanel.ts` (qui, lui, orchestre le storage et les onglets).
 */
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderPriceAndStatus } from '../src/sidepanel/item-render.ts';
import { initPriceHistory, openPriceHistory } from '../src/sidepanel/price-history.ts';
import { formatEuro } from '../src/shared/price.ts';
import type { SavedItem } from '../src/shared/types.ts';
import { makeItem } from './factories.ts';

const PANEL = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'sidepanel');

let dom: JSDOM;
let template: HTMLTemplateElement;
let priceHistoryEl: HTMLElement;

before(() => {
  dom = new JSDOM(readFileSync(join(PANEL, 'sidepanel.html'), 'utf8'), {
    url: 'chrome-extension://test/sidepanel.html',
  });

  const window = dom.window;
  // `price-history.ts` parle à `document` et à `window` (position du popover),
  // comme le panneau : voir gallery.test.ts pour le même principe sur `document`.
  (globalThis as { document?: Document }).document = window.document;
  (globalThis as { window?: unknown }).window = window;

  const byId = (id: string): HTMLElement => {
    const found = window.document.getElementById(id);
    if (!found) throw new Error(`sidepanel.html : #${id} introuvable`);
    return found;
  };

  template = byId('item-template') as unknown as HTMLTemplateElement;
  priceHistoryEl = byId('price-history');
  initPriceHistory(priceHistoryEl);
});

beforeEach(() => {
  priceHistoryEl.hidden = true;
  priceHistoryEl.textContent = '';
});

/** Clone le template de ligne d'article et y applique le rendu testé. */
function mount(item: SavedItem): { article: HTMLElement; node: DocumentFragment } {
  const node = template.content.cloneNode(true) as DocumentFragment;
  const article = node.querySelector('.item');
  if (!article) throw new Error('item-template : .item introuvable');
  renderPriceAndStatus(node, article as HTMLElement, item);
  return { article: article as HTMLElement, node };
}

describe('badge de variation', () => {
  test('une baisse de 2 % n’affiche aucun badge', () => {
    const item = makeItem({
      id: '1',
      priceValue: 98,
      priceHistory: [
        { at: 1, price: 100 },
        { at: 2, price: 98 },
      ],
    });
    const { node } = mount(item);

    assert.equal(node.querySelector<HTMLElement>('.item-price-delta')?.hidden, true);
    assert.equal(node.querySelector<HTMLElement>('.item-price-was')?.hidden, true);
  });

  test('une baisse de 20 % affiche la pastille et l’ancien prix', () => {
    const item = makeItem({
      id: '2',
      priceValue: 80,
      priceHistory: [
        { at: 1, price: 100 },
        { at: 2, price: 80 },
      ],
    });
    const { node } = mount(item);

    const delta = node.querySelector<HTMLButtonElement>('.item-price-delta');
    const was = node.querySelector<HTMLElement>('.item-price-was');

    assert.equal(delta?.hidden, false);
    assert.equal(delta?.textContent, '−20 %');
    assert.ok(delta?.classList.contains('item-price-delta--drop'));
    assert.match(delta?.getAttribute('aria-label') ?? '', /baisse de 20 %/);

    assert.equal(was?.hidden, false);
    assert.equal(was?.textContent, formatEuro(100));
  });

  test('une hausse s’affiche toujours, jamais comme une baisse', () => {
    const item = makeItem({
      id: '3',
      priceValue: 110,
      priceHistory: [
        { at: 1, price: 100 },
        { at: 2, price: 110 },
      ],
    });
    const { node } = mount(item);

    const delta = node.querySelector<HTMLButtonElement>('.item-price-delta');
    assert.equal(delta?.hidden, false);
    assert.equal(delta?.textContent, '+10 %');
    assert.ok(delta?.classList.contains('item-price-delta--rise'));
  });

  test('un seul point d’historique n’affiche rien', () => {
    const item = makeItem({ id: '4', priceHistory: [{ at: 1, price: 50 }] });
    const { node } = mount(item);

    assert.equal(node.querySelector<HTMLElement>('.item-price-delta')?.hidden, true);
  });
});

describe('article vendu ou disparu', () => {
  test('garde sa ligne dans la liste avec son badge d’état', () => {
    const item = makeItem({ id: '5', status: 'sold' });
    const { article, node } = mount(item);

    assert.ok(article.classList.contains('item--sold'));

    const status = node.querySelector<HTMLElement>('.item-status-badge');
    assert.equal(status?.hidden, false);
    assert.equal(status?.textContent, 'Vendu');
  });

  test('un article disparu porte le badge « Retiré », pas « Vendu »', () => {
    const item = makeItem({ id: '6', status: 'gone' });
    const { article, node } = mount(item);

    assert.ok(article.classList.contains('item--gone'));
    assert.equal(node.querySelector<HTMLElement>('.item-status-badge')?.textContent, 'Retiré');
  });

  test('n’affiche plus le badge de variation, même avec un historique', () => {
    const item = makeItem({
      id: '7',
      status: 'sold',
      priceHistory: [
        { at: 1, price: 100 },
        { at: 2, price: 80 },
      ],
    });
    const { node } = mount(item);

    assert.equal(node.querySelector<HTMLElement>('.item-price-delta')?.hidden, true);
  });
});

describe('popover d’historique', () => {
  test('ne s’ouvre pas sur un article à un seul point de prix', () => {
    const item = makeItem({ id: '8', priceHistory: [{ at: 1, price: 50 }] });
    const anchor = dom.window.document.createElement('button');

    openPriceHistory(item, anchor);

    assert.equal(priceHistoryEl.hidden, true);
  });

  test('s’ouvre et liste les relevés quand il y a de quoi', () => {
    const item = makeItem({
      id: '9',
      lastCheckedAt: Date.now() - 2 * 60 * 60 * 1000,
      priceHistory: [
        { at: Date.parse('2026-03-12'), price: 128 },
        { at: Date.parse('2026-07-26'), price: 102 },
      ],
    });
    const anchor = dom.window.document.createElement('button');

    openPriceHistory(item, anchor);

    assert.equal(priceHistoryEl.hidden, false);
    assert.equal(priceHistoryEl.querySelectorAll('.price-history-row').length, 2);
    assert.match(priceHistoryEl.textContent ?? '', /Vérifié il y a 2 h/);
  });
});
