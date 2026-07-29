/**
 * La page d'accueil de vinted.fr — le premier écran d'une session de chine.
 *
 * Ses cartes ont le markup du catalogue mais un `data-testid` **fixe** :
 * `feed-item`, identique pour les vingt cartes de la page, sans identifiant
 * nulle part. `CATALOG_CARDS` ne les voyait donc pas et l'extension y était
 * totalement inerte — sans erreur en console, comme toujours.
 *
 * Le point délicat n'est pas de les sélectionner, c'est d'en tirer l'ID : il
 * n'existe que dans l'URL du lien overlay. Ce repli doit rester réservé aux
 * testids connus pour ne pas en porter, sous peine de faire passer pour une
 * carte n'importe quel conteneur qui en contient — d'où le dernier test.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadContentScript, settleFetches, settle } from './harness.ts';

after(settleFetches);

describe('fil de la page d’accueil', () => {
  test('un bouton est injecté sur chaque carte', async () => {
    const page = await loadContentScript('home');

    const cards = page.document.querySelectorAll('[data-testid="feed-item"]');
    assert.ok(cards.length >= 4, 'la fixture doit porter plusieurs cartes');
    assert.equal(
      page.cardButtons().length,
      cards.length,
      'chaque carte du fil doit recevoir son bouton'
    );
  });

  test('l’identifiant est lu dans l’URL, faute de testid qui le porte', async () => {
    const page = await loadContentScript('home');

    for (const button of page.cardButtons()) {
      const id = button.dataset.vfId;
      assert.match(id || '', /^\d+$/, 'identifiant absent ou non numérique');

      const href = button
        .closest('[data-testid="feed-item"]')
        .querySelector('[data-testid$="--overlay-link"]')
        .getAttribute('href');
      assert.ok(href.includes(`/items/${id}`), `${id} ne correspond pas au lien de sa carte`);
    }
  });

  test('la capture enregistre l’article de la bonne carte', async () => {
    const page = await loadContentScript('home');
    const [button] = page.cardButtons();

    await page.clickMouse(button);

    const [item] = page.saved();
    assert.equal(item.id, button.dataset.vfId);
    assert.ok(item.title, 'titre non extrait du libellé d’accessibilité');
    assert.equal(typeof item.priceValue, 'number', 'prix non extrait');
    assert.ok(item.url.includes(`/items/${item.id}`));
  });

  test('les identifiants sont tous distincts', async () => {
    const page = await loadContentScript('home');

    const ids = page.cardButtons().map((button) => button.dataset.vfId);
    assert.equal(new Set(ids).size, ids.length, 'deux cartes ont enregistré le même ID');
  });

  test('masquer une carte du fil referme la grille, pas seulement la carte', async () => {
    const page = await loadContentScript('home');
    const [button] = page.cardButtons();
    const id = button.dataset.vfId;

    await page.setNoise({ hidden: { [id]: Date.now() } });

    const [hidden] = page.hiddenCards();
    assert.ok(hidden, 'la carte écartée doit porter un verdict');

    // Le verdict doit tomber sur la cellule de grille, comme au catalogue. Posé
    // sur la carte, il laisse la cellule en place, vide : la page d'accueil
    // gardait un trou et les cartes suivantes ne remontaient pas.
    assert.equal(
      hidden.dataset.testid,
      'grid-item',
      'la carte du fil est enfouie sous sa cellule : la masquer ne referme rien'
    );
    assert.ok(
      hidden.querySelector('[data-testid="feed-item"]'),
      'et la cellule doit bien contenir la carte visée'
    );
  });

  test('Vinted recycle le noeud d’une carte masquée : le bouton doit suivre le nouvel article', async () => {
    const page = await loadContentScript('home');
    const doc = page.window.document as Document;

    const cards = [...doc.querySelectorAll<HTMLElement>('[data-testid="feed-item"]')];
    assert.ok(cards.length >= 2, 'la fixture doit porter au moins deux cartes');
    const [cardA, cardOther] = cards as [HTMLElement, HTMLElement];
    const idOther = cardOther
      .querySelector('[data-testid$="--overlay-link"]')
      ?.getAttribute('href')
      ?.match(/\/items\/(\d+)/)?.[1];
    assert.ok(idOther, 'la fixture doit porter une deuxième carte identifiable');

    // La carte A a déjà été écartée dans une session précédente : elle est
    // masquée, donc un candidat plausible au recyclage de Vinted.
    const idA = cardA
      .querySelector('[data-testid$="--overlay-link"]')
      ?.getAttribute('href')
      ?.match(/\/items\/(\d+)/)?.[1];
    await page.setNoise({ hidden: { [idA as string]: Date.now() } });

    // Vinted réutilise le même noeud `feed-item` pour un tout autre article —
    // seul son contenu change, pas son identité DOM.
    const newId = '9999999999';
    const linkInA = cardA.querySelector<HTMLAnchorElement>('[data-testid$="--overlay-link"]')!;
    linkInA.setAttribute('href', linkInA.getAttribute('href')!.replace(idA as string, newId));

    // Un vrai changement de DOM ailleurs sur la page, comme le ferait Vinted,
    // pour réveiller le MutationObserver.
    const spacer = doc.createElement('span');
    doc.body.appendChild(spacer);
    spacer.remove();
    await settle(100);

    const recycledButton = cardA.querySelector<HTMLButtonElement>('.vf-card-btn');
    assert.ok(recycledButton, 'la carte recyclée doit garder un bouton');
    assert.equal(
      recycledButton.dataset.vfId,
      newId,
      'le bouton doit suivre le nouvel article, pas rester tagué sur l’ancien'
    );

    await page.clickMouse(recycledButton);
    const [saved] = page.saved();
    assert.equal(saved.id, newId, 'la carte cliquée doit enregistrer l’article qu’elle affiche');
  });

  test('un conteneur qui contient des cartes n’est pas pris pour une carte', async () => {
    const page = await loadContentScript('item');

    // Le conteneur `{plugin}-items` des blocs d'une fiche englobe les cartes et
    // porte un testid du même préfixe, sans identifiant. Si le repli par URL
    // s'appliquait à tout testid sans identifiant, il descendrait jusqu'au
    // premier lien d'article de son sous-arbre : le conteneur recevrait un
    // bouton, sur l'id d'une carte qui a déjà le sien.
    const block = await page.appendItemBlock('other_user_items', 3, true);

    const wrapper = block.querySelector('[data-testid="other_user_items-items"]');
    assert.ok(wrapper, 'le conteneur doit être présent, sinon le test ne prouve rien');
    assert.equal(
      wrapper.querySelector(':scope > .vf-card-btn'),
      null,
      'un bouton a été injecté sur le conteneur, pas sur une carte'
    );

    const ids = page.cardButtons().map((button) => button.dataset.vfId);
    assert.equal(new Set(ids).size, ids.length, 'un bouton a été injecté deux fois sur le même id');
  });
});
