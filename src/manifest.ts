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

const VINTED_ORIGIN = 'https://www.vinted.fr/*';

export function buildManifest(version: string): chrome.runtime.ManifestV3 {
  return {
    manifest_version: 3,
    name: 'Vinted Favoris',
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
      default_title: 'Ouvrir mes favoris Vinted',
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

    icons: {
      16: 'icons/icon16.png',
      48: 'icons/icon48.png',
      128: 'icons/icon128.png',
    },
  };
}
