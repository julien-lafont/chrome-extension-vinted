/**
 * Bouton « Rafraîchir » : élection de l'onglet Vinted et retour au clic —
 * `docs/specs/suivi-prix.md` §5.1 et §6.1.
 *
 * Tous ces cas viennent du même signalement : « cliquer sur Rafraîchir ne fait
 * rien ». Ce n'était jamais une panne, toujours une décision prise en silence —
 * mauvais onglet élu, bouton `disabled`, refus du content script journalisé dans
 * une console que personne ne regarde, cycle mort resté inscrit en storage.
 *
 * Le montage suit `watch-render.test.ts` : le vrai `sidepanel.html` en jsdom,
 * plus le faux `chrome` (storage **et** onglets), sans passer par
 * `sidepanel.ts`. Un DOM neuf par cas — `initWatch()` s'abonne au bouton qu'on
 * lui passe, et deux abonnements sur le même nœud feraient compter chaque clic
 * deux fois.
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  installFakeChrome,
  uninstallFakeChrome,
  type FakeChrome,
  type FakeTab,
} from './fake-chrome.ts';
import { initWatch } from '../src/sidepanel/watch.ts';
import { SWEEP_STALE_MS } from '../src/shared/watch.ts';
import type { WatchState } from '../src/shared/types.ts';
import { makeItem } from './factories.ts';

const HTML = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'sidepanel', 'sidepanel.html'),
  'utf8'
);

/** Laisse passer les promesses du faux storage et des faux onglets. */
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

const ailleurs = (id: number, windowId: number, active: boolean): FakeTab => ({
  id,
  url: 'https://example.com/',
  active,
  windowId,
});

type Panel = {
  button: HTMLButtonElement;
  label: HTMLElement;
  notice: HTMLElement;
  /** Messages passagers reçus par `onFlash` — le retour visible du clic. */
  flashes: string[];
  click: () => Promise<void>;
};

let log: typeof console.log;

beforeEach(() => {
  // `watch.ts` tient un journal de diagnostic sur la console du panneau ; il
  // sortirait ici au milieu du rapport de tests.
  log = console.log;
  console.log = () => {};
});

afterEach(() => {
  console.log = log;
  uninstallFakeChrome();
});

/** Monte le bouton sur un DOM neuf et rend de quoi l'actionner. */
async function mount(items = [makeItem({ id: 'a' })]): Promise<Panel> {
  const dom = new JSDOM(HTML, { url: 'chrome-extension://test/sidepanel.html' });
  const byId = (id: string): HTMLElement => {
    const found = dom.window.document.getElementById(id);
    if (!found) throw new Error(`sidepanel.html : #${id} introuvable`);
    return found;
  };

  const panel: Panel = {
    button: byId('refresh') as HTMLButtonElement,
    label: byId('refresh-label'),
    notice: byId('watch-notice'),
    flashes: [],
    async click() {
      panel.button.dispatchEvent(new dom.window.Event('click'));
      await tick(60);
    },
  };

  initWatch(
    { button: panel.button, label: panel.label, notice: panel.notice },
    {
      visibleIds: () => items.map((item) => item.id),
      getItems: () => items,
      onFlash: (message) => panel.flashes.push(message),
    }
  );

  await tick();
  return panel;
}

/** Le `VF_WATCH_START` envoyé, s'il l'a été. */
function startedOn(fake: FakeChrome): number | null {
  return fake.tabs.sent.find((call) => call.message.type === 'VF_WATCH_START')?.tabId ?? null;
}

describe('élection de l’onglet Vinted', () => {
  test('élit l’onglet Vinted actif de la fenêtre, pas le premier de la liste', async () => {
    // Trois onglets Vinted, l'actif en dernier : c'est l'ordre que rend
    // `chrome.tabs.query`, fenêtre par fenêtre. L'ancienne élection prenait le
    // premier — un onglet caché, que §3.6 mettait aussitôt en pause, sans un mot.
    const fake = installFakeChrome(
      {},
      {
        tabs: [vinted(1, 2, true), vinted(2, 1, false), vinted(3, 1, true)],
        currentWindowId: 1,
        respond: () => ({ accepted: true }),
      }
    );

    const panel = await mount();
    await panel.click();

    assert.equal(startedOn(fake), 3, 'l’ordre doit partir à l’onglet actif de cette fenêtre');
  });

  test('active l’onglet Vinted de la fenêtre quand on regarde ailleurs', async () => {
    const fake = installFakeChrome(
      {},
      {
        tabs: [ailleurs(1, 1, true), vinted(2, 1, false)],
        currentWindowId: 1,
        respond: () => ({ accepted: true }),
      }
    );

    const panel = await mount();
    await panel.click();

    assert.deepEqual(fake.tabs.activated, [2], 'l’onglet Vinted doit passer au premier plan');
    assert.equal(startedOn(fake), 2);
  });

  test('ouvre un onglet Vinted quand il n’y en a aucun, et lance le cycle', async () => {
    const fake = installFakeChrome(
      {},
      {
        tabs: [ailleurs(1, 1, true)],
        currentWindowId: 1,
        respond: (_tabId, message) =>
          message.type === 'VF_PING' ? { ok: true } : { accepted: true },
      }
    );

    const panel = await mount();
    await panel.click();

    assert.equal(fake.tabs.created.length, 1, 'un onglet Vinted doit avoir été ouvert');
    assert.match(fake.tabs.created[0]?.url ?? '', /^https:\/\/www\.vinted\.fr\//);
    assert.equal(startedOn(fake), 2, 'le cycle doit partir dans l’onglet fraîchement ouvert');
  });

  test('un onglet Vinted caché reçoit quand même l’ordre, et l’utilisateur sait quoi faire', async () => {
    // Vinted ouvert dans une autre fenêtre, en arrière-plan : le cycle démarre
    // en pause (§3.6) et reprend au retour. Bloquer ici serait le pire choix —
    // l'utilisateur n'aurait ni cycle ni explication.
    const fake = installFakeChrome(
      {},
      {
        tabs: [ailleurs(1, 1, true), vinted(2, 2, false)],
        currentWindowId: 1,
        respond: () => ({ accepted: true }),
      }
    );

    const panel = await mount();
    await panel.click();

    assert.equal(startedOn(fake), 2);
    assert.match(panel.flashes.join(' '), /onglet Vinted/i);
  });
});

describe('le clic ne peut pas rester sans réponse', () => {
  test('sans onglet Vinted, le bouton reste cliquable et dit ce qu’il fera', async () => {
    installFakeChrome({}, { tabs: [ailleurs(1, 1, true)], currentWindowId: 1 });

    const panel = await mount();

    assert.equal(panel.button.disabled, false, 'un bouton désactivé n’explique jamais rien');
    assert.equal(panel.notice.hidden, false);
    assert.match(panel.notice.textContent ?? '', /onglet Vinted/i);
  });

  test('freiné, le bouton reste cliquable et redonne l’échéance', async () => {
    const now = Date.now();
    installFakeChrome(
      {
        watch: {
          lastSweepAt: now - 7200_000,
          bucket: { tokens: 48, at: now },
          throttledUntil: now + 22 * 60_000,
        } satisfies WatchState,
      },
      { tabs: [vinted(1, 1, true)], currentWindowId: 1, respond: () => ({ accepted: true }) }
    );

    const panel = await mount();

    assert.equal(panel.button.disabled, false);
    assert.match(panel.label.textContent ?? '', /Réessai 22 min/);
    assert.match(panel.notice.textContent ?? '', /limité nos requêtes/);

    await panel.click();
    assert.match(panel.flashes.join(' '), /reprend à/, 'le clic doit répéter la raison');
  });

  test('un refus du content script remonte à l’écran', async () => {
    installFakeChrome(
      {},
      {
        tabs: [vinted(1, 1, true)],
        currentWindowId: 1,
        respond: () => ({ accepted: false, reason: 'Un autre onglet Vinted rafraîchit déjà.' }),
      }
    );

    const panel = await mount();
    await panel.click();

    assert.match(panel.flashes.join(' '), /Un autre onglet Vinted rafraîchit déjà/);
  });

  test('un onglet muet demande un rechargement, plutôt que rien', async () => {
    installFakeChrome(
      {},
      {
        tabs: [vinted(1, 1, true)],
        currentWindowId: 1,
        // Content script pas injecté : onglet ouvert avant le chargement de
        // l'extension. Chrome ne rend qu'une erreur laconique.
        respond: () => {
          throw new Error('Could not establish connection.');
        },
      }
    );

    const panel = await mount();
    await panel.click();

    assert.match(panel.flashes.join(' '), /Recharge l’onglet Vinted/);
  });

  test('une collection vide le dit, au lieu d’abandonner en silence', async () => {
    const fake = installFakeChrome(
      {},
      { tabs: [vinted(1, 1, true)], currentWindowId: 1, respond: () => ({ accepted: true }) }
    );

    const panel = await mount([]);
    await panel.click();

    assert.equal(startedOn(fake), null);
    assert.match(panel.flashes.join(' '), /Aucun article à rafraîchir/);
  });
});

describe('cycle dont le porteur a disparu', () => {
  /** Onglet fermé en plein cycle : `progress` reste, plus personne ne l'avance. */
  const stale = (now: number): WatchState => ({
    lastSweepAt: now - 7200_000,
    bucket: { tokens: 48, at: now },
    progress: { done: 12, total: 48, startedAt: now - 3600_000, at: now - SWEEP_STALE_MS - 1000 },
  });

  test('ne fige plus le bouton sur son compteur', async () => {
    const now = Date.now();
    installFakeChrome(
      { watch: stale(now) },
      { tabs: [vinted(1, 1, true)], currentWindowId: 1, respond: () => ({ accepted: true }) }
    );

    const panel = await mount();

    assert.match(panel.label.textContent ?? '', /Rafraîchir/);
    assert.equal(
      panel.button.classList.contains('is-running'),
      false,
      'l’icône ne doit pas tourner pour un cycle que personne ne porte'
    );
  });

  test('le clic relance un cycle au lieu d’annuler dans le vide', async () => {
    const now = Date.now();
    const fake = installFakeChrome(
      { watch: stale(now) },
      { tabs: [vinted(1, 1, true)], currentWindowId: 1, respond: () => ({ accepted: true }) }
    );

    const panel = await mount();
    await panel.click();

    assert.equal(startedOn(fake), 1, 'le clic doit lancer, pas annuler');
  });

  test('un cycle qui bat encore reste un cycle en cours', async () => {
    const now = Date.now();
    const fake = installFakeChrome(
      {
        watch: {
          lastSweepAt: 0,
          bucket: { tokens: 48, at: now },
          progress: { done: 12, total: 48, startedAt: now - 60_000, at: now - 5_000 },
        } satisfies WatchState,
      },
      { tabs: [vinted(1, 1, true)], currentWindowId: 1, respond: () => ({ accepted: true }) }
    );

    const panel = await mount();
    assert.match(panel.label.textContent ?? '', /12\/48/);

    await panel.click();
    assert.equal(startedOn(fake), null, 'un clic sur un cycle vivant annule');
    assert.ok(
      fake.tabs.sent.some((call) => call.message.type === 'VF_WATCH_CANCEL'),
      'l’annulation doit être diffusée'
    );
  });
});

describe('cycle en pause (§3.6)', () => {
  test('le dit, et n’anime plus l’icône', async () => {
    const now = Date.now();
    installFakeChrome(
      {
        watch: {
          lastSweepAt: 0,
          bucket: { tokens: 48, at: now },
          progress: { done: 7, total: 48, startedAt: now - 60_000, at: now - 2_000, paused: true },
        } satisfies WatchState,
      },
      { tabs: [vinted(1, 1, false)], currentWindowId: 1, respond: () => ({ accepted: true }) }
    );

    const panel = await mount();

    assert.match(panel.label.textContent ?? '', /7\/48/, 'l’avancement acquis reste visible');
    assert.equal(panel.button.classList.contains('is-running'), false);
    assert.match(panel.notice.textContent ?? '', /pause/i);
    assert.match(panel.notice.textContent ?? '', /reviens/i, 'la ligne doit dire le geste à faire');
  });
});

describe('retour vers l’onglet porteur (§6.10)', () => {
  /** Cycle en pause porté par un onglet Vinted d'une autre fenêtre. */
  const carried = (now: number): WatchState => ({
    lastSweepAt: 0,
    bucket: { tokens: 48, at: now },
    progress: { done: 7, total: 48, startedAt: now - 60_000, at: now - 2_000, paused: true },
    host: { tabId: 2, windowId: 5 },
  });

  test('l’onglet retenu est rangé en storage au lancement', async () => {
    // Sans lui, le panneau ne peut désigner aucun onglet : un content script ne
    // connaît pas son propre id d'onglet Chrome, seul le panneau le sait.
    const fake = installFakeChrome(
      {},
      {
        tabs: [vinted(4, 3, true)],
        currentWindowId: 3,
        respond: () => ({ accepted: true }),
      }
    );

    const panel = await mount();
    await panel.click();

    assert.deepEqual((fake.db.watch as WatchState).host, { tabId: 4, windowId: 3 });
  });

  test('la ligne d’état porte un lien vers cet onglet, pas une consigne', async () => {
    const now = Date.now();
    const fake = installFakeChrome(
      { watch: carried(now) },
      { tabs: [vinted(2, 5, false)], currentWindowId: 1, respond: () => ({ accepted: true }) }
    );

    const panel = await mount();

    const link = panel.notice.querySelector('button.link');
    assert.ok(link, 'la phrase doit contenir un lien, non un simple texte');
    assert.match(link.textContent ?? '', /onglet Vinted responsable du rafraîchissement/);

    link.dispatchEvent(new panel.notice.ownerDocument.defaultView!.Event('click'));
    await tick(40);

    assert.deepEqual(fake.tabs.activated, [2], 'le clic doit activer l’onglet porteur');
    assert.deepEqual(fake.tabs.focused, [5], 'et remettre sa fenêtre au premier plan');
  });

  test('si l’onglet porteur a été fermé, le clic le dit', async () => {
    const now = Date.now();
    // `host` désigne l'onglet 2, absent de la liste : Chrome lève.
    installFakeChrome(
      { watch: carried(now) },
      { tabs: [vinted(9, 1, true)], currentWindowId: 1, respond: () => ({ accepted: true }) }
    );

    const panel = await mount();
    const link = panel.notice.querySelector('button.link');
    assert.ok(link);

    link.dispatchEvent(new panel.notice.ownerDocument.defaultView!.Event('click'));
    await tick(40);

    assert.match(panel.flashes.join(' '), /a été fermé/);
  });

  test('un cycle sans onglet connu garde une phrase lisible', async () => {
    // Cycle lancé par une version antérieure, ou storage incomplet : le lien
    // redevient du texte, la phrase ne perd pas son sens.
    const now = Date.now();
    const state = carried(now);
    delete state.host;
    installFakeChrome(
      { watch: state },
      { tabs: [vinted(2, 1, false)], currentWindowId: 1, respond: () => ({ accepted: true }) }
    );

    const panel = await mount();

    assert.equal(panel.notice.querySelector('button.link'), null);
    assert.match(panel.notice.textContent ?? '', /onglet Vinted responsable du rafraîchissement/);
  });
});
