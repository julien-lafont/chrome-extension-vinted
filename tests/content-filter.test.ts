/**
 * Filtrage du bruit — le content script, sur la fixture de catalogue réelle.
 *
 * `noise.test.ts` couvre les règles ; ici on vérifie qu'elles atteignent
 * vraiment les cartes : verdict posé sur le bon conteneur, panneau d'annulation,
 * pastille de comptage, et surtout la garde d'idempotence de la règle 3.
 *
 * Voir `docs/specs/filtrage-bruit.md` §4 et §6.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadContentScript, settle, settleFetches } from './harness.ts';

// Solde les requêtes de fiche laissées en attente par un enregistrement.
after(settleFetches);

describe('masquage au scan', () => {
  test('une marque masquée retire ses cartes, et elles seules', async () => {
    const page = await loadContentScript('catalog');
    // La fixture porte 7 cartes « Nike », une « Nike x NBA », une « boutique
    // indépendante » et une dont la marque est une phrase entière.
    await page.setNoise({ brands: ['nike'] });

    const hidden = page.hiddenCards();
    assert.ok(hidden.length > 0, 'aucune carte masquée : la règle n’atteint pas les cartes');

    for (const box of hidden) {
      assert.equal(box.dataset.vfHidden, 'brand');
    }

    // « boutique indépendante » ne commence pas par « nike », et « Baskets Nike
    // air 42 neuves force » non plus : le préfixe exige un espace après.
    const visible = page.verdicts().filter((verdict: string) => verdict === '0');
    assert.ok(visible.length >= 2, 'le préfixe mord trop large');
  });

  test('le verdict est posé sur la cellule de grille, pas sur la carte', async () => {
    const page = await loadContentScript('catalog');
    await page.setNoise({ words: ['enfant'] });

    const [hidden] = page.hiddenCards();

    // Masquer la carte laissait sa cellule en place, vide : la grille gardait un
    // trou blanc, et une ligne ne se refermait que lorsque ses quatre cartes
    // étaient masquées. C'est la cellule qui doit disparaître — l'auto-placement
    // CSS Grid fait alors remonter les suivantes tout seul.
    assert.equal(
      hidden.dataset.testid,
      'grid-item',
      'la carte est enfouie trois niveaux sous sa cellule : masquer la carte ne referme rien'
    );
    assert.ok(
      hidden.querySelector('[data-testid^="product-item-id-"]'),
      'et la cellule doit bien contenir la carte visée'
    );
  });

  test('un mot exclu masque par le titre', async () => {
    const page = await loadContentScript('catalog');
    await page.setNoise({ words: ['enfant'] });

    const hidden = page.hiddenCards();
    assert.equal(hidden.length, 1, 'un seul article « enfant » dans la fixture');
    assert.equal(hidden[0].dataset.vfHidden, 'word');
  });

  test('un article enregistré échappe à la règle qui le viserait', async () => {
    const page = await loadContentScript('catalog');

    // On enregistre la première carte, puis on masque sa marque.
    const button = page.cardButtons()[0];
    await page.clickMouse(button);
    const savedId = button.dataset.vfId;

    await page.setNoise({ brands: ['nike'] });

    const box = page.cardBox(savedId);
    assert.ok(box, 'la carte enregistrée doit rester dans le document');
    assert.equal(box.dataset.vfHidden, '0', "l'enregistrement l'emporte sur la règle");
  });

  test('le verdict est reposé quand les règles changent', async () => {
    const page = await loadContentScript('catalog');
    assert.equal(page.hiddenCards().length, 0);

    await page.setNoise({ brands: ['nike'] });
    assert.ok(page.hiddenCards().length > 0, 'la règle arrivée après coup doit être appliquée');

    // Sans le compteur de révision, une carte jugée visible sous les anciennes
    // règles ne serait jamais réévaluée : la garde sortirait avant le calcul.
    await page.setNoise({});
    assert.equal(page.hiddenCards().length, 0, 'retirer la règle doit tout réafficher');
  });
});

describe('écarter un article', () => {
  test('le clic écrit la règle et ouvre le panneau d’annulation', async () => {
    const page = await loadContentScript('catalog');

    const hide = page.hideButtons()[0];
    assert.ok(hide, 'aucun bouton d’écart injecté');
    const id = hide.dataset.vfId;

    await page.clickMouse(hide);

    assert.ok(page.noise()?.hidden?.[id], "l'article doit être écarté en storage");
    assert.ok(page.undoPanel(), "le panneau d'annulation doit s'afficher");
    assert.ok(
      page.undoRules().some((label: string) => /^Masquer tous les produits Nike$/.test(label)),
      'le panneau doit proposer la règle de marque, en toutes lettres'
    );
  });

  test('la carte reste visible tant que le panneau est ouvert', async () => {
    const page = await loadContentScript('catalog');

    const hide = page.hideButtons()[0];
    const id = hide.dataset.vfId;
    await page.clickMouse(hide);

    // L'écart est écrit tout de suite, mais le masquage attend l'expiration :
    // sinon la carte disparaît dans la foulée du clic et emporte avec elle le
    // « Annuler » qu'on venait d'afficher. Le panneau est ancré au conteneur
    // d'image, la carte est son ancêtre — confondre les deux rend la garde
    // toujours fausse, et ça ne se voit pas à l'œil en jsdom (pas de CSS).
    assert.ok(page.noise()?.hidden?.[id], "l'écart doit être écrit immédiatement");
    assert.equal(
      page.cardBox(id)?.dataset.vfHidden,
      '0',
      'la carte ne doit pas être masquée pendant la fenêtre d’annulation'
    );
  });

  test('« Annuler » remet l’article', async () => {
    const page = await loadContentScript('catalog');

    const hide = page.hideButtons()[0];
    const id = hide.dataset.vfId;
    await page.clickMouse(hide);

    await page.clickMouse(page.undoCancel());

    assert.equal(page.noise()?.hidden?.[id], undefined, "l'écart doit être défait");
    assert.equal(page.undoPanel(), null, 'le panneau doit avoir disparu');
    assert.equal(page.cardBox(id)?.dataset.vfHidden, '0', 'la carte redevient visible');
  });

  test('« Masquer tous les produits Nike » écrit une règle générale', async () => {
    const page = await loadContentScript('catalog');

    const hide = page.hideButtons()[0];
    await page.clickMouse(hide);

    await page.clickMouse(page.undoRule('Nike'));

    // Recopié dans un tableau du realm de test : celui du storage vient de jsdom,
    // et `deepEqual` strict compare aussi les prototypes.
    assert.deepEqual([...(page.noise()?.brands ?? [])], ['nike']);
    assert.ok(page.hiddenCards().length > 1, 'toutes les cartes de la marque doivent se replier');
  });

  test('recliquer l’œil d’un article déjà écarté le remet', async () => {
    const page = await loadContentScript('catalog');

    const hide = page.hideButtons()[0];
    const id = hide.dataset.vfId;

    await page.clickMouse(hide);
    await settle(2400); // le repli va au bout : plus de panneau d'annulation
    assert.ok(page.noise()?.hidden?.[id], 'la carte est écartée');
    assert.equal(page.cardBox(id)?.dataset.vfHidden, 'item');

    // Le même bouton, devenu œil ouvert : le geste inverse au même endroit —
    // c'est ce qui rend le mode révision utilisable pour repêcher une carte.
    assert.match(hide.title, /remettre/i);
    await page.clickMouse(hide);

    assert.equal(page.noise()?.hidden?.[id], undefined, "l'écart doit être défait");
    assert.equal(page.cardBox(id)?.dataset.vfHidden, '0');
    assert.match(hide.title, /écarter/i, 'le bouton reprend son sens premier');
  });

  test('le bouton est inerte sur un article déjà enregistré', async () => {
    const page = await loadContentScript('catalog');

    const button = page.cardButtons()[0];
    await page.clickMouse(button);
    const id = button.dataset.vfId;

    const hide = page.hideButtonOf(id);
    assert.equal(hide.disabled, true);
    assert.match(hide.title, /enregistré/i);

    await page.clickMouse(hide);
    assert.equal(page.noise()?.hidden?.[id], undefined, 'un clic ne doit rien écrire');
  });
});

describe('pastille de comptage', () => {
  test('elle n’apparaît que lorsqu’il y a quelque chose à compter', async () => {
    const page = await loadContentScript('catalog');
    assert.equal(page.pillText(), null);

    await page.setNoise({ words: ['enfant'] });

    assert.equal(page.pillText(), '1 masqué');
  });

  test('« Afficher » bascule en mode révision, sans rien écrire en storage', async () => {
    const page = await loadContentScript('catalog');
    await page.setNoise({ brands: ['nike'] });

    await page.clickMouse(page.pillToggle());

    assert.ok(
      page.document.documentElement.classList.contains('vf-reveal'),
      'la classe de révision doit être posée sur <html>'
    );
    // Transitoire et local à la page : le réglage durable vit dans le panneau.
    assert.equal(page.store.settings, undefined);
  });
});

describe('idempotence — règle 3', () => {
  test('des scans répétés ne réécrivent rien sur les cartes', async () => {
    const page = await loadContentScript('catalog');
    await page.setNoise({ brands: ['nike'] });

    const box = page.hiddenCards()[0];
    const churn = page.watchChurn(box);

    // Simule l'activité permanente de la SPA Vinted.
    for (let i = 0; i < 5; i += 1) {
      page.document.body.appendChild(page.document.createElement('div'));
      await settle(60);
    }

    assert.equal(churn(), 0, 'applyFilters() doit sortir quand le verdict est déjà posé');
  });

  test('la pose se répare si Vinted efface nos attributs', async () => {
    const page = await loadContentScript('catalog');
    await page.setNoise({ brands: ['nike'] });

    const box = page.hiddenCards()[0];
    // Ce que fait un re-rendu React : nos `data-*` disparaissent avec le reste.
    box.removeAttribute('data-vf-hidden');
    box.removeAttribute('data-vf-rev');

    page.document.body.appendChild(page.document.createElement('div'));
    await settle(150);

    assert.equal(
      box.dataset.vfHidden,
      'brand',
      'une garde qui ne lit que son drapeau laisserait la carte visible pour toujours'
    );
  });
});

describe('diagnostic', () => {
  test('il rapporte les règles, les motifs et le taux de résolution du vendeur', async () => {
    const page = await loadContentScript('catalog');
    await page.setNoise({ brands: ['nike'], words: ['lot'] });

    const report = await page.diagnose();

    assert.equal(report.regles.marques, 1);
    assert.equal(report.regles.mots, 1);
    assert.ok(report.cartesMasquees > 0);
    assert.equal(report.motifs.brand, report.cartesMasquees);
    // Le format compte : c'est ce qu'on lit pour trancher la question du §7.
    assert.match(report.vendeursSurCartes, /^\d+\/\d+$/);
  });
});
