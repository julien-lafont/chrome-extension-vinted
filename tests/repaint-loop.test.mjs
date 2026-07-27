/**
 * Le content script se repeint-il en boucle ?
 *
 * Le MutationObserver surveille `document.body`. Un repeint inconditionnel écrit
 * dans le DOM, déclenche l'observer, relance un scan, repeint… à chaque frame.
 * La page rame et le bouton devient incliquable : ses enfants sont recréés entre
 * le mousedown et le mouseup. Voir docs/pitfalls.md.
 *
 * Ces tests gardent les trois garde-fous de content.js en place.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadContentScript, settle, settleFetches } from './harness.mjs';

// Solde les requêtes de fiche laissées en attente : leur délai d'expiration
// retiendrait le process de test. Voir settleFetches().
after(settleFetches);

/** Au-delà, on est clairement en boucle : un toggle légitime coûte 1 repeint. */
const CHURN_MAX = 10;

describe('stabilité du DOM', () => {
  test('le bouton de la fiche ne se repeint pas en boucle après un clic', async () => {
    const page = await loadContentScript('item');
    const button = page.detailButton();
    const churn = page.watchChurn(button);

    page.clickMouse(button);
    await settle(600);

    assert.ok(
      churn() <= CHURN_MAX,
      `${churn()} repeints en 600 ms — boucle innerHTML → observer → scan → innerHTML`
    );
  });

  test('repeindre un état inchangé ne touche pas au DOM', async () => {
    const page = await loadContentScript('item');
    const button = page.detailButton();
    const churn = page.watchChurn(button);

    // Force plusieurs scans sans changer l'état enregistré.
    for (let i = 0; i < 5; i += 1) {
      page.document.body.appendChild(page.document.createElement('div'));
      await settle(60);
    }

    assert.equal(churn(), 0, 'paintButton() doit sortir quand l’état affiché est déjà bon');
  });

  test('les cartes ne sont pas ré-injectées à chaque mutation', async () => {
    const page = await loadContentScript('catalog');
    const before = page.cardButtons().length;

    // Simule l'activité permanente de la SPA Vinted.
    for (let i = 0; i < 5; i += 1) {
      page.document.body.appendChild(page.document.createElement('div'));
      await settle(60);
    }

    assert.equal(page.cardButtons().length, before, 'boutons dupliqués sur les cartes');
  });

  test('une carte ajoutée après coup reçoit son bouton', async () => {
    const page = await loadContentScript('catalog');
    const before = page.cardButtons().length;

    // Défilement infini : Vinted insère de nouvelles cartes dans la grille.
    const source = page.document.querySelector('[data-testid="grid-item"]');
    const clone = source.cloneNode(true);
    const box = clone.querySelector('[data-testid^="product-item-id-"]');
    box.dataset.testid = 'product-item-id-999999999';
    source.parentNode.appendChild(clone);

    await settle(200);

    assert.equal(page.cardButtons().length, before + 1, 'la nouvelle carte n’a pas été traitée');
  });
});
