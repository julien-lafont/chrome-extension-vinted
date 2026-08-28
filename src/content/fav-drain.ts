/**
 * Vidage de la file d'intentions — la seule chose **automatique** qui écrive sur
 * le compte Vinted. Voir `docs/specs/favoris-sync.md`.
 *
 * Tourne dans le content script d'un onglet Vinted, jamais dans le service
 * worker : l'API exige les cookies de session, et le jeton anti-CSRF ne se lit
 * que dans une page. Le transport vit dans `fav-api.ts` ; ce fichier ne porte
 * que la décision de basculer, ou non.
 *
 * Ce module ne sert que ce qu'un clic ne peut pas faire. Partout où la carte est
 * à l'écran, on clique le cœur de Vinted, qui fait sa propre requête et repeint
 * son icône : c'est plus sûr, moins coûteux, et l'utilisateur voit le résultat.
 * Ne restent ici que les gestes faits ailleurs — une suppression depuis le
 * panneau, un archivage, un cœur pas encore hydraté.
 *
 * L'ordre des opérations n'est pas négociable, et c'est tout l'objet du fichier :
 *
 *   bail → jeton → liste réelle des favoris → comparaison → bascules
 *
 * L'API ne sait qu'**inverser** un favori. Basculer sans avoir lu l'état réel,
 * c'est une chance sur deux de faire l'inverse de ce qui est demandé — et deux
 * onglets qui basculent le même article reviennent au point de départ en croyant
 * avoir agi. D'où la lecture préalable, et d'où le bail.
 */
import { openFavApi, toggleFavourite } from './fav-api.ts';
import type { FavApiDeps, FavFailure } from './fav-api.ts';
import { FAV_LEASE_MS, MAX_TOGGLES_PER_DRAIN } from '../shared/fav-sync.ts';
import { patchFavSync } from '../shared/fav-sync-storage.ts';
import { setHeart } from './fav-sync.ts';

/** Espacement des bascules. Le rythme d'un humain qui déclique ses favoris. */
const TOGGLE_DELAY_MS = 600;

/** Silence après un 429 ou un 403, aligné sur le balayage des offres. */
const THROTTLE_MS = 10 * 60 * 1000;

/** Ce qu'un vidage a fait, pour le diagnostic du panneau. */
export type DrainSummary = {
  /** Bascules effectivement émises. */
  toggled: number;
  /** Intentions retirées de la file sans requête : l'état voulu y était déjà. */
  satisfied: number;
  /** Pourquoi le vidage s'est arrêté, quand ce n'est pas « file vide ». */
  stopped?: 'freiné' | 'occupé' | 'jeton absent' | 'compte inconnu' | 'réseau' | 'onglet caché';
};

/** Ce que les tests remplacent ; en production, tout vient de la page. */
export type DrainDeps = FavApiDeps & {
  /** Identifiant d'instance de cet onglet, pour le bail. */
  instanceId: string;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
  isVisible?: () => boolean;
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Vide la file d'intentions, ou renonce proprement.
 *
 * **Aucune bascule n'est émise sans une lecture réussie de la liste des
 * favoris.** Un échec de lecture n'est pas un « rien n'est en favori » : le
 * traiter comme tel mettrait en favori toute la collection. Le vidage s'arrête
 * alors, la file reste intacte, et le prochain onglet retentera.
 */
export async function drainFavourites(deps: DrainDeps): Promise<DrainSummary> {
  const now = deps.now ?? Date.now;
  const wait = deps.wait ?? sleep;
  const doc = deps.doc ?? document;
  const isVisible = deps.isVisible ?? ((): boolean => doc.visibilityState === 'visible');

  const summary: DrainSummary = { toggled: 0, satisfied: 0 };

  // --- Ce qui se décide sans réseau ------------------------------------------

  let pending: DrainSummary['stopped'] | undefined;
  const state = await patchFavSync((current) => {
    if (!current.pending.length) return null;

    if (current.throttledUntil && current.throttledUntil > now()) {
      pending = 'freiné';
      return null;
    }

    // Bail d'un autre onglet, encore valide : on ne touche à rien. Le prendre
    // dans la même section critique que sa lecture est ce qui évite que deux
    // onglets se l'attribuent tous les deux.
    const lease = current.lease;
    if (lease && lease.until > now() && lease.tabId !== deps.instanceId) {
      pending = 'occupé';
      return null;
    }

    return { ...current, lease: { tabId: deps.instanceId, until: now() + FAV_LEASE_MS } };
  });

  if (pending) {
    summary.stopped = pending;
    return summary;
  }
  if (!state.pending.length) return summary;

  const release = async (): Promise<void> => {
    await patchFavSync((current) =>
      current.lease?.tabId === deps.instanceId ? { ...current, lease: undefined } : null
    );
  };

  const api = openFavApi(deps);
  if (!api) {
    // Session expirée, ou Vinted a renommé la clé. Dans les deux cas la file
    // reste intacte : mieux vaut un geste en retard qu'un geste inversé.
    summary.stopped = 'jeton absent';
    await release();
    return summary;
  }

  const stop = async (reason: DrainSummary['stopped']): Promise<DrainSummary> => {
    summary.stopped = reason;
    await release();
    return summary;
  };

  const throttle = async (): Promise<DrainSummary> => {
    await patchFavSync((current) => ({
      ...current,
      lease: undefined,
      throttledUntil: now() + THROTTLE_MS,
    }));
    summary.stopped = 'freiné';
    return summary;
  };

  // --- L'état réel chez Vinted, lu seulement s'il le faut ---------------------

  /**
   * La liste des favoris, lue à la première intention qui en a besoin.
   *
   * Paresseuse, et c'est ce qui rend le cas courant gratuit : une suppression
   * faite dans le panneau pendant qu'on regarde la carte se règle par un clic
   * sur le cœur de Vinted, sans la moindre requête d'ici.
   *
   * @returns `null` quand la lecture échoue — ce qui doit **arrêter le vidage**.
   *   La traiter comme une liste vide mettrait toute la collection en favori.
   */
  let favourites: Set<string> | null = null;
  let listFailure: Exclude<FavFailure, 'jeton absent'> | null = null;

  const loadFavourites = async (): Promise<Set<string> | null> => {
    if (favourites) return favourites;

    const list = await api.favourites();
    if (!list.ok) {
      listFailure = list.reason;
      return null;
    }

    favourites = new Set(list.entries.map((entry) => String((entry as { id: unknown }).id)));
    return favourites;
  };

  // --- Les bascules -----------------------------------------------------------

  const done: string[] = [];
  const url = doc.location.href;
  let emitted = 0;

  for (const entry of state.pending) {
    if (emitted >= MAX_TOGGLES_PER_DRAIN) break;

    // Un onglet passé en arrière-plan n'agit plus, comme le cycle de suivi : ce
    // qui reste attendra son retour, la file est intacte.
    if (!isVisible()) {
      await commit(done, deps.instanceId, now);
      summary.stopped = 'onglet caché';
      return summary;
    }

    // **La page d'abord.** Si la carte est à l'écran, son cœur porte l'état réel
    // et Vinted sait le basculer lui-même : une requête de moins, et surtout un
    // cœur qui change de couleur sous les yeux de l'utilisateur. Sans ce chemin,
    // un article retiré depuis le panneau se dé-favorisait bien côté serveur
    // mais restait rouge dans la page ouverte, jusqu'au rechargement.
    const onPage = setHeart(entry.id, entry.want, doc, url);

    if (onPage === 'unchanged') {
      summary.satisfied += 1;
      done.push(entry.id);
      continue;
    }
    if (onPage === 'clicked') {
      summary.toggled += 1;
      emitted += 1;
      done.push(entry.id);
      await wait(TOGGLE_DELAY_MS);
      continue;
    }

    // Carte absente, ou cœur pas encore hydraté : il faut l'API, et donc l'état
    // réel du compte.
    const known = await loadFavourites();
    if (!known) {
      await commit(done, deps.instanceId, now);
      return listFailure === 'freiné' ? throttle() : stop(listFailure ?? 'réseau');
    }

    if (known.has(entry.id) === entry.want) {
      summary.satisfied += 1;
      done.push(entry.id);
      continue;
    }

    const response = await toggleFavourite(api, entry.id);

    if (response.blocked) {
      await commit(done, deps.instanceId, now);
      return throttle();
    }
    // Un échec ponctuel laisse l'intention en file : elle repartira au prochain
    // vidage, où l'état réel sera relu de toute façon.
    if (response.failed) continue;

    done.push(entry.id);
    summary.toggled += 1;
    emitted += 1;
    await wait(TOGGLE_DELAY_MS);
  }

  await commit(done, deps.instanceId, now);
  return summary;
}

/** Retire de la file ce qui est fait, libère le bail, horodate. */
async function commit(done: string[], instanceId: string, now: () => number): Promise<void> {
  await patchFavSync((current) => {
    const finished = new Set(done);
    return {
      ...current,
      pending: current.pending.filter((entry) => !finished.has(entry.id)),
      lastDrainAt: now(),
      lease: current.lease?.tabId === instanceId ? undefined : current.lease,
    };
  });
}
