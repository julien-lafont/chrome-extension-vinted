/**
 * Vinted Favoris — recherche d'articles similaires.
 *
 * Construit une URL de catalogue Vinted pré-filtrée à partir d'un favori :
 * même marque, même taille, prix dans une fourchette autour du sien, et
 * uniquement les bons états.
 */

import type { SavedItem } from '../shared/types.ts';
import { parsePrice } from './sorting.ts';

/**
 * Identifiants d'état du catalogue, relevés sur `/api/v2/statuses` (vinted.fr).
 * Vinted ne filtre que par identifiant : les libellés ne sont pas acceptés.
 */
export const STATUS_IDS = {
  'Neuf avec étiquette': 6,
  'Neuf sans étiquette': 1,
  'Très bon état': 2,
  'Bon état': 3,
  Satisfaisant: 4,
} as const;

export type StatusLabel = keyof typeof STATUS_IDS;

/**
 * États retenus pour une recherche de similaires. Volontairement fixes, quel que
 * soit l'état de l'article d'origine : on cherche une bonne affaire, pas son
 * équivalent abîmé.
 */
export const SIMILAR_STATUSES: readonly StatusLabel[] = [
  'Neuf avec étiquette',
  'Neuf sans étiquette',
  'Très bon état',
];

/**
 * Écarts appliqués au prix enregistré, dissociés : une remise de plus de 100 %
 * n'aurait aucun sens, alors qu'un prix peut doubler.
 */
export const PRICE_DOWN = 0.5; // −50 %
export const PRICE_UP = 1; // +100 %

const CATALOG_URL = 'https://www.vinted.fr/catalog';

/**
 * Ajoute le filtre de marque : par identifiant si l'article en porte un, sinon
 * en recherche textuelle. Vinted n'accepte pas de nom dans `brand_ids[]`.
 * @returns vrai si un filtre a pu être posé
 */
function appendBrand(params: URLSearchParams, item: SavedItem, words: string[]): boolean {
  if (item.brandId) {
    params.append('brand_ids[]', String(item.brandId));
    return true;
  }
  if (item.brand) {
    words.push(item.brand);
    return true;
  }
  return false;
}

/**
 * Ajoute le filtre de catégorie, seulement si elle décrit l'article lui-même.
 * `exact: false` signale la catégorie de la page parcourue, pas celle du produit.
 * @returns vrai si un filtre a pu être posé
 */
function appendCategory(params: URLSearchParams, item: SavedItem): boolean {
  if (!item.category || !item.category.exact || !item.category.id) return false;
  params.append('catalog[]', String(item.category.id));
  return true;
}

/** Vinted attend `status_ids[]` en clair ; URLSearchParams encode les crochets. */
const buildUrl = (params: URLSearchParams): string =>
  `${CATALOG_URL}?${params.toString().replace(/%5B%5D/g, '[]')}`;

/**
 * URL du catalogue filtré sur la marque d'un article, dans sa catégorie.
 *
 * Volontairement plus large que {@link similarSearchUrl} : ni prix, ni taille, ni
 * état. C'est une exploration de la marque, pas la recherche d'un équivalent.
 *
 * Sans catégorie exploitable, la recherche porte sur la marque seule — ce qui
 * reste utile, là où une catégorie approximative fausserait tout.
 *
 * @param item favori enregistré
 * @returns URL de catalogue, ou null si la marque est inconnue
 */
export function brandSearchUrl(item: SavedItem): string | null {
  const params = new URLSearchParams();
  const words: string[] = [];

  appendCategory(params, item);
  if (!appendBrand(params, item, words)) return null;

  if (words.length) params.set('search_text', words.join(' '));

  return buildUrl(params);
}

/**
 * URL de recherche des articles similaires à un favori.
 *
 * Marque et taille passent par leur identifiant si l'article en porte un
 * (`brandId`, `sizeId`) — c'est le seul filtrage exact. Sinon on retombe sur la
 * recherche textuelle, qui reste approximative : « 42 » remonte aussi bien une
 * pointure qu'un tour de taille.
 *
 * @param item favori enregistré
 * @returns URL de catalogue Vinted
 */
export function similarSearchUrl(item: SavedItem): string {
  const params = new URLSearchParams();
  const words: string[] = [];

  // La catégorie resserre beaucoup la recherche : « 42 » ne remonte plus à la fois
  // des pointures et des tours de taille.
  appendCategory(params, item);
  appendBrand(params, item, words);

  if (item.sizeId) params.append('size_ids[]', String(item.sizeId));
  else if (item.size) words.push(item.size);

  // Sans marque ni taille exploitables, le titre vaut mieux qu'une recherche vide.
  if (!words.length && !params.has('brand_ids[]') && !params.has('size_ids[]') && item.title) {
    words.push(item.title);
  }

  if (words.length) params.set('search_text', words.join(' '));

  const price = parsePrice(item);
  if (price !== null && price > 0) {
    params.set('price_from', String(Math.max(0, Math.floor(price * (1 - PRICE_DOWN)))));
    params.set('price_to', String(Math.ceil(price * (1 + PRICE_UP))));
    params.set('currency', 'EUR');
  }

  for (const label of SIMILAR_STATUSES) {
    params.append('status_ids[]', String(STATUS_IDS[label]));
  }

  return buildUrl(params);
}
