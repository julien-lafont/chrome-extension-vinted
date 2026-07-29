/**
 * Recherche « ailleurs » : Google Lens sur la photo, repli texte sinon.
 *
 * Sur le modèle de `similar-search.test.ts` — fonctions pures, relecture de
 * l'URL produite via `new URL()`. Voir docs/specs/recherche-inversee.md §7.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { elsewhereSearches, lensUrl, textQuery } from '../src/sidepanel/elsewhere.ts';
import type { ItemPhoto, SavedItem } from '../src/shared/types.ts';
import { makeItem } from './factories.ts';

const SIGNED_PHOTO =
  'https://images1.vinted.net/t/01_002d4_WrAWsVQUhTXAi4iWtgjLpzpo/310x430/1785135037.webp' +
  '?s=6cc51b966f27fdadc35cfb4b2d63f0af6b64e12d';

const photo = (overrides: Partial<ItemPhoto> = {}): ItemPhoto => ({
  thumb: SIGNED_PHOTO,
  url: SIGNED_PHOTO,
  full: SIGNED_PHOTO.replace('310x430', '1200x1600'),
  ...overrides,
});

describe('elsewhereSearches()', () => {
  test('article avec une photo Vinted exploitable : Lens en tête, sur images[0].url', () => {
    const item = makeItem({ id: '1', images: [photo()] });
    const [first] = elsewhereSearches(item);

    assert.equal(first.kind, 'lens');
    const url = new URL(first.url);
    assert.equal(url.origin + url.pathname, 'https://lens.google.com/uploadbyurl');
    assert.equal(url.searchParams.get('url'), SIGNED_PHOTO);
  });

  test('la marque part en paramètre q, aux côtés de la photo', () => {
    const item = makeItem({ id: '1', brand: 'Nike', images: [photo()] });
    const [first] = elsewhereSearches(item);

    assert.equal(first.kind, 'lens');
    assert.equal(new URL(first.url).searchParams.get('q'), 'Nike');
  });

  test('sans marque, pas de paramètre q', () => {
    const item = makeItem({ id: '1', images: [photo()] });
    const [first] = elsewhereSearches(item);

    assert.equal(new URL(first.url).searchParams.has('q'), false);
  });

  test('la signature ?s=… de la photo traverse intacte le paramètre url=', () => {
    const item = makeItem({ id: '1', images: [photo()] });
    const [first] = elsewhereSearches(item);

    const forwarded = new URL(first.url).searchParams.get('url');
    assert.equal(forwarded, SIGNED_PHOTO);
    assert.ok(forwarded?.includes('?s=6cc51b966f27fdadc35cfb4b2d63f0af6b64e12d'));
  });

  test('images[0].url et .full sur un hôte inconnu : repli texte, le garde-fou mord', () => {
    const item = makeItem({
      id: '1',
      images: [
        photo({
          url: 'https://cdn.evil.example/photo.jpg',
          full: 'https://cdn.evil.example/full.jpg',
        }),
      ],
    });

    const searches = elsewhereSearches(item);
    assert.equal(searches.length, 1);
    assert.equal(searches[0].kind, 'text');
  });

  test('images[0].url et .full en http: (non https) : repli texte', () => {
    const item = makeItem({
      id: '1',
      images: [
        photo({
          url: 'http://images1.vinted.net/t/x/310x430/1.webp',
          full: 'http://images1.vinted.net/t/x/1200x1600/1.webp',
        }),
      ],
    });

    assert.equal(elsewhereSearches(item)[0].kind, 'text');
  });

  test('images[0].url et .full relatifs : repli texte', () => {
    const item = makeItem({
      id: '1',
      images: [photo({ url: '/t/x/310x430/1.webp', full: '/t/x/1200x1600/1.webp' })],
    });

    assert.equal(elsewhereSearches(item)[0].kind, 'text');
  });

  test('images absent : repli texte, liste jamais vide', () => {
    const item = makeItem({ id: '1', title: 'Nike Air Zoom Mercurial', brand: 'Nike' });

    const searches = elsewhereSearches(item);
    assert.equal(searches.length, 1);
    assert.equal(searches[0].kind, 'text');
  });

  test('url inexploitable mais full exploitable : Lens retombe sur full', () => {
    const item = makeItem({
      id: '1',
      images: [photo({ url: 'https://cdn.evil.example/photo.jpg', full: SIGNED_PHOTO })],
    });

    const [first] = elsewhereSearches(item);
    assert.equal(first.kind, 'lens');
    assert.equal(new URL(first.url).searchParams.get('url'), SIGNED_PHOTO);
  });
});

describe('lensUrl()', () => {
  test('sans marque, ne pose que le paramètre url', () => {
    const url = new URL(lensUrl(SIGNED_PHOTO));
    assert.equal([...url.searchParams.keys()].join(','), 'url');
  });

  test('avec une marque, ajoute q', () => {
    const url = new URL(lensUrl(SIGNED_PHOTO, 'Nike'));
    assert.equal(url.searchParams.get('q'), 'Nike');
  });
});

describe('textQuery()', () => {
  test('marque puis titre, sans le nom de la marque en double', () => {
    const item = makeItem({ id: '1', brand: 'Nike', title: 'Nike Air Zoom Mercurial' });
    const q = textQuery(item);

    assert.equal((q.match(/Nike/gi) ?? []).length, 1);
    assert.ok(q.includes('Air Zoom Mercurial'));
  });

  test("taille courte (« M ») écartée, elle n'informe pas une recherche web", () => {
    const item = makeItem({ id: '1', brand: 'Nike', title: 'Sweat à capuche', size: 'M' });
    assert.ok(!textQuery(item).split(' ').includes('M'));
  });

  test('taille informative (« 42 EU »), absente du titre, conservée', () => {
    const item = makeItem({
      id: '1',
      brand: 'Nike',
      title: 'Air Zoom Mercurial',
      size: '42 EU',
    });
    assert.ok(textQuery(item).includes('42 EU'));
  });

  test('taille déjà présente dans le titre : pas de doublon', () => {
    const item = makeItem({
      id: '1',
      brand: 'Nike',
      title: 'Air Zoom Mercurial 42',
      size: '42',
    });
    const q = textQuery(item);
    assert.equal((q.match(/42/g) ?? []).length, 1);
  });

  test('sans marque ni taille : la requête retombe sur le titre', () => {
    const item = makeItem({ id: '1', title: 'Robe fleurie vintage' });
    assert.equal(textQuery(item), 'Robe fleurie vintage');
  });

  test("sans marque, ni titre, ni taille : retombe sur l'id, jamais vide", () => {
    const item = makeItem({ id: '42', title: '' });
    assert.equal(textQuery(item), '42');
  });
});

/** Relit `textSearchUrl` indirectement via `elsewhereSearches()` : une URL valide, requête lisible. */
test('le repli texte produit une URL Google valide', () => {
  const item: SavedItem = makeItem({
    id: '1',
    brand: 'Nike',
    title: 'Nike Air Zoom Mercurial',
    size: '42 EU',
  });

  const search = elsewhereSearches(item).find((s) => s.kind === 'text');
  assert.ok(search);

  const url = new URL(search.url);
  assert.equal(url.origin + url.pathname, 'https://www.google.com/search');
  assert.equal(url.searchParams.get('q'), textQuery(item));
});
