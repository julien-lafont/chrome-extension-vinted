/**
 * La barre d'onglets : ce qu'elle montre, et ce qu'elle laisse supprimer.
 *
 * Trois règles y sont invisibles à la lecture du rendu final et cassent en
 * silence : « Archives » se rend en icône sans compteur et toujours en dernier,
 * la croix de suppression n'apparaît sur aucun des deux onglets qui ne sont pas
 * des collections (« Mes favoris », qui récapitule tout, et « Archives »), et le
 * `+` reste au bout des collections ordinaires — donc *avant* « Archives », pas
 * après.
 *
 * Le compteur de « Mes favoris » recouvre les autres : un article classé compte
 * des deux côtés. C'est le cœur du récapitulatif, et une répartition exclusive
 * est précisément ce qu'on ne veut plus.
 *
 * Comme `item-list.test.ts`, cette suite n'était pas écrivable tant que le rendu
 * vivait dans `sidepanel.ts`, qui exige le DOM du panneau dès son chargement.
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { renderCollectionsBar } from '../src/sidepanel/collections-bar.ts';
import {
  ARCHIVE_COLLECTION_ID,
  DEFAULT_COLLECTION_ID,
  makeArchiveCollection,
  makeDefaultCollection,
} from '../src/shared/collections.ts';
import type { Collection, CollectionMap, SavedItem } from '../src/shared/types.ts';
import { makeItem } from './factories.ts';

let dom: JSDOM;
let bar: HTMLElement;
let asked: { selected: string[]; deleted: Collection[]; renamed: Collection[]; created: number };

const collection = (id: string, name: string, createdAt = 1): Collection => ({
  id,
  name,
  createdAt,
  order: [],
});

function paint(
  collections: CollectionMap,
  items: SavedItem[] = [],
  activeId = DEFAULT_COLLECTION_ID
): void {
  renderCollectionsBar(
    bar,
    { collections, items, activeCollectionId: activeId },
    {
      onSelect: (id) => asked.selected.push(id),
      onDelete: (c) => asked.deleted.push(c),
      onContextMenu: (c) => asked.renamed.push(c),
      onCreate: () => (asked.created += 1),
    }
  );
}

const tabs = (): HTMLElement[] => [...bar.querySelectorAll<HTMLElement>('.tab')];
const tabNames = (): string[] =>
  tabs().map((el) => el.querySelector('.tab-name')?.textContent ?? '');

/** L'onglet de la collection `id`, dont le test sait qu'il est affiché. */
function tab(id: string): HTMLElement {
  const found = tabs().find((el) => el.dataset.dropCollection === id);
  assert.ok(found, `aucun onglet pour la collection ${id}`);
  return found;
}

function click(el: Element): void {
  el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
}

beforeEach(() => {
  dom = new JSDOM('<nav id="collections"></nav>');
  (globalThis as { document?: Document }).document = dom.window.document;

  const el = dom.window.document.getElementById('collections');
  assert.ok(el);
  bar = el;
  asked = { selected: [], deleted: [], renamed: [], created: 0 };
});

describe('affichage de la barre', () => {
  test('chaque collection porte son nom, et « Mes favoris » compte tout', () => {
    const jeans = collection('col-1', 'Jeans');
    paint({ [DEFAULT_COLLECTION_ID]: makeDefaultCollection(), [jeans.id]: jeans }, [
      makeItem({ id: '1' }),
      makeItem({ id: '2', collectionId: jeans.id }),
      makeItem({ id: '3', collectionId: jeans.id }),
    ]);

    assert.deepEqual(tabNames(), ['Mes favoris', 'Jeans']);
    assert.equal(
      tab(DEFAULT_COLLECTION_ID).querySelector('.tab-count')?.textContent,
      '3',
      'les classés comptent aussi dans le récapitulatif'
    );
    assert.equal(tab('col-1').querySelector('.tab-count')?.textContent, '2');
  });

  test('les archivés sont les seuls à ne pas compter dans « Mes favoris »', () => {
    paint(
      {
        [DEFAULT_COLLECTION_ID]: makeDefaultCollection(),
        [ARCHIVE_COLLECTION_ID]: makeArchiveCollection(),
      },
      [makeItem({ id: '1' }), makeItem({ id: '2', collectionId: ARCHIVE_COLLECTION_ID })]
    );

    assert.equal(tab(DEFAULT_COLLECTION_ID).querySelector('.tab-count')?.textContent, '1');
  });

  test('une référence vers une collection supprimée compte comme non classée', () => {
    paint({ [DEFAULT_COLLECTION_ID]: makeDefaultCollection() }, [
      makeItem({ id: '1', collectionId: 'col-disparue' }),
      // Ce qu'écrivaient les versions où « Mes favoris » était une collection.
      makeItem({ id: '2', collectionId: DEFAULT_COLLECTION_ID }),
    ]);

    assert.equal(tab(DEFAULT_COLLECTION_ID).querySelector('.tab-count')?.textContent, '2');
  });

  test('la collection active est la seule marquée', () => {
    const jeans = collection('col-1', 'Jeans');
    paint({ [DEFAULT_COLLECTION_ID]: makeDefaultCollection(), [jeans.id]: jeans }, [], jeans.id);

    assert.equal(tab('col-1').classList.contains('active'), true);
    assert.equal(tab(DEFAULT_COLLECTION_ID).classList.contains('active'), false);
  });

  test('« Archives » est en dernier, en icône, sans compteur', () => {
    // Sa date de création est celle du premier archivage : une collection créée
    // après elle la doublerait si l'ordre suivait le calendrier.
    const recente = collection('col-1', 'Créée après', Date.now() + 1000);
    paint({
      [DEFAULT_COLLECTION_ID]: makeDefaultCollection(),
      [ARCHIVE_COLLECTION_ID]: makeArchiveCollection(),
      [recente.id]: recente,
    });

    assert.deepEqual(tabNames(), ['Mes favoris', 'Créée après', '🗄️']);
    assert.equal(tab(ARCHIVE_COLLECTION_ID).querySelector('.tab-count'), null);
    assert.equal(
      tab(ARCHIVE_COLLECTION_ID).querySelector('.tab-select')?.getAttribute('aria-label'),
      'Archives'
    );
  });

  test('le bouton + reste avant « Archives »', () => {
    paint({
      [DEFAULT_COLLECTION_ID]: makeDefaultCollection(),
      [ARCHIVE_COLLECTION_ID]: makeArchiveCollection(),
    });

    const children = [...bar.children];
    const plus = children.findIndex((el) => el.classList.contains('tab-add'));
    const archive = children.findIndex((el) => el.classList.contains('tab-archive'));

    assert.ok(plus >= 0 && archive >= 0);
    assert.ok(plus < archive, 'le + doit précéder « Archives »');
    assert.equal(children.at(-1)?.classList.contains('tab-archive'), true);
  });
});

describe('suppression d une collection', () => {
  test('une collection vide porte sa croix', () => {
    const jeans = collection('col-1', 'Jeans');
    paint({ [DEFAULT_COLLECTION_ID]: makeDefaultCollection(), [jeans.id]: jeans });

    const remove = tab('col-1').querySelector('.tab-delete');
    assert.ok(remove, 'la croix devrait être là');

    click(remove);
    assert.deepEqual(asked.deleted, [jeans]);
  });

  test('une collection habitée la porte aussi : ses articles restent aux favoris', () => {
    const jeans = collection('col-1', 'Jeans');
    paint({ [DEFAULT_COLLECTION_ID]: makeDefaultCollection(), [jeans.id]: jeans }, [
      makeItem({ id: '1', collectionId: jeans.id }),
    ]);

    const remove = tab('col-1').querySelector('.tab-delete');
    assert.ok(remove, 'supprimer ne fait plus perdre d’article : la croix reste offerte');
    // Le titre annonce la conséquence ; la confirmation, elle, est au panneau.
    assert.match(remove.getAttribute('title') ?? '', /restent dans « Mes favoris »/);

    click(remove);
    assert.deepEqual(asked.deleted, [jeans]);
  });

  test('ni « Mes favoris » ni « Archives », même vides', () => {
    paint({
      [DEFAULT_COLLECTION_ID]: makeDefaultCollection(),
      [ARCHIVE_COLLECTION_ID]: makeArchiveCollection(),
    });

    assert.equal(tab(DEFAULT_COLLECTION_ID).querySelector('.tab-delete'), null);
    assert.equal(tab(ARCHIVE_COLLECTION_ID).querySelector('.tab-delete'), null);
  });
});

describe('gestes de la barre', () => {
  test('cliquer un onglet demande le changement de collection', () => {
    const jeans = collection('col-1', 'Jeans');
    paint({ [DEFAULT_COLLECTION_ID]: makeDefaultCollection(), [jeans.id]: jeans });

    click(tab('col-1').querySelector('.tab-select')!);
    assert.deepEqual(asked.selected, ['col-1']);
  });

  test('le clic droit propose le renommage, sauf sur « Archives »', () => {
    const jeans = collection('col-1', 'Jeans');
    paint({
      [DEFAULT_COLLECTION_ID]: makeDefaultCollection(),
      [ARCHIVE_COLLECTION_ID]: makeArchiveCollection(),
      [jeans.id]: jeans,
    });

    const menu = (el: Element): void => {
      el.dispatchEvent(
        new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true })
      );
    };

    menu(tab('col-1'));
    menu(tab(ARCHIVE_COLLECTION_ID));

    // Renommer « Archives » n'aurait aucun effet visible : son onglet ne montre
    // que son icône.
    assert.deepEqual(asked.renamed, [jeans]);
  });

  test('le + demande une nouvelle collection', () => {
    paint({ [DEFAULT_COLLECTION_ID]: makeDefaultCollection() });

    click(bar.querySelector('.tab-add')!);
    assert.equal(asked.created, 1);
  });
});
