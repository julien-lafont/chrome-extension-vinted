# Filtrage du bruit dans le catalogue — spécification

> Spécification du 28 juillet 2026, sur la base du code de la v0.2.1.
>
> Répond au point **D** de `docs/audit/analyse-utilisateur.md` (« le meilleur rapport
> effort/plaisir »). Le document fixe le modèle de données, les règles de
> correspondance, l'interface des deux côtés (page Vinted et panneau) et l'ordre de mise
> en œuvre. Il ne décrit pas l'implémentation ligne à ligne.

## Le besoin, en une phrase

Le chineur rejoue les mêmes requêtes tous les jours et **rescanne à chaque fois les
mêmes résultats** : 90 % de ce qu'il voit lundi, il l'a déjà écarté dimanche. Sa mémoire
fait aujourd'hui tout le travail, et elle sature à la troisième page.

## 1. Le périmètre, posé d'emblée

Trois propriétés distinguent cette fonctionnalité de tout le reste du projet, et elles
gouvernent chaque décision qui suit.

**Aucune requête réseau.** Le filtrage ne lit que ce qui est déjà à l'écran. C'est
précisément ce qui en fait la fonctionnalité la moins chère du document : ni débit à
négocier avec Vinted, ni permission, ni cycle à planifier. Le corollaire est une
contrainte dure — un critère que la carte ne porte pas n'est pas filtrable, et on ne va
pas le chercher (§7).

**Aucun message entre panneau et content script.** Les règles vivent dans
`chrome.storage.local` ; le content script écoute déjà `chrome.storage.onChanged`. Une
marque masquée depuis le panneau disparaît des trois onglets Vinted ouverts sans qu'une
seule ligne de protocole soit écrite. Contrairement au suivi de prix, `messages.ts` ne
bouge pas.

**Rien n'est jamais supprimé.** Masquer, c'est une décision d'affichage : les règles
sont listées, réversibles une par une, et le mode révision (§4.4) rend tout visible d'un
clic. Un article écarté par erreur reste récupérable.

## 2. Modèle de données

Une **cinquième clé** dans `chrome.storage.local`, à côté de `savedItems`,
`collections`, `settings` et `watch` : `noise`.

> Le nom `filters` a été écarté : le panneau aura ses propres filtres de recherche (§3.4
> de l'audit), et deux clés homonymes dans le même storage sont une confusion garantie
> six mois plus tard. `noise` dit ce que la clé contient — le bruit qu'on ne veut plus
> voir — et pas la mécanique qui l'applique.

```ts
export type NoiseFilters = {
  /**
   * Articles écartés un par un, `id → horodatage`. Un `Record` plutôt qu'un
   * tableau : la lecture est un test d'appartenance à chaque carte de chaque
   * scan, et l'horodatage sert à l'éviction (voir NOISE_HIDDEN_MAX).
   */
  hidden: Record<string, number>;

  /**
   * Les 20 derniers écartés, avec leur titre — le seul endroit où l'on garde
   * autre chose qu'un id. C'est ce qui permet au panneau de proposer une
   * annulation tardive nommée (« Veste Zara ») plutôt qu'un id opaque, sans
   * pour autant conserver le titre des 5 000 autres.
   */
  recent: { id: string; title: string; at: number }[];

  /** `sellerId → { name }`. Le pseudo n'est stocké que pour être affiché. */
  sellers: Record<string, { name: string; at: number }>;

  /** Marques masquées, **normalisées** (§3.1). Jamais l'identifiant : voir §3.3. */
  brands: string[];

  /** Mots exclus, normalisés. */
  words: string[];
};
```

**Aucune migration.** Clé absente = aucune règle, ce qui est exactement l'état de tout
le monde aujourd'hui. Le jeu « fast fashion » n'est **jamais** posé par défaut : une
extension qui masque des marques dès l'installation, sans qu'on l'ait demandé, est une
extension qu'on croit cassée (§5.3).

Deux réglages complètent le tableau, et ils vont dans `settings`, pas dans `noise` — ce
sont des préférences d'affichage, pas des règles :

```ts
/** Mode révision : les cartes masquées sont grisées au lieu d'être retirées (§4.4). */
revealHidden: boolean;
```

### Bornes

| Constante          | Valeur | Pourquoi                                                                                                                                      |
| ------------------ | ------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `NOISE_HIDDEN_MAX` | 5 000  | ~30 octets l'entrée → 150 Ko sur les 10 Mo. Au-delà, éviction des plus anciens : un article écarté il y a deux ans est vendu depuis longtemps |
| `NOISE_RECENT_MAX` | 20     | de quoi couvrir une session de tri, pas un journal                                                                                            |
| `NOISE_RULES_MAX`  | 200    | par liste. Au-delà, le champ d'ajout refuse et le dit — 200 marques masquées, c'est un problème de méthode, pas de stockage                   |

L'éviction est **silencieuse et sans conséquence visible** : un id évincé réapparaîtra
au catalogue, où un clic le réécartera. C'est le seul endroit du projet où perdre une
donnée est acceptable, et c'est pour ça que la borne est ici plutôt qu'ailleurs.

## 3. Les règles et leur évaluation

### 3.1 Normalisation

Une seule fonction, appliquée **à l'écriture d'une règle comme à la lecture d'une
carte** — c'est la condition pour que « H&M », « h&m » et « H&M » se rencontrent :

```ts
/** Minuscules, diacritiques retirés, espaces réduits. Rien d'autre. */
export function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}
```

On ne retire **ni la ponctuation ni les caractères spéciaux** : `h&m` et `pull & bear`
sont des noms de marque Vinted, et les amputer les rendrait introuvables.

### 3.2 Correspondance des mots exclus — la règle qui décide de tout

L'exemple de l'audit contient le piège : masquer sur `« lot »` en sous-chaîne masque
`culotte`, `salopette`, `pantalon` et `philosophie`. Un filtre qui fait ça est
désinstallé le jour même.

La correspondance se fait donc **par mot entier**, sur un flux de jetons :

```ts
/**
 * Le texte de la carte, découpé sur tout ce qui n'est pas lettre ou chiffre, puis
 * rejoint par des espaces et bordé d'un espace : `" veste barbour bedale c40 "`.
 * Une règle correspond si elle apparaît **entourée d'espaces** dans ce flux.
 *
 * Le bordage permet aux règles multi-mots (`"neuf avec etiquette"`) de marcher
 * sans traitement particulier, et interdit `lot` de rencontrer `culotte`.
 */
function haystack(text: string): string {
  return ` ${normalize(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .join(' ')} `;
}
```

Le texte examiné est **le titre plus la marque** : c'est là que vivent « style », «
inspiré », « réplique », « lot », « enfant ». Pas la description — elle n'est pas sur la
carte, et aller la chercher violerait §1.

**Pas de jokers, pas d'expressions régulières.** Une règle est un mot ou une suite de
mots, point. Un champ de saisie qui accepte une regex accepte aussi `(a+)+$` et fige la
page du chineur pendant qu'il tape.

### 3.3 Correspondance des marques

Une marque se compare au libellé de la carte (`--description-title`), normalisé, et
correspond si l'un des deux est vrai :

- **égalité** : `zara` ↔ `zara` ;
- **préfixe suivi d'un espace** : la règle `zara` masque `zara kids`, `zara man`,
  `zara home`, mais pas `zarautz`.

C'est ce qui rend le jeu fast fashion utile sans avoir à énumérer les déclinaisons, et
c'est assez strict pour ne pas mordre sur une marque voisine.

**Pourquoi le libellé et non `brandId`.** La carte de catalogue ne porte **pas**
l'identifiant de marque : il ne se lit que sur la fiche, dans le maillon
`/brand/53-nike` du fil d'Ariane (`docs/vinted-dom.md`). Filtrer par identifiant
supposerait donc de charger une fiche par carte — exactement ce que §1 interdit. Le
libellé est ce que la carte affiche ; c'est aussi ce que l'utilisateur voit et désigne
quand il clique « masquer cette marque ». La conséquence assumée : deux marques
homonymes chez Vinted tomberaient ensemble. Cas rare, coût nul, réversible.

### 3.4 Précédence — et la seule exception qui compte

L'ordre d'évaluation, du plus fort au plus faible :

| #   | Test                      | Verdict    | Remarque                                                      |
| --- | ------------------------- | ---------- | ------------------------------------------------------------- |
| 1   | `savedItems[id]` existe   | `'0'`      | **jamais masqué**, quelle que soit la règle — voir ci-dessous |
| 2   | `noise.hidden[id]`        | `'item'`   | décision explicite, une par une                               |
| 3   | `noise.sellers[sellerId]` | `'seller'` | seulement si le vendeur est connu côté carte (§7)             |
| 4   | `noise.brands` correspond | `'brand'`  | §3.3                                                          |
| 5   | `noise.words` correspond  | `'word'`   | §3.2                                                          |
| —   | sinon                     | `'0'`      |                                                               |

**Un article enregistré n'est jamais masqué.** C'est la règle qui évite le pire scénario
d'usage : masquer Zara, puis ne plus retrouver au catalogue la veste Zara qu'on avait
mise de côté la semaine d'avant, sans comprendre pourquoi. L'enregistrement est une
décision individuelle, il l'emporte sur toute règle générale.

Corollaire, sur la carte d'un article enregistré : le bouton « Écarter » est **inerte**,
avec le `title` « Article enregistré — retire-le de tes favoris pour l'écarter ». Un
bouton qui ne fait rien sans dire pourquoi est le pire des deux mondes ; c'est déjà la
position tenue pour le bouton freiné du suivi de prix.

Le verdict est une **chaîne**, pas un booléen, parce qu'il sert trois fois : à masquer,
à expliquer en mode révision, et à compter par motif dans le Diagnostic (§9).

## 4. Interface — la page Vinted

### 4.1 Le bouton « Écarter » sur la carte

Un deuxième bouton, injecté dans le même hôte et par le même chemin que le marque-page
existant (`injectCardButton()`) — donc dans `.new-item-box__image-container`, en
position absolue :

```
┌───────────────────────────────┐
│  ╭────╮               ╭─────╮ │  marque-page : inchangé, top 8 / right 8, 32 px
│  │ ⦸  │               │ 🔖  │ │  écarter : à sa gauche, top 10 / right 48, 28 px
│  ╰────╯               ╰─────╯ │
│                               │
│          photo Vinted         │
│                               │
│                       ╭─────╮ │
│                       │  ♡  │ │  favori natif Vinted, jamais touché
│                       ╰─────╯ │
├───────────────────────────────┤
│ Zara                          │
│ 38 · Très bon état            │
│ 12,00 €                       │
└───────────────────────────────┘
```

Trois décisions de placement, chacune motivée :

- **à gauche du marque-page, pas en dessous.** Une colonne de deux boutons ressemble à
  une barre d'outils et couvre le vêtement, qui est la seule chose qu'on regarde sur une
  carte. Deux boutons côte à côte tiennent dans les 72 px du coin, y compris sur les
  grilles à quatre colonnes ;
- **28 px contre 32.** Le geste fréquent et positif reste le plus gros. Écarter est plus
  rare et plus destructeur : il ne doit pas être le bouton qu'on touche par accident en
  visant l'autre ;
- **visible au survol de la carte seulement** (`opacity: 0` → `1`, plus `:focus-visible`
  pour le clavier). Le catalogue reste visuellement calme, et le bouton apparaît là où
  le pointeur est déjà. **Jamais par `display` ni `visibility`** : les deux détruisent
  la cible du survol et produisent exactement l'oscillation que la règle 2 interdit — le
  `transform` n'est pas le seul moyen de fabriquer ce bug.

**Le bouton est un interrupteur.** Sur une carte déjà écartée il montre un œil ouvert et
le clic la remet — le geste inverse au même endroit. Sans cela, le mode révision (§4.4)
ne servait qu'à regarder : on voyait les cartes masquées sans pouvoir en repêcher une
sans ouvrir le panneau. Un article masqué par une **règle** (marque, mot, vendeur) n'est
pas concerné : le bouton ne connaît que l'écart individuel, et une règle se retire
depuis le panneau — le `title` le dit plutôt que de laisser un clic sans effet.

Le bouton respecte les règles 1 et 2 du `CLAUDE.md` sans exception : déclenché sur
`pointerdown`, `click` réservé au clavier (`event.detail === 0`), `user-select: none`,
`pointer-events: none` sur les enfants, et aucun `transform` au survol. Il réutilise
`createButton()`, qui porte déjà tout cela — c'est la raison pour laquelle il faut
passer par lui plutôt que d'écrire un second créateur.

### 4.2 Le clic : un repli différé, pas une disparition

Un clic ne fait pas disparaître la carte tout de suite. Elle se replie sur un panneau
d'annulation qui occupe sa place pendant **2 secondes** :

```
┌───────────────────────────────┐
│░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░│  la carte : opacité 0,15, sur fond gris clair
│░ ┌──────────────────────────┐░│  le panneau : superposé, jamais substitué
│░ │ Écarté          Annuler  │░│
│░ │                          │░│
│░ │ Masquer tous les produits│░│
│░ │ Zara                     │░│  ← la phrase porte l'action, le lien la cible
│░ │ Masquer tous les produits│░│
│░ │ de ce vendeur            │░│  ← seulement si le vendeur est connu (§7)
│░ ├──────────────────────────┤░│
│░ │██████████░░░░░░░░░░░░░░░░│░│  ← compte à rebours, animation CSS pure
│░ └──────────────────────────┘░│
└───────────────────────────────┘
```

C'est le point de conception le plus important de la fonctionnalité, et il tient en une
phrase : **l'instant où l'on écarte un article est le seul instant où l'on sait
pourquoi.** « Encore du Shein », « encore ce revendeur » — la raison est présente à
l'esprit à ce moment-là, et jamais plus ensuite. Proposer la règle générale ici évite
d'avoir à ouvrir un écran de réglages pour la formuler, ce que personne ne fait.

Ce même panneau règle le piège identifié par l'audit (« prévoir le cas j'ai écarté par
erreur ») sans mécanisme supplémentaire.

Quatre détails qui ne sont pas cosmétiques :

- **la fenêtre est courte, et c'est voulu.** Elle vise le clic de travers, pas la
  délibération : à ce stade la décision est déjà prise, et un trou de six secondes dans
  la grille pendant qu'on parcourt la page coûte plus qu'il ne rattrape. Les regrets
  tardifs ont leur propre chemin — la liste des récents dans la modale du panneau
  (§5.2), qui n'a pas de date de péremption ;
- **le compte à rebours est une animation CSS** (`@keyframes` sur la largeur), pas un
  `setInterval` qui réécrirait un texte dix fois par seconde. Une barre animée par le
  compositeur coûte zéro mutation ; un compteur en JavaScript réveillerait le
  `MutationObserver` à chaque frame, sur chaque carte écartée. C'est la règle 3
  appliquée à un endroit où on ne l'attend pas ;
- **la carte n'est jamais vidée ni déplacée.** Le panneau est un enfant de plus dans
  l'hôte, comme le bouton ; la carte de Vinted est seulement atténuée par une règle CSS.
  Aucun `remove()`, aucun `innerHTML` sur du DOM Vinted ;
- **un fond gris très clair** (`#f3f4f6`) occupe la place pendant le repli, posé sur
  l'hôte _et_ sur le panneau : la photo transparaît sous l'opacité 0,15, et du blanc pur
  par-dessus la ferait ressortir en gris sale. La place se lit comme « en cours de
  départ », pas comme un trou ;
- **à l'expiration**, l'attribut de masquage est posé (§6) et le panneau retiré. Si
  l'utilisateur a fait défiler la page entre-temps, rien ne change : le repli est une
  question de temps, pas de visibilité.

Un clic sur « la marque Zara » ou « ce vendeur » écrit la règle correspondante, ferme le
panneau immédiatement, et **toutes les cartes concernées de la page se replient dans la
foulée** — sans animation en cascade, sans étape intermédiaire. Le `flash` de
confirmation est la pastille de §4.4, dont le compteur bondit : c'est plus lisible qu'un
message.

### 4.3 Le masquage lui-même

Une carte masquée reçoit un attribut, et c'est tout :

```html
<div
  data-testid="product-item-id-9497504182"
  data-vf-hidden="brand"
  data-vf-rev="3"
></div>
```

```css
/* Le sélecteur d'attribut plutôt qu'une classe : React réécrit `className` à
   chaque rendu de la carte et emporterait la nôtre, alors qu'il ne touche pas
   aux `data-*` qu'il ne connaît pas. Voir §6 pour l'auto-guérison. */
html:not(.vf-reveal) [data-vf-hidden]:not([data-vf-hidden='0']) {
  display: none !important;
}
```

Le `!important` est assumé : on est en concurrence avec une feuille de styles qu'on ne
contrôle pas, dont l'ordre d'injection n'est pas garanti, et sur une propriété où perdre
signifie « la fonctionnalité ne marche pas ». C'est le seul `!important` du projet, et
il mérite son commentaire dans `content.css`.

**C'est la cellule de grille qui disparaît, pas la carte.** La carte
(`product-item-id-…`) est enfouie **trois niveaux** sous sa cellule
(`[data-testid="grid-item"]`, ancre déjà documentée). Masquer la carte laisse la cellule
en place, vide : la grille garde un trou blanc, et une ligne ne se referme que lorsque
ses quatre cartes sont masquées — exactement le symptôme observé à la première
livraison. En masquant la cellule, l'auto-placement CSS Grid fait remonter les suivantes
sans qu'on ait rien à calculer, et le rendu reste fluide au fil des écarts.

`hideTargetOf()` remonte donc à la cellule, **à condition qu'elle ne porte qu'une
carte** — deux cartes dans la même cellule et l'on emporterait la voisine. Le résultat
est mémoïsé : la structure d'une carte ne change pas de sa vie. À défaut de cellule
(blocs d'une fiche, fil d'accueil), on retombe sur la carte elle-même, où le problème ne
se pose pas.

**Repli et non grisage, par défaut.** L'audit hésitait entre les deux ; le repli gagne
parce que le gain recherché est de la place à l'écran : une grille de cartes grisées se
fait défiler exactement comme une grille de cartes normales, et 90 % du bénéfice est
perdu. Le grisage existe, mais comme mode de révision explicite (§4.4).

**Conséquence à connaître** : masquer beaucoup raccourcit la page, ce qui fait
déclencher plus tôt le chargement de la page suivante par Vinted. Le défilement devient
de la pagination accélérée. Ce n'est pas un bug et il n'y a rien à corriger — c'est même
l'effet recherché — mais c'est la seule façon dont cette fonctionnalité, qui n'émet
aucune requête, augmente indirectement le trafic vers Vinted. Autant l'avoir écrit.

### 4.4 La pastille de comptage et le mode révision

Une pastille flottante, en bas à gauche de la fenêtre, visible seulement quand la page
masque au moins une carte :

```
   ┌──────────────────────────────┐
   │  ⦸  34 masqués  ·  Afficher  │   position: fixed ; bottom: 20px ; left: 20px
   └──────────────────────────────┘
```

**Pourquoi flottante et non « en haut de la page »** comme le proposait l'audit : ancrer
un bandeau en tête des résultats demande une ancre pour la grille, or Vinted n'en expose
aucune de stable à cet endroit (les classes sont obfusquées, et `feed-grid` est un nom
que nos propres fixtures fabriquent). Une pastille `position: fixed` ne dépend d'aucune
ancre, ne peut être cassée par aucune refonte, et suit le défilement — ce qui compte,
puisque le compteur monte à mesure que le scroll infini charge des pages. Le précédent
existe déjà dans le projet : `.vf-detail-btn` est fixe pour exactement cette raison. En
bas à **gauche**, parce que la droite est occupée par le bouton de la fiche et par la
bulle de messagerie de Vinted.

Le clic sur « Afficher » pose la classe `vf-reveal` sur `<html>` :

```css
html.vf-reveal [data-vf-hidden]:not([data-vf-hidden='0']) {
  opacity: 0.35;
  filter: grayscale(1);
}
```

Une seule écriture d'attribut, sur un élément que le `MutationObserver` ne surveille
même pas (il observe `document.body`, et sans `attributes: true`) : révéler 96 cartes
coûte zéro mutation et zéro scan. Le motif de chaque masquage se lit au survol, dans le
`title` posé au moment du verdict (« Masqué : marque Zara »).

**Ce mode est transitoire et local à la page.** Il retombe à la navigation suivante, et
n'est pas écrit en storage. Le réglage durable existe, mais il vit dans le panneau
(`settings.revealHidden`, §5) : un « tout afficher » global qu'on oublie d'éteindre
donne une extension qui semble avoir perdu ses réglages. Transitoire là où l'on navigue,
durable là où l'on configure.

### 4.5 Sur la fiche article

La fiche est aujourd'hui le **seul endroit où l'identifiant du vendeur est certain**
(`readSeller()`, lien `/member/{id}` + `data-testid="profile-username"`). Elle porte
donc l'entrée de règle qui manque peut-être à la carte (§7).

Le bouton flottant existant devient un groupe de deux, l'œil barré à gauche de la pilule
« Enregistrer », même hauteur, 40 px, rond :

```
                                     ┌────┐  ┌──────────────────┐
                                     │ ⦸  │  │ 🔖  Enregistrer  │
                                     └────┘  └──────────────────┘
                                         bottom: 104px ; right: 24px
```

Un clic ouvre un petit menu ancré au-dessus, à trois entrées — c'est le seul endroit du
content script qui ouvre un menu, et il ne réutilise rien du panneau (mondes séparés) :

```
   ┌─────────────────────────────┐
   │ Écarter cet article         │
   │ Masquer la marque Zara      │
   │ Masquer vintage_shop_75     │
   └─────────────────────────────┘
```

Fermeture au clic extérieur et à `Échap`. Les entrées dont la donnée manque (marque
absente, vendeur illisible) ne sont **pas affichées** plutôt que désactivées : sur une
liste de trois, une entrée grise n'apprend rien.

La fiche ouverte n'est **jamais masquée**, même si elle relève d'une règle : on l'a
ouverte exprès. Les blocs « Dressing du membre » et « Articles similaires » qui la
suivent, en revanche, sont des cartes ordinaires (`blockCards()`) et sont filtrés comme
telles — c'est même là que le masquage par vendeur se voit le mieux.

### 4.6 « Déjà dans Vestes » au survol du marque-page

Le dernier point de l'audit, et le moins cher. Le content script ne lit aujourd'hui que
`savedItems` ; il lira aussi `collections` — un objet de quelques centaines d'octets,
mis à jour par le même écouteur `onChanged`.

Le `title` du marque-page enregistré devient :

```
  Déjà dans « Vestes » — retirer de mes favoris (extension)
```

et retombe sur le libellé actuel quand l'article est dans la collection par défaut ou
qu'aucun nom n'est lisible.

**Attention à la garde d'idempotence de `paintButton()`** : elle compare aujourd'hui
`vfPainted`, `vfSaved` et `vfBlocked`. Ajouter un texte qui dépend de la collection sans
ajouter la collection à la comparaison produit un bouton dont le `title` ne se met
jamais à jour après un déplacement — silencieux, évidemment. La garde gagne donc
`vfCol`.

## 5. Interface — le panneau latéral

### 5.1 L'entrée — et la séparation du pied de page en deux bandes

Le pied de page actuel mélange deux natures de boutons qui n'ont pas la même espérance
de vie. « Exporter en JSON » et « Diagnostic » sont des **outils de développement** :
utiles pendant la mise au point, ils ont vocation à disparaître de la version que voit
l'utilisateur (`docs/audit/analyse-utilisateur.md` §5.7 le dit déjà du diagnostic — « un
outil de développeur affiché à l'utilisateur »). « Filtres » est un **réglage**, il
restera aussi longtemps que la fonctionnalité.

Les mélanger dans la même rangée oblige à démonter la bande le jour où l'on retire le
debug. On les sépare donc dès maintenant, en deux bandes empilées :

```
┌────────────────────────────────────────────────────┐
│                                                    │
│   … liste des articles …                           │
│                                                    │
├────────────────────────────────────────────────────┤
│  [ ⚙ Filtres 12 ]                                  │  ← réglages, permanente
├────────────────────────────────────────────────────┤
│  [ Exporter en JSON ]        [ Diagnostic ]        │  ← debug, temporaire
└────────────────────────────────────────────────────┘
```

- **La bande de réglages** (`<footer class="footer">`) est celle du haut, et c'est la
  seule qui restera. Elle n'a pour l'instant qu'un bouton, qui n'occupe donc pas toute
  la largeur : elle est prévue pour en accueillir d'autres (import, préférences de coût
  total, cadence du suivi) et un bouton étiré sur 320 px qu'on rétrécira au premier
  voisin est un faux départ. Alignement à gauche, largeur naturelle.
- **La bande de debug** (`<footer class="footer footer--dev">`) est tout en bas,
  visuellement en retrait : texte plus petit, couleur `--muted`, séparateur plus
  discret. Elle se supprime le jour venu **en retirant un seul élément du HTML** et son
  bloc de CSS, sans toucher à quoi que ce soit d'autre. C'est tout l'intérêt de la
  séparation, et la raison pour laquelle elle mérite un commentaire dans
  `sidepanel.html` — sinon la prochaine session « nettoiera » en refusionnant les deux
  bandes.

Le pied de page reste le bon endroit pour les filtres : ce sont des réglages qu'on ouvre
rarement et qu'on ne consulte pas en chinant. La barre de tri, elle, est déjà pleine
(tri, sens, tout ouvrir, rafraîchir) et n'accueillera rien de plus.

Le bouton porte le compte total de règles quand il y en a — `Filtres 12` — ce qui est le
seul rappel permanent que des articles sont masqués quelque part. Sans lui, un filtre
oublié devient un bug incompréhensible six mois plus tard.

### 5.2 La modale

Même mécanique que `#collection-dialog` et `#offer-dialog` : `.overlay` + `.dialog`,
fermeture par `Échap` et par le fond. Aucun nouveau mécanisme de superposition.

```
┌────────────────────────────────────────────┐
│ Filtres du catalogue                       │
│                                            │
│ Articles écartés                           │
│   128 articles · Gérer  ─────────────┐     │
│                                      │     │
│ Marques masquées                       6   │
│   [Zara ×] [Shein ×] [H&M ×] [Primark ×]   │
│   ┌──────────────────────┐  ┌──────────┐   │
│   │ Ajouter une marque   │  │ Ajouter  │   │
│   └──────────────────────┘  └──────────┘   │
│   + Ajouter le jeu « fast fashion »        │
│                                            │
│ Vendeurs masqués                       2   │
│   [vintage_shop_75 ×] [destock_pro_92 ×]   │
│                                            │
│ Mots exclus                            4   │
│   [style ×] [inspiré ×] [réplique ×]       │
│   ┌──────────────────────┐  ┌──────────┐   │
│   │ Ajouter un mot       │  │ Ajouter  │   │
│   └──────────────────────┘  └──────────┘   │
│                                            │
│ ☐ Afficher les articles masqués            │
│   (grisés au lieu d'être retirés)          │
│                                            │
│                               [ Fermer ]   │
└────────────────────────────────────────────┘
```

Quelques partis pris :

- **les règles sont des puces (`.chip`)**, style déjà présent dans la modale d'offre.
  Une puce, une croix, une suppression : c'est la forme la plus dense pour une liste de
  courts libellés, et la seule qui tienne dans 320 px ;
- **les articles écartés ont leur propre modale.** La liste occupait la moitié de la
  hauteur des filtres pour l'usage le plus rare de l'écran ; il n'en reste ici qu'un
  compte et un « Gérer » qui ouvre `#hidden-dialog`, par-dessus. `Échap` ferme la plus
  haute des deux, une à la fois — fermer les deux d'un coup renverrait à la liste
  d'articles alors qu'on venait consulter une sous-liste ;
- **on ne stocke que des ids** (§2) : afficher `9497504182` n'apprend rien. Les 20
  derniers ont un titre et sont donc nommés dans la modale dédiée ; au-delà, seuls le
  compte et le « Tout réafficher » sont offerts, et une ligne le dit explicitement
  plutôt que de laisser croire la liste complète ;
- **il n'y a pas de bouton « Ajouter un vendeur ».** Un pseudo se saisit mal et
  s'identifie par un nombre : les vendeurs n'entrent dans la liste que depuis une page
  Vinted (§4.2, §4.5), où l'identifiant est connu. La modale ne sait qu'en retirer ;
- **la case « Afficher les articles masqués »** écrit `settings.revealHidden`. Cochée,
  les onglets Vinted ouverts passent en grisé sans rechargement, par `onChanged`.

### 5.3 Le jeu « fast fashion »

Une constante de `shared/noise.ts`, proposée en un clic, **jamais appliquée d'office** :

```ts
/**
 * Proposé, jamais posé par défaut : masquer des marques sans qu'on l'ait demandé
 * est le meilleur moyen de faire croire l'extension cassée. Le clic les insère
 * comme des règles ordinaires — retirables une par une ensuite, sans mode
 * spécial ni indirection.
 *
 * Les libellés doivent être ceux de **Vinted**, au caractère près : la règle se
 * compare au texte de la carte (§3.3). « Pull & Bear » avec ses espaces, pas
 * « Pull&Bear ». À revérifier au catalogue si une marque de la liste ne mord pas.
 */
export const FAST_FASHION = [
  'shein',
  'temu',
  'wish',
  'aliexpress',
  'primark',
  'h&m',
  'zara',
  'bershka',
  'pull & bear',
  'stradivarius',
  'boohoo',
  'prettylittlething',
];
```

Le bouton **disparaît une fois le jeu complet** : il n'aurait plus rien à proposer, et
un bouton qui ne fait rien est pire qu'un bouton absent. Retirer une seule de ces
marques le ramène.

Le clic ajoute ce qui manque et ne dédouble rien. Une fois ajoutées, ce sont des règles
comme les autres : rien ne distingue « Zara venu du jeu » de « Zara ajouté à la main »,
et c'est voulu — un état caché « appartient au jeu » compliquerait la suppression
individuelle pour aucun bénéfice.

## 6. Idempotence — la règle 3 appliquée ici

C'est le seul risque technique réel de la fonctionnalité, et il se traite en trois
points.

**Le masquage ne coûte aucune mutation observée.** L'observateur est monté sur
`document.body` en `{ childList: true, subtree: true }` — **sans `attributes`**. Poser
`data-vf-hidden` sur 96 cartes est donc invisible pour lui : aucun scan déclenché,
aucune boucle possible. C'est la raison profonde du choix « attribut + CSS » plutôt que
« style en ligne » ou « nœud injecté » : le mécanisme le plus économe est aussi le seul
qui ne puisse pas boucler.

**Ce qui, en revanche, ajoute des enfants doit être ignoré par l'observateur.** Le
panneau d'annulation (§4.2) et la pastille (§4.4) sont des nœuds injectés : leur
apparition et leur retrait déclenchent l'observateur, qui relance un scan, qui les
repeint… Le filtre existant s'étend donc :

```ts
return !target.closest('.vf-card-btn, .vf-detail-btn, .vf-undo, .vf-pill, .vf-menu');
```

**La garde vérifie l'état réel, pas seulement le drapeau.** C'est le piège subtil : si
l'on se contente de « déjà traité, on sort », une carte que React aurait re-rendue entre
deux scans — perdant nos attributs — resterait visible pour toujours, sans erreur nulle
part. La garde compare donc ce qui est écrit à ce qui devrait l'être :

```ts
/**
 * `rev` est incrémenté à chaque arrivée de nouvelles règles par `onChanged` :
 * sans lui, une carte jugée visible sous les anciennes règles ne serait jamais
 * réévaluée. Comparer les deux attributs plutôt qu'un drapeau booléen rend la
 * pose **auto-guérissante** : si Vinted re-rend la carte et emporte nos
 * attributs, les deux lectures rendent `undefined` et le verdict est reposé.
 */
if (box.dataset.vfRev === String(rev) && box.dataset.vfHidden === verdict) return;
```

Le texte normalisé d'une carte est mémoïsé dans une `WeakMap<HTMLElement, string>` : il
ne change pas de la vie de la carte, et le recalculer à chaque scan pour 96 cartes × 200
règles serait le seul coût mesurable de la fonctionnalité.

## 7. Le point à vérifier avant de coder : le vendeur sur une carte

L'audit le signalait, et la question reste ouverte : **`seller_id` est-il atteignable
depuis une carte de catalogue ?**

Ce qu'on sait :

- il est présent sur une **fiche**, dans le flux d'hydratation, blocs `gallery`,
  `favourite` et `report` (`docs/vinted-dom.md`) — `hydrationNumbers()` le lit déjà ;
- il n'est **pas** dans le DOM d'une carte : ni `data-testid`, ni lien overlay
  (`/items/{id}-slug`), ni libellé d'accessibilité ;
- la fixture `catalog.html` **ne permet pas de conclure** : `refresh-fixtures` ne
  conserve que les cartes et le fil d'Ariane, et jette les ~150 scripts du flux. Zéro
  occurrence dans la fixture ne veut pas dire zéro occurrence sur la vraie page.

**La vérification tient en quelques lignes de `diagnose()`**, à écrire en premier (§11,
étape 2) :

```ts
vendeursSurCartes: `${resolus}/${cartes}`,
```

Deux branches, décidées par ce chiffre :

- **le flux porte les vendeurs** → on construit une fois par page une carte
  `item_id → seller_id`, et « Masquer ce vendeur » est offert partout, y compris dans le
  panneau d'annulation de §4.2 ;
- **le flux ne les porte pas** → la sous-fonctionnalité se replie sur la fiche (§4.5) et
  sur les articles déjà enregistrés, dont on connaît le `sellerId`. La règle continue de
  s'écrire et de vivre ; simplement, une carte de catalogue dont le vendeur est inconnu
  ne peut pas être filtrée. La modale du panneau le dit en une ligne sous la section
  Vendeurs, plutôt que de laisser croire à un filtre qui ne mord pas.

**Ce qu'on ne fera dans aucun des deux cas** : appeler `/api/v2/catalog/items` pour
obtenir les vendeurs. Une requête par page de catalogue parcourue, pour une
fonctionnalité passive, contredit §1 et rouvre tout le dossier du débit que
`docs/specs/suivi-prix.md` a refermé.

## 8. Quota

`noise` est borné par construction (§2) : ~150 Ko au pire pour `hidden`, quelques
kilo-octets pour les trois listes de règles. Aucun champ n'est ajouté à `SavedItem`,
donc aucune croissance proportionnelle à la taille de la collection. C'est la seule
fonctionnalité de la feuille de route qui ne pèse rien.

## 9. Diagnostic

Quatre lignes de plus dans `diagnose()`, dans l'esprit du risque transverse n°1 de
l'audit (étendre le diagnostic en même temps que la fonctionnalité, pas après) :

```ts
regles: { ecartes: 128, vendeurs: 2, marques: 6, mots: 4 },
cartesMasquees: 34,
motifs: { item: 8, seller: 3, brand: 20, word: 3 },
vendeursSurCartes: '0/48',
```

`motifs` est ce qui rend une plainte diagnosticable en une seconde : « pourquoi ce truc
a disparu ? » se répond par la ligne qui montre 20 masquages par marque. Sans elle, la
seule voie est de vider les règles une par une.

La table de lecture correspondante va dans `docs/diagnostic.md`.

## 10. Découpage

| Fichier                                      | Rôle                                                                                                                                        |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/shared/types.ts`                        | `NoiseFilters`, `revealHidden` dans `Settings`, les trois bornes                                                                            |
| `src/shared/noise.ts` _(nouveau, pur)_       | `normalize()`, `haystack()`, `matchesBrand()`, `verdictFor()`, `pushHidden()` (éviction), `FAST_FASHION` — **aucun accès Chrome**           |
| `src/content/content.ts`                     | `applyFilters()` dans `scan()`, second bouton via `createButton()`, panneau d'annulation, pastille, menu de fiche, lecture de `collections` |
| `src/content/content.css`                    | `.vf-hide-btn`, `.vf-undo`, `.vf-pill`, `.vf-menu`, `[data-vf-hidden]`, `html.vf-reveal`                                                    |
| `src/sidepanel/filters.ts` _(nouveau)_       | la modale : rendu des puces, ajout/retrait, jeu fast fashion                                                                                |
| `src/sidepanel/store.ts`                     | lecture/écriture de `noise`, avec la relecture préalable de la règle 6                                                                      |
| `src/sidepanel/sidepanel.{ts,html,css}`      | pied de page scindé en deux bandes (§5.1), bouton « Filtres » et son compteur, modale                                                       |
| `src/shared/messages.ts`                     | **rien** — tout passe par le storage (§1)                                                                                                   |
| `src/manifest.ts`                            | **rien** — aucune permission nouvelle                                                                                                       |
| `docs/architecture.md`, `docs/diagnostic.md` | la cinquième clé, la table de lecture du diagnostic                                                                                         |

## 11. Tests

Chacun doit rougir si l'on neutralise le correctif correspondant — méthode de debug,
point 3 du `CLAUDE.md`.

1. **`noise.test.ts`** _(pur, le plus important)_ — `lot` ne masque pas `culotte` ni
   `salopette` ; `zara` masque `zara kids` mais pas `zarautz` ; `H&M` masque `h&m` ;
   `Rétro` masque `retro` ; un article présent dans `savedItems` échappe à toutes les
   règles ; l'éviction au-delà de `NOISE_HIDDEN_MAX` retire bien les plus anciens.
2. **`content-filter.test.ts`** _(jsdom, fixture `catalog.html` authentique)_ — avec une
   marque masquée, les cartes concernées portent `data-vf-hidden="brand"` et les autres
   `"0"` ; un article enregistré de cette marque reste visible ; l'annulation dans les 6
   s remet la carte ; la pastille affiche le bon compte.
3. **`repaint-loop.test.ts`** _(existant, à étendre)_ — un scan sur une page où des
   cartes sont masquées n'écrit rien de plus (`watchChurn()` à 0), et l'injection du
   panneau d'annulation ne relance pas de scan en boucle. C'est ici que le filtre étendu
   de l'observateur (§6) est verrouillé.
4. **`filters-render.test.ts`** _(panneau, sur le modèle de `watch-render.test.ts`)_ —
   la modale liste les règles, retirer une puce réécrit `noise`, le jeu fast fashion ne
   dédouble pas une marque déjà présente, et le champ refuse au-delà de
   `NOISE_RULES_MAX`.

Le test qui vaut tous les autres est le premier : c'est celui qui empêche la version où
`« lot »` masque les culottes, et cette version-là ferait désinstaller l'extension avant
qu'on ait lu le rapport de bug.

## 12. Ordre de mise en œuvre

1. `shared/noise.ts` et ses tests purs. Aucun effet visible, tout est vérifiable.
2. **La vérification `seller_id` sur carte** (§7), par `diagnose()` étendu. Une
   demi-heure, et elle décide de la forme de deux écrans.
3. Le cœur : `applyFilters()` dans `scan()`, le bouton œil, le panneau d'annulation. À
   ce stade, aucune règle générale n'existe encore — seul « écarter cet article »
   marche, et c'est déjà le gain quotidien principal.
4. La pastille et le mode révision (§4.4).
5. Les règles générales : marque et mots depuis le panneau d'annulation et la fiche
   (§4.5).
6. La modale du panneau et le jeu fast fashion (§5).
7. Le nom de la collection au survol du marque-page (§4.6) — indépendant du reste, à
   caser dès qu'il y a un créneau.

## 13. Ce qu'on ne fait pas

- **Pas de masquage par prix, par état ou par taille.** Vinted a des filtres pour ça, et
  ils sont meilleurs que les nôtres. Le filtrage local ne traite que ce que le catalogue
  ne sait pas exprimer : « celui-là, plus jamais ».
- **Pas d'expressions régulières ni de jokers** dans les mots exclus (§3.2).
- **Pas de suppression automatique des favoris** quand on masque une marque : masquer un
  affichage n'est pas jeter ce qu'on a mis de côté (§3.4).
- **Pas de masquage sur la fiche ouverte** : si on l'a ouverte, c'est qu'on veut la
  voir.
- **Pas d'apprentissage automatique** du genre « tu écartes souvent du Shein, faut-il le
  masquer ? ». Suggérer une règle à partir d'un comptage, c'est deviner l'intention ; le
  panneau d'annulation la demande explicitement, au bon moment, ce qui est plus simple
  et plus juste.
- **Pas de synchronisation avec les préférences Vinted.** Le site n'expose rien de tel,
  et aller le chercher supposerait des requêtes (§1).
