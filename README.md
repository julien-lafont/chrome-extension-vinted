# Vinted Favoris

Extension Chrome (Manifest V3) pour enregistrer des articles Vinted en local et les
retrouver dans un panneau latéral : collections, tri, et envoi d'offres au vendeur.

Aucun serveur, aucun compte, aucune donnée qui sort du navigateur. Fonctionne sur
`vinted.fr`.

## Installation

### Depuis une version publiée

1. Télécharger le `.zip` de la [dernière release][releases] et le décompresser
2. Ouvrir `chrome://extensions`
3. Activer le **Mode développeur** (en haut à droite)
4. **Charger l'extension non empaquetée** → sélectionner le dossier décompressé
5. Épingler l'extension dans la barre d'outils

L'extension n'est pas publiée sur le Chrome Web Store : l'installation manuelle est le
mode de distribution prévu.

[releases]: ../../releases/latest

### Depuis les sources

```bash
pnpm install
pnpm build
```

Puis charger le dossier **`dist/`** (et non la racine) en suivant les étapes 2 à 5
ci-dessus.

Après toute modification du code : `pnpm build`, bouton ↻ sur la carte de l'extension
dans `chrome://extensions`, **puis recharger l'onglet Vinted**. Sans ce dernier
rechargement, `chrome.storage` lève « Extension context invalidated » et les clics
échouent en silence.

## Utilisation

- **Page de recherche** — un bouton marque-page apparaît en haut à droite de chaque
  article (le favori natif de Vinted reste en bas à droite, aucune collision).
- **Fiche article** — un bouton « Enregistrer » flotte en bas à droite de l'écran, et le
  même marque-page apparaît sur les cartes des blocs du bas de page (« Dressing du
  membre », « Articles similaires »).
- **Panneau latéral** — clic sur l'icône de l'extension.

Les boutons se synchronisent entre tous les onglets Vinted ouverts.

### Collections

Les onglets en haut du panneau regroupent les articles. Tout nouvel article arrive dans
**Mes favoris**, la collection par défaut, qui ne peut pas être supprimée.

- `+` crée une collection (« Jeans », « Chemises », « Cadeau Julien »…)
- clic droit sur un onglet : le renommer
- pour classer un article : glisser sa poignée sur l'onglet visé, ou passer par l'icône
  dossier de la ligne
- une **croix** apparaît sur un onglet dès que sa collection est vide : elle la
  supprime. Une collection qui contient encore des articles n'affiche pas de croix — il
  faut la vider d'abord, ce qui évite de déplacer des articles sans le vouloir. **Mes
  favoris** n'en affiche jamais.

### Tri et ordre manuel

Six modes : **Personnalisé**, **Date d'ajout**, **Prix**, **État**, **Likes**,
**Taille**. Le bouton à droite du sélecteur inverse le sens, avec un libellé adapté au
mode (« Moins cher » plutôt que « Croissant »).

L'ordre personnalisé se règle en glissant la poignée `⠿` à gauche d'un article. Le
glisser fonctionne quel que soit le mode actif : partir d'un tri automatique bascule
simplement en ordre personnalisé, en figeant l'ordre affiché. L'ordre est propre à
chaque collection.

Réordonner **avec une recherche active** ne déplace que les articles visibles : les
articles masqués par le filtre gardent leur position dans l'ordre complet.

Échelles utilisées :

| Tri    | Ordre                                                                     |
| ------ | ------------------------------------------------------------------------- |
| État   | Satisfaisant → Bon → Très bon → Neuf sans étiquette → Neuf avec étiquette |
| Taille | Alphabétiques (XXXS → XXXL) d'abord, puis numériques (34, 36, 38…)        |

Un article dépourvu de la donnée triée finit **toujours** en bas de liste, dans les deux
sens, et l'en-tête indique combien d'articles sont dans ce cas. Certains tris sont
aujourd'hui incomplets — voir [limites connues](docs/limitations.md).

### Explorer une marque

La **marque** d'un article, soulignée en pointillé dans la ligne de métadonnées, ouvre
le catalogue Vinted filtré sur cette marque **dans la catégorie de l'article**. Rien
d'autre n'est filtré : ni prix, ni taille, ni état — c'est une exploration de la marque,
pas la recherche d'un équivalent.

Si la catégorie de l'article n'est pas connue avec certitude, le filtre porte sur la
marque seule plutôt que de risquer une catégorie erronée.

### Rechercher un article similaire

L'icône loupe d'un article ouvre le catalogue Vinted pré-filtré :

| Critère          | Valeur                                                             |
| ---------------- | ------------------------------------------------------------------ |
| Marque et taille | celles de l'article                                                |
| Catégorie        | celle de l'article, si elle est connue avec certitude              |
| Prix             | de la **moitié** au **double** du prix enregistré (−50 % / +100 %) |
| État             | Neuf avec étiquette, Neuf sans étiquette, Très bon état            |

Les trois états sont **fixes**, quel que soit celui de l'article d'origine : on cherche
une bonne affaire, pas son équivalent abîmé.

Les deux bornes s'ajustent séparément dans `src/sidepanel/search.ts` : `PRICE_DOWN` (0,5
= −50 %) et `PRICE_UP` (1 = +100 %). Elles sont arrondies vers l'extérieur, pour ne pas
exclure un article situé pile sur la limite.

Marque et taille passent aujourd'hui par la recherche textuelle : Vinted ne filtre que
par identifiant numérique, et les favoris ne stockent que des libellés. La recherche est
donc approximative sur ces deux critères — « 42 » remonte aussi bien une pointure qu'un
tour de taille. La catégorie corrige beaucoup ce flou quand elle est disponible. Voir
[vinted-dom.md](docs/vinted-dom.md#url-de-recherche-du-catalogue).

### Offres au vendeur

L'icône étiquette d'un article ouvre la fenêtre d'offre :

1. le prix est pré-rempli à la dernière remise utilisée (raccourcis −10 / −15 / −20 /
   −30 %) ;
2. un message de négociation est composé pour ce prix — **Régénérer** en propose une
   autre formulation, et toute modification manuelle est conservée ;
3. **Envoyer l'offre** ouvre (ou réutilise) l'onglet de l'article et pilote la page :
   bouton « Faire une offre » → saisie du prix → validation, puis envoi du message dans
   la conversation si la case est cochée.

Le registre du message s'adapte à l'effort demandé au vendeur : au-delà de 25 % de
remise, il reconnaît explicitement que la demande est basse et invite à une
contre-proposition, ce qui vaut mieux qu'un chiffre sec.

L'offre part réellement à la validation — le récapitulatif affiché avant l'envoi est le
point de contrôle. Chaque étape ratée est signalée nommément (bouton introuvable, champ
inactif, modale non refermée) plutôt que par un échec générique.

### Export et diagnostic

Le pied du panneau propose un **export JSON** de tous les favoris, et un **Diagnostic**
à lancer quand quelque chose ne fonctionne plus — il dit en une lecture si Vinted a
changé son DOM ou si le clic n'atteint pas le bouton.

## Documentation

| Document                                | Contenu                                            |
| --------------------------------------- | -------------------------------------------------- |
| [architecture.md](docs/architecture.md) | Fichiers, modèle de données, stockage, concurrence |
| [vinted-dom.md](docs/vinted-dom.md)     | Ancres DOM Vinted et procédure quand elles cassent |
| [pitfalls.md](docs/pitfalls.md)         | Clics fantômes, boucle de repeint, glisser-déposer |
| [diagnostic.md](docs/diagnostic.md)     | Lecture du rapport de diagnostic                   |
| [testing.md](docs/testing.md)           | Lancer les tests, harness, fixtures                |
| [limitations.md](docs/limitations.md)   | Limites connues                                    |

Pour contribuer : [CONTRIBUTING.md](CONTRIBUTING.md). Pour travailler avec un agent sur
ce dépôt : [CLAUDE.md](CLAUDE.md).

## Développement

Node 22+ et pnpm 10+ (`corepack enable` suffit à obtenir le bon pnpm).

```bash
pnpm install
pnpm dev        # reconstruit dist/ à chaque sauvegarde
```

| Commande         | Effet                                                      |
| ---------------- | ---------------------------------------------------------- |
| `pnpm dev`       | build de développement en veille (sourcemaps, non minifié) |
| `pnpm build`     | `dist/` de production, minifié                             |
| `pnpm test`      | 88 tests jsdom sur fixtures Vinted réelles (~25 s)         |
| `pnpm typecheck` | `tsc --noEmit`                                             |
| `pnpm lint`      | ESLint + stylelint                                         |
| `pnpm format`    | Prettier en écriture                                       |
| `pnpm check`     | tout ce qui précède — ce que le CI rejoue                  |
| `pnpm package`   | `artifacts/vinted-favoris-<version>.zip`                   |

### Ce que le projet garantit mécaniquement

Les pièges de cette extension sont silencieux : rien n'apparaît en console. Trois
garde-fous sont donc outillés plutôt que confiés à la relecture.

- **Les content scripts restent en IIFE.** Chrome n'y accepte aucun `import` à
  l'exécution ; un module ES y échouerait sans un mot. `tests/build-output.test.ts` le
  vérifie.
- **Pas de `transform` au `:hover`** sur les boutons injectés : le bouton sort de sa
  propre zone de survol et oscille, ce qui avale le clic. Un plugin stylelint maison
  (`tools/stylelint-no-hover-transform.js`) le refuse.
- **Pas de classe CSS Vinted dans les sélecteurs** : elles sont obfusquées et changent à
  chaque déploiement. Une règle ESLint les interdit.

### Publier une version

La version vit dans `package.json` seul — `src/manifest.ts` la lit, le tag doit s'y
accorder (le workflow échoue sinon).

```bash
pnpm version minor          # met à jour package.json et crée le tag
git push --follow-tags
```

Le workflow `release.yml` rejoue `pnpm check`, construit le zip et crée la Release
GitHub. Chaque commit sur `main` et chaque PR produisent déjà un artefact zip
téléchargeable depuis l'onglet Actions, sans créer de release.

### Une note sur TypeScript

TypeScript est volontairement maintenu en **6.x** : `typescript-eslint` ne supporte pas
encore TS 7 (sa borne est `<6.1.0`) et refuse de démarrer au-delà, ce qui casse
`pnpm lint` entièrement. Dependabot a pour consigne d'ignorer ce majeur.
