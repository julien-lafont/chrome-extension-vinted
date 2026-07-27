# Ancres DOM Vinted

Le savoir le plus périssable du projet : Vinted change son front sans préavis. Ce
document dit **où** on s'accroche et **pourquoi** là plutôt qu'ailleurs.

Règle générale : Vinted obfusque ses classes CSS (`Grid-module-scss-module__HmDNda__…`)
mais expose des `data-testid` stables. **On ne s'accroche jamais à une classe générée.**

## Page de résultats

`[data-testid="product-item-id-{ID}"]` porte l'ID de l'article directement dans
l'attribut — c'est le point d'ancrage principal. Ses descendants portent les métadonnées
:

| Donnée                   | Ancre (suffixe du `data-testid`)                        |
| ------------------------ | ------------------------------------------------------- |
| Carte, conteneur externe | `[data-testid="grid-item"]`                             |
| URL                      | `--overlay-link` (`<a href>`)                           |
| Miniature                | `--image--img` (`<img src>`)                            |
| Marque                   | `--description-title`                                   |
| Taille · état            | `--description-subtitle` → `"42 · Neuf avec étiquette"` |
| Prix                     | `--price-text`                                          |
| Favori natif Vinted      | `--favourite` (coin bas-droite)                         |
| Nombre de favoris        | `--favourite` → `[data-testid="favourite-count-text"]`  |
| Catégorie                | _absente_ — voir le fil d'Ariane de la page             |

Le sélecteur des cartes exclut les descendants :
`[data-testid^="product-item-id-"]:not([data-testid*="--"])`.

Le bouton `--favourite` porte aussi le compte dans son libellé
(`aria-label="Ajouter aux favoris, ajouté aux favoris par 9 utilisateurs"`), lu en repli
du compteur visible. Un libellé sans nombre signifie zéro favori ; aucun bouton du tout
signifie donnée absente — les deux ne se confondent pas, sous peine de trier des
articles inconnus comme des articles sans favori.

### Le titre n'a pas d'ancre — et le sous-titre est ambigu

Le titre n'existe nulle part en clair sur une carte. On le lit dans le libellé
d'accessibilité du lien (`title`, ou `alt` de l'image), au format :

```
"{titre}, marque: X, état: Y, taille: Z, {prix}, {protection acheteurs}"
```

On coupe au **premier attribut nommé** (`marque:`, `état:`, `taille:`) — et non à la
première virgule, un titre pouvant en contenir (« Jogging Nike, taille S »). Couper au
seul `", marque:"` ne suffit pas : la marque manque sur certaines cartes, et tout le
libellé se retrouvait alors en guise de titre. Repli : le slug de l'URL.

Ce libellé est aussi la source **prioritaire** de la taille et de l'état, parce qu'il
les nomme. Le sous-titre `--description-subtitle` les juxtapose
(`"42 · Neuf avec étiquette"`) et **omet la taille** sur les articles qui n'en ont pas —
il se réduit alors à `"Très bon état"`, sans rien pour le signaler. Le repli sur le
sous-titre lève l'ambiguïté par vocabulaire (`CONDITION_WORDS`).

C'est la partie la plus fragile de l'extraction, et elle dépend de la locale française.
Voir `parseTitleFromLabel()` et `parseSubtitle()` dans `content.ts`.

## Fiche article

Un `<script type="application/ld+json">` schema.org expose tout :

```json
{
  "@type": "Product",
  "name": "Nike Air Zoom mercurial superfly 11 Élite (PAS 1€)",
  "description": "…",
  "image": "https://images1.vinted.net/…/f800/….webp",
  "brand": { "name": "Nike" },
  "offers": {
    "price": 1,
    "priceCurrency": "EUR",
    "availability": "InStock",
    "itemCondition": "NewCondition"
  },
  "category": "Hommes Chaussures de foot",
  "color": "Menthe"
}
```

**C'est la source à privilégier** : Vinted a un intérêt SEO à ne pas la casser, là où
les `data-testid` ne servent que ses propres tests. Le JSON-LD est présent en session
connectée comme déconnectée (vérifié).

Le prix y est un nombre brut (`1`) là où le catalogue affiche une chaîne (`"1,00 €"`).
`formatPrice()` normalise via `Intl.NumberFormat('fr-FR')` pour que les deux sources
produisent la même valeur ; le nombre est conservé tel quel dans `priceValue`, que le
tri lit en priorité.

Replis si le JSON-LD disparaît : `item-price`, `item-attributes-size`,
`item-attributes-status`, `item-attributes-brand-menu-button`, `item-photo-1--img`.

### Taille et état : viser la valeur, pas la ligne

Le JSON-LD ne les porte pas (`itemCondition` vaut `NewCondition`, trop grossier pour
l'échelle Vinted). Ils se lisent sur la fiche, mais chaque ligne empile son libellé et
sa valeur :

```html
<div data-testid="item-attributes-size">
  <div>Taille</div>
  <div itemprop="size">
    42<button data-testid="item-attributes-size-faq-link">…</button>
  </div>
</div>
```

Le `textContent` de la ligne entière donne `"Taille42"`. On cible donc `[itemprop]` —
`size`, `status`, également `color` et `upload_date` si besoin — et on écarte le bouton
d'aide qu'il contient. Voir `detailAttribute()`.

### Le fil d'Ariane porte la catégorie

Rendu côté serveur, sur la fiche article **comme** sur les pages catégorie du catalogue
:

```html
<ul class="breadcrumbs">
  <li>
    <a href="/catalog/5-hommes" itemprop="url"><span itemProp="title">Hommes</span></a>
  </li>
  …
  <a href="/catalog/584-hauts-et-t-shirts">Hauts et t-shirts</a>
  <li>
    <a href="/catalog/584-tops-and-t-shirts/brand/53-nike">Nike Hauts et t-shirts</a>
  </li>
</ul>
```

Chaque maillon est une URL de catalogue ouvrable telle quelle — c'est ce qui rend la
catégorie enregistrée réutilisable. **Le dernier maillon croise la marque**
(`/brand/53-nike`) : on l'écarte, une recherche relancée depuis là serait restreinte à
cette marque. La catégorie retenue est donc l'avant-dernier.

Les slugs varient selon la page (`584-hauts-et-t-shirts` sur une fiche,
`584-tops-and-t-shirts` sur la page catégorie) ; seul l'identifiant numérique compte,
les deux URLs mènent au même catalogue.

Ancre : les `itemprop` schema.org, avec `ul.breadcrumbs` en repli.

### Le nombre de favoris n'est pas dans le DOM de la fiche

`[data-testid="favourite-button"]` y arrive `disabled`, sans compteur ni libellé :
Vinted l'hydrate côté client. Le nombre est en revanche rendu côté serveur, dans le flux
React Server Components :

```js
self.__next_f.push([1,"…{\"name\":\"favourite\",…,\"data\":{\"item_id\":9497504182,
  \"seller_id\":286459945,\"favourite_count\":1,\"is_favourite\":false}…"])
```

`favouriteCountFromHydration()` le lit par expression régulière, bornée à l'objet
courant (`[^}]`) pour ne pas rattacher à l'article le compteur d'une carte « articles
similaires ». Le bouton hydraté reste prioritaire quand il porte le nombre.
`refresh-fixtures` conserve le plus petit script portant un compteur chiffré, ce qui
garde cette voie sous test.

### Les photos : trois sources, une seule qui donne la pleine résolution

| Source                            | Photos                     | Résolution max   |
| --------------------------------- | -------------------------- | ---------------- |
| Flux RSC, bloc `"name":"gallery"` | toutes, ordonnées          | **1200×1600**    |
| DOM `item-photo-{N}--img`         | toutes, mais dupliquées ×5 | 600×800 (`f800`) |
| JSON-LD `image`                   | la principale seulement    | 600×800          |

Les trois sont dans le HTML **servi** : la galerie se remplit aussi bien sur la page
ouverte que sur le document `fetch()` de l'enrichissement. Le JSON-LD expose une chaîne,
jamais un tableau — même sur une fiche à trois photos.

Le bloc du flux porte son nom et l'article qu'il décrit :

```js
{"name":"gallery","type":"gallery","section":"content",
 "data":{"item_id":9504133342,"seller_id":148532183,"photos":[
   {"image_no":1,"width":600,"height":800,"dominant_color":"#CD98C1",
    "url":"…/t/<hash>/f800/1785153571.webp?s=aff1c5…",
    "full_size_url":"…/tc/<hash>/1785153571.webp?s=f6eb46…",
    "thumbnails":[{"type":"thumb310x430","url":"…"},…],
    "is_hidden":false,"is_suspicious":false}]}}
```

**Les URLs sont signées, et la signature est liée à l'URL exacte.** Réécrire `f800` en
`310x430` pour obtenir une miniature répond 404 : chaque taille se prend telle qu'elle
est livrée, jamais fabriquée. `full_size_url` (chemin `/tc/`, sans segment de taille)
est l'original ; c'est la seule raison de préférer le flux au DOM.

Trois pièges, tous vérifiés sur une fiche réelle :

- **le DOM rend le carrousel cinq fois** (bureau, mobile, bande de miniatures) : une
  fiche à trois photos y expose quinze `<img>`. Le `data-testid` porte le numéro, il
  sert de clé de dédoublonnage et d'ordre ;
- **le tableau n'est pas forcément dans l'ordre d'affichage** : `image_no` fait foi ;
- **`item_id` doit être vérifié.** Aujourd'hui la page servie ne contient que l'article
  affiché, mais le dressing du membre et les articles similaires réutilisent la même
  structure : le jour où Vinted les rendra côté serveur, une galerie sans contrôle
  mélangerait les photos de deux articles. Même précaution que pour le compteur de
  favoris.

`extractPhotos()` prend le flux d'abord, le DOM en repli. Le [Diagnostic](diagnostic.md)
compte les deux séparément.

### Les blocs d'articles de la fiche renomment leurs cartes

Sous la fiche, « Dressing du membre » et « Articles similaires » réutilisent la carte du
catalogue — mais **`product-item-id-{ID}` n'en est que le nom par défaut**. Chaque bloc
passe à ses cartes son propre préfixe, celui du plugin :

| Bloc                | Conteneur                           | Carte                   |
| ------------------- | ----------------------------------- | ----------------------- |
| Dressing du membre  | `item-page-other_user_items-plugin` | `other_user_items-{ID}` |
| Articles similaires | `item-page-similar_items-plugin`    | `similar_items-{ID}`    |

Le reste ne bouge pas : les métadonnées gardent les mêmes suffixes (`--overlay-link`,
`--price-text`…), le `--` restant le séparateur.

`blockCards()` **dérive donc le préfixe du conteneur** (`item-page-(…)-plugin`) au lieu
d'énumérer les plugins connus : Vinted en ajoute, et un bloc de plus doit marcher sans
toucher au code. Deux voisins portent ce préfixe sans être des cartes —
`{plugin}-items`, `{plugin}-plugin-empty-state` — et sont écartés par l'absence
d'identifiant numérique final (`cardId()`).

Deux conséquences pour l'extraction :

- **rien de tout cela n'est dans le HTML servi.** Vinted rend un squelette
  (`item-feed-loader`) et charge les articles par requête à l'approche du bloc : seul le
  `MutationObserver` les voit arriver, et `refresh-fixtures` ne peut pas les capturer
  par simple requête HTTP — d'où `appendItemBlock()` côté tests ;
- **le fil d'Ariane ne les concerne pas.** Sur une fiche il décrit l'article affiché ;
  une carte du dressing relève d'un tout autre rayon. On enregistre donc
  `category: null` pour les cartes d'une fiche, et l'enrichissement remplit la vraie
  catégorie depuis la fiche de l'article.

## Modale d'offre

⚠️ **Ancres non vérifiées en production** — ce sont des candidats plausibles, pas des
relevés. Lancer le [Diagnostic](diagnostic.md) sur une fiche article pour confirmer, et
ajuster `ANCHORS` dans `offer-agent.ts`.

L'agent essaie plusieurs candidats par étape, du plus stable au plus permissif :

| Étape          | Candidats                                                                                      |
| -------------- | ---------------------------------------------------------------------------------------------- |
| Bouton d'offre | `item-make-offer-button` → `*make-offer*` → libellé « faire une offre » / « proposer un prix » |
| Modale         | `offer-modal` → `[role="dialog"]` **contenant un champ de saisie**                             |
| Champ prix     | `offer-price-input` → `input[inputmode="decimal"]` → `input[type="number"]`                    |
| Validation     | `offer-modal-submit-button` → `button[type="submit"]` → libellé « envoyer » / « proposer »     |

Deux règles qui évitent les faux positifs :

- une modale **sans champ de saisie** est considérée comme encore en ouverture, pas
  comme la bonne modale — sinon l'agent tape dans le vide ;
- la saisie passe par le **setter natif** de `HTMLInputElement.prototype.value` suivi
  d'un événement `input`. Écrire `field.value = …` est silencieusement ignoré par React,
  qui conserve son état interne : le bouton d'envoi reste alors désactivé sans qu'aucune
  erreur n'apparaisse.

## URL de recherche du catalogue

`src/sidepanel/search.ts` construit deux URLs de catalogue : « article similaire »
(marque, taille, catégorie, prix, bons états) et « explorer la marque » (marque et
catégorie seules). Les paramètres utiles, tous vérifiés sur `vinted.fr` :

| Paramètre                 | Rôle            | Remarque                                  |
| ------------------------- | --------------- | ----------------------------------------- |
| `search_text`             | recherche libre | seul repli quand on n'a pas d'identifiant |
| `catalog[]`               | catégorie       | l'`id` de `item.category`                 |
| `brand_ids[]`             | marque          | identifiant, jamais le nom                |
| `size_ids[]`              | taille          | identifiant, jamais le libellé            |
| `status_ids[]`            | état            | répétable, voir table ci-dessous          |
| `price_from` / `price_to` | fourchette      | à accompagner de `currency=EUR`           |

**Les filtres n'acceptent que des identifiants numériques.** Passer « Nike » à
`brand_ids[]` ne filtre rien. Comme les favoris ne stockent que des libellés, marque et
taille transitent aujourd'hui par `search_text` — c'est approximatif : « 42 » remonte
aussi bien une pointure qu'un tour de taille. Stocker `brandId` et `sizeId` à
l'extraction rendrait le filtrage exact ; `search.ts` les utilise déjà s'ils existent.

### Identifiants d'état

Relevés sur `/api/v2/statuses`, qui répond en JSON sans session :

| id  | Libellé                              |
| --- | ------------------------------------ |
| 6   | Neuf avec étiquette                  |
| 1   | Neuf sans étiquette                  |
| 2   | Très bon état                        |
| 3   | Bon état                             |
| 4   | Satisfaisant                         |
| 7   | Certaines pièces ne fonctionnent pas |

La numérotation n'est pas ordonnée par qualité : **l'ordre d'affichage vit dans le champ
`order`**, pas dans l'`id`. Ne pas déduire une échelle des identifiants.

Pour revérifier, depuis n'importe quelle page Vinted :

```js
await (await fetch('/api/v2/statuses')).json();
```

## Ce qui reste accessible sans connexion

Les pages de recherche et de fiche article sont **rendues côté serveur** et lisibles
sans session. C'est ce qui permet à `pnpm refresh-fixtures` de régénérer les fixtures de
test par simple requête HTTP, et c'est ainsi que les ancres ci-dessus ont été relevées
plutôt que devinées.

## Quand Vinted casse quelque chose

1. `ppnpm test` — la suite d'extraction est la première à rougir
2. `pnpm refresh-fixtures` puis relancer : si c'est vert, seules les fixtures étaient
   périmées
3. si c'est toujours rouge, les ancres ont changé → lancer le
   [Diagnostic](diagnostic.md) sur une vraie page pour voir ce qui existe désormais,
   puis mettre à jour `content.ts`
