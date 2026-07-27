# Diagnostic

Bouton **Diagnostic** dans le pied du panneau latéral, à lancer avec un onglet Vinted
actif. Il interroge le content script de cet onglet et affiche son rapport.

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
  "debug": { "clicks": 2, "writes": 2, "lastError": null }
}
```

`missing.size` non nul est normal — sacs et accessoires n'ont pas de taille. Les autres
champs doivent rester à 0 : ce sont les quatre entrées du tri (`price`/`priceValue`,
`condition`, `favouriteCount`, `size`). `priceValue` et `favouriteCount` sont comptés
sur leur type, pas sur leur valeur — 0 favori est une donnée, pas une absence.

## Sur une fiche article

```json
{ "detailButton": "présent", "detailJsonLd": true, "detailExtraction": { … },
  "detailButtonBox": { "top": 732, "left": 1180, "w": 148, "h": 41, "opacity": "1" },
  "clickablePoints": "9/9", "inViewport": true }
```

`clickablePoints` sonde **9 points** répartis sur la surface du bouton, pas seulement
son centre : un recouvrement partiel — le symptôme « ça ne marche qu'à certains endroits
» — est invisible autrement. En dessous de `9/9`, le champ `BLOQUÉ_PAR` nomme les
éléments qui interceptent le clic.

## Blocs supplémentaires

Le rapport comprend aussi `offre` (ancres de la modale vues par `offer-agent.ts`, via
`VF_OFFER_DIAGNOSE`) et `donneesDeTri`, qui compte les favoris déjà enregistrés
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

`enAttenteDeFiche` compte les articles dont la fiche est en cours de lecture. Il doit
retomber à zéro en quelques secondes ; s'il stagne, les requêtes échouent —
`debug.enrichFailed` et `debug.lastError`, côté `catalogue`, disent pourquoi.

`categorieApprochee` compte les articles dont la catégorie vient de la page de
navigation et non de leur fiche (`exact: false`) — voir
[limitations.md](limitations.md#catégorie). Côté page, le bloc `catalogue` porte
`categorie` : le fil d'Ariane lu sur la page courante, ou le message expliquant qu'il
n'y en a pas.

`sansLikes` compte les articles **déjà enregistrés** sans nombre de favoris : ceux
d'avant l'extraction du champ. Les réenregistrer (un clic pour retirer, un pour
remettre) les complète. `sansLikes` égal au total sur des articles récents signale en
revanche que l'ancre a cassé — voir [vinted-dom.md](vinted-dom.md).

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
place de `catalogue` et `offre`) : il se lit dans le storage, pas dans la page. Pour
l'exploiter ailleurs que dans la fenêtre de 220 px du panneau, **Exporter** livre le
même contenu en fichier.

## Table de lecture

| Symptôme                                                         | Interprétation                                                                       |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `cardsFound: 0` sur une recherche                                | Vinted a changé ses `data-testid` → [vinted-dom.md](vinted-dom.md)                   |
| `cardsFound > cardsParsed`                                       | Des cartes ont une structure inattendue                                              |
| `cardsParsed > cardButtons`                                      | L'injection échoue — conteneur d'image introuvable                                   |
| `blockCardsFound: 0` alors que le dressing du membre est visible | Le préfixe de testid des cartes de bloc a changé → [vinted-dom.md](vinted-dom.md)    |
| `blocsArticles: []` sur une fiche                                | Le conteneur `item-page-{plugin}-plugin` a changé de nom                             |
| `missing.title > 0`                                              | Le format du libellé d'accessibilité a changé                                        |
| `detailButton: "ABSENT"`                                         | `extractFromDetail()` renvoie `null` — voir `detailExtraction`                       |
| `detailJsonLd: false`                                            | Le JSON-LD a disparu, on est retombé sur les replis                                  |
| `clickablePoints` < `9/9`                                        | Un élément Vinted recouvre le bouton → voir `BLOQUÉ_PAR`                             |
| `debug.clicks` reste à 0 après un clic                           | Le clic n'atteint pas le bouton → [pitfalls.md](pitfalls.md)                         |
| `debug.clicks > debug.writes`                                    | Le clic arrive mais l'écriture échoue → voir `lastError`                             |
| `debug.enrichFailed` grimpe                                      | Vinted refuse la lecture des fiches → les articles restent aux données de leur carte |
| `enAttenteDeFiche` ne redescend pas                              | Requêtes bloquées ou très lentes ; l'article reste utilisable                        |
| `lastError: "Extension context invalidated"`                     | Extension rechargée sans recharger l'onglet — Cmd+R sur Vinted                       |

## Étendre le rapport

`diagnose()` vit dans `content.ts` et répond au message `VF_DIAGNOSE`. Y ajouter un
champ coûte quelques lignes et fait gagner un aller-retour de debug — c'est souvent plus
rentable que d'inspecter à la main dans la console, puisque le content script tourne
dans un monde isolé peu commode à atteindre.
