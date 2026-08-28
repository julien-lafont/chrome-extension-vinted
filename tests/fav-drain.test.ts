/**
 * Le vidage de la file d'intentions — la seule chose de l'extension qui
 * **écrive sur le compte Vinted**. Voir `docs/specs/favoris-sync.md`.
 *
 * L'API ne sait qu'*inverser* un favori : elle n'a pas de « mets à ». Tout ce
 * fichier tourne donc autour d'une question — a-t-on lu l'état réel avant de
 * basculer ? Les cas qui comptent sont ceux où la réponse est non :
 *
 *  1. la liste des favoris ne se lit pas → **aucune bascule**, la file intacte.
 *     La lire comme vide mettrait toute la collection en favori ;
 *  2. l'intention est déjà satisfaite → elle sort de la file **sans requête**,
 *     sinon elle défait précisément ce qu'elle devait faire ;
 *  3. un autre onglet tient le bail → on ne touche à rien, deux bascules du même
 *     article revenant au point de départ ;
 *  4. un 429 arrête tout et ne consomme rien.
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { drainFavourites } from '../src/content/fav-drain.ts';
import { importFavourites, pushFavourites } from '../src/content/fav-catchup.ts';
import { MAX_TOGGLES_PER_DRAIN } from '../src/shared/fav-sync.ts';
import type { FavSyncState, PendingFav } from '../src/shared/fav-sync.ts';
import type { SavedItem } from '../src/shared/types.ts';
import {
  COLLECTIONS_KEY,
  FAVSYNC_KEY,
  ITEMS_KEY,
  OFFERS_KEY,
  SETTINGS_KEY,
} from '../src/shared/storage.ts';
import { installFakeChrome, uninstallFakeChrome, type FakeChrome } from './fake-chrome.ts';

const ME = 77742929;
const NOW = Date.parse('2026-08-25T21:00:00+02:00');
const TOKEN = '75f6c9fa-dc8e-4e52-a000-e09dd4084b3e';
const ANON = '0b9ffca0-1665-4f67-a3eb-342b255a3c08';
const TAB = 'onglet-a';

const FAVOURITES_URL = `/api/v2/users/${ME}/items/favourites?page=1&per_page=100`;
const TOGGLE_URL = '/api/v2/user_favourites/toggle';

/**
 * Une page portant le jeton **tel que Vinted le sert** : du JSON sérialisé dans
 * une chaîne JavaScript, donc à guillemets échappés. Écrire la forme propre
 * ferait passer le test sans prouver que le motif tolère l'emballage réel.
 */
function pageWithToken(token: string | null, cards = ''): Document {
  const script = token
    ? `<script>self.__next_f.push([1,"…\\"NEXT_JS\\":\\"true\\",\\"CSRF_TOKEN\\":\\"${token}\\",\\"NODE_ENV\\":\\"production\\"…"])</script>`
    : '<script>self.__next_f.push([1,"rien ici"])</script>';

  return new JSDOM(`<body>${script}${cards}</body>`, { url: 'https://www.vinted.fr/' }).window
    .document;
}

/** Une carte de catalogue avec son cœur, dans l'état donné. */
const cardWithHeart = (id: string, favourite: boolean): string => `
  <div data-testid="product-item-id-${id}">
    <button data-testid="product-item-id-${id}--favourite" aria-pressed="${favourite}"></button>
  </div>`;

type Route = { status?: number; body?: unknown };
type Call = { url: string; method: string; body: unknown; headers: Record<string, string> };

/** `fetch` de test : sert une réponse par URL, et journalise tout ce qu'on lui passe. */
function fakeFetch(routes: Record<string, Route>) {
  const calls: Call[] = [];

  const impl = ((url: string, init: RequestInit = {}) => {
    const path = String(url);
    calls.push({
      url: path,
      method: init.method ?? 'GET',
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      headers: (init.headers ?? {}) as Record<string, string>,
    });

    const route = routes[path];
    if (!route) return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });

    const status = route.status ?? 200;
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(route.body ?? {}),
    });
  }) as unknown as typeof fetch;

  return { impl, calls };
}

/** Une page de `/items/favourites`, réduite à ce que le vidage en lit. */
const favouritesPage = (ids: number[], totalPages = 1) => ({
  items: ids.map((id) => ({ id, is_favourite: true })),
  pagination: { total_pages: totalPages, per_page: 100 },
});

const deps = (fetchImpl: typeof fetch, doc = pageWithToken(TOKEN)) => ({
  instanceId: TAB,
  fetchImpl,
  doc,
  now: () => NOW,
  wait: () => Promise.resolve(),
  cookie: () => `anonymous-locale=fr; anon_id=${ANON}; v_uid=${ME}`,
  isVisible: () => true,
});

const pending = (entries: [string, boolean][]): PendingFav[] =>
  entries.map(([id, want]) => ({ id, want, at: NOW - 1000 }));

const state = (fake: FakeChrome): FavSyncState => fake.db[FAVSYNC_KEY] as FavSyncState;
const queuedIds = (fake: FakeChrome): string[] => state(fake).pending.map((entry) => entry.id);
const toggles = (calls: Call[]): Call[] => calls.filter((call) => call.url === TOGGLE_URL);

/**
 * @param queue intentions en attente
 * @param extra clés supplémentaires du storage (bail, freinage…)
 */
function install(queue: PendingFav[], extra: Partial<FavSyncState> = {}): FakeChrome {
  return installFakeChrome({
    [SETTINGS_KEY]: { favSync: true },
    // Le compte est déjà connu : c'est le balayage des offres qui l'a mis en
    // cache, et le vidage n'a donc pas à le redemander.
    [OFFERS_KEY]: { lastScanAt: 0, userId: String(ME) },
    [FAVSYNC_KEY]: { pending: queue, ...extra },
  });
}

describe('drainFavourites', () => {
  let fake: FakeChrome;

  afterEach(() => {
    uninstallFakeChrome();
  });

  test("bascule ce qui diffère, et rien d'autre", async () => {
    // 111 est à mettre en favori et ne l'est pas → bascule.
    // 222 est à retirer et y est encore → bascule.
    // 333 est à mettre en favori et l'est déjà → aucune requête.
    fake = install(
      pending([
        ['111', true],
        ['222', false],
        ['333', true],
      ])
    );

    const { impl, calls } = fakeFetch({
      [FAVOURITES_URL]: { body: favouritesPage([222, 333]) },
      [TOGGLE_URL]: { body: { code: 0 } },
    });

    const summary = await drainFavourites(deps(impl));

    assert.equal(summary.toggled, 2);
    assert.equal(summary.satisfied, 1);
    assert.deepEqual(
      toggles(calls).map((call) => call.body),
      [
        { type: 'item', user_favourites: [111] },
        { type: 'item', user_favourites: [222] },
      ]
    );
    // La file est vidée, satisfaites comprises.
    assert.deepEqual(queuedIds(fake), []);
  });

  test('envoie les deux en-têtes que Vinted exige', async () => {
    fake = install(pending([['111', true]]));
    const { impl, calls } = fakeFetch({
      [FAVOURITES_URL]: { body: favouritesPage([]) },
      [TOGGLE_URL]: { body: { code: 0 } },
    });

    await drainFavourites(deps(impl));

    const [toggle] = toggles(calls);
    assert.equal(toggle?.headers['x-csrf-token'], TOKEN);
    assert.equal(toggle?.headers['x-anon-id'], ANON);
    assert.equal(toggle?.headers['content-type'], 'application/json');
  });

  test('sans jeton dans la page, rien ne part et la file reste intacte', async () => {
    // Session expirée, ou Vinted a renommé la clé : mieux vaut un geste en
    // retard qu'un geste inversé.
    fake = install(pending([['111', true]]));
    const { impl, calls } = fakeFetch({ [FAVOURITES_URL]: { body: favouritesPage([]) } });

    const summary = await drainFavourites(deps(impl, pageWithToken(null)));

    assert.equal(summary.stopped, 'jeton absent');
    assert.equal(calls.length, 0);
    assert.deepEqual(queuedIds(fake), ['111']);
  });

  test('liste illisible : aucune bascule — le cas qui viderait les favoris', async () => {
    // Si un échec de lecture se traduisait par « rien n'est en favori », toutes
    // les intentions `want: true` partiraient en bascule, et toutes celles à
    // `false` seraient jugées satisfaites. C'est le pire scénario du fichier.
    fake = install(
      pending([
        ['111', true],
        ['222', false],
      ])
    );
    const { impl, calls } = fakeFetch({ [FAVOURITES_URL]: { status: 500 } });

    const summary = await drainFavourites(deps(impl));

    assert.equal(summary.stopped, 'réseau');
    assert.equal(toggles(calls).length, 0);
    assert.deepEqual(queuedIds(fake), ['111', '222']);
  });

  test("une réponse d'une forme inattendue vaut un échec, pas une liste vide", async () => {
    fake = install(pending([['111', true]]));
    const { impl, calls } = fakeFetch({
      [FAVOURITES_URL]: { body: { message: 'nope' } },
      [TOGGLE_URL]: { body: { code: 0 } },
    });

    const summary = await drainFavourites(deps(impl));

    assert.equal(summary.stopped, 'réseau');
    assert.equal(toggles(calls).length, 0);
    assert.deepEqual(queuedIds(fake), ['111']);
  });

  test('un 429 arrête tout, pose le silence et ne consomme rien', async () => {
    fake = install(pending([['111', true]]));
    const { impl, calls } = fakeFetch({ [FAVOURITES_URL]: { status: 429 } });

    const summary = await drainFavourites(deps(impl));

    assert.equal(summary.stopped, 'freiné');
    assert.equal(toggles(calls).length, 0);
    assert.deepEqual(queuedIds(fake), ['111']);
    assert.equal(state(fake).throttledUntil! > NOW, true);
  });

  test('pendant le silence, aucune requête', async () => {
    fake = install(pending([['111', true]]), { throttledUntil: NOW + 60_000 });
    const { impl, calls } = fakeFetch({ [FAVOURITES_URL]: { body: favouritesPage([]) } });

    const summary = await drainFavourites(deps(impl));

    assert.equal(summary.stopped, 'freiné');
    assert.equal(calls.length, 0);
  });

  test("le bail d'un autre onglet interdit le vidage", async () => {
    fake = install(pending([['111', true]]), {
      lease: { tabId: 'onglet-b', until: NOW + 30_000 },
    });
    const { impl, calls } = fakeFetch({ [FAVOURITES_URL]: { body: favouritesPage([]) } });

    const summary = await drainFavourites(deps(impl));

    assert.equal(summary.stopped, 'occupé');
    assert.equal(calls.length, 0);
    assert.deepEqual(queuedIds(fake), ['111']);
  });

  test('un bail périmé ne bloque pas — un onglet fermé ne condamne pas la file', async () => {
    fake = install(pending([['111', true]]), {
      lease: { tabId: 'onglet-b', until: NOW - 1 },
    });
    const { impl } = fakeFetch({
      [FAVOURITES_URL]: { body: favouritesPage([]) },
      [TOGGLE_URL]: { body: { code: 0 } },
    });

    const summary = await drainFavourites(deps(impl));

    assert.equal(summary.toggled, 1);
    // Le bail est rendu : le prochain onglet n'a pas à attendre son expiration.
    assert.equal(state(fake).lease, undefined);
  });

  test('file vide : pas la moindre requête', async () => {
    fake = install([]);
    const { impl, calls } = fakeFetch({});

    const summary = await drainFavourites(deps(impl));

    assert.equal(summary.toggled, 0);
    assert.equal(calls.length, 0);
  });

  test('un onglet passé en arrière-plan garde ce qui reste', async () => {
    fake = install(
      pending([
        ['111', true],
        ['222', true],
      ])
    );
    const { impl } = fakeFetch({
      [FAVOURITES_URL]: { body: favouritesPage([]) },
      [TOGGLE_URL]: { body: { code: 0 } },
    });

    const summary = await drainFavourites({ ...deps(impl), isVisible: () => false });

    assert.equal(summary.stopped, 'onglet caché');
    assert.equal(summary.toggled, 0);
    assert.deepEqual(queuedIds(fake), ['111', '222']);
  });

  test('au-delà du plafond, le reste attend le vidage suivant', async () => {
    // Plafond de dégâts, pas de débit : un défaut qui produirait mille intentions
    // fausses ne doit pas pouvoir vider les favoris en une passe.
    const many: [string, boolean][] = [];
    for (let i = 0; i < MAX_TOGGLES_PER_DRAIN + 4; i += 1) many.push([String(1000 + i), true]);
    fake = install(pending(many));

    const { impl, calls } = fakeFetch({
      [FAVOURITES_URL]: { body: favouritesPage([]) },
      [TOGGLE_URL]: { body: { code: 0 } },
    });

    const summary = await drainFavourites(deps(impl));

    assert.equal(summary.toggled, MAX_TOGGLES_PER_DRAIN);
    assert.equal(toggles(calls).length, MAX_TOGGLES_PER_DRAIN);
    assert.equal(state(fake).pending.length, 4);
  });

  test('la liste se lit sur toutes ses pages', async () => {
    fake = install(pending([['222', false]]));

    const { impl, calls } = fakeFetch({
      [FAVOURITES_URL]: { body: favouritesPage([111], 2) },
      [`/api/v2/users/${ME}/items/favourites?page=2&per_page=100`]: {
        body: favouritesPage([222], 2),
      },
      [TOGGLE_URL]: { body: { code: 0 } },
    });

    const summary = await drainFavourites(deps(impl));

    // 222 n'est que sur la seconde page : sans la pagination, il passerait pour
    // « déjà retiré » et l'intention serait abandonnée sans rien faire.
    assert.equal(summary.toggled, 1);
    assert.equal(calls.filter((call) => call.url.includes('items/favourites')).length, 2);
  });

  test("le compte est demandé quand il n'est pas déjà connu", async () => {
    fake = installFakeChrome({
      [SETTINGS_KEY]: { favSync: true },
      [FAVSYNC_KEY]: { pending: pending([['111', true]]) },
    });

    const { impl, calls } = fakeFetch({
      '/api/v2/users/current': { body: { user: { id: ME } } },
      [FAVOURITES_URL]: { body: favouritesPage([]) },
      [TOGGLE_URL]: { body: { code: 0 } },
    });

    const summary = await drainFavourites(deps(impl));

    assert.equal(summary.toggled, 1);
    assert.equal(calls[0]?.url, '/api/v2/users/current');
  });

  test('compte inconnu : rien ne part', async () => {
    fake = installFakeChrome({
      [SETTINGS_KEY]: { favSync: true },
      [FAVSYNC_KEY]: { pending: pending([['111', true]]) },
    });

    const { impl, calls } = fakeFetch({ '/api/v2/users/current': { status: 401 } });

    const summary = await drainFavourites(deps(impl));

    assert.equal(summary.stopped, 'compte inconnu');
    assert.equal(toggles(calls).length, 0);
    assert.deepEqual(queuedIds(fake), ['111']);
  });
});

describe('drainFavourites — la page avant l’API', () => {
  afterEach(() => {
    uninstallFakeChrome();
  });

  test("un cœur à l'écran est cliqué, sans la moindre requête", async () => {
    // Le bug : un article retiré depuis le panneau se dé-favorisait bien côté
    // serveur, mais le cœur de la page ouverte restait rouge jusqu'au
    // rechargement. Vinted seul sait repeindre son bouton — on clique le sien.
    const fake = install(pending([['111', false]]));
    const doc = pageWithToken(TOKEN, cardWithHeart('111', true));

    let clicks = 0;
    const heart = doc.querySelector('[data-testid$="--favourite"]')!;
    heart.addEventListener('click', () => {
      clicks += 1;
      heart.setAttribute('aria-pressed', 'false');
    });

    const { impl, calls } = fakeFetch({});
    const summary = await drainFavourites(deps(impl, doc));

    assert.equal(clicks, 1);
    assert.equal(summary.toggled, 1);
    // Ni la liste des favoris, ni la bascule : la page a tout fait.
    assert.equal(calls.length, 0);
    assert.deepEqual(queuedIds(fake), []);
  });

  test("un cœur déjà dans l'état voulu ne coûte rien non plus", async () => {
    const fake = install(pending([['111', true]]));
    const doc = pageWithToken(TOKEN, cardWithHeart('111', true));

    const { impl, calls } = fakeFetch({});
    const summary = await drainFavourites(deps(impl, doc));

    assert.equal(summary.satisfied, 1);
    assert.equal(summary.toggled, 0);
    assert.equal(calls.length, 0);
    assert.deepEqual(queuedIds(fake), []);
  });

  test("les articles hors écran passent par l'API, les autres non", async () => {
    const fake = install(
      pending([
        ['111', false],
        ['222', false],
      ])
    );
    const doc = pageWithToken(TOKEN, cardWithHeart('111', true));

    const heart = doc.querySelector('[data-testid$="--favourite"]')!;
    heart.addEventListener('click', () => heart.setAttribute('aria-pressed', 'false'));

    const { impl, calls } = fakeFetch({
      [FAVOURITES_URL]: { body: favouritesPage([222]) },
      [TOGGLE_URL]: { body: { code: 0 } },
    });

    const summary = await drainFavourites(deps(impl, doc));

    assert.equal(summary.toggled, 2);
    // Une seule bascule par l'API : 111 a été réglé par un clic.
    assert.deepEqual(
      toggles(calls).map((call) => call.body),
      [{ type: 'item', user_favourites: [222] }]
    );
    assert.deepEqual(queuedIds(fake), []);
  });
});

// ---------------------------------------------------------------------------
// Les rattrapages explicites (docs/specs/favoris-sync.md §5)
// ---------------------------------------------------------------------------

/** Une entrée de la liste des favoris, telle que l'API la sert. */
const favouriteEntry = (id: number, patch: Record<string, unknown> = {}) => ({
  id,
  title: 'Prada Nylon Rucksack',
  url: `https://www.vinted.fr/items/${id}-prada-nylon-rucksack`,
  brand_title: 'Prada',
  size_title: 'XS',
  status: 'Très bon état',
  favourite_count: 17,
  price: { amount: '450.0', currency_code: 'EUR' },
  photo: { url: 'https://images1.vinted.net/t/x/f800/1.webp?s=abc' },
  user: { id: 122892573, login: 'snow_bell' },
  ...patch,
});

const richPage = (entries: unknown[], totalPages = 1) => ({
  items: entries,
  pagination: { total_pages: totalPages, per_page: 100 },
});

describe('importFavourites — additif, et rien de plus', () => {
  afterEach(() => {
    uninstallFakeChrome();
  });

  test('enregistre les favoris absents, en qualité « carte »', async () => {
    const fake = installFakeChrome({
      [SETTINGS_KEY]: { favSync: true },
      [OFFERS_KEY]: { lastScanAt: 0, userId: String(ME) },
    });

    const { impl } = fakeFetch({
      [FAVOURITES_URL]: { body: richPage([favouriteEntry(111), favouriteEntry(222)]) },
    });

    const enriched: string[] = [];
    const summary = await importFavourites({
      ...deps(impl),
      onImported: (item) => enriched.push(item.id),
    });

    assert.equal(summary.done, 2);
    const items = fake.db[ITEMS_KEY] as Record<string, SavedItem>;
    assert.deepEqual(Object.keys(items).sort(), ['111', '222']);

    const first = items['111'];
    assert.equal(first?.title, 'Prada Nylon Rucksack');
    assert.equal(first?.brand, 'Prada');
    assert.equal(first?.priceValue, 450);
    assert.equal(first?.sellerName, 'snow_bell');
    // L'API des favoris ne porte pas de catégorie : la fiche complétera.
    assert.equal(first?.category, null);
    assert.equal(first?.pending, true);
    assert.deepEqual(enriched.sort(), ['111', '222']);
  });

  test("n'écrase jamais un article déjà enregistré", async () => {
    // Réimporter remplacerait un article complet — catégorie, photos, historique
    // de prix — par les six champs d'une carte.
    const existing = {
      id: '111',
      title: 'Titre complet',
      priceHistory: [{ at: 1, price: 500 }],
      collectionId: 'col-jeans',
    } as unknown as SavedItem;

    const fake = installFakeChrome({
      [SETTINGS_KEY]: { favSync: true },
      [OFFERS_KEY]: { lastScanAt: 0, userId: String(ME) },
      [ITEMS_KEY]: { '111': existing },
    });

    const { impl } = fakeFetch({ [FAVOURITES_URL]: { body: richPage([favouriteEntry(111)]) } });
    const summary = await importFavourites(deps(impl));

    assert.equal(summary.done, 0);
    assert.equal(summary.skipped, 1);
    assert.deepEqual((fake.db[ITEMS_KEY] as Record<string, SavedItem>)['111'], existing);
  });

  test("un article archivé n'est pas ressuscité par l'import", async () => {
    const archived = { id: '111', collectionId: 'archives' } as unknown as SavedItem;
    const fake = installFakeChrome({
      [SETTINGS_KEY]: { favSync: true },
      [OFFERS_KEY]: { lastScanAt: 0, userId: String(ME) },
      [ITEMS_KEY]: { '111': archived },
    });

    const { impl } = fakeFetch({ [FAVOURITES_URL]: { body: richPage([favouriteEntry(111)]) } });
    await importFavourites(deps(impl));

    assert.equal(
      (fake.db[ITEMS_KEY] as Record<string, SavedItem>)['111']?.collectionId,
      'archives'
    );
  });

  test("liste illisible : rien n'est enregistré", async () => {
    const fake = installFakeChrome({
      [SETTINGS_KEY]: { favSync: true },
      [OFFERS_KEY]: { lastScanAt: 0, userId: String(ME) },
    });

    const { impl } = fakeFetch({ [FAVOURITES_URL]: { status: 500 } });
    const summary = await importFavourites(deps(impl));

    assert.equal(summary.stopped, 'réseau');
    assert.equal(summary.done, 0);
    assert.equal(fake.db[ITEMS_KEY], undefined);
  });
});

describe('pushFavourites — pose les cœurs manquants, et seulement eux', () => {
  afterEach(() => {
    uninstallFakeChrome();
  });

  /**
   * `classifiedIn()` tient pour **non classé** toute référence vers une
   * collection absente du storage — c'est la règle du projet pour les références
   * mortes. « Archives » doit donc exister pour qu'un article y soit vraiment
   * archivé, exactement comme en production où `archiveItem()` la crée à la
   * demande.
   */
  const withItems = (items: Record<string, unknown>) =>
    installFakeChrome({
      [SETTINGS_KEY]: { favSync: true },
      [OFFERS_KEY]: { lastScanAt: 0, userId: String(ME) },
      [COLLECTIONS_KEY]: {
        archives: { id: 'archives', name: 'Archives', createdAt: 1, order: [] },
      },
      [ITEMS_KEY]: items,
    });

  test("ne bascule que ce qui n'est pas déjà en favori", async () => {
    withItems({ '111': { id: '111' }, '222': { id: '222' } });

    const { impl, calls } = fakeFetch({
      [FAVOURITES_URL]: { body: richPage([favouriteEntry(222)]) },
      [TOGGLE_URL]: { body: { code: 0 } },
    });

    const summary = await pushFavourites(deps(impl));

    assert.equal(summary.done, 1);
    assert.equal(summary.skipped, 1);
    // Basculer 222, déjà en favori, l'aurait **retiré** : c'est le piège du
    // bouton-bascule, et la raison de lire la liste avant d'écrire.
    assert.deepEqual(
      toggles(calls).map((call) => call.body),
      [{ type: 'item', user_favourites: [111] }]
    );
  });

  test('les archives restent en dehors', async () => {
    // Les pousser les ferait remonter chez Vinted, puis la synchro constaterait
    // un cœur posé et les sortirait des archives : le geste défairait un
    // rangement voulu.
    withItems({ '111': { id: '111', collectionId: 'archives' }, '222': { id: '222' } });

    const { impl, calls } = fakeFetch({
      [FAVOURITES_URL]: { body: richPage([]) },
      [TOGGLE_URL]: { body: { code: 0 } },
    });

    const summary = await pushFavourites(deps(impl));

    assert.equal(summary.done, 1);
    assert.deepEqual(
      toggles(calls).map((call) => call.body),
      [{ type: 'item', user_favourites: [222] }]
    );
  });

  test('liste illisible : aucune bascule', async () => {
    withItems({ '111': { id: '111' } });
    const { impl, calls } = fakeFetch({ [FAVOURITES_URL]: { status: 500 } });

    const summary = await pushFavourites(deps(impl));

    assert.equal(summary.stopped, 'réseau');
    assert.equal(toggles(calls).length, 0);
  });

  test('un 429 en cours de route dit ce qui reste', async () => {
    withItems({ '111': { id: '111' }, '222': { id: '222' } });

    const { impl } = fakeFetch({
      [FAVOURITES_URL]: { body: richPage([]) },
      [TOGGLE_URL]: { status: 429 },
    });

    const summary = await pushFavourites(deps(impl));

    assert.equal(summary.stopped, 'freiné');
    assert.equal(summary.done, 0);
    assert.equal(summary.remaining, 2);
  });
});
