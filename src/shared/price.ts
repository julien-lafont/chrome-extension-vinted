/**
 * Lecture d'un prix affiché par Vinted.
 *
 * Ce parseur était dupliqué entre `content/content.ts` et `sidepanel/sorting.ts`,
 * faute de pouvoir partager du code entre un content script et le panneau. Le
 * bundler lève cette contrainte : les deux appellent désormais la même fonction,
 * et un prix lu à l'extraction est trié exactement comme il a été lu.
 */

/**
 * Le nombre, et les espaces que Vinted glisse entre ses milliers : U+00A0
 * (insécable) ou U+202F (fine insécable) selon les pages.
 *
 * Les deux sont écrites en échappements, jamais en caractères littéraux —
 * invisibles dans un éditeur, elles survivent mal aux copier-coller, et le
 * linter les refuse à juste titre dans du code source.
 */
const PRICE_PATTERN = /(\d[\d\s\u00a0\u202f]*)(?:[.,](\d{1,2}))?/;
const SPACES_PATTERN = /[\s\u00a0\u202f]/g;

/**
 * « 1 234,56 € » donne 1234.56.
 *
 * On lit le premier nombre de la chaîne plutôt que de la nettoyer globalement :
 * Vinted suffixe le prix (« 3,85 € Protection acheteurs incluse »), et la
 * ponctuation du suffixe fausserait un nettoyage caractère par caractère.
 */
export function parsePriceString(raw: unknown): number | null {
  // `raw` vient du DOM ou du JSON-LD : une chaîne ou un nombre, en pratique.
  // Tout le reste n'a pas de prix lisible, et `null` est la bonne réponse.
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;

  const match = String(raw).match(PRICE_PATTERN);
  if (!match?.[1]) return null;

  const whole = match[1].replace(SPACES_PATTERN, '');
  const value = Number.parseFloat(`${whole}.${match[2] || '0'}`);
  return Number.isFinite(value) ? value : null;
}
