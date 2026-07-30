/**
 * Les ancres Vinted, lues sans monter l'extension.
 *
 * `extraction.test.ts` couvre le même terrain de bout en bout : il bundle le
 * content script par esbuild, l'évalue dans une fenêtre jsdom, lui donne un faux
 * `chrome` et un faux `fetch`, puis interroge `diagnose()`. C'est ce qu'il faut
 * pour vérifier qu'un clic enregistre — mais c'était aussi, jusqu'à l'extraction
 * de `content/extract.ts`, le seul moyen de vérifier qu'un sous-titre "42 · Très
 * bon état" se lit dans le bon ordre.
 *
 * Ici, les fonctions sont appelées directement sur un `Document` : quand Vinted
 * déplace une ancre, l'échec pointe la fonction fautive plutôt qu'un compteur de
 * `diagnose()`, et il n'y a rien à démonter pour comprendre pourquoi.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  cardId,
  extractFromCard,
  extractFromDetail,
  extractIdFromUrl,
  isSoldDetail,
  parseTitleFromLabel,
  readBreadcrumbCategory,
  titleFromUrl,
} from '../src/content/extract.ts';
// Les fixtures sont relues directement, sans passer par `harness.ts` : son
// import déclenche le bundle esbuild du content script, dont ce fichier n'a
// justement plus besoin.
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const meta = JSON.parse(readFileSync(join(FIXTURES, 'meta.json'), 'utf8')) as {
  itemUrl: string;
  catalogUrl: string;
  soldUrl: string;
  cards: number;
};

/** Le document d'une fixture, sans fenêtre globale ni faux `chrome`. */
function docOf(fixture: string, url: string): Document {
  const dom = new JSDOM(readFileSync(join(FIXTURES, `${fixture}.html`), 'utf8'), { url });
  return dom.window.document;
}

describe('fiche article', () => {
  const doc = (): Document => docOf('item', meta.itemUrl);

  test('le JSON-LD porte titre, marque, prix et description', () => {
    const item = extractFromDetail(doc(), meta.itemUrl);

    assert.ok(item, 'aucune extraction');
    assert.equal(item.id, extractIdFromUrl(meta.itemUrl));
    assert.equal(item.source, 'detail');
    assert.ok(item.title.length > 0, 'titre vide');
    assert.equal(typeof item.priceValue, 'number');
    assert.match(item.url, /^https:\/\/www\.vinted\.fr\/items\/\d+/);
  });

  test("le fil d'Ariane donne une catégorie exacte, avec son identifiant", () => {
    const item = extractFromDetail(doc(), meta.itemUrl);

    assert.ok(item?.category, 'aucune catégorie');
    assert.equal(item.category.exact, true, 'une fiche décrit son propre article');
    assert.match(item.category.url ?? '', /\/catalog\/\d+/);
  });

  test('le maillon de marque du fil est écarté de la catégorie', () => {
    const category = readBreadcrumbCategory(doc());

    assert.ok(category);
    assert.ok(!(category.url ?? '').includes('/brand/'), 'la catégorie a gardé la marque');
  });

  test("une fiche d'article vendu se reconnaît, une fiche active non", () => {
    assert.equal(isSoldDetail(docOf('sold', meta.soldUrl)), true);
    assert.equal(isSoldDetail(doc()), false);
  });

  test("une URL sans identifiant d'article ne produit rien", () => {
    assert.equal(extractFromDetail(doc(), 'https://www.vinted.fr/catalog'), null);
  });
});

describe('carte de catalogue', () => {
  // `extractFromCard()` lit `location` pour savoir si la page est une fiche (le
  // fil d'Ariane y décrit l'article affiché, pas les cartes du dressing).
  let dom: JSDOM;

  before(() => {
    dom = new JSDOM(readFileSync(join(FIXTURES, 'catalog.html'), 'utf8'), {
      url: meta.catalogUrl,
    });
    (globalThis as { document?: Document }).document = dom.window.document;
    (globalThis as { location?: Location }).location = dom.window.location;
  });

  after(() => {
    delete (globalThis as { document?: Document }).document;
    delete (globalThis as { location?: Location }).location;
  });

  const cards = (): HTMLElement[] => [
    ...dom.window.document.querySelectorAll<HTMLElement>('[data-testid^="product-item-id-"]'),
  ];

  test('toutes les cartes de la fixture portent un identifiant', () => {
    const boxes = cards().filter((box) => !(box.dataset.testid ?? '').includes('--'));

    assert.equal(boxes.length, meta.cards);
    for (const box of boxes) assert.match(cardId(box) ?? '', /^\d+$/);
  });

  test('une carte donne titre, marque, prix et miniature', () => {
    const box = cards().find((el) => !(el.dataset.testid ?? '').includes('--'));
    assert.ok(box, 'aucune carte dans la fixture');

    const item = extractFromCard(box);

    assert.ok(item);
    assert.equal(item.source, 'catalog');
    assert.ok(item.title.length > 0, 'titre vide');
    assert.ok(item.price.length > 0, 'prix vide');
    assert.ok(!item.url.includes('?'), 'le ?referrer= doit être retiré');
  });

  test("le titre s'arrête au premier attribut du libellé d'accessibilité", () => {
    // Un titre peut contenir des virgules : la coupe se fait sur ", marque:",
    // jamais sur la première virgule venue.
    const label = 'Veste Barbour, doublée, marque: Barbour, état: Très bon état, taille: M';

    assert.equal(parseTitleFromLabel(label), 'Veste Barbour, doublée');
    assert.equal(parseTitleFromLabel('Sac sans attribut'), 'Sac sans attribut');
    assert.equal(parseTitleFromLabel(''), '');
  });

  test("le slug de l'URL sert de titre de dernier recours", () => {
    assert.equal(
      titleFromUrl('https://www.vinted.fr/items/123-veste-en-jean-levis'),
      'Veste en jean levis'
    );
    assert.equal(titleFromUrl('https://www.vinted.fr/catalog'), '');
  });
});
