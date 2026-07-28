/**
 * Réputation du vendeur : note, nombre d'évaluations, pays.
 *
 * Trois lectures, trois fragilités distinctes. La note et le compteur viennent
 * du flux d'hydratation, dont rien ne garantit le format ; le pays vient d'une
 * **autre page** que la fiche, et d'une clé que Vinted n'a aucune raison de
 * garder stable. Les deux ancres se testent donc sur du markup réel :
 * `item.html` pour le repli DOM de la fiche, `member.html` pour le profil.
 *
 * Voir `src/shared/seller.ts` et `docs/vinted-dom.md`.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseRatingLabel,
  ratingFromReputation,
  readSellerFeedback,
  sellerCell,
  sellerCountryFrom,
} from '../src/shared/seller.ts';
import { codeFromName, countryName, flagEmoji } from '../src/shared/countries.ts';
import { FIXTURES } from './harness.ts';

const fixture = (name: string): Document =>
  new JSDOM(readFileSync(join(FIXTURES, `${name}.html`), 'utf8')).window.document;

describe('note du vendeur', () => {
  test('convertit la réputation du flux en note sur 5', () => {
    assert.equal(ratingFromReputation(0.8), 4);
    assert.equal(ratingFromReputation(1), 5);
    assert.equal(ratingFromReputation(0), 0);
  });

  test('arrondit à la décimale, comme le libellé de Vinted', () => {
    // Valeur relevée telle quelle dans le flux d'une vraie fiche, dont
    // l'aria-label affichait « 4.7 sur 5 ». Sans arrondi, la note dépendrait de
    // la source empruntée.
    assert.equal(ratingFromReputation(0.9400000000000001), 4.7);
  });

  test('ignore ce qui n’est pas une réputation', () => {
    assert.equal(ratingFromReputation(undefined), null);
    assert.equal(ratingFromReputation(4), null, 'une note déjà sur 5 n’est pas une réputation');
    assert.equal(ratingFromReputation(Number.NaN), null);
  });

  test('lit le libellé d’accessibilité, avec ou sans décimale', () => {
    assert.equal(parseRatingLabel('Le membre est noté 4.7 sur 5'), 4.7);
    assert.equal(parseRatingLabel('Le membre est noté 4 sur 5'), 4);
    assert.equal(parseRatingLabel('Le membre est noté 4,7 sur 5'), 4.7);
  });

  test('ne prend pas un libellé quelconque pour une note', () => {
    assert.equal(parseRatingLabel('Ajouter aux favoris'), null);
    assert.equal(parseRatingLabel(null), null);
  });
});

describe('cellule vendeur de la fiche', () => {
  test('lit la note et le nombre d’évaluations du DOM servi', () => {
    const feedback = readSellerFeedback(sellerCell(fixture('item')));

    assert.equal(typeof feedback.rating, 'number', 'note absente du DOM de la fiche');
    assert.ok(feedback.rating !== null && feedback.rating >= 0 && feedback.rating <= 5);
    assert.equal(typeof feedback.count, 'number', 'nombre d’évaluations absent');
  });

  test('borne la lecture à la cellule du vendeur', () => {
    // Un bloc d'articles arrivé après coup porte lui aussi des `role="group"` :
    // sans la borne, le premier venu deviendrait la note du vendeur.
    const doc = fixture('item');
    const intrus = doc.createElement('div');
    intrus.setAttribute('role', 'group');
    intrus.setAttribute('aria-label', 'Le membre est noté 1 sur 5');
    doc.body.insertBefore(intrus, doc.body.firstChild);

    const feedback = readSellerFeedback(sellerCell(doc));
    assert.notEqual(feedback.rating, 1, 'note prise à un bloc voisin');
  });

  test('un groupe qui ne parle pas de note ne donne pas de compteur', () => {
    const doc = new JSDOM(
      '<!DOCTYPE html><div role="group" aria-label="Photos"><div>12</div></div>'
    ).window.document;

    assert.deepEqual(readSellerFeedback(doc), { rating: null, count: null });
  });

  test('une page sans cellule vendeur ne lève pas', () => {
    const doc = new JSDOM('<!DOCTYPE html><p>rien</p>').window.document;

    assert.equal(sellerCell(doc), doc);
    assert.deepEqual(readSellerFeedback(doc), { rating: null, count: null });
  });
});

describe('pays du vendeur', () => {
  test('lit le code ISO du flux de la page profil', () => {
    assert.equal(sellerCountryFrom(fixture('member')), 'FR');
  });

  test('retombe sur la cellule de localisation quand le flux se tait', () => {
    // Markup de la fixture, privé de ses scripts : c'est exactement ce qui
    // resterait si Vinted renommait `country_code`.
    const doc = fixture('member');
    doc.querySelectorAll('script').forEach((script) => {
      script.remove();
    });

    assert.equal(sellerCountryFrom(doc), 'FR');
  });

  test('reconnaît un pays étranger affiché en français', () => {
    const doc = new JSDOM(
      '<!DOCTYPE html><div data-testid="profile-location-info--content">Bad Soden am Taunus, Allemagne </div>'
    ).window.document;

    assert.equal(sellerCountryFrom(doc), 'DE');
  });

  test('un profil sans localisation ne donne pas de pays', () => {
    const doc = new JSDOM('<!DOCTYPE html><p>profil sans localisation</p>').window.document;
    assert.equal(sellerCountryFrom(doc), null);
  });

  test('deux pays dans la même page n’en désignent aucun', () => {
    // Le jour où le profil embarquerait le pays d'un autre membre, mieux vaut
    // n'afficher aucun drapeau qu'un drapeau faux.
    const doc = new JSDOM(
      `<!DOCTYPE html><script>{"country_code":"FR"} {"country_code":"IT"}</script>`
    ).window.document;

    assert.equal(sellerCountryFrom(doc), null);
  });
});

describe('affichage d’un pays', () => {
  test('dérive le drapeau du code, sans table', () => {
    assert.equal(flagEmoji('FR'), '🇫🇷');
    assert.equal(flagEmoji('de'), '🇩🇪');
    assert.equal(flagEmoji(null), '');
    assert.equal(flagEmoji('FRA'), '', 'seul l’alpha-2 est un code pays');
  });

  test('nomme le pays en français', () => {
    assert.equal(countryName('DE'), 'Allemagne');
    assert.equal(countryName('FR'), 'France');
    assert.equal(countryName(''), '');
  });

  test('retrouve le code depuis le nom, accents compris', () => {
    assert.equal(codeFromName('Allemagne'), 'DE');
    assert.equal(codeFromName('Tchequie'), 'CZ', 'la comparaison doit ignorer les accents');
    assert.equal(codeFromName('  royaume-uni '), 'GB');
    assert.equal(codeFromName('Pays imaginaire'), null);
  });

  test('un nom que Vinted formule autrement qu’Intl n’est pas reconnu', () => {
    // Limite assumée du repli DOM : `Intl` dit « Tchéquie », Vinted pourrait
    // écrire « République tchèque ». Le flux, qui donne le code, reste la source
    // principale — ce test est là pour que la limite soit connue, pas subie.
    assert.equal(codeFromName('République tchèque'), null);
  });
});
