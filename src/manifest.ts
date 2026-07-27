/**
 * Manifeste de l'extension, en TypeScript plutôt qu'en JSON.
 *
 * Deux raisons :
 *   — la version vient de `package.json`, il n'y a donc qu'un seul endroit à
 *     modifier pour publier (le manifeste et le tag Git ne peuvent plus diverger) ;
 *   — le type `chrome.runtime.ManifestV3` détecte les fautes de frappe dans les
 *     permissions ou les clés, que Chrome signalerait autrement par un refus de
 *     chargement sans explication utile.
 *
 * Les chemins sont **relatifs à `dist/`**, pas aux sources : c'est ce dossier que
 * Chrome charge. La correspondance sources → `dist/` est décrite dans
 * `scripts/build.ts`, qui vérifie aussi que chaque chemin cité ici existe bien
 * après le build.
 */

import { ICON_PATHS } from './shared/icons.ts';

const VINTED_ORIGIN = 'https://www.vinted.fr/*';

export function buildManifest(version: string): chrome.runtime.ManifestV3 {
  return {
    manifest_version: 3,
    name: 'Vinted Smart Bookmarks',
    version,
    description:
      'Enregistre tes articles Vinted préférés en local et retrouve-les dans un panneau latéral.',

    permissions: ['storage', 'sidePanel'],
    host_permissions: [VINTED_ORIGIN],

    background: {
      // Bundle en module ES : le service worker importe le modèle de données
      // partagé avec le reste de l'extension.
      service_worker: 'background/service-worker.js',
      type: 'module',
    },

    action: {
      default_title: 'Ouvrir Vinted Smart Bookmarks',
      // Déclarée explicitement, et pas seulement via `icons` : le service worker
      // remplace l'icône le temps de la pulsation puis rend celle-ci
      // (`saved-pulse.ts`), donc elle doit être une valeur nommée quelque part.
      default_icon: { ...ICON_PATHS },
    },

    side_panel: {
      default_path: 'sidepanel/sidepanel.html',
    },

    content_scripts: [
      {
        matches: [VINTED_ORIGIN],
        js: ['content/content.js'],
        css: ['content/content.css'],
        run_at: 'document_idle',
      },
      {
        // Agent d'offre : script distinct, inerte jusqu'à ce que le panneau le
        // sollicite. Séparé de content.js pour que le pilotage de la modale
        // d'offre ne puisse pas faire tomber l'injection des boutons.
        matches: [VINTED_ORIGIN],
        js: ['content/offer-agent.js'],
        run_at: 'document_idle',
      },
    ],

    icons: { ...ICON_PATHS },
  };
}
