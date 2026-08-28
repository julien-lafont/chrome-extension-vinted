/**
 * Synchro avec les favoris natifs de Vinted — `docs/specs/favoris-sync.md`.
 *
 * Deux moitiés, testées séparément parce qu'elles cassent pour des raisons
 * différentes : la décision (`shared/fav-sync.ts`, pure) et la constatation
 * (`content/fav-sync.ts`, qui s'accroche à `aria-pressed` et casse quand Vinted
 * déploie).
 *
 * Les cas qui comptent vraiment ne sont pas les quatre règles nominales mais
 * ceux qui protègent d'une action **non voulue** :
 *
 *   — un état jamais vu ne vaut pas une transition (sinon chaque chargement de
 *     page ferait constater le retrait de tous les favoris) ;
 *   — un article archivé ne redéclenche rien (sinon l'archivage boucle) ;
 *   — la synchro éteinte n'écrit rien, mais relève quand même.
 */
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import {
  MAX_PENDING,
  dropFav,
  effectOfFavourite,
  emptyFavSync,
  normalizeFavSync,
  queueFav,
  wantedFavourite,
} from '../src/shared/fav-sync.ts';
import {
  ARCHIVE_COLLECTION_ID,
  DEFAULT_COLLECTION_ID,
  makeArchiveCollection,
  makeDefaultCollection,
} from '../src/shared/collections.ts';
import { favouriteTargetId, readFavouriteState } from '../src/content/extract.ts';
import type { CollectionMap, SavedItem } from '../src/shared/types.ts';
import { SOLD_ITEM_ID, loadContentScript, meta, settle, settleFetches } from './harness.ts';

after(settleFetches);

const collections: CollectionMap = {
  [DEFAULT_COLLECTION_ID]: makeDefaultCollection(),
  [ARCHIVE_COLLECTION_ID]: makeArchiveCollection(),
};

const item = (patch: Partial<SavedItem> = {}): SavedItem => ({ id: '1', ...patch }) as SavedItem;

// ---------------------------------------------------------------------------
// La décision
// ---------------------------------------------------------------------------

describe("effectOfFavourite — ce qu'une transition du cœur produit", () => {
  test("cœur posé sur un article inconnu : on l'enregistre", () => {
    assert.equal(effectOfFavourite(true, undefined, collections), 'save');
  });

  test("cœur retiré sur un article enregistré : on l'archive, on ne le supprime pas", () => {
    assert.equal(effectOfFavourite(false, item(), collections), 'archive');
  });

  test("cœur posé sur un article archivé : il ressort du dépôt, il n'est pas recréé", () => {
    // La distinction n'est pas cosmétique : `save` réécrirait l'article avec les
    // six champs d'une carte, emportant historique de prix et date d'ajout.
    const archived = item({ collectionId: ARCHIVE_COLLECTION_ID });
    assert.equal(effectOfFavourite(true, archived, collections), 'restore');
  });

  test("le retrait d'un cœur déjà archivé ne fait rien — c'est ce qui ferme la boucle", () => {
    // Archiver retire le cœur ; sans ce `none`, le retrait constaté rearchiverait
    // l'article, indéfiniment.
    const archived = item({ collectionId: ARCHIVE_COLLECTION_ID });
    assert.equal(effectOfFavourite(false, archived, collections), 'none');
  });

  test('cœur posé sur un article déjà enregistré : rien à faire', () => {
    assert.equal(effectOfFavourite(true, item(), collections), 'none');
  });

  test("cœur retiré sur un article qu'on n'a jamais enregistré : rien à faire", () => {
    assert.equal(effectOfFavourite(false, undefined, collections), 'none');
  });
});

describe('wantedFavourite — ce que le storage veut chez Vinted', () => {
  test('un article rangé veut son cœur, un archivé ne le veut plus', () => {
    assert.equal(wantedFavourite(item(), collections), true);
    assert.equal(wantedFavourite(item({ collectionId: 'col-x' }), collections), true);
    assert.equal(
      wantedFavourite(item({ collectionId: ARCHIVE_COLLECTION_ID }), collections),
      false
    );
  });

  test('un article absent veut son cœur retiré — le cas de la suppression au panneau', () => {
    assert.equal(wantedFavourite(undefined, collections), false);
  });
});

// ---------------------------------------------------------------------------
// La file d'intentions
// ---------------------------------------------------------------------------

describe("la file d'intentions", () => {
  test('une intention plus récente remplace la précédente sur le même article', () => {
    let state = queueFav(emptyFavSync(), '1', true, 10);
    state = queueFav(state, '2', true, 20);
    state = queueFav(state, '1', false, 30);

    assert.deepEqual(state.pending, [
      { id: '2', want: true, at: 20 },
      { id: '1', want: false, at: 30 },
    ]);
  });

  test('au-delà du plafond, ce sont les plus anciennes qui tombent', () => {
    let state = emptyFavSync();
    for (let i = 0; i < MAX_PENDING + 5; i += 1) state = queueFav(state, String(i), true, i);

    assert.equal(state.pending.length, MAX_PENDING);
    assert.equal(state.pending[0]?.id, '5');
    assert.equal(state.pending.at(-1)?.id, String(MAX_PENDING + 4));
  });

  test('dropFav retire ce qui a été porté', () => {
    let state = queueFav(emptyFavSync(), '1', true, 10);
    state = queueFav(state, '2', false, 20);

    assert.deepEqual(dropFav(state, ['1']).pending, [{ id: '2', want: false, at: 20 }]);
    assert.equal(dropFav(state, []), state);
  });

  test('un storage vide ou abîmé se relit sans lever', () => {
    assert.deepEqual(normalizeFavSync(undefined), { pending: [] });
    const junk = { pending: [{ id: '1' }, null, { id: '2', want: true, at: 3 }] };
    assert.deepEqual(normalizeFavSync(junk as never).pending, [{ id: '2', want: true, at: 3 }]);
  });
});

// ---------------------------------------------------------------------------
// La lecture du cœur dans le DOM
// ---------------------------------------------------------------------------

const dom = (html: string): Document =>
  new JSDOM(`<body>${html}</body>`, { url: 'https://www.vinted.fr/' }).window.document;

describe("readFavouriteState — aria-pressed, et rien d'autre", () => {
  test('lit les deux états', () => {
    const doc = dom('<button aria-pressed="true"></button><button aria-pressed="false"></button>');
    const [on, off] = [...doc.querySelectorAll('button')];

    assert.equal(readFavouriteState(on!), true);
    assert.equal(readFavouriteState(off!), false);
  });

  test('un bouton pas encore hydraté rend null, jamais false', () => {
    // Le cas de la fiche article, où le cœur arrive `disabled` et nu. Rendre
    // `false` ferait constater un retrait de favori à chaque chargement.
    const doc = dom('<button data-testid="favourite-button" disabled></button>');
    assert.equal(readFavouriteState(doc.querySelector('button')!), null);
  });
});

describe('favouriteTargetId — à quel article le cœur appartient', () => {
  test("la carte du catalogue porte l'identifiant dans son testid", () => {
    const doc = dom(`
      <div data-testid="product-item-id-42">
        <button data-testid="product-item-id-42--favourite" aria-pressed="false"></button>
      </div>`);

    const btn = doc.querySelector('button')!;
    assert.equal(favouriteTargetId(btn, 'https://www.vinted.fr/'), '42');
  });

  test("le fil d'accueil n'en a nulle part : il se lit sur le lien de la carte", () => {
    const doc = dom(`
      <div data-testid="feed-item">
        <a data-testid="feed-item--overlay-link" href="/items/77-veste"></a>
        <button data-testid="feed-item--favourite" aria-pressed="false"></button>
      </div>`);

    const btn = doc.querySelector('button')!;
    assert.equal(favouriteTargetId(btn, 'https://www.vinted.fr/'), '77');
  });

  test("les blocs d'une fiche gardent leur propre préfixe", () => {
    const doc = dom(`
      <div data-testid="similar_items-99">
        <button data-testid="similar_items-99--favourite" aria-pressed="false"></button>
      </div>`);

    const btn = doc.querySelector('button')!;
    assert.equal(favouriteTargetId(btn, 'https://www.vinted.fr/'), '99');
  });

  test("le cœur de la fiche désigne l'article de l'URL", () => {
    const doc = dom('<button data-testid="favourite-button" aria-pressed="true"></button>');
    const btn = doc.querySelector('button')!;

    assert.equal(favouriteTargetId(btn, 'https://www.vinted.fr/items/1234-veste'), '1234');
  });

  test("un cœur orphelin ne s'attribue à personne", () => {
    const doc = dom('<button data-testid="feed-item--favourite" aria-pressed="false"></button>');
    assert.equal(favouriteTargetId(doc.querySelector('button')!, 'https://www.vinted.fr/'), null);
  });
});

// ---------------------------------------------------------------------------
// Bout en bout, dans la page
// ---------------------------------------------------------------------------

/** Le cœur natif de Vinted sur la carte de cet article. */
const heartOf = (document: Document, id: string): Element => {
  const btn = document.querySelector(`[data-testid$="${id}--favourite"]`);
  if (!btn) throw new Error(`aucun cœur Vinted sur la carte ${id}`);
  return btn;
};

/** Le premier article du catalogue de la fixture, avec son cœur. */
function firstCard(document: Document): { id: string; heart: Element } {
  const card = document.querySelector('[data-testid^="product-item-id-"]:not([data-testid*="--"])');
  const id = (card as HTMLElement | null)?.dataset.testid?.match(/-(\d+)$/)?.[1];
  if (!id) throw new Error("la fixture catalogue n'expose aucune carte identifiable");
  return { id, heart: heartOf(document, id) };
}

/** Bascule le cœur comme le ferait Vinted : un seul attribut change. */
async function flipHeart(heart: Element, favourite: boolean): Promise<void> {
  heart.setAttribute('aria-pressed', String(favourite));
  await settle(250);
}

describe("dans la page — le cœur Vinted pilote les favoris de l'extension", () => {
  test("synchro éteinte : un cœur posé n'enregistre rien", async () => {
    const page = await loadContentScript('catalog');
    const { heart } = firstCard(page.document);

    await flipHeart(heart, true);

    assert.equal(page.savedCount(), 0);
  });

  test("synchro allumée : un cœur posé enregistre l'article", async () => {
    const page = await loadContentScript('catalog');
    await page.write({ settings: { favSync: true } });

    const { id, heart } = firstCard(page.document);
    await flipHeart(heart, true);

    assert.equal(page.savedCount(), 1);
    const [saved] = page.saved() as SavedItem[];
    assert.equal(saved?.id, id);
    // Même protocole qu'un clic sur le marque-page : la carte d'abord, la fiche
    // ensuite.
    assert.equal(saved?.pending, true);
  });

  test("le marque-page de l'extension suit dans la foulée", async () => {
    const page = await loadContentScript('catalog');
    await page.write({ settings: { favSync: true } });

    const { id, heart } = firstCard(page.document);
    await flipHeart(heart, true);

    const btn = page.document.querySelector(`.vf-card-btn[data-vf-id="${id}"]`);
    assert.equal(btn?.getAttribute('aria-pressed'), 'true');
  });

  test("un cœur retiré archive l'article au lieu de le supprimer", async () => {
    const page = await loadContentScript('catalog');
    await page.write({ settings: { favSync: true } });

    const { id, heart } = firstCard(page.document);
    await flipHeart(heart, true);
    await flipHeart(heart, false);

    // L'article est toujours là — c'est tout l'intérêt : son historique de prix
    // et sa date d'ajout survivent à un cœur retiré par erreur.
    assert.equal(page.savedCount(), 1);
    const [saved] = page.saved() as SavedItem[];
    assert.equal(saved?.collectionId, ARCHIVE_COLLECTION_ID);
    assert.equal(page.collections()[ARCHIVE_COLLECTION_ID]?.order.includes(id), true);
  });

  test('un article archivé dont on repose le cœur ressort du dépôt', async () => {
    const page = await loadContentScript('catalog');
    await page.write({ settings: { favSync: true } });

    const { heart } = firstCard(page.document);
    await flipHeart(heart, true);
    const savedAt = (page.saved()[0] as SavedItem).savedAt;

    await flipHeart(heart, false);
    await flipHeart(heart, true);

    const [saved] = page.saved() as SavedItem[];
    // Sorti du dépôt = non classé, c'est-à-dire sans `collectionId` : « Mes
    // favoris » n'est pas une collection où l'on range (voir `classifiedIn()`).
    assert.equal(saved?.collectionId, undefined);
    // Ressorti, pas recréé : la date d'ajout d'origine est intacte.
    assert.equal(saved?.savedAt, savedAt);
  });

  test("une carte qui arrive n'est pas une transition, même synchro allumée", async () => {
    // Le cas qui ferait tout perdre. Toutes les cartes du catalogue portent
    // `aria-pressed="false"` en arrivant : si un état vu pour la première fois
    // comptait pour un retrait, défiler le catalogue archiverait, une par une,
    // toutes les pièces de la collection qu'on n'a jamais mises en favori chez
    // Vinted.
    const saved = { '4242': { id: '4242', title: 'Enregistré, jamais en favori' } };
    const page = await loadContentScript('catalog', { saved });
    await page.write({ settings: { favSync: true } });

    // Défilement infini : Vinted insère une carte de plus.
    const card = page.document.createElement('div');
    card.setAttribute('data-testid', 'product-item-id-4242');
    card.innerHTML =
      '<a data-testid="product-item-id-4242--overlay-link" href="/items/4242-veste"></a>' +
      '<button data-testid="product-item-id-4242--favourite" aria-pressed="false"></button>';
    page.document.body.appendChild(card);
    await settle(300);

    const [stored] = page.saved() as SavedItem[];
    assert.equal(
      stored?.collectionId,
      undefined,
      "l'article a été archivé sans qu'on l'ait demandé"
    );

    // Et le geste réel, lui, compte bien.
    await flipHeart(heartOf(page.document, '4242'), true);
    await flipHeart(heartOf(page.document, '4242'), false);
    assert.equal((page.saved()[0] as SavedItem).collectionId, ARCHIVE_COLLECTION_ID);
  });

  test('la synchro allumée après coup ne rejoue pas le passé', async () => {
    const page = await loadContentScript('catalog');
    const { heart } = firstCard(page.document);

    // Geste fait synchro éteinte : relevé, mais sans effet.
    await flipHeart(heart, true);
    assert.equal(page.savedCount(), 0);

    await page.write({ settings: { favSync: true } });
    await settle(250);

    // Allumer ne rattrape rien — seul le geste suivant comptera.
    assert.equal(page.savedCount(), 0);

    await flipHeart(heart, false);
    await flipHeart(heart, true);
    assert.equal(page.savedCount(), 1);
  });

  test('le diagnostic compte les transitions appliquées', async () => {
    const page = await loadContentScript('catalog');
    await page.write({ settings: { favSync: true } });

    const { heart } = firstCard(page.document);
    await flipHeart(heart, true);

    const report = await page.diagnose();
    assert.equal(report.debug.favApplied, 1);
    assert.equal(report.debug.favUnresolved, 0);
  });
});

/**
 * Joue le rôle de React : le cœur de Vinted bascule quand on le clique.
 *
 * jsdom n'exécute pas le JavaScript de Vinted, et son bouton est donc inerte.
 * Ce qu'on veut vérifier n'est de toute façon pas le comportement de Vinted mais
 * le nôtre : que l'extension **clique son bouton**, et seulement quand l'état
 * diffère. Le compteur des clics reçus le dit sans ambiguïté.
 */
function vintedHeart(heart: Element): { clicks: () => number } {
  let clicks = 0;

  heart.addEventListener('click', () => {
    clicks += 1;
    const now = heart.getAttribute('aria-pressed') === 'true';
    heart.setAttribute('aria-pressed', String(!now));
  });

  return { clicks: () => clicks };
}

describe('dans la page — le marque-page pilote le cœur Vinted', () => {
  test('enregistrer allume le cœur de Vinted', async () => {
    const page = await loadContentScript('catalog');
    await page.write({ settings: { favSync: true } });

    const { id, heart } = firstCard(page.document);
    const vinted = vintedHeart(heart);

    await page.clickMouse(page.document.querySelector(`.vf-card-btn[data-vf-id="${id}"]`));
    await settle(250);

    assert.equal(vinted.clicks(), 1);
    // Rouge : c'est Vinted qui repeint, on ne fait que déclencher son bouton.
    assert.equal(heart.getAttribute('aria-pressed'), 'true');
  });

  test('synchro éteinte, le cœur de Vinted ne bouge pas', async () => {
    const page = await loadContentScript('catalog');
    const { id, heart } = firstCard(page.document);
    const vinted = vintedHeart(heart);

    await page.clickMouse(page.document.querySelector(`.vf-card-btn[data-vf-id="${id}"]`));
    await settle(250);

    assert.equal(page.savedCount(), 1);
    assert.equal(vinted.clicks(), 0);
  });

  test("un article déjà en favori chez Vinted n'est pas décoché", async () => {
    // Le piège du bouton-bascule : cliquer un cœur déjà rouge le retire. Sans la
    // comparaison d'état, enregistrer un article qu'on avait déjà mis en favori
    // l'en sortirait — l'exact inverse de ce qu'on demande.
    // Un article mis en favori sur Vinted *avant* qu'on allume la synchro : elle
    // ne rejoue pas le passé, l'article n'est donc pas enregistré, et c'est bien
    // un ajout que le marque-page va faire.
    const page = await loadContentScript('catalog');
    const { id, heart } = firstCard(page.document);
    await flipHeart(heart, true);

    await page.write({ settings: { favSync: true } });
    const vinted = vintedHeart(heart);

    await page.clickMouse(page.document.querySelector(`.vf-card-btn[data-vf-id="${id}"]`));
    await settle(250);

    assert.equal(vinted.clicks(), 0);
    assert.equal(heart.getAttribute('aria-pressed'), 'true');
  });

  test('retirer du marque-page éteint le cœur de Vinted', async () => {
    const page = await loadContentScript('catalog');
    await page.write({ settings: { favSync: true } });

    const { id, heart } = firstCard(page.document);
    const vinted = vintedHeart(heart);
    const btn = page.document.querySelector(`.vf-card-btn[data-vf-id="${id}"]`);

    await page.clickMouse(btn);
    await settle(250);
    await page.clickMouse(btn);
    await settle(250);

    assert.equal(page.savedCount(), 0);
    assert.equal(vinted.clicks(), 2);
    assert.equal(heart.getAttribute('aria-pressed'), 'false');
  });

  test("un cœur pas encore hydraté n'est jamais cliqué à l'aveugle", async () => {
    // Sur une fiche, le bouton arrive `disabled` et sans `aria-pressed` : son
    // état est inconnu, et un clic aurait une chance sur deux de faire l'inverse.
    const page = await loadContentScript('item');
    await page.write({ settings: { favSync: true } });

    const heart = page.document.querySelector('[data-testid="favourite-button"]');
    const vinted = vintedHeart(heart);

    await page.clickMouse(page.detailButton());
    await settle(250);

    assert.equal(page.savedCount(), 1);
    assert.equal(vinted.clicks(), 0);

    const report = await page.diagnose();
    assert.equal(report.debug.favDeferred, 1);
  });
});

describe("dans la page — un article archivé n'est plus un favori", () => {
  test('son marque-page se vide, comme le cœur de Vinted', async () => {
    // Le bug : le marque-page restait plein en face d'un cœur éteint, et le clic
    // qui suivait **supprimait** l'article au lieu de le reprendre.
    const page = await loadContentScript('catalog');
    await page.write({ settings: { favSync: true } });

    const { id, heart } = firstCard(page.document);
    await flipHeart(heart, true);
    await flipHeart(heart, false);

    const [stored] = page.saved() as SavedItem[];
    assert.equal(stored?.collectionId, ARCHIVE_COLLECTION_ID);

    const btn = page.document.querySelector(`.vf-card-btn[data-vf-id="${id}"]`);
    assert.equal(btn?.getAttribute('aria-pressed'), 'false');
  });

  test('cliquer son marque-page le reprend, sans le recréer', async () => {
    const page = await loadContentScript('catalog');
    await page.write({ settings: { favSync: true } });

    const { id, heart } = firstCard(page.document);
    const vinted = vintedHeart(heart);

    await page.clickMouse(page.document.querySelector(`.vf-card-btn[data-vf-id="${id}"]`));
    await settle(250);
    const savedAt = (page.saved()[0] as SavedItem).savedAt;

    // Retiré depuis le cœur de Vinted : l'article part aux archives.
    await flipHeart(heart, false);
    assert.equal((page.saved()[0] as SavedItem).collectionId, ARCHIVE_COLLECTION_ID);

    // Puis repris depuis le marque-page.
    await page.clickMouse(page.document.querySelector(`.vf-card-btn[data-vf-id="${id}"]`));
    await settle(250);

    const [stored] = page.saved() as SavedItem[];
    // Toujours là, sorti du dépôt, et sa date d'ajout d'origine intacte : c'est
    // une reprise, pas un nouvel enregistrement.
    assert.equal(page.savedCount(), 1);
    assert.equal(stored?.collectionId, undefined, "l'article revient non classé");
    assert.equal(stored?.savedAt, savedAt);

    // Et le cœur de Vinted a suivi.
    assert.equal(heart.getAttribute('aria-pressed'), 'true');
    assert.equal(vinted.clicks(), 2);
  });
});

// ---------------------------------------------------------------------------
// L'import des favoris, jusqu'au bout de la fiche
// ---------------------------------------------------------------------------

/**
 * « Importer mes favoris » oubliait des articles, sans un mot : l'import les
 * écrivait bien, puis l'enrichissement lisait leur fiche, y voyait le badge
 * « Vendu » et les **effaçait** — la garde posée pour un clic sur une carte de
 * catalogue, où l'utilisateur ne pouvait pas savoir. Ici il sait : il a demandé
 * ses favoris, et un favori gardé après la vente l'a souvent été exprès.
 *
 * Le compte affiché venait de l'import (« 3 articles importés »), la
 * suppression arrivait après : le panneau en montrait deux.
 */
describe("dans la page — l'import des favoris", () => {
  /** Une entrée de la liste des favoris, telle que l'API la sert. */
  const favourite = (id: string, url: string) => ({
    id: Number(id),
    title: 'Prada Nylon Rucksack',
    url,
    brand_title: 'Prada',
    size_title: 'XS',
    status: 'Très bon état',
    price: { amount: '450.0', currency_code: 'EUR' },
    photo: { url: 'https://images1.vinted.net/t/x/f800/1.webp?s=abc' },
  });

  type Summary = { done: number; skipped: number };

  /**
   * Lance l'import sur une page catalogue et sert la liste des favoris.
   *
   * Le rattrapage est rendu **enveloppé** : une promesse rendue telle quelle
   * serait aplatie par le `async` de cette fonction, et l'appelant attendrait la
   * fin de l'import avant d'avoir répondu aux fiches — or l'enrichissement part
   * de `onImported`, donc pendant l'import.
   */
  async function startImport(
    page: Awaited<ReturnType<typeof loadContentScript>>,
    entries: unknown[]
  ): Promise<{ running: Promise<Summary> }> {
    page.installCsrfToken();
    // Le compte est déjà connu — c'est le balayage des offres qui l'a mis en
    // cache. Sans lui, l'API des favoris commencerait par `/users/current`.
    page.store.offers = { lastScanAt: 0, userId: '77742929' };

    const running = page.favImport() as Promise<Summary>;
    await settle(50);
    await page.respondJson({ items: entries, pagination: { total_pages: 1 } });

    return { running };
  }

  test('un favori vendu est conservé et marqué, pas effacé', async () => {
    const page = await loadContentScript('catalog');
    const { running } = await startImport(page, [favourite(SOLD_ITEM_ID, meta.soldUrl)]);

    // La fiche du favori importé : celle d'un article vendu.
    await page.respondWithFixture('sold');
    const summary = await running;

    assert.equal(summary.done, 1);
    const saved = page.store.savedItems as Record<string, SavedItem>;
    assert.equal(page.savedCount(), 1, "l'article importé ne doit pas disparaître");
    assert.equal(saved[SOLD_ITEM_ID]?.status, 'sold');
    // La fiche a répondu : l'article n'est plus en attente, même vendu.
    assert.equal(saved[SOLD_ITEM_ID]?.pending, undefined);
  });

  test('un clic sur une carte de catalogue vendue reste annulé, lui', async () => {
    // La garde d'origine ne bouge pas : là, rien ne disait à l'utilisateur que
    // l'article était vendu au moment où il l'a enregistré.
    const page = await loadContentScript('catalog');
    const { id } = firstCard(page.document);

    await page.clickMouse(page.document.querySelector(`.vf-card-btn[data-vf-id="${id}"]`));
    assert.equal(page.savedCount(), 1);

    await page.respondWithFixture('sold');
    assert.equal(page.savedCount(), 0, "l'ajout provisoire doit être annulé");
  });
});
