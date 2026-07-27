/**
 * Empaquette `dist/` en une archive prête à installer.
 *
 * L'archive contient les fichiers **à sa racine**, pas dans un sous-dossier :
 * c'est ce que Chrome attend d'un paquet d'extension, et ce qui permet de la
 * déposer directement sur `chrome://extensions` après décompression.
 *
 * Suppose que `pnpm build` a déjà tourné (c'est ce que fait `pnpm package`).
 */

import { mkdir, readFile, rm, readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const ARTIFACTS = join(ROOT, 'artifacts');

async function main(): Promise<void> {
  const entries = await readdir(DIST).catch(() => []);
  if (entries.length === 0) {
    throw new Error('dist/ est vide ou absent — lancer `pnpm build` d’abord.');
  }

  const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')) as {
    name: string;
    version: string;
  };

  const archive = join(ARTIFACTS, `${pkg.name}-${pkg.version}.zip`);

  await mkdir(ARTIFACTS, { recursive: true });
  await rm(archive, { force: true });

  // `zip` plutôt qu'une dépendance npm : l'outil est présent sur macOS comme sur
  // les runners GitHub, et le projet tient à n'avoir aucune dépendance superflue.
  //   -r récursif  -q silencieux  -X sans métadonnées macOS (archive plus stable
  //   d'une machine à l'autre)
  try {
    await run('zip', ['-r', '-q', '-X', archive, '.'], { cwd: DIST });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('ENOENT')) {
      throw new Error(
        'La commande `zip` est introuvable. Sur Debian/Ubuntu : apt-get install zip',
        { cause: error }
      );
    }
    throw error;
  }

  console.log(`✓ ${archive.replace(`${ROOT}/`, '')}`);
}

await main();
