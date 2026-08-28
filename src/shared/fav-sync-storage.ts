/**
 * La clé `favsync` du storage : relecture puis écriture.
 *
 * Séparé de `shared/fav-sync.ts` comme `noise-storage.ts` l'est de `noise.ts`,
 * et pour la même raison : la décision se teste sans navigateur, l'écriture non.
 *
 * Trois mondes posent des intentions ici — le content script (un geste sur le
 * marque-page dont le cœur n'était pas à l'écran), le panneau (une suppression,
 * un archivage) et, indirectement, tout onglet Vinted. D'où le passage
 * obligatoire par `update()`, qui relit avant d'écrire (règle 6).
 */
import { normalizeFavSync, queueFav } from './fav-sync.ts';
import type { FavSyncState } from './fav-sync.ts';
import { FAVSYNC_KEY, SETTINGS_KEY, read, update } from './storage.ts';

/**
 * Relit l'état complet, applique la transformation, réécrit.
 *
 * `mutate` reçoit un état **normalisé** — jamais `undefined`, jamais une file
 * absente — de sorte qu'aucun appelant n'ait à retomber sur des valeurs par
 * défaut de son côté. Rendre `null` renonce à l'écriture.
 */
export async function patchFavSync(
  mutate: (current: FavSyncState) => FavSyncState | null
): Promise<FavSyncState> {
  let written: FavSyncState = { pending: [] };

  await update([FAVSYNC_KEY], (stored) => {
    const current = normalizeFavSync(stored[FAVSYNC_KEY]);
    const next = mutate(current);
    if (!next) {
      written = current;
      return null;
    }
    written = next;
    return { [FAVSYNC_KEY]: next };
  });

  return written;
}

/**
 * La synchro est-elle allumée ?
 *
 * Vérifié **ici**, une fois, plutôt qu'à chaque appelant : une intention mise en
 * file alors que le réglage est éteint attendrait qu'on l'allume pour partir, et
 * agirait donc rétroactivement sur des gestes d'avant l'activation — exactement
 * ce que la spec interdit. Un seul endroit à ne pas oublier vaut mieux que six.
 */
async function enabled(): Promise<boolean> {
  const stored = await read(SETTINGS_KEY);
  return Boolean(stored[SETTINGS_KEY]?.favSync);
}

/**
 * Met en file l'état voulu chez Vinted pour un article.
 *
 * À n'appeler **que pour un geste de l'utilisateur sur l'extension**. Une
 * transition venue de Vinted elle-même n'a rien à y faire : l'état voulu y est
 * déjà atteint, et la mettre en file coûterait une relecture complète de la
 * liste des favoris pour conclure qu'il n'y a rien à faire.
 */
export async function queueFavIntent(id: string, want: boolean, now = Date.now()): Promise<void> {
  if (!(await enabled())) return;
  await patchFavSync((current) => queueFav(current, id, want, now));
}

/** La même chose pour un geste qui porte sur plusieurs articles (archivage en masse). */
export async function queueFavIntents(
  entries: readonly { id: string; want: boolean }[],
  now = Date.now()
): Promise<void> {
  if (!entries.length || !(await enabled())) return;

  await patchFavSync((current) =>
    entries.reduce((state, entry) => queueFav(state, entry.id, entry.want, now), current)
  );
}
