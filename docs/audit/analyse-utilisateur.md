# Analyse utilisateur — regard d'un chineur sur Vinted Smart Bookmarks

> Audit du 27 juillet 2026, sur la base du code de la v0.2.0.
>
> Posture adoptée : celle d'un utilisateur régulier de Vinted qui cherche des pièces de
> qualité au meilleur prix — des vraies pièces, rares, noyées dans le volume médiocre du
> site. Pas celle d'un vendeur, pas celle d'un acheteur occasionnel. Le document juge
> l'extension **à cet usage-là**, puis évalue la faisabilité technique de chaque piste
> dans le code existant.

## 1. Qui parle, et ce qu'il fait vraiment

Le chineur ne « fait pas ses courses » sur Vinted. Il opère une veille. Concrètement,
sur une semaine type :

- il rejoue les mêmes 15 à 40 requêtes tous les jours, souvent plusieurs fois par jour,
  et **rescanne à chaque fois les mêmes résultats** : sur une recherche « Barbour taille
  40 », 90 % de ce qu'il voit lundi, il l'a déjà écarté dimanche ;
- il ouvre 20 onglets, en garde 3, et perd les 17 autres ;
- sur une pièce rare correctement décrite, la fenêtre de décision est de **quelques
  minutes** — les bonnes affaires partent dans l'heure, souvent avant qu'un favori natif
  ait servi à quoi que ce soit ;
- il négocie presque systématiquement, et perd le fil de ce qu'il a proposé, à qui, et
  quand ;
- il doute constamment sur deux points que la fiche ne dit pas directement : **est-ce
  que ça taille** (mesures dans la description, pas dans les attributs) et **est-ce que
  c'est authentique** (marque + prix trop bas + vendeur récent = signal) ;
- il ne sait jamais si le prix affiché est bon, sauf à ouvrir 6 onglets pour comparer
  avec les autres exemplaires en vente.

Trois questions dominent sa journée, dans cet ordre :

1. **« Est-ce que c'est nouveau ? »** — ce que je regarde, l'ai-je déjà vu et écarté ?
2. **« Est-ce que c'est une affaire ? »** — ce prix, comparé à quoi ?
3. **« Est-ce que je peux encore l'avoir ? »** — c'est toujours dispo, le prix a-t-il
   bougé, ma négo en est où ?

## 2. Verdict d'ensemble

### Ce que l'extension réussit déjà, et qu'il faut préserver

- **La capture est excellente.** Un clic sur une carte enregistre immédiatement, puis la
  fiche complète en tâche de fond (`content.ts`, `enrichFromDetail()`). C'est exactement
  le bon compromis : zéro attente ressentie, donnée fiable à l'arrivée. La règle « une
  seule extraction fait foi » est un choix d'architecture rare et payant.
- **Le classement en collections est mieux que les favoris natifs de Vinted**, qui n'en
  ont aucun. Les onglets, le glisser-déposer sur un onglet, la collection non
  supprimable tant qu'elle est pleine : rien à redire.
- **Le local-only est un vrai argument.** Pas de compte, pas de serveur,
  `chrome.storage.local` seul, deux permissions (`storage`, `sidePanel`). C'est
  défendable et c'est un différenciant face aux extensions Vinted qui existent.
- **La rigueur d'ingénierie** (règles anti-boucle, `pointerdown`, ancrage `data-testid`,
  diagnostic intégré) est nettement au-dessus de la moyenne du genre. Les
  fonctionnalités proposées ci-dessous doivent s'y plier, pas la contourner.

### Le diagnostic, en une phrase

> **C'est un presse-papiers d'articles remarquablement bien fait — ce n'est pas encore
> un outil de chine.**

L'extension excelle à répondre à « qu'est-ce que j'ai mis de côté ? ». Elle est
**muette** sur les trois questions qui structurent réellement la journée du chineur. Il
en découle quatre angles morts :

| Angle mort    | Ce qui manque                                                                                                             | Conséquence vécue                                                                              |
| ------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| **Le temps**  | Rien n'est jamais relu après l'enregistrement. Un favori de mars 2026 affiche encore son prix de mars et son image morte. | Je ne sais pas ce qui est vendu, ce qui a baissé, ce qui est encore jouable. Ma liste pourrit. |
| **Le marché** | Aucun point de comparaison. « 45 € » ne veut rien dire seul.                                                              | Je continue d'ouvrir 6 onglets pour savoir si c'est cher.                                      |
| **Le bruit**  | Aucun moyen d'écarter durablement un article, un vendeur, un mot-clé.                                                     | Je rescanne les mêmes rebuts tous les jours. C'est le coût caché n°1 de Vinted.                |
| **Le retour** | Une offre part et disparaît. Aucune trace, aucun statut, aucune relance.                                                  | Je ne sais plus ce que j'ai proposé ni si j'ai eu une réponse.                                 |

Le reste de ce document découle de ces quatre lignes.

## 3. Frictions immédiates — le petit bois, à ramasser d'abord

Ce ne sont pas des fonctionnalités : ce sont des irritants qui se corrigent en quelques
heures chacun et qui coûtent cher à l'usage quotidien.

### 3.1 L'export est un cul-de-sac : il n'y a pas d'import

`exportJson()` (`sidepanel.ts:791`) produit un JSON complet — collections, ordre,
articles. **Rien ne sait le relire.** `docs/limitations.md` présente pourtant l'export
comme la parade au « pas de synchro entre machines ». Ce n'est pas une parade, c'est un
fichier qu'on ne peut que regarder. Changer de machine, ou récupérer après un profil
Chrome effacé, signifie tout reperdre.

C'est le manque le plus disproportionné du projet : effort/impact imbattable. Un import
avec choix `fusionner` / `remplacer`, validant la forme et ignorant les articles déjà
présents, tient dans une centaine de lignes de `store.ts`.

### 3.2 La suppression est instantanée et définitive

`removeItem()` est câblé directement sur le clic (`sidepanel.ts:327`). Pas de
confirmation, pas d'annulation. Sur un panneau étroit où les icônes sont serrées, la
mauvaise ligne part sans recours — et avec elle une pièce qu'on cherchait depuis six
mois. Un `flash()` « Article retiré · Annuler » de 5 s existe déjà comme mécanisme
(`sidepanel.ts:87`) : il ne reste qu'à y accrocher une restauration.

### 3.3 La catégorie est extraite avec grand soin… et jamais montrée

Tout le travail d'`ItemCategory` (fil d'Ariane, `exact`, chemin complet) sert
**uniquement** à construire des URLs de recherche. La ligne de méta (`renderItem()`,
`sidepanel.ts:269`) affiche marque · taille · état · ♥, jamais la catégorie. On ne peut
ni la voir, ni filtrer dessus, ni trier dessus. Une collection « Vestes » de 80 articles
ne peut pas être scindée entre bombers et parkas alors que la donnée est là, exacte,
dans le storage.

### 3.4 La recherche du panneau est trop pauvre pour une grosse liste

`matches()` (`sidepanel.ts:116`) fait un `includes` sur cinq champs concaténés, **et
seulement dans la collection active**. Passé 200 articles, il manque : la recherche
transverse à toutes les collections (« où j'ai rangé ce Lacoste ? »), les filtres
numériques (`< 40 €`), les filtres par état/catégorie, et l'exclusion (`-nike`).
Aujourd'hui, chercher « 40 » remonte les prix à 40 €, les tailles 40 et les titres
contenant 40.

### 3.5 Petits manques d'affichage

- **La date d'ajout est triable mais invisible.** On peut trier par ancienneté sans
  jamais savoir si un article date de 3 jours ou de 4 mois — précisément l'information
  qui dit si ça vaut encore le coup d'y croire.
- **Aucune sélection multiple.** Déplacer 30 articles vers une nouvelle collection se
  fait un par un, au menu contextuel.
- **Pas de « tout ouvrir »** sur une collection filtrée, alors que le geste naturel du
  chineur est de comparer 8 candidats dans 8 onglets.
- **Aucune note personnelle.** « vu en vrai, tissu décevant », « attendre la baisse », «
  mesure épaules à demander » n'ont nulle part où aller.

## 4. Fonctionnalités à développer

Chaque entrée donne : le besoin réel, la proposition, la faisabilité dans **ce** code,
les pièges, l'effort estimé (S ≈ 1 jour, M ≈ 2-4 jours, L ≈ 1 semaine et plus).

### A. Suivi de prix et de disponibilité — **la priorité n°1** · effort M

**Le besoin.** Un favori est une hypothèse d'achat en attente. Aujourd'hui l'hypothèse
ne se vérifie jamais. Trois choses arrivent à un article suivi, et aucune n'est visible
: il se vend, il baisse, il est remonté par le vendeur. La première rend la ligne
inutile, la deuxième est exactement le déclencheur d'achat qu'on attendait.

**La proposition.**

- Un rafraîchissement périodique des favoris, qui rejoue la lecture de fiche déjà écrite
  (`extractFromDetail()` sur un document `fetch`é — le mécanisme existe intégralement,
  il ne lui manque qu'un déclencheur).
- Trois nouveaux champs sur `SavedItem` : `lastCheckedAt`, `status`
  (`'active' | 'sold' | 'gone'`), et `priceHistory: { at: number; value: number }[]`.
- Dans le panneau : badge **Vendu** (ligne grisée, barrée, jamais supprimée d'office),
  badge **−15 % depuis l'ajout** en vert, et un mode de tri **« Baisse de prix »**.
- Un filtre « masquer les vendus », et une action groupée « archiver les vendus ».

**Faisabilité.** Élevée, le gros du travail est déjà fait. `extractFromDetail()` prend
un `Document` quelconque, la file d'enrichissement (`enrichQueue`, une requête à la
fois) est exactement le débit qu'il faut. Il faut ajouter la permission `alarms` et un
planificateur dans le service worker (aujourd'hui six lignes).

**Pièges à ne pas sous-estimer.**

1. **Une requête depuis le service worker n'est pas une requête depuis l'onglet.** Les
   cookies `SameSite=Lax` de la session Vinted ne partiront pas forcément : la fiche
   reviendra en version déconnectée. Ce n'est pas bloquant (`docs/vinted-dom.md` établit
   que prix, JSON-LD et fil d'Ariane sont rendus côté serveur sans session), mais il
   faut le vérifier avant de bâtir dessus. Le repli propre : déléguer le
   rafraîchissement à un onglet Vinted ouvert quand il y en a un, et ne tomber sur le
   service worker qu'à défaut.
2. **La détection de « vendu » doit être conservatrice.** Une 404, une redirection, un
   `availability` qui n'est plus `InStock` : trois signaux différents. Le garde-fou
   existant — refuser une fiche dont l'id ne correspond pas — doit être conservé tel
   quel. En cas de doute : ne rien changer plutôt que marquer vendu à tort.
3. **Le débit.** 300 favoris × un rafraîchissement horaire = 7 200 requêtes/jour vers
   Vinted, ce qui est une invitation au blocage. Viser un cycle **quotidien** par
   défaut, séquentiel, avec un intervalle plus court réservé à une éventuelle « liste
   courte » explicitement surveillée (voir L).
4. **Le quota.** Un point d'historique ≈ 20 octets ; 300 articles × 365 points = 2 Mo
   sur les 10 Mo disponibles. Il faut donc **borner** : un point seulement quand le prix
   change, plafonné à N entrées par article.

### B. Prix de référence et score d'affaire · effort M/L

**Le besoin.** « 45 € » ne signifie rien. « 45 €, alors que les 30 derniers exemplaires
comparables se sont affichés autour de 78 € » signifie tout. C'est la question n°2 du
chineur, et aucune extension locale ne la traite honnêtement.

**La proposition.** Sur demande (jamais automatiquement, cf. pièges), un bouton **«
Situer le prix »** sur un article : l'extension rejoue la recherche similaire — que
`search.ts` sait déjà construire — lit les prix de la première page de résultats, et
affiche une médiane, un intervalle interquartile, et le positionnement de l'article
dedans.

Rendu attendu, en une ligne :
`45 € — médiane 78 € sur 42 offres comparables · dans les 10 % les moins chers`.

**Faisabilité.** Bonne, avec une réserve importante : la qualité du repère dépend
entièrement de la qualité du filtre. Or `similarSearchUrl()` passe aujourd'hui la marque
et la taille en **recherche textuelle** faute d'identifiants (voir M ci-dessous). Une
médiane calculée sur un échantillon mal filtré est pire qu'aucune médiane : elle donne
une fausse confiance. **B dépend de M** — il ne faut pas livrer B avant que les
identifiants soient exacts.

**Pièges.**

- **Ne jamais présenter ça comme une estimation de valeur.** C'est un prix d'affichage
  médian, pas un prix de vente réel : sur Vinted, une bonne partie du stock ne se vend
  jamais et tire la médiane vers le haut. Le libellé doit dire « offres comparables en
  ligne », pas « valeur ».
- **Sur demande uniquement**, et mis en cache par (catégorie, marque, taille) pendant
  quelques jours. Calculer ça pour 300 favoris en tâche de fond, c'est 300 pages de
  catalogue chargées : le meilleur moyen de se faire bloquer.
- L'échantillon doit être **affiché** (« sur 42 offres ») : sous 15 résultats, mieux
  vaut afficher « pas assez de comparables » que d'inventer une médiane.

### C. Veille sur recherches sauvegardées · effort L

**Le besoin.** C'est le seul moyen d'arrêter de rescanner à la main. Vinted a bien des
notifications de recherche sauvegardée, mais elles sont bruyantes, mal filtrées, et
n'excluent rien.

**La proposition.** Une deuxième nature d'objet dans le panneau, à côté des collections
: une **recherche suivie**, capturée en un clic depuis n'importe quelle page de
catalogue (l'URL courante et ses filtres sont là, il suffit de les mémoriser).
L'extension la rejoue à intervalle choisi, garde en mémoire les ids déjà vus, et ne
présente que **les nouveautés depuis la dernière visite** — avec un compteur par
recherche, comme un lecteur RSS.

C'est la fonctionnalité qui change le plus la vie du chineur : elle transforme 40
minutes de scroll quotidien en 2 minutes de revue d'inédits.

**Faisabilité.** Le parsing d'une page de catalogue est déjà écrit (`extractFromCard()`
fonctionne sur n'importe quel `Document`, y compris `fetch`é). Le travail réel est
ailleurs : nouveau modèle (`SavedSearch`), nouvel écran, gestion du « déjà vu »,
planification. D'où le L.

**Pièges.**

- **Le changement de nature de l'extension.** On passe de « réagit à mes clics » à «
  interroge Vinted en tâche de fond ». La promesse « rien ne sort du navigateur » reste
  vraie (aucune donnée envoyée à un tiers), mais l'empreinte réseau vers Vinted change.
  Cela doit être **explicitement opt-in**, avec la cadence visible et réglable, et un
  interrupteur global de pause.
- **Le volume.** Une recherche large (« Nike ») remonte des milliers de résultats : ne
  lire que la première page, et exiger de l'utilisateur qu'il resserre.
- **Ne pas notifier trop.** Voir §6 : une notification système par nouveauté est le
  meilleur moyen de faire désinstaller l'extension. Un badge sur l'icône et un compteur
  dans le panneau suffisent.

### D. Filtrage du bruit dans le catalogue — **le meilleur rapport effort/plaisir** · effort S/M

**Le besoin.** Question n°1 du chineur : « est-ce que c'est nouveau ? ». Aujourd'hui, la
réponse est dans sa mémoire, et sa mémoire sature à la troisième page.

**La proposition.** Sur la page de catalogue elle-même, à côté du marque-page déjà
injecté :

- un bouton **« Écarter »** (👁 barré) qui grise ou masque définitivement la carte, sur
  toutes les recherches, pour toujours — avec un compteur « 34 articles masqués ·
  afficher » en haut de page pour rester réversible ;
- **« Masquer ce vendeur »**, pour les revendeurs pros qui saturent une niche avec du
  stock réimporté ;
- une **liste de mots exclus** (« style », « inspiré », « réplique », « lot », « enfant
  ») qui grise les cartes correspondantes ;
- un marquage discret des articles **déjà enregistrés** dans une collection —
  aujourd'hui l'icône pleine le dit, ce qui est déjà bien : il manque juste le nom de la
  collection au survol (« déjà dans Vestes »).

**Faisabilité.** Excellente. Le bouton s'injecte au même endroit et par le même chemin
que l'existant (`injectCardButton()`), et une quatrième clé de storage (`hiddenItems`,
`hiddenSellers`, `mutedWords`) suffit. C'est **la fonctionnalité la plus rentable du
document** : quelques centaines de lignes, un gain quotidien immédiat.

**Pièges.** Deux règles du projet s'appliquent de plein fouet : le repeint doit rester
idempotent (règle 3 — masquer une carte est une mutation du DOM, donc un déclencheur
potentiel de boucle : masquer par classe CSS avec garde `vfHidden`, jamais par
`remove()`), et le bouton doit respecter la règle 2 (`user-select: none`, pas de
`transform` au `:hover`). Prévoir aussi le cas « j'ai écarté par erreur » : l'annulation
immédiate est indispensable.

Le masquage par vendeur suppose de connaître le vendeur depuis une carte : `seller_id`
apparaît dans le flux d'hydratation (`docs/vinted-dom.md`, section favoris), il faut
vérifier qu'il est atteignable côté carte, sinon rabattre cette sous-fonctionnalité sur
la fiche seule.

### E. Signal de confiance vendeur · effort M

**Le besoin.** Sur une pièce rare à 150 €, le vendeur compte autant que l'article. Note
moyenne, nombre d'évaluations, ancienneté du compte, pays (frais et délais de douane),
délai de réponse : tout est sur la fiche vendeur, aucun de ces éléments n'est capturé.
Et le trio « marque désirable + prix anormalement bas + compte récent sans évaluation »
est le signal de contrefaçon le plus fiable qui soit.

**La proposition.** Capturer à l'enrichissement le bloc vendeur de la fiche (nom, note,
nombre d'avis, pays), l'afficher en ligne de méta secondaire, et permettre de
trier/filtrer dessus. Puis, sur cette base, un **avertissement discret** — jamais une
accusation — quand prix, marque et profil vendeur se combinent mal.

**Faisabilité.** Moyenne : ce sont de nouvelles ancres DOM à relever sur une vraie
fiche, avec la fragilité que ça implique. À traiter comme le compteur de favoris :
source principale + repli, valeur `null` assumée plutôt qu'une valeur fausse. Le
`seller_id` du flux d'hydratation est un point de départ.

**Piège.** Formuler l'avertissement comme un signal, pas comme un verdict (« profil
récent, peu d'évaluations, prix très inférieur au marché — à vérifier »), sinon on
diffame des vendeurs légitimes qui débutent.

### F. Coût réel, tout compris · effort S

**Le besoin.** Le prix affiché n'est pas le prix payé : s'y ajoutent la protection
acheteurs et la livraison. Entre un article à 20 € livré en point relais et un à 18 € en
Mondial Relay depuis l'Italie, le classement s'inverse — et le tri « Prix » du panneau
ment.

**La proposition.** Un champ de réglages (montant fixe + pourcentage de protection, coût
de livraison par défaut, tous **modifiables** par l'utilisateur), un affichage « 24,80 €
tout compris » sous le prix, et un mode de tri sur ce total.

**Faisabilité.** Immédiate côté code : c'est un calcul dérivé, aucune extraction
supplémentaire n'est nécessaire pour la version paramétrée. La version exacte (lire les
frais réels affichés sur la fiche) est plus fiable mais dépend d'ancres non relevées.

**Piège.** Le barème de la protection acheteurs change et diffère selon les marchés.
**Ne jamais le coder en dur sans le rendre visible et modifiable** — un chiffre faux,
figé dans le code, produit un tri faux et silencieux, ce qui est exactement le type de
bug que ce projet s'attache à éviter partout ailleurs.

### G. Description, mesures et notes personnelles · effort S/M

**Le besoin.** « Est-ce que ça taille ? » est la question qui fait renoncer à un achat,
et la réponse est presque toujours dans la description en texte libre (« épaules 46,
longueur 68 »). Aujourd'hui la description **n'est pas stockée du tout**, alors que le
JSON-LD la porte (`description`, `docs/vinted-dom.md`) et que la fiche expose aussi
`color` et `upload_date` via `itemprop`.

**La proposition.**

- Stocker `description`, `color` et `uploadedAt` à l'extraction — trois lignes dans
  `extractFromDetail()`, aucune ancre nouvelle à inventer.
- Rendre la description **cherchable** depuis le panneau (elle contient les mesures, les
  défauts, la provenance).
- Repérer les motifs de mesure (`\d{2,3}\s?cm`, « épaules », « longueur », « pit to pit
  ») et les afficher en pastilles.
- Un champ **note personnelle** libre par article, plus des **tags** (`#àmesurer`,
  `#attendrebaisse`, `#vuenvrai`).

**Faisabilité.** Très bonne. `uploadedAt` a un intérêt propre : c'est l'ancienneté de
l'annonce, donc le levier de négociation le plus solide (un article en ligne depuis 3
mois a un vendeur nettement plus souple) — voir H.

**Piège.** Le quota. Une description Vinted fait 200 à 2 000 caractères ; 1 000 articles
≈ 2 Mo sur 10. Tronquer à ~1 000 caractères et le documenter.

### H. Suivi des offres · effort M

**Le besoin.** Le module d'offre est la partie la plus ambitieuse de l'extension — et la
seule sans mémoire. L'offre part, le panneau affiche « Offre envoyée », et **rien n'est
écrit**. Trois jours plus tard : ai-je proposé 32 ou 35 € ? A-t-il répondu ? Puis-je
relancer sans passer pour un importun ?

**La proposition.**

- Un historique par article : `offers: { at, price, message, outcome }[]`, avec
  `outcome` initialement `'sent'`, modifiable à la main (`accepted` / `refused` /
  `ignored`) — et, à terme, déductible du suivi de prix (un prix qui tombe exactement à
  ma proposition = acceptée).
- Dans la ligne : `Offre 32 € il y a 3 j · sans réponse`.
- Un tri/filtre **« offres en attente »**.
- Une **garde anti-doublon** : réouvrir la modale sur un article déjà négocié prévient
  et propose un montant cohérent plutôt que de repartir du réglage global.
- Une aide au montant qui utilise l'ancienneté de l'annonce (G) et le nombre de favoris
  : article en ligne depuis 2 mois avec 40 favoris et aucune vente → la remise proposée
  peut être plus agressive.

**Faisabilité.** Simple côté données. Le point délicat est `outcome`, qui n'est pas
observable directement sans lire la messagerie — d'où la saisie manuelle en premier
temps, l'automatisme plus tard.

**Piège.** Le module d'offre repose sur des ancres explicitement **non vérifiées en
production** (`docs/limitations.md`). Enrichir cette zone avant d'avoir confirmé les
ancres, c'est bâtir sur du sable : confirmer d'abord par le Diagnostic sur une vraie
fiche.

### I. Import, sauvegarde, portabilité · effort S

Voir §3.1. À traiter en premier, indépendamment de tout le reste : import JSON avec
fusion/remplacement, et export automatique périodique dans les téléchargements (« au cas
où »). Une extension qui détient plusieurs années de chine sans filet de sécurité est
une extension dont on finit par perdre le contenu.

### J. Multi-domaine · effort M

**Le besoin.** Les vraies pièces rares sont souvent à l'étranger : vintage italien sur
`vinted.it`, workwear allemand sur `vinted.de`, marques japonaises via `vinted.nl`. Un
chineur sérieux navigue sur 3 ou 4 domaines. Aujourd'hui `host_permissions` se limite à
`https://www.vinted.fr/*` et l'extension est **totalement inerte** ailleurs.

**Faisabilité.** Le travail est identifié et documenté (`docs/limitations.md`) : les
séparateurs du libellé d'accessibilité (`, marque:`, `, état:`, `, taille:`) et le
vocabulaire des états sont en français dur. Il faut un jeu de locales, plus un
`CATALOG_URL` dérivé du domaine courant dans `search.ts` (aujourd'hui constante
`vinted.fr`), plus les identifiants d'état par marché (à revérifier via
`/api/v2/statuses` sur chaque domaine).

**Piège.** La couverture de test est aujourd'hui adossée à des fixtures françaises.
Étendre sans fixtures étrangères, c'est perdre le filet — prévoir au moins un domaine
supplémentaire dans `refresh-fixtures`.

### K. Vue comparaison · effort S/M

**Le besoin.** Le panneau latéral est une colonne étroite, une ligne par article,
miniature minuscule. Comparer 8 vestes se fait à l'œil, et l'œil a besoin des photos
côte à côte.

**La proposition.** Un basculement **liste / grille** (grille de vignettes larges), une
visionneuse au clic (les URLs d'image sont stockées), et une vue **comparaison** de 2 à
4 articles sélectionnés en colonnes : photo, prix, taille, état, mesures, vendeur.

**Faisabilité.** Purement front, sur des données déjà présentes. Attention à ne stocker
qu'une URL d'image par article aujourd'hui : une vraie visionneuse suppose de capturer
les autres photos de la fiche (`item-photo-N--img`).

### L. Alerte de baisse et liste courte · effort S (une fois A livré)

Dérivé direct de A : une collection marquée **« surveillance rapprochée »**, limitée à
~20 articles, rafraîchie plus souvent, avec badge sur l'icône de l'extension quand un
prix baisse. C'est la fonctionnalité qui fait _gagner de l'argent_ : sur Vinted, une
baisse de prix est très souvent suivie d'une vente dans les heures qui suivent.

### M. Identifiants exacts de marque et de taille · effort M — **prérequis de B**

**Le besoin.** Aujourd'hui la recherche similaire cherche « Nike 42 » en texte libre.
Résultat : des pointures mélangées à des tours de taille, et des marques homonymes.
`docs/vinted-dom.md` le dit sans détour : « les filtres n'acceptent que des identifiants
numériques ».

Le modèle prévoit déjà `brandId` et `sizeId` (`types.ts`, marqués « versions antérieures
»), et `search.ts` sait les utiliser (`appendBrand`, `appendCategory`) — **personne ne
les renseigne**. Deux fonctions attendent une donnée qui n'arrive jamais.

**La proposition.** Les résoudre à l'enrichissement : soit depuis les liens de la fiche
(le fil d'Ariane porte déjà `/brand/53-nike`, dont on extrait `53` — l'information est
**déjà lue et jetée** par `readBreadcrumbCategory()`), soit via les endpoints de
catalogue Vinted, dont `/api/v2/statuses` est déjà utilisé comme référence dans la doc.

**Impact.** Recherche similaire enfin exacte, exploration de marque fiable, et surtout
un échantillon propre pour le prix de référence (B). C'est un petit chantier avec un
effet de levier disproportionné.

### N. Doublons et reposts · effort S

Les vendeurs suppriment et republient pour remonter dans le fil : le même article
revient sous un nouvel id. Un chineur le reconnaît au bout du troisième passage,
s'énerve, et parfois le réenregistre. Une empreinte simple (titre normalisé + marque +
taille + prix, ou URL d'image identique) permet de signaler « déjà dans ta liste sous un
autre id » et de dédoublonner à l'affichage.

## 5. Améliorations des fonctionnalités existantes

### 5.1 Capture (content script)

| Amélioration                                                                             | Pourquoi                                                                                                                                                                                               |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Champs manquants : `description`, `color`, `uploadedAt`, `sellerId`, `brandId`, `sizeId` | Tous accessibles sans nouvelle source (JSON-LD, `itemprop`, fil d'Ariane, flux d'hydratation). C'est de la donnée gratuite, déjà sous les yeux du parseur.                                             |
| Raccourci clavier de capture                                                             | Le chineur scrolle vite ; viser une icône de 24 px casse le rythme.                                                                                                                                    |
| Capture avec choix de collection                                                         | Aujourd'hui tout tombe dans « Mes favoris » puis se range à la main. Un appui long, ou un `Alt`+clic, ouvrant un choix de collection, supprimerait une corvée entière.                                 |
| Retour visuel de l'enrichissement sur la carte                                           | Le panneau montre `pending`, la page non.                                                                                                                                                              |
| Reprise des enrichissements échoués                                                      | `enrichFailed` est compté mais aucun article n'est jamais retenté. Un article dont le `fetch` a échoué reste incomplet à vie. Une nouvelle tentative au prochain démarrage, une seule fois, suffirait. |

### 5.2 Panneau et collections

- **Collections imbriquées ou couleurs.** Passé 8 collections, la barre d'onglets
  sature. À défaut de hiérarchie : une pastille de couleur et un ordre réglable.
- **Compteur de valeur.** « 42 articles · 1 380 € » en tête de collection : un chineur
  pilote un budget.
- **Actions groupées** (sélection multiple → déplacer, supprimer, ouvrir, archiver).
- **Un article dans plusieurs collections.** Le modèle actuel (`collectionId` sur
  l'article) impose l'exclusivité. Une veste peut légitimement être à la fois dans «
  Cadeau Julien » et « Vestes hiver ». Passer à des tags résoudrait §3.3, §4.G et ce
  point d'un coup — mais c'est une migration de modèle, à ne pas engager à la légère.
- **Archive.** Plutôt que supprimer un article vendu, l'archiver : la mémoire de ce qui
  est parti, et à quel prix, est précieuse pour situer le marché.

### 5.3 Tri

- Le tri est **la seule mécanique de sélection** du panneau, et il fait tout le travail
  que devraient faire des filtres. Six modes exclusifs qui ne se combinent pas : on ne
  peut pas dire « en 42, sous 50 €, très bon état minimum, les moins chers d'abord ».
  **Il faut des filtres à côté du tri**, pas un septième mode.
- Le tri **Likes** est trompeur : 40 favoris sur une annonce d'un jour et 40 sur une
  annonce de six mois n'ont pas le même sens. Avec `uploadedAt` (G), une **vélocité**
  (favoris/jour) est un bien meilleur indicateur de désirabilité — et de risque de se
  faire souffler la pièce.
- Le tri **Taille** range les échelles en deux blocs incomparables (documenté). Avec la
  catégorie exacte disponible, une table de correspondance par famille (chaussures /
  hauts / bas) rendrait le tri cohérent — imparfait, mais utilisable.
- Ajouts naturels une fois A, F et G livrés : **baisse de prix**, **coût total**,
  **ancienneté de l'annonce**.

### 5.4 Recherche similaire

C'est une bonne idée dont l'exécution est bridée par un manque de données (M).

- **Prix** : la fourchette −50 % / +100 % est fixe pour tout le monde. Pour un chineur,
  la moitié haute n'a aucun intérêt : il veut « même chose, moins cher ». Proposer
  plusieurs profils — _moins cher que le mien_, _équivalent_, _large_ — plutôt qu'une
  constante dans le code.
- **Tri** : ajouter `order=price_low_to_high` à l'URL. Aujourd'hui la recherche s'ouvre
  sur le tri par défaut de Vinted (pertinence), qui n'est pas ce qu'on cherche.
- **Exclure l'article d'origine** des résultats, qui se retrouve toujours en tête.
- **Couleur** (dès qu'elle est capturée) et **matière** resserrent beaucoup sur les
  pièces techniques.
- Un chemin **« sauvegarder comme recherche suivie »** depuis cet écran fait le pont
  naturel vers C.

### 5.5 Explorer la marque

Correct et honnête (repli sur la marque seule si la catégorie est douteuse). Manque : la
même exploration **dans ma taille**, qui est la seule que je veux vraiment. Et un accès
depuis la carte du catalogue, pas seulement depuis le panneau.

### 5.6 Offres

- **Le message.** Les quatre ouvertures et trois registres sont bien vus, mais un
  vendeur qui reçoit deux offres de moi reconnaît le gabarit. Surtout, aucune mémoire
  des messages déjà envoyés : rien n'empêche d'envoyer deux fois le même texte au même
  vendeur. Un anti-répétition par vendeur est peu coûteux.
- **Les leviers manquants** sont ceux qui font accepter : l'ancienneté de l'annonce («
  en ligne depuis 2 mois »), le lot (« je prends aussi le pull, 45 € les deux »).
  **L'offre groupée par vendeur** est la vraie fonctionnalité manquante ici : le
  dressing d'un même membre est la situation la plus fréquente et la plus rentable, et
  l'extension a déjà tout pour la détecter (une fois `sellerId` capturé).
- **Le prix suggéré** part d'un pourcentage global, jamais de l'article. Avec le prix de
  référence (B) et l'ancienneté (G), on peut proposer un montant argumenté — et surtout
  dire _pourquoi_ il est proposé.
- **La sécurité.** « L'offre part réellement à la validation » est le bon choix, mais le
  récapitulatif mériterait d'être plus dur à confondre : le montant en grand, le titre
  de l'article, la photo. C'est un envoi irréversible à un inconnu.

### 5.7 Diagnostic et export

Le diagnostic est une excellente idée, mal située : c'est un outil de développeur
affiché à l'utilisateur, qui recrache un JSON brut incluant la totalité des articles.
Deux niveaux — un résumé lisible en français (« 3 articles n'ont jamais pu être
complétés », « les ancres de la modale d'offre ne répondent pas ») et le JSON complet en
repli — le rendraient utile aux deux publics. Ajouter un bouton « copier le rapport »
(aujourd'hui il faut le sélectionner à la main dans un `<pre>`).

## 6. Ce que je déconseille explicitement

Un avis critique doit aussi dire où ne pas aller.

- **L'achat automatique / le sniping.** Techniquement à portée (l'agent d'offre sait
  déjà piloter la page). À proscrire : irréversible, financièrement dangereux, et le
  premier bug coûte de l'argent réel à l'utilisateur. La bonne limite est celle déjà
  tenue par le projet — préparer et notifier, laisser l'humain valider.
- **Les notifications système par nouveauté.** Une recherche un peu large produit 50
  notifications par heure ; l'extension est désinstallée dans la semaine. Badge sur
  l'icône + compteur dans le panneau, et rien d'autre par défaut.
- **Le polling agressif.** Toute cadence sous l'heure sur l'ensemble des favoris expose
  au blocage et rendrait l'extension inutilisable pour tout le monde. La règle : par
  défaut le plus lent qui reste utile, et laisser l'utilisateur accélérer sciemment sur
  une liste courte.
- **Un scoring « IA » sur les photos** (authenticité, état réel). Ni fiable ni honnête à
  ce stade, et incompatible avec le principe « aucune donnée qui sort du navigateur ».
- **Une synchronisation cloud.** Ce serait renier le seul argument différenciant du
  projet. L'import/export (I) couvre 95 % du besoin réel.
- **Multiplier les modes de tri** pour éviter d'écrire des filtres. Le tri est déjà
  surchargé (§5.3).
- **Un scraping systématique du catalogue pour bâtir une base de prix locale.** Tentant
  pour B, mais c'est le pas de trop : volume de requêtes indéfendable, et un usage qui
  déborde clairement de ce qu'un outil personnel est censé faire.

## 7. Feuille de route proposée

**Jalon 1 — réparer et récolter (≈ 1 semaine).** Les manques criants, sans changement de
nature. `I` (import/export), §3.2 (annulation de suppression), §3.3 (afficher la
catégorie), §3.4 (filtres de recherche), `G` partiel (stocker description, couleur,
`uploadedAt`), `M` (`brandId`/`sizeId` — débloque tout le reste).

**Jalon 2 — arrêter de perdre du temps (≈ 1-2 semaines).** La valeur quotidienne la plus
forte. `D` (masquer vus / vendeurs / mots exclus), `A` (suivi de prix et disponibilité),
`L` (liste courte), `N` (doublons), §5.2 (actions groupées).

**Jalon 3 — décider mieux (≈ 2-3 semaines).** `B` (prix de référence, une fois M livré),
`H` (suivi des offres, une fois les ancres confirmées), `E` (signal vendeur), `F` (coût
total), `K` (vue comparaison).

**Ensuite, selon l'appétit.** `C` (veille sur recherches sauvegardées) et `J`
(multi-domaine) sont les deux gros morceaux, et les deux qui feraient passer l'outil de
« très bon assistant personnel » à « avantage compétitif ». À n'engager qu'avec la
couverture de test correspondante.

## 8. Risques transverses à garder à l'esprit

- **La fragilité DOM est le risque n°1**, et il croît linéairement avec le nombre
  d'ancres. Chaque fonctionnalité ci-dessus qui ajoute une ancre ajoute une dette.
  Privilégier systématiquement JSON-LD > `itemprop` > `data-testid` > libellé, comme le
  fait déjà le code, et étendre `diagnose()` en même temps que l'ancre — c'est cinq
  lignes, et c'est ce qui rend le prochain diagnostic exploitable.
- **Le passage de passif à actif** (A, C) change la relation à Vinted. Cadence
  conservatrice par défaut, interrupteur de pause visible, arrêt automatique sur 403 ou
  page anti-bot, et documentation honnête de ce que l'extension fait en arrière-plan.
- **Le quota de 10 Mo** ne pose problème qu'avec descriptions et historiques. Borner les
  deux dès l'écriture, pas après.
- **La performance du panneau.** `render()` reconstruit la liste entière à chaque frappe
  dans la recherche. À 1 000 articles avec grille et vignettes, ça se sentira : prévoir
  un rendu incrémental ou virtualisé avant d'y arriver.
- **La dette de test.** `docs/testing.md` le reconnaît : le panneau n'est pas couvert.
  Or les jalons 2 et 3 sont presque entièrement dans le panneau. Livrer A ou H sans
  tests sur le store et le tri, c'est reproduire exactement le type de bug silencieux
  que ce projet a passé tant d'énergie à éliminer côté content script.
- **La complexité de l'interface.** Le panneau est aujourd'hui lisible. Filtres, badges,
  historiques, notes, vendeurs : le risque réel est d'en faire un tableau de bord
  illisible. Chaque ajout devrait passer le test « est-ce que ça répond à _nouveau ?
  affaire ? encore dispo ?_ » — sinon, le reléguer derrière un dépli.

---

### En un paragraphe, s'il ne fallait retenir que ça

L'extension est très bien construite et répond parfaitement à « où ai-je rangé cet
article ». Les trois manques qui séparent un presse-papiers d'un vrai outil de chine
sont, dans l'ordre : **écarter durablement ce que j'ai déjà vu** (D), **savoir ce que
deviennent mes favoris** (A), et **savoir si un prix est bon** (B, qui dépend de M).
Avant tout cela, deux corrections d'une demi-journée chacune : **un import** pour que
l'export serve enfin à quelque chose, et **une annulation de suppression** pour ne plus
perdre une pièce d'un clic de travers.
