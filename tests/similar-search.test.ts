/**
 * L'URL de recherche « articles similaires » est-elle correctement filtrée ?
 *
 * Vinted ne filtre que par identifiant numérique : les libellés d'état ne sont pas
 * acceptés. Les valeurs employées ont été relevées sur `/api/v2/statuses` et
 * vérifiées sur le catalogue — voir docs/vinted-dom.md.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  similarSearchUrl,
  brandSearchUrl,
  STATUS_IDS,
  SIMILAR_STATUSES,
} from '../src/sidepanel/search.js';

/** Relit l'URL produite comme le ferait Vinted. */
function parse(item) {
  const url = new URL(similarSearchUrl(item));
  return {
    url,
    params: url.searchParams,
    statuses: url.searchParams.getAll('status_ids[]'),
    text: url.searchParams.get('search_text'),
  };
}

const ITEM = {
  id: '1',
  title: 'Nike Air Zoom Mercurial',
  brand: 'Nike',
  size: '42',
  condition: 'Bon état',
  price: '40,00 €',
};

describe('recherche d articles similaires', () => {
  test('vise le catalogue Vinted', () => {
    const { url } = parse(ITEM);
    assert.equal(url.origin + url.pathname, 'https://www.vinted.fr/catalog');
  });

  test('retient toujours les trois bons états, quel que soit celui de l article', () => {
    const attendus = ['6', '1', '2']; // Neuf avec étiquette, Neuf sans étiquette, Très bon état

    for (const condition of ['Bon état', 'Satisfaisant', 'Neuf avec étiquette', '']) {
      const { statuses } = parse({ ...ITEM, condition });
      assert.deepEqual(statuses, attendus, `état d'origine : « ${condition} »`);
    }
  });

  test('les identifiants d état correspondent aux libellés attendus', () => {
    assert.deepEqual(
      SIMILAR_STATUSES.map((label) => STATUS_IDS[label]),
      [6, 1, 2]
    );
    // Les états écartés ne doivent jamais se retrouver dans l'URL.
    const { statuses } = parse(ITEM);
    assert.ok(!statuses.includes(String(STATUS_IDS['Bon état'])));
    assert.ok(!statuses.includes(String(STATUS_IDS.Satisfaisant)));
  });

  test('la fourchette va de la moitié au double du prix enregistré', () => {
    const { params } = parse(ITEM); // 40,00 €
    assert.equal(params.get('price_from'), '20', '−50 %');
    assert.equal(params.get('price_to'), '80', '+100 %');
    assert.equal(params.get('currency'), 'EUR');
  });

  test('les bornes sont arrondies vers l extérieur', () => {
    // 12,50 € → de 6 (6,25 arrondi au plancher) à 25.
    const { params } = parse({ ...ITEM, price: '12,50 €' });
    assert.equal(params.get('price_from'), '6');
    assert.equal(params.get('price_to'), '25');
  });

  test('le prix numérique prime sur la chaîne affichée', () => {
    const { params } = parse({ ...ITEM, price: '40,00 €', priceValue: 12.5 });
    assert.equal(params.get('price_from'), '6');
    assert.equal(params.get('price_to'), '25');
  });

  test('sans prix lisible, aucune borne n est posée', () => {
    const { params } = parse({ ...ITEM, price: '', priceValue: undefined });
    assert.equal(params.get('price_from'), null);
    assert.equal(params.get('price_to'), null);
  });

  test('marque et taille passent par le texte à défaut d identifiants', () => {
    const { text } = parse(ITEM);
    assert.match(text, /Nike/);
    assert.match(text, /42/);
  });

  test('les identifiants de marque et de taille priment sur le texte', () => {
    const { params, text } = parse({ ...ITEM, brandId: 53, sizeId: 208 });
    assert.equal(params.get('brand_ids[]'), '53');
    assert.equal(params.get('size_ids[]'), '208');
    assert.equal(text, null, 'plus besoin de recherche textuelle');
  });

  test('la catégorie est utilisée quand elle décrit l article', () => {
    const category = { id: '584', name: 'Hauts et t-shirts', exact: true };
    const { params } = parse({ ...ITEM, category });
    assert.equal(params.get('catalog[]'), '584');
  });

  test('une catégorie seulement héritée de la page est ignorée', () => {
    const category = { id: '584', name: 'Hauts et t-shirts', exact: false };
    const { params } = parse({ ...ITEM, category });
    assert.equal(params.get('catalog[]'), null, 'ne pas filtrer sur une catégorie approximative');
  });

  test('sans marque ni taille, le titre sert de recherche', () => {
    const { text } = parse({ ...ITEM, brand: '', size: '' });
    assert.equal(text, 'Nike Air Zoom Mercurial');
  });

  test('les crochets des paramètres répétés restent lisibles', () => {
    // Vinted attend `status_ids[]`, pas sa forme percent-encodée.
    assert.ok(similarSearchUrl(ITEM).includes('status_ids[]=6'));
    assert.ok(!similarSearchUrl(ITEM).includes('%5B%5D'));
  });

  test('un article sans aucune métadonnée produit une URL valide', () => {
    const { url, statuses } = parse({ id: '9' });
    assert.equal(url.origin + url.pathname, 'https://www.vinted.fr/catalog');
    assert.deepEqual(statuses, ['6', '1', '2']);
  });
});

describe('recherche par marque', () => {
  const parseBrand = (item) => {
    const raw = brandSearchUrl(item);
    return raw === null ? null : new URL(raw).searchParams;
  };

  const CATEGORY = { id: '584', name: 'Hauts et t-shirts', exact: true };

  test('filtre sur la marque dans la catégorie de l article', () => {
    const params = parseBrand({ ...ITEM, category: CATEGORY });
    assert.equal(params.get('catalog[]'), '584');
    assert.equal(params.get('search_text'), 'Nike');
  });

  test('ne pose ni prix, ni taille, ni état', () => {
    const params = parseBrand({ ...ITEM, category: CATEGORY });

    for (const absent of ['price_from', 'price_to', 'currency', 'size_ids[]']) {
      assert.equal(params.get(absent), null, `${absent} ne doit pas être filtré`);
    }
    assert.deepEqual(params.getAll('status_ids[]'), [], 'tous les états sont acceptés');
    assert.ok(!params.get('search_text').includes('42'), 'la taille ne doit pas polluer');
  });

  test('l identifiant de marque prime sur le texte', () => {
    const params = parseBrand({ ...ITEM, brandId: 53, category: CATEGORY });
    assert.equal(params.get('brand_ids[]'), '53');
    assert.equal(params.get('search_text'), null);
  });

  test('sans catégorie exploitable, la marque seule est filtrée', () => {
    const approximative = { ...CATEGORY, exact: false };

    for (const category of [null, undefined, approximative]) {
      const params = parseBrand({ ...ITEM, category });
      assert.equal(params.get('catalog[]'), null);
      assert.equal(params.get('search_text'), 'Nike');
    }
  });

  test('sans marque, aucun lien n est proposé', () => {
    assert.equal(brandSearchUrl({ ...ITEM, brand: '' }), null);
    assert.equal(brandSearchUrl({ id: '9' }), null);
  });

  test('les crochets restent lisibles', () => {
    const url = brandSearchUrl({ ...ITEM, brandId: 53, category: CATEGORY });
    assert.ok(url.includes('catalog[]=584'));
    assert.ok(!url.includes('%5B%5D'));
  });
});
