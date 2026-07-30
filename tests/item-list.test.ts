/**
 * La liste d'articles du panneau : ce qu'une ligne affiche, et ce qui est
 * conservé d'un rendu au suivant.
 *
 * Ces deux choses n'étaient éprouvables par aucun test avant que `item-list.ts`
 * ne soit extrait de `sidepanel.ts` : ce dernier cherche ses éléments dès son
 * chargement (`required('list')`), donc l'importer hors du panneau lève avant
 * d'avoir rien pu appeler.
 *
 * Le DOM est celui de `sidepanel.html`, pas un fac-similé — un identifiant ou une
 * classe renommés dans le HTML doivent faire rougir cette suite, comme pour
 * `gallery.test.ts`.
 */
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { initItemList, renderEmpty, renderItems } from '../src/sidepanel/item-list.ts';
import type { SavedItem } from '../src/shared/types.ts';
import { makeItem } from './factories.ts';

const PANEL = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'sidepanel');

let dom: JSDOM;
let listEl: HTMLElement;

/** Ce que la liste a demandé à l'extérieur pendant le cas en cours. */
let asked: { photos: SavedItem[]; tabs: string[]; moved: SavedItem[]; removed: SavedItem[] };

before(() => {
  dom = new JSDOM(readFileSync(join(PANEL, 'sidepanel.html'), 'utf8'), {
    url: 'chrome-extension://test/sidepanel.html',
  });
  (globalThis as { document?: Document }).document = dom.window.document;
});

beforeEach(() => {
  const byId = (id: string): HTMLElement => {
    const found = dom.window.document.getElementById(id);
    if (!found) throw new Error(`sidepanel.html : #${id} introuvable`);
    return found;
  };

  listEl = byId('list');
  listEl.textContent = '';
  asked = { photos: [], tabs: [], moved: [], removed: [] };

  initItemList(
    { list: listEl, template: byId('item-template') as HTMLTemplateElement },
    {
      openPhotos: (item) => asked.photos.push(item),
      openTab: (url) => asked.tabs.push(url),
      openMoveMenu: (item) => asked.moved.push(item),
      onRemove: (item) => asked.removed.push(item),
    }
  );
});

const rows = (): HTMLElement[] => [...listEl.querySelectorAll<HTMLElement>('.item')];

/** La ligne de l'article `id`, dont le test sait qu'elle est affichée. */
function row(id: string): HTMLElement {
  const found = rows().find((el) => el.dataset.id === id);
  assert.ok(found, `aucune ligne pour l'article ${id}`);
  return found;
}

function click(el: Element): void {
  el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
}

const photo = (n: number) => ({
  thumb: `https://img.vinted.net/t/${n}/310x430/x.webp`,
  url: `https://img.vinted.net/t/${n}/f800/x.webp`,
  full: `https://img.vinted.net/tc/${n}/x.webp`,
  width: 600,
  height: 800,
});

describe('rendu d une ligne', () => {
  test('titre, lien et identifiant sont posés sur la ligne', () => {
    const item = makeItem({
      id: '42',
      title: 'Veste Barbour Bedale',
      url: 'https://www.vinted.fr/items/42-veste',
    });

    renderItems([item]);

    const el = row('42');
    const title = el.querySelector<HTMLAnchorElement>('.item-title');
    assert.equal(title?.textContent, 'Veste Barbour Bedale');
    assert.equal(title?.href, 'https://www.vinted.fr/items/42-veste');
  });

  test('les métadonnées présentes sont jointes, les absentes sautées', () => {
    renderItems([
      makeItem({ id: '1', brand: 'Nike', size: '42', condition: 'Très bon état' }),
      // Ni taille ni état : la ligne ne doit pas afficher de séparateurs vides.
      makeItem({ id: '2', brand: 'Levi’s' }),
    ]);

    assert.equal(row('1').querySelector('.item-meta')?.textContent, 'Nike · 42 · Très bon état');
    assert.equal(row('2').querySelector('.item-meta')?.textContent, 'Levi’s');
  });

  test('un article en attente de fiche le signale sans se rendre inutilisable', () => {
    renderItems([makeItem({ id: '1', pending: true })]);

    const el = row('1');
    assert.ok(el.classList.contains('item--pending'));
    assert.ok(el.querySelector('.item-loading'), "l'attente doit être visible");
    // La ligne reste manipulable : c'est tout l'intérêt de l'ajout provisoire.
    assert.equal(el.querySelector<HTMLButtonElement>('.item-remove')?.disabled, false);
  });

  test('le compteur de photos n apparaît qu au-delà d une photo', () => {
    renderItems([
      makeItem({ id: '1', images: [photo(1)] }),
      makeItem({ id: '2', images: [photo(1), photo(2), photo(3)] }),
    ]);

    assert.equal(row('1').querySelector<HTMLElement>('.item-photo-count')?.hidden, true);
    const count = row('2').querySelector<HTMLElement>('.item-photo-count');
    assert.equal(count?.hidden, false);
    assert.equal(count?.textContent, '3');
  });
});

describe('gestes d une ligne', () => {
  test('la miniature ouvre la visionneuse quand l article a des photos', () => {
    const item = makeItem({ id: '1', images: [photo(1), photo(2)] });
    renderItems([item]);

    click(row('1').querySelector('.item-thumb')!);

    assert.deepEqual(asked.photos, [item]);
    assert.deepEqual(asked.tabs, [], "la visionneuse remplace l'onglet, elle ne s'y ajoute pas");
  });

  test('sans photo lue, la miniature retombe sur l onglet Vinted', () => {
    renderItems([makeItem({ id: '1', url: 'https://www.vinted.fr/items/1-sac' })]);

    click(row('1').querySelector('.item-thumb')!);

    assert.deepEqual(asked.photos, []);
    assert.deepEqual(asked.tabs, ['https://www.vinted.fr/items/1-sac']);
  });

  test('retirer et déplacer passent la main à l appelant', () => {
    const item = makeItem({ id: '1' });
    renderItems([item]);

    click(row('1').querySelector('.item-remove')!);
    click(row('1').querySelector('.item-move')!);

    assert.deepEqual(asked.removed, [item]);
    assert.deepEqual(asked.moved, [item]);
  });
});

describe('conservation des lignes d un rendu à l autre', () => {
  test('un article inchangé garde son nœud', () => {
    renderItems([makeItem({ id: '1' }), makeItem({ id: '2' })]);
    const before = [row('1'), row('2')];

    // Objets neufs, mêmes valeurs : c'est ce que produit chaque relecture du
    // storage. Comparer les références ne servirait donc à rien.
    renderItems([makeItem({ id: '1' }), makeItem({ id: '2' })]);

    assert.equal(row('1'), before[0], 'la ligne a été recréée sans raison');
    assert.equal(row('2'), before[1]);
  });

  test('un article modifié voit sa ligne refaite, les autres non', () => {
    renderItems([makeItem({ id: '1', price: '20,00 €' }), makeItem({ id: '2' })]);
    const before = [row('1'), row('2')];

    renderItems([makeItem({ id: '1', price: '15,00 €' }), makeItem({ id: '2' })]);

    assert.notEqual(row('1'), before[0], 'le nouveau prix doit être rendu');
    assert.equal(row('2'), before[1], "l'autre ligne n'avait pas à bouger");
    assert.match(row('1').querySelector('.item-price-value')?.textContent ?? '', /15,00/);
  });

  test('l ordre demandé est celui affiché, sans recréer les lignes', () => {
    renderItems([makeItem({ id: '1' }), makeItem({ id: '2' }), makeItem({ id: '3' })]);
    const first = row('1');

    renderItems([makeItem({ id: '3' }), makeItem({ id: '1' }), makeItem({ id: '2' })]);

    assert.deepEqual(
      rows().map((el) => el.dataset.id),
      ['3', '1', '2']
    );
    assert.equal(row('1'), first, 'un déplacement ne doit pas refaire la ligne');
  });

  test('un article retiré de la liste puis remis est bien rendu à nouveau', () => {
    // Le cache est purgé des articles sortis : sans cette purge il grossirait à
    // chaque lettre tapée dans la recherche.
    renderItems([makeItem({ id: '1' }), makeItem({ id: '2' })]);
    renderItems([makeItem({ id: '1' })]);

    assert.equal(rows().length, 1);

    renderItems([makeItem({ id: '1' }), makeItem({ id: '2' })]);
    assert.deepEqual(
      rows().map((el) => el.dataset.id),
      ['1', '2']
    );
  });
});

describe('liste vide', () => {
  test('le message remplace les lignes', () => {
    renderItems([makeItem({ id: '1' })]);

    renderEmpty('Aucun résultat', 'Essaie un autre terme de recherche.');

    assert.equal(rows().length, 0);
    assert.match(listEl.querySelector('.empty')?.textContent ?? '', /Aucun résultat/);
  });

  test('les lignes reviennent après le message', () => {
    renderItems([makeItem({ id: '1' })]);
    renderEmpty('Aucun résultat', 'Essaie un autre terme.');
    renderItems([makeItem({ id: '1' })]);

    assert.equal(rows().length, 1);
    assert.equal(listEl.querySelector('.empty'), null, 'le message doit avoir disparu');
  });
});
