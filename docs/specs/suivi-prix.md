# Suivi de prix et de disponibilité — spécification

> Spécification du 28 juillet 2026, sur la base du code de la v0.2.1.
>
> Répond au point **A** de `docs/audit/analyse-utilisateur.md` (« la priorité n°1 »). Le
> document fixe l'architecture, le modèle de données, la stratégie de débit vis-à-vis de
> Vinted et l'ordre de mise en œuvre. Il ne décrit pas l'implémentation ligne à ligne.

## Le besoin, en une phrase

Un favori est une hypothèse d'achat en attente, et l'extension ne la vérifie jamais : un
article de mars affiche encore son prix de mars, qu'il soit vendu, baissé ou intact.
Trois choses arrivent à un article suivi ; la première rend la ligne inutile, la
deuxième est exactement le déclencheur d'achat qu'on attendait.

## 1. Le choix structurant : qui émet les requêtes

**Le rafraîchissement tourne dans le content script d'un onglet Vinted, jamais dans le
service worker.** Ce n'est pas un repli, c'est le chemin principal — et l'argument
anti-détection est le plus fort des trois :

| Aspect                               | `fetch` depuis la page Vinted                                   | `fetch` depuis le service worker      |
| ------------------------------------ | --------------------------------------------------------------- | ------------------------------------- |
| Cookies de session                   | first-party, `SameSite=Lax` respecté                            | contexte extension, `Lax` non garanti |
| `Referer`                            | `https://www.vinted.fr/…`                                       | absent                                |
| `Sec-Fetch-Site` / `-Mode` / `-Dest` | `same-origin` / `cors` / `empty` — comme une navigation interne | `none` / `cross-site`, signant        |
| `Origin`                             | cohérent                                                        | absent ou `chrome-extension://`       |
| Réponse                              | version connectée                                               | potentiellement version déconnectée   |

Le service worker ne fait **aucune** requête vers Vinted. Il garde son rôle actuel :
ouvrir le panneau, et la pulsation du badge.

Corollaire assumé : **pas de rafraîchissement sans onglet Vinted ouvert et au premier
plan.** Le panneau élit un onglet via `electVintedTab()`
(`chrome.tabs.query({ url: 'https://www.vinted.fr/*' })` dans `watch.ts`) et lui envoie
l'ordre ; à défaut d'onglet Vinted, le clic en ouvre un (§5.1). C'est une contrainte, et
c'est aussi le comportement le plus humain qui soit : le trafic n'existe que quand
l'utilisateur est réellement sur le site.

**La contrainte a été rediscutée le 30 juillet 2026 et maintenue.** La lever voudrait
dire émettre depuis un onglet caché ou depuis le service worker ; le tableau ci-dessus
dit ce que coûte la seconde option, et la première butte sur le bridage des timers d'un
onglet caché (Chrome les plafonne à un par minute après cinq minutes — un cycle de 48
articles prendrait la soirée, avec des délais qui ne ressemblent plus à rien d'humain).
Ce qui a changé n'est donc pas la contrainte mais son coût : le cycle **attend**
l'onglet au lieu de se perdre (§3.6), et le panneau dit à chaque instant quel geste le
débloque (§5.1).

## 2. Modèle de données

Quatre champs optionnels sur `SavedItem`. **Aucune migration** : l'absence vaut « jamais
vérifié, réputé actif », ce qui est exactement l'état des articles enregistrés avant.

```ts
/** Horodatage de la dernière vérification aboutie (fiche lue, quel qu'en soit le verdict). */
lastCheckedAt?: number;

/**
 * `undefined` = actif, ou jamais infirmé. `sold` vient du badge « Vendu » de la
 * fiche, `gone` de deux absences consécutives — jamais d'une seule (voir §4).
 * Un article marqué n'est jamais supprimé d'office : c'est l'utilisateur qui archive.
 */
status?: 'sold' | 'gone';

/**
 * Points de prix, du plus ancien au plus récent, **seulement quand la valeur change**.
 * Le premier point est toujours conservé — c'est la référence du « −15 % depuis
 * l'ajout ». Au-delà de PRICE_HISTORY_MAX on évince les plus anciens *intermédiaires*.
 * ~20 octets le point → 300 articles × 24 points ≈ 150 Ko sur les 10 Mo disponibles.
 */
priceHistory?: PricePoint[];

/** Absences consécutives. Remis à 0 dès qu'une lecture aboutit. */
missCount?: number;
```

Et une quatrième clé de storage à côté des trois existantes, `watch`, qui porte l'état
du cycle. **Pas un port, pas un message de progression** : le panneau écoute déjà
`chrome.storage.onChanged`, la progression s'affiche gratuitement et survit à la
fermeture du panneau comme à l'arrêt du service worker.

```ts
type WatchState = {
  /** Fin du dernier cycle complet. Base du déclencheur « > 2 h ». */
  lastSweepAt: number;
  /** Verrou d'onglet, avec bail : un onglet fermé en plein cycle ne bloque pas à vie. */
  lease?: { tabId: number; until: number };
  /**
   * `at` avance à chaque article **et** pendant une pause (§3.6) : c'est le seul
   * signe de vie du cycle, et donc le seul moyen de distinguer un cycle en cours
   * d'un `progress` laissé par un onglet fermé en plein travail — voir
   * `isSweepStale()`.
   */
  progress?: {
    done: number;
    total: number;
    startedAt: number;
    at: number;
    paused?: boolean;
  };
  /**
   * L'onglet Chrome porteur, écrit par le panneau — seul à connaître ces
   * identifiants — pour le lien de §6.10.
   */
  host?: { tabId: number; windowId?: number };
  /** Fenêtre de silence après un 429 ou un challenge. Aucune requête avant. */
  throttledUntil?: number;
  /** Seau à jetons, partagé entre tous les onglets — voir §3.2. */
  bucket: { tokens: number; at: number };
};
```

## 3. Stratégie vis-à-vis de Vinted

Six mesures, par ordre d'efficacité décroissante.

### 3.1 L'origine de la requête

C'est 80 % du sujet, et c'est le §1. Le complément indispensable : **ne forger aucun
en-tête.** Pas de `User-Agent`, pas de `X-Requested-With`. Le `fetch` émis depuis la
page porte déjà les bons ; un en-tête ajouté est précisément ce qui trahit un automate.

### 3.2 Un seul rafraîchisseur, un budget global

Trois onglets Vinted ouverts, c'est trois content scripts. Sans verrou, le débit est
triplé sans que personne ne l'ait demandé. D'où deux mécanismes :

- un **bail** de 60 s dans `watch.lease`, renouvelé à chaque requête : un seul onglet
  rafraîchit, et un onglet fermé en cours de route libère la place par expiration ;
- un **seau à jetons** en storage, relu-puis-écrit comme toute écriture (règle 6 du
  `CLAUDE.md`), qui plafonne le débit indépendamment du nombre de déclencheurs :

```ts
const RATE = { capacity: 24, refillPerMinute: 24 }; // pointe de 24, régime de 24/min
```

Un plafond quotidien s'y ajoute (`DAILY_CAP = 5000`, en pratique non contraignant). La
valeur d'origine de cette spec (~80 fiches/jour, capacité 12, régime 6/min) était
calibrée pour rester indiscernable d'une navigation soutenue ; ces valeurs ont été
relevées en deux temps sur demande explicite le 28 juillet 2026 (24/12 puis 48/48), en
connaissance de cause du compromis anti-détection que §3 décrit.

**Redescendues de moitié le 30 juillet 2026** (48/48 → 24/24, plafond 10000 → 5000) :
Vinted renvoyait des 429 au régime précédent. Le même jour, et pour la même raison, les
délais de §3.3 ont doublé, et le déclencheur silencieux de §5.2 est passé d'une heure à
deux.

### 3.3 Une cadence irrégulière

Un délai fixe de 5 s est aussi signant que pas de délai du tout. On tire le délai dans
une distribution log-normale, et on y ajoute des pauses longues :

```ts
/**
 * Un humain qui parcourt des fiches n'a pas de période. On tire un délai log-normal
 * (médiane ~1 s) et, une fois sur 50, on ajoute une pause de 20 à 60 s : la
 * « lecture » d'une fiche. Le coût en durée totale est réel mais le cycle tourne en
 * fond — personne ne l'attend.
 */
function nextDelay(): number {
  const base = Math.exp(Math.log(1000) + gauss() * 0.55);
  return Math.random() < 0.02 ? base + 20000 + Math.random() * 40000 : base;
}
```

### 3.4 Un ordre non déterministe

Rafraîchir par id croissant, ou rejouer toujours la même liste dans le même ordre,
produit un motif reconnaissable côté serveur. On trie par `lastCheckedAt` croissant — le
plus périmé d'abord, c'est aussi le plus utile — puis on **mélange à l'intérieur de
tranches** d'une dizaine d'articles pour casser la régularité sans perdre la priorité.

### 3.5 Un backoff sur signal

`429` ou `403` : arrêt immédiat du cycle, `throttledUntil = now + 10 min × 2^n` avec
jitter, et on n'y retouche pas. **Un article en échec n'est jamais rejoué dans le même
cycle.**

La base était de 30 min ; ramenée à 10 le 30 juillet 2026. Ce qui protège du 429, c'est
le débit du §3.2, pas la longueur du silence : un premier réessai renvoyé à plus d'une
heure privait l'utilisateur de tout rafraîchissement pour un coup de frein passager.
L'escalade en 2^n reste, elle, pour le cas où Vinted freine vraiment.

Une réponse dont le HTML ne contient aucune ancre connue est plus ambiguë : c'est le
visage d'un challenge Cloudflare, mais aussi celui d'un article dont Vinted ne sert plus
les informations — sa page affiche brièvement la fiche puis renvoie vers le dressing du
vendeur, redirection décidée côté client. Rien dans la réponse ne les distingue, et
freiner dès la première mettait tout le cycle en sommeil pour un seul article
momentanément illisible. Ce qui les sépare, c'est la portée : **un challenge frappe
toutes les requêtes, jamais une seule.** On passe donc à l'article suivant, et l'on ne
freine qu'à la **deuxième réponse illisible d'affilée** — une requête de plus, contre un
cycle entier perdu.

### 3.6 Le piggyback sur la navigation réelle

Ne lancer un cycle que lorsqu'un onglet Vinted est visible
(`document.visibilityState === 'visible'`), et le suspendre s'il passe en arrière-plan.
Effet secondaire utile : Chrome bride les timers des onglets cachés, ce qui étirerait
les délais de §3.3 de façon incontrôlée.

**Corrigé le 30 juillet 2026 : « suspendre » se lisait « abandonner ».** La boucle
sortait sur un `break` dès que l'onglet passait en arrière-plan, et le cycle était perdu
— un onglet effleuré une seconde suffisait. L'utilisateur ne voyait que le compteur
disparaître, sans un mot.

Désormais le cycle **attend** (`awaitForeground()`) : il bat `progress.at` toutes les 20
s en marquant `paused: true`, se réveille sur `visibilitychange`, et reprend où il en
était. Trois conséquences qui tiennent ensemble :

- le bail **n'est pas** renouvelé pendant la pause. Il expire en une minute, et un autre
  onglet Vinted — lui visible — peut reprendre le travail. Un cycle qui dort ne garde
  pas le verrou contre un cycle qui peut tourner ;
- au bout de 15 minutes en arrière-plan, on rend la main pour de bon : reprendre ne
  rendrait plus service, et le prochain déclencheur repartira d'une file recomposée ;
- le battement est ce qui rend la mort du porteur détectable. Sans lui, un onglet fermé
  en plein cycle laissait un `progress` éternel en storage — voir §6.1.

Reste que la pause est réelle et qu'elle se paie : un cycle sur un onglet caché n'avance
pas. C'est le prix de §1, assumé.

## 4. Détection de « vendu », conservatrice

La règle, en cas de doute : **ne rien écrire.**

| Observation                                                           | Verdict                                                                      |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `[data-testid="item-status--content"]` = « vendu » (`isSoldDetail()`) | `status: 'sold'` — signal explicite, une occurrence suffit                   |
| `404` / `410`                                                         | `missCount += 1` ; `status: 'gone'` seulement à 2, sur deux cycles distincts |
| Id servi ≠ id demandé (garde-fou existant d'`enrichFromDetail()`)     | **rien** — l'échec est compté, jamais interprété                             |
| Réponse sans aucune ancre connue (§3.5)                               | `lastCheckedAt` **seulement** — interrogé, rien de lisible à en conclure     |
| JSON-LD `availability` ≠ `InStock`                                    | corroboration seulement, jamais seule source                                 |
| Timeout, erreur réseau, `429`, `5xx`                                  | **rien du tout** — ni `lastCheckedAt`, ni `missCount`                        |

La ligne « sans ancre » est la seule à écrire `lastCheckedAt` sans rien conclure : sans
cette date, l'article resterait le plus périmé de la file (§3.4) et repasserait en tête
à chaque cycle, indéfiniment.

`discardSoldItem()` reste strictement réservé aux ajouts `pending`, comme aujourd'hui :
un article **suivi** qui se vend est marqué, jamais supprimé.

## 5. Déclencheurs

### 5.1 Le bouton « Rafraîchir » manuel

Dans la barre d'outils du panneau, à côté du sélecteur de tri. Rafraîchit la collection
visible, affiche `12/48` en place de son libellé, et se re-clique pour annuler. Ignore
`lastCheckedAt` — l'utilisateur a demandé — mais respecte le seau à jetons et
`throttledUntil`, avec un message explicite : « Vinted nous a freinés, réessai dans 22
min ». Mieux vaut le dire que faire semblant.

**Révisé le 30 juillet 2026, sur signalement : « cliquer ne fait rien ».** Ce n'était
jamais une panne, toujours une décision prise en silence. Quatre causes, un seul
principe de correction — **un clic produit toujours quelque chose à l'écran, et jamais
un blocage** :

| Ce qui se passait                                                                                                                        | Ce qui se passe                                                                                             |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `findVintedTab()` prenait le **premier** onglet Vinted rendu par `chrome.tabs.query`, souvent un onglet caché que §3.6 stoppait aussitôt | élection par capacité réelle à émettre : onglet actif de la fenêtre, sinon on l'active, sinon on prévient   |
| sans onglet Vinted, bouton `disabled` : aucun événement, donc aucune explication                                                         | le clic **ouvre** un onglet Vinted, attend l'injection du content script (`VF_PING`) et lance le cycle      |
| refus du content script (bail tenu ailleurs, onglet muet) journalisé en console                                                          | le refus s'affiche, avec le geste à faire quand il y en a un (« Recharge l'onglet Vinted (Cmd+R) »)         |
| `progress` laissé par un onglet fermé figeait le bouton sur `12/48` à vie, chaque clic étant compris comme une annulation                | un cycle sans battement depuis 4 min n'est plus un cycle en cours (`isSweepStale()`), le clic en relance un |

Le libellé du bouton dépend des onglets ouverts, qui changent sans que le storage bouge
: le panneau se repeint donc aussi sur `chrome.tabs.onActivated`, `onRemoved` et un
changement d'URL. Sans ces écoutes, un panneau ouvert avant Vinted gardait à vie son «
Ouvre un onglet Vinted » — et, du temps où ce libellé venait avec un bouton `disabled`,
un bouton mort alors que Vinted était sous les yeux.

L'annulation efface `progress` **depuis le panneau**, sans attendre que le porteur le
fasse : il peut être en pause, à vingt secondes de son prochain battement, et un bouton
doit répondre au clic. Corollaire côté content script : la boucle ne recrée jamais un
`progress` effacé, sous peine de faire clignoter le bouton en « en cours » juste après
un clic sur Annuler.

### 5.1 bis L'appui long : toutes les collections d'un coup

Ajouté le 30 juillet 2026. Le bouton ne rafraîchit que ce qui est **affiché** (§5.1), ce
qui est le bon défaut — c'est la liste qu'on regarde — mais rend le rafraîchissement de
dix collections aussi laborieux que dix clics et neuf changements d'onglet. **Un appui
maintenu 480 ms sur « Rafraîchir » lance un seul cycle sur tous les articles
enregistrés**, collections confondues.

La portée n'est pas la liste brute : c'est `orderForCheck()`, comme le déclencheur
silencieux de §5.2 — ni les vendus, ni les disparus, ni les articles encore en attente
de leur première fiche, et le plus périmé d'abord. À l'échelle de toute la collection,
envoyer des articles dont le verdict est définitif ne ferait que brûler le budget de
§3.2. Le clic court, lui, continue d'envoyer la liste affichée telle quelle :
l'utilisateur y désigne des articles précis, il est seul juge.

**Le geste se décide au relâchement**, contrairement à l'appui long des boutons injectés
(`content.ts`), où il _ajoute_ une action à celle du `pointerdown`. Ici il en
**remplace** une autre : impossible de lancer un cycle sur la collection affichée puis
un second sur toutes. C'est donc `pointerup` qui tranche — jamais `click`, que le
navigateur supprime dès qu'une sélection démarre ou que le pointeur glisse (règle 1), et
ce bouton a déjà une histoire de clics perdus. Le `click` que le navigateur émet ensuite
est ignoré comme l'écho du geste, via une fenêtre de 700 ms plutôt qu'un drapeau : le
`click` n'est pas garanti, et un drapeau resté armé avalerait le clic suivant.

Corollaire, et c'est le point à ne pas casser : **un glissement pendant l'appui annule
l'escalade, jamais le clic.** Le geste redevient un rafraîchissement de la collection
affichée, qui part au relâchement. Désarmer complètement rendrait au bouton son défaut
d'origine — un clic un peu tremblant qui ne produit rien.

Pendant un cycle, le bouton annule (§5.1) : il n'y a rien à escalader, l'appui n'arme
donc pas, et rien ne se remplit.

**Découvrabilité.** Un geste que rien n'annonce n'existe pas. Deux signes, aucun message
répétitif :

- le `title` du bouton au repos se termine par « · appui long : toutes les collections
  », et l'`aria-label` le reprend ;
- **le bouton se remplit pendant l'appui** (`.dir.is-holding::before`, 480 ms), du même
  langage visuel que l'anneau de l'appui long sur les boutons injectés. C'est le vrai
  vecteur : qui appuie une demi-seconde de trop voit qu'il se passe quelque chose, et
  recommence pour savoir quoi. La durée CSS est couplée à `LONG_PRESS_MS` — le
  remplissage doit se terminer à l'instant où le cycle part, sinon il promet plus tôt ou
  plus tard que ce qui arrive.

Le départ est confirmé par un message passager : « Rafraîchissement de toutes les
collections (137 articles) ». Il est émis **avant** l'élection de l'onglet, pour qu'un
message plus actionnable (onglet en arrière-plan, onglet à recharger) puisse le
remplacer.

Alt+clic et Alt+Entrée mènent au même endroit sans l'attente — mêmes raccourcis que le
choix de collection du content script, et le seul accès clavier : un appui long n'existe
pas au clavier, la répétition de touche n'en est pas un.

### 5.2 À l'ouverture du panneau, si `lastSweepAt` remonte à plus de deux heures

Cycle silencieux en tâche de fond, non bloquant, sans indicateur intrusif — seulement le
compteur discret dans le bouton. Si aucun onglet Vinted **visible** n'est ouvert : on ne
fait rien, et on ne le signale pas (rien ne serait actionnable). La visibilité compte
ici depuis le 30 juillet 2026 : élire un onglet caché ferait démarrer un cycle qui se
mettrait aussitôt en pause (§3.6), laissant un compteur figé dans un bouton que personne
n'a touché. Contrairement au bouton, ce déclencheur reste muet de bout en bout — aucun
refus ne s'affiche, personne n'a rien demandé.

Le plafond de ~25 articles d'origine a été supprimé sur demande explicite (même
changement que §3.2) : le déclencheur silencieux couvre désormais tous les articles
éligibles, pas seulement les plus périmés d'entre 25.

### 5.3 Le timer automatique : non, pas en V1

Trois raisons :

- **Il n'apporte rien sans notification.** Un cycle qui tourne à 3 h du matin alimente
  une donnée que personne ne lit avant l'ouverture du panneau — or §5.2 couvre
  exactement ce cas, à l'instant où l'utilisateur regarde. La valeur propre du timer,
  c'est « être prévenu d'une baisse sans ouvrir le panneau » : cela demande la
  permission `notifications` et une politique de seuil, c'est une autre fonctionnalité.
- **Il tape dans le pire scénario de détection** : pas d'onglet ouvert → service worker
  → requête sans `Referer` ni cookie de session, tout ce que §1 cherche à éviter. Et
  `chrome.alarms` se déclenche à la minute pile pour tous les utilisateurs à la fois.
- **MV3 le rend peu fiable** : le worker est tué en cours de cycle, il faut rendre la
  reprise idempotente pour un gain marginal.

**À la place, en phase 2** — même bénéfice, aucun de ces coûts : un **déclencheur
opportuniste dans le content script**. À l'activation d'une page Vinted, si
`lastSweepAt` remonte à plus de 6 h et que le seau a des jetons, le script rafraîchit 10
à 15 articles en fond pendant que l'utilisateur navigue. Le trafic se noie dans une
session réelle, pas d'alarme, pas de permission supplémentaire, et la liste reste
fraîche pour qui utilise Vinted régulièrement.

Si le suivi doit un jour devenir proactif sans onglet ouvert, ce sera avec
`notifications` et une « liste courte » explicitement surveillée (point L de l'audit) —
dix articles, pas trois cents.

## 6. Interface

Le panneau latéral fait 320 à 400 px de large et la ligne d'article y est **déjà dense**
: poignée, miniature, titre, ligne de méta, ligne prix + vendeur, quatre boutons
d'action. La contrainte de conception qui gouverne toute cette section : **le suivi
n'ajoute aucune ligne à un article normal.** Un article actif dont le prix n'a pas bougé
— le cas de la grande majorité — doit s'afficher exactement comme aujourd'hui. Tout ce
qui suit n'apparaît que lorsqu'il y a quelque chose à dire.

### 6.1 La barre d'outils

Un troisième bouton dans `.sortbar`, à côté de « Tout ouvrir », au même style `.dir` :

```
┌─────────────────────────────────────────────┐
│ [ Prix          ▾ ] [↕ Moins cher] [⭮ 12/48]│
└─────────────────────────────────────────────┘
```

Cinq états, tous portés par le même bouton — le libellé change, jamais la position.
**Aucun n'est `disabled`** (révision du 30 juillet 2026, voir §5.1) :

| État                | Libellé          | `title`                                                 | Clic                             |
| ------------------- | ---------------- | ------------------------------------------------------- | -------------------------------- |
| Repos               | `Rafraîchir`     | « Dernière vérification il y a 3 h »                    | lance un cycle                   |
| En cours            | `12/48`          | « Annuler le rafraîchissement »                         | annule                           |
| En pause (§3.6)     | `12/48`          | « En pause — reviens sur l'onglet Vinted, ou annule »   | annule ; l'icône ne tourne plus  |
| Freiné (§3.5)       | `Réessai 22 min` | « Vinted nous a freinés, reprise à 15 h 40 »            | répète la raison et l'échéance   |
| Aucun onglet Vinted | `Rafraîchir`     | « Ouvre un onglet Vinted et lance le rafraîchissement » | en ouvre un, puis lance le cycle |

Ce qui décide entre lancer et annuler est l'état lu au dernier rendu, **pas la classe
`is-running` du bouton** : l'icône ne tourne pas pendant une pause alors que le cycle
est bien en cours, et un état visuel n'est de toute façon pas une source de vérité.

Deux registres de message, à ne pas confondre :

- `#watch-notice` porte un **état durable** — cycle en cours, en pause, freinage,
  absence d'onglet Vinted — et reste tant qu'il dure. Pendant un cycle, la phrase
  contient un **lien** vers l'onglet qui le porte (§6.10) ;
- `flash()` (dans `#hint`, 5 s) porte l'**événement** : retour immédiat du clic, refus
  du content script, onglet ouvert ou activé, résumé de fin de cycle (§6.7).

L'icône est une flèche circulaire, animée en rotation continue **pendant le cycle
seulement**. Le libellé `12/48` était à l'origine mis à jour par paliers de 5 pour
limiter le repeint du panneau (voir §8) ; supprimé sur demande explicite le 28 juillet
2026, en connaissance du compromis que §8 décrit — le libellé avance désormais à chaque
article vérifié.

L'état freiné se dit franchement plutôt que de se déguiser en panne : un bouton qui ne
répond pas sans expliquer pourquoi est le pire des deux mondes.

**Ajouté le 28 juillet 2026, sur demande explicite.** Pendant l'état « En cours »
seulement, une ligne apparaît sous la barre de tri (`#watch-notice`, juste sous
`#watchbar`) : « Rafraîchissement en cours — si tu changes d'onglet, le cycle se met en
pause et reprend à ton retour. » Ce n'est pas décoratif : §3.6 suspend réellement le
cycle dès que `document.visibilityState` de l'onglet Vinted n'est plus `'visible'`, et
rien d'autre dans l'interface ne le disait explicitement. La formulation a suivi la
correction du 30 juillet : le cycle n'est plus perdu, il attend — l'ancienne phrase («
ça mettrait le cycle en pause ») décrivait une menace, la nouvelle décrit ce qui arrive
vraiment.

### 6.2 La ligne d'article — anatomie des trois cas

**Cas 1, l'article actif au prix inchangé.** Rien ne change, rien n'est ajouté :

```
┌──────┐  Veste Barbour Bedale C40
│      │  Barbour · 40 · Très bon état · ♥ 12
│ img  │  128,00 €  ·  vintage_shop_75            [⌕] [◇] [🗀] [🗑]
└──────┘
```

**Cas 2, le prix a baissé.** Le prix courant reste l'élément fort ; l'ancien prix le
suit, barré et en gris ; le badge ferme la séquence. Le vendeur reste sur la même ligne,
tronqué en premier s'il manque de place (`flex-shrink` sur `.item-seller`,
`text-overflow: ellipsis`) — entre le pseudo du vendeur et l'information « −20 % », le
second gagne.

```
┌──────┐  Veste Barbour Bedale C40
│      │  Barbour · 40 · Très bon état · ♥ 12
│ img  │  102,00 € 128,00 € (−20 %) · vintage_…   [⌕] [◇] [🗀] [🗑]
└──────┘             ^^^^^^^^  barré, gris, 11 px
                                ^^^^^^^ pastille verte, cliquable → §6.4
```

**Cas 3, l'article est vendu.** La ligne reste en place et reste manipulable — c'est
l'inverse du comportement de Vinted, qui fait disparaître. Elle se retire visuellement
sans se retirer de la liste :

```
┌──────┐  ~~Veste Barbour Bedale C40~~          ← titre barré
│ img  │  Barbour · 40 · Très bon état · ♥ 12   ← ligne entière à 55 % d'opacité
│ gris │  128,00 €  [Vendu]                     ← miniature désaturée
└──────┘                                         [⌕] [◇] [🗀] [🗑]
                                                  ↑
                                    mise en avant
```

Deux détails qui comptent dans ce cas :

- **la miniature passe en `filter: grayscale(1)`** : c'est ce qui se lit au balayage,
  avant même le titre barré ;
- **le bouton « rechercher un article similaire » reste, et devient l'action évidente**
  : quand la pièce est partie, la seule chose utile est d'en retrouver une autre. C'est
  précisément le moment où cette fonction sert.

Le statut `gone` (deux absences, §4) donne le même traitement avec le badge **« Retiré
»** en gris neutre : on n'affirme pas qu'il a été vendu, seulement que la fiche n'existe
plus.

### 6.3 Le badge de variation, et ce qu'on n'affiche pas

La référence est **le premier point de l'historique** — le prix au moment de
l'enregistrement — et non le point précédent : la question du chineur est « est-ce que
c'est descendu depuis que je l'ai repéré ? », pas « qu'a fait le vendeur cette semaine
».

| Situation                   | Affichage                                                |
| --------------------------- | -------------------------------------------------------- |
| Baisse ≥ 5 %                | ancien prix barré + pastille verte `−20 %`               |
| Baisse < 5 % (ou < 3 €)     | **rien** — le prix affiché est simplement à jour         |
| Hausse, quelle qu'elle soit | ancien prix barré + `+10 %` en gris, **jamais en rouge** |
| Un seul point d'historique  | rien                                                     |
| Article jamais vérifié      | rien                                                     |

Le seuil de 5 % existe parce que Vinted encourage les micro-ajustements : un « −1 % »
affiché sur trente lignes est du bruit qui décrédibilise le « −30 % » d'à côté. La
hausse reste en gris parce que `--danger` est déjà le rouge de la suppression, et parce
qu'une hausse n'est pas une alerte — c'est une information de contexte.

Deux nouvelles variables CSS, déclinées clair et sombre comme le reste du fichier :

```css
:root {
  --drop: #15803d; /* vert du texte de la pastille */
  --drop-bg: #dcfce7; /* fond de la pastille */
}

@media (prefers-color-scheme: dark) {
  :root {
    --drop: #4ade80;
    --drop-bg: rgb(74 222 128 / 14%);
  }
}
```

### 6.4 L'historique de prix

**Le badge de variation est un bouton.** Un clic ouvre un popover ancré sous le prix,
qui réutilise tel quel le mécanisme du menu « déplacer vers » (`.menu` :
`position: fixed`, ombre, fermeture au clic extérieur et à `Échap`, repositionnement si
le bas du panneau est atteint). Aucun nouveau mécanisme de superposition n'est
introduit.

```
        ┌──────────────────────────────┐
        │ Historique du prix           │
        │                              │
        │  128 ┐                       │  ← courbe en escalier, SVG inline
        │      └──┐                    │    (un prix saute, il ne glisse pas)
        │  102    └──────               │
        │                              │
        │ 12 mars      128,00 €        │
        │ 4 juillet    118,00 €  −8 %  │
        │ 26 juillet   102,00 €  −20 % │
        │                              │
        │ Vérifié il y a 2 h           │
        └──────────────────────────────┘
```

- **La courbe est un `<polyline>` SVG écrit à la main**, sans dépendance (le projet n'en
  a aucune à l'exécution, et ce n'est pas ici qu'on commencera). ~40 lignes.
- **L'axe horizontal est le temps réel**, pas l'index des points : les relevés sont
  irréguliers, et espacer uniformément trois points étalés sur quatre mois raconterait
  une histoire fausse.
- **Le tracé est en escalier** (`stepAfter`) : entre deux relevés, on sait que le prix
  était constant, pas qu'il glissait. Une interpolation linéaire inventerait des valeurs
  intermédiaires qui n'ont jamais existé.
- **Chaque ligne datée** porte la variation par rapport au point précédent. La dernière
  ligne du popover donne la fraîcheur : « Vérifié il y a 2 h ».
- **Pas de badge, pas de bouton.** Un article à un seul point de prix n'a pas
  d'historique à montrer, et un prix qui n'est pas cliquable ne doit pas en avoir l'air
  : pas de soulignement, pas de curseur `pointer`.

C'est aussi le seul endroit où la **fraîcheur par article** est écrite. Je l'avais
placée dans la ligne de méta dans la première version de cette spec ; c'est une erreur :
« vérifié il y a 2 h » répété sur 300 lignes est une colonne de bruit constant, alors
que l'information n'est consultée qu'en cas de doute sur un article précis. Elle vit
donc dans le popover, et en `title` du prix pour qui survole.

### 6.5 Vendus : le filtre et l'archivage

Une ligne d'état apparaît sous la barre de tri **uniquement quand la collection affichée
contient au moins un vendu**, au style de `.hint` déjà en place :

```
  3 vendus dans cette collection · Masquer · Archiver
```

- **Masquer** est un basculement, mémorisé dans `settings` (`hideSold`), qui devient «
  Afficher » une fois actif. Le compte reste visible : masquer n'est pas oublier.
- **Archiver** déplace les vendus vers une collection **« Archives »**, créée à la
  demande au premier usage. Ce n'est **pas** une suppression, et c'est réversible : un
  `flash('3 articles archivés', undo)` de 5 s rétablit les `collectionId` précédents,
  sur le modèle exact de l'annulation de retrait déjà écrite.

Ce placement — une ligne conditionnelle plutôt qu'une case à cocher permanente — évite
d'ajouter un contrôle qui ne servirait à rien 90 % du temps dans une barre déjà chargée.

### 6.6 Le tri « Baisse de prix »

> Supprimé de la spec, ne pas implémenter

### 6.7 Fin de cycle

Quand un cycle se termine en ayant trouvé quelque chose, un `flash()` le dit en une
ligne : **« 3 baisses de prix, 1 vendu »**. S'il n'a rien trouvé, il ne dit rien — un
rafraîchissement de fond qui annonce son propre néant est une notification de trop.

### 6.8 Contraintes à respecter dans le rendu

- **La liste est `aria-live="polite"`.** Chaque article vérifié avec succès écrit dans
  `savedItems` (au moins `lastCheckedAt`), ce qui redéclenche le rendu complet de la
  liste côté panneau — indépendamment du palier de progression de §8, qui ne concerne
  que le libellé du bouton. Un cycle qui vérifie cent articles fait donc parler un
  lecteur d'écran une centaine de fois ; `polite` attend une pause plutôt que de couper
  la parole, mais n'élimine pas le bruit.
- **Le badge porte un `aria-label` explicite** (« prix en baisse de 20 % depuis l'ajout
  ») : « −20 % » seul est illisible à la synthèse vocale.
- L'ancien prix utilise `<s>`, qui porte la sémantique ; le titre d'un article vendu
  passe par `text-decoration: line-through` en CSS, qui n'en porte aucune — c'est le
  badge « Vendu » qui dit l'état, pas la rature.
- Les règles 1 et 2 du `CLAUDE.md` (`pointerdown`, `user-select`, pas de `transform` au
  survol) visent les boutons **injectés dans les pages Vinted** ; le panneau est notre
  DOM, il n'y est pas soumis. **La règle 3 en revanche s'applique** : le repeint
  déclenché par `storage.onChanged` doit rester idempotent, et le rendu du bouton de
  rafraîchissement doit court-circuiter le rendu complet de la liste.

### 6.9 Récapitulatif des ajouts au DOM du panneau

| Élément                                                                        | Emplacement                                                                                                                          |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `<button id="refresh" class="dir">` + libellé `#refresh-label`                 | `.sortbar` de `sidepanel.html`                                                                                                       |
| `<p class="hint watchbar" id="watchbar" hidden>`                               | sous `#hint`                                                                                                                         |
| `<p class="hint" id="watch-notice" hidden>`                                    | sous `#watchbar`, ajouté le 28 juillet 2026 : l'état durable du cycle — en cours, en pause (§3.6), freiné, sans onglet Vinted (§6.1) |
| `<span class="item-price-was">` (`<s>`) et `<button class="item-price-delta">` | dans `.item-price` du template                                                                                                       |
| `<span class="item-status-badge">`                                             | dans `.item-price`, après le prix                                                                                                    |
| `<button class="link">` dans `#watch-notice`                                   | ajouté le 30 juillet 2026 : le lien de §6.10, au milieu de la phrase d'état                                                          |
| `<div id="price-history" class="menu" hidden>`                                 | à côté de `#move-menu`                                                                                                               |
| `.item--sold`, `.item--gone`                                                   | classes posées sur `.item`                                                                                                           |

### 6.10 Quel onglet porte le cycle — marquage et retour

**Ajouté le 30 juillet 2026, sur demande.** Le cycle tourne dans **un** onglet Vinted
(§1, §3.2) et rien ne disait lequel. Avec trois onglets ouverts, « reviens sur ton
onglet Vinted » ne désignait rien : l'utilisateur ne pouvait ni savoir sur lequel
revenir, ni voir qu'il était déjà au bon endroit. Trois marques, chacune répondant à une
question différente :

| Marque                                           | Où          | Répond à                                      |
| ------------------------------------------------ | ----------- | --------------------------------------------- |
| `🔄` en tête du titre de l'onglet (`⏸` en pause) | page Vinted | « lequel de mes onglets ? » — sans le quitter |
| Bandeau `Rafraîchissement des favoris — 12/48`   | page Vinted | « où en est-il ? » — une fois sur l'onglet    |
| Lien dans `#watch-notice`                        | panneau     | « comment y retourner ? » — d'un clic         |

Le titre est la seule des trois qui se lise **sans quitter l'onglet où l'on est**, donc
la seule qui serve à _trouver_ le porteur dans la barre d'onglets. C'est elle qui compte
le plus, et le bandeau ne fait que confirmer une fois qu'on y est.

Le bandeau a d'abord été une pastille en bas à gauche, dans la pile des autres
(`ui.ts`). **Remplacé le 30 juillet 2026 sur retour d'usage : trop discret.** Une
information qu'on cherche activement — « est-ce cet onglet-là ? » — doit se voir en
arrivant, pas se chercher. Le bandeau tient toute la largeur en haut de la fenêtre,
porte une jauge de 3 px collée à son bas (l'avancement se lit alors sans être lu, ce que
« 12/48 » ne permet pas), et passe en gris en pause plutôt que de répéter la même chose
dans la même couleur.

Il **recouvre** l'en-tête de Vinted plutôt que de décaler la page : décaler demanderait
de toucher au `padding` du `body`, et la mise en page collante de Vinted s'en accommode
mal.

Trois détails qui ne sont pas cosmétiques :

- **le préfixe se retire du titre courant, jamais restauré depuis une valeur
  mémorisée.** Vinted est une application monopage : le titre change légitimement
  pendant un cycle qui dure, et restaurer une capture d'il y a dix minutes réafficherait
  le nom d'un article qu'on a quitté depuis. Écrire dans `document.title` ne réveille
  pas le `MutationObserver` de `content.ts` (il surveille `document.body`, et `<title>`
  vit dans `<head>`), mais l'écriture reste conditionnelle par principe — règle 3 ;
- **le bandeau est inerte aux clics** (`pointer-events: none`). Il masque la barre de
  recherche le temps du cycle et ne porte aucune action : avaler en plus les clics qui
  la visaient serait un effet de bord gratuit. Les règles 1 et 2 n'ont alors plus prise
  sur lui, faute de zone de survol ;
- **la largeur de la jauge est un style en ligne**, donc un attribut : le
  `MutationObserver` n'observe que `childList` et `subtree`, elle ne coûte aucun scan.
  Le bandeau lui-même figure dans les deux listes d'exclusion (`SWEEP_BAR_SELECTOR`),
  sans quoi chaque article vérifié aurait relancé un scan complet de la page — règle 3.

Le lien du panneau a besoin de l'`id` d'onglet Chrome, que le content script **ne peut
pas connaître** — c'est pourquoi `lease.tabId` est un identifiant d'instance, bon à
comparer mais à rien d'autre. Le panneau, lui, le connaît : il l'écrit dans `watch.host`
au moment d'envoyer l'ordre, avant que le content script n'écrive son premier
`progress`. Le clic active l'onglet **et** remet sa fenêtre au premier plan — sans quoi
l'onglet deviendrait actif dans une fenêtre restée derrière, donc toujours invisible,
donc toujours en pause. Si l'onglet a été fermé entretemps, `chrome.tabs.update` lève et
le panneau le dit.

Le libellé du lien est « l'onglet Vinted responsable du rafraîchissement » : il désigne
un onglet précis, là où « ton onglet Vinted » supposait qu'il n'y en avait qu'un.

## 7. Découpage

| Fichier                                      | Rôle                                                                                                                                       |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/shared/types.ts`                        | les 4 champs, `PricePoint`, `WatchState`, `PRICE_HISTORY_MAX`                                                                              |
| `src/shared/watch.ts` _(nouveau, pur)_       | `pushPricePoint()`, `applyCheckResult()`, `dueForCheck()`, `priceDropRatio()`, `takeToken()` — **aucun accès Chrome**                      |
| `src/shared/messages.ts`                     | `VF_WATCH_START { ids }`, `VF_WATCH_CANCEL`, `VF_PING`, réponse `{ accepted, reason }`                                                     |
| `src/content/content.ts`                     | handler des messages + `runWatchQueue()` : réutilise `enrichFromDetail()` et sa sérialisation, avec le jitter, le bail et la pause de §3.6 |
| `src/content/watch-ui.ts` _(nouveau)_        | marque du titre de l'onglet et bandeau d'avancement, dans la page Vinted (§6.10)                                                           |
| `src/sidepanel/watch.ts` _(nouveau)_         | élection de l'onglet (§5.1), envoi de l'ordre, lecture de `watch`, rendu du bouton (§6.1), retour vers l'onglet porteur (§6.10)            |
| `src/sidepanel/price-history.ts` _(nouveau)_ | popover d'historique : tracé SVG en escalier, lignes datées (§6.4)                                                                         |
| `src/sidepanel/sorting.ts`                   | mode `priceDrop` : clé, sens par défaut, libellés (§6.6)                                                                                   |
| `src/sidepanel/sidepanel.{ts,html,css}`      | badges, ligne grisée-barrée, ligne d'état des vendus, archivage groupé (§6.2 à §6.9)                                                       |
| `src/sidepanel/store.ts`                     | `hideSold` dans `Settings`, `archiveSold()` et son annulation                                                                              |
| `src/manifest.ts`                            | **rien à ajouter** — `storage` et les `host_permissions` Vinted suffisent, `alarms` est inutile puisqu'il n'y a pas de timer               |

Le passage de `SortMode` à un membre de plus fait réclamer par le compilateur les
entrées manquantes de `DEFAULT_DIR` et `DIR_LABELS` : c'est voulu.

## 8. Tests

Les trois qui comptent — et chacun doit rougir si l'on neutralise le correctif
correspondant (méthode de debug, point 3 du `CLAUDE.md`) :

1. `watch.test.ts` — pur : un prix identique n'ajoute pas de point ; le premier point
   survit à l'éviction ; un `404` isolé ne marque pas `gone`, deux consécutifs oui ; un
   timeout ne touche à rien ; le seau refuse au-delà du débit.
2. `content-watch.test.ts` — jsdom, sur une fixture de fiche **vendue** authentique : le
   cycle écrit `status: 'sold'` sans supprimer l'article, et un id divergent laisse
   l'article intact.
3. `watch-lease.test.ts` — deux content scripts simulés sur le même storage : un seul
   obtient le bail et le second n'émet aucune requête ; un bail expiré est repris.

Et un quatrième, côté rendu, sur le modèle de `gallery.test.ts` qui monte déjà le
panneau en jsdom — `watch-render.test.ts` : une baisse de 2 % n'affiche aucun badge, une
baisse de 20 % affiche la pastille et l'ancien prix, un article `sold` garde sa ligne
dans la liste, et le popover d'historique ne s'ouvre pas sur un article à un seul point
de prix.

Un cinquième depuis l'appui long (§5.1 bis) — `watch-scope.test.ts`, même montage jsdom.
Il tient les deux moitiés du geste : la **portée** (l'appui long dépasse la collection
affichée, sans les vendus ni les disparus ; le clic court s'y tient) et le **geste**
lui-même (le `click` d'écho ne lance pas de second cycle, deux clics rapprochés en
lancent bien deux, un pointeur qui glisse produit quand même le rafraîchissement
affiché, et rien ne se remplit pendant un cycle). Vérifié : ramener la portée au visible
ou retirer la garde d'écho fait rougir 11 des 16 cas.

**Vigilance liée à la règle 3.** Le panneau n'écoute `storage.onChanged` sur la clé
`watch` que dans `sidepanel/watch.ts`, pour repeindre le seul bouton — le rendu complet
de la liste (`sidepanel.ts`) n'écoute que `savedItems`/`collections`/`settings`, jamais
`watch`. Écrire la progression à chaque article ne coûte donc que deux éléments DOM, pas
un repeint de liste ; c'est pour cette raison que le palier de progression d'origine (un
article sur cinq) a pu être supprimé sur demande explicite le 28 juillet 2026 sans
risque de scintillement. Le repeint de liste, lui, vient d'ailleurs — de l'écriture de
chaque résultat dans `savedItems`, voir §6.8.

## 9. Ordre de mise en œuvre

1. Types + `shared/watch.ts` + ses tests. Aucun effet visible, tout est vérifiable.
2. Cycle dans le content script, bail et seau compris, déclenché **uniquement** par le
   bouton manuel. On mesure le taux de succès réel avant d'aller plus loin : étendre
   `diagnose()` de quelques lignes donne le compte des `200` / `404` / `429`.
3. Interface, dans cet ordre de valeur décroissante : badge de variation et prix barré
   (§6.2, §6.3), état vendu (§6.2), tri « Baisse de prix » (§6.6), ligne d'état et
   archivage (§6.5), popover d'historique (§6.4) — ce dernier est le plus coûteux et le
   moins consulté, il vient en dernier.
4. Déclencheur « plus de deux heures » à l'ouverture du panneau.
5. _(phase 2)_ Déclencheur opportuniste à 6 h sur page Vinted.
