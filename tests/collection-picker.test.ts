/**
 * Capture avec choix de collection : l'appui long sur un bouton injecté ouvre
 * un menu qui range l'article sans passer par le panneau.
 *
 * Ce que ces tests verrouillent, et pourquoi :
 *   — le geste normal reste un clic court, avec exactement le comportement
 *     d'avant. L'appui long est bâti *au-dessus* de `pointerdown`, jamais à sa
 *     place : différer l'écriture jusqu'au relâchement rouvrirait la porte au
 *     bug de la règle 1 (le `click` supprimé par le navigateur) ;
 *   — un appui long sur un article **déjà enregistré** ne le perd pas. Son
 *     propre `pointerdown` vient pourtant de le retirer : c'est la restauration
 *     qui doit le remettre, et c'est le point le plus fragile de la
 *     fonctionnalité ;
 *   — un glissement n'ouvre rien. Sur mobile comme à la souris, le scroll
 *     démarre souvent sur un bouton.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadContentScript, settle, settleFetches } from './harness.ts';

after(settleFetches);

describe('appui long sur une carte du catalogue', () => {
  test('enregistre l’article et ouvre le choix de collection', async () => {
    const page = await loadContentScript('catalog');
    const [button] = page.cardButtons();

    await page.pressLong(button);

    assert.equal(page.savedCount(), 1, "l'appui long doit enregistrer comme un clic court");
    assert.ok(page.picker(), 'aucun menu de collection ouvert');
    assert.deepEqual(
      page.pickerLabels(),
      ['Aucune collection'],
      'la ligne de déclassement doit être proposée, même sans aucune collection'
    );
  });

  test('propose les collections existantes, la collection actuelle marquée', async () => {
    const page = await loadContentScript('catalog');
    page.store.collections = {
      default: { id: 'default', name: 'Mes favoris', createdAt: 0, order: [] },
      'col-1': { id: 'col-1', name: 'Vestes', createdAt: 10, order: [] },
      'col-2': { id: 'col-2', name: 'Bottes', createdAt: 20, order: [] },
    };

    await page.pressLong(page.cardButtons()[0]);

    assert.deepEqual(page.pickerLabels(), ['Aucune collection', 'Vestes', 'Bottes']);
    assert.equal(
      page.pickerItem('Aucune collection').getAttribute('aria-current'),
      'true',
      'un article fraîchement capturé n’est classé nulle part'
    );
  });

  test('« Archives » n’est jamais proposée', async () => {
    const page = await loadContentScript('catalog');
    page.store.collections = {
      default: { id: 'default', name: 'Mes favoris', createdAt: 0, order: [] },
      archives: { id: 'archives', name: 'Archives', createdAt: 10, order: [] },
      'col-1': { id: 'col-1', name: 'Vestes', createdAt: 20, order: [] },
    };

    await page.pressLong(page.cardButtons()[0]);

    // C'est le dépôt de ce qui est vendu ou parti : y ranger une pièce qu'on
    // vient de trouver n'a aucun sens, et la proposer à chaque geste fait du bruit.
    assert.deepEqual(page.pickerLabels(), ['Aucune collection', 'Vestes']);
  });

  test('un clic court reste un simple enregistrement', async () => {
    const page = await loadContentScript('catalog');

    await page.clickMouse(page.cardButtons()[0]);

    assert.equal(page.savedCount(), 1);
    assert.equal(page.picker(), null, 'un clic court ne doit rien ouvrir');
  });

  test('un glissement pendant l’appui n’ouvre rien', async () => {
    const page = await loadContentScript('catalog');

    // Le geste du scroll : le doigt part du bouton et descend.
    await page.pressAndDrag(page.cardButtons()[0]);

    assert.equal(page.savedCount(), 1, "le pointerdown enregistre, c'est le geste de base");
    assert.equal(page.picker(), null, 'un glissement n’est pas un appui long');
  });

  test('Alt+clic ouvre le menu sans attendre', async () => {
    const page = await loadContentScript('catalog');

    await page.altClick(page.cardButtons()[0]);

    assert.ok(page.picker(), 'Alt+clic doit ouvrir le choix de collection');
    assert.equal(page.savedCount(), 1);
  });
});

describe('rangement depuis le menu', () => {
  test('choisir une collection y range l’article et met son ordre à jour', async () => {
    const page = await loadContentScript('catalog');
    page.store.collections = {
      default: { id: 'default', name: 'Mes favoris', createdAt: 0, order: [] },
      'col-1': { id: 'col-1', name: 'Vestes', createdAt: 10, order: ['autre'] },
    };

    const [button] = page.cardButtons();
    const id = button.dataset.vfId;

    await page.pressLong(button);
    await page.choose(page.pickerItem('Vestes'));

    assert.equal(page.saved()[0].collectionId, 'col-1');
    assert.deepEqual(
      [...(page.collections()['col-1']?.order || [])],
      [id, 'autre'],
      "l'article rangé passe en tête de l'ordre personnalisé"
    );
    assert.equal(page.picker(), null, 'le menu doit se fermer après le choix');
    assert.match(page.toastText() || '', /Vestes/, 'le rangement doit être confirmé à l’écran');
  });

  test('créer une collection depuis le menu y range l’article', async () => {
    const page = await loadContentScript('catalog');
    const [button] = page.cardButtons();
    const id = button.dataset.vfId;

    await page.pressLong(button);

    const input = page.picker().querySelector('.vf-picker-input');
    input.value = 'Barbour';
    page
      .picker()
      .querySelector('.vf-picker-new')
      .dispatchEvent(new page.window.Event('submit', { bubbles: true, cancelable: true }));
    await settle(250);

    const created = Object.values(page.collections()).find((c) => c.name === 'Barbour');
    assert.ok(created, 'la collection doit être créée');
    assert.equal(page.saved()[0].collectionId, created?.id);
    assert.deepEqual([...(created?.order || [])], [id]);
    assert.equal(page.picker(), null);
  });

  test('Échap ferme le menu sans rien ranger', async () => {
    const page = await loadContentScript('catalog');

    await page.pressLong(page.cardButtons()[0]);
    await page.pressEscape();

    assert.equal(page.picker(), null);
    assert.equal(page.saved()[0].collectionId, undefined, 'aucun rangement ne doit avoir eu lieu');
  });
});

describe('appui long sur un article déjà enregistré', () => {
  test('ne le retire pas, et conserve son rangement', async () => {
    const page = await loadContentScript('catalog');
    page.store.collections = {
      default: { id: 'default', name: 'Mes favoris', createdAt: 0, order: [] },
      'col-1': { id: 'col-1', name: 'Vestes', createdAt: 10, order: [] },
    };

    const [button] = page.cardButtons();

    // Capture, puis rangement : l'article a une collection et une date d'ajout.
    await page.pressLong(button);
    await page.choose(page.pickerItem('Vestes'));
    const before = page.saved()[0];

    // Second appui long : son pointerdown retire l'article, la restauration
    // doit le remettre intact avant l'ouverture du menu.
    await page.pressLong(button);

    assert.equal(page.savedCount(), 1, "l'appui long ne doit jamais retirer un article");
    const after = page.saved()[0];
    assert.equal(
      after.collectionId,
      'col-1',
      'la collection doit survivre au retrait/restauration'
    );
    assert.equal(after.savedAt, before.savedAt, 'la date d’ajout ne doit pas être réécrite');
    assert.ok(page.picker());
    assert.equal(
      page.pickerItem('Vestes').getAttribute('aria-current'),
      'true',
      'le menu doit désigner la collection actuelle de l’article'
    );
  });

  test('un clic court continue de retirer', async () => {
    const page = await loadContentScript('catalog');
    const [button] = page.cardButtons();

    await page.clickMouse(button);
    assert.equal(page.savedCount(), 1);

    await page.clickMouse(button);
    assert.equal(page.savedCount(), 0, 'le clic court reste une bascule');
  });
});

describe('appui long sur la fiche article', () => {
  test('ouvre le même menu', async () => {
    const page = await loadContentScript('item');

    await page.pressLong(page.detailButton());

    assert.equal(page.savedCount(), 1);
    assert.ok(page.picker(), 'le bouton de la fiche doit répondre au même geste');
  });
});

describe('le menu ne déclenche pas de boucle de repeint', () => {
  test('son ouverture laisse le DOM Vinted tranquille', async () => {
    const page = await loadContentScript('catalog');
    const [button] = page.cardButtons();

    // Le MutationObserver surveille document.body : le menu y est ajouté, donc
    // il pourrait relancer un scan qui repeint, qui mute, à chaque frame.
    // Voir règle 3 du projet.
    const churn = page.watchChurn(page.document.body);

    await page.pressLong(button);
    await settle(400);
    const afterOpen = churn();

    await settle(500);
    assert.equal(churn(), afterOpen, 'le DOM continue de muter menu ouvert : boucle de repeint');
  });
});
