# Limites connues

## Périmètre

**`vinted.fr` uniquement.** Titre, taille et état d'une carte viennent du libellé
d'accessibilité en français (`", marque:"`, `", état:"`, `", taille:"`). Étendre aux
autres domaines Vinted demande d'ajouter les variantes de ces séparateurs — voir
`LABEL_FIELDS` dans `content.ts` et [vinted-dom.md](vinted-dom.md). L'échelle des états,
elle, est reconnue par vocabulaire français dans `sorting.ts`.

**Stockage local à un profil Chrome.** Pas de synchronisation entre machines :
`chrome.storage.sync` est plafonné à 100 Ko, trop juste. L'export JSON du panneau permet
un transfert manuel.

**Articles vendus.** Vérifiés par le bouton « Rafraîchir » du panneau et par le
déclencheur silencieux à l'ouverture (au-delà de deux heures) — voir
[docs/specs/suivi-prix.md](specs/suivi-prix.md). Aucun rafraîchissement n'a lieu sans
onglet Vinted ouvert : un article resté longtemps sans onglet Vinted actif garde l'état
de sa dernière vérification, éventuellement périmé.

**Le cycle n'avance que sur un onglet Vinted au premier plan.** Contrainte structurelle
(§1 et §3.6 de la spec) : les requêtes partent du content script, et un onglet caché
voit ses minuteurs bridés par Chrome. Changer d'onglet en cours de cycle ne le perd pas
— il se met en pause et reprend au retour, avec un rappel affiché sous la barre de tri —
mais un rafraîchissement complet demande de laisser l'onglet Vinted devant soi. Au bout
d'un quart d'heure en arrière-plan, le cycle rend la main et le suivant repartira d'une
file recomposée.

## Données de tri incomplètes

**Un champ de tri illisible à l'enregistrement le reste.** `favouriteCount` et
`priceValue` sont extraits une fois pour toutes ; si l'ancre a cassé ce jour-là, rien ne
les recalcule a posteriori — la donnée n'est lisible que sur la page Vinted.
Réenregistrer l'article depuis le site (un clic pour retirer, un pour remettre) le remet
à niveau ; le [Diagnostic](diagnostic.md) compte les manques sous `donneesDeTri`.

**Le nombre de favoris de la fiche article est lu dans le flux d'hydratation.** Le
bouton cœur de la fiche arrive vide et désactivé, Vinted l'hydrate côté client. Le
compteur est donc extrait du flux React Server Components — plus fragile que le DOM,
mais disponible dès le chargement. Le bouton hydraté reste prioritaire s'il porte le
nombre. Sur les cartes du catalogue, la lecture est directe et sûre.

**Le prix numérique est déduit de la chaîne affichée sur le catalogue** (`"12,00 €"`),
et lu tel quel dans le JSON-LD sur la fiche. Un prix illisible exclut l'article des
remises et le relègue en fin de tri.

**La taille est filtrée exactement — mais pas toujours.** Aucune page ne porte le
`size_id` de l'article : il est résolu après l'enregistrement, depuis le libellé et la
catégorie, par la seule requête d'API du projet (voir
[vinted-dom.md](vinted-dom.md#la-table-des-tailles-dune-catégorie)). Trois cas laissent
l'article sans identifiant, et la recherche retombe alors sur le texte :

- **la catégorie n'est pas exacte** — fiche jamais lue : la table d'un rayon large est
  ambiguë, on ne demande donc rien ;
- **le libellé est ambigu dans sa catégorie** : « M » vaut 208 en vêtements, 1390 en
  chapeaux, 1426 en gants. Sur une catégorie feuille — la seule qu'on enregistre — le
  cas ne s'est pas présenté, mais le renoncement est explicite ;
- **l'API n'a pas répondu** : 403, coupure, ou 5 s d'expiration.

Le [Diagnostic](diagnostic.md) compte les deux issues sous `debug.sizesResolved` et
`debug.sizesUnresolved`.

**La description est enregistrée mais inexploitée.** Elle vient du JSON-LD, tronquée à 1
200 caractères, et n'est ni affichée ni cherchable. C'est une capture d'avance : la
relire plus tard supposerait de recharger toutes les fiches.

**Le vendeur est connu par son identifiant, son pseudo, sa note, son nombre
d'évaluations et son pays** — voir la section « Vendeur » plus bas pour ce qui manque
encore.

## Catégorie

**Une carte de catalogue ne porte pas sa catégorie.** Ni dans le DOM, ni dans le flux
d'hydratation — l'objet article y expose `size_title`, `status`, `favourite_count`, mais
aucun `catalog_id`. C'est la raison d'être de l'enrichissement par la fiche (voir
[architecture.md](architecture.md)) : la catégorie enregistrée est donc exacte, une fois
la fiche lue.

Les valeurs approchées (`exact: false`) ne subsistent que sur les articles dont le
`fetch` n'a jamais pu lire la fiche. Le [Diagnostic](diagnostic.md) les compte
(`categorieApprochee`, `sansCategorie`, `enAttenteDeFiche`).

**L'enrichissement dépend d'une requête vers Vinted.** Une seule à la fois, en tâche de
fond, avec 15 s d'expiration. Si Vinted venait à la bloquer (403, page anti-bot,
redirection de connexion), l'article resterait avec les données de sa carte —
visiblement incomplet mais jamais perdu, et sans erreur bloquante. Aucun repli n'est
prévu.

**Le repli sans fil d'Ariane n'a pas d'URL.** Si le fil disparaît de la fiche, le
JSON-LD fournit encore un nom (`"Hommes Chaussures de foot"`) mais aucun identifiant :
de quoi afficher la catégorie, pas de quoi relancer la recherche.

## Autres

**Échelles de taille non comparables.** Mélanger « M » et « 38 » dans une même
collection produit deux blocs ordonnés l'un après l'autre — alphabétiques d'abord (XXXS
→ XXXL), puis numériques (34, 36, 38…). Il n'existe pas de correspondance fiable entre
les deux.

Un article sans donnée exploitable pour le tri courant finit **toujours** en bas de
liste, dans les deux sens : une donnée manquante ne doit pas remonter artificiellement
en tête. L'en-tête du panneau indique combien d'articles sont dans ce cas.

## Vendeur

**Le pays coûte une requête, et n'arrive pas toujours.** Il n'est sur aucune fiche : il
faut lire `/member/{id}`, ce qui se fait après l'enregistrement, en tâche de fond. Trois
cas où le drapeau n'apparaît pas, et ils ne se distinguent pas à l'œil : le membre
n'expose pas sa localisation, la requête a échoué, ou la fiche n'a jamais été lue. Seul
le [Diagnostic](diagnostic.md) les sépare (`debug.sellerProfiles` /
`sellerProfilesEmpty`).

**Le pays n'est jamais rafraîchi**, délibérément : celui d'un compte ne change pas, et
relire un profil par article coûterait une requête pour rien.

**Pas de drapeaux sous Windows.** Chrome n'y embarque pas les glyphes d'indicateurs
régionaux et affiche le code en deux lettres (« DE »). Le nom complet du pays reste dans
l'infobulle, dans les deux cas.

**Ancienneté du compte et délai de réponse ne sont pas capturés.** Le premier n'est
servi nulle part (aucun `created_at` dans le HTML de la fiche ni du profil) ; le second
n'existe qu'après hydratation côté client, hors de portée d'une lecture par `fetch()`.

**Note et évaluations ne sont pas rattrapées.** Comme la galerie et les identifiants,
elles n'arrivent qu'avec la lecture de la fiche, et un article dont le `fetch` a échoué
reste sans. Le cycle de veille relit pourtant ces fiches — propager la réputation au
passage ne coûterait aucune requête, et reste à faire.

## Offres

Voir [docs/specs/offres.md](specs/offres.md) pour le mécanisme ; ce qui suit est ce
qu'il ne fait pas.

**Une offre n'apparaît qu'après un balayage**, déclenché à l'ouverture du panneau et au
plus une fois par demi-heure — et jamais sans onglet Vinted ouvert, l'API refusant les
requêtes sans cookies de session. Une offre faite à l'instant peut donc mettre quelques
minutes à s'afficher.

**Le premier balayage est étalé.** L'historique se lit par tranches de 40 conversations,
une par ouverture du panneau : sur une messagerie de plusieurs centaines d'échanges, les
offres les plus anciennes n'apparaissent qu'au bout de quelques sessions. Les plus
récentes, elles, arrivent au premier passage.

**L'état d'une proposition du vendeur est déduit, pas lu.** Ces messages
(`offer_message`) ne portent aucun statut : « en attente » n'est affiché que sur une
transaction explicitement ouverte, et tout le reste est présenté comme éteint. Une
proposition en cours peut donc apparaître grisée si Vinted introduit un code de
transaction inconnu.

**Aucune action.** L'extension ne fait, n'accepte ni ne refuse d'offre : la lecture est
sans effet de bord, écrire exigerait le `X-CSRF-Token` et engagerait l'utilisateur.

**Rien sur les offres reçues en tant que vendeur.** Elles vivent dans la même messagerie
et sont écartées délibérément (`current_user_side`).

## Galerie de photos

**Un article dont la fiche n'a pas été lue n'en a pas.** Rien ne va chercher `images`
après coup : sa miniature ouvre l'onglet Vinted. Le réenregistrer (un clic pour retirer,
un pour remettre) lui donne la galerie — c'est le même geste que pour compléter un
nombre de favoris manquant.

**Les URLs d'images sont signées, et on ignore leur durée de vie.** Le `?s=…` qui les
termine est lié à l'URL exacte : rien ne peut être reconstruit, et si Vinted fait
expirer ces signatures, la galerie d'un vieil article affichera des images cassées. Le
cas n'a pas été observé, et le risque existe déjà pour `imageUrl`, stocké de la même
façon depuis le début. Le réenregistrement rafraîchit tout.

**Le repli DOM plafonne à 600×800.** Quand le bloc `gallery` du flux d'hydratation est
introuvable — après une navigation SPA, ou s'il change de nom — la galerie se rabat sur
le carrousel de la page, qui ne sert que la taille d'affichage. Elle reste complète et
utilisable ; seul le zoom pleine résolution est perdu. Le [Diagnostic](diagnostic.md)
distingue les deux voies.

## Recherche ailleurs

**Sans photo Vinted exploitable, la recherche retombe sur le texte.** Voir
[docs/specs/recherche-inversee.md](specs/recherche-inversee.md). Un article dont
`images` est absent (fiche jamais lue) ou dont la photo n'est pas hébergée sur un
domaine Vinted connu perd la recherche par image, silencieusement pour le module — mais
le `title` du bouton l'annonce (« pas de photo lisible »).

**`lens.google.com/uploadbyurl` n'est pas une API publiée.** Google peut le changer, le
retirer, ou exiger une session connectée sans préavis, auquel cas le bouton ouvrirait un
onglet qui ne montre pas ce qu'on attend. Rien ne détecte cet échec côté extension —
c'est un lien externe, pas un appel dont on lit la réponse.

## Couverture de test

Le panneau latéral n'est couvert qu'en partie. Ses modules testables isolément le sont
(tri, `pickSlot()` du glisser-déposer, URLs de recherche — Vinted comme externe —,
visionneuse de photos) ; son orchestration — `sidepanel.ts`, le rendu de la liste, les
collections à l'écran — ne l'est pas. Voir
[testing.md](testing.md#ce-que-les-tests-ne-couvrent-pas).
