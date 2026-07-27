/**
 * Les identifiants du flux React Server Components sont-ils lus, et rattachés au
 * bon article ?
 *
 * Ce flux est la source la plus fragile du projet : c'est du JSON échappé dans
 * une chaîne JavaScript, sans contrat. Il n'est utilisé qu'en repli — le DOM rendu
 * côté serveur passe d'abord — mais ce repli doit rester exercé, sans quoi il
 * casserait en silence le jour où Vinted retire une ancre du DOM.
 *
 * Voir `src/shared/hydration.ts` et `docs/vinted-dom.md`.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hydrationNumbers } from '../src/shared/hydration.ts';
import { FIXTURES, ITEM_ID } from './harness.ts';

const doc = (): Document =>
  new JSDOM(readFileSync(join(FIXTURES, 'item.html'), 'utf8')).window.document;

const KEYS = ['favourite_count', 'brand_id', 'seller_id'] as const;

describe('identifiants du flux d’hydratation', () => {
  test('lit les trois clés de la fiche', () => {
    const found = hydrationNumbers(doc(), ITEM_ID, KEYS);

    // `favourite_count` peut légitimement valoir 0 : on teste le type, pas la
    // véracité — un `!found.favourite_count` laisserait passer une clé absente.
    assert.equal(typeof found.favourite_count, 'number', 'compteur de favoris absent');
    assert.equal(typeof found.brand_id, 'number', 'identifiant de marque absent');
    assert.equal(typeof found.seller_id, 'number', 'identifiant de vendeur absent');
  });

  test('ne rattache rien à un autre article', () => {
    // La fiche affiche aussi le dressing du membre et les articles similaires.
    // Sans la garde `item_id`, le compteur du voisin deviendrait celui-ci.
    const found = hydrationNumbers(doc(), '1', KEYS);
    assert.deepEqual(found, {}, 'valeurs rattachées à un identifiant étranger');
  });

  test('ne rend que les clés demandées', () => {
    const found = hydrationNumbers(doc(), ITEM_ID, ['brand_id']);
    assert.deepEqual(Object.keys(found), ['brand_id']);
  });

  test('une clé inconnue laisse le reste intact', () => {
    const found = hydrationNumbers(doc(), ITEM_ID, ['brand_id', 'grosseur_du_chat']);

    assert.equal(typeof found.brand_id, 'number');
    assert.equal(found.grosseur_du_chat, undefined);
  });

  test('une page sans flux ne lève pas', () => {
    const empty = new JSDOM('<!DOCTYPE html><body><p>rien</p>').window.document;
    assert.deepEqual(hydrationNumbers(empty, ITEM_ID, KEYS), {});
  });
});
