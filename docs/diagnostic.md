# Diagnostic

Bouton **Diagnostic** dans le pied du panneau latéral, à lancer avec un onglet Vinted
actif. Il interroge le content script de cet onglet et affiche son rapport.

La bande qui le porte est masquée par défaut : **clic droit sur l'icône de l'extension →
« Ouvrir en mode développeur »**. Elle reste dépliée jusqu'au bouton « Quitter » ou à la
fermeture de Chrome (le drapeau vit dans `chrome.storage.session`).

C'est le premier réflexe quand quelque chose ne marche plus : il distingue en une
lecture « Vinted a changé son DOM » de « le clic n'arrive pas jusqu'au bouton ».

## Sur une page de résultats

```json
{
  "cardsFound": 96,
  "cardsParsed": 96,
  "cardButtons": 96,
  "missing": {
    "title": 0,
    "brand": 0,
    "price": 0,
    "imageUrl": 0,
    "size": 3,
    "condition": 0,
    "priceValue": 0,
    "favouriteCount": 0
  },
  "savedCount": 12,
  "collectionParDefaut": "Vestes",
  "debug": { "clicks": 2, "writes": 2, "lastError": null }
}
```

`missing.size` non nul est normal — sacs et accessoires n'ont pas de taille. Les autres
champs doivent rester à 0 : ce sont les quatre entrées du tri (`price`/`priceValue`,
`condition`, `favouriteCount`, `size`). `priceValue` et `favouriteCount` sont comptés
sur leur type, pas sur leur valeur — 0 favori est une donnée, pas une absence.

`collectionParDefaut` répond à « pourquoi mes articles atterrissent-ils là ? » : c'est
la collection épinglée sur **cet onglet** (l'épingle du menu de rangement), où part tout
clic court. `null` quand il n'y en a pas — l'article va alors dans « Mes favoris ».
L'épinglage est propre à l'onglet et disparaît avec lui ; un autre onglet peut donc
répondre autre chose, et c'est voulu.

### `regles`, `motifs`, `vendeursSurCartes` — le filtrage du bruit

```json
{
  "regles": { "ecartes": 128, "vendeurs": 2, "marques": 6, "mots": 4 },
  "cartesMasquees": 34,
  "motifs": { "item": 8, "seller": 3, "brand": 20, "word": 3 },
  "vendeursSurCartes": "0/48"
}
```

`motifs` est la ligne à lire en premier quand un article a « disparu » : elle dit par
quelle nature de règle, et évite de vider les filtres un par un pour trouver le
coupable.

`vendeursSurCartes` répond à la question ouverte par
[filtrage-bruit.md](specs/filtrage-bruit.md) §7 :

| Ce qu'on lit                      | Interprétation                                                                                    |
| --------------------------------- | ------------------------------------------------------------------------------------------------- |
| `n/n` ou presque                  | le flux d'hydratation porte les vendeurs → « masquer ce vendeur » marche depuis le catalogue      |
| `0/n` sur une page de catalogue   | il ne les porte pas → la règle ne mord que sur les fiches et les articles déjà enregistrés        |
| `0/n` alors que ça marchait avant | le bloc du flux a changé de forme → voir `hydrationSellerMap()` et [vinted-dom.md](vinted-dom.md) |

## Sur une fiche article

```json
{ "detailButton": "présent", "detailJsonLd": true, "detailExtraction": { … },
  "photos": { "flux": 3, "dom": 3 },
  "detailButtonBox": { "top": 732, "left": 1180, "w": 148, "h": 41, "opacity": "1" },
  "clickablePoints": "9/9", "inViewport": true }
```

`clickablePoints` sonde **9 points** répartis sur la surface du bouton, pas seulement
son centre : un recouvrement partiel — le symptôme « ça ne marche qu'à certains endroits
» — est invisible autrement. En dessous de `9/9`, le champ `BLOQUÉ_PAR` nomme les
éléments qui interceptent le clic.

`photos` compte les deux voies de la galerie séparément, et l'écart entre elles se lit
ainsi :

| `flux` | `dom` | Ce que ça dit                                                         |
| ------ | ----- | --------------------------------------------------------------------- |
| n      | n     | tout va bien ; la galerie a la pleine résolution                      |
| 0      | n     | le bloc `gallery` a changé de nom → la galerie retombe sur le `f800`  |
| n      | 0     | normal après une navigation SPA : le carrousel n'est pas encore rendu |
| 0      | 0     | les deux ancres ont cassé — voir [vinted-dom.md](vinted-dom.md)       |

### `identifiants`

Marque et vendeur ont chacun deux sources : le DOM rendu côté serveur, préféré, et le
flux d'hydratation en repli. Le bloc les montre **côte à côte**, ce qui dit laquelle des
deux a lâché plutôt que de conclure à l'absence de donnée.

```json
{
  "identifiants": {
    "marqueFilDAriane": "53",
    "marqueFlux": 53,
    "vendeurLien": "3165663897",
    "vendeurFlux": 3165663897,
    "vendeurPseudo": "emma07297",
    "taille": "non exposée par Vinted — voir docs/limitations.md"
  }
}
```

| Ce qu'on lit                          | Interprétation                                                       |
| ------------------------------------- | -------------------------------------------------------------------- |
| les deux sources d'accord             | tout va bien                                                         |
| `marqueFilDAriane: null`, flux fourni | le maillon `/brand/…` a disparu du fil ; le repli tient              |
| les deux à `null`                     | l'article n'a pas de marque référencée, ou les deux ancres ont sauté |
| `vendeurPseudo: null`                 | `profile-username` a changé de nom → le panneau n'affiche plus rien  |
| sources en désaccord                  | le motif du flux attrape un article voisin — à corriger d'urgence    |

`taille` rappelle que Vinted n'écrit ce identifiant nulle part : il est résolu par
requête, et ce sont `debug.sizesResolved` / `debug.sizesUnresolved` qui disent si cela
fonctionne.

### `vendeur`

Même principe pour la réputation, à ceci près que c'est le **flux** qui est la source
préférée et le DOM le repli — voir [architecture.md](architecture.md).

```json
{
  "vendeur": {
    "noteFlux": 4.7,
    "noteDom": 4.7,
    "avisFlux": 39,
    "avisDom": 39,
    "paysLus": "3 profil(s), 1 sans localisation"
  }
}
```

| Ce qu'on lit                   | Interprétation                                                                     |
| ------------------------------ | ---------------------------------------------------------------------------------- |
| `noteFlux: null`, `noteDom` ok | le bloc `user_info_header` a changé de nom ; le repli tient                        |
| `noteFlux: 0.8` au lieu de `4` | la conversion réputation → note est cassée (`ratingFromReputation`)                |
| les deux à `null`              | les deux ancres ont sauté → [vinted-dom.md](vinted-dom.md)                         |
| `avisDom: null`, `noteDom` ok  | la structure du bloc d'étoiles a bougé : le compteur n'est plus son dernier enfant |
| `paysLus: "0 profil(s)"`       | aucun profil lu depuis le chargement de la page — normal sans enregistrement       |

Le pays n'apparaît pas parmi ces sources : il n'est sur aucune fiche, il vient d'une
lecture de `/member/{id}`. `paysLus` compte ces lectures depuis le chargement de la
page, et sépare celles qui ont donné un pays de celles où le membre n'expose pas sa
localisation — les deux sont des réponses normales.

## Blocs supplémentaires

Le rapport comprend aussi `donneesDeTri`, qui compte les favoris déjà enregistrés
dépourvus de chaque champ de tri :

```json
{
  "donneesDeTri": {
    "total": 42,
    "sansPrix": 0,
    "sansLikes": 9,
    "sansTaille": 3,
    "sansEtat": 0,
    "sansCategorie": 12,
    "categorieApprochee": 18,
    "enAttenteDeFiche": 0
  }
}
```

Et `offres`, qui dit où en est le balayage de la messagerie
([offres.md](specs/offres.md) §4) — la première chose à lire quand un badge d'offre
manque :

```json
{
  "offres": {
    "avecOffre": 4,
    "enAttente": 2,
    "compte": "77742929",
    "dernierBalayage": "30/07/2026 11:42:03",
    "rattrapage": "en cours, conversations d'avant le 26/04/2026 12:14:37",
    "freineJusqua": "non"
  }
}
```

| Ce qu'on lit                             | Interprétation                                                                                        |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `compte: "inconnu — session expirée ?"`  | `/api/v2/users/current` n'a rien rendu : rien n'est décidable, le balayage ne lit aucune conversation |
| `dernierBalayage: "jamais"`              | aucun scan n'a abouti — ouvrir un onglet Vinted, puis le panneau                                      |
| `rattrapage: "en cours…"`                | l'historique n'est pas entièrement lu : les offres anciennes arriveront aux prochaines ouvertures     |
| `freineJusqua` avec une heure            | 429/403 sur l'API : silence jusque-là, les offres connues restent affichées                           |
| `avecOffre: 0` alors qu'une offre existe | l'article n'est pas dans les favoris, ou l'offre porte sur ce que l'on vend                           |

`enAttenteDeFiche` compte les articles dont la fiche est en cours de lecture. Il doit
retomber à zéro en quelques secondes ; s'il stagne, les requêtes échouent —
`debug.enrichFailed` et `debug.lastError`, côté `catalogue`, disent pourquoi.

`categorieApprochee` compte les articles dont la catégorie vient de la page de
navigation et non de leur fiche (`exact: false`) — voir
[limitations.md](limitations.md#catégorie). Côté page, le bloc `catalogue` porte
`categorie` : le fil d'Ariane lu sur la page courante, ou le message expliquant qu'il
n'y en a pas.

`sansLikes` compte les articles enregistrés sans nombre de favoris : l'ancre n'a rien
donné ce jour-là. Les réenregistrer (un clic pour retirer, un pour remettre) les
complète. `sansLikes` égal au total signale en revanche que l'ancre a cassé pour de bon
— voir [vinted-dom.md](vinted-dom.md).

## `articles` — le contenu enregistré

Dernière clé du rapport : tous les articles du storage, tels qu'ils ont été enregistrés,
`collectionId` résolu.

```json
{
  "articles": [
    {
      "id": "9496908003",
      "title": "Nike Air Zoom mercurial superfly 11 Élite",
      "brand": "Nike",
      "size": "42",
      "condition": "Neuf avec étiquette",
      "price": "1,00 €",
      "priceValue": 1,
      "favouriteCount": 9,
      "url": "…",
      "imageUrl": "…",
      "savedAt": 1753500000000,
      "source": "detail",
      "collectionId": "default"
    }
  ]
}
```

`donneesDeTri` dit **combien** d'articles n'ont pas telle donnée ; ce bloc dit **ce
qui** a été enregistré à la place — un état rangé dans la taille, un prix suffixé, un
champ absent parce que l'article précède son extraction. C'est la lecture à faire avant
de conclure qu'une ancre a cassé.

Il est produit même sans onglet Vinted actif (le rapport porte alors une clé `page` à la
place de `catalogue`) : il se lit dans le storage, pas dans la page. Pour l'exploiter
ailleurs que dans la fenêtre de 220 px du panneau, **Exporter** livre le même contenu en
fichier.

## Table de lecture

| Symptôme                                                         | Interprétation                                                                                        |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `cardsFound: 0` sur une recherche                                | Vinted a changé ses `data-testid` → [vinted-dom.md](vinted-dom.md)                                    |
| `cardsFound > cardsParsed`                                       | Des cartes ont une structure inattendue                                                               |
| `cardsParsed > cardButtons`                                      | L'injection échoue — conteneur d'image introuvable                                                    |
| `blockCardsFound: 0` alors que le dressing du membre est visible | Le préfixe de testid des cartes de bloc a changé → [vinted-dom.md](vinted-dom.md)                     |
| `blocsArticles: []` sur une fiche                                | Le conteneur `item-page-{plugin}-plugin` a changé de nom                                              |
| `missing.title > 0`                                              | Le format du libellé d'accessibilité a changé                                                         |
| `detailButton: "ABSENT"`                                         | `extractFromDetail()` renvoie `null` — voir `detailExtraction`                                        |
| `detailJsonLd: false`                                            | Le JSON-LD a disparu, on est retombé sur les replis                                                   |
| `clickablePoints` < `9/9`                                        | Un élément Vinted recouvre le bouton → voir `BLOQUÉ_PAR`                                              |
| `debug.clicks` reste à 0 après un clic                           | Le clic n'atteint pas le bouton → [pitfalls.md](pitfalls.md)                                          |
| `debug.clicks > debug.writes`                                    | Le clic arrive mais l'écriture échoue → voir `lastError`                                              |
| `debug.longPress` reste à 0 après un appui long                  | Le geste est avalé avant le seuil (glissement, `pointerup` précoce), pas un menu cassé                |
| `debug.enrichFailed` grimpe                                      | Vinted refuse la lecture des fiches → les articles restent aux données de leur carte                  |
| `enAttenteDeFiche` ne redescend pas                              | Requêtes bloquées ou très lentes ; l'article reste utilisable                                         |
| `lastError: "Extension context invalidated"`                     | Extension rechargée sans recharger l'onglet — Cmd+R sur Vinted                                        |
| `cartesMasquees` proche de `cardsFound`                          | Une règle trop large — lire `motifs` pour savoir laquelle                                             |
| `motifs.word` élevé et inattendu                                 | Un mot exclu attrape plus large que prévu → le retirer depuis « Filtres »                             |
| `vendeursSurCartes: "0/n"`                                       | Le vendeur n'est pas lisible sur une carte ; c'est un état connu, pas une panne                       |
| `vendeur.noteFlux` et `noteDom` tous deux à `null`               | Les deux ancres de la note ont sauté → [vinted-dom.md](vinted-dom.md)                                 |
| `debug.sellerProfilesEmpty` monte seul                           | Les profils sont lus mais n'ont plus de pays → l'ancre `country_code` a changé                        |
| `debug.offersRead: 0` alors qu'une offre existe                  | Le balayage ne part pas : session expirée, ou freinage → voir `offersStopped`                         |
| `debug.offersStopped: "freiné"`                                  | 429/403 sur l'API : silence de 10 min, les offres connues restent affichées                           |
| `debug.offersRead` monte, `offersWritten` reste à 0              | Les conversations sont lues mais ne concernent aucun favori — normal si l'on vend                     |
| Un import de favoris en enregistre moins qu'annoncé              | `debug.soldBlocked` monte → des fiches vendues effacent l'ajout ; à l'import, ce doit être `soldKept` |

## Étendre le rapport

`diagnose()` vit dans `content.ts` et répond au message `VF_DIAGNOSE`. Y ajouter un
champ coûte quelques lignes et fait gagner un aller-retour de debug — c'est souvent plus
rentable que d'inspecter à la main dans la console, puisque le content script tourne
dans un monde isolé peu commode à atteindre.
