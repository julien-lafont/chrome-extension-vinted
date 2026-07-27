/**
 * Les boutons injectés répondent-ils à tous les gestes ?
 *
 * `click` est un événement synthétisé, que le navigateur supprime dès qu'une
 * sélection de texte démarre ou que le pointeur glisse un peu. Un bouton qui ne
 * s'appuie que sur `click` « ne répond qu'une fois sur trois », sans erreur en
 * console. D'où `pointerdown` comme déclencheur souris.
 * Voir docs/pitfalls.md.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadContentScript, settleFetches } from './harness.ts';

// Solde les requêtes de fiche laissées en attente : leur délai d'expiration
// retiendrait le process de test. Voir settleFetches().
after(settleFetches);

describe('bouton de la fiche article', () => {
  test('répond quand le navigateur a supprimé le click', async () => {
    const page = await loadContentScript('item');
    const button = page.detailButton();
    const label = button.querySelector('span');

    // Le geste exact qui échouait : appui sur le libellé, click jamais émis.
    await page.pressOnly(label);

    assert.equal(page.savedCount(), 1, 'article perdu — le clic doit passer par pointerdown');
  });

  test('un geste souris complet ne compte qu’une fois', async () => {
    const page = await loadContentScript('item');
    const button = page.detailButton();

    // pointerdown ET click sont émis : si les deux déclenchaient, le toggle
    // s'annulerait aussitôt et le bouton paraîtrait inerte.
    await page.clickMouse(button);

    assert.equal(page.savedCount(), 1, 'double comptage du même geste');
  });

  test('reste accessible au clavier', async () => {
    const page = await loadContentScript('item');

    // Entrée / Espace n'émettent qu'un `click`, avec detail === 0.
    await page.pressKey(page.detailButton());

    assert.equal(page.savedCount(), 1, 'bouton inaccessible au clavier');
  });

  test('le libellé bascule avec l’état', async () => {
    const page = await loadContentScript('item');
    const button = page.detailButton();

    assert.match(button.textContent, /Enregistrer/);
    assert.equal(button.dataset.vfSaved, 'false');

    await page.clickMouse(button);

    assert.match(button.textContent, /Enregistré/);
    assert.equal(button.dataset.vfSaved, 'true');
    assert.equal(button.getAttribute('aria-pressed'), 'true');
  });
});

describe('boutons des cartes', () => {
  test('répondent aussi quand le click est supprimé', async () => {
    const page = await loadContentScript('catalog');
    const [button] = page.cardButtons();

    await page.pressOnly(button);

    assert.equal(page.savedCount(), 1);
  });

  test('un clic sur le bouton ne navigue pas vers l’article', async () => {
    const page = await loadContentScript('catalog');
    const [button] = page.cardButtons();

    // Le bouton est posé au-dessus du lien overlay de la carte : sans
    // preventDefault/stopPropagation, cliquer ouvrirait la fiche.
    let navigated = false;
    const overlay = button.closest('[data-testid^="product-item-id-"]').querySelector('a');
    overlay.addEventListener('click', (event: Event) => {
      if (!event.defaultPrevented) navigated = true;
    });

    await page.clickMouse(button);

    assert.equal(navigated, false, 'le clic ne doit pas atteindre le lien de la carte');
    assert.equal(page.savedCount(), 1);
  });

  test('chaque carte enregistre son propre article', async () => {
    const page = await loadContentScript('catalog');
    const buttons = page.cardButtons();

    await page.clickMouse(buttons[0]);
    await page.clickMouse(buttons[1]);

    const ids = page.saved().map((item) => item.id);
    assert.equal(ids.length, 2);
    assert.notEqual(ids[0], ids[1], 'deux cartes ont enregistré le même ID');
  });
});
