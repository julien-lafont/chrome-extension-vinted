# Vinted Favoris — guide de travail

Extension Chrome **Manifest V3**, TypeScript, bundlée par esbuild. Cible
`https://www.vinted.fr/*` uniquement. Le stockage est local (`chrome.storage.local`),
rien ne sort du navigateur.

## Commandes

```bash
pnpm dev          # build de développement en veille sur src/
pnpm build        # dist/ minifié
pnpm test         # 216 tests, ~28 s, runner Node natif via tsx
pnpm check        # types + lint + formatage + tests — ce que le CI rejoue
pnpm package      # artifacts/vinted-favoris-<version>.zip
```

Node 22 minimum (`.nvmrc`), pnpm 10. **Chrome charge `dist/`, jamais `src/`.** Après
toute modification : `pnpm build` (ou laisser `pnpm dev` tourner), ↻ dans
`chrome://extensions`, **puis** Cmd+R sur l'onglet Vinted — sinon `chrome.storage` lève
« Extension context invalidated » et les clics échouent en silence.

## Structure

```
src/content/content.ts       injection des boutons + extraction   ← le cœur, testé
src/content/collection-picker.ts  menu de collection ouvert par l'appui long
src/content/offer-agent.ts   pilotage de la modale d'offre Vinted
src/sidepanel/               panneau : sidepanel, store, sorting, dnd, offer, search, gallery
src/shared/                  modèle de données, messages, prix, photos, erreurs
src/background/              ouvre le panneau ; badge + pulsation à l'enregistrement
src/manifest.ts              manifeste typé ; la version vient de package.json
scripts/                     build, empaquetage (build-config.ts = source unique)
tests/                       jsdom + fixtures Vinted réelles
```

**Les formats de sortie ne sont pas cosmétiques.** Content scripts → IIFE : Chrome n'y
accepte aucun `import` à l'exécution, esbuild les résout à la compilation. Panneau et
service worker → modules ES. L'appariement vit dans `scripts/build-config.ts` et
`tests/build-output.test.ts` le verrouille.

`src/shared/` n'existe que grâce au bundler : avant lui, content script et panneau ne
pouvaient rien partager, et le modèle de données comme le parseur de prix vivaient en
double.

**Une seule extraction fait foi : celle de la fiche article.** Un clic sur une carte
enregistre aussitôt ce que la carte affiche (`pending: true`, le panneau montre
l'article dans la seconde), puis `fetch()` la fiche en tâche de fond et complète — même
fonction, mêmes ancres. Détail et garde-fous : `docs/architecture.md`.

## Règles à ne pas enfreindre

Chacune vient d'un bug réel, intermittent et **silencieux** — aucune erreur en console.
Ce qui les verrouille mécaniquement : les tests jsdom pour 1 et 3, un plugin stylelint
maison (`tools/stylelint-no-hover-transform.js`) pour le `transform` de la règle 2, une
règle ESLint `no-restricted-syntax` pour la 4. Les règles 5 et 6 ne tiennent qu'à la
relecture.

1. **`pointerdown`, jamais `click` seul** pour déclencher une action souris. Le
   navigateur supprime `click` dès qu'une sélection de texte démarre ou que le pointeur
   glisse. `click` ne sert qu'au clavier (`event.detail === 0`).
2. **Sur tout bouton injecté** : `user-select: none`, `pointer-events: none` sur les
   enfants (`> *`), et **jamais de `transform` au `:hover`** (le bouton sort de sa
   propre zone de survol et oscille).
3. **Tout repeint doit être idempotent.** Le `MutationObserver` surveille
   `document.body` : écrire dans le DOM sans condition déclenche un scan, qui repeint, à
   chaque frame. Garder les gardes `vfPainted` / `vfInjected` / `vfPath`.
4. **S'ancrer sur les `data-testid`, jamais sur les classes CSS** — Vinted les obfusque
   (`Grid-module-scss-module__HmDNda__…`).
5. **Écrire dans un champ React** passe par le setter natif de
   `HTMLInputElement.prototype.value` + un événement `input`. `field.value = …` est
   ignoré et laisse le bouton d'envoi désactivé.
6. **Toute écriture en storage relit d'abord** : plusieurs onglets Vinted écrivent en
   parallèle.

## Où chercher

| Besoin                                           | Document               |
| ------------------------------------------------ | ---------------------- |
| Ancres DOM Vinted, que faire quand elles cassent | `docs/vinted-dom.md`   |
| Détail des pièges ci-dessus                      | `docs/pitfalls.md`     |
| Modèle de données, storage, responsabilités      | `docs/architecture.md` |
| Lire un rapport de diagnostic                    | `docs/diagnostic.md`   |
| Harness, fixtures, ce qui n'est pas couvert      | `docs/testing.md`      |
| Limites connues (tri likes, prix, offres)        | `docs/limitations.md`  |

Ne les charger qu'au besoin — le présent fichier suffit pour la plupart des tâches.

## Méthode de debug

Le content script tourne dans un monde isolé, peu commode à inspecter. Le chemin le plus
court n'est pas la console :

1. **Bouton Diagnostic** du panneau, sur un onglet Vinted → `docs/diagnostic.md` a la
   table de lecture. Étendre `diagnose()` dans `content.ts` coûte quelques lignes et
   fait gagner un aller-retour.
2. **Reproduire dans `tests/`** avant de corriger. Un test qui échoue vaut mieux qu'une
   hypothèse.
3. **Vérifier que le test peut échouer** : neutraliser le correctif doit le faire
   rougir. Un stub qui simplifie le comportement testé ne prouve rien — un premier test
   a conclu à tort à l'absence de bug parce qu'il stubbait `chrome.storage.onChanged` en
   no-op, coupant précisément le chaînon fautif.
4. Un MCP `chrome-devtools` est configuré si l'observation du vrai navigateur devient
   nécessaire (nécessite un redémarrage de session pour être disponible). A n'utiliser
   que pour débogger un problème existant, pas pour tester une nouvelle fonctionnalité.

Symptômes déjà élucidés, à ne pas re-diagnostiquer :

| Symptôme                                           | Cause                                                    |
| -------------------------------------------------- | -------------------------------------------------------- |
| Le bouton répond sur l'icône mais pas sur le texte | sélection de texte → règles 1 et 2                       |
| Le catalogue marche, la fiche article non          | boucle de repeint → règle 3                              |
| « Une fois sur deux » au glisser-déposer           | `sortDir` appliqué à l'ordre manuel → `docs/pitfalls.md` |

## Conventions

- Commentaires et interface **en français**, identifiants en anglais.
- Commenter le **pourquoi**, en particulier les contournements : sans la raison, la
  prochaine session les supprime comme du code mort.
- **Aucune dépendance d'exécution.** Tout ce qui est dans `package.json` est de
  l'outillage, et `dist/` n'embarque rien d'externe.
- Fixtures de test : markup Vinted authentique, jamais réécrit à la main.
- **TypeScript reste en 6.x.** `typescript-eslint` refuse TS 7 (il s'arrête à `<6.1.0`)
  : monter TypeScript casse `pnpm lint` d'un bloc. Dependabot a pour consigne d'ignorer
  ce majeur.
- Les imports citent le fichier réel (`./sorting.ts`), pas une sortie hypothétique.
