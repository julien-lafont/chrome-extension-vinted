/**
 * Collection par défaut de l'onglet : l'épingle du menu de rangement fait du
 * clic court un enregistrement direct dans une collection choisie.
 *
 * Ce que ces tests verrouillent, et pourquoi :
 *   — l'épingle **range et épingle** d'un seul geste. Deux actions séparées
 *     (choisir, puis cocher) demanderaient de revenir dans un menu qui s'est
 *     fermé au premier choix ;
 *   — l'article épinglé arrive **en tête de l'ordre personnalisé**, comme un
 *     rangement fait à la main. Le clic court n'écrit plus seulement
 *     `savedItems` : il touche `collections` dans le même `set`, et un ordre
 *     oublié ne se verrait qu'à l'ouverture du panneau ;
 *   — la portée est l'onglet, réellement : un second onglet sur le même storage
 *     n'hérite de rien. C'est tout l'intérêt du `sessionStorage`, et la seule
 *     façon de le prouver est de faire tourner deux instances ;
 *   — une collection supprimée depuis le panneau emporte l'épingle. Sans ça, les
 *     enregistrements suivants pointeraient une collection morte, et la pastille
 *     nommerait un tiroir inexistant.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { createSharedBackend, loadContentScript, settle, settleFetches } from './harness.ts';

after(settleFetches);

const COLLECTIONS = {
  default: { id: 'default', name: 'Mes favoris', createdAt: 0, order: [] },
  'col-1': { id: 'col-1', name: 'Vestes', createdAt: 10, order: [] },
  'col-2': { id: 'col-2', name: 'Bottes', createdAt: 20, order: [] },
};

/** Une page de catalogue dont les collections sont déjà connues du content script. */
async function catalogWithCollections(tabDefault?: string) {
  const backend = createSharedBackend();
  backend.store.collections = structuredClone(COLLECTIONS);
  return loadContentScript('catalog', { shared: backend, tabDefault });
}

describe('épingler une collection depuis le menu', () => {
  test('sans choix explicite, « Mes favoris » porte l’épingle', async () => {
    const page = await catalogWithCollections();

    await page.pressLong(page.cardButtons()[0]);

    // C'est là que va un clic court : montrer toutes les épingles vides
    // laisserait croire à une destination indéterminée.
    assert.equal(page.pickerPin('Mes favoris').getAttribute('aria-pressed'), 'true');
    assert.equal(page.pickerPin('Vestes').getAttribute('aria-pressed'), 'false');
    assert.equal(page.defaultPillText(), null, 'l’état normal n’a pas besoin de pastille');
  });

  test('épingler ailleurs déplace l’épingle', async () => {
    const page = await catalogWithCollections();

    await page.pressLong(page.cardButtons()[0]);
    await page.choose(page.pickerPin('Vestes'));
    await page.pressLong(page.cardButtons()[1]);

    assert.equal(page.pickerPin('Vestes').getAttribute('aria-pressed'), 'true');
    assert.equal(
      page.pickerPin('Mes favoris').getAttribute('aria-pressed'),
      'false',
      'une seule collection à la fois porte l’épingle'
    );
  });

  test('range l’article et fixe la collection pour l’onglet', async () => {
    const page = await catalogWithCollections();
    const [button] = page.cardButtons();
    const id = button.dataset.vfId;

    await page.pressLong(button);
    await page.choose(page.pickerPin('Vestes'));

    assert.equal(page.tabDefault(), 'col-1', 'l’épingle doit être posée sur l’onglet');
    assert.equal(page.saved()[0].collectionId, 'col-1', 'le geste range aussi l’article');
    assert.deepEqual([...(page.collections()['col-1']?.order || [])], [id]);
    assert.equal(page.picker(), null, 'le menu se ferme, comme après un rangement simple');
    assert.match(page.toastText() || '', /Vestes/);
    assert.equal(page.defaultPillText(), 'Vestes', 'l’épinglage doit être visible en permanence');
  });

  test('le clic court suivant enregistre dans la collection épinglée', async () => {
    const page = await catalogWithCollections();

    await page.pressLong(page.cardButtons()[0]);
    await page.choose(page.pickerPin('Vestes'));

    const next = page.cardButtons()[1];
    const id = next.dataset.vfId;
    await page.clickMouse(next);

    const item = page.saved().find((saved) => saved.id === id);
    assert.equal(item.collectionId, 'col-1', 'le clic court doit suivre l’épingle');
    assert.equal(
      page.collections()['col-1']?.order[0],
      id,
      'l’article doit passer en tête de l’ordre personnalisé, comme un rangement à la main'
    );
  });

  test('le bouton annonce où ira le clic', async () => {
    const page = await catalogWithCollections();

    await page.pressLong(page.cardButtons()[0]);
    await page.choose(page.pickerPin('Vestes'));

    // La pastille dit qu'un défaut est actif ; le bouton dit ce qu'il en fera.
    assert.match(page.cardButtons()[1].title, /Enregistrer dans « Vestes »/);
  });

  test('créer une collection et l’épingler dans le même geste', async () => {
    const page = await catalogWithCollections();

    await page.pressLong(page.cardButtons()[0]);
    page.picker().querySelector('.vf-picker-input').value = 'Barbour';
    await page.choose(page.pickerPinNew());
    await settle(250);

    const created = Object.values(page.collections()).find((c) => c.name === 'Barbour');
    assert.ok(created, 'la collection doit être créée');
    assert.equal(page.tabDefault(), created.id);
    assert.equal(page.saved()[0].collectionId, created.id);
    assert.equal(
      page.defaultPillText(),
      'Barbour',
      'la pastille doit nommer une collection que cet onglet vient tout juste d’apprendre'
    );
  });
});

describe('annuler l’épinglage', () => {
  test('le ✕ de la pastille rend le clic court à la collection par défaut', async () => {
    const page = await catalogWithCollections();

    await page.pressLong(page.cardButtons()[0]);
    await page.choose(page.pickerPin('Vestes'));
    await page.choose(page.defaultPillClear());

    assert.equal(page.tabDefault(), null);
    assert.equal(page.defaultPillText(), null, 'la pastille doit disparaître avec l’épingle');

    const next = page.cardButtons()[1];
    const id = next.dataset.vfId;
    await page.clickMouse(next);

    const item = page.saved().find((saved) => saved.id === id);
    assert.equal(item.collectionId, undefined, 'l’enregistrement redevient un enregistrement nu');
  });

  test('l’épingle pleine rend la main à « Mes favoris », et laisse le menu ouvert', async () => {
    const page = await catalogWithCollections('col-1');

    await page.pressLong(page.cardButtons()[0]);
    const pin = page.pickerPin('Vestes');
    assert.equal(
      pin.getAttribute('aria-pressed'),
      'true',
      'le menu doit montrer l’épingle en cours'
    );

    await page.choose(pin);

    assert.equal(page.tabDefault(), null);
    assert.equal(pin.getAttribute('aria-pressed'), 'false', 'l’épingle doit se vider sur place');
    assert.equal(
      page.pickerPin('Mes favoris').getAttribute('aria-pressed'),
      'true',
      'l’épingle ne disparaît pas, elle revient à la collection par défaut'
    );
    assert.ok(page.picker(), 'ce n’est pas un rangement : le menu reste ouvert');
    assert.equal(
      page.saved()[0].collectionId,
      'col-1',
      'l’article capturé par le geste garde la collection qu’il avait'
    );
  });

  test('l’épingle de « Mes favoris » ne se retire pas : il n’y a rien derrière', async () => {
    const page = await catalogWithCollections();

    await page.pressLong(page.cardButtons()[0]);
    const pin = page.pickerPin('Mes favoris');
    await page.choose(pin);

    // Un radio déjà coché : le geste ne fait rien plutôt que d'inventer un état
    // « aucune destination », qui n'existe pas.
    assert.equal(pin.getAttribute('aria-pressed'), 'true');
    assert.equal(page.tabDefault(), null);
    assert.ok(page.picker(), 'le menu reste ouvert');
  });
});

describe('portée de l’épinglage', () => {
  test('un autre onglet sur le même storage n’en hérite pas', async () => {
    const backend = createSharedBackend();
    backend.store.collections = structuredClone(COLLECTIONS);

    const first = await loadContentScript('catalog', { shared: backend });
    const second = await loadContentScript('catalog', { shared: backend });

    await first.pressLong(first.cardButtons()[0]);
    await first.choose(first.pickerPin('Vestes'));

    assert.equal(
      second.tabDefault(),
      null,
      'l’épingle ne doit pas franchir la frontière de l’onglet'
    );
    assert.equal(second.defaultPillText(), null);

    const button = second.cardButtons()[1];
    const id = button.dataset.vfId;
    await second.clickMouse(button);

    const item = second.saved().find((saved) => saved.id === id);
    assert.equal(item.collectionId, undefined);
  });

  test('elle survit à un rechargement de la page', async () => {
    // Ce que voit un content script qui démarre dans un onglet déjà épinglé :
    // `sessionStorage` traverse le rechargement, contrairement à la mémoire du script.
    const page = await catalogWithCollections('col-1');

    assert.equal(page.defaultPillText(), 'Vestes', 'la pastille doit être là dès le démarrage');
    assert.match(page.cardButtons()[0].title, /Enregistrer dans « Vestes »/);

    const button = page.cardButtons()[0];
    const id = button.dataset.vfId;
    await page.clickMouse(button);

    assert.equal(page.saved().find((saved) => saved.id === id).collectionId, 'col-1');
  });
});

describe('la collection épinglée change dans le panneau', () => {
  test('supprimée, elle emporte l’épingle', async () => {
    const page = await catalogWithCollections('col-1');

    // Le panneau supprime « Vestes » pendant que l'onglet est ouvert.
    await page.write({
      collections: { default: COLLECTIONS.default, 'col-2': COLLECTIONS['col-2'] },
    });

    assert.equal(page.tabDefault(), null, 'une épingle sans collection ne doit pas subsister');
    assert.equal(page.defaultPillText(), null);

    const button = page.cardButtons()[0];
    const id = button.dataset.vfId;
    await page.clickMouse(button);

    assert.equal(
      page.saved().find((saved) => saved.id === id).collectionId,
      undefined,
      'aucun article ne doit être rangé dans une collection morte'
    );
  });

  test('renommée, la pastille suit', async () => {
    const page = await catalogWithCollections('col-1');

    await page.write({
      collections: { ...COLLECTIONS, 'col-1': { ...COLLECTIONS['col-1'], name: 'Manteaux' } },
    });

    assert.equal(page.defaultPillText(), 'Manteaux');
    assert.equal(page.tabDefault(), 'col-1', 'un renommage n’est pas une suppression');
  });
});

describe('la pastille cohabite avec le reste', () => {
  test('elle s’empile avec le comptage du filtrage au lieu de le recouvrir', async () => {
    const page = await catalogWithCollections('col-1');
    const hidden = page.cardButtons()[2].dataset.vfId;

    await page.setNoise({ hidden: { [hidden]: { id: hidden, title: 'x', at: Date.now() } } });

    assert.equal(page.pills().length, 2, 'les deux pastilles doivent vivre dans la même pile');
    assert.ok(page.pillText(), 'le comptage du filtrage reste rendu');
    assert.equal(page.defaultPillText(), 'Vestes');
  });

  test('elle ne déclenche pas de boucle de repeint', async () => {
    const page = await catalogWithCollections();

    // Le MutationObserver surveille document.body, où la pile de pastilles est
    // posée : un rendu non idempotent relancerait un scan, qui repeint, à chaque
    // frame. Voir règle 3 du projet.
    const churn = page.watchChurn(page.document.body);

    await page.pressLong(page.cardButtons()[0]);
    await page.choose(page.pickerPin('Vestes'));
    await settle(400);
    const afterPin = churn();

    await settle(500);
    assert.equal(churn(), afterPin, 'le DOM continue de muter : boucle de repeint');
  });
});
