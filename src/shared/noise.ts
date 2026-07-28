/**
 * Vinted Favoris — filtrage du bruit dans le catalogue.
 *
 * Le cœur de `docs/specs/filtrage-bruit.md` : décider si une carte doit être
 * masquée, et pourquoi. **Module pur** — aucun accès à `chrome`, aucun accès au
 * DOM. C'est ce qui le rend testable sans jsdom, et c'est là qu'est écrite la
 * seule logique qui puisse rendre la fonctionnalité insupportable si elle est
 * fausse (voir `matchesWord()`).
 *
 * Trois propriétés gouvernent tout ce fichier (§1 de la spec) : aucune requête
 * réseau, aucun message entre les deux mondes, rien n'est jamais supprimé.
 */
import type { ItemMap } from './types.ts';

/**
 * Ce qui est écrit sous la clé `noise` de `chrome.storage.local`.
 *
 * Le nom `filters` a été écarté : le panneau aura ses propres filtres de
 * recherche, et deux clés homonymes dans le même storage sont une confusion
 * garantie six mois plus tard.
 */
export type NoiseFilters = {
  /**
   * Articles écartés un par un, `id → horodatage`. Un `Record` plutôt qu'un
   * tableau : la lecture est un test d'appartenance à chaque carte de chaque
   * scan, et l'horodatage sert à l'éviction (voir {@link NOISE_HIDDEN_MAX}).
   */
  hidden: Record<string, number>;

  /**
   * Les 20 derniers écartés, avec leur titre — le seul endroit où l'on garde
   * autre chose qu'un id. C'est ce qui permet au panneau de proposer une
   * annulation tardive nommée (« Veste Zara ») plutôt qu'un id opaque, sans
   * pour autant conserver le titre des 5 000 autres. Du plus récent au plus
   * ancien.
   */
  recent: HiddenRecent[];

  /** `sellerId → { name }`. Le pseudo n'est stocké que pour être affiché. */
  sellers: Record<string, { name: string; at: number }>;

  /** Marques masquées, **normalisées**. Jamais l'identifiant — voir `matchesBrand()`. */
  brands: string[];

  /** Mots exclus, normalisés. */
  words: string[];
};

export type HiddenRecent = { id: string; title: string; at: number };

export const NOISE_KEY = 'noise';

/**
 * ~30 octets l'entrée → 150 Ko sur les 10 Mo disponibles. Au-delà, éviction des
 * plus anciens.
 *
 * C'est le seul endroit du projet où perdre une donnée est acceptable : un id
 * évincé réapparaît au catalogue, où un clic le réécarte. Et un article écarté
 * il y a deux ans est vendu depuis longtemps.
 */
export const NOISE_HIDDEN_MAX = 5000;

/** De quoi couvrir une session de tri, pas un journal. */
export const NOISE_RECENT_MAX = 20;

/** Par liste. Au-delà, c'est un problème de méthode, pas de stockage. */
export const NOISE_RULES_MAX = 200;

export function emptyNoise(): NoiseFilters {
  return { hidden: {}, recent: [], sellers: {}, brands: [], words: [] };
}

/**
 * Complète ce que rend le storage. Clé absente = aucune règle, ce qui est
 * exactement l'état de tout le monde avant cette fonctionnalité : aucune
 * migration n'est nécessaire, et un champ manquant (storage écrit par une
 * version antérieure) ne doit pas faire tomber le scan.
 */
export function normalizeNoise(raw: Partial<NoiseFilters> | undefined): NoiseFilters {
  return {
    hidden: raw?.hidden || {},
    recent: raw?.recent || [],
    sellers: raw?.sellers || {},
    brands: raw?.brands || [],
    words: raw?.words || [],
  };
}

// --- Normalisation ------------------------------------------------------------

/**
 * Minuscules, diacritiques retirés, espaces réduits. Rien d'autre.
 *
 * Appliquée **à l'écriture d'une règle comme à la lecture d'une carte** : c'est
 * la condition pour que « H&M », « h&m » et « H&M » se rencontrent. On ne retire
 * ni la ponctuation ni les caractères spéciaux — `h&m` et `pull & bear` sont des
 * noms de marque Vinted, et les amputer les rendrait introuvables.
 */
export function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Le texte d'une carte, découpé sur tout ce qui n'est pas lettre ou chiffre,
 * rejoint par des espaces et **bordé d'un espace** : `" veste barbour bedale c40 "`.
 *
 * Le bordage est ce qui fait toute la fonctionnalité : une règle correspond si
 * elle apparaît entourée d'espaces dans ce flux, donc `lot` ne rencontre jamais
 * `culotte` ni `salopette`. Un filtre qui masque les culottes parce qu'on a
 * exclu « lot » est désinstallé le jour même.
 *
 * Effet secondaire voulu : les règles multi-mots (« neuf avec etiquette »)
 * marchent sans traitement particulier.
 */
export function haystack(text: string): string {
  return ` ${normalize(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .join(' ')} `;
}

// --- Correspondance -----------------------------------------------------------

/**
 * Une marque masquée correspond par égalité, ou par préfixe suivi d'un espace :
 * `zara` masque `zara kids`, `zara man`, `zara home`, mais **pas** `zarautz`.
 *
 * C'est ce qui rend le jeu fast fashion utile sans énumérer les déclinaisons, et
 * c'est assez strict pour ne pas mordre sur une marque voisine.
 */
export function matchesBrand(brand: string, rules: readonly string[]): string | null {
  const value = normalize(brand);
  if (!value) return null;

  for (const rule of rules) {
    if (!rule) continue;
    if (value === rule || value.startsWith(`${rule} `)) return rule;
  }
  return null;
}

/** Le mot exclu qui correspond, ou `null`. Voir `haystack()` pour le pourquoi. */
export function matchesWord(text: string, rules: readonly string[]): string | null {
  if (!rules.length) return null;

  const hay = haystack(text);
  for (const rule of rules) {
    if (!rule) continue;
    if (hay.includes(` ${rule} `)) return rule;
  }
  return null;
}

// --- Verdict ------------------------------------------------------------------

/** `'0'` = visible. Les autres valeurs disent **pourquoi** la carte est masquée. */
export type NoiseVerdict = '0' | 'item' | 'seller' | 'brand' | 'word';

export type NoiseCandidate = {
  id: string;
  title?: string;
  brand?: string;
  /** Absent tant qu'on ne sait pas lire le vendeur depuis une carte — voir §7 de la spec. */
  sellerId?: string | null;
};

export type NoiseDecision = {
  verdict: NoiseVerdict;
  /** La règle qui a mordu, pour l'expliquer au survol en mode révision. */
  reason: string;
};

const VISIBLE: NoiseDecision = { verdict: '0', reason: '' };

/**
 * Le verdict d'une carte, et la règle qui l'a produit.
 *
 * **Un article enregistré n'est jamais masqué**, quelle que soit la règle. C'est
 * la règle qui évite le pire scénario d'usage : masquer Zara, puis ne plus
 * retrouver au catalogue la veste Zara qu'on avait mise de côté la semaine
 * d'avant, sans comprendre pourquoi. L'enregistrement est une décision
 * individuelle, il l'emporte sur toute règle générale.
 *
 * L'ordre du reste va du plus précis au plus large : une décision explicite
 * (« celui-là, plus jamais ») avant une règle de vendeur, avant une règle de
 * marque, avant un mot. C'est cet ordre qui est rapporté au survol, et c'est
 * celui qu'attend l'utilisateur quand il demande « pourquoi celui-ci a
 * disparu ? ».
 */
export function verdictFor(
  candidate: NoiseCandidate,
  noise: NoiseFilters,
  saved: ItemMap
): NoiseDecision {
  if (saved[candidate.id]) return VISIBLE;

  if (noise.hidden[candidate.id]) return { verdict: 'item', reason: 'écarté à la main' };

  const sellerId = candidate.sellerId;
  if (sellerId && noise.sellers[sellerId]) {
    return { verdict: 'seller', reason: `vendeur ${noise.sellers[sellerId].name || sellerId}` };
  }

  const brand = matchesBrand(candidate.brand || '', noise.brands);
  if (brand) return { verdict: 'brand', reason: `marque ${brand}` };

  // Le titre plus la marque : c'est là que vivent « style », « inspiré »,
  // « réplique », « lot », « enfant ». Pas la description — elle n'est pas sur
  // la carte, et aller la chercher demanderait une requête (§1 de la spec).
  const word = matchesWord(`${candidate.title || ''} ${candidate.brand || ''}`, noise.words);
  if (word) return { verdict: 'word', reason: `mot « ${word} »` };

  return VISIBLE;
}

// --- Écritures (pures : elles rendent le prochain état, n'écrivent rien) -------

/**
 * Écarte un article : pose l'id, empile le titre dans les récents, et évince.
 *
 * L'éviction ne porte que sur `hidden` et se fait par horodatage croissant. Elle
 * est silencieuse parce qu'elle est sans conséquence visible.
 */
export function pushHidden(noise: NoiseFilters, entry: HiddenRecent): NoiseFilters {
  const hidden = { ...noise.hidden, [entry.id]: entry.at };

  const ids = Object.keys(hidden);
  if (ids.length > NOISE_HIDDEN_MAX) {
    const excess = ids
      .sort((a, b) => (hidden[a] ?? 0) - (hidden[b] ?? 0))
      .slice(0, ids.length - NOISE_HIDDEN_MAX);
    for (const id of excess) delete hidden[id];
  }

  const recent = [entry, ...noise.recent.filter((r) => r.id !== entry.id)].slice(
    0,
    NOISE_RECENT_MAX
  );

  return { ...noise, hidden, recent };
}

/** Annule un écart, immédiat ou tardif. L'inverse exact de `pushHidden()`. */
export function unhide(noise: NoiseFilters, id: string): NoiseFilters {
  const hidden = { ...noise.hidden };
  delete hidden[id];
  return { ...noise, hidden, recent: noise.recent.filter((r) => r.id !== id) };
}

/**
 * Ajoute une règle si elle manque, normalisée. Rend `noise` **inchangé** quand la
 * règle est vide, déjà là, ou que la liste est pleine : l'appelant compare les
 * références pour savoir s'il doit écrire.
 */
export function addRule(noise: NoiseFilters, list: 'brands' | 'words', raw: string): NoiseFilters {
  const rule = normalize(raw);
  if (!rule) return noise;

  const current = noise[list];
  if (current.includes(rule) || current.length >= NOISE_RULES_MAX) return noise;

  return { ...noise, [list]: [...current, rule].sort() };
}

export function removeRule(
  noise: NoiseFilters,
  list: 'brands' | 'words',
  rule: string
): NoiseFilters {
  return { ...noise, [list]: noise[list].filter((entry) => entry !== rule) };
}

export function addSeller(noise: NoiseFilters, id: string, name: string): NoiseFilters {
  if (!id || noise.sellers[id]) return noise;
  return { ...noise, sellers: { ...noise.sellers, [id]: { name, at: Date.now() } } };
}

export function removeSeller(noise: NoiseFilters, id: string): NoiseFilters {
  const sellers = { ...noise.sellers };
  delete sellers[id];
  return { ...noise, sellers };
}

/**
 * Le témoin du bouton « Filtres Vinted » du panneau : au moins une **règle
 * générale** (marque, mot, vendeur) est-elle active ?
 *
 * `hidden` en est délibérément exclu. Un article écarté un par un est une
 * décision ponctuelle sur une pièce précise, pas un filtre qui façonne ce que le
 * catalogue montre — le témoin répond à « est-ce que je vois le catalogue tel
 * qu'il est, ou un sous-ensemble décidé à l'avance ? ».
 */
export function hasActiveRules(noise: NoiseFilters): boolean {
  return Boolean(noise.brands.length || noise.words.length || Object.keys(noise.sellers).length);
}

// --- Le jeu proposé -----------------------------------------------------------

/**
 * Proposé en un clic, **jamais posé par défaut** : masquer des marques sans
 * qu'on l'ait demandé est le meilleur moyen de faire croire l'extension cassée.
 * Le clic les insère comme des règles ordinaires — retirables une par une
 * ensuite, sans mode spécial ni indirection. Rien ne distingue ensuite « Zara
 * venu du jeu » de « Zara ajouté à la main », et c'est voulu.
 *
 * Les libellés doivent être ceux de **Vinted**, au caractère près : la règle se
 * compare au texte de la carte. « Pull & Bear » avec ses espaces, pas
 * « Pull&Bear ». À revérifier au catalogue si une marque de la liste ne mord pas.
 */
export const FAST_FASHION: readonly string[] = [
  'aliexpress',
  'bershka',
  'boohoo',
  'h&m',
  'prettylittlething',
  'primark',
  'pull & bear',
  'shein',
  'stradivarius',
  'temu',
  'wish',
  'zara',
];
