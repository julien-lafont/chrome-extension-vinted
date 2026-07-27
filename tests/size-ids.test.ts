/**
 * La taille est-elle résolue en identifiant de catalogue, et **refusée** quand
 * elle ne peut pas l'être sans risque ?
 *
 * C'est le seul module du projet qui interroge l'API de Vinted plutôt que de
 * lire une page. Deux choses comptent donc autant que la résolution elle-même :
 * ne demander qu'une fois par catégorie, et renoncer proprement — un mauvais
 * `size_ids[]` filtrerait la recherche sur une autre échelle (« M » de chapeau
 * au lieu de « M » de t-shirt) sans que rien ne le signale.
 *
 * Les réponses sont celles relevées sur vinted.fr le 27/07/2026, réduites aux
 * champs lus. Voir `docs/vinted-dom.md`.
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sizeIdFor, resetSizeTables } from '../src/shared/size-ids.ts';

/** Catégorie feuille : un seul groupe, aucun libellé ambigu. */
const TAILLES_HOMMES = {
  size_groups: [
    {
      description: 'Tailles hommes',
      sizes: [
        { id: 206, title: 'XS' },
        { id: 207, title: 'S' },
        { id: 208, title: 'M' },
        { id: 209, title: 'L' },
      ],
    },
  ],
};

/** Catégorie large : « M » y vaut vêtement (208), chapeau (1390) ou gant (1426). */
const RAYON_LARGE = {
  size_groups: [
    { description: 'Tailles hommes', sizes: [{ id: 208, title: 'M' }] },
    { description: 'Chapeaux adulte', sizes: [{ id: 1390, title: 'M' }] },
    { description: 'Gants adulte', sizes: [{ id: 1426, title: 'M' }] },
  ],
};

/** Titres composés, tels que Vinted les sert sur certaines catégories. */
const TAILLES_COMPOSEES = {
  size_groups: [
    {
      description: 'Tailles',
      sizes: [
        { id: 3, title: 'S / 36 / 8' },
        { id: 6, title: 'XL / 42 / 14' },
      ],
    },
  ],
};

/** `fetch` de test : mémorise les URLs demandées et sert la réponse voulue. */
function fakeFetch(body: unknown, { ok = true, status = 200 } = {}) {
  const calls: string[] = [];
  const impl = ((url: string) => {
    calls.push(String(url));
    return Promise.resolve({
      ok,
      status,
      json: () => Promise.resolve(body),
    } as Response);
  }) as unknown as typeof fetch;

  return { impl, calls };
}

beforeEach(resetSizeTables);

describe('résolution de la taille', () => {
  test('rend l’identifiant du libellé de la fiche', async () => {
    const { impl } = fakeFetch(TAILLES_HOMMES);
    assert.equal(await sizeIdFor('584', 'M', impl), '208');
  });

  test('interroge l’API sur la catégorie, au pluriel', async () => {
    const { impl, calls } = fakeFetch(TAILLES_HOMMES);
    await sizeIdFor('584', 'M', impl);

    // `catalog_id` au singulier est ignoré par Vinted, qui rend alors les 51
    // groupes du site — et « M » y devient ambigu. Le pluriel n'est pas un détail.
    assert.match(calls[0] ?? '', /\/api\/v2\/size_groups\?catalog_ids=584$/);
  });

  test('accepte les titres composés sans les retoucher', async () => {
    const { impl } = fakeFetch(TAILLES_COMPOSEES);

    // Le libellé de la fiche vaut « S / 36 / 8 » au caractère près : toute
    // normalisation (espaces, séparateurs) casserait la correspondance.
    assert.equal(await sizeIdFor('221', 'S / 36 / 8', impl), '3');
  });

  test('renonce quand le libellé est ambigu dans la catégorie', async () => {
    const { impl } = fakeFetch(RAYON_LARGE);

    // Trois échelles, trois identifiants : filtrer sur l'un d'eux reviendrait à
    // chercher des chapeaux. Mieux vaut la recherche textuelle.
    assert.equal(await sizeIdFor('2050', 'M', impl), null);
  });

  test('ne demande qu’une fois par catégorie', async () => {
    const { impl, calls } = fakeFetch(TAILLES_HOMMES);

    await sizeIdFor('584', 'M', impl);
    await sizeIdFor('584', 'L', impl);
    await sizeIdFor('584', 'XS', impl);

    assert.equal(calls.length, 1, 'une requête par article enregistré');
  });

  test('ne demande qu’une fois même en parallèle', async () => {
    const { impl, calls } = fakeFetch(TAILLES_HOMMES);

    // Enregistrer plusieurs articles d'affilée ne doit pas lancer autant de
    // requêtes que de clics : c'est la promesse qui est mise en cache, pas
    // seulement son résultat.
    await Promise.all([sizeIdFor('584', 'M', impl), sizeIdFor('584', 'L', impl)]);

    assert.equal(calls.length, 1);
  });

  test('un libellé inconnu de la table ne rend rien', async () => {
    const { impl } = fakeFetch(TAILLES_HOMMES);
    assert.equal(await sizeIdFor('584', '42', impl), null);
  });

  test('une API muette ne bloque pas et ne rend rien', async () => {
    const { impl } = fakeFetch({}, { ok: false, status: 403 });
    assert.equal(await sizeIdFor('584', 'M', impl), null);
  });

  test('une requête qui échoue est rattrapée', async () => {
    const impl = (() => Promise.reject(new Error('réseau'))) as unknown as typeof fetch;
    assert.equal(await sizeIdFor('584', 'M', impl), null);
  });

  test('sans catégorie ni taille, aucune requête n’est faite', async () => {
    const { impl, calls } = fakeFetch(TAILLES_HOMMES);

    assert.equal(await sizeIdFor(null, 'M', impl), null);
    assert.equal(await sizeIdFor('584', '', impl), null);
    assert.equal(await sizeIdFor('584', '   ', impl), null);

    assert.equal(calls.length, 0, 'requête inutile');
  });
});
