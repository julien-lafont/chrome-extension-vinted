/**
 * Vinted Smart Bookmarks — la frontière avec `chrome.storage.local`.
 *
 * Deux problèmes se règlent ici, une fois pour tous les appelants.
 *
 * **1. Les clés et leur forme.** Elles étaient déclarées en dur dans cinq
 * fichiers (`'savedItems'` dans le content script, dans `shared/collections.ts`
 * et dans `background/saved-pulse.ts` ; `'watch'` et `'settings'` en double). Une
 * faute de frappe dans l'une d'elles ne produit aucune erreur : la lecture rend
 * `undefined`, le code retombe sur ses valeurs par défaut, et la donnée semble
 * simplement avoir disparu. `StorageShape` est désormais la seule description du
 * contenu du storage, et le seul endroit qui convertit le retour non typé de
 * l'API.
 *
 * **2. La lecture-modification-écriture n'est pas atomique.** La règle 6 du
 * projet — « toute écriture en storage relit d'abord » — protège des écritures
 * *d'un autre onglet* mais pas des siennes. `chrome.storage.local.get()` rend une
 * promesse : entre le `get` et le `set`, la boucle d'événements passe la main.
 * Deux écritures lancées dans le même contexte s'entrelacent donc ainsi :
 *
 *     enrichissement  get(savedItems) ──────────────► set({a, b'})
 *     clic utilisateur       get(savedItems) ──► set({a, b, c})
 *                                                    ▲ écrase c
 *
 * L'article que l'utilisateur vient d'enregistrer disparaît, sans erreur en
 * console — la signature exacte des bugs que ce projet redoute. Et le cas n'est
 * pas théorique : le content script fait tourner en parallèle une file
 * d'enrichissement, un cycle de suivi de prix et les gestes de l'utilisateur, qui
 * écrivent tous sur `savedItems`.
 *
 * `update()` sérialise donc les sections critiques dans une file unique. Une
 * seule file pour toutes les clés, et non une par clé : les opérations qui
 * touchent `savedItems` **et** `collections` prendraient deux verrous, et deux
 * verrous pris dans un ordre variable finissent en interblocage. Le débit
 * (quelques écritures par seconde au pire) ne justifie pas ce risque.
 *
 * **Ce que cela ne règle pas** : deux onglets Vinted sont deux contextes
 * JavaScript, chacun avec sa file. `chrome.storage` n'offre ni transaction ni
 * comparaison-échange, il n'existe donc pas de garantie inter-onglets — la
 * relecture juste avant l'écriture reste ce qui s'en approche le plus, et c'est
 * précisément ce que `update()` impose par construction.
 */
import type { FavSyncState } from './fav-sync.ts';
import { NOISE_KEY } from './noise.ts';
import type { NoiseFilters } from './noise.ts';
import type { CollectionMap, ItemMap, OffersScanState, Settings, WatchState } from './types.ts';

export const ITEMS_KEY = 'savedItems';
export const COLLECTIONS_KEY = 'collections';
export const SETTINGS_KEY = 'settings';
export const WATCH_KEY = 'watch';
export const OFFERS_KEY = 'offers';

/**
 * Déclarée ici et non dans `shared/fav-sync.ts`, contrairement à `NOISE_KEY` :
 * ce module-là importe `collections.ts`, qui importe celui-ci. Y prendre la clé
 * fermerait le cycle à l'exécution, là où l'import de type ci-dessus disparaît à
 * la compilation.
 */
export const FAVSYNC_KEY = 'favsync';

export { NOISE_KEY };

/**
 * Le contenu de `chrome.storage.local`, clé par clé.
 *
 * `settings`, `noise` et `favsync` sont partiels à dessein : sur une
 * installation neuve la clé est absente, et c'est aux normaliseurs
 * (`DEFAULT_SETTINGS`, `normalizeNoise()`, `normalizeFavSync()`) de rendre un
 * objet complet.
 */
export type StorageShape = {
  [ITEMS_KEY]: ItemMap;
  [COLLECTIONS_KEY]: CollectionMap;
  [SETTINGS_KEY]: Partial<Settings>;
  [NOISE_KEY]: Partial<NoiseFilters>;
  [WATCH_KEY]: WatchState;
  [OFFERS_KEY]: OffersScanState;
  [FAVSYNC_KEY]: Partial<FavSyncState>;
};

export type StorageKey = keyof StorageShape;

/** Ce qu'une lecture rend : les clés demandées, chacune éventuellement absente. */
export type StoredPart<K extends StorageKey> = Partial<Pick<StorageShape, K>>;

/**
 * Lecture typée. Seul endroit qui convertit le retour de l'API, indexé par
 * chaînes et sans type utile.
 *
 * Hors file d'attente : une lecture seule n'a rien à sérialiser, et la faire
 * patienter derrière une écriture en cours n'ajouterait aucune garantie — la
 * valeur peut de toute façon changer juste après. Ce qui **décide** à partir de
 * ce qu'il lit passe par `update()`.
 */
export async function read<K extends StorageKey>(...keys: K[]): Promise<StoredPart<K>> {
  // L'API rend un objet indexé dont les valeurs sont `any` : le passer par
  // `unknown` est ce qui rend l'assertion suivante visible plutôt qu'implicite.
  const res: Record<string, unknown> = await chrome.storage.local.get(keys);
  return res as StoredPart<K>;
}

/**
 * File d'attente des sections critiques : chaque tâche attend la fin de la
 * précédente. L'échec de l'une ne doit pas emporter les suivantes, d'où le
 * `.then(ignore, ignore)` — la promesse rendue à l'appelant, elle, rejette bien.
 */
let queue: Promise<unknown> = Promise.resolve();
const ignore = (): void => {};

/**
 * Relit, transforme, réécrit — sans qu'aucune autre écriture de ce contexte ne
 * puisse s'intercaler entre les trois.
 *
 * `mutate` reçoit l'état frais des clés demandées et rend **les seules clés à
 * écrire** : les autres ne partent pas dans le `set`, et ne déclenchent donc ni
 * `onChanged` ni repeint chez ceux qui les écoutent. Rendre `null` renonce à
 * l'écriture — cas courant quand l'état relu montre qu'il n'y a plus rien à faire
 * (article retiré entre-temps, règle déjà posée par un autre onglet).
 *
 * Les clés rendues ensemble partent dans un `set` unique, ce dont plusieurs
 * appelants dépendent : deux `set` successifs produisent deux `onChanged`, donc
 * deux rendus du panneau, et le premier montre un état intermédiaire incohérent —
 * un article déjà déplacé vers une collection qui n'existe pas encore.
 *
 * `mutate` est **synchrone**, et doit le rester : il s'exécute dans la section
 * critique, tout ce qu'il attendrait retiendrait les autres écritures. Ce qui
 * demande une requête réseau la fait avant, sur un état lu par `read()`, puis
 * appelle `update()` pour la seule écriture — voir `completeSizeId()` dans le
 * content script. `mutate` ne doit pas non plus appeler `update()` lui-même : la
 * file est FIFO, l'appel imbriqué attendrait la fin de celui qui l'a lancé.
 *
 * Une valeur à rendre en plus de l'état écrit (« qu'a fait ce geste ? ») se
 * récupère par une variable de la fonction appelante, que `mutate` renseigne :
 * il s'exécute exactement une fois, et avant que `update()` ne rende la main.
 *
 * @returns ce qui a été écrit, ou l'état relu si `mutate` a renoncé
 */
export function update<K extends StorageKey>(
  keys: readonly K[],
  mutate: (current: StoredPart<K>) => StoredPart<K> | null
): Promise<StoredPart<K>> {
  const run = queue.then(async () => {
    const current = await read(...keys);
    const next = mutate(current);
    if (!next) return current;

    await chrome.storage.local.set(next);
    return next;
  });

  queue = run.then(ignore, ignore);
  return run;
}

/**
 * Vide la file. Réservé aux tests : entre deux cas, une tâche restée en attente
 * s'exécuterait sur le storage du cas suivant.
 */
export function resetStorageQueue(): void {
  queue = Promise.resolve();
}
