/**
 * La galerie lit-elle toutes les photos d'une fiche, dans le bon ordre et à la
 * bonne qualité ?
 *
 * Deux fixtures : `item.html` (une seule photo — le cas le plus courant) et
 * `item-photos.html` (trois photos, article épinglé). La seconde existe parce
 * qu'`itemUrl` est pris au premier article du catalogue : son nombre de photos
 * change à chaque rafraîchissement, et une galerie testée à un seul exemplaire
 * n'est pas testée. Voir `tests/tools/refresh-fixtures.ts`.
 *
 * Les URLs Vinted sont **signées** : ces tests vérifient qu'on les recopie
 * telles quelles, jamais qu'on les fabrique. Voir `docs/vinted-dom.md`.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractPhotos, photosFromDom, photosFromHydration } from '../src/shared/photos.ts';
import { FIXTURES, ITEM_ID, PHOTOS_ITEM_ID, type Fixture } from './harness.ts';

const docOf = (fixture: Fixture): Document =>
  new JSDOM(readFileSync(join(FIXTURES, `${fixture}.html`), 'utf8')).window.document;

describe('flux d’hydratation', () => {
  test('lit les trois photos de la fiche, ordonnées', () => {
    const photos = photosFromHydration(docOf('item-photos'), PHOTOS_ITEM_ID);

    assert.equal(photos.length, 3, 'les trois photos de la fiche');

    // L'ordre est celui du vendeur (`image_no`), pas celui du tableau : la
    // première photo doit être celle qu'affiche déjà la miniature du panneau.
    const main = docOf('item-photos').querySelector<HTMLImageElement>(
      '[data-testid="item-photo-1--img"]'
    );
    assert.equal(photos[0]?.url, main?.getAttribute('src'), 'la première photo doit être la 1');
  });

  test('donne la pleine résolution, distincte de la taille d’affichage', () => {
    const [photo] = photosFromHydration(docOf('item-photos'), PHOTOS_ITEM_ID);
    assert.ok(photo);

    // `f800` fait 600×800, `full_size_url` 1200×1600 : c'est tout l'intérêt de
    // passer par le flux plutôt que par le DOM, qui ne sert que la première.
    assert.match(photo.url, /\/f800\//, 'la taille d’affichage doit être le f800');
    assert.match(photo.full, /\/tc\//, 'la qualité max doit être le full_size_url');
    assert.notEqual(photo.full, photo.url);

    assert.match(photo.thumb, /\/310x430\//, 'la miniature doit être la 310x430');
    assert.equal(photo.width, 600);
    assert.equal(photo.height, 800);
    assert.match(photo.dominantColor ?? '', /^#[0-9a-f]{6}$/i);
  });

  test('recopie les URLs signées sans les reconstruire', () => {
    const html = readFileSync(join(FIXTURES, 'item-photos.html'), 'utf8');

    // Une URL dont la signature aurait été recopiée d'une autre taille répond
    // 404 chez Vinted, sans rien signaler ici : la seule garantie possible est
    // que chaque URL servie soit présente telle quelle dans la page.
    for (const photo of photosFromHydration(docOf('item-photos'), PHOTOS_ITEM_ID)) {
      for (const url of [photo.thumb, photo.url, photo.full]) {
        assert.match(url, /\?s=[0-9a-f]+$/, `URL non signée : ${url}`);
        assert.ok(html.includes(url), `URL absente de la page, donc fabriquée : ${url}`);
      }
    }
  });

  test('ne rend rien pour un autre article que celui demandé', () => {
    // Le bloc `gallery` porte l'`item_id` : le dressing du membre et les
    // articles similaires ne doivent jamais teindre la galerie de l'article.
    assert.deepEqual(photosFromHydration(docOf('item-photos'), '1234567890'), []);
  });

  test('lit aussi une fiche à photo unique', () => {
    assert.equal(photosFromHydration(docOf('item'), ITEM_ID).length, 1);
  });
});

describe('repli DOM', () => {
  test('lit les photos du carrousel, dédoublonnées', () => {
    const photos = photosFromDom(docOf('item-photos'));

    // Vinted rend le carrousel plusieurs fois (bureau, mobile, bande de
    // miniatures) : sans dédoublonnage, trois photos en produiraient quinze.
    assert.equal(photos.length, 3);
    assert.equal(new Set(photos.map((p) => p.url)).size, 3, 'photos dupliquées');
  });

  test('sert la même URL pour les trois tailles', () => {
    // Le DOM ne porte que le `f800` : la galerie reste utilisable, seule la
    // pleine résolution est perdue. Mieux vaut ça qu'aucune galerie.
    const [photo] = photosFromDom(docOf('item-photos'));
    assert.ok(photo);
    assert.equal(photo.full, photo.url);
    assert.equal(photo.thumb, photo.url);
  });
});

describe('extractPhotos', () => {
  test('préfère le flux au DOM', () => {
    const [fromFlux] = extractPhotos(docOf('item-photos'), PHOTOS_ITEM_ID) ?? [];
    const [fromDom] = photosFromDom(docOf('item-photos'));

    assert.ok(fromFlux && fromDom);
    assert.notEqual(fromFlux.full, fromDom.full, 'la pleine résolution doit venir du flux');
  });

  test('retombe sur le DOM quand le flux ne dit rien de cet article', () => {
    const photos = extractPhotos(docOf('item-photos'), '1234567890');
    assert.equal(photos?.length, 3, 'le repli DOM doit prendre le relais');
  });

  test('rend `undefined`, jamais un tableau vide, quand il n’y a pas de photo', () => {
    // La distinction n'est pas cosmétique : `mergeDetail()` ignore `undefined`
    // mais recopierait un `[]`, et un enrichissement dégradé effacerait alors
    // une galerie déjà lue. Voir shared/types.ts.
    const empty = new JSDOM('<!doctype html><html><body></body></html>').window.document;
    assert.equal(extractPhotos(empty, ITEM_ID), undefined);
  });
});
