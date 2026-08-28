/**
 * Mode développeur : la bande d'outils du pied de panneau (export, diagnostic,
 * déblocage du débit) ne s'affiche plus d'elle-même — elle attend le clic droit
 * sur l'icône de l'extension.
 *
 * Deux moitiés, testées ensemble parce que la panne serait invisible si l'une
 * seule marchait : le service worker qui pose l'entrée de menu et arme le
 * drapeau, et le panneau qui le lit. Le montage suit `watch-tabs.test.ts` : le
 * vrai `sidepanel.html` en jsdom, le faux `chrome`, sans passer par
 * `sidepanel.ts`.
 *
 * `notify: true` n'est pas décoratif : le cas « le panneau était déjà ouvert »
 * ne passe que par `storage.onChanged`, et un faux muet le déclarerait vert à
 * tort.
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installFakeChrome, uninstallFakeChrome, type FakeChrome } from './fake-chrome.ts';
import { initDevBar } from '../src/sidepanel/dev-bar.ts';
import { DEV_MODE_KEY } from '../src/shared/dev-mode.ts';
import { DEV_MENU_ID, installDevMenu } from '../src/background/dev-menu.ts';

const PANEL = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'sidepanel');
const HTML = readFileSync(join(PANEL, 'sidepanel.html'), 'utf8');
const CSS = readFileSync(join(PANEL, 'sidepanel.css'), 'utf8');

/** Laisse passer les promesses du faux storage. */
const tick = (ms = 20): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

type Panel = { bar: HTMLElement; exit: HTMLElement; report: HTMLElement };

/** Un DOM neuf par cas : `initDevBar` s'abonne aux nœuds qu'on lui passe. */
function mountPanel(): Panel {
  const dom = new JSDOM(HTML, { url: 'chrome-extension://test/sidepanel.html' });
  const byId = (id: string): HTMLElement => {
    const found = dom.window.document.getElementById(id);
    if (!found) throw new Error(`sidepanel.html : #${id} introuvable`);
    return found;
  };

  const panel = { bar: byId('dev-bar'), exit: byId('dev-exit'), report: byId('report') };
  initDevBar(panel.bar, panel.exit, panel.report);
  return panel;
}

describe('bande de développement du panneau', () => {
  let fake: FakeChrome;

  afterEach(() => {
    uninstallFakeChrome();
  });

  test('part masquée dès le HTML, avant toute lecture du storage', () => {
    // Sans l'attribut, la bande apparaîtrait le temps de la lecture asynchrone
    // du drapeau, à chaque ouverture du panneau. Et sans la règle CSS, l'attribut
    // ne ferait rien : `.footer` impose `display: flex`, qui l'emporte sur le
    // `display: none` de la feuille du navigateur.
    const dom = new JSDOM(HTML, { url: 'chrome-extension://test/sidepanel.html' });
    assert.equal(dom.window.document.getElementById('dev-bar')?.hasAttribute('hidden'), true);
    assert.match(CSS, /\.footer--dev\[hidden\]\s*\{[^}]*display:\s*none/);
  });

  test('reste masquée quand le mode n’a pas été demandé', async () => {
    fake = installFakeChrome({}, { notify: true });
    const panel = mountPanel();

    await tick();
    assert.equal(panel.bar.hidden, true);
  });

  test('s’affiche à l’ouverture du panneau quand le mode est déjà armé', async () => {
    fake = installFakeChrome({}, { notify: true, session: { [DEV_MODE_KEY]: true } });
    const panel = mountPanel();

    await tick();
    assert.equal(panel.bar.hidden, false);
  });

  test('s’affiche quand le mode est armé panneau déjà ouvert', async () => {
    fake = installFakeChrome({}, { notify: true });
    const panel = mountPanel();
    await tick();

    await chrome.storage.session.set({ [DEV_MODE_KEY]: true });
    await tick();

    assert.equal(panel.bar.hidden, false);
  });

  test('« Quitter » referme la bande, efface le rapport et désarme le mode', async () => {
    fake = installFakeChrome({}, { notify: true, session: { [DEV_MODE_KEY]: true } });
    const panel = mountPanel();
    await tick();

    // Un diagnostic vient d'être lancé : son rapport est à l'écran.
    panel.report.hidden = false;
    panel.exit.dispatchEvent(
      new (panel.exit.ownerDocument.defaultView as Window & typeof globalThis).MouseEvent('click')
    );
    await tick();

    assert.equal(panel.bar.hidden, true);
    assert.equal(panel.report.hidden, true);
    assert.equal(DEV_MODE_KEY in fake.session, false);
  });
});

describe('entrée « Ouvrir en mode développeur »', () => {
  type Menu = { id?: string; title?: string; contexts?: string[] };

  let created: Menu[];
  let clicked: ((info: { menuItemId: string }, tab?: { windowId: number }) => void)[];
  let opened: { windowId: number }[];

  beforeEach(() => {
    installFakeChrome({}, { notify: true });
    created = [];
    clicked = [];
    opened = [];

    // Ce que le faux `chrome` commun n'a pas : le menu contextuel et l'ouverture
    // du panneau, propres au service worker.
    const stub = globalThis.chrome as unknown as Record<string, unknown>;
    stub.contextMenus = {
      removeAll: (done: () => void) => done(),
      create: (menu: Menu) => created.push(menu),
      onClicked: {
        addListener: (fn: (typeof clicked)[number]) => clicked.push(fn),
      },
    };
    stub.sidePanel = {
      open: (options: { windowId: number }) => {
        opened.push(options);
        return Promise.resolve();
      },
    };
    (stub.runtime as { onInstalled?: unknown }).onInstalled = {
      addListener: (fn: () => void) => fn(),
    };
  });

  afterEach(() => {
    uninstallFakeChrome();
  });

  test('se pose sur l’icône de l’extension, et nulle part ailleurs', () => {
    installDevMenu();

    assert.deepEqual(created, [
      { id: DEV_MENU_ID, title: 'Ouvrir en mode développeur', contexts: ['action'] },
    ]);
  });

  test('arme le mode et ouvre le panneau', async () => {
    installDevMenu();
    clicked[0]?.({ menuItemId: DEV_MENU_ID }, { windowId: 7 });

    // L'ouverture est **synchrone** : Chrome n'autorise `sidePanel.open()` qu'en
    // réponse directe au geste, un `await` avant elle le ferait échouer.
    assert.deepEqual(opened, [{ windowId: 7 }]);

    await tick();
    const store = await chrome.storage.session.get(DEV_MODE_KEY);
    assert.equal(store[DEV_MODE_KEY], true);
  });

  test('ignore les clics venus d’une autre entrée', async () => {
    installDevMenu();
    clicked[0]?.({ menuItemId: 'autre-chose' }, { windowId: 7 });

    await tick();
    assert.deepEqual(opened, []);
    const store = await chrome.storage.session.get(DEV_MODE_KEY);
    assert.equal(DEV_MODE_KEY in store, false);
  });
});
