# Journal des modifications

Format inspiré de [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/).
Ce projet suit le [versionnage sémantique](https://semver.org/lang/fr/).

## [Non publié]

### Ajouté

- Chaîne d'outillage complète : pnpm, build esbuild, ESLint, Prettier, stylelint,
  hooks git (`lint-staged`, `commitlint`) et `pnpm check` comme porte de qualité
  unique, rejouée à l'identique par le CI.
- CI GitHub Actions sur chaque push et chaque PR, avec un **artefact zip
  téléchargeable** ; workflow de release déclenché par un tag `v*`, qui vérifie que
  le tag et `package.json` s'accordent avant de publier.
- `src/shared/` : modèle de données, protocole de messages, parseur de prix et
  formatage des erreurs, désormais partagés entre le content script et le panneau.
- `src/manifest.ts` : manifeste typé, dont la version est lue depuis `package.json` —
  il n'y a plus qu'un seul endroit à modifier pour publier.
- `tests/build-output.test.ts` : verrouille le format de sortie des content scripts
  (IIFE) et la cohérence entre le manifeste et ce que le build produit.
- Un plugin stylelint maison interdit `transform` au survol des boutons injectés, et
  une règle ESLint interdit les classes CSS obfusquées de Vinted dans les sélecteurs.

### Modifié

- **Les sources passent de JavaScript à TypeScript** en mode strict, sans changement
  de comportement : les 81 tests d'origine restent verts à chaque étape.
- **Chrome charge désormais `dist/`, plus la racine du dépôt.**
- Les tests s'exécutent via `tsx` et chargent le **bundle esbuild** plutôt que le
  fichier source : ils valident ce qui est réellement livré.
- Le parseur de prix, jusqu'ici dupliqué entre le content script et le panneau faute
  de pouvoir partager du code, est unifié dans `src/shared/price.ts`.
- Node 22 minimum (`.nvmrc`), pnpm 10.

### Corrigé

- `.vf-card-btn:hover` portait encore un `transform: scale(1.1)` — la règle 2 du
  projet, appliquée au bouton de la fiche article mais jamais reportée sur celui des
  cartes. Le survol ne change plus que des propriétés de peinture.
- `clip` (déprécié) remplacé par `clip-path` dans la classe d'accessibilité du
  panneau, et `word-break: break-word` par `overflow-wrap: anywhere`.

## [0.1.0]

Première version : enregistrement des articles depuis le catalogue et les fiches,
panneau latéral, collections, tri, ordre manuel par glisser-déposer, recherche
d'articles similaires, envoi d'offres au vendeur.
