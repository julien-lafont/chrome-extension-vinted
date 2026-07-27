# Contribuer

Merci de passer par ici. Ce document tient en une page : l'essentiel est de savoir
**pourquoi** certaines contraintes existent, parce qu'aucune ne se signale à
l'exécution.

## Mise en route

```bash
corepack enable      # fournit le pnpm attendu
pnpm install
pnpm dev             # reconstruit dist/ à chaque sauvegarde
```

Charger ensuite **`dist/`** via `chrome://extensions` → Mode développeur → Charger
l'extension non empaquetée.

Node 22 minimum. Le dépôt porte un `.nvmrc` : `nvm use` ou `fnm use` suffit.

## La boucle de travail

Après toute modification : `pnpm build` (ou laisser `pnpm dev` tourner), **↻** sur la
carte de l'extension, **puis Cmd+R sur l'onglet Vinted**. Sauter le dernier pas est
l'erreur la plus fréquente : `chrome.storage` lève « Extension context invalidated » et
les clics échouent sans rien afficher.

Avant de pousser :

```bash
pnpm check     # types + lint + formatage + tests
```

C'est exactement ce que rejoue le CI. Les hooks git en lancent déjà une partie
(`lint-staged` au commit, `typecheck` + tests au push).

## Les six règles

Elles viennent toutes d'un bug réel, **intermittent et silencieux**. Le détail est dans
[docs/pitfalls.md](docs/pitfalls.md) ; la version courte :

1. **`pointerdown`, jamais `click` seul** pour une action souris. Le navigateur supprime
   `click` dès qu'une sélection de texte démarre ou que le pointeur glisse. `click` ne
   sert qu'au clavier (`event.detail === 0`).
2. **Sur tout bouton injecté** : `user-select: none`, `pointer-events: none` sur les
   enfants, et **jamais de `transform` au `:hover`**.
3. **Tout repeint doit être idempotent.** Le `MutationObserver` surveille
   `document.body` : écrire dans le DOM sans condition part en boucle à chaque frame.
4. **S'ancrer sur les `data-testid`**, jamais sur les classes CSS de Vinted, qui sont
   obfusquées.
5. **Écrire dans un champ React** passe par le setter natif du prototype plus un
   événement `input`.
6. **Toute écriture en storage relit d'abord** : plusieurs onglets écrivent en
   parallèle.

Les règles 1, 2, 3 et 4 sont vérifiées automatiquement (tests jsdom, plugin stylelint,
règle ESLint). Les règles 5 et 6 ne tiennent qu'à la relecture — le signaler dans la PR
si vous y touchez.

## Écrire un test qui prouve quelque chose

La suite tourne sur du **markup Vinted authentique** (`tests/fixtures/`), jamais réécrit
à la main, et charge le **bundle esbuild** — pas les sources.

Une consigne non négociable : **vérifier que le test peut échouer.** Neutraliser le
correctif doit le faire rougir. Ce projet a déjà connu deux tests qui ne prouvaient rien
—

- l'un stubbait `chrome.storage.onChanged` en no-op, coupant précisément le chaînon qui
  provoquait la boucle de repeint : le bug était là, le test disait le contraire ;
- l'autre vérifiait que la sortie du build ressemblait à `(() => { … })`, ce qui est
  vrai même en format `esm` puisque les sources sont elles-mêmes écrites en IIFE.

[docs/testing.md](docs/testing.md) décrit le harness et ce qui n'est pas couvert (le
vrai DOM Vinted, la modale d'offre).

## Commits

Commits conventionnels, sujet en français :

```
feat(sidepanel): trie les tailles numériques après les alphabétiques
fix(content): rétablit le bouton sur les cartes du dressing
docs: précise la procédure de release
```

Portées disponibles : `content`, `sidepanel`, `background`, `shared`, `build`, `tests`,
`ci`, `docs`, `deps`. `commitlint` refuse le reste au moment du commit.

Ce n'est pas de la cérémonie : les notes de release et le choix du numéro de version se
lisent dans l'historique.

## Conventions de code

- **Commentaires et interface en français**, identifiants en anglais.
- **Commenter le pourquoi**, en particulier les contournements. Sans la raison, la
  session suivante les supprime comme du code mort — c'est déjà arrivé.
- Aucune dépendance d'exécution. `dist/` n'embarque rien d'externe.
- Les imports citent le fichier réel (`./sorting.ts`), pas une sortie hypothétique.

## Quand Vinted casse tout

C'est le cas le plus fréquent. Le chemin le plus court n'est pas la console :

1. **Bouton Diagnostic** du panneau, sur un onglet Vinted. Le rapport dit ce que
   l'extension voit du DOM — table de lecture dans
   [docs/diagnostic.md](docs/diagnostic.md).
2. `pnpm refresh-fixtures` re-télécharge le markup Vinted et fait rougir la suite
   d'extraction à l'endroit précis où l'ancre a bougé.
3. [docs/vinted-dom.md](docs/vinted-dom.md) liste les ancres utilisées et la procédure.
