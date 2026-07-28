/**
 * Vinted Favoris — la clé `noise` dans `chrome.storage.local`.
 *
 * Séparé de `shared/noise.ts`, qui reste **pur** et testable sans `chrome`.
 * Séparé aussi des appelants : le content script et le panneau écrivent tous
 * deux ici, et deux implémentations de la même relecture-puis-écriture auraient
 * divergé — c'est exactement la raison d'être de `shared/collections.ts`, et le
 * même partage s'applique.
 */
import { NOISE_KEY, normalizeNoise } from './noise.ts';
import type { NoiseFilters } from './noise.ts';

type Stored = { [NOISE_KEY]?: Partial<NoiseFilters> };

export async function readNoise(): Promise<NoiseFilters> {
  const res: Stored = await chrome.storage.local.get(NOISE_KEY);
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
  const current = await readNoise();
  const next = mutate(current);
  if (next === current) return current;

  await chrome.storage.local.set({ [NOISE_KEY]: next });
  return next;
}
