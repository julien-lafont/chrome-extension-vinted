/**
 * Vinted Smart Bookmarks — recherche « ailleurs » : Google Lens sur la photo, ou repli
 * texte sur marque + titre + taille.
 *
 * Même contrat que `search.ts` : des fonctions pures qui construisent une URL,
 * jamais de DOM, jamais de storage, jamais de `fetch`. L'extension ne juge rien
 * des résultats — elle ouvre un onglet, à l'initiative explicite d'un clic. Voir
 * `docs/specs/recherche-inversee.md`.
 */

import type { SavedItem } from '../shared/types.ts';

/** Une destination possible, prête à ouvrir. */
export type ElsewhereSearch = {
  kind: 'lens' | 'text';
  url: string;
  /** Libellé du bouton et du menu. */
  label: string;
};

const LENS = 'https://lens.google.com/uploadbyurl';
const GOOGLE_SEARCH = 'https://www.google.com/search';

/**
 * Hôtes CDN acceptés pour une recherche par image. Le storage vient de pages
 * tierces : on ne transmet à Google que des URLs dont on sait d'où elles
 * sortent, jamais une valeur arbitraire lue dans du contenu qu'on ne rédige pas.
 */
const PHOTO_HOSTS = ['vinted.net', 'vinted.fr', 'vinted.com'] as const;

/** Vrai si l'URL est absolue, en `https:`, et hébergée par un domaine Vinted connu. */
function isExploitablePhoto(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  if (parsed.protocol !== 'https:') return false;
  return PHOTO_HOSTS.some(
    (host) => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`)
  );
}

/**
 * URL Google Lens pour une photo donnée, transmise telle quelle : le `?s=…`
 * final est une signature liée à l'URL exacte, la réécrire produirait un 404
 * (voir `docs/vinted-dom.md` et `ItemPhoto`).
 *
 * `brand`, si fourni, part en paramètre `q` : Lens bascule alors en recherche
 * mixte image + texte, plutôt que la seule ressemblance visuelle — utile
 * quand deux marques partagent une coupe proche. Aucun autre paramètre.
 */
export function lensUrl(photoUrl: string, brand?: string): string {
  const url = new URL(LENS);
  url.searchParams.set('url', photoUrl);
  if (brand) url.searchParams.set('q', brand);
  return url.toString();
}

/** Retire les accents pour une comparaison insensible à la casse et aux diacritiques. */
function foldForCompare(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

/**
 * Requête texte de repli : marque + titre + taille, dédoublonnés.
 *
 * La marque passe en tête — un titre Vinted commence rarement par elle, et
 * Google pondère l'ordre des termes. Les mots du titre déjà présents dans la
 * marque sont retirés, sans quoi « Nike » + « Nike Air Zoom » donnerait « Nike
 * Nike Air Zoom ». La taille ne s'ajoute que si elle informe : au moins deux
 * caractères et absente du titre — un « M » ou un « 42 » isolé n'ajoute que du
 * bruit à une recherche web, alors que « 42 EU » ou « W32 L34 » resserre.
 */
export function textQuery(item: SavedItem): string {
  const brand = item.brand?.trim() || '';
  const title = item.title?.trim() || '';
  const size = item.size?.trim() || '';

  const brandWords = new Set(foldForCompare(brand).split(/\s+/).filter(Boolean));

  const titleWords = title
    .split(/\s+/)
    .filter((word) => word && !brandWords.has(foldForCompare(word)));

  const parts: string[] = [];
  if (brand) parts.push(brand);
  if (titleWords.length) parts.push(titleWords.join(' '));

  if (size.length >= 2 && !foldForCompare(title).includes(foldForCompare(size))) {
    parts.push(size);
  }

  return parts.length ? parts.join(' ') : title || item.id;
}

/** URL de recherche web Google, sans `tbm=isch` : on cherche une annonce ou une
 *  fiche produit, pas une planche d'images. */
function textSearchUrl(item: SavedItem): string {
  const url = new URL(GOOGLE_SEARCH);
  url.searchParams.set('q', textQuery(item));
  return url.toString();
}

/**
 * Meilleure photo exploitable de l'article, ou `null` si aucune ne l'est.
 * `url` (600×800) est préféré à `full` (1200×1600, ~4× plus lourd) : Lens
 * redimensionne de son côté, `full` ne sert que de filet si `url` manque.
 */
function bestPhoto(item: SavedItem): string | null {
  const photo = item.images?.[0];
  if (!photo) return null;

  if (photo.url && isExploitablePhoto(photo.url)) return photo.url;
  if (photo.full && isExploitablePhoto(photo.full)) return photo.full;
  return null;
}

/**
 * Destinations disponibles pour un article, la meilleure en tête. Jamais vide :
 * le repli texte est toujours proposé, le panneau n'a donc jamais à traiter de
 * cas vide ni à désactiver le bouton — invariant porté par le type tuple, pas
 * seulement par convention.
 */
export function elsewhereSearches(item: SavedItem): [ElsewhereSearch, ...ElsewhereSearch[]] {
  const text: ElsewhereSearch = {
    kind: 'text',
    url: textSearchUrl(item),
    label: 'Recherche Google',
  };

  const photo = bestPhoto(item);
  if (!photo) return [text];

  const lens: ElsewhereSearch = {
    kind: 'lens',
    url: lensUrl(photo, item.brand?.trim() || undefined),
    label: 'Google Lens',
  };
  return [lens, text];
}
