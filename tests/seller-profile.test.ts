/**
 * Le pays du vendeur, de la page profil jusqu'au storage.
 *
 * C'est la seule information de l'extension qui exige une **seconde** page :
 * la fiche ne la porte nulle part (voir `shared/seller.ts`). Ce fichier vérifie
 * la chaîne complète — requête émise après l'enrichissement, pays écrit sur
 * l'article, et surtout **jamais redemandé** : le pays d'un compte ne change
 * pas, et une relecture par article coûterait une requête pour rien.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadContentScript, settleFetches, settle } from './harness.ts';

after(settleFetches);

/** Requête de profil en attente, s'il y en a une. */
const memberCall = (page: Awaited<ReturnType<typeof loadContentScript>>): string | undefined =>
  page.pendingFetches().find((call) => call.url.includes('/member/'))?.url;

describe('pays du vendeur', () => {
  test('l’article enregistré depuis sa fiche reçoit le pays de son vendeur', async () => {
    const page = await loadContentScript('item');

    await page.clickMouse(page.detailButton());

    // La taille passe d'abord (une requête d'API), le profil ensuite : la file
    // d'enrichissement est sérialisée. On solde la première pour libérer la
    // seconde.
    await page.respondJson({ size_groups: [] });

    assert.match(memberCall(page) ?? '', /\/member\/\d+$/, 'profil du vendeur non demandé');
    await page.respondWithFixture('member');

    const [item] = page.saved();
    assert.equal(item.sellerCountry, 'FR', 'pays non enregistré');
  });

  test('un article venu d’une carte reçoit le pays lui aussi', async () => {
    const page = await loadContentScript('catalog');

    await page.clickMouse(page.cardButtons()[0]);
    await page.respondWithFixture('item'); // la fiche, qui donne le vendeur
    await page.respondJson({ size_groups: [] }); // la taille

    assert.ok(memberCall(page), 'profil du vendeur non demandé après enrichissement');
    await page.respondWithFixture('member');

    assert.equal(page.saved()[0].sellerCountry, 'FR');
  });

  test('un profil sans localisation range une réponse, pas un trou', async () => {
    const page = await loadContentScript('item');

    await page.clickMouse(page.detailButton());
    await page.respondJson({ size_groups: [] });

    // Vinted sert le profil, mais le membre n'expose pas sa ville : c'est une
    // réponse définitive. `null` la distingue de « jamais lu » (`undefined`),
    // qui seul autorise une nouvelle requête.
    await page.respond({
      ok: true,
      status: 200,
      text: () => Promise.resolve('<!DOCTYPE html><p>profil sans localisation</p>'),
    });

    assert.equal(page.saved()[0].sellerCountry, null);
  });

  test('une requête échouée laisse le champ absent, pas nul', async () => {
    const page = await loadContentScript('item');

    await page.clickMouse(page.detailButton());
    await page.respondJson({ size_groups: [] });
    await page.failFetch();

    // Rien n'est écrit : le prochain enregistrement du même vendeur retentera.
    assert.equal(page.saved()[0].sellerCountry, undefined);
  });

  test('un vendeur déjà consulté n’est pas relu', async () => {
    const page = await loadContentScript('item');

    // Premier enregistrement : le profil est lu.
    await page.clickMouse(page.detailButton());
    await page.respondJson({ size_groups: [] });
    assert.ok(memberCall(page), 'profil du vendeur non demandé la première fois');
    await page.respondWithFixture('member');

    // Retiré puis remis : c'est le même vendeur, et chiner en enregistre cinq
    // pièces d'affilée. Le pays ne bouge pas — la page s'en souvient.
    // La table des tailles, elle, est déjà en cache pour cette catégorie : rien
    // à répondre cette fois, la file arrive directement au profil.
    await page.clickMouse(page.detailButton());
    await page.clickMouse(page.detailButton());
    await settle(300);

    assert.equal(memberCall(page), undefined, 'profil relu pour un vendeur déjà connu');
    assert.equal(page.saved()[0].sellerCountry, 'FR', 'pays perdu au ré-enregistrement');
  });
});
