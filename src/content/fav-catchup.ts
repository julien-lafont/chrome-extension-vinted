/**
 * Les deux rattrapages explicites — `docs/specs/favoris-sync.md` §5.
 *
 * La synchro, elle, n'agit **que sur des transitions constatées** : elle ne
 * compare jamais les deux listes, parce qu'un écart ne dit pas qui a bougé. « Ce
 * favori a été retiré » et « ce favori n'a jamais existé » produisent exactement
 * les mêmes données.
 *
 * Ces deux routines lèvent cette limite, mais seulement parce que l'utilisateur
 * les déclenche à la main, et surtout parce qu'elles sont **additives des deux
 * côtés** :
 *
 *   importer  → enregistre les favoris Vinted absents du panneau
 *   pousser   → met en favori les articles du panneau qui ne le sont pas
 *
 * Aucune ne supprime, aucune n'archive, aucune ne retire un cœur. C'est ce qui
 * les rend sûres là où un « aligner les deux listes » ne le serait pas : un
 * rattrapage symétrique, lui, effacerait ce qu'il ne comprend pas.
 *
 * Elles ne passent pas par la file d'intentions : la file sert à porter un geste
 * jusqu'à un onglet, alors qu'ici l'onglet est déjà là et l'utilisateur attend
 * le résultat.
 */
import { openFavApi, toggleFavourite } from './fav-api.ts';
import type { FavApiDeps, FavFailure } from './fav-api.ts';
import { ARCHIVE_COLLECTION_ID, COLLECTIONS_KEY, classifiedIn } from '../shared/collections.ts';
import { itemFromFavourite } from '../shared/fav-sync.ts';
import { ITEMS_KEY, read, update } from '../shared/storage.ts';
import type { SavedItem } from '../shared/types.ts';

/** Espacement des bascules, comme le vidage : le rythme d'un humain. */
const TOGGLE_DELAY_MS = 600;

/**
 * Cœurs posés au plus par exécution.
 *
 * Bien au-dessus du plafond du vidage automatique (25) : celui-là borne les
 * dégâts d'un défaut, celui-ci borne l'attente d'un geste **voulu**. À 600 ms
 * la bascule, 200 articles font deux minutes — au-delà, mieux vaut relancer que
 * tenir la page indéfiniment.
 */
const MAX_PUSH = 200;

export type CatchupSummary = {
  /** Articles enregistrés (import) ou cœurs posés (poussée). */
  done: number;
  /** Ce qui était déjà en place, et n'a donc rien coûté. */
  skipped: number;
  /** Ce qui reste à faire, quand le plafond a été atteint. */
  remaining?: number;
  /** Pourquoi le rattrapage s'est arrêté. */
  stopped?: FavFailure;
};

export type CatchupDeps = FavApiDeps & {
  wait?: (ms: number) => Promise<void>;
  /**
   * Appelé pour chaque article importé, après son écriture : c'est le content
   * script qui sait mettre une fiche en file d'enrichissement, pas ce module.
   */
  onImported?: (item: SavedItem) => void;
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Enregistre les favoris Vinted qui manquent au panneau.
 *
 * **N'écrit rien chez Vinted.** C'est le seul des deux qui puisse tourner sans
 * risque quel que soit l'état du compte : au pire il ajoute des articles, que
 * l'utilisateur retire d'un clic.
 *
 * Les articles arrivent en qualité « carte » — l'API des favoris ne porte ni
 * catégorie ni fil d'Ariane — et sont donc marqués `pending` : leur fiche les
 * complétera, exactement comme un clic sur une carte de catalogue.
 */
export async function importFavourites(deps: CatchupDeps = {}): Promise<CatchupSummary> {
  const summary: CatchupSummary = { done: 0, skipped: 0 };

  const api = openFavApi(deps);
  if (!api) {
    summary.stopped = 'jeton absent';
    return summary;
  }

  const list = await api.favourites();
  if (!list.ok) {
    summary.stopped = list.reason;
    return summary;
  }

  const imported: SavedItem[] = [];

  // Une seule écriture pour tout l'import : cent articles en cent `set`
  // produiraient cent `onChanged`, donc cent rendus du panneau.
  await update([ITEMS_KEY], (current) => {
    const items = current[ITEMS_KEY] || {};
    const next = { ...items };

    for (const raw of list.entries) {
      const item = itemFromFavourite(raw);
      if (!item) continue;

      // Déjà connu : on n'y touche pas, même archivé. Réimporter écraserait un
      // article complet par les quelques champs d'une carte, et ferait remonter
      // dans les favoris ce que l'utilisateur avait mis au fond du tiroir.
      if (items[item.id]) {
        summary.skipped += 1;
        continue;
      }

      const fresh: SavedItem = { ...item, savedAt: Date.now(), pending: true };
      next[item.id] = fresh;
      imported.push(fresh);
    }

    return imported.length ? { [ITEMS_KEY]: next } : null;
  });

  summary.done = imported.length;
  for (const item of imported) deps.onImported?.(item);

  return summary;
}

/**
 * Met en favori chez Vinted tous les articles enregistrés qui ne le sont pas.
 *
 * « Archives » est exclu, comme partout ailleurs dans la synchro : un article
 * archivé est précisément celui dont les deux mondes s'accordent à dire qu'il
 * n'est plus un favori (voir `wantedFavourite()`). Le pousser le ferait
 * remonter, puis la synchro constaterait un cœur posé et le sortirait des
 * archives — le geste défairait un rangement voulu.
 *
 * On lit la liste réelle **avant** de basculer, pour la raison qui vaut partout
 * ici : l'API ne sait qu'inverser, et basculer un article déjà en favori l'en
 * retirerait.
 */
export async function pushFavourites(deps: CatchupDeps = {}): Promise<CatchupSummary> {
  const wait = deps.wait ?? sleep;
  const summary: CatchupSummary = { done: 0, skipped: 0 };

  const api = openFavApi(deps);
  if (!api) {
    summary.stopped = 'jeton absent';
    return summary;
  }

  const list = await api.favourites();
  if (!list.ok) {
    summary.stopped = list.reason;
    return summary;
  }

  const favourites = new Set(list.entries.map((entry) => String((entry as { id: unknown }).id)));
  const stored = await read(ITEMS_KEY, COLLECTIONS_KEY);
  const collections = stored[COLLECTIONS_KEY] || {};

  const targets: string[] = [];
  for (const item of Object.values(stored[ITEMS_KEY] || {})) {
    if (classifiedIn(item, collections)?.id === ARCHIVE_COLLECTION_ID) continue;
    if (favourites.has(item.id)) summary.skipped += 1;
    else targets.push(item.id);
  }

  const batch = targets.slice(0, MAX_PUSH);
  if (targets.length > batch.length) summary.remaining = targets.length - batch.length;

  for (const id of batch) {
    const response = await toggleFavourite(api, id);

    if (response.blocked) {
      summary.stopped = 'freiné';
      summary.remaining = targets.length - summary.done;
      return summary;
    }
    // Un échec ponctuel n'arrête pas le reste : l'article sera repris au
    // prochain lancement, où l'état réel est relu de toute façon.
    if (response.failed) continue;

    summary.done += 1;
    await wait(TOGGLE_DELAY_MS);
  }

  return summary;
}
