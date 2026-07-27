/**
 * Fabriques d'objets du modèle pour les tests.
 *
 * `SavedItem` porte une quinzaine de champs dont la plupart n'intéressent pas un
 * test donné. Les énumérer à chaque cas noierait ce que le test vérifie
 * réellement ; ces fabriques fournissent un objet complet et valide, dont on ne
 * surcharge que ce qui compte.
 */

import type { SavedItem } from '../src/shared/types.ts';

export function makeItem(overrides: Partial<SavedItem> & { id: string }): SavedItem {
  return {
    url: `https://www.vinted.fr/items/${overrides.id}`,
    title: `Article ${overrides.id}`,
    brand: '',
    size: '',
    condition: '',
    price: '',
    priceValue: null,
    favouriteCount: null,
    category: null,
    imageUrl: '',
    source: 'catalog',
    savedAt: Number(overrides.id) || 0,
    ...overrides,
  };
}
