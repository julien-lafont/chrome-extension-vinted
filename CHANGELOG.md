# Journal des modifications

Format inspiré de [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/).
Ce projet suit le [versionnage sémantique](https://semver.org/lang/fr/).

## [Non publié]

### Modifié

- **« Mes favoris » récapitule tout ce qui est enregistré**
  (`docs/specs/favoris-recapitulatif.md`). Ranger un article dans « Jeans » ne le fait
  plus disparaître du premier onglet : une collection est désormais une **étiquette
  facultative** qui s'ajoute au favori, pas un tiroir qui l'emporte. Un article peut donc
  n'être classé nulle part — c'est même son état à la capture — et les compteurs de la
  barre se recouvrent, ce qui est le sens même d'un récapitulatif. Seuls les archivés en
  sortent : les y laisser reparaître viderait l'archivage de son sens.

  **Une pastille** sur la ligne nomme la collection d'un article classé, et l'ouvre d'un
  clic ; son absence dit qu'il ne l'est pas. Le menu de rangement — celui du panneau
  comme celui de la page — remplace l'entrée « Mes favoris » par « **Aucune
  collection** », qui déclasse sans rien retirer, tout comme un dépôt sur l'onglet des
  favoris.

  **Rien à migrer pour lire.** Trois formes disent « non classé » et sont toutes
  comprises telles quelles : champ absent, `collectionId: 'default'` (ce qu'écrivaient
  les versions précédentes) et référence vers une collection supprimée. Un
  `shared/migrate.ts` versionné (`settings.schemaVersion`) nettoie les deux dernières au
  premier lancement du panneau, mais **l'affichage n'en dépend pas** : une migration dont
  dépendrait la lecture ferait d'un échec d'écriture une extension cassée.

- **Une collection se supprime même pleine.** Ses articles ne sont plus perdus — ils
  redeviennent non classés et restent dans « Mes favoris » —, la règle « seulement si
  vide » n'a donc plus rien à protéger. Le panneau demande confirmation en annonçant le
  nombre d'articles concernés, et le champ est effacé sur chacun d'eux dans la même
  écriture que la suppression.

- **L'archivage note l'origine article par article.** Lancé depuis « Mes favoris », il
  balaie les vendus de toutes les collections ; une origine unique les aurait tous rendus
  au même endroit sur un simple « Annuler », c'est-à-dire déclassés en bloc et en
  silence.

### Ajouté

- **Appui long sur « Rafraîchir » : toutes les collections d'un coup**
  (`docs/specs/suivi-prix.md` §5.1 bis). Un clic court continue de ne rafraîchir que la
  liste affichée — c'est celle qu'on regarde ; un appui maintenu une demi-seconde lance
  un seul cycle sur tous les articles enregistrés, collections confondues, en laissant de
  côté les vendus, les disparus et ceux qui attendent encore leur première fiche. Alt+clic
  et Alt+Entrée y mènent sans l'attente.

  **Le geste s'annonce** : le bouton se remplit pendant l'appui — qui appuie une
  demi-seconde de trop voit qu'il se passe quelque chose — et son infobulle le dit. Un
  glissement pendant l'appui annule l'escalade, jamais le clic : le geste redevient un
  rafraîchissement de la collection affichée. C'est le point que `watch-scope.test.ts`
  garde, ce bouton ayant une longue histoire de clics perdus.

- **Suivi des offres en cours** (`docs/specs/offres.md`). La ligne d'un article sous
  offre porte désormais le prix proposé et depuis quand — « Offre 399 € · il y a 3 h »,
  ou « Vendeur 205 € » quand c'est lui qui a fixé un prix. Une offre refusée, acceptée ou
  annulée reste affichée en gris : « déjà tenté à 42 € » évite de refaire deux fois la
  même offre au même vendeur. L'ancienneté se recalcule toutes les 5 minutes à partir de
  la date d'envoi, sans rendu de liste ni relecture du storage — seul le texte des
  badges change.

  **La fiche article ne dit rien d'une offre** (vérifié : dans les 2,6 Mo servis, les
  seules occurrences de `offer` sont des chaînes de traduction). La donnée vient de
  l'API des conversations, balayée depuis un onglet Vinted — elle répond 403 sans
  cookies de session. Le balayage lit une page d'inbox et s'arrête à la première
  conversation déjà vue : en régime courant, **une requête**. L'historique se rattrape
  par tranches de 40 conversations. Les offres reçues sur ce que l'on vend sont écartées
  (`current_user_side`), et seuls les articles enregistrés sont marqués.

- **Vue « Sous offres »** (💸), à gauche d'« Archives ». Ce n'est pas une collection :
  l'article reste rangé là où il est, rien ne s'y dépose, et l'onglet n'existe que
  lorsqu'une offre existe. Sa pastille compte les offres en attente sur des articles ni
  vendus ni retirés — la seule information qu'on pilote du regard.

- **Collection par défaut de l'onglet.** L'épingle posée sur chaque ligne du menu de
  rangement (appui long) range l'article **et** fait de cette collection la destination
  de tous les clics courts suivants — le geste utile quand une session de chine a un
  sujet. C'est un radio : une collection est toujours épinglée, « Mes favoris » tant
  qu'on n'a rien choisi, puisque c'est là que les enregistrements vont de fait. Une
  pastille flottante nomme en permanence tout écart à cette normale et porte son
  annulation ; les
  boutons injectés annoncent la destination au survol. La portée est réellement
  l'onglet : l'épingle vit dans le `sessionStorage` de la page, survit au rechargement,
  ne franchit pas la frontière de l'onglet et disparaît avec lui. Une collection
  supprimée depuis le panneau emporte l'épingle plutôt que de laisser une référence
  morte.
- **Identifiant de marque extrait de la fiche** (`brandId`), lu dans le maillon du fil
  d'Ariane que la catégorie écarte, avec le flux d'hydratation en repli. « Rechercher
  un article similaire » et « explorer la marque » filtrent enfin sur la vraie marque :
  le catalogue Vinted n'accepte pas de nom dans `brand_ids[]`, et les deux fonctions
  attendaient depuis toujours un champ que personne ne renseignait.
- **Identifiant de taille résolu** (`sizeId`) : aucune page de Vinted ne le porte, il est
  déduit du libellé et de la catégorie via `/api/v2/size_groups`, dans une écriture
  séparée qui ne retarde pas l'affichage. La recherche d'articles similaires filtre donc
  la taille exactement, au lieu de la chercher en texte — « 42 » ne remonte plus une
  pointure quand on cherchait un tour de taille. La résolution renonce plutôt que de
  filtrer sur la mauvaise échelle quand le libellé est ambigu.
- **Vendeur affiché à côté du prix**, cliquable vers son dressing (`sellerId`,
  `sellerName`).
- **Description enregistrée** avec l'article (tronquée à 1 200 caractères). Encore
  inexploitée : la capturer maintenant évite d'avoir à relire toutes les fiches le jour
  où la recherche s'en servira.
- `src/shared/size-ids.ts` : résolution d'un libellé de taille en identifiant de
  catalogue, avec cache par catégorie et repli textuel silencieux.
- `src/shared/hydration.ts` : lecture des identifiants du flux React Server Components,
  en une seule passe pour les trois clés (`favourite_count`, `brand_id`, `seller_id`).
- Le rapport de Diagnostic montre les **deux sources** de chaque identifiant, ce qui dit
  laquelle a lâché plutôt que de conclure à une donnée absente.
- Chaîne d'outillage complète : pnpm, build esbuild, ESLint, Prettier, stylelint,
  hooks git (`lint-staged`, `commitlint`) et `pnpm check` comme porte de qualité
  unique, rejouée à l'identique par le CI.
- CI GitHub Actions sur chaque push et chaque PR, avec un **artefact zip
  téléchargeable** ; workflow de release déclenché par un tag `v*`, qui vérifie que
  le tag et `package.json` s'accordent avant de publier.
- `src/shared/` : modèle de données, protocole de messages, parseur de prix et
  formatage des erreurs, désormais partagés entre le content script et le panneau.
- `src/manifest.ts` : manifeste typé, dont la version est lue depuis `package.json` —
  il n'y a plus qu'un seul endroit à modifier pour publier.
- `tests/build-output.test.ts` : verrouille le format de sortie des content scripts
  (IIFE) et la cohérence entre le manifeste et ce que le build produit.
- Un plugin stylelint maison interdit `transform` au survol des boutons injectés, et
  une règle ESLint interdit les classes CSS obfusquées de Vinted dans les sélecteurs.

### Modifié

- **Les fraîcheurs de plus de 48 h se comptent en jours** (« il y a 9 j » plutôt que
  « il y a 216 h »). Une offre reste en attente des semaines, là où le suivi de prix ne
  parlait que d'heures.
- **Toute écriture en storage passe par `src/shared/storage.ts`**, qui relit *et*
  sérialise. Relire avant d'écrire ne protégeait que des autres onglets : dans un même
  contexte, la boucle d'événements passe la main entre le `get` et le `set`, si bien
  qu'un article enregistré pendant qu'une fiche s'enrichissait pouvait être effacé par
  l'écriture de celle-ci. Le fichier est aussi la seule description du contenu du
  storage — les cinq clés étaient déclarées en dur dans autant de fichiers. Une règle
  ESLint interdit désormais `chrome.storage.local` partout ailleurs.
- **L'extraction du DOM Vinted vit dans `src/content/extract.ts`**, séparée de
  l'injection des boutons : des fonctions pures sur un `Document`, éprouvées
  directement par `tests/extract.test.ts` en une seconde, là où il fallait auparavant
  bundler le content script et monter une fenêtre complète pour vérifier la lecture
  d'un sous-titre. `content.ts` perd 570 lignes.
- **Le panneau est découpé en modules éprouvables.** `sidepanel.ts` cherchait ses
  éléments dès son chargement, si bien qu'aucun test ne pouvait l'importer : le rendu
  d'une ligne d'article et la barre de collections n'étaient couverts par rien. Ils
  vivent désormais dans `item-list.ts`, `collections-bar.ts` et `menus.ts`, qui ne
  touchent qu'au DOM qu'on leur passe. `required()` et `within()`, jusqu'ici dupliqués
  dans trois fichiers avec trois messages différents, sont réunis dans `dom.ts`.
- **Le panneau ne reconstruit plus sa liste à chaque écriture.** Elle était vidée puis
  recréée en entier ; comme vider un conteneur qui défile remet son `scrollTop` à zéro
  et qu'un cycle de suivi de prix écrit une fois par article vérifié, la liste
  remontait toute seule en haut toutes les quelques secondes. Les lignes inchangées
  sont maintenant conservées telles quelles (`src/sidepanel/reconcile.ts`).
- **Retirer ou restaurer un article n'écrit plus qu'une fois** au lieu de deux
  (articles puis collections), ce qui supprime le rendu intermédiaire où l'ordre citait
  encore un article disparu.
- **Les sources passent de JavaScript à TypeScript** en mode strict, sans changement
  de comportement : les 81 tests d'origine restent verts à chaque étape.
- **Chrome charge désormais `dist/`, plus la racine du dépôt.**
- Les tests s'exécutent via `tsx` et chargent le **bundle esbuild** plutôt que le
  fichier source : ils valident ce qui est réellement livré.
- Le parseur de prix, jusqu'ici dupliqué entre le content script et le panneau faute
  de pouvoir partager du code, est unifié dans `src/shared/price.ts`.
- Node 22 minimum (`.nvmrc`), pnpm 10.

### Corrigé

- **« Cliquer sur Rafraîchir ne fait rien. »** Ce n'était jamais une panne, toujours une
  décision prise en silence — et il y en avait quatre. Le panneau élisait le **premier**
  onglet Vinted rendu par Chrome, souvent un onglet en arrière-plan, que la règle de
  l'onglet visible stoppait aussitôt ; sans onglet Vinted du tout, le bouton était
  `disabled`, donc muet par construction ; un refus du content script (« Un autre onglet
  Vinted rafraîchit déjà ») partait dans une console que personne ne regarde ; et un onglet
  fermé en plein cycle laissait en storage un état « 12/48 » que rien n'effaçait plus,
  figeant le bouton à vie et transformant chaque clic suivant en annulation d'un cycle
  inexistant.

  Le rafraîchissement part désormais de n'importe quel onglet Vinted, en élisant celui qui
  peut réellement émettre : l'onglet actif de la fenêtre, sinon un onglet Vinted de la même
  fenêtre qu'il active, sinon celui d'une autre fenêtre — et s'il n'y en a aucun, **le clic
  ouvre un onglet Vinted** et lance le cycle dès que la page répond. Plus aucun état ne
  désactive le bouton : freinage, collection vide, onglet à recharger, chaque cas dit ce
  qu'il en est et ce qu'il reste à faire. Le libellé suit aussi l'ouverture et la fermeture
  des onglets, là où il était figé sur l'état du moment où le panneau s'était ouvert.

- **On voit maintenant quel onglet Vinted porte le rafraîchissement.** Avec trois onglets
  ouverts, « reviens sur ton onglet Vinted » ne désignait rien de précis. L'onglet qui
  travaille prend un `🔄` en tête de son titre (`⏸` s'il est en pause) — la seule marque
  qui se lise **sans le quitter**, donc la seule qui serve à le retrouver dans la barre
  d'onglets — et affiche un bandeau « Rafraîchissement des favoris — 12/48 » en haut de la
  page, avec une jauge d'avancement, gris quand le cycle est en pause. Le bandeau recouvre
  l'en-tête de Vinted le temps du cycle sans décaler la page, et reste inerte aux clics
  pour ne pas avaler ceux qui visaient la barre de recherche. Les deux marques
  disparaissent à la fin du cycle. Côté
  panneau, la ligne d'état porte désormais un lien, « l'onglet Vinted responsable du
  rafraîchissement », qui y ramène d'un clic : il active l'onglet et remet sa fenêtre au
  premier plan, faute de quoi l'onglet serait actif dans une fenêtre restée derrière —
  donc toujours invisible, donc toujours en pause.

- **Changer d'onglet ne perd plus le rafraîchissement en cours.** La spec disait
  « suspendre », le code faisait `break` : un onglet effleuré une seconde suffisait à
  perdre le cycle entier, sans un mot. Il se met maintenant en pause — l'avancement acquis
  reste affiché, l'icône cesse de tourner, une ligne indique qu'il reprendra au retour — et
  il reprend là où il en était. Il rend la main au bout d'un quart d'heure en
  arrière-plan, et son bail est libéré pendant la pause pour qu'un autre onglet Vinted,
  lui visible, puisse prendre le relais. La contrainte de l'onglet au premier plan reste
  entière : les requêtes doivent partir de la page Vinted (cookies de session, en-têtes
  cohérents), et Chrome bride les minuteurs des onglets cachés.

- **Un seul article illisible mettait tout le rafraîchissement en sommeil 30 min.** La
  page d'un article dont Vinted ne sert plus les informations affiche brièvement la fiche
  puis renvoie vers le dressing du vendeur, redirection décidée côté client : la réponse
  ne porte alors aucune ancre — exactement l'allure d'un challenge Cloudflare, qui, lui,
  doit freiner le cycle. Ce qui les sépare est la portée, pas le contenu : un challenge
  frappe toutes les requêtes, jamais une seule. L'article est désormais passé sans rien
  conclure sur lui (aucune absence comptée, aucun `gone`), et le freinage n'intervient
  qu'à la deuxième réponse illisible d'affilée.
- `.vf-card-btn:hover` portait encore un `transform: scale(1.1)` — la règle 2 du
  projet, appliquée au bouton de la fiche article mais jamais reportée sur celui des
  cartes. Le survol ne change plus que des propriétés de peinture.
- `clip` (déprécié) remplacé par `clip-path` dans la classe d'accessibilité du
  panneau, et `word-break: break-word` par `overflow-wrap: anywhere`.

## [0.1.0]

Première version : enregistrement des articles depuis le catalogue et les fiches,
panneau latéral, collections, tri, ordre manuel par glisser-déposer, recherche
d'articles similaires, envoi d'offres au vendeur.
