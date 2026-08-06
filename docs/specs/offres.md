# Offres en cours — spécification

> Spécification du 29 juillet 2026, sur la base du code de la v0.4.
>
> Relevés effectués le même jour sur un compte réel (55 conversations, 3 ans
> d'historique), en session connectée. Les ancres et les codes cités plus bas ne sont
> pas déduits d'une documentation — il n'en existe pas — mais lus dans les réponses de
> l'API.

## Le besoin, en une phrase

Un article sous offre n'est ni un favori ordinaire ni un article vendu : c'est une
décision en attente chez quelqu'un d'autre. L'extension ne le sait pas, et Vinted ne le
dit nulle part une fois la conversation sortie de l'écran.

## 1. Ce que Vinted expose — et ce qu'il n'expose pas

**La fiche article ne porte aucune trace d'une offre en cours.** Vérifié le 29/07/2026
sur une fiche dont l'offre était en attente : les 15 occurrences de `offer` dans les 2,6
Mo servis sont toutes des chaînes de traduction
(`"conversation.offer_request.accept": "Accepter l'offre"`). Ni le DOM, ni le JSON-LD,
ni le flux d'hydratation. C'est la deuxième donnée de l'extension — après le pays du
vendeur — qui exige une autre page que la fiche, et la seule qui exige l'API.

Deux points d'entrée, tous deux same-origin et dépendants de la session :

| Requête                                | Ce qu'elle donne                                                 |
| -------------------------------------- | ---------------------------------------------------------------- |
| `GET /api/v2/users/current`            | `user.id` — indispensable pour distinguer les deux côtés         |
| `GET /api/v2/inbox?page=N&per_page=20` | `conversations[]` : `id`, `updated_at`, **rien d'autre d'utile** |
| `GET /api/v2/conversations/{id}`       | la transaction, les messages, les offres                         |

`/api/v2/conversations?page=…` **n'existe pas** (404) : la liste, c'est `/api/v2/inbox`.

L'inbox ne porte ni `item_id` ni offre : il faut une requête par conversation. C'est ce
qui gouverne toute la stratégie de débit du §4.

### La conversation, réduite à ce qu'on en lit

```jsonc
{
  "conversation": {
    "id": 24027793606,
    "messages": [
      {
        "entity_type": "offer_request_message",
        "created_at_ts": "2026-07-29T19:58:42+02:00",
        "entity": {
          "user_id": 77742929, // qui a fait l'offre
          "status": 10, // 10 en attente, 20 acceptée, 30 refusée, 40 annulée
          "status_title": "En attente", // traduit — ne jamais s'y ancrer
          "current": true,
          "price": { "amount": "399.0", "currency_code": "EUR" },
          "original_price": { "amount": "650.0", "currency_code": "EUR" },
        },
      },
    ],
    "transaction": {
      "status": 1,
      "buyer_id": 77742929,
      "seller_id": 35422672,
      "current_user_side": "buyer",
      "item_id": 9488279818,
      "item_ids": [9488279818],
      "is_bundle": false,
      "item_is_closed": false,
    },
  },
}
```

### Cinq relevés qui gouvernent l'implémentation

1. **`created_at_ts` est la date d'envoi de l'offre**, malgré le titre « Rappel : tu as
   fait une offre à ce membre » que porte l'entité. Vérifié sur la conversation
   21639250773 : offre le 31/03 à 21:27, conversation mise à jour le 15/04. Ce titre
   n'est que le libellé d'affichage côté acheteur — côté vendeur, la même entité
   s'annonce « Hey, X t'a fait une offre ».
2. **`transaction.item_id` est `null` sur les conversations d'avant avril 2026**, alors
   que `item_ids` est rempli. Lire les deux, ou la moitié de l'historique est muette.
3. **`current: true` vaut par auteur, pas par conversation.** Dans la conversation
   22149099255, l'`offer_message` de l'un et l'`offer_request_message` de l'autre sont
   tous deux `current`.
4. **Les statuts sont numériques et les libellés traduits.** L'ancrage se fait sur
   `10/20/30/40` ; un code inconnu n'affiche rien plutôt qu'un badge faux — même
   précaution que partout ailleurs dans ce projet.
5. **Deux types de messages portent un prix**, et ils ne se lisent pas pareil :

| `entity_type`           | Qui                        | Statut                        |
| ----------------------- | -------------------------- | ----------------------------- |
| `offer_request_message` | l'acheteur propose un prix | `entity.status` (10/20/30/40) |
| `offer_message`         | le vendeur fixe un prix    | **aucun** — voir §3           |

## 2. Modèle de données

Un champ optionnel sur `SavedItem`, sans historique — le besoin est « où j'en suis »,
pas « ce que j'ai tenté ». L'absence vaut « aucune offre connue » : aucune migration.

```ts
type ItemOffer = {
  /** Qui a proposé ce prix. Les deux comptent : `seller` est une balle dans mon camp. */
  by: 'me' | 'seller';
  price: number;
  /** Envoi de l'offre (`created_at_ts`), jamais la date du scan : c'est ce qui est affiché. */
  at: number;
  status: 'pending' | 'accepted' | 'rejected' | 'cancelled';
  /** Pour ouvrir l'échange d'un clic depuis le badge. */
  conversationId: string;
};
```

**Pas de date de vérification sur l'offre.** Le balayage incrémental (§4) ne relit pas
les conversations inchangées : un tel champ ne pourrait jamais dire « confirmée à
l'instant » sans mentir, et le réécrire à chaque scan repeindrait toute la liste pour
rien. Ce que le scan a fait et quand se lit dans `offers.lastScanAt`.

Et une sixième clé de storage, `offers`, qui porte l'état du balayage — jamais les
offres elles-mêmes, qui vivent sur leur article :

```ts
type OffersScanState = {
  /** Identifiant du compte, lu une fois. Sans lui, impossible de distinguer les côtés. */
  userId?: string;
  lastScanAt: number;
  /** `updated_at` le plus récent déjà traité : borne haute de l'incrémental. */
  cursor?: number;
  /** Reste-t-il de l'historique à balayer, et sous quelle date ? Absent = balayage terminé. */
  backfillBefore?: number;
  /** Fenêtre de silence après un signal de freinage. */
  throttledUntil?: number;
};
```

## 3. Interprétation

Une conversation donne **au plus une** offre, celle qui décrit l'état courant.

1. **Côté acheteur seulement.** `transaction.current_user_side === 'buyer'`, ou à défaut
   `buyer_id === userId`. Les offres reçues sur ce que l'utilisateur vend sont hors
   sujet, et cette condition seule les écarte — la seconde garde (§4) est que l'article
   doit être dans `savedItems`.
2. **Mes offres** : `offer_request_message` dont `entity.user_id` est le mien, `current`
   non explicitement faux, la plus récente. Statut par le code numérique.
3. **Offres du vendeur** : `offer_message` d'un autre que moi, la plus récente. Ces
   entités **n'ont pas de statut** : il se déduit de la transaction — `pending` si
   `transaction.status === 1` et `item_is_closed === false`, `cancelled` sinon. C'est le
   point le plus incertain du relevé (les codes de transaction observés sont 1, 450,
   500, 510, 520, sans vocabulaire connu) : le repli est donc conservateur, « en attente
   » n'est affiché que dans le cas explicitement reconnu.
4. **La plus récente des deux gagne.** Une contre-offre du vendeur postérieure à mon
   offre refusée est bien l'état courant (conversation 23962918496 : offre à 150 €
   refusée à 18:33, le vendeur propose 205 € à 18:34).
5. **Un article fermé n'a plus d'offre en attente**, quel que soit le code :
   `item_is_closed` dégrade `pending` en `cancelled`.
6. **Les lots** (`is_bundle`, plusieurs `item_ids`) marquent chacun de leurs articles de
   la même offre. Rare, mais une offre groupée est bien une offre sur chacun.

## 4. Collecte

**Dans le content script d'un onglet Vinted**, pour les raisons du §1 de
[suivi-prix.md](suivi-prix.md), auxquelles s'en ajoute une décisive : l'API répond 403
sans cookies de session, et le service worker n'en a pas.

Un scan, dans l'ordre :

1. l'état ; freiné → on ne fait rien ;
2. `userId` s'il manque (une requête, une seule fois par installation) ;
3. **l'incrémental** : les pages d'inbox du plus récent au plus ancien, en ne détaillant
   que les conversations dont `updated_at > cursor`. Tout changement d'offre remonte la
   conversation en tête — c'est ce qui rend l'incrémental suffisant. On s'arrête à la
   première conversation déjà vue ;
4. **le rattrapage** : au premier scan, il n'y a pas de `cursor` et tout l'historique
   est à lire. Il se fait par tranches de {@link MAX_DETAILS_PER_SCAN} conversations, la
   reprise étant mémorisée dans `backfillBefore`. Une inbox de 500 conversations s'étale
   ainsi sur plusieurs scans au lieu de tenir la page une minute.

En régime courant : **une requête** (la première page d'inbox), zéro détail. Sans
commune mesure avec le suivi de prix, qui relit des fiches de 2,6 Mo.

Les requêtes sont espacées de {@link SCAN_DELAY_MS}, un 429/403 pose une fenêtre de
silence, et le scan s'arrête si l'onglet passe en arrière-plan — mêmes règles que le
cycle de suivi, sans partager son seau à jetons : ce sont deux budgets, deux ordres de
grandeur (quelques kilo-octets de JSON contre plusieurs mégaoctets de HTML).

**Déclenchement** : le panneau envoie `VF_OFFERS_SCAN` à un onglet Vinted à son
ouverture, si le dernier scan remonte à plus de {@link SCAN_EVERY_MS}. Indépendant du
cycle de suivi, et non greffé dessus : le suivi est freiné par un budget quotidien et
une fenêtre de deux heures, dont les offres n'ont pas à hériter.

**Écriture** : une offre n'est écrite que sur un article **présent dans `savedItems`**,
et jamais par-dessus une offre plus récente — les conversations sont parcourues du plus
récent au plus ancien, et un même article peut en avoir plusieurs. Une offre qui
disparaît de la conversation qui l'avait posée est effacée.

## 5. Affichage

**Sur la ligne, à côté du prix** — le badge n'apparaît que s'il y a une offre :

| État                         | Badge                             |
| ---------------------------- | --------------------------------- |
| mon offre en attente         | `Offre 399 € · il y a 3 h`        |
| le vendeur propose           | `Vendeur 205 € · il y a 2 j`      |
| acceptée / refusée / annulée | même chose, grisé, `Refusée 42 €` |

L'ancienneté est **relative et recalculée**, jamais stockée : `formatAgo()` sur `at`,
rafraîchi toutes les 5 minutes par un `setInterval` qui ne réécrit que le texte des
badges — pas de relecture du storage, pas de rendu de liste, et donc rien qui puisse
bouger sous la souris.

**L'onglet « Sous offres »** (💸), à gauche d'« Archives ». Ce n'est **pas une
collection** : l'article reste dans la sienne, `collectionOf()` n'en sait rien, et rien
ne s'y dépose au glisser. C'est une vue, portée par un `activeCollectionId` réservé
(`view:offers`) que le panneau interprète comme un filtre. Elle contient les offres en
attente (les deux côtés), sur des articles ni vendus ni retirés, et sa pastille en donne
le nombre — la seule information qu'on veuille piloter du regard.

## 6. Ce que cette spec ne fait pas

- **aucun historique d'offres** : le champ décrit l'état courant et rien d'autre ;
- **aucune action** : ni faire, ni accepter, ni refuser une offre depuis l'extension. La
  lecture est same-origin et sans effet ; écrire exigerait le `X-CSRF-Token` et
  engagerait l'utilisateur — c'est une tout autre décision ;
- **aucune notification** : le badge et la pastille suffisent, comme pour les baisses de
  prix ;
- **rien sur les offres reçues en tant que vendeur.** Elles existent dans la même inbox
  et sont explicitement écartées.
