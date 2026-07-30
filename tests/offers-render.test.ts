/**
 * Rendu des offres dans le panneau — `docs/specs/offres.md` §5.
 *
 * Deux zones, deux fichiers de production, une seule suite : le badge de la
 * ligne d'article (`item-render.ts`) et l'onglet de la barre
 * (`collections-bar.ts`). Ni l'un ni l'autre ne touche à `chrome` — on monte
 * `sidepanel.html` en jsdom et on lit ce qui a été écrit, comme
 * `watch-render.test.ts`.
 *
 * Ce qui casserait en silence, et que la suite verrouille : l'ancienneté est
 * **recalculée** à partir de la date d'envoi (un badge figé sur « il y a 3 h »
 * pendant une journée est indétectable à la relecture du code), et l'onglet ne
 * compte que les offres qui appellent encore une décision.
 */
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderOffer, refreshOfferAges } from '../src/sidepanel/item-render.ts';
import { renderCollectionsBar } from '../src/sidepanel/collections-bar.ts';
import {
  DEFAULT_COLLECTION_ID,
  OFFERS_VIEW_ID,
  makeArchiveCollection,
  makeDefaultCollection,
} from '../src/shared/collections.ts';
import type { CollectionMap, ItemOffer, SavedItem } from '../src/shared/types.ts';
import { makeItem } from './factories.ts';

const PANEL = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'sidepanel');

let dom: JSDOM;
let template: HTMLTemplateElement;

before(() => {
  dom = new JSDOM(readFileSync(join(PANEL, 'sidepanel.html'), 'utf8'), {
    url: 'chrome-extension://test/sidepanel.html',
  });
  (globalThis as { document?: Document }).document = dom.window.document;

  const found = dom.window.document.getElementById('item-template');
  if (!found) throw new Error('sidepanel.html : #item-template introuvable');
  template = found as unknown as HTMLTemplateElement;
});

const MINUTE = 60000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function offer(overrides: Partial<ItemOffer> = {}): ItemOffer {
  return {
    by: 'me',
    price: 399,
    at: Date.now() - 3 * HOUR,
    status: 'pending',
    conversationId: '24027793606',
    ...overrides,
  };
}

/** Clone la ligne d'article et y applique le rendu testé. */
function mount(item: SavedItem): { badge: HTMLButtonElement; opened: string[] } {
  const opened: string[] = [];
  const node = template.content.cloneNode(true) as DocumentFragment;
  renderOffer(node, item, (url) => opened.push(url));

  const badge = node.querySelector<HTMLButtonElement>('.item-offer');
  if (!badge) throw new Error('item-template : .item-offer introuvable');
  return { badge, opened };
}

describe('badge d’offre', () => {
  test('aucune offre : aucun badge, la ligne reste celle d’un article ordinaire', () => {
    const { badge } = mount(makeItem({ id: '1' }));
    assert.equal(badge.hidden, true);
  });

  test('mon offre en attente : prix proposé et ancienneté', () => {
    const { badge } = mount(makeItem({ id: '1', offer: offer() }));

    assert.equal(badge.hidden, false);
    assert.match(badge.textContent ?? '', /^Offre 399,00\s*€ · il y a 3 h$/u);
    assert.ok(badge.classList.contains('item-offer--live'));
  });

  test('une proposition du vendeur se nomme autrement', () => {
    const { badge } = mount(makeItem({ id: '1', offer: offer({ by: 'seller', price: 205 }) }));

    assert.match(badge.textContent ?? '', /^Vendeur 205,00\s*€/u);
    assert.equal(badge.title, 'Proposition du vendeur — ouvrir la conversation');
  });

  test('une offre refusée reste affichée, grisée', () => {
    // « Déjà tenté à 42 € » évite de refaire la même offre au même vendeur.
    const { badge } = mount(
      makeItem({
        id: '1',
        offer: offer({ status: 'rejected', price: 42, at: Date.now() - 9 * DAY }),
      })
    );

    assert.equal(badge.hidden, false);
    assert.match(badge.textContent ?? '', /^Offre refusée 42,00\s*€ · il y a 9 j$/u);
    assert.ok(badge.classList.contains('item-offer--dead'));
    assert.ok(!badge.classList.contains('item-offer--live'));
  });

  test('le badge ouvre la conversation d’origine', () => {
    const { badge, opened } = mount(makeItem({ id: '1', offer: offer() }));
    badge.dispatchEvent(new dom.window.Event('click'));

    assert.deepEqual(opened, ['https://www.vinted.fr/inbox/24027793606']);
  });

  test('les paliers d’ancienneté, du plus frais au plus vieux', () => {
    const cases: [number, RegExp][] = [
      [20000, /à l'instant$/u],
      [20 * MINUTE, /il y a 20 min$/u],
      [3 * HOUR, /il y a 3 h$/u],
      [2 * DAY + 3 * HOUR, /il y a 2 j$/u],
      [9 * DAY, /il y a 9 j$/u],
    ];

    for (const [age, expected] of cases) {
      const { badge } = mount(makeItem({ id: '1', offer: offer({ at: Date.now() - age }) }));
      assert.match(badge.textContent ?? '', expected, `âge ${age} ms`);
    }
  });
});

describe('refreshOfferAges', () => {
  test('recompose l’ancienneté sans toucher au reste du badge', () => {
    const container = dom.window.document.createElement('div');
    const node = template.content.cloneNode(true) as DocumentFragment;
    renderOffer(node, makeItem({ id: '1', offer: offer({ at: Date.now() }) }), () => {});
    container.append(node);

    const badge = container.querySelector<HTMLElement>('.item-offer');
    assert.match(badge?.textContent ?? '', /à l'instant$/u);

    // Le panneau est resté ouvert : seule la date de référence a vieilli, et
    // c'est bien depuis elle — pas depuis le texte affiché — que le libellé se
    // recalcule.
    badge!.dataset.offerAt = String(Date.now() - 4 * HOUR);
    refreshOfferAges(container);

    assert.match(badge?.textContent ?? '', /^Offre 399,00\s*€ · il y a 4 h$/u);
  });

  test('ne touche à rien quand aucun badge n’est affiché', () => {
    const container = dom.window.document.createElement('div');
    container.innerHTML = '<p class="item-price"><span class="item-price-value">10 €</span></p>';

    refreshOfferAges(container);

    assert.equal(container.querySelector('.item-price-value')?.textContent, '10 €');
  });
});

describe('onglet « Sous offres »', () => {
  let bar: HTMLElement;
  let selected: string[];

  const collections = (): CollectionMap => ({
    [DEFAULT_COLLECTION_ID]: makeDefaultCollection(),
  });

  function paint(items: SavedItem[], activeId = DEFAULT_COLLECTION_ID, map = collections()): void {
    renderCollectionsBar(
      bar,
      { collections: map, items, activeCollectionId: activeId },
      {
        onSelect: (id) => selected.push(id),
        onDelete: () => {},
        onContextMenu: () => {},
        onCreate: () => {},
      }
    );
  }

  const offersTab = () => bar.querySelector<HTMLElement>('.tab-offers');

  beforeEach(() => {
    bar = dom.window.document.createElement('nav');
    selected = [];
  });

  test('absent tant qu’aucun article n’a d’offre', () => {
    paint([makeItem({ id: '1' })]);
    assert.equal(offersTab(), null);
  });

  test('présent dès qu’une offre existe, avec le nombre d’offres en cours', () => {
    paint([
      makeItem({ id: '1', offer: offer() }),
      makeItem({ id: '2', offer: offer({ by: 'seller' }) }),
      makeItem({ id: '3', offer: offer({ status: 'rejected' }) }),
      makeItem({ id: '4' }),
    ]);

    assert.equal(offersTab()?.querySelector('.tab-name')?.textContent, '💸');
    // Les deux offres en attente ; la refusée n'appelle plus de décision.
    assert.equal(offersTab()?.querySelector('.tab-count')?.textContent, '2');
  });

  test('un article vendu ne compte plus, même sous offre', () => {
    paint([
      makeItem({ id: '1', offer: offer(), status: 'sold' }),
      makeItem({ id: '2', offer: offer() }),
    ]);

    assert.equal(offersTab()?.querySelector('.tab-count')?.textContent, '1');
  });

  test('l’onglet reste, à zéro, quand toutes les offres sont éteintes', () => {
    // Le compteur à zéro est une information : « plus rien en cours ».
    paint([makeItem({ id: '1', offer: offer({ status: 'accepted' }) })]);

    assert.equal(offersTab()?.querySelector('.tab-count')?.textContent, '0');
  });

  test('rien ne s’y dépose : c’est une vue, pas une collection', () => {
    paint([makeItem({ id: '1', offer: offer() })]);

    const tab = offersTab();
    assert.equal(tab?.dataset.dropCollection, undefined);
    assert.equal(tab?.querySelector('.tab-delete'), null);
  });

  test('se place juste avant « Archives », au bout de la barre', () => {
    const map = collections();
    map.archives = makeArchiveCollection();

    paint([makeItem({ id: '1', offer: offer() })], DEFAULT_COLLECTION_ID, map);

    const classes = [...bar.querySelectorAll('.tab')].map((el) => el.className);
    assert.deepEqual(classes.slice(-2), ['tab tab-offers', 'tab tab-archive']);
  });

  test('le clic demande la vue, pas une collection', () => {
    paint([makeItem({ id: '1', offer: offer() })]);
    offersTab()?.querySelector('button')?.dispatchEvent(new dom.window.Event('click'));

    assert.deepEqual(selected, [OFFERS_VIEW_ID]);
  });

  test('l’onglet actif est marqué quand la vue est ouverte', () => {
    paint([makeItem({ id: '1', offer: offer() })], OFFERS_VIEW_ID);
    assert.ok(offersTab()?.classList.contains('active'));
  });
});
