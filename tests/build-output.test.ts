/**
 * Invariants de la sortie du build.
 *
 * Ce que ces tests protègent : un content script que Chrome refuse d'exécuter
 * échoue **en silence** — aucun bouton n'apparaît, rien en console. Les autres
 * tests chargent le bundle dans jsdom via `window.eval()`, qui se moque du format
 * du fichier : ils resteraient tous verts.
 *
 * Une première version de ce fichier ne prouvait rien : elle vérifiait que la
 * sortie ressemblait à `(() => { … })`, ce qui est vrai même en format `esm`
 * puisque les sources sont elles-mêmes écrites en IIFE. Neutraliser le format ne
 * la faisait pas rougir. Les assertions ci-dessous portent donc sur ce qui casse
 * réellement : des imports non résolus, et l'appariement entrées ↔ format.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';

import { buildManifest } from '../src/manifest.ts';
import {
  ASSETS,
  BUILD_TARGETS,
  ESM_ENTRIES,
  IIFE_ENTRIES,
  esbuildOptions,
  type Entry,
} from '../scripts/build-config.ts';

/** Bundle une entrée en mémoire, avec les options du build. */
async function bundle(entry: Entry, format: 'iife' | 'esm'): Promise<string> {
  const result = await esbuild.build({
    ...esbuildOptions([entry], format, true),
    outdir: undefined,
    write: false,
  });

  const [output] = result.outputFiles;
  assert.ok(output, `aucune sortie pour ${entry.source}`);
  return output.text;
}

describe('sortie du build', () => {
  test('les content scripts sont appariés au format IIFE', () => {
    const target = BUILD_TARGETS.find((candidate) => candidate.entries === IIFE_ENTRIES);

    assert.ok(target, 'les content scripts ne figurent dans aucune cible de build');
    assert.equal(
      target.format,
      'iife',
      "Chrome n'exécute pas de module ES en content script : ses `import` resteraient " +
        "non résolus et l'injection échouerait sans message."
    );
  });

  test('le code importé est bien inclus dans le bundle', async () => {
    // `content.ts` importe `shared/price.ts`. Si le bundling cessait d'opérer,
    // l'import subsisterait au lieu d'être remplacé par le code de la fonction —
    // c'est le seul symptôme observable dans le fichier produit.
    for (const target of BUILD_TARGETS) {
      for (const entry of target.entries) {
        const code = await bundle(entry, target.format);

        assert.doesNotMatch(
          code,
          /\bfrom\s*['"][./]/,
          `${entry.source} : un import relatif survit dans la sortie — le bundling n'a pas eu lieu.`
        );
        assert.doesNotMatch(
          code,
          /\brequire\s*\(/,
          `${entry.source} : appel à require() dans du code navigateur.`
        );
      }
    }
  });

  test('aucune déclaration de module ne subsiste dans un content script', async () => {
    for (const entry of IIFE_ENTRIES) {
      const code = await bundle(entry, 'iife');

      assert.doesNotMatch(
        code,
        /^\s*(import|export)\s/m,
        `${entry.source} : déclaration de module dans un content script.`
      );
    }
  });

  test('le panneau embarque le code qu’il partage avec le content script', async () => {
    // Le modèle de données et la normalisation des règles de filtrage sont
    // communs aux deux mondes depuis le passage au bundler : chacun doit en
    // embarquer sa copie.
    const sidepanel = ESM_ENTRIES.find((entry) => entry.source.endsWith('sidepanel.ts'));
    assert.ok(sidepanel, 'entrée du panneau introuvable');

    const code = await bundle(sidepanel, 'esm');
    assert.match(
      code,
      /u0300-\\?u036f/,
      'la normalisation partagée (shared/noise.ts) est absente du bundle du panneau'
    );
  });
});

describe('cohérence du manifeste', () => {
  const manifest = buildManifest('9.9.9');

  /** Tout ce que le build écrira dans `dist/`, d'après sa seule configuration. */
  const produced = new Set([
    ...[...IIFE_ENTRIES, ...ESM_ENTRIES].map((entry) => `${entry.out}.js`),
    ...ASSETS.map((asset) => asset.out),
    'icons/icon16.png',
    'icons/icon48.png',
    'icons/icon128.png',
  ]);

  test('la version vient de package.json', () => {
    assert.equal(manifest.version, '9.9.9');
  });

  test('chaque chemin déclaré correspond à une sortie du build', () => {
    const declared: string[] = [];

    if (manifest.background && 'service_worker' in manifest.background) {
      declared.push(manifest.background.service_worker);
    }
    if (manifest.side_panel?.default_path) declared.push(manifest.side_panel.default_path);
    for (const script of manifest.content_scripts ?? []) {
      declared.push(...(script.js ?? []), ...(script.css ?? []));
    }
    for (const icon of Object.values(manifest.icons ?? {})) {
      if (typeof icon === 'string') declared.push(icon);
    }

    assert.ok(declared.length > 0, 'le manifeste ne déclare aucun fichier');

    for (const path of declared) {
      assert.ok(
        produced.has(path),
        `le manifeste déclare « ${path} », que le build ne produit pas. ` +
          `Sorties connues : ${[...produced].sort().join(', ')}`
      );
    }
  });

  test('les content scripts ne visent que vinted.fr', () => {
    for (const script of manifest.content_scripts ?? []) {
      assert.deepEqual(
        script.matches,
        ['https://www.vinted.fr/*'],
        'un content script injecté hors de Vinted lirait des pages sans rapport'
      );
    }
  });
});
