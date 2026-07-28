/**
 * La modale « Filtres du catalogue » — voir docs/specs/filtrage-bruit.md §5.
 *
 * Comme `watch-render.test.ts`, on monte `sidepanel.html` en jsdom. À la
 * différence de celui-ci, `filters.ts` écrit en storage : le faux `chrome` est
 * donc installé avant l'import du module, qui capte ses éléments au chargement.
 */
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installFakeChrome } from './fake-chrome.ts';
import type { FakeChrome } from './fake-chrome.ts';
import { emptyNoise, FAST_FASHION, NOISE_RULES_MAX } from '../src/shared/noise.ts';
import type { NoiseFilters } from '../src/shared/noise.ts';
import type { Settings } from '../src/shared/types.ts';

const PANEL = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'sidepanel');

let chrome: FakeChrome;
let dom: JSDOM;
let setFilters: (noise: NoiseFilters, settings: Settings) => void;

const settings = (patch: Partial<Settings> = {}): Settings =>
  ({ revealHidden: false, ...patch }) as Settings;

/** Laisse repartir la boucle d'événements : les écritures sont asynchrones. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10));

const byId = (id: string): HTMLElement => {
  const found = dom.window.document.getElementById(id);
  if (!found) throw new Error(`sidepanel.html : #${id} introuvable`);
  return found;
};

/** Les libellés des règles affichées dans une section. */
const chipLabels = (id: string): string[] =>
  [...byId(id).querySelectorAll('.rule-chip > span')].map((el) => el.textContent ?? '');

const noise = (): NoiseFilters => (chrome.db.noise as NoiseFilters) ?? emptyNoise();

before(async () => {
  dom = new JSDOM(readFileSync(join(PANEL, 'sidepanel.html'), 'utf8'), {
    url: 'chrome-extension://test/sidepanel.html',
  });

  (globalThis as { document?: Document }).document = dom.window.document;
  (globalThis as { window?: unknown }).window = dom.window;
  chrome = installFakeChrome({}, { notify: true });

  // Import différé : le module lit le DOM et `chrome` au chargement.
  ({ setFilters } = await import('../src/sidepanel/filters.ts'));
});

beforeEach(() => {
  chrome.db.noise = emptyNoise();
  setFilters(emptyNoise(), settings());
});

describe('rendu des règles', () => {
  test('chaque nature de règle est listée, avec son compte', () => {
    setFilters(
      {
        ...emptyNoise(),
        brands: ['shein', 'zara'],
        words: ['lot'],
        sellers: { '7': { name: 'destock_pro', at: 1 } },
      },
      settings()
    );

    assert.deepEqual(chipLabels('filters-brands'), ['shein', 'zara']);
    assert.deepEqual(chipLabels('filters-words'), ['lot']);
    assert.deepEqual(chipLabels('filters-sellers'), ['destock_pro']);

    assert.equal(byId('filters-brands-count').textContent, '2');
    assert.equal(byId('filters-words-count').textContent, '1');
  });

  test('un vendeur sans pseudo reste identifiable', () => {
    // Le cas d'un vendeur masqué depuis une carte : seul l'identifiant est connu.
    setFilters({ ...emptyNoise(), sellers: { '7': { name: '', at: 1 } } }, settings());
    assert.deepEqual(chipLabels('filters-sellers'), ['Vendeur 7']);
  });

  test('le témoin s’allume dès qu’une règle générale existe', () => {
    // Les articles écartés un par un (`hidden`) ne comptent pas : seule une
    // règle qui façonne le catalogue (marque, mot, vendeur) l'allume.
    setFilters({ ...emptyNoise(), hidden: { '1': 1, '2': 2 } }, settings());
    assert.equal(byId('filters-dot').classList.contains('filters-dot--active'), false);

    setFilters({ ...emptyNoise(), brands: ['zara'] }, settings());
    assert.equal(byId('filters-dot').classList.contains('filters-dot--active'), true);
  });

  test('aucune règle : le témoin est éteint et chaque section le dit', () => {
    assert.equal(byId('filters-dot').classList.contains('filters-dot--active'), false);
    assert.match(byId('filters-brands').textContent ?? '', /Aucune marque/);
    assert.match(byId('filters-hidden').textContent ?? '', /Aucun article/);
  });

  test('le texte d’aide sur les vendeurs a été retiré', () => {
    assert.equal(dom.window.document.getElementById('filters-sellers-note'), null);
  });

  test('le jeu fast fashion disparaît une fois complet', () => {
    assert.equal(byId('filters-fast-fashion').hidden, false);

    setFilters({ ...emptyNoise(), brands: [...FAST_FASHION] }, settings());
    // Un bouton qui ne ferait plus rien est pire qu'un bouton absent.
    assert.equal(byId('filters-fast-fashion').hidden, true);

    setFilters({ ...emptyNoise(), brands: FAST_FASHION.slice(1) }, settings());
    assert.equal(byId('filters-fast-fashion').hidden, false, 'une marque retirée le ramène');
  });
});

describe('articles écartés — leur propre modale', () => {
  test('les filtres n’en montrent qu’un compte et une porte', () => {
    setFilters({ ...emptyNoise(), hidden: { '1': 1, '2': 2, '3': 3 } }, settings());

    // La liste mangeait la moitié de la hauteur des filtres pour un usage rare :
    // elle vit désormais dans #hidden-dialog.
    assert.match(byId('filters-hidden').textContent ?? '', /3 articles/);
    assert.match(byId('filters-hidden').textContent ?? '', /Gérer/);
    assert.equal(byId('filters-hidden').querySelector('.filters-recent-row'), null);
  });

  test('« Gérer » ouvre la modale dédiée par-dessus celle des filtres', () => {
    setFilters({ ...emptyNoise(), hidden: { '1': 1 } }, settings());
    byId('filters').dispatchEvent(new dom.window.Event('click'));
    assert.equal(byId('filters-dialog').hidden, false);

    byId('filters-hidden').querySelector('button')?.dispatchEvent(new dom.window.Event('click'));

    // Les deux modales restent visibles en même temps — jsdom ne calcule pas de
    // feuille de style externe, donc l'ordre de peinture ne se vérifie pas ici,
    // mais la classe qui le garantit (z-index au-dessus de .overlay) doit être
    // posée. Sans elle, #filters-dialog — plus loin dans le DOM, même z-index —
    // peint par-dessus et « Gérer » ne montre visuellement rien.
    assert.equal(byId('filters-dialog').hidden, false, 'la modale des filtres reste ouverte');
    assert.equal(byId('hidden-dialog').hidden, false);
    assert.ok(
      byId('hidden-dialog').classList.contains('overlay--stacked'),
      'sans ce modificateur, la modale ouverte par-dessus reste invisible'
    );

    dom.window.document.dispatchEvent(
      new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
    );
    assert.equal(byId('hidden-dialog').hidden, true, 'la plus haute se ferme');
    assert.equal(byId('filters-dialog').hidden, false, 'et elle seule');

    byId('filters-dialog')
      .querySelector('[data-close]')
      ?.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  });

  test('seuls les récents sont nommés ; le reste n’est qu’un compte', () => {
    setFilters(
      {
        ...emptyNoise(),
        hidden: { '1': 1, '2': 2, '3': 3 },
        recent: [{ id: '1', title: 'Veste Barbour', at: 1 }],
      },
      settings()
    );

    assert.match(byId('hidden-summary').textContent ?? '', /3 articles/);
    const rows = byId('hidden-recent').querySelectorAll('.filters-recent-row');
    assert.equal(rows.length, 1, 'on ne nomme que ce dont on a gardé le titre');
    assert.match(rows[0]?.textContent ?? '', /Veste Barbour/);
    // Et on dit franchement que les deux autres ne sont pas listés.
    assert.match(byId('hidden-note').textContent ?? '', /2 articles plus anciens/);
  });

  test('« Tout réafficher » vide les écarts', async () => {
    setFilters({ ...emptyNoise(), hidden: { '1': 1, '2': 2 } }, settings());
    chrome.db.noise = { ...emptyNoise(), hidden: { '1': 1, '2': 2 } };

    byId('hidden-summary').querySelector('button')?.dispatchEvent(new dom.window.Event('click'));
    await settle();

    assert.deepEqual(noise().hidden, {});
  });

  test('la croix d’un récent ne réaffiche que celui-là', async () => {
    const stored = {
      ...emptyNoise(),
      hidden: { '1': 1, '2': 2 },
      recent: [
        { id: '1', title: 'Veste', at: 1 },
        { id: '2', title: 'Sweat', at: 2 },
      ],
    };
    chrome.db.noise = stored;
    setFilters(stored, settings());

    const row = byId('hidden-recent').querySelector('.filters-recent-row button');
    row?.dispatchEvent(new dom.window.Event('click'));
    await settle();

    assert.equal(noise().hidden['1'], undefined);
    assert.equal(noise().hidden['2'], 2, "l'autre est intact");
  });
});

describe('ajout et retrait', () => {
  async function submit(formId: string, inputId: string, value: string): Promise<void> {
    (byId(inputId) as HTMLInputElement).value = value;
    byId(formId).dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
    await settle();
  }

  test('une marque saisie est normalisée avant d’être rangée', async () => {
    await submit('filters-brand-form', 'filters-brand-input', '  ZARA  ');

    assert.deepEqual([...noise().brands], ['zara']);
    assert.equal((byId('filters-brand-input') as HTMLInputElement).value, '', 'le champ se vide');
  });

  test('une règle déjà là est refusée, et le dit', async () => {
    chrome.db.noise = { ...emptyNoise(), brands: ['zara'] };
    setFilters({ ...emptyNoise(), brands: ['zara'] }, settings());

    await submit('filters-brand-form', 'filters-brand-input', 'Zara');

    assert.equal(noise().brands.length, 1);
    assert.match(byId('filters-status').textContent ?? '', /déjà/i);
  });

  test('la liste pleine refuse sans erreur, et le dit', async () => {
    const full = Array.from({ length: NOISE_RULES_MAX }, (_, i) => `mot${i}`);
    chrome.db.noise = { ...emptyNoise(), words: full };
    setFilters({ ...emptyNoise(), words: full }, settings());

    await submit('filters-word-form', 'filters-word-input', 'un-de-plus');

    assert.equal(noise().words.length, NOISE_RULES_MAX);
    assert.match(byId('filters-status').textContent ?? '', /pleine/i);
  });

  test('un champ vide ne fait rien du tout', async () => {
    await submit('filters-word-form', 'filters-word-input', '   ');
    assert.deepEqual([...noise().words], []);
  });

  test('la croix d’une puce retire la règle', async () => {
    chrome.db.noise = { ...emptyNoise(), brands: ['shein', 'zara'] };
    setFilters({ ...emptyNoise(), brands: ['shein', 'zara'] }, settings());

    const cross = byId('filters-brands').querySelector('.rule-chip-remove');
    cross?.dispatchEvent(new dom.window.Event('click'));
    await settle();

    assert.deepEqual([...noise().brands], ['zara']);
  });
});

describe('jeu fast fashion', () => {
  test('un clic pose toutes les marques', async () => {
    byId('filters-fast-fashion').dispatchEvent(new dom.window.Event('click'));
    await settle();

    assert.equal(noise().brands.length, FAST_FASHION.length);
    assert.ok(noise().brands.includes('shein'));
  });

  test('un second clic ne dédouble rien, et le dit', async () => {
    byId('filters-fast-fashion').dispatchEvent(new dom.window.Event('click'));
    await settle();
    byId('filters-fast-fashion').dispatchEvent(new dom.window.Event('click'));
    await settle();

    assert.equal(noise().brands.length, FAST_FASHION.length);
    assert.match(byId('filters-status').textContent ?? '', /déjà masquées/i);
  });

  test('il n’est jamais posé tout seul', () => {
    // Rien n'a été cliqué dans ce test : la liste doit être vide.
    assert.deepEqual([...noise().brands], []);
  });
});

describe('mode révision', () => {
  test('la case reflète le réglage, et l’écrit', async () => {
    const box = byId('filters-reveal') as HTMLInputElement;
    assert.equal(box.checked, false);

    setFilters(emptyNoise(), settings({ revealHidden: true }));
    assert.equal(box.checked, true);

    box.checked = false;
    box.dispatchEvent(new dom.window.Event('change'));
    await settle();

    assert.equal((chrome.db.settings as Settings).revealHidden, false);
  });
});
