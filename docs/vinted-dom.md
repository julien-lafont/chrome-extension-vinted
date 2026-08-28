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
(`/brand/53-nike`) : on l'écarte de la catégorie, une recherche relancée depuis là
serait restreinte à cette marque. La catégorie retenue est donc l'avant-dernier.

Ce maillon écarté n'est pas jeté pour autant : c'est la **seule occurrence en clair de
l'identifiant de marque dans le DOM servi**, et sans lui le catalogue ne sait pas
filtrer par marque (`brand_ids[]` n'accepte pas de nom). `brandIdFromBreadcrumb()` en
tire le `53`, le flux d'hydratation servant de repli quand l'article n'a pas de maillon
de marque.

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

`hydrationNumbers()` (`src/shared/hydration.ts`) le lit par expression régulière, bornée
à l'objet courant (`[^}]`) pour ne pas rattacher à l'article le compteur d'une carte «
articles similaires ». Le bouton hydraté reste prioritaire quand il porte le nombre.
`refresh-fixtures` conserve le plus petit script portant un compteur chiffré, ce qui
garde cette voie sous test.

La même fonction sert de repli à deux autres identifiants, dans un bloc voisin du même
flux — d'où la lecture en **une seule passe** sur les ~240 scripts de la page :

```js
self.__next_f.push([1,"…{\"name\":\"breadcrumbs\",…,\"data\":{\"item_id\":9497504182,
  \"brand_id\":53,\"catalog_id\":584,\"breadcrumbs\":[…]}…"])
```

### Le vendeur : un lien et un pseudo

Deux ancres complémentaires, toutes deux rendues côté serveur :

```html
<a href="/member/3165663897">
  … <span data-testid="profile-username">emma07297</span>
</a>
```

L'identifiant vient du **lien**, seul à porter le nombre ; le pseudo du `data-testid`,
seul endroit où il est isolé du reste de la cellule (avatar, note, évaluations). Le
motif exige des chiffres après `/member/`, ce qui écarte les `/member/signup/…` que la
page porte aussi. Repli : `seller_id` dans le flux d'hydratation, présent dans les blocs
`gallery`, `favourite` et `report`.

### La note et le nombre d'évaluations : le flux d'abord

La même cellule porte la réputation, mais **sans aucun `data-testid`** :

```html
<div
  class="web_ui__Rating__rating"
  role="group"
  aria-label="Le membre est noté 4.7 sur 5"
>
  …cinq étoiles…
  <div class="web_ui__Rating__label"><span>39</span></div>
</div>
```

C'est le seul endroit du projet où le flux d'hydratation est la source **préférée** et
le DOM le repli. Le bloc `user_info_header` nomme les deux valeurs, et ne dépend ni de
la langue ni d'une classe :

```js
{"name":"user_info_header","section":"sidebar","data":{"item_id":9508569835,
  "seller_id":237208752,"name":"ramikljk","feedback_count":4,
  "feedback_reputation":0.8,"badges":[],"business":false}}
```

Trois relevés qui comptent :

- **`feedback_reputation` est entre 0 et 1**, pas sur 5 : `0.8` vaut 4 étoiles. Le motif
  d'`hydrationNumbers()` accepte donc les décimales — sans quoi il lirait « 0 », une
  note nulle silencieusement fausse ;
- le flux rend parfois `0.9400000000000001`, que Vinted affiche « 4.7 » : les deux voies
  doivent arrondir pareil, d'où `ratingFromReputation()` ;
- **le compteur du DOM est le dernier enfant du groupe**, atteint par sa position et non
  par sa classe `web_ui__Rating__label` — la règle 4 vaut aussi pour les classes que
  Vinted n'obfusque pas (encore).

L'`aria-label` reste le repli de la note parce qu'il n'est pas une classe ; il est en
revanche **traduit**, et le motif ne s'accroche donc qu'au nombre et à son séparateur.

### Le pays du vendeur n'est pas sur la fiche — du tout

Vérifié le 28/07/2026 sur quatre fiches : dans les 2,3 Mo servis, les seules occurrences
de `country_code` sont des chaînes de traduction. Ni le DOM, ni le JSON-LD, ni le flux
ne portent le pays du vendeur. C'est la seule information de l'extension qui exige une
**seconde page**.

### La taille en identifiant n'est nulle part dans la page

Le HTML servi ne contient **aucun `size_id`** — ni dans le DOM (`itemprop="size"` ne
porte que le libellé, « S »), ni dans le flux d'hydratation (vérifié le 27/07/2026 sur
une fiche complète : la seule occurrence du terme est un nom de feature flag). Ni la
fiche, ni la carte, ni l'API `catalog/items`, qui n'expose qu'un `size_title`.

Il se **résout** en revanche par la table des tailles de la catégorie, ci-dessous.

### La table des tailles d'une catégorie

Seule requête d'API du projet, et seul endroit où l'identifiant d'une taille se trouve :

```
GET /api/v2/size_groups?catalog_ids=584
{ "size_groups": [ { "description": "Tailles hommes",
                     "sizes": [ { "id": 208, "title": "M" }, … ] } ] }
```

Trois relevés font tenir `shared/size-ids.ts`, et sont à refaire si la résolution casse
:

1. **`catalog_ids`, au pluriel.** Au singulier (`catalog_id`), le paramètre est
   silencieusement ignoré : l'API rend les 51 groupes du site, où « M » vaut aussi bien
   208 (vêtements homme) que 1390 (chapeaux) ou 1426 (gants). Le pluriel restreint la
   réponse aux groupes de la catégorie — un seul, le plus souvent.
2. **Le libellé de la fiche est celui de l'API, au caractère près**, titres composés
   compris (« S / 36 / 8 »). Vérifié en comparant `itemprop="size"` au `title` de l'API
   sur deux catégories : aucune normalisation n'est nécessaire, et aucune ne doit être
   ajoutée sans refaire la comparaison.
3. **Une catégorie feuille n'a pas de collision** ; une catégorie large en a. D'où les
   deux conditions de la résolution : `category.exact`, et un libellé qui ne porte qu'un
   identifiant.

L'API répond **403 sans cookies** : l'appel n'a donc lieu que depuis le content script,
où il est same-origin. Le filtre correspondant a été vérifié sur le catalogue web —
`?catalog[]=584&size_ids[]=210` ne rend que des XL.

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

## Page profil `/member/{id}`

Lue par `fetch()` uniquement, jamais injectée, et pour une seule chose : le pays.

```js
"expose_location":true,"city":"Bad Soden am Taunus","city_id":812,"country_code":"DE"
```

```html
<div data-testid="profile-location-info">
  …
  <div data-testid="profile-location-info--content">Cenon, France</div>
</div>
```

Le flux passe devant ici aussi, mais pour une autre raison qu'au-dessus : il donne le
**code ISO**, la forme que le storage retient, là où le DOM affiche le nom traduit qu'il
faut reconvertir (« Tchéquie » selon `Intl`, peut-être « République tchèque » selon
Vinted — le repli ne reconnaît alors pas le pays, et c'est assumé).

Le pays n'est retenu que si la page n'en désigne **qu'un seul** : mieux vaut aucun
drapeau qu'un drapeau faux, même précaution que pour les photos et le compteur de
favoris.

Ce qui figure aussi sur cette page, et qu'on ne lit pas : `positive_feedback_count`,
`item_count`, `followers_count`, `last_loged_on_ts`. En revanche **l'ancienneté du
compte n'y est pas** — aucun `created_at` dans le HTML servi, sur les deux profils
relevés.

## API des conversations : les offres

Relevé le 29/07/2026 sur un compte réel (55 conversations). **Aucune page ne porte
l'information** : sur une fiche dont l'offre est en attente, les 15 occurrences de
`offer` dans les 2,6 Mo servis sont des chaînes de traduction
(`"conversation.offer_request.accept": "Accepter l'offre"`). L'API est la seule voie, et
elle exige la session — d'où un appel depuis le content script, comme `size_groups`.

| Requête                                | Ce qu'elle donne                                               |
| -------------------------------------- | -------------------------------------------------------------- |
| `GET /api/v2/users/current`            | `user.id` — sans lui, offre faite et offre reçue se confondent |
| `GET /api/v2/inbox?page=N&per_page=20` | `conversations[]` : `id` et `updated_at`, **rien de plus**     |
| `GET /api/v2/conversations/{id}`       | `transaction` (article, côté) et `messages` (offres)           |

`/api/v2/conversations?page=…` répond **404** malgré la symétrie des noms : la liste,
c'est `/api/v2/inbox`.

Deux entités portent un prix, et ne se lisent pas pareil :

| `entity_type`           | Qui                        | Statut                                  |
| ----------------------- | -------------------------- | --------------------------------------- |
| `offer_request_message` | l'acheteur propose un prix | `entity.status` : 10, 20, 30, 40        |
| `offer_message`         | le vendeur fixe un prix    | **aucun** — se déduit de la transaction |

Les codes valent en attente (10), acceptée (20), refusée (30), annulée (40).
`status_title` les double en clair mais il est **traduit** : la règle 4 vaut aussi pour
l'API. Quatre pièges, tous constatés :

- **`created_at_ts` est la date d'envoi de l'offre**, même si l'entité s'intitule «
  Rappel : tu as fait une offre à ce membre » (conversation 21639250773 : offre le
  31/03, conversation mise à jour le 15/04) ;
- **`transaction.item_id` est `null` avant avril 2026** ; seul `item_ids[]` est rempli ;
- **`current: true` vaut par auteur**, pas par conversation : les deux côtés peuvent
  avoir chacun leur message courant ;
- **`current_user_side`** (`buyer`/`seller`) distingue ce qu'on achète de ce qu'on vend,
  avec `buyer_id` en repli sur les conversations anciennes.

Voir `src/shared/offers.ts` et `docs/specs/offres.md`.

## API des favoris : lire, et écrire

Relevé le 25/08/2026 sur un compte réel. C'est le **seul endroit où l'extension écrit
chez Vinted**, et seulement quand « Sync favoris » est allumé — voir
`docs/specs/favoris-sync.md`.

### Le cœur, dans la page

Le même composant partout, avec un `aria-pressed` qui porte l'état :

```html
<button
  aria-pressed="false"
  aria-label="Ajouter aux favoris, ajouté aux favoris par 37 utilisateurs"
  data-testid="feed-item--favourite"
></button>
```

| Contexte                      | Ancre du bouton                               |
| ----------------------------- | --------------------------------------------- |
| Catalogue, recherche          | `product-item-id-{ID}--favourite`             |
| Fil de la page d'accueil      | `feed-item--favourite` — **sans identifiant** |
| Dressing, articles similaires | `{plugin}-{ID}--favourite`                    |
| Fiche article                 | `favourite-button`                            |

`aria-pressed` est la seule source d'état qui ne dépende ni de la langue (l'`aria-label`
est traduit) ni d'une classe (la couleur de l'icône vit dans
`web_ui__Icon__greyscale-level-2`, ce que la règle 4 interdit de lire). **Absent ≠
`false`** : sur la fiche, le bouton arrive `disabled` et nu, Vinted l'hydrate ensuite.
Le lire comme un « pas en favori » ferait constater le retrait de tous les favoris à
chaque chargement de page — voir `readFavouriteState()`.

Le fil d'accueil ne porte l'identifiant nulle part dans le testid, exactement comme sa
carte : `favouriteTargetId()` remonte donc à la carte (le testid du bouton privé de
`--favourite`) et laisse `cardId()` trancher.

### Le cœur rouge : quatre différences, une seule à lire

Un article en favori change bien plus que son `aria-pressed` :

```html
<button
  aria-pressed="true"
  aria-label="Supprimer des favoris, ajouté aux favoris par 36 utilisateurs"
  …
>
  <span
    class="web_ui__Icon__icon web_ui__Icon__warning-default"
    data-testid="favourite-filled-icon"
  >
    <svg><path d="M4.74 1.25c-.766 0-1.584.21-2.402.735…" /></svg> ← cœur plein
  </span>
  <span data-testid="favourite-count-text">36</span>
</button>
<span aria-live="polite" class="u-visually-hidden">Ajouté ! </span>
```

| Vide                              | Plein                                 |
| --------------------------------- | ------------------------------------- |
| `aria-pressed="false"`            | `aria-pressed="true"`                 |
| « Ajouter aux favoris, … »        | « Supprimer des favoris, … »          |
| `data-testid="favourite-icon"`    | `data-testid="favourite-filled-icon"` |
| `web_ui__Icon__greyscale-level-2` | `web_ui__Icon__warning-default`       |
| tracé du cœur ouvert              | tracé du cœur plein                   |

**On ne lit que le premier, et on n'écrit aucun des cinq.** Le libellé est traduit, la
classe est interdite par la règle 4, et repeindre l'icône soi-même reviendrait à
réimplémenter le rendu de Vinted — que son prochain rendu React écraserait. Pour faire
rougir un cœur, on clique **son** bouton : `setHeart()` dans `content/fav-sync.ts`.
Vinted fait alors sa requête, avec son propre jeton, et repeint les cinq. Ce n'est
possible que là où la carte est à l'écran ; ailleurs, il faut l'API ci-dessous.

Le bouton est une **bascule** : on ne le clique donc jamais sans avoir comparé
`aria-pressed` à l'état voulu, sous peine de retirer le favori qu'on venait poser.

### Les deux en-têtes obligatoires

```
x-anon-id:     0b9ffca0-…      le cookie `anon_id`, tel quel
x-csrf-token:  75f6c9fa-…      un UUID qui n'est dans aucun cookie
```

Sans `x-csrf-token`, l'API répond **403** (vérifié). Il n'y a **pas de balise `<meta>`**
: le token vit dans un script de la page, au milieu d'un bloc de configuration sérialisé
en JSON dans une chaîne JavaScript — les guillemets y sont donc échappés :

```js
…\"RELEASE_VERSION\":\"4dd8bbe…\",\"NEXT_JS\":\"true\",
  \"CSRF_TOKEN\":\"75f6c9fa-dc8e-4e52-a000-e09dd4084b3e\",\"NODE_ENV\":…
```

Le motif de lecture doit accepter les deux formes (échappée et non échappée) : rien ne
garantit que Vinted continue de le sérialiser ainsi.

### Poser ou retirer un favori : une bascule

```
POST /api/v2/user_favourites/toggle
content-type: application/json
{"type":"item","user_favourites":[9778177557]}
→ {"code":0,"message":"Ok","message_code":"ok"}
```

**La requête d'ajout et celle de retrait sont identiques**, corps compris : c'est l'état
courant du compte qui décide du sens, et la réponse ne dit pas lequel a été pris.
Émettre cet appel sans connaître l'état réel, c'est une chance sur deux d'inverser ce
qu'on voulait faire. D'où la lecture préalable ci-dessous, qui n'est pas un confort mais
la condition de correction.

### Lire la liste des favoris

```
GET /api/v2/users/{userId}/items/favourites?page=1&per_page=20
{ "items": [ { "id": 9475489079, "is_favourite": true, … } ],
  "pagination": { "current_page": 1, "total_pages": 5,
                  "total_entries": 100, "per_page": 20 } }
```

`userId` vient de `/api/v2/users/current`, que le balayage des offres lit et met déjà en
cache (`OffersScanState.userId`) — rien à redemander.

`pagination.total_pages` fait foi : demander un `per_page` plus grand que ce que Vinted
accepte n'échoue pas, il est simplement ramené à sa valeur, et la pagination s'ajuste
d'elle-même.

Chaque entrée porte bien plus que l'identifiant (prix, photos, vendeur, taille) — c'est
le même objet que l'API du catalogue. On n'en lit que `id` : la liste sert à savoir **ce
qui est en favori**, pas à enrichir des articles, dont la fiche reste la seule source de
vérité.

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
`brand_ids[]` ne filtre rien.

| Critère   | Filtrage | D'où vient l'identifiant                           |
| --------- | -------- | -------------------------------------------------- |
| Catégorie | exact    | fil d'Ariane (`/catalog/584-…`)                    |
| Marque    | exact    | maillon de marque du fil, flux en repli            |
| Taille    | exact    | résolue par `/api/v2/size_groups` — voir plus haut |

`search_text` n'est donc qu'un repli : fiche jamais lue, marque non référencée par
Vinted, ou taille non résolue (voir [limitations.md](limitations.md)).

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
