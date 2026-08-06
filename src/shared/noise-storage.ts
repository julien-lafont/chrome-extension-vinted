/**
 * Vinted Smart Bookmarks — la clé `noise` dans `chrome.storage.local`.
 *
 * Séparé de `shared/noise.ts`, qui reste **pur** et testable sans `chrome`.
 * Séparé aussi des appelants : le content script et le panneau écrivent tous
 * deux ici, et deux implémentations de la même relecture-puis-écriture auraient
 * divergé — c'est exactement la raison d'être de `shared/collections.ts`, et le
 * même partage s'applique.
 */
import { normalizeNoise } from './noise.ts';
import type { NoiseFilters } from './noise.ts';
import { NOISE_KEY, read, update } from './storage.ts';

export async function readNoise(): Promise<NoiseFilters> {
  const res = await read(NOISE_KEY);
  return normalizeNoise(res[NOISE_KEY]);
}

/**
 * Relit, transforme, réécrit (règle 6 du projet).
 *
 * La relecture n'est pas une précaution de principe : trois onglets Vinted
 * écartent des articles en parallèle, et le panneau retire des règles pendant ce
 * temps. Partir d'un état en cache ferait réapparaître des cartes que quelqu'un
 * venait d'écarter, sans la moindre trace.
 *
 * `mutate` doit être **pur** et rendre l'objet reçu tel quel quand il n'a rien à
 * changer : on saute alors l'écriture, donc le `onChanged` et le repeint de tous
 * les onglets.
 */
export async function patchNoise(
  mutate: (current: NoiseFilters) => NoiseFilters
): Promise<NoiseFilters> {
  const result = await update([NOISE_KEY], (stored) => {
    const current = normalizeNoise(stored[NOISE_KEY]);
    const next = mutate(current);
    // `normalizeNoise` reconstruit l'objet : l'identité ne peut être conservée
    // que par un `mutate` qui rend son argument, ce qui est justement la
    // convention pour dire « rien à changer ».
    return next === current ? null : { [NOISE_KEY]: next };
  });

  // `update` rend ce qui a été écrit, ou l'état relu si `mutate` a renoncé :
  // dans les deux cas c'est la valeur courante, qu'il reste à compléter (la
  // normalisation est idempotente, la repasser sur ce qu'on vient d'écrire ne
  // change rien).
  return normalizeNoise(result[NOISE_KEY]);
}
