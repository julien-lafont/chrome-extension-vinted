# Pièges

Les bugs qui ont réellement mordu sur ce projet, avec leurs garde-fous. Tous
partagent un trait : ils se manifestent **par intermittence et sans aucune erreur
en console**, ce qui rend le diagnostic par déduction très coûteux.

À lire avant de toucher aux boutons injectés ou au glisser-déposer.

---

# Content script

Les garde-fous de cette section sont couverts par `tests/repaint-loop.test.mjs` et
`tests/click-gestures.test.mjs` : ne pas les retirer sans faire tomber la suite.

## Les clics fantômes

`click` est un événement **synthétisé**. Le navigateur ne l'émet que s'il juge le
geste comme un clic, et le supprime silencieusement quand :

- une **sélection de texte** démarre sur le libellé du bouton ;
- le pointeur **glisse** de quelques pixels entre l'appui et le relâchement ;
- la cible du `mousedown` a **disparu** avant le `mouseup`.

### Le déclencheur souris est `pointerdown`

`pointerdown` est inconditionnel : aucune heuristique du navigateur ne peut le
supprimer. Le `click` du même geste est neutralisé pour éviter un double
déclenchement, et n'agit que si `event.detail === 0` — le marqueur d'une
activation **clavier** (Entrée / Espace), ce qui préserve l'accessibilité.

```js
btn.addEventListener('pointerdown', activate);
btn.addEventListener('click', (event) => {
  event.preventDefault();
  event.stopPropagation();
  if (event.detail === 0) activate(event); // clavier uniquement
});
```

### Quatre règles CSS complètent le dispositif

1. **`user-select: none`** sur le bouton. Sans ça, presser sur le libellé arme une
   sélection de texte : le moindre déplacement la déclenche et supprime le `click`.
   *Symptôme caractéristique : le bouton répond sur l'icône mais pas sur le texte.*
2. **`pointer-events: none` sur tous les enfants** (`> *`), pour que le clic cible
   toujours le `<button>` et jamais un `<svg>` ou un `<span>` susceptible d'être
   recréé entre l'appui et le relâchement.
3. **Jamais de `transform` au `:hover`.** Déplacer l'élément sous le curseur le
   fait sortir de sa propre zone de survol près des bords : hover → déplacement →
   unhover → retour → hover… Le bouton oscille et avale le clic. On n'anime que
   des propriétés de peinture (couleur, ombre).
4. **Rester hors de la barre d'action sticky de Vinted** (d'où `bottom: 104px` sur
   la fiche article), sinon elle recouvre une partie du bouton — cliquable en
   haut, morte en bas.

## La boucle de repeint

Le `MutationObserver` surveille `document.body`. Un repeint qui écrit dans le DOM
sans condition déclenche l'observer, qui relance un scan, qui repeint… à chaque
frame :

```
clic → storage.set → chrome.storage.onChanged → repaintAll()
     → innerHTML → MutationObserver → scan() → injectDetailButton()
     → innerHTML → … 60 fois par seconde
```

La page rame, et le bouton devient **incliquable** : ses enfants sont recréés entre
le `mousedown` et le `mouseup`.

### Trois garde-fous dans `content.js`

1. `paintButton()` sort immédiatement si l'état affiché est déjà le bon
   (`dataset.vfPainted`)
2. l'observer **ignore les mutations issues de nos propres boutons**
3. `injectDetailButton()` ne ré-extrait rien tant que `location.pathname` n'a pas
   changé

*Symptôme caractéristique : le catalogue fonctionne mais pas la fiche article.* Les
cartes sont protégées par leur flag d'injection (`dataset.vfInjected`), le bouton
flottant ne l'était pas.

## Leçon de méthode : le stub qui ment

La première tentative de reproduction de la boucle a été **négative à tort**. Le
test stubbait `chrome.storage.onChanged` en no-op — ce qui supprimait précisément
le chaînon déclencheur. Le bug était bien présent, le test affirmait le contraire.

`tests/harness.mjs` notifie donc les listeners `onChanged` à chaque écriture,
**y compris pour l'onglet qui vient d'écrire**, comme le vrai Chrome.

Règle : un double d'API qui simplifie le comportement qu'on cherche justement à
tester ne prouve rien.

## Autres pièges du content script

**Extension rechargée sans recharger l'onglet** — `chrome.storage` lève alors
« Extension context invalidated » et le clic échoue en silence. Le handler capture
l'erreur dans `debug.lastError`, que le [Diagnostic](diagnostic.md) affiche.

**`elementFromPoint` n'existe pas dans jsdom** — le diagnostic le teste avant
usage et rapporte `clickablePoints: "indéterminé"` plutôt que de planter.

**L'URL du catalogue traîne un `?referrer=`** — retiré à l'extraction, sinon deux
enregistrements du même article produisent des URLs différentes.

---

# Panneau latéral

## Le glisser-déposer

Trois règles rendent le dépôt prévisible, chacune corrigeant un « la carte ne reste
pas où je la lâche » :

1. **Le calcul se fait dans la disposition sans le fantôme.** C'est le piège
   central. Le fantôme occupe la hauteur d'une carte et repousse tout ce qui le
   suit : comparer le centre de la carte saisie aux positions *courantes* des
   voisins oblige à parcourir **une carte entière** pour gagner un seul rang, là où
   l'utilisateur attend une demi-carte. Symptôme : on déplace la carte d'une
   demi-hauteur, rien ne bouge, et au relâchement elle revient à sa place — « figée
   entre deux zones ». `reposition()` recalcule donc la position qu'auraient les
   voisins si le fantôme disparaissait (ceux qui le suivent remontent de sa
   hauteur), puis retient l'emplacement dont le centre est le plus proche.

   Raisonner par *emplacement* plutôt que par « voisin à dépasser » gère au passage
   les cartes de hauteurs inégales — un titre tient sur une ou deux lignes.

2. **Le mode Personnalisé ignore `sortDir`.** L'ordre manuel *est* l'ordre voulu ;
   lui appliquer un sens le retournerait intégralement dès qu'on arrive d'un tri
   descendant — date d'ajout, prix décroissant, likes… d'où un bug qui ne se
   manifestait qu'une fois sur deux. Le bouton de sens est masqué dans ce mode.
3. **Un dépôt = une seule écriture** (`commitCustomOrder`). Écrire le mode puis
   l'ordre déclenchait deux rendus, et celui du milieu — mode déjà manuel, ordre
   pas encore enregistré — faisait reculer la carte avant qu'elle se replace.

Ces trois défauts sont invisibles aux tests d'ordre : la logique de tri était juste,
c'est le geste qui ne l'était pas. Ils ne se voient qu'en rejouant un vrai glisser
dans un navigateur — voir [testing.md](testing.md).

Réordonner **avec une recherche active** ne déplace que les articles visibles : les
articles masqués par le filtre gardent leur position dans l'ordre complet de la
collection, au lieu d'être repoussés à la fin.

**Un rendu pendant un glisser détruirait l'élément saisi** : `sidepanel.js` diffère
le rendu (`dragging` / `renderPending`) jusqu'au relâchement.

`dnd.js` s'appuie sur les Pointer Events plutôt que sur l'API HTML5 drag-and-drop,
qui ne donne aucun retour visuel exploitable dans un panneau étroit et gère mal le
défilement.

## Le canal se ferme quand la page navigue

> `A listener indicated an asynchronous response by returning true, but the
> message channel closed before a response was received`

Ce message ne dit **pas** que l'action a échoué : il dit que le content script a
disparu avant de répondre. Valider une offre fait naviguer Vinted vers la
conversation, ce qui détruit l'agent — l'offre était pourtant bien partie.

Trois règles en découlent :

1. **Une opération = un aller-retour court.** L'offre et le message sont deux
   messages distincts (`VF_MAKE_OFFER`, `VF_SEND_MESSAGE`), pas un enchaînement
   côté page. Entre les deux, le panneau attend que l'onglet réponde de nouveau
   avec `readyState === 'complete'` : c'est ce qui permet de survivre à la
   navigation.
2. **Une erreur de canal n'est pas un échec métier.** `CHANNEL_LOST` dans
   `offer.js` reconnaît ces messages (canal fermé, *receiving end does not
   exist*, contexte invalidé) et poursuit, au lieu de rapporter une panne.
3. **`offer-agent.js` est déclaré sur `https://www.vinted.fr/*`**, pas seulement
   sur `/items/*` : après navigation, le message s'envoie depuis la messagerie.
   L'agent reste inerte tant qu'on ne lui parle pas.

**Garde-fou** : avant d'écrire dans une conversation, l'agent vérifie que la page
renvoie bien à l'article visé (`a[href*="/items/{id}"]`, ou URL de la fiche). Sans
cette preuve il renonce et le dit — un message adressé au mauvais vendeur ne se
rattrape pas. Le panneau propose alors **Copier** pour un envoi manuel : une offre
partie n'est jamais présentée comme un échec, et le texte n'est pas perdu.

## Écrire dans un champ React

Vinted est une application React. Affecter `field.value = …` est **silencieusement
ignoré** : React conserve son état interne et le bouton d'envoi reste désactivé,
sans qu'aucune erreur n'apparaisse.

Il faut passer par le setter natif, puis émettre l'événement que React écoute :

```js
const setter = Object.getOwnPropertyDescriptor(
  window.HTMLInputElement.prototype, 'value'
).set;
setter.call(field, value);
field.dispatchEvent(new Event('input', { bubbles: true }));
```

Voir `offer-agent.js`. Le même piège vaut pour tout pilotage d'une interface tierce
moderne.
