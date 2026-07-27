/**
 * Build de l'extension.
 *
 * Chrome charge `dist/`, jamais `src/`. Le build produit quatre bundles, copie
 * les fichiers statiques, écrit le manifeste, puis **vérifie que chaque chemin
 * cité par le manifeste existe** — une entrée manquante fait échouer le
 * chargement de l'extension avec un message que Chrome n'explique pas.
 *
 * Les entrées, les formats de sortie et les options esbuild vivent dans
 * `build-config.ts`, que les tests importent aussi : ils bundlent donc avec
 * exactement les options de production.
 *
 * Usage :
 *   pnpm build             build de production (minifié)
 *   pnpm build:dev         sourcemaps, pas de minification
 *   pnpm dev               reconstruit à chaque sauvegarde
 */

import * as esbuild from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';

import { buildManifest } from '../src/manifest.ts';
import { ASSETS, ASSET_DIRS, BUILD_TARGETS, DIST, ROOT, esbuildOptions } from './build-config.ts';

async function copyAssets(): Promise<void> {
  for (const asset of ASSETS) {
    const to = join(DIST, asset.out);
    await mkdir(dirname(to), { recursive: true });
    await cp(join(ROOT, asset.source), to);
  }

  for (const dir of ASSET_DIRS) {
    await cp(join(ROOT, dir.source), join(DIST, dir.out), { recursive: true });
  }
}

async function writeManifest(): Promise<chrome.runtime.ManifestV3> {
  // La version vient de package.json : un seul endroit à changer pour publier.
  const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')) as { version: string };
  const manifest = buildManifest(pkg.version);

  await writeFile(join(DIST, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifest;
}

/**
 * Vérifie que `dist/` contient tout ce que le manifeste annonce.
 *
 * Sans ce contrôle, renommer un fichier sans toucher au manifeste produit un
 * build « réussi » et une extension que Chrome refuse de charger — l'erreur
 * n'apparaît qu'au chargement manuel, loin de la cause. Ce garde-fou a déjà
 * servi : il a attrapé des sorties nommées `content.js.js`.
 */
function validate(manifest: chrome.runtime.ManifestV3): void {
  const declared = new Set<string>();

  if (manifest.background && 'service_worker' in manifest.background) {
    declared.add(manifest.background.service_worker);
  }
  if (manifest.side_panel?.default_path) declared.add(manifest.side_panel.default_path);
  for (const script of manifest.content_scripts ?? []) {
    for (const path of [...(script.js ?? []), ...(script.css ?? [])]) declared.add(path);
  }
  // Le garde de type satisfait aussi le lint : `ManifestIcons` est indexé par
  // taille et ses valeurs ne sont pas typées plus finement que `string`.
  for (const icon of Object.values(manifest.icons ?? {})) {
    if (typeof icon === 'string') declared.add(icon);
  }

  const missing = [...declared].filter((path) => !existsSync(join(DIST, path)));
  if (missing.length > 0) {
    throw new Error(
      `Le manifeste déclare des fichiers absents de dist/ :\n  ${missing.join('\n  ')}`
    );
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      dev: { type: 'boolean', default: false },
      watch: { type: 'boolean', default: false },
    },
  });
  const dev = values.dev ?? false;
  const watch = values.watch ?? false;

  await rm(DIST, { recursive: true, force: true });
  await mkdir(DIST, { recursive: true });

  // L'appariement entrées ↔ format vient de build-config : un test le verrouille.
  const contexts = await Promise.all(
    BUILD_TARGETS.map((target) =>
      esbuild.context(esbuildOptions(target.entries, target.format, dev))
    )
  );

  const buildOnce = async (): Promise<void> => {
    await Promise.all(contexts.map((context) => context.rebuild()));
    await copyAssets();
    validate(await writeManifest());
  };

  await buildOnce();
  console.log(`✓ dist/ prêt (${dev ? 'développement' : 'production'})`);

  if (!watch) {
    await Promise.all(contexts.map((context) => context.dispose()));
    return;
  }

  // esbuild ne surveille que ce qui entre dans ses bundles : le CSS, le HTML et
  // le manifeste sont recopiés, il faut donc les surveiller nous-mêmes.
  await Promise.all(contexts.map((context) => context.watch()));

  const { watch: watchDir } = await import('node:fs/promises');
  const watcher = watchDir(join(ROOT, 'src'), { recursive: true });

  console.log('… en veille sur src/ — Ctrl+C pour arrêter');
  console.log('  rappel : ↻ dans chrome://extensions puis Cmd+R sur l’onglet Vinted');

  for await (const event of watcher) {
    if (!event.filename) continue;
    if (!/\.(css|html)$/.test(event.filename) && event.filename !== 'manifest.ts') continue;

    try {
      await copyAssets();
      validate(await writeManifest());
      console.log(`✓ ${event.filename}`);
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
    }
  }
}

await main();
