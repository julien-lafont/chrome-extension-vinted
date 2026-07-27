# Limites connues

## Périmètre

**`vinted.fr` uniquement.** Titre, taille et état d'une carte viennent du libellé
d'accessibilité en français (`", marque:"`, `", état:"`, `", taille:"`). Étendre
aux autres domaines Vinted demande d'ajouter les variantes de ces séparateurs —
voir `LABEL_FIELDS` dans `content.js` et [vinted-dom.md](vinted-dom.md). L'échelle
des états, elle, est reconnue par vocabulaire français dans `sorting.js`.

**Stockage local à un profil Chrome.** Pas de synchronisation entre machines :
`chrome.storage.sync` est plafonné à 100 Ko, trop juste. L'export JSON du panneau
permet un transfert manuel.

**Articles vendus.** Un article retiré de Vinted reste dans la liste, mais son
image peut renvoyer une 404. Aucune vérification de disponibilité n'est faite.

## Données de tri incomplètes

**Les articles enregistrés avant l'extraction des champs de tri gardent leurs
lacunes.** `favouriteCount` et `priceValue` n'existaient pas ; une taille pouvait
recevoir un état (`"Très bon état"`) sur les articles sans taille. Rien ne
recalcule ces champs a posteriori — la donnée n'est lisible que sur la page
Vinted. Les réenregistrer depuis le site (un clic pour retirer, un pour remettre)
les remet à niveau ; le [Diagnostic](diagnostic.md) les compte sous
`donneesDeTri`.

**Le nombre de favoris de la fiche article est lu dans le flux d'hydratation.**
Le bouton cœur de la fiche arrive vide et désactivé, Vinted l'hydrate côté client.
Le compteur est donc extrait du flux React Server Components — plus fragile que le
DOM, mais disponible dès le chargement. Le bouton hydraté reste prioritaire s'il
porte le nombre. Sur les cartes du catalogue, la lecture est directe et sûre.

**Le prix numérique est déduit de la chaîne affichée sur le catalogue** (`"12,00 €"`),
et lu tel quel dans le JSON-LD sur la fiche. Un prix illisible exclut l'article
des remises et le relègue en fin de tri.

## Catégorie

**Une carte de catalogue ne porte pas sa catégorie.** Ni dans le DOM, ni dans le
flux d'hydratation — l'objet article y expose `size_title`, `status`,
`favourite_count`, mais aucun `catalog_id`. C'est la raison d'être de
l'enrichissement par la fiche (voir [architecture.md](architecture.md)) : la
catégorie enregistrée est donc exacte, une fois la fiche lue.

Les valeurs approchées (`exact: false`) ne subsistent que dans deux cas : une
fiche que le `fetch` n'a jamais pu lire, et les articles enregistrés avant la mise
en place de l'enrichissement. Le [Diagnostic](diagnostic.md) les compte
(`categorieApprochee`, `sansCategorie`, `enAttenteDeFiche`).

**L'enrichissement dépend d'une requête vers Vinted.** Une seule à la fois, en
tâche de fond, avec 15 s d'expiration. Si Vinted venait à la bloquer (403, page
anti-bot, redirection de connexion), l'article resterait avec les données de sa
carte — visiblement incomplet mais jamais perdu, et sans erreur bloquante. Aucun
repli n'est prévu.

**Le repli sans fil d'Ariane n'a pas d'URL.** Si le fil disparaît de la fiche, le
JSON-LD fournit encore un nom (`"Hommes Chaussures de foot"`) mais aucun
identifiant : de quoi afficher la catégorie, pas de quoi relancer la recherche.

## Autres

**Échelles de taille non comparables.** Mélanger « M » et « 38 » dans une même
collection produit deux blocs ordonnés l'un après l'autre — alphabétiques d'abord
(XXXS → XXXL), puis numériques (34, 36, 38…). Il n'existe pas de correspondance
fiable entre les deux.

Un article sans donnée exploitable pour le tri courant finit **toujours** en bas de
liste, dans les deux sens : une donnée manquante ne doit pas remonter
artificiellement en tête. L'en-tête du panneau indique combien d'articles sont
dans ce cas.

## Offres

**Ancres non vérifiées en production.** Les `data-testid` de la modale d'offre sont
des candidats plausibles, pas des relevés — contrairement aux ancres du catalogue
et de la fiche article. Lancer le [Diagnostic](diagnostic.md) sur une fiche pour
confirmer, et ajuster `ANCHORS` dans `offer-agent.js`. Les replis par libellé
couvrent le cas où les `testid` diffèrent.

**Message envoyé séparément de l'offre.** La modale d'offre Vinted ne comporte pas
de champ message ; l'agent passe donc par la conversation dans un second temps,
après avoir attendu que l'onglet se stabilise — valider une offre fait naviguer
Vinted. Si cette étape échoue, l'offre reste envoyée : le panneau le dit
explicitement et propose **Copier** pour envoyer le texte à la main.

**Le message n'est jamais envoyé à l'aveugle.** L'agent exige une preuve que la
page affichée concerne bien l'article visé — l'URL de la fiche, ou un lien vers
elle dans la conversation. Sur une messagerie dont la structure aurait changé, il
renoncera plutôt que de risquer d'écrire au mauvais vendeur ; c'est un compromis
délibéré en faveur du repli manuel.

**L'offre part réellement à la validation.** Le récapitulatif affiché avant l'envoi
est le seul point de contrôle : il n'y a pas de mode simulation.

## Couverture de test

Le panneau latéral (collections, tri, glisser-déposer, offres) n'est pas couvert
par les tests automatisés, qui portent uniquement sur le content script. Voir
[testing.md](testing.md#ce-que-les-tests-ne-couvrent-pas).
