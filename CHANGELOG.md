# Journal des modifications

Format inspiré de [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/).
Ce projet suit le [versionnage sémantique](https://semver.org/lang/fr/).

## [Non publié]

### Ajouté

- **Identifiant de marque extrait de la fiche** (`brandId`), lu dans le maillon du fil
  d'Ariane que la catégorie écarte, avec le flux d'hydratation en repli. « Rechercher
  un article similaire » et « explorer la marque » filtrent enfin sur la vraie marque :
  le catalogue Vinted n'accepte pas de nom dans `brand_ids[]`, et les deux fonctions
  attendaient depuis toujours un champ que personne ne renseignait.
- **Identifiant de taille résolu** (`sizeId`) : aucune page de Vinted ne le porte, il est
  déduit du libellé et de la catégorie via `/api/v2/size_groups`, dans une écriture
  séparée qui ne retarde pas l'affichage. La recherche d'articles similaires filtre donc
  la taille exactement, au lieu de la chercher en texte — « 42 » ne remonte plus une
  pointure quand on cherchait un tour de taille. La résolution renonce plutôt que de
  filtrer sur la mauvaise échelle quand le libellé est ambigu.
- **Vendeur affiché à côté du prix**, cliquable vers son dressing (`sellerId`,
  `sellerName`).
- **Description enregistrée** avec l'article (tronquée à 1 200 caractères). Encore
  inexploitée : la capturer maintenant évite d'avoir à relire toutes les fiches le jour
  où la recherche s'en servira.
- `src/shared/size-ids.ts` : résolution d'un libellé de taille en identifiant de
  catalogue, avec cache par catégorie et repli textuel silencieux.
- `src/shared/hydration.ts` : lecture des identifiants du flux React Server Components,
  en une seule passe pour les trois clés (`favourite_count`, `brand_id`, `seller_id`).
- Le rapport de Diagnostic montre les **deux sources** de chaque identifiant, ce qui dit
  laquelle a lâché plutôt que de conclure à une donnée absente.
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
