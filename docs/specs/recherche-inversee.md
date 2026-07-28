# Recherche inversée par image — spécification

> Spécification du 28 juillet 2026, sur la base du code de la v0.3.
>
> Répond au point **O** de `docs/audit/analyse-utilisateur.md` (effort S). Le document
> fixe le module, la cascade de repli, l'UI et le protocole de vérification préalable.
> Il ne décrit pas l'implémentation ligne à ligne.

## Le besoin, en une phrase

Deux des trois questions du chineur débordent du seul Vinted — « est-ce que c'est une
affaire ? » ne se compare aujourd'hui qu'au marché Vinted, « est-ce que c'est
authentique ? » n'a aucune réponse outillée — alors qu'une pièce correctement
photographiée se retrouve souvent ailleurs : même annonce republiée sur Leboncoin, photo
de catalogue officiel de la marque, ou revente identique chez un autre vendeur.

## 1. Ce que la fonctionnalité n'est pas

**Aucun verdict.** L'extension ne compare rien, ne note rien, ne dit ni « authentique »
ni « surpayé ». Elle construit une URL et ouvre un onglet ; tout le reste — lire les
résultats, en tirer une conclusion — se passe dans la tête de l'utilisateur. C'est
exactement le contrat de `similarSearchUrl()` et `brandSearchUrl()`, transposé hors de
Vinted.

Cette limite n'est pas une prudence de rédaction, c'est une contrainte d'implémentation.
Sont **hors périmètre**, définitivement et pas « pour plus tard » :

- tout `fetch()` vers Google ou vers un autre marché depuis l'extension ;
- toute lecture, analyse ou stockage des résultats de la recherche ;
- tout appel automatique — la recherche part d'un clic, jamais d'un cycle de veille,
  jamais d'un enregistrement d'article.

Le jour où quelqu'un voudra « juste récupérer le premier résultat pour afficher une
pastille », c'est le scoring IA écarté en §6 de l'audit qui rentre par la fenêtre : la
revue doit le refuser.

## 2. Ce qui sort du navigateur, et ce qu'on en dit

`CLAUDE.md` et le README annoncent que rien ne sort du navigateur. Ouvrir un lien Google
Lens transmet à Google l'URL de la photo, donc son contenu — et l'URL contient
l'identifiant CDN de l'article. La phrase doit donc être nuancée, pas maintenue telle
quelle.

Ce qui reste vrai, et qui est le vrai principe :

- **aucune donnée n'est stockée hors du navigateur** — le storage reste local ;
- **rien ne part à l'insu de l'utilisateur** — un clic explicite, ponctuel, sur un
  article précis ;
- **rien n'est envoyé en tâche de fond** — pas de préchargement, pas de veille.

Sur le fond, c'est le régime de `similarSearchUrl()`, qui interroge déjà Vinted à la
demande. La différence tient au destinataire : Google, pas Vinted. Elle mérite d'être
dite dans la documentation — d'où la mise à jour au §8 — mais n'appelle aucun geste de
confirmation supplémentaire : le clic sur le bouton est lui-même l'action explicite et
ponctuelle, exactement comme pour `similarSearchUrl()`.

## 3. Modèle de données

**Aucun champ nouveau, ni sur `SavedItem` ni sur `Settings`, aucune migration.** Tout ce
qu'il faut est déjà capturé par `images` (`ItemPhoto[]`), `brand`, `title`, `size`. Le
bouton ouvre l'onglet directement au clic, sans état à retenir entre deux usages.

**Pas de repli sur `imageUrl`.** C'est le seul champ de `SavedItem` qui existe sur tout
article, y compris ceux enregistrés avant la 0.3 — mais l'admettre ici reviendrait à
maintenir une compatibilité que cette fonctionnalité n'a aucune raison de porter :
`imageUrl` vient parfois d'une simple miniature de carte de catalogue (310×430), une
qualité insuffisante pour une reconnaissance fiable, et l'exploiter ajouterait une
branche entière (validation d'hôte sur une source non prévue à cet usage) pour un gain
marginal. La cascade ne porte que sur `images` ; son absence bascule directement sur le
repli texte (§4.2), qui reste toujours disponible.

### 3.1 Quelle photo, et pourquoi

Cascade, du meilleur au moins bon :

| Rang | Source           | Taille    | Présent quand                   |
| ---- | ---------------- | --------- | ------------------------------- |
| 1    | `images[0].url`  | 600×800   | fiche lue (`images` renseigné)  |
| 2    | `images[0].full` | 1200×1600 | idem, si `url` manque à l'appel |
| —    | aucune           |           | repli texte (§4.2)              |

`url` avant `full` : Lens redimensionne l'image de son côté, 600×800 suffit largement à
la reconnaissance, et c'est ~4× moins lourd à télécharger pour Google comme pour le CDN
Vinted. `full` ne sert que de filet si un jour `url` venait à manquer.

**Les URLs sont transmises telles quelles, jamais réécrites.** Le `?s=…` final est une
signature liée à l'URL exacte : changer le segment de taille produit un 404
(`docs/vinted-dom.md`, et le commentaire de `ItemPhoto`). `URLSearchParams` encode la
signature correctement en paramètre `url=` — c'est le seul encodage à faire.

### 3.2 Ce qui vaut « photo exploitable »

Une URL n'est retenue que si elle est absolue, en `https:`, et hébergée par un domaine
Vinted connu :

```ts
/** Hôtes CDN acceptés. Le storage vient de pages tierces : on ne transmet à Google
 *  que des URLs dont on sait d'où elles sortent. */
const PHOTO_HOSTS = ['vinted.net', 'vinted.fr', 'vinted.com'] as const;
```

Une URL qui échoue à ce test — hôte inconnu, schéma `http:`, chemin relatif — ne compte
pas comme photo exploitable, et on retombe sur la recherche texte.

Contrepartie assumée : si Vinted change de CDN, la recherche image bascule sur le texte
pour tous les articles à la fois. Ce n'est pas silencieux pour autant — le `title` du
bouton l'annonce article par article (§6.1), et c'est le bon endroit : `diagnose()` vit
dans le content script, qui ne lit pas les favoris et n'a rien à dire ici.

## 4. Le module

Nouveau fichier `src/sidepanel/elsewhere.ts`, jumeau de `search.ts` : que des fonctions
pures, aucun accès au DOM, aucun accès au storage, aucun `fetch`.

```ts
/** Une destination possible, prête à ouvrir. */
export type ElsewhereSearch = {
  kind: 'lens' | 'text';
  url: string;
  /** Libellé du bouton et du menu. */
  label: string;
};

/** Destinations disponibles pour un article, la meilleure en tête. Jamais vide. */
export function elsewhereSearches(item: SavedItem): ElsewhereSearch[];

/** URL Google Lens pour une photo donnée. Exportée pour le test. */
export function lensUrl(photoUrl: string): string;

/** Requête texte de repli : marque + titre + taille, dédoublonnés. */
export function textQuery(item: SavedItem): string;
```

`elsewhereSearches()` renvoie toujours au moins la recherche texte : le panneau n'a
jamais à traiter un cas vide, et le bouton n'est jamais désactivé (piège n°4 de
l'audit). La liste est ordonnée pour que `[0]` soit l'action du clic simple, et le reste
alimente le menu évoqué au §6.4.

### 4.1 Lens

```ts
const LENS = 'https://lens.google.com/uploadbyurl';

export function lensUrl(photoUrl: string): string {
  const url = new URL(LENS);
  url.searchParams.set('url', photoUrl);
  return url.toString();
}
```

Rien de plus : pas de `hl`, pas de `ep`, pas de paramètre de session. Chaque paramètre
supplémentaire est une occasion de casser le jour où Google change son endpoint, pour un
bénéfice nul — l'interface de Lens suit déjà la langue du compte.

### 4.2 Le repli texte

```
https://www.google.com/search?q=<marque> <titre> <taille>
```

Recherche web ordinaire, pas `tbm=isch` : ce qu'on cherche ici, c'est une autre annonce
ou une fiche produit, pas une planche d'images.

Trois règles de construction, toutes motivées par du bruit observable :

1. **La marque d'abord**, puis le titre. Un titre Vinted commence rarement par la
   marque, et Google pondère l'ordre.
2. **Pas de doublon** : les mots du titre déjà présents dans la marque sont retirés
   (comparaison insensible à la casse et aux accents — `title.normalize('NFD')`, comme
   ailleurs dans le projet). « Nike » + « Nike Air Zoom » ne doit pas donner « Nike Nike
   Air Zoom ».
3. **La taille seulement si elle informe** : au moins deux caractères, et absente du
   titre. « M » ou « 42 » isolé dans une recherche web ne fait qu'ajouter du bruit,
   alors que « 42 EU » ou « W32 L34 » resserre.

Si l'article n'a ni marque, ni titre, ni taille — cas théorique, un favori a toujours un
titre — la requête retombe sur `item.title || item.id`, et l'URL reste valide.

## 5. Ouverture

Dans `sidepanel.ts`, à côté du gestionnaire de `.item-similar` :

```ts
within(node, '.item-elsewhere').addEventListener('click', () => {
  void openElsewhere(item);
});
```

`openElsewhere()` ne fait qu'une chose :
`chrome.tabs.create({ url: elsewhereSearches(item)[0].url, active: true })`. Aucune
permission nouvelle au manifeste — `chrome.tabs.create` n'en exige pas, et
`host_permissions` reste sur `https://www.vinted.fr/*`. Rien à déclarer pour
lens.google.com : on ouvre un onglet, on ne l'observe pas.

## 6. Interface

### 6.1 Le bouton

Cinquième `.icon-btn` de `.item-actions`, **placé juste après `.item-similar`** : les
deux recherches se lisent ensemble, l'une sur Vinted, l'autre ailleurs.

```html
<button type="button" class="icon-btn item-elsewhere">
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <!-- Cadre de visée + cible : le vocabulaire de la recherche par image,
         distinct de la loupe du bouton « similaires ». -->
    <path d="M3 8V5a2 2 0 0 1 2-2h3" />
    <path d="M16 3h3a2 2 0 0 1 2 2v3" />
    <path d="M21 16v3a2 2 0 0 1-2 2h-3" />
    <path d="M8 21H5a2 2 0 0 1-2-2v-3" />
    <circle cx="12" cy="12" r="3.2" />
  </svg>
</button>
```

Le `title` est posé au rendu, parce qu'il dépend de ce qu'on a :

| Cas         | `title`                                                    |
| ----------- | ---------------------------------------------------------- |
| photo       | « Rechercher cette photo sur Google Lens »                 |
| repli texte | « Rechercher ce modèle sur Google (pas de photo lisible) » |

Le second dit **pourquoi** le comportement diffère : c'est le piège n°4 de l'audit
retourné en information, plutôt qu'un bouton désactivé sans explication.

### 6.2 La grille, sans agrandir la carte

`.item-actions` est une grille de 2 colonnes ; un cinquième bouton la fait passer à
trois lignes. À 26 px, cela donne 82 px de haut contre 76 px pour la miniature : toute
la liste grandirait de 6 px par article.

Correctif en deux lignes de CSS, **scopé à la barre d'actions** — `.icon-btn` sert aussi
au bouton « Fermer » de la galerie, qui ne doit pas rétrécir :

```css
.item-actions {
  grid-template-columns: repeat(2, 24px);
}

/* 3 lignes de 24 px + 2 gouttières = 76 px, la hauteur exacte de la miniature :
   la cinquième action n'allonge pas la liste. */
.item-actions .icon-btn {
  width: 24px;
  height: 24px;
}
```

Disposition obtenue : `similar` / `elsewhere`, `offer` / `move`, `remove` / vide.

L'icône reste à 15 px dans un bouton de 24 px — la cible de clic passe de 26 à 24 px, au
seuil du confortable mais dans la norme du panneau (`.item-drag` fait 18 px de large).
Si le rendu réel déçoit, le repli est d'accepter les 82 px : c'est un arbitrage
esthétique, pas une contrainte technique.

### 6.3 Rappels de rendu

Le panneau n'est pas le content script — pas de `MutationObserver`, donc pas de risque
de boucle de repeint. Restent les règles qui s'appliquent partout : `user-select: none`
et `pointer-events: none` sur les enfants sont déjà portés par `.icon-btn`, et le
nouveau SVG hérite du même traitement. **Aucun `transform` au `:hover`** sur le bouton.

### 6.4 Ce qu'on ne fait pas maintenant

`elsewhereSearches()` renvoie une liste précisément pour qu'un menu — « Google Lens » /
« Recherche Google » / d'autres marchés — puisse s'y brancher plus tard, via
l'`openMenu()` déjà utilisé par `openMoveMenu()`. **Pas dans cette version** : un clic,
une action, à l'effort S. La structure de retour est le seul investissement consenti
pour la suite.

## 7. Tests

`tests/elsewhere.test.ts`, sur le modèle de `similar-search.test.ts` — fonctions pures,
`makeItem()` de `factories.ts`, relecture de l'URL produite via `new URL()` :

| Cas                                                  | Attendu                                       |
| ---------------------------------------------------- | --------------------------------------------- |
| article avec `images`                                | `kind: 'lens'`, `url=` = `images[0].url`      |
| photo signée `?s=…`                                  | signature intacte après décodage du paramètre |
| `images` absent, `imageUrl` sur `images1.vinted.net` | `kind: 'lens'` sur `imageUrl`                 |
| `imageUrl` sur un hôte inconnu                       | `kind: 'text'` — le garde-fou du §3.2 mord    |
| `imageUrl` en `http:` ou relative                    | `kind: 'text'`                                |
| aucune photo                                         | `kind: 'text'`, liste non vide                |
| marque répétée dans le titre                         | un seul « Nike » dans `q`                     |
| taille « M »                                         | absente de `q`                                |
| taille « 42 EU » hors titre                          | présente dans `q`                             |
| article sans marque ni taille                        | `q` = titre, URL valide                       |

Le test de la signature est le plus important : il verrouille le seul point où une
réécriture bien intentionnée casserait le lien sans erreur visible.

**Vérifier que ces tests peuvent échouer** (méthode de debug, point 3) : neutraliser le
filtre d'hôte doit faire rougir deux cas, retirer la déduplication un troisième.

Pas de test de rendu du panneau pour ce bouton : `sidepanel.ts` n'est pas monté en jsdom
aujourd'hui, et l'y monter pour un `addEventListener` coûterait plus que le risque
couvert. `tests/build-output.test.ts` continue de verrouiller les formats de sortie sans
modification — `elsewhere.ts` est importé par le panneau, donc bundlé en module ES.

## 8. Documentation à mettre à jour

- `CLAUDE.md` et `README` : nuancer « rien ne sort du navigateur » en renvoyant au §2.
  La formulation proposée — « le stockage est local, rien ne part sans un clic explicite
  ; la recherche externe est la seule action qui sorte du site, et elle est décrite dans
  `docs/specs/recherche-inversee.md` ».
- `docs/architecture.md` : `elsewhere.ts` dans la liste des modules du panneau.
- `docs/limitations.md` : la dépendance à un endpoint Google non documenté (§9), et la
  qualité variable du repli `imageUrl` sur les articles d'avant la 0.3.

## 9. Vérification préalable — à faire avant d'écrire le code

`https://lens.google.com/uploadbyurl?url=…` n'est pas une API publiée : c'est un
endpoint observé, que Google peut changer sans préavis, et **il n'a pas été testé avec
une URL Vinted signée**. Le vérifier coûte deux minutes et évite d'écrire un module
autour d'un lien mort.

1. Prendre une URL de photo dans une fixture (`tests/fixtures/`,
   `images1.vinted.net/t/…?s=…`).
2. L'encoder (`encodeURIComponent`), la coller derrière `uploadbyurl?url=`.
3. Ouvrir : Lens doit afficher **l'image de l'article**, pas une erreur ni une page
   d'accueil vide.
4. Recommencer avec l'URL `full` (1200×1600) : si la grande passe et pas la `f800`,
   inverser la cascade du §3.1.

Ce que le test tranche, et ce qu'on fait de chaque issue :

| Observation                             | Conséquence                                                 |
| --------------------------------------- | ----------------------------------------------------------- |
| Lens affiche l'image                    | on implémente tel quel                                      |
| Lens refuse l'URL signée                | plan B : `https://www.google.com/searchbyimage?image_url=…` |
| Les deux refusent                       | plan C : la recherche texte devient l'unique comportement   |
| Lens exige une session Google connectée | à noter dans `docs/limitations.md`, sans changer le code    |

Le plan C n'est pas un échec : marque + titre + taille sur Google reste un raccourci
réel face à la copie manuelle. Le bouton et son module ne bougent pas — seule
`elsewhereSearches()` cesse de proposer `lens`.

## 10. Ordre de mise en œuvre

1. **Vérifier Lens** (§9). Tout le reste en dépend.
2. `src/sidepanel/elsewhere.ts` + `tests/elsewhere.test.ts` — le module pur, testé seul.
3. Bouton dans `sidepanel.html`, CSS du §6.2, câblage et `title` dynamique dans
   `renderItem()`.
4. Documentation (§8), puis `pnpm check`.

L'étape 2 est indépendante du reste : si la vérification du §9 tarde, elle peut partir
en premier, `lens` restant simplement inutilisé.
