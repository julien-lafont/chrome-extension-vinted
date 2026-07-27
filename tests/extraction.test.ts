/**
 * L'extraction lit-elle correctement le markup Vinted ?
 *
 * C'est la suite qui casse en premier quand Vinted change son front. Un échec ici
 * veut dire : rafraîchir les fixtures (`npm run refresh-fixtures`), relancer, et
 * si c'est toujours rouge, mettre à jour les ancres dans content.js.
 * Voir docs/vinted-dom.md.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadContentScript, meta, settle, settleFetches } from './harness.mjs';

// Solde les requêtes de fiche laissées en attente : leur délai d'expiration
// retiendrait le process de test. Voir settleFetches().
after(settleFetches);

describe('page de résultats', () => {
  test('détecte toutes les cartes et injecte un bouton sur chacune', async () => {
    const page = await loadContentScript('catalog');
    const report = await page.diagnose();

    assert.equal(report.cardsFound, meta.cards, 'cartes détectées');
    assert.equal(report.cardsParsed, meta.cards, 'cartes correctement parsées');
    assert.equal(report.cardButtons, meta.cards, 'boutons injectés');
  });

  test('extrait tous les champs affichés dans le panneau', async () => {
    const page = await loadContentScript('catalog');
    const { missing, sample } = await page.diagnose();

    // `size` est absent de certains articles chez Vinted : on ne l'exige pas.
    assert.equal(missing.title, 0, 'titre manquant sur certaines cartes');
    assert.equal(missing.brand, 0, 'marque manquante');
    assert.equal(missing.price, 0, 'prix manquant');
    assert.equal(missing.imageUrl, 0, 'miniature manquante');

    assert.match(sample.id, /^\d+$/, "l'ID doit être numérique");
    assert.match(sample.url, /^https:\/\/www\.vinted\.fr\/items\/\d+/);
    assert.ok(!sample.url.includes('?'), 'le ?referrer= doit être retiré');
    assert.equal(sample.source, 'catalog');
  });

  test("le titre ne contient pas les métadonnées du libellé d'accessibilité", async () => {
    const page = await loadContentScript('catalog');
    const { sample } = await page.diagnose();

    // Le libellé vaut "{titre}, marque: X, état: Y, taille: Z, {prix}".
    // On doit couper à ", marque:" — pas à la première virgule, un titre peut
    // en contenir. Voir parseTitleFromLabel().
    assert.doesNotMatch(sample.title, /marque\s*:/i);
    assert.doesNotMatch(sample.title, /état\s*:/i);
    assert.ok(sample.title.length > 0);
  });

  test('un clic enregistre, un second retire', async () => {
    const page = await loadContentScript('catalog');
    const [button] = page.cardButtons();

    await page.clickMouse(button);
    assert.equal(page.savedCount(), 1, 'article non enregistré');

    const [item] = page.saved();
    assert.ok(item.savedAt > 0, 'savedAt absent');
    assert.ok(item.title && item.price, 'métadonnées perdues à l’enregistrement');

    await page.clickMouse(button);
    assert.equal(page.savedCount(), 0, 'le second clic doit retirer l’article');
  });
});

describe('données de tri', () => {
  // Le panneau trie par prix, état, likes et taille. Chacun de ces modes a besoin
  // d'un champ enregistré : ce qui compte n'est pas ce que la page affiche, mais
  // ce qui atterrit dans le storage au clic. Voir sidepanel/sorting.js.

  test('chaque carte enregistre prix, état, taille et likes', async () => {
    const page = await loadContentScript('catalog');
    const { missing, cardsParsed } = await page.diagnose();

    assert.equal(missing.priceValue, 0, 'prix numérique manquant');
    assert.equal(missing.favouriteCount, 0, 'nombre de favoris manquant');
    assert.equal(missing.condition, 0, 'état manquant');

    // La taille manque légitimement sur les accessoires, jamais partout.
    assert.ok(missing.size < cardsParsed, 'aucune carte n’a de taille');
  });

  test('le prix numérique correspond au prix affiché', async () => {
    const page = await loadContentScript('catalog');

    for (const button of page.cardButtons()) await page.clickMouse(button);

    for (const item of page.saved()) {
      assert.equal(typeof item.priceValue, 'number', `priceValue absent : ${item.title}`);
      // "3,00 €" → 3
      const shown = Number.parseFloat(item.price.replace(/[^\d,.]/g, '').replace(',', '.'));
      assert.equal(item.priceValue, shown, `prix incohérent : ${item.price}`);
      assert.equal(typeof item.favouriteCount, 'number', `likes absents : ${item.title}`);
    }
  });

  test("une carte sans taille n'enregistre pas l'état comme taille", async () => {
    const page = await loadContentScript('catalog');

    // Sacs et accessoires : le sous-titre se réduit à l'état ("Très bon état"),
    // sans rien pour signaler la taille absente.
    const button = page.cardButtonWhere((label) => label && !/taille\s*:/i.test(label));
    assert.ok(button, 'la fixture ne contient plus de carte sans taille');

    await page.clickMouse(button);
    const [item] = page.saved();

    assert.equal(item.size, '', `état rangé dans la taille : ${item.size}`);
    assert.match(item.condition, /état|neuf|satisfaisant/i, 'état perdu');
  });

  test('un article sans marque garde un titre sans métadonnées', async () => {
    const page = await loadContentScript('catalog');

    // Le titre se coupe au premier attribut du libellé. Couper au seul
    // ", marque:" laissait tout le libellé en titre sur ces cartes-là.
    const button = page.cardButtonWhere((label) => label && !/marque\s*:/i.test(label));
    assert.ok(button, 'la fixture ne contient plus de carte sans marque');

    await page.clickMouse(button);
    const [item] = page.saved();

    assert.doesNotMatch(item.title, /état\s*:/i, `titre pollué : ${item.title}`);
    assert.doesNotMatch(item.title, /taille\s*:/i, `titre pollué : ${item.title}`);
    assert.match(item.condition, /état|neuf|satisfaisant/i, 'état perdu');
    assert.ok(item.size, 'taille perdue');
  });
});

describe('catégorie', () => {
  // Elle est enregistrée pour pouvoir relancer une recherche : ce qui compte est
  // l'URL de catalogue, pas seulement le nom.

  test("la fiche article donne la catégorie exacte, sans le maillon de marque", async () => {
    const page = await loadContentScript('item');
    const { detailExtraction } = await page.diagnose();
    const { category } = detailExtraction;

    assert.ok(category, 'aucune catégorie extraite');
    assert.equal(category.exact, true);
    assert.match(category.id, /^\d+$/, 'identifiant de catalogue absent');
    assert.match(category.url, /^https:\/\/www\.vinted\.fr\/catalog\/\d+-/);

    // Le dernier maillon du fil croise la marque ("Nike Hauts et t-shirts") :
    // relancer une recherche depuis là la restreindrait à cette marque.
    assert.doesNotMatch(category.url, /\/brand\//, 'maillon de marque retenu');
    assert.ok(category.path.length > 1, 'chemin de catégories perdu');
    assert.equal(category.path[category.path.length - 1], category.name);
  });

  test('les cartes d’une page catégorie héritent de la catégorie de la page', async () => {
    const page = await loadContentScript('category');

    for (const button of page.cardButtons()) await page.clickMouse(button);
    const saved = page.saved();
    assert.ok(saved.length, 'aucune carte enregistrée');

    for (const item of saved) {
      assert.ok(item.category, `catégorie absente : ${item.title}`);
      assert.match(item.category.url, /\/catalog\/\d+-/);
      // Le fil décrit la page, pas la carte : la vraie catégorie de l'article
      // peut être une sous-catégorie plus fine.
      assert.equal(item.category.exact, false);
    }
  });

  test('une recherche par mots-clés n’invente pas de catégorie', async () => {
    const page = await loadContentScript('catalog');

    const [button] = page.cardButtons();
    await page.clickMouse(button);
    const [item] = page.saved();

    // Avant que la fiche ne réponde : rien n'est deviné depuis la page.
    assert.equal(item.category, null, 'catégorie inventée hors page catégorie');
    assert.ok(item.title && item.price, 'le reste de l’extraction doit tenir');
  });
});

describe('enrichissement par la fiche', () => {
  // Une carte ne porte pas tout : l'article est enregistré immédiatement avec ce
  // qu'elle affiche, puis complété par sa fiche, récupérée par fetch.
  // La première carte de la fixture catalogue est l'article de la fixture fiche :
  // c'est ce qui permet de répondre une fiche cohérente.

  test('l’article est enregistré avant que la fiche ne réponde', async () => {
    const page = await loadContentScript('catalog');

    await page.clickMouse(page.cardButtons()[0]);

    // Ce que voit le panneau dès le clic : l'article, marqué en attente.
    assert.equal(page.savedCount(), 1, 'enregistrement différé à la requête');
    const [item] = page.saved();
    assert.equal(item.pending, true, 'état d’attente absent — rien à afficher');
    assert.ok(item.title && item.price && item.imageUrl, 'placeholder vide');

    assert.equal(page.pendingFetches().length, 1, 'fiche non demandée');
  });

  test('la fiche complète l’article et lève l’attente', async () => {
    const page = await loadContentScript('catalog');

    await page.clickMouse(page.cardButtons()[0]);
    await page.respondWithFixture('item');

    const [item] = page.saved();
    assert.equal(item.pending, undefined, 'l’article reste marqué en attente');
    assert.equal(item.source, 'detail', 'les données ne viennent pas de la fiche');

    // Ce que la carte ne pouvait pas donner.
    assert.ok(item.category, 'catégorie toujours absente');
    assert.equal(item.category.exact, true);
    assert.match(item.category.url, /\/catalog\/\d+-/);
    assert.equal(typeof item.favouriteCount, 'number');
    assert.ok(item.size && item.condition);
  });

  test('un article retiré pendant la requête ne réapparaît pas', async () => {
    const page = await loadContentScript('catalog');
    const button = page.cardButtons()[0];

    await page.clickMouse(button);
    await page.clickMouse(button); // retiré avant que la fiche ne réponde
    assert.equal(page.savedCount(), 0);

    await page.respondWithFixture('item');

    assert.equal(page.savedCount(), 0, 'l’enrichissement a ressuscité l’article');
  });

  test('une fiche illisible laisse les données de la carte', async () => {
    const page = await loadContentScript('catalog');

    await page.clickMouse(page.cardButtons()[0]);
    const before = page.saved()[0];

    await page.respond({ ok: false, status: 503, text: async () => '' });

    const [item] = page.saved();
    assert.equal(item.pending, undefined, 'l’attente doit être levée même en échec');
    assert.equal(item.title, before.title, 'données de la carte perdues');
    assert.equal(item.price, before.price);
    assert.equal(item.source, 'catalog');
  });

  test('une fiche muette n’efface pas les données de la carte', async () => {
    const page = await loadContentScript('catalog');

    await page.clickMouse(page.cardButtons()[0]);
    const before = page.saved()[0];

    // Une page qui répond 200 mais où rien de ce qu'on lit n'existe : ancres
    // changées, ou page d'erreur maquillée. Ce que la carte savait vaut mieux
    // que le vide qu'on vient de lire.
    await page.respondWithFixture('catalog');

    const [item] = page.saved();
    assert.equal(item.price, before.price, 'prix effacé par une fiche muette');
    assert.equal(item.condition, before.condition, 'état effacé');
    assert.equal(item.size, before.size, 'taille effacée');
    assert.equal(item.pending, undefined);
  });

  test('une coupure réseau ne perd pas l’article', async () => {
    const page = await loadContentScript('catalog');

    await page.clickMouse(page.cardButtons()[0]);
    await page.failFetch();

    assert.equal(page.savedCount(), 1);
    assert.equal(page.saved()[0].pending, undefined);
  });

  test('une fiche qui décrit un autre article est ignorée', async () => {
    const page = await loadContentScript('catalog');

    // Seconde carte : la fiche servie (fixture) est celle de la première.
    // Vinted redirige ainsi les articles retirés ou fusionnés.
    await page.clickMouse(page.cardButtons()[1]);
    const before = page.saved()[0];

    await page.respondWithFixture('item');

    const [item] = page.saved();
    assert.equal(item.title, before.title, 'article écrasé par une autre fiche');
    assert.equal(item.id, before.id);
    assert.equal(item.pending, undefined);
  });

  test('les fiches sont demandées une par une', async () => {
    const page = await loadContentScript('catalog');

    for (const button of page.cardButtons()) await page.clickMouse(button);
    assert.ok(page.savedCount() > 1, 'plusieurs articles attendus');

    // Dix articles enregistrés d'affilée ne doivent pas lancer dix requêtes
    // de 2 Mo en parallèle : l'utilisateur ne les attend pas.
    assert.equal(page.pendingFetches().length, 1, 'requêtes de fiche en parallèle');
  });

  test('un enregistrement depuis la fiche ne déclenche aucune requête', async () => {
    const page = await loadContentScript('item');

    await page.clickMouse(page.detailButton());

    assert.equal(page.savedCount(), 1);
    assert.equal(page.saved()[0].pending, undefined, 'attente inutile depuis la fiche');
    assert.equal(page.pendingFetches().length, 0, 'la fiche est déjà là');
  });
});

describe('fiche article', () => {
  test('lit le JSON-LD schema.org', async () => {
    const page = await loadContentScript('item');
    const report = await page.diagnose();

    assert.equal(report.isDetailPage, true);
    assert.equal(report.detailJsonLd, true, 'JSON-LD Product introuvable');
    assert.equal(report.detailButton, 'présent');
  });

  test('formate le prix comme le catalogue', async () => {
    const page = await loadContentScript('item');
    const { detailExtraction } = await page.diagnose();

    // Le JSON-LD donne un nombre brut (1) ; le catalogue affiche "1,00 €".
    // Les deux sources doivent produire la même chaîne.
    assert.match(detailExtraction.price, /^\d+,\d{2}\s€$/, `prix inattendu : ${detailExtraction.price}`);
    assert.equal(detailExtraction.source, 'detail');
    assert.match(detailExtraction.id, /^\d+$/);
    assert.ok(detailExtraction.title.length > 0);
  });

  test('livre les mêmes champs de tri que le catalogue', async () => {
    const page = await loadContentScript('item');
    const { detailExtraction } = await page.diagnose();

    // La ligne d'attribut empile son libellé et sa valeur : lire le bloc entier
    // donnait "Taille42" et "ÉtatNeuf avec étiquette".
    assert.doesNotMatch(detailExtraction.size, /taille/i, 'libellé collé à la taille');
    assert.doesNotMatch(detailExtraction.condition, /^état/i, "libellé collé à l'état");
    assert.ok(detailExtraction.size, 'taille absente');
    assert.match(detailExtraction.condition, /état|neuf|satisfaisant/i);

    assert.equal(typeof detailExtraction.priceValue, 'number', 'prix numérique absent');
    // Le bouton cœur de la fiche arrive vide : le compteur vient du flux
    // d'hydratation. Voir favouriteCountFromHydration().
    assert.equal(typeof detailExtraction.favouriteCount, 'number', 'likes absents');
  });

  test('enregistre depuis le bouton flottant', async () => {
    const page = await loadContentScript('item');

    await page.clickMouse(page.detailButton());

    assert.equal(page.savedCount(), 1);
    assert.equal(page.saved()[0].source, 'detail');
  });

  test('reflète un article déjà enregistré au chargement', async () => {
    const id = meta.itemUrl.match(/\/items\/(\d+)/)[1];
    const page = await loadContentScript('item', {
      saved: { [id]: { id, title: 'déjà là', savedAt: 1 } },
    });

    assert.equal(page.detailButton().dataset.vfSaved, 'true');
    assert.match(page.detailButton().textContent, /Enregistré/);
  });
});

describe('blocs d’articles d’une fiche', () => {
  // « Dressing du membre » et « Articles similaires » réutilisent la carte du
  // catalogue mais lui donnent leur propre préfixe de data-testid : le sélecteur
  // `product-item-id-` ne les voyait pas, et le bouton n'apparaissait nulle part
  // sous la fiche. Voir blockCards() et docs/vinted-dom.md.

  test('injecte un bouton sur les cartes du dressing du membre', async () => {
    const page = await loadContentScript('item');
    assert.equal(page.cardButtons().length, 0, 'la fiche servie ne contient aucune carte');

    await page.appendItemBlock('other_user_items', 3);

    assert.equal(page.cardButtons().length, 3, 'aucun bouton sur les cartes du dressing');
  });

  test('voit aussi les blocs que Vinted ajoutera plus tard', async () => {
    // Le préfixe est dérivé du conteneur, jamais d'une liste de plugins connus :
    // un bloc inédit doit marcher sans changement de code.
    const page = await loadContentScript('item');

    await page.appendItemBlock('similar_items', 2);
    await page.appendItemBlock('you_might_also_like', 2);

    assert.equal(page.cardButtons().length, 4);
  });

  test('enregistre l’article de la carte, pas celui de la fiche', async () => {
    const page = await loadContentScript('item');
    const block = await page.appendItemBlock('other_user_items', 3);

    // La première carte de la fixture catalogue est l'article de la fixture
    // fiche : on prend une autre, sans quoi le test ne prouverait rien.
    const detailId = meta.itemUrl.match(/\/items\/(\d+)/)[1];
    const box = [
      ...block.querySelectorAll('[data-testid^="other_user_items-"]:not([data-testid*="--"])'),
    ].find((el) => el.dataset.testid !== `other_user_items-${detailId}`);
    const cardId = box.dataset.testid.replace('other_user_items-', '');

    await page.clickMouse(box.querySelector('.vf-card-btn'));

    const [item] = page.saved();
    assert.equal(item.id, cardId);
    assert.equal(item.pending, true, 'la fiche de la carte doit être demandée');
    assert.equal(page.pendingFetches()[0].url, item.url);
  });

  test('n’hérite pas de la catégorie de la fiche affichée', async () => {
    // Le fil d'Ariane d'une fiche décrit l'article affiché. Une carte du
    // dressing relève d'un tout autre rayon : hériter de ce fil enregistrerait
    // une catégorie fausse, que rien ne signalerait si la fiche ne répondait pas.
    const page = await loadContentScript('item');
    const block = await page.appendItemBlock('other_user_items', 1);

    await page.clickMouse(block.querySelector('.vf-card-btn'));

    assert.equal(page.saved()[0].category, null);
  });

  test('le bouton flottant de la fiche reste celui de la fiche', async () => {
    const page = await loadContentScript('item');
    const detailId = meta.itemUrl.match(/\/items\/(\d+)/)[1];

    await page.appendItemBlock('other_user_items', 3);

    assert.equal(page.detailButton().dataset.vfId, detailId);
  });

  test('ne repeint pas en boucle quand un bloc arrive', async () => {
    const page = await loadContentScript('item');
    const block = await page.appendItemBlock('other_user_items', 3);

    const churn = page.watchChurn(block);
    await settle(300);

    assert.equal(churn(), 0, 'le bloc est réécrit à chaque frame');
  });
});
