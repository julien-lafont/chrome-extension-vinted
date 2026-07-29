/**
 * Masquage des encarts publicitaires du fil (Braze, `feed-braze--promo-box`).
 *
 * Réglage indépendant du filtrage du bruit : pas de règle, pas de mode
 * révision, juste actif ou non, désactivé par défaut. Voir `content.ts`,
 * `markAdBlocks()` et `applyAdsClass()`.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadContentScript, settle, settleFetches } from './harness.ts';

after(settleFetches);

/** Une carte tenant sa propre cellule de grille, comme sur la page d'accueil. */
const AD_MARKUP =
  '<div data-testid="grid-item"><div data-testid="feed-braze--promo-box">Pub</div></div>';

describe('encarts publicitaires du fil', () => {
  test('désactivé par défaut : la classe de masquage n’est pas posée', async () => {
    const page = await loadContentScript('home');
    assert.equal(page.document.documentElement.classList.contains('vf-hide-ads'), false);
  });

  test('activer le réglage pose la classe sur <html>, comme le mode révision', async () => {
    const page = await loadContentScript('home');

    await page.write({ settings: { hideAds: true } });

    assert.ok(
      page.document.documentElement.classList.contains('vf-hide-ads'),
      'la classe doit apparaître dès l’écriture du réglage'
    );

    await page.write({ settings: { hideAds: false } });
    assert.equal(
      page.document.documentElement.classList.contains('vf-hide-ads'),
      false,
      'et disparaître si on désactive à nouveau'
    );
  });

  test('le marquage vise la cellule de grille, pas l’encart, pour ne pas laisser de trou', async () => {
    const page = await loadContentScript('home');

    page.document.querySelector('.feed-grid').insertAdjacentHTML('beforeend', AD_MARKUP);
    await settle(150);

    const promo = page.document.querySelector('[data-testid="feed-braze--promo-box"]');
    const cell = promo.closest('[data-testid="grid-item"]');

    assert.equal(
      promo.dataset.vfAd,
      undefined,
      'la marque ne doit pas être posée sur l’encart lui-même'
    );
    assert.equal(cell.dataset.vfAd, '1', 'mais sur la cellule qui le porte');
  });

  test('le marquage est posé même réglage désactivé : seule la classe décide de l’affichage', async () => {
    const page = await loadContentScript('home');

    page.document.querySelector('.feed-grid').insertAdjacentHTML('beforeend', AD_MARKUP);
    await settle(150);

    const cell = page.document
      .querySelector('[data-testid="feed-braze--promo-box"]')
      .closest('[data-testid="grid-item"]');

    assert.equal(cell.dataset.vfAd, '1');
    assert.equal(
      page.document.documentElement.classList.contains('vf-hide-ads'),
      false,
      'le réglage reste désactivé : la marque seule ne masque rien'
    );
  });
});
