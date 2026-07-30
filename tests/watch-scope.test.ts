/**
 * Portée du bouton « Rafraîchir » : clic court sur la collection affichée, appui
 * long sur toutes les collections — `docs/specs/suivi-prix.md` §5.1 bis.
 *
 * Deux choses s'y jouent, et la seconde est celle qui casse en silence :
 *
 * 1. **la portée** — un appui long doit envoyer les articles de *toutes* les
 *    collections, sans les vendus ni les disparus, qu'aucun cycle ne fera
 *    changer d'avis ;
 * 2. **le geste** — ce bouton a une histoire de « je clique et rien ne se
 *    passe ». Ajouter un appui long, c'est ajouter des façons de perdre un clic
 *    : le `click` que le navigateur émet après le `pointerup` ne doit pas lancer
 *    un second cycle, et un pointeur qui tremble pendant l'appui doit toujours
 *    produire un rafraîchissement — celui de la collection affichée.
 *
 * Montage repris de `watch-tabs.test.ts` : le vrai `sidepanel.html` en jsdom, le
 * faux `chrome`, et un DOM neuf par cas (`initWatch()` s'abonne au bouton qu'on
 * lui passe).
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installFakeChrome, type FakeChrome, type FakeTab } from './fake-chrome.ts';
import { uninstallFakeChrome } from './fake-chrome.ts';
import { initWatch } from '../src/sidepanel/watch.ts';
import type { SavedItem, WatchState } from '../src/shared/types.ts';
import { makeItem } from './factories.ts';

const HTML = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'sidepanel', 'sidepanel.html'),
  'utf8'
);

const tick = (ms = 20): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const vinted = (id: number, windowId: number, active: boolean): FakeTab => ({
  id,
  url: `https://www.vinted.fr/items/${id}-un-article`,
  active,
  windowId,
});

/**
 * Au-delà du seuil de `watch.ts` (480 ms), avec de la marge : c'est un vrai
 * minuteur, pas une horloge simulée.
 */
const OVER_THRESHOLD_MS = 620;

/** En deçà — un clic appuyé, pas un appui long. */
const UNDER_THRESHOLD_MS = 200;

type Panel = {
  button: HTMLButtonElement;
  label: HTMLElement;
  notice: HTMLElement;
  flashes: string[];
  /** Clic souris complet, tel que le navigateur l'émet : down, up, puis click. */
  click: (options?: { altKey?: boolean }) => Promise<void>;
  /** Appui maintenu au-delà du seuil, puis relâché — et son `click` d'écho. */
  pressLong: () => Promise<void>;
  /** Appui qui glisse : le pointeur bouge de plus de 10 px avant le seuil. */
  pressAndDrag: () => Promise<void>;
  /** Activation au clavier : un `click` sans geste pointeur avant lui. */
  keyboard: (options?: { altKey?: boolean }) => Promise<void>;
};

let log: typeof console.log;

beforeEach(() => {
  log = console.log;
  console.log = () => {};
});

afterEach(() => {
  console.log = log;
  uninstallFakeChrome();
});

/**
 * @param visible ce que la collection affichée montre — ce que vise le clic court
 * @param all tout ce qui est enregistré ; par défaut, la collection affichée
 */
async function mount(visible: SavedItem[], all: SavedItem[] = visible): Promise<Panel> {
  const dom = new JSDOM(HTML, { url: 'chrome-extension://test/sidepanel.html' });
  const { window } = dom;
  const byId = (id: string): HTMLElement => {
    const found = window.document.getElementById(id);
    if (!found) throw new Error(`sidepanel.html : #${id} introuvable`);
    return found;
  };

  const button = byId('refresh') as HTMLButtonElement;

  // jsdom ne connaît pas `PointerEvent` ; `MouseEvent` porte tout ce que le
  // geste lit (bouton, coordonnées, altKey) et se propage pareil.
  const down = (options: Record<string, unknown> = {}): void => {
    button.dispatchEvent(
      new window.MouseEvent('pointerdown', { bubbles: true, button: 0, ...options })
    );
  };
  const up = (): void => {
    window.document.dispatchEvent(new window.MouseEvent('pointerup', { bubbles: true }));
  };
  const echo = (options: Record<string, unknown> = {}): void => {
    button.dispatchEvent(new window.MouseEvent('click', { bubbles: true, detail: 1, ...options }));
  };

  const panel: Panel = {
    button,
    label: byId('refresh-label'),
    notice: byId('watch-notice'),
    flashes: [],

    async click(options = {}) {
      down(options);
      await tick(UNDER_THRESHOLD_MS);
      up();
      echo(options);
      await tick(80);
    },

    async pressLong() {
      down({ clientX: 100, clientY: 100 });
      await tick(OVER_THRESHOLD_MS);
      up();
      echo();
      await tick(80);
    },

    async pressAndDrag() {
      down({ clientX: 100, clientY: 100 });
      await tick(120);
      window.document.dispatchEvent(
        new window.MouseEvent('pointermove', { bubbles: true, clientX: 100, clientY: 160 })
      );
      await tick(OVER_THRESHOLD_MS);
      up();
      echo();
      await tick(80);
    },

    async keyboard(options = {}) {
      // `detail: 0` : c'est ce qui distingue Entrée / Espace d'un clic souris.
      button.dispatchEvent(
        new window.MouseEvent('click', { bubbles: true, detail: 0, ...options })
      );
      await tick(80);
    },
  };

  initWatch(
    { button, label: panel.label, notice: panel.notice },
    {
      visibleIds: () => visible.map((item) => item.id),
      getItems: () => all,
      onFlash: (message) => panel.flashes.push(message),
    }
  );

  await tick();
  return panel;
}

/** Les `VF_WATCH_START` envoyés, dans l'ordre, avec les articles demandés. */
function starts(fake: FakeChrome): string[][] {
  return fake.tabs.sent
    .filter((call) => call.message.type === 'VF_WATCH_START')
    .map((call) => call.message.ids ?? []);
}

/** Un onglet Vinted sous les yeux, qui accepte tout : le cas courant. */
function ready(store: Record<string, unknown> = {}): FakeChrome {
  return installFakeChrome(store, {
    tabs: [vinted(1, 1, true)],
    currentWindowId: 1,
    respond: () => ({ accepted: true }),
  });
}

describe('appui long : toutes les collections', () => {
  test('envoie les articles de toutes les collections, pas seulement ceux affichés', async () => {
    const fake = ready();
    const visible = [makeItem({ id: '1' }), makeItem({ id: '2' })];
    const all = [...visible, makeItem({ id: '3' }), makeItem({ id: '4' })];

    const panel = await mount(visible, all);
    await panel.pressLong();

    assert.equal(starts(fake).length, 1, 'un seul cycle, pas un par événement du geste');
    assert.deepEqual(
      [...(starts(fake)[0] ?? [])].sort(),
      ['1', '2', '3', '4'],
      'l’appui long doit dépasser la collection affichée'
    );
  });

  test('le clic court s’en tient à la collection affichée', async () => {
    const fake = ready();
    const visible = [makeItem({ id: '1' })];

    const panel = await mount(visible, [...visible, makeItem({ id: '3' })]);
    await panel.click();

    assert.deepEqual(starts(fake), [['1']]);
  });

  test('laisse de côté vendus, disparus et articles en attente', async () => {
    // Ce sont les trois états qu'aucun cycle ne fera changer d'avis : à
    // l'échelle de toutes les collections, les envoyer brûlerait le débit (§3.2)
    // pour des verdicts déjà connus.
    const fake = ready();
    const visible = [makeItem({ id: '1' })];
    const all = [
      ...visible,
      makeItem({ id: '2', status: 'sold' }),
      makeItem({ id: '3', status: 'gone' }),
      makeItem({ id: '4', pending: true }),
      makeItem({ id: '5' }),
    ];

    const panel = await mount(visible, all);
    await panel.pressLong();

    assert.deepEqual([...(starts(fake)[0] ?? [])].sort(), ['1', '5']);
  });

  test('le dit, avec le nombre d’articles', async () => {
    ready();
    const visible = [makeItem({ id: '1' })];
    const all = [...visible, makeItem({ id: '2' }), makeItem({ id: '3' })];

    const panel = await mount(visible, all);
    await panel.pressLong();

    assert.match(panel.flashes.join(' '), /toutes les collections \(3 articles\)/);
  });

  test('sans aucun article éligible, le geste ne part pas dans le vide', async () => {
    const fake = ready();
    const all = [makeItem({ id: '1', status: 'sold' })];

    const panel = await mount([], all);
    await panel.pressLong();

    assert.deepEqual(starts(fake), []);
    assert.match(panel.flashes.join(' '), /Aucun article à rafraîchir/);
  });

  test('Alt+clic mène au même endroit, sans l’attente', async () => {
    const fake = ready();
    const visible = [makeItem({ id: '1' })];

    const panel = await mount(visible, [...visible, makeItem({ id: '2' })]);
    await panel.click({ altKey: true });

    assert.deepEqual([...(starts(fake)[0] ?? [])].sort(), ['1', '2']);
  });

  test('Alt+Entrée aussi, seul chemin clavier vers les autres collections', async () => {
    const fake = ready();
    const visible = [makeItem({ id: '1' })];

    const panel = await mount(visible, [...visible, makeItem({ id: '2' })]);
    await panel.keyboard({ altKey: true });

    assert.deepEqual([...(starts(fake)[0] ?? [])].sort(), ['1', '2']);
  });
});

describe('le geste ne perd ni ne double aucun clic', () => {
  test('le `click` qui suit le `pointerup` ne relance pas un second cycle', async () => {
    // Le navigateur émet toujours les deux ; sans garde, chaque clic partait en
    // double — et le second cycle se faisait refuser par le bail, donc en
    // silence, avec juste un message de refus incompréhensible.
    const fake = ready();
    const panel = await mount([makeItem({ id: '1' })]);
    await panel.click();

    assert.equal(starts(fake).length, 1);
  });

  test('un appui relâché avant le seuil reste un clic court', async () => {
    const fake = ready();
    const visible = [makeItem({ id: '1' })];

    const panel = await mount(visible, [...visible, makeItem({ id: '2' })]);
    await panel.click();

    assert.deepEqual(starts(fake), [['1']], 'la collection affichée, et rien d’autre');
  });

  test('un pointeur qui glisse produit quand même le rafraîchissement affiché', async () => {
    // Le point le plus important du geste : le glissement annule l'escalade vers
    // toutes les collections, jamais le clic. Tout annuler rendrait au bouton
    // son défaut d'origine — un clic un peu tremblant qui ne produit rien.
    const fake = ready();
    const visible = [makeItem({ id: '1' })];

    const panel = await mount(visible, [...visible, makeItem({ id: '2' })]);
    await panel.pressAndDrag();

    assert.deepEqual(starts(fake), [['1']]);
  });

  test('le clavier passe toujours, sans geste pointeur devant lui', async () => {
    const fake = ready();
    const panel = await mount([makeItem({ id: '1' })]);
    await panel.keyboard();

    assert.deepEqual(starts(fake), [['1']]);
  });

  test('deux clics successifs lancent bien deux cycles', async () => {
    // Le garde anti-écho est une fenêtre de temps : mal réglé, il avalerait le
    // second clic d'une série au lieu du seul écho du premier.
    const fake = ready();
    const panel = await mount([makeItem({ id: '1' })]);
    await panel.click();
    await tick(750);
    await panel.click();

    assert.equal(starts(fake).length, 2);
  });
});

describe('découvrabilité du geste', () => {
  test('le bouton au repos annonce l’appui long dans son infobulle', async () => {
    ready();
    const panel = await mount([makeItem({ id: '1' })]);

    assert.match(panel.button.title, /appui long : toutes les collections/);
    assert.equal(panel.button.getAttribute('aria-label'), panel.button.title);
  });

  test('le bouton se remplit pendant l’appui, et s’arrête au relâchement', async () => {
    // Ce remplissage *est* la découverte : qui appuie une demi-seconde de trop
    // voit qu'il se passe quelque chose, et recommence pour savoir quoi.
    ready();
    const panel = await mount([makeItem({ id: '1' })]);

    panel.button.dispatchEvent(
      new panel.button.ownerDocument.defaultView!.MouseEvent('pointerdown', {
        bubbles: true,
        button: 0,
        clientX: 10,
        clientY: 10,
      })
    );
    await tick(100);
    assert.equal(panel.button.classList.contains('is-holding'), true, 'pendant l’appui');

    panel.button.ownerDocument.dispatchEvent(
      new panel.button.ownerDocument.defaultView!.MouseEvent('pointerup', { bubbles: true })
    );
    await tick(80);
    assert.equal(panel.button.classList.contains('is-holding'), false, 'après le relâchement');
  });

  test('pendant un cycle, rien ne se remplit : le bouton annule, il n’escalade pas', async () => {
    const now = Date.now();
    ready({
      watch: {
        lastSweepAt: now - 7200_000,
        bucket: { tokens: 48, at: now },
        progress: { done: 12, total: 48, startedAt: now - 60_000, at: now },
      } satisfies WatchState,
    });

    const panel = await mount([makeItem({ id: '1' })]);
    assert.match(
      panel.label.textContent ?? '',
      /12\/48/,
      'le cas de test suppose un cycle en cours'
    );

    panel.button.dispatchEvent(
      new panel.button.ownerDocument.defaultView!.MouseEvent('pointerdown', {
        bubbles: true,
        button: 0,
      })
    );
    await tick(100);

    assert.equal(
      panel.button.classList.contains('is-holding'),
      false,
      'un remplissage promettrait une action qui n’existe pas ici'
    );
  });

  test('l’appui long pendant un cycle annule, comme un clic', async () => {
    const now = Date.now();
    const fake = ready({
      watch: {
        lastSweepAt: now - 7200_000,
        bucket: { tokens: 48, at: now },
        progress: { done: 12, total: 48, startedAt: now - 60_000, at: now },
      } satisfies WatchState,
    });

    const panel = await mount([makeItem({ id: '1' })]);
    await panel.pressLong();

    const cancels = fake.tabs.sent.filter((call) => call.message.type === 'VF_WATCH_CANCEL');
    assert.equal(cancels.length, 1);
    assert.deepEqual(starts(fake), [], 'aucun cycle ne doit partir par-dessus celui en cours');
  });
});
