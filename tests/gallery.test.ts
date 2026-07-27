/**
 * La visionneuse montre-t-elle la bonne photo, à la bonne qualité ?
 *
 * Deux comportements ne se voient pas à l'œil et cassent en silence :
 *
 *   — la **course** entre le chargement de la pleine résolution et la
 *     navigation. `full` pèse quatre fois `url` ; si l'utilisateur passe à la
 *     photo suivante pendant ce chargement, l'événement `load` arrive après la
 *     navigation et remplacerait la photo affichée par la pleine résolution de
 *     la **précédente**. Rien dans l'événement ne dit à quelle photo il se
 *     rapporte ;
 *   — le repli quand `full` échoue (URL signée expirée) : la version affichée
 *     doit rester à l'écran, pas laisser un cadre vide.
 *
 * Le DOM est celui de `sidepanel.html`, pas un fac-similé : un identifiant
 * renommé dans le HTML doit faire rougir cette suite.
 */
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initGallery, openGallery, type GalleryElements } from '../src/sidepanel/gallery.ts';
import type { ItemPhoto, SavedItem } from '../src/shared/types.ts';
import { makeItem } from './factories.ts';

const PANEL = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'sidepanel');

/**
 * Chargement d'image en attente. jsdom ne va pas sur le réseau : sans ce faux,
 * `load` n'arriverait jamais et la substitution de la pleine résolution serait
 * intestable — le test conclurait à tort qu'elle n'a pas lieu.
 */
type Pending = { src: string; load: () => void; fail: () => void };
let loading: Pending[] = [];

let dom: JSDOM;
let el: GalleryElements;

const photo = (n: number, dominant?: string): ItemPhoto => ({
  thumb: `https://img.vinted.net/t/${n}/310x430/x.webp?s=aaa${n}`,
  url: `https://img.vinted.net/t/${n}/f800/x.webp?s=bbb${n}`,
  full: `https://img.vinted.net/tc/${n}/x.webp?s=ccc${n}`,
  width: 600,
  height: 800,
  ...(dominant ? { dominantColor: dominant } : {}),
});

const itemWith = (count: number): SavedItem =>
  makeItem({
    id: '42',
    title: 'Sac à dos Nike rose',
    url: 'https://www.vinted.fr/items/42-sac',
    images: Array.from({ length: count }, (_, i) => photo(i + 1)),
  });

const overlayOpen = (): boolean => !el.overlay.hidden;
const thumbs = (): HTMLElement[] => [...el.thumbs.children].map((node) => node as HTMLElement);

/** La miniature de rang `position`, dont le test sait qu'elle existe. */
function thumbAt(position: number): HTMLElement {
  const found = thumbs()[position];
  if (!found) throw new Error(`miniature ${position} absente`);
  return found;
}

/** Le chargement de pleine résolution en cours pour cette URL, s'il y en a un. */
const pendingFor = (url: string): Pending | undefined => loading.find((p) => p.src === url);

before(() => {
  dom = new JSDOM(readFileSync(join(PANEL, 'sidepanel.html'), 'utf8'), {
    url: 'chrome-extension://test/sidepanel.html',
  });

  const window = dom.window;
  const byId = (id: string): HTMLElement => {
    const found = window.document.getElementById(id);
    if (!found) throw new Error(`sidepanel.html : #${id} introuvable`);
    return found;
  };

  // `gallery.ts` parle à `document` et à `Image` comme le fait le panneau.
  (globalThis as { document?: Document }).document = window.document;

  // Faux `Image` : il retient la source demandée et laisse le test décider du
  // moment où elle aboutit — c'est exactement ce que la course a besoin de
  // pouvoir intercaler.
  class FakeImage {
    #src = '';
    #handlers: Record<string, (() => void)[]> = {};

    addEventListener(type: string, fn: () => void): void {
      (this.#handlers[type] ??= []).push(fn);
    }

    get src(): string {
      return this.#src;
    }

    set src(value: string) {
      this.#src = value;
      if (!value) return;

      const fire = (type: string): void => {
        loading = loading.filter((p) => p.src !== value);
        for (const fn of this.#handlers[type] ?? []) fn();
      };

      loading.push({ src: value, load: () => fire('load'), fail: () => fire('error') });
    }
  }

  (globalThis as { Image?: unknown }).Image = FakeImage;

  el = {
    overlay: byId('gallery-dialog'),
    image: byId('gallery-image') as HTMLImageElement,
    stage: byId('gallery-stage'),
    thumbs: byId('gallery-thumbs'),
    title: byId('gallery-title'),
    counter: byId('gallery-counter'),
    link: byId('gallery-link') as HTMLAnchorElement,
    prev: byId('gallery-prev') as HTMLButtonElement,
    next: byId('gallery-next') as HTMLButtonElement,
  };

  initGallery(el);
});

beforeEach(() => {
  loading = [];
  el.overlay.hidden = true;
});

const press = (key: string): void => {
  dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key }));
};

const click = (target: HTMLElement): void => {
  target.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
};

describe('ouverture', () => {
  test('affiche la première photo et sa bande de miniatures', () => {
    const item = itemWith(3);
    openGallery(item);

    assert.ok(overlayOpen(), 'la visionneuse doit s’ouvrir');
    assert.equal(el.image.src, item.images?.[0]?.url);
    assert.equal(el.counter.textContent, '1 / 3');
    assert.equal(el.title.textContent, item.title);
    assert.equal(el.link.href, item.url);

    assert.equal(thumbs().length, 3);
    assert.ok(thumbs()[0]?.classList.contains('is-current'));
  });

  test('une photo unique n’affiche ni flèches ni miniatures', () => {
    openGallery(itemWith(1));

    assert.equal(el.prev.hidden, true, 'flèche précédente inutile');
    assert.equal(el.next.hidden, true, 'flèche suivante inutile');
    assert.equal(el.thumbs.hidden, true, 'bande de miniatures inutile');
    assert.equal(el.counter.textContent, '1 / 1');
  });

  test('un article sans galerie n’ouvre rien', () => {
    // Les articles enregistrés avant la 0.3 n'ont pas de photos : la miniature
    // retombe sur l'onglet Vinted, et la visionneuse ne doit pas s'ouvrir vide.
    openGallery(makeItem({ id: '7' }));
    assert.equal(overlayOpen(), false);
  });
});

describe('navigation', () => {
  test('les flèches avancent, reculent et bouclent', () => {
    openGallery(itemWith(3));

    click(el.next);
    assert.equal(el.counter.textContent, '2 / 3');

    click(el.prev);
    assert.equal(el.counter.textContent, '1 / 3');

    // Reculer depuis la première mène à la dernière, sans cul-de-sac.
    click(el.prev);
    assert.equal(el.counter.textContent, '3 / 3');

    click(el.next);
    assert.equal(el.counter.textContent, '1 / 3');
  });

  test('le clavier ne pilote la visionneuse que lorsqu’elle est ouverte', () => {
    openGallery(itemWith(3));
    press('ArrowRight');
    assert.equal(el.counter.textContent, '2 / 3');

    // Fermée, les flèches appartiennent à la liste et au champ de recherche.
    el.overlay.hidden = true;
    press('ArrowRight');
    assert.equal(el.counter.textContent, '2 / 3', 'la visionneuse a réagi fermée');
  });

  test('une miniature saute directement à sa photo', () => {
    const item = itemWith(3);
    openGallery(item);

    click(thumbAt(2));

    assert.equal(el.image.src, item.images?.[2]?.url);
    assert.equal(thumbs()[2]?.classList.contains('is-current'), true);
    assert.equal(thumbs()[0]?.classList.contains('is-current'), false);
  });

  test('ouvre le fond sur la couleur dominante de la photo', () => {
    const item = makeItem({ id: '9', images: [photo(1, '#cd98c1')] });
    openGallery(item);

    // Pendant que la photo charge, un cadre gris tranche sur une image colorée :
    // le flux donne la dominante, autant s'en servir. Le DOM normalise la
    // notation hexadécimale en `rgb()`.
    assert.equal(el.stage.style.background, 'rgb(205, 152, 193)');
    assert.equal(el.stage.style.aspectRatio, '600/800');
  });
});

describe('pleine résolution', () => {
  test('remplace la taille d’affichage une fois chargée', () => {
    const item = itemWith(3);
    openGallery(item);

    const [first] = item.images ?? [];
    assert.ok(first);
    assert.equal(el.image.src, first.url, 'la taille d’affichage doit venir en premier');

    pendingFor(first.full)?.load();
    assert.equal(el.image.src, first.full, 'la pleine résolution n’a pas pris le relais');
  });

  test('ne s’applique pas à la photo qu’on vient de quitter', () => {
    const item = itemWith(3);
    openGallery(item);

    const [first, second] = item.images ?? [];
    assert.ok(first && second);

    // La course : on navigue pendant que la pleine résolution de la 1 charge.
    const late = pendingFor(first.full);
    click(el.next);
    assert.equal(el.image.src, second.url);

    late?.load();
    assert.equal(el.image.src, second.url, 'la photo précédente s’est affichée par-dessus');
  });

  test('un échec laisse la photo affichée en place', () => {
    const item = itemWith(2);
    openGallery(item);

    const [first] = item.images ?? [];
    assert.ok(first);

    // URL signée expirée, réseau coupé : il n'y a rien de mieux à montrer que
    // ce qui est déjà à l'écran.
    pendingFor(first.full)?.fail();
    assert.equal(el.image.src, first.url);
  });

  test('ne redemande pas une image déjà à l’écran', () => {
    // Le repli DOM sert la même URL pour les trois tailles ; et à une seule
    // photo, la « suivante » à précharger est la photo courante. Les deux
    // ensemble faisaient demander trois fois la même image à l'ouverture.
    const same = 'https://img.vinted.net/t/1/f800/x.webp?s=bbb1';
    openGallery(makeItem({ id: '5', images: [{ thumb: same, url: same, full: same }] }));

    assert.equal(loading.length, 0, `chargements redondants : ${loading.length}`);
  });

  test('précharge la photo suivante, sans monter en résolution pour rien', () => {
    const same = (n: number): ItemPhoto => {
      const url = `https://img.vinted.net/t/${n}/f800/x.webp?s=bbb${n}`;
      return { thumb: url, url, full: url };
    };
    openGallery(makeItem({ id: '6', images: [same(1), same(2)] }));

    // La 2 est demandée d'avance ; la 1 est déjà affichée et n'a pas de
    // meilleure qualité à charger.
    assert.deepEqual(
      loading.map((p) => p.src),
      [same(2).url]
    );
  });
});
