# Tests

```bash
pnpm install
pnpm test
```

447 tests, ~30 s. Le runner est celui de Node (`node --test`), exécuté à travers `tsx`
pour qu'il lise directement les sources TypeScript. Node 22 minimum.

**Les tests chargent le bundle esbuild, pas le fichier source.** `content.ts` importe du
code de `src/shared/` : un `window.eval()` sur le source échouerait sur son premier
`import`. Le harness le passe donc par esbuild avec les options de production, lues dans
`scripts/build-config.ts` — ce qui est testé est ce qui est livré, y compris la mise en
IIFE dont dépend la règle 1 du projet.

`tests/` est inerte à l'exécution : `dist/` ne contient que ce que le build y écrit, et
le dossier de tests n'y entre jamais.

## Ce qui est couvert

| Fichier                     | Question posée                                                                               |
| --------------------------- | -------------------------------------------------------------------------------------------- |
| `extract.test.ts`           | Les ancres Vinted, lues seules : fiche, carte, fil d'Ariane, libellés                        |
| `extraction.test.ts`        | L'extraction lit-elle correctement le markup Vinted, y compris les quatre champs de tri ?    |
| `storage.test.ts`           | Deux écritures simultanées s'écrasent-elles ?                                                |
| `click-gestures.test.ts`    | Les boutons répondent-ils à tous les gestes ?                                                |
| `repaint-loop.test.ts`      | Le content script se repeint-il en boucle ?                                                  |
| `drag-slots.test.ts`        | Où se pose une carte qu'on fait glisser ?                                                    |
| `collections.test.ts`       | Une collection ne se supprime-t-elle que vide ?                                              |
| `similar-search.test.ts`    | L'URL de recherche est-elle correctement filtrée ?                                           |
| `photos.test.ts`            | La galerie lit-elle toutes les photos, dans le bon ordre et à la bonne qualité ?             |
| `gallery.test.ts`           | La visionneuse montre-t-elle la bonne photo ?                                                |
| `saved-pulse.test.ts`       | L'icône ne confirme-t-elle _que_ les enregistrements ?                                       |
| `hydration.test.ts`         | Les identifiants du flux RSC sont-ils lus, et rattachés au bon article ?                     |
| `size-ids.test.ts`          | La taille est-elle résolue en identifiant, et refusée quand elle est ambiguë ?               |
| `watch.test.ts`             | La logique pure du suivi de prix (historique, verdicts, débit) est-elle correcte ?           |
| `content-watch.test.ts`     | Le cycle marque-t-il « vendu » sans supprimer, et laisse-t-il un id divergent intact ?       |
| `watch-lease.test.ts`       | Un seul onglet à la fois tient le bail, et un bail expiré est-il repris ?                    |
| `watch-render.test.ts`      | Le badge de variation et l'état vendu s'affichent-ils selon les seuils de la spec ?          |
| `collection-picker.test.ts` | L'appui long range-t-il sans jamais perdre l'article qu'il vient de capturer ?               |
| `tab-default.test.ts`       | L'épingle tient-elle sur le seul onglet, et tombe-t-elle avec sa collection ?                |
| `offers.test.ts`            | Une offre est-elle lue dans une conversation, et refusée quand rien ne la rend sûre ?        |
| `offers-scan.test.ts`       | Le balayage lit-il le moins possible, et n'écrit-il que ce qui a changé ?                    |
| `offers-render.test.ts`     | Le badge d'offre vieillit-il tout seul, et l'onglet ne compte-t-il que ce qui est en cours ? |

`click-gestures`, `repaint-loop` et `drag-slots` verrouillent les correctifs décrits
dans [pitfalls.md](pitfalls.md). Vérifié : retirer le listener `pointerdown` fait tomber
6 tests, neutraliser la garde `vfPainted` en fait tomber 1.

Vérifié de même pour `tab-default` : ignorer l'épingle au clic court fait tomber 3
tests, oublier l'ordre personnalisé 1, et laisser survivre une épingle dont la
collection a été supprimée 1.

Vérifié de même pour les offres (`docs/specs/offres.md`) : supprimer l'arrêt du balayage
sur la première conversation déjà vue, ou traiter un 429 comme une conversation sans
offre — le bug qui effacerait tous les badges d'un coup — fait rougir un cas chacun.

Les quatre suites du suivi de prix couvrent `docs/specs/suivi-prix.md` — détail des
verdicts, du bail et du débit dans `shared/watch.ts`, jamais dans le content script
directement testable autrement qu'à travers `content-watch.test.ts` et
`watch-lease.test.ts`.

La suite « données de tri » d'`extraction.test.ts` couvre les quatre modes du panneau.
Vérifié aussi, un correctif à la fois : ne plus désambiguïser le sous-titre, recouper le
titre au seul `", marque:"`, ne plus lire le bouton `--favourite`, relire une ligne
d'attribut de fiche en bloc, ou retirer le repli d'hydratation — chacun fait rougir la
suite concernée.

La suite « catégorie » vérifie les trois contextes de navigation (fiche, page catégorie,
recherche par mots-clés) — une fixture chacun. Vérifié de même : ne plus filtrer le
maillon de marque, ne plus lire le fil sur les cartes, ou marquer `exact` sans
distinguer la page de l'article font rougir la suite.

La suite « blocs d'articles d'une fiche » couvre le dressing du membre et les articles
similaires, dont les cartes portent un autre préfixe de `data-testid` (voir
[vinted-dom.md](vinted-dom.md)). Vérifié : neutraliser `blockCards()` fait tomber 4
tests, faire hériter ces cartes du fil d'Ariane de la fiche en fait tomber 1.

La suite « identifiants et vendeur » d'`extraction.test.ts` couvre la marque, le vendeur
et la description ; `hydration.test.ts` couvre le flux à part, parce qu'il n'est qu'un
repli — le DOM répond d'abord. Vérifié, un correctif à la fois :

- retirer la garde `item_id` du motif du flux fait tomber 1 test d'`hydration.test.ts` ;
- neutraliser la lecture du fil d'Ariane n'en fait tomber qu'**un** — celui du
  diagnostic, qui compare les deux sources. Les autres passent toujours : c'est le repli
  du flux qui prend le relais, et c'est exactement ce qu'on attend de lui ;
- neutraliser les **deux** sources en fait tomber 3. C'est la mesure qui dit que ces
  tests ne sont pas vides.

`size-ids.test.ts` couvre la seule requête d'API du projet, sur un `fetch` injecté —
aucun test ne sort sur le réseau. Vérifié : ignorer l'ambiguïté d'un libellé fait tomber
2 tests (un ici, un dans `extraction.test.ts`), retirer le cache par catégorie en fait
tomber 2 autres.

`photos.test.ts` et `gallery.test.ts` se partagent la galerie : le premier vérifie ce
qu'on lit de la page, le second ce qu'on en montre. Vérifié un correctif à la fois :
supprimer le tri par `image_no`, le contrôle de l'`item_id`, le dédoublonnage du
carrousel, la montée en pleine résolution, ou rendre `[]` au lieu d'`undefined` fait
rougir la suite. Côté visionneuse : retirer la garde de course, le bouclage, ou laisser
les flèches agir fenêtre fermée en font tomber une chacun.

La garde de course mérite un mot : `full` pèse quatre fois `url`, et si l'utilisateur
change de photo pendant son chargement, l'événement `load` arrive **après** la
navigation. Rien dans l'événement ne dit à quelle photo il se rapporte — sans garde, la
pleine résolution de la précédente s'affiche par-dessus la suivante. jsdom ne va pas sur
le réseau : le test remplace `Image` par un faux qui laisse décider du moment où chaque
chargement aboutit, ce qui est précisément ce qu'il faut pour intercaler la navigation.

`saved-pulse.test.ts` ne teste pas l'animation — Node n'a ni `OffscreenCanvas` ni
`createImageBitmap`, et le module se contente alors du badge — mais **ce qui la
déclenche**. Un clic sur une carte écrit deux fois dans le storage (article en attente,
puis fiche complétée) : `countAdded()` ne compte que les identifiants apparus. Les
horloges du runner de Node servent à traverser la seconde d'affichage du badge sans
attendre. Vérifié : compter toutes les écritures au lieu des ajouts, ou retirer la garde
qui empêche une pulsation d'effacer le badge de la suivante, fait tomber 5 tests.

`drag-slots.test.ts` porte sur `pickSlot()`, la fonction pure extraite de `dnd.ts` qui
décide de l'emplacement visé. Ce calcul dépend de positions à l'écran, que jsdom ne
produit pas — d'où une fonction pure alimentée par des rectangles décrits à la main,
plutôt qu'un DOM simulé. Le cas qui échouait avant correction : un déplacement de 0,7
carte doit faire gagner un rang, et n'en faisait gagner aucun.

## Les modules du panneau

`sidepanel.ts` cherche ses éléments dès son chargement (`required('list')`) : l'importer
hors du panneau lève avant qu'on ait pu appeler quoi que ce soit, et rien de ce qu'il
contient n'est donc atteignable par un test. Tout ce qui mérite d'être éprouvé en sort —
`gallery.ts`, `item-render.ts`, `price-history.ts`, puis `item-list.ts`,
`collections-bar.ts`, `menus.ts` et `reconcile.ts`. Ces modules ne touchent qu'au DOM
qu'on leur passe, n'agissent que par rappels, et ne connaissent pas `chrome` : un test
monte `sidepanel.html` dans jsdom, appelle leur `init…()` avec des rappels espions, et
lit le résultat.

Ce qui reste dans `sidepanel.ts` est l'orchestration : l'état courant, les écouteurs, et
le `render()` qui distribue le travail. C'est la part qu'on relit plutôt qu'on ne teste.

## Deux niveaux, et lequel choisir

`extract.test.ts` appelle `content/extract.ts` directement sur un `Document` jsdom :
aucun bundle, aucun faux `chrome`, aucun faux `fetch`, ~1 s. C'est le niveau à préférer
pour tout ce qui **lit** le markup Vinted — une ancre déplacée y désigne la fonction
fautive plutôt qu'un compteur de `diagnose()`.

`extraction.test.ts` et les autres suites du harness évaluent le content script bundlé
dans une fenêtre complète. C'est le niveau nécessaire dès qu'un geste, une écriture en
storage ou un repeint entre en jeu — donc pour tout ce qui **agit**.

## Le harness

`harness.ts` charge `src/content/content.ts` dans un DOM jsdom bâti sur du markup Vinted
réel, avec un faux `chrome`.

```js
const page = await loadContentScript('item'); // ou 'catalog'
await page.clickMouse(page.detailButton());
assert.equal(page.savedCount(), 1);
```

Helpers de geste, tous attendables (l'écriture en storage est asynchrone) :

| Helper             | Simule                                                                       |
| ------------------ | ---------------------------------------------------------------------------- |
| `clickMouse(el)`   | geste souris complet — `pointerdown` + `click` avec `detail: 1`              |
| `pressOnly(el)`    | appui dont le navigateur a **supprimé** le `click`                           |
| `pressKey(el)`     | activation clavier — `click` seul, `detail: 0`                               |
| `pressLong(el)`    | appui maintenu au-delà du seuil, puis relâché — ouvre le choix de collection |
| `pressAndDrag(el)` | appui qui glisse avant le seuil : un scroll, pas un appui long               |
| `altClick(el)`     | `Alt`+clic — même menu, sans l'attente                                       |
| `watchChurn(el)`   | compte les remplacements d'enfants, révèle une boucle de repeint             |

**Le stub `chrome.storage.onChanged` notifie l'onglet qui vient d'écrire**, comme le
vrai Chrome. Ce détail n'est pas cosmétique : une version antérieure le stubbait en
no-op, ce qui coupait le chaînon déclencheur de la boucle de repeint et produisait un
faux négatif.

### Piloter la lecture des fiches

`window.fetch` est stubbé, et **les requêtes ne se résolvent pas d'elles-mêmes** : c'est
le test qui décide quand la fiche répond. C'est ce qui permet d'observer l'état
intermédiaire — l'article affiché dès le clic, avant que la fiche n'arrive.

| Helper                                   | Effet                                   |
| ---------------------------------------- | --------------------------------------- |
| `pendingFetches()`                       | requêtes parties et pas encore honorées |
| `respondWithFixture('item')`             | répond avec le HTML d'une fixture       |
| `respond({ ok: false, status: 503, … })` | répond une erreur HTTP                  |
| `failFetch()`                            | coupure réseau                          |

### Faire arriver un bloc d'articles de fiche

`appendItemBlock('other_user_items')` ajoute au DOM un « Dressing du membre » après le
rendu initial, comme Vinted le fait. Il ne peut pas venir d'une fixture : la page servie
ne contient qu'un squelette, ces articles n'existent que dans le DOM hydraté et
`refresh-fixtures` ne les voit pas passer. Le markup des cartes est donc celui,
authentique, de `catalog.html`, avec pour seule retouche le préfixe de leur
`data-testid` — ce que Vinted change, et rien d'autre.

Chaque fichier qui charge le content script doit terminer par `after(settleFetches)` :
le content script pose 15 s d'expiration sur chaque requête, et un test qui en laisse
une en suspens retiendrait le process d'autant. Fermer les fenêtres jsdom à la place ne
marche pas — les rAF et observateurs encore en vol échouent sur une fenêtre détruite.

## Fixtures

Sept fixtures, extraites de vraies pages Vinted :

| Fixture                           | Page d'origine                   | Ce qu'elle seule couvre                                            |
| --------------------------------- | -------------------------------- | ------------------------------------------------------------------ |
| `catalog.html` (10 cartes, 61 Ko) | recherche `?search_text=nike`    | l'extraction des cartes, et l'absence de catégorie                 |
| `item.html` (10 Ko)               | une fiche article                | JSON-LD, attributs, favoris par hydratation, catégorie exacte      |
| `category.html` (2 cartes, 13 Ko) | `/catalog/584-hauts-et-t-shirts` | la catégorie héritée du fil d'Ariane de la page                    |
| `item-photos.html` (18 Ko)        | une fiche à trois photos         | la galerie : ordre, pleine résolution, dédoublonnage               |
| `sold.html`                       | une fiche **vendue**             | `isSoldDetail()`, et le repli sans JSON-LD (absent une fois vendu) |
| `home.html` (4 cartes, 23 Ko)     | la page d'accueil                | les cartes `feed-item`, dont le testid ne porte pas d'identifiant  |
| `member.html` (7 Ko)              | le profil du vendeur de la fiche | le pays, qui n'est **sur aucune fiche** — voir `shared/seller.ts`  |

Les pages brutes pèsent 8 Mo et 2 Mo, presque entièrement du bundle Next.js : on ne
garde que le markup réellement lu par le content script. Le markup conservé est
authentique, jamais réécrit à la main.

L'échantillon de cartes n'est pas seulement « les 8 premières » : `pickCards()` ajoute
au besoin une carte sans taille et une carte sans marque, seules à exercer les replis
d'extraction. La fiche embarque en plus le bouton favori, le fil d'Ariane, ses photos et
les fragments du flux d'hydratation qui portent le compteur de favoris, la galerie et la
réputation du vendeur.

`member.html` est la seule fixture d'une page que l'extension **n'affiche jamais** :
elle n'est lue que par `fetch()`, pour le seul pays du vendeur. Son URL se dérive du
lien `/member/{id}` de `item.html`, de sorte que les deux fixtures décrivent le même
vendeur sans qu'aucune URL soit épinglée à la main.

**Les quinze `<img>` d'`item-photos.html` ne sont pas une négligence** : Vinted rend le
carrousel cinq fois, et c'est exactement ce que le dédoublonnage doit absorber. Une
première version les réduisait à trois en construisant la fixture — le test du
dédoublonnage passait alors quoi qu'on fasse au code.

`item-photos.html` a une URL épinglée, là où `itemUrl` est pris au premier article du
catalogue : son nombre de photos change à chaque rafraîchissement, et une galerie testée
à un seul exemplaire n'est pas testée. L'article finira vendu et retiré ; le refresh le
signale alors sans échouer, et conserve la fixture. Il suffit de remplacer `PHOTOS_URL`
par n'importe quelle fiche à trois photos ou plus.

`sold.html` a de même une URL épinglée (`SOLD_URL`) : impossible d'obtenir le badge «
Vendu » autrement qu'en pointant une vraie fiche dans cet état. Même filet de sécurité —
l'article finira par disparaître du tout, le refresh le signale et conserve la fixture
existante plutôt que de faire échouer les quatre autres.

`fixtures/meta.json` porte les URLs des sept pages (l'ID de l'article se lit dans celle
de la fiche) et le nombre de cartes, que les tests lisent au lieu de coder ces valeurs
en dur. **L'URL compte** : c'est elle qui décide si le content script se croit sur une
fiche, et dans quel contexte de catégorie.

### Rafraîchir

```bash
pnpm refresh-fixtures                                    # télécharge depuis vinted.fr
tsx tests/tools/refresh-fixtures.ts cat.html item.html \
  cat2.html photos.html sold.html home.html member.html  # depuis des pages capturées
```

Les pages Vinted étant rendues côté serveur, aucune session n'est nécessaire.

À faire quand la suite d'extraction rougit : si elle repasse au vert avec des fixtures
fraîches, seules les fixtures étaient périmées. Si elle reste rouge, les ancres ont
vraiment changé → [vinted-dom.md](vinted-dom.md).

## Ce que les tests ne couvrent pas

jsdom n'est pas un navigateur. Restent invérifiables ici, et donc à contrôler à la main
dans Chrome :

- **la mise en page** — `elementFromPoint` n'existe pas, aucun recouvrement ne peut être
  détecté (c'est le rôle de `clickablePoints` dans le [Diagnostic](diagnostic.md)) ;
- **le CSS calculé** — `user-select`, `pointer-events` et les `:hover` ne sont pas
  évalués ; les règles de [pitfalls.md](pitfalls.md) reposent sur la revue de code ;
- **le panneau latéral** — le calcul d'emplacement du glisser-déposer est couvert
  (`drag-slots.test.ts`), mais le geste complet ne l'est pas : capture du pointeur,
  défilement automatique, dépôt sur un onglet de collection. L'orchestration de
  `sidepanel.ts` — rendu de la liste, badge de photos sur la miniature, collections à
  l'écran — n'est pas testée non plus ;
- **le chargement réel des images** — `gallery.test.ts` remplace `Image` par un faux,
  puisque jsdom ne va pas sur le réseau. Que les URLs signées répondent vraiment, et que
  la montée en pleine résolution soit imperceptible, se vérifie dans Chrome.

### Rejouer un vrai glisser

Le geste complet ne se vérifie que dans un navigateur. Le panneau tourne hors extension
avec un `chrome` simulé : servir `dist/sidepanel/` après un `pnpm build:dev` (les
modules ES exigent `http://`, pas `file://`), en insérant avant `sidepanel.js` un script
qui pose `window.chrome` — `storage.local` en mémoire, `onChanged` notifiant de façon
asynchrone — et quelques articles de test.

Un geste se rejoue ensuite en dispatchant `pointerdown` / `pointermove` ×N / `pointerup`
sur `.item-drag`. C'est ainsi qu'a été trouvé le décalage d'une demi-carte : un
déplacement de 95 px pour des cartes de 98 px ne bougeait rien. Une seule paire
`pointermove` ne suffit pas à reproduire — il faut une trentaine de pas, comme une vraie
souris.
