# Vinted Favoris — guide de travail

Extension Chrome **Manifest V3**, JS vanilla, **aucune étape de build**. Cible
`https://www.vinted.fr/*` uniquement. Le stockage est local (`chrome.storage.local`),
rien ne sort du navigateur.

## Commandes

```bash
cd tests && npm test          # 81 tests, ~20 s, runner Node natif
cd tests && npm run refresh-fixtures   # re-télécharge le markup Vinted
```

Il n'y a ni linter ni build. Après toute modification : ↻ dans `chrome://extensions`
**puis** Cmd+R sur l'onglet Vinted — sinon `chrome.storage` lève
« Extension context invalidated » et les clics échouent en silence.

## Structure

```
src/content/content.js       injection des boutons + extraction   ← le cœur, testé
src/content/offer-agent.js   pilotage de la modale d'offre Vinted
src/sidepanel/               panneau : sidepanel, store, sorting, dnd, offer
src/background/              ouvre le panneau au clic sur l'icône
tests/                       jsdom + fixtures Vinted réelles
```

Content scripts = IIFE (Chrome n'y supporte pas les imports). Panneau = modules ES.

**Une seule extraction fait foi : celle de la fiche article.** Un clic sur une
carte enregistre aussitôt ce que la carte affiche (`pending: true`, le panneau
montre l'article dans la seconde), puis `fetch()` la fiche en tâche de fond et
complète — même fonction, mêmes ancres. Détail et garde-fous :
`docs/architecture.md`.

## Règles à ne pas enfreindre

Chacune vient d'un bug réel, intermittent et **silencieux** — aucune erreur en
console. Les tests verrouillent les trois premières.

1. **`pointerdown`, jamais `click` seul** pour déclencher une action souris. Le
   navigateur supprime `click` dès qu'une sélection de texte démarre ou que le
   pointeur glisse. `click` ne sert qu'au clavier (`event.detail === 0`).
2. **Sur tout bouton injecté** : `user-select: none`, `pointer-events: none` sur les
   enfants (`> *`), et **jamais de `transform` au `:hover`** (le bouton sort de sa
   propre zone de survol et oscille).
3. **Tout repeint doit être idempotent.** Le `MutationObserver` surveille
   `document.body` : écrire dans le DOM sans condition déclenche un scan, qui
   repeint, à chaque frame. Garder les gardes `vfPainted` / `vfInjected` / `vfPath`.
4. **S'ancrer sur les `data-testid`, jamais sur les classes CSS** — Vinted les
   obfusque (`Grid-module-scss-module__HmDNda__…`).
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

Le content script tourne dans un monde isolé, peu commode à inspecter. Le chemin le
plus court n'est pas la console :

1. **Bouton Diagnostic** du panneau, sur un onglet Vinted → `docs/diagnostic.md` a la
   table de lecture. Étendre `diagnose()` dans `content.js` coûte quelques lignes et
   fait gagner un aller-retour.
2. **Reproduire dans `tests/`** avant de corriger. Un test qui échoue vaut mieux
   qu'une hypothèse.
3. **Vérifier que le test peut échouer** : neutraliser le correctif doit le faire
   rougir. Un stub qui simplifie le comportement testé ne prouve rien — un premier
   test a conclu à tort à l'absence de bug parce qu'il stubbait
   `chrome.storage.onChanged` en no-op, coupant précisément le chaînon fautif.
4. Un MCP `chrome-devtools` est configuré si l'observation du vrai navigateur devient
   nécessaire (nécessite un redémarrage de session pour être disponible). A n'utiliser que pour débogger un problème existant, pas pour tester une nouvelle fonctionnalité.

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
- Aucune dépendance runtime. `jsdom` est confiné à `tests/node_modules` : Chrome
  charge tout le dossier mais n'exécute que ce que déclare `manifest.json`.
- Fixtures de test : markup Vinted authentique, jamais réécrit à la main.
