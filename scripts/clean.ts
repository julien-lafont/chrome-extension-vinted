/** Supprime les produits de build. Ne touche pas à node_modules. */

import { rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

for (const target of ['dist', 'artifacts']) {
  await rm(join(ROOT, target), { recursive: true, force: true });
  console.log(`✓ ${target}/ supprimé`);
}
