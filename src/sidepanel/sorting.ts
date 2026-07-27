/**
 * Vinted Favoris — modes de tri.
 *
 * Chaque mode expose une clé numérique par article. Les articles dont la clé
 * est indisponible (champ absent ou illisible) sont toujours renvoyés en fin de
 * liste, quel que soit le sens du tri : une donnée manquante ne doit pas
 * remonter artificiellement en tête.
 *
 * Champs lus en priorité s'ils existent (fournis par le content script), sinon
 * reconstruits depuis les chaînes affichées :
 *   priceValue     nombre        ← sinon parsé depuis `price` ("12,00 €")
 *   favouriteCount nombre        ← sinon indisponible
 *
 * Les deux sont extraits depuis fin juillet 2026 ; les replis servent les articles
 * enregistrés avant, que rien ne recalcule — voir docs/limitations.md.
 */

export const SORT_MODES = [
  { id: 'custom', label: 'Personnalisé' },
  { id: 'savedAt', label: "Date d'ajout" },
  { id: 'price', label: 'Prix' },
  { id: 'condition', label: 'État' },
  { id: 'likes', label: 'Likes' },
  { id: 'size', label: 'Taille' },
];

/** Sens par défaut de chaque mode, celui qu'on attend en le sélectionnant. */
const DEFAULT_DIR = {
  savedAt: 'desc', // le plus récent d'abord
  price: 'asc', // le moins cher d'abord
  condition: 'desc', // le meilleur état d'abord
  likes: 'desc', // le plus aimé d'abord
  size: 'asc',
  // `custom` est absent volontairement : l'ordre manuel n'a pas de sens de tri.
};

export const defaultDirFor = (mode) => DEFAULT_DIR[mode] || 'asc';

/** Libellés des deux sens, adaptés au mode : "Moins cher" a plus de sens que "Croissant". */
export const DIR_LABELS = {
  savedAt: { asc: 'Plus ancien', desc: 'Plus récent' },
  price: { asc: 'Moins cher', desc: 'Plus cher' },
  condition: { asc: 'État le plus usé', desc: 'Meilleur état' },
  likes: { asc: 'Moins aimé', desc: 'Plus aimé' },
  size: { asc: 'Plus petite', desc: 'Plus grande' },
};

// --- Extraction des clés de tri ---------------------------------------------

/**
 * Prix affiché → nombre : "1 234,56 €" donne 1234.56.
 *
 * On lit le premier nombre de la chaîne plutôt que de la nettoyer globalement :
 * Vinted suffixe parfois le prix ("13,45 EUR incl. Protection acheteurs"), et la
 * ponctuation du suffixe fausserait un nettoyage caractère par caractère.
 * Espaces fines et insécables des milliers comprises.
 */
export function parsePrice(item) {
  if (typeof item.priceValue === 'number' && Number.isFinite(item.priceValue)) {
    return item.priceValue;
  }

  const match = String(item.price || '').match(/(\d[\d\s\u00a0\u202f]*)(?:[.,](\d{1,2}))?/);
  if (!match) return null;

  const whole = match[1].replace(/[\s\u00a0\u202f]/g, '');
  const value = Number.parseFloat(`${whole}.${match[2] || '0'}`);
  return Number.isFinite(value) ? value : null;
}

/** Échelle des états Vinted, du plus usé au neuf. */
const CONDITION_RANK = [
  [/satisfaisant/i, 1],
  [/bon\s+état/i, 2],
  [/tr[eè]s\s+bon\s+état/i, 3],
  [/neuf\s+sans/i, 4],
  [/neuf\s+avec/i, 5],
];

export function parseCondition(item) {
  const raw = String(item.condition || '').trim();
  if (!raw) return null;

  // Parcours à l'envers : "très bon état" doit gagner sur "bon état".
  for (let i = CONDITION_RANK.length - 1; i >= 0; i -= 1) {
    if (CONDITION_RANK[i][0].test(raw)) return CONDITION_RANK[i][1];
  }
  return null;
}

export function parseLikes(item) {
  const value = item.favouriteCount ?? item.likes;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

const ALPHA_SIZES = [
  [/^(xxxs|3xs)$/i, 1],
  [/^(xxs|2xs)$/i, 2],
  [/^xs$/i, 3],
  [/^s$/i, 4],
  [/^m$/i, 5],
  [/^l$/i, 6],
  [/^xl$/i, 7],
  [/^(xxl|2xl)$/i, 8],
  [/^(xxxl|3xl)$/i, 9],
];

/**
 * Les tailles Vinted mélangent des échelles incomparables ("M", "42", "36/38").
 * On les range par famille (alpha < numérique) puis par valeur, ce qui garde
 * chaque échelle groupée et ordonnée.
 * @returns {number|null} clé de tri, ou null si la taille est illisible.
 */
export function parseSize(item) {
  const raw = String(item.size || '').trim();
  if (!raw) return null;

  // "36 / 38" ou "42 (EU)" → on trie sur la première valeur numérique.
  const numeric = raw.match(/\d+([.,]\d+)?/);
  const alpha = raw.split(/[\s/(]/)[0];

  for (const [pattern, rank] of ALPHA_SIZES) {
    if (pattern.test(alpha)) return rank;
  }

  if (numeric) {
    // Décalage de 100 : toute taille numérique passe après les tailles alpha.
    return 100 + Number.parseFloat(numeric[0].replace(',', '.'));
  }

  return null;
}

const KEY_OF = {
  savedAt: (item) => (typeof item.savedAt === 'number' ? item.savedAt : null),
  price: parsePrice,
  condition: parseCondition,
  likes: parseLikes,
  size: parseSize,
};

/** Nombre d'articles pour lesquels le mode courant n'a aucune donnée à trier. */
export function countMissing(items, mode) {
  const keyOf = KEY_OF[mode];
  if (!keyOf) return 0;
  return items.filter((item) => keyOf(item) === null).length;
}

// --- Ordre manuel -------------------------------------------------------------

/**
 * Réinjecte l'ordre des articles visibles dans l'ordre complet d'une collection.
 *
 * Une recherche active masque une partie de la liste. Concaténer simplement les
 * masqués après les visibles les déporterait tous en fin de collection dès qu'on
 * réordonne sous filtre. On ne réécrit donc que les positions occupées par des
 * articles visibles, chaque masqué conservant la sienne.
 *
 * @param {string[]} previousOrder ordre complet enregistré
 * @param {string[]} visibleIds ids affichés, dans leur nouvel ordre
 */
export function mergeVisibleOrder(previousOrder, visibleIds) {
  const shown = new Set(visibleIds);
  const known = new Set(previousOrder);

  // Un article jamais réordonné n'est pas encore dans l'ordre : il prend une place en tête.
  const base = [...visibleIds.filter((id) => !known.has(id)), ...previousOrder];

  const queue = [...visibleIds];
  return base.map((id) => (shown.has(id) ? queue.shift() : id));
}

// --- Tri ---------------------------------------------------------------------

/**
 * @param {object[]} items
 * @param {string} mode identifiant d'un SORT_MODES
 * @param {'asc'|'desc'} dir
 * @param {string[]} customOrder ids dans l'ordre personnalisé de la collection
 */
export function sortItems(items, mode, dir, customOrder = []) {
  const list = [...items];

  // L'ordre manuel est déjà l'ordre voulu : `dir` ne s'y applique pas. L'inverser
  // renverrait la carte qu'on vient de déposer à l'autre bout de la liste dès qu'on
  // arrive d'un tri descendant — et l'interface ne propose aucun sens dans ce mode.
  if (mode === 'custom') {
    const rank = new Map(customOrder.map((id, index) => [id, index]));
    // Un article jamais réordonné (nouvel ajout) passe en tête, du plus récent au plus ancien.
    list.sort((a, b) => {
      const ra = rank.has(a.id) ? rank.get(a.id) : -1;
      const rb = rank.has(b.id) ? rank.get(b.id) : -1;
      if (ra !== rb) return ra - rb;
      return (b.savedAt || 0) - (a.savedAt || 0);
    });
    return list;
  }

  const keyOf = KEY_OF[mode];
  if (!keyOf) return list;

  const sign = dir === 'desc' ? -1 : 1;

  list.sort((a, b) => {
    const ka = keyOf(a);
    const kb = keyOf(b);

    if (ka === null && kb === null) return (b.savedAt || 0) - (a.savedAt || 0);
    if (ka === null) return 1; // les données manquantes finissent toujours en bas
    if (kb === null) return -1;
    if (ka !== kb) return (ka - kb) * sign;

    return (b.savedAt || 0) - (a.savedAt || 0);
  });

  return list;
}
