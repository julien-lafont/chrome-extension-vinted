/**
 * Configuration du build, sans aucun effet de bord.
 *
 * Séparée de `build.ts` pour que trois appelants partagent la même vérité :
 *   — `build.ts`, qui produit `dist/` ;
 *   — `tests/harness.ts`, qui bundle le content script pour le tester tel qu'il
 *     sera livré (options identiques, y compris la mise en IIFE) ;
 *   — `tests/build-output.test.ts`, qui vérifie les invariants de sortie.
 *
 * Importer `build.ts` depuis un test déclencherait le build : d'où ce module.
 */

import type { BuildOptions } from 'esbuild';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DIST = join(ROOT, 'dist');

/** Chrome 114 est le premier à proposer le panneau latéral : rien à transpiler en deçà. */
export const TARGET = 'chrome114';

/**
 * `out` est un chemin **sans extension** : esbuild ajoute `.js` lui-même. L'y
 * écrire produisait des `content.js.js`, que le manifeste ne trouvait pas.
 */
export type Entry = { source: string; out: string };

/**
 * Content scripts : IIFE obligatoire. Chrome n'accepte pas les modules ES dans un
 * content script (pas d'`import` à l'exécution). esbuild résout les imports à la
 * compilation et enferme le tout dans une fonction anonyme, ce qui isole aussi
 * nos variables de celles de la page Vinted.
 */
export const IIFE_ENTRIES: Entry[] = [
  { source: 'src/content/content.ts', out: 'content/content' },
  { source: 'src/content/offer-agent.ts', out: 'content/offer-agent' },
];

/**
 * Service worker et panneau : modules ES. Les deux tournent dans un contexte
 * d'extension qui les supporte, et le panneau charge son bundle avec
 * `<script type="module">`.
 */
export const ESM_ENTRIES: Entry[] = [
  { source: 'src/background/service-worker.ts', out: 'background/service-worker' },
  { source: 'src/sidepanel/sidepanel.ts', out: 'sidepanel/sidepanel' },
];

/** Fichiers recopiés tels quels. Le CSS et le HTML ne passent par aucun outil. */
export const ASSETS: Entry[] = [
  { source: 'src/content/content.css', out: 'content/content.css' },
  { source: 'src/sidepanel/sidepanel.css', out: 'sidepanel/sidepanel.css' },
  { source: 'src/sidepanel/sidepanel.html', out: 'sidepanel/sidepanel.html' },
];

/** Dossiers recopiés récursivement. */
export const ASSET_DIRS: Entry[] = [{ source: 'icons', out: 'icons' }];

/**
 * L'appariement entrées ↔ format, en un seul endroit.
 *
 * C'est lui qui porte la contrainte : associer les content scripts à `esm`
 * laisserait leurs `import` non résolus, et Chrome les ignorerait sans un mot.
 * `build.ts` et `tests/build-output.test.ts` lisent cette liste plutôt que de
 * répéter la paire chacun de son côté.
 */
export const BUILD_TARGETS: { name: string; entries: Entry[]; format: 'iife' | 'esm' }[] = [
  { name: 'content scripts', entries: IIFE_ENTRIES, format: 'iife' },
  { name: 'panneau et service worker', entries: ESM_ENTRIES, format: 'esm' },
];

export function esbuildOptions(
  entries: Entry[],
  format: 'iife' | 'esm',
  dev: boolean
): BuildOptions {
  return {
    entryPoints: entries.map((entry) => ({ in: join(ROOT, entry.source), out: entry.out })),
    outdir: DIST,
    bundle: true,
    format,
    target: TARGET,
    platform: 'browser',
    charset: 'utf8',
    logLevel: 'warning',

    minify: !dev,
    // Inline plutôt qu'en fichier séparé : Chrome ne sert pas les .map d'un
    // content script, et un .map orphelin dans le zip est du poids mort.
    sourcemap: dev ? 'inline' : false,

    // Une extension n'a pas de bannière légale à préserver et le code n'a pas
    // de licence tierce embarquée (aucune dépendance runtime).
    legalComments: 'none',
  };
}
