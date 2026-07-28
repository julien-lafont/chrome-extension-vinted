/**
 * Pays d'un vendeur : code ISO 3166-1 alpha-2, drapeau, nom.
 *
 * Le storage ne retient que le **code** (`FR`, `DE`) : c'est ce que Vinted
 * expose, c'est stable, et c'est la seule forme dont on puisse dériver les deux
 * autres. Le drapeau et le nom se calculent à l'affichage.
 *
 * Aucune table de noms de pays n'est maintenue ici : `Intl.DisplayNames` en
 * donne la traduction française, et Chrome comme Node l'embarquent. La seule
 * liste tenue à la main est celle des marchés Vinted, et elle ne sert qu'au sens
 * inverse — retrouver un code depuis le nom affiché sur une page profil.
 */

/**
 * Les marchés où Vinted opère, plus les pays d'où viennent des vendeurs
 * livrant en France. Sert **uniquement** à `codeFromName()` : le sens direct
 * (code → nom) n'a besoin d'aucune liste.
 *
 * Une entrée manquante ne casse rien — le repli DOM ne reconnaît simplement pas
 * ce pays-là, et la source principale (le code ISO du flux) n'en dépend pas.
 */
const MARKETS = [
  'FR',
  'BE',
  'LU',
  'ES',
  'IT',
  'DE',
  'AT',
  'NL',
  'PT',
  'PL',
  'CZ',
  'SK',
  'LT',
  'LV',
  'EE',
  'HU',
  'RO',
  'GB',
  'IE',
  'SE',
  'DK',
  'FI',
  'GR',
  'HR',
  'SI',
  'CH',
  'US',
  'CA',
] as const;

/** Un code ISO alpha-2, normalisé, ou `null` si l'entrée n'en est pas un. */
export function normalizeCountry(value: string | null | undefined): string | null {
  const code = (value ?? '').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : null;
}

/**
 * Drapeau emoji d'un code pays.
 *
 * Les indicateurs régionaux Unicode se dérivent du code lui-même (`D` + `E` →
 * 🇩🇪) : il n'y a pas de table à tenir, et un pays que Vinted ajoute demain
 * marchera sans rien changer.
 *
 * **Chrome sous Windows n'a pas les glyphes de drapeaux** et rendra « DE » en
 * deux lettres. C'est lisible, et c'est la raison pour laquelle le drapeau n'est
 * jamais la seule forme de l'information : l'infobulle porte le nom du pays.
 */
export function flagEmoji(code: string | null | undefined): string {
  const iso = normalizeCountry(code);
  if (!iso) return '';

  const BASE = 127397; // 0x1F1E6 ('🇦') − 'A'.charCodeAt(0)
  return String.fromCodePoint(...[...iso].map((letter) => BASE + letter.charCodeAt(0)));
}

/**
 * Nom français du pays, pour l'infobulle. Retombe sur le code si le runtime n'a
 * pas les données de localisation (`Intl.DisplayNames` est présent partout où
 * l'extension tourne, mais lever ici ferait perdre la ligne entière).
 */
export function countryName(code: string | null | undefined): string {
  const iso = normalizeCountry(code);
  if (!iso) return '';

  try {
    return new Intl.DisplayNames(['fr'], { type: 'region' }).of(iso) ?? iso;
  } catch {
    return iso;
  }
}

/**
 * Sens inverse : « Allemagne » → `DE`.
 *
 * Sert au seul repli DOM de la page profil, qui affiche « Ville, Pays » en
 * clair là où le flux donne le code. La comparaison ignore la casse et les
 * accents — « Rép. tchèque » ne sera pas reconnu, et c'est acceptable : le flux
 * reste la source principale.
 */
export function codeFromName(name: string | null | undefined): string | null {
  const wanted = fold(name);
  if (!wanted) return null;

  for (const code of MARKETS) {
    if (fold(countryName(code)) === wanted) return code;
  }
  return null;
}

/** Minuscules sans accents ni ponctuation d'espacement, pour comparer des noms de pays. */
function fold(value: string | null | undefined): string {
  return (value ?? '')
    .normalize('NFD') // décompose « é » en « e » + accent, que la ligne suivante retire
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}
