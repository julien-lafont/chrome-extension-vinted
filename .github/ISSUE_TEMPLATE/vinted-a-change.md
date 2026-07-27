---
name: Vinted a changé son DOM
about: Les boutons n'apparaissent plus, ou les articles s'enregistrent vides
labels: bug, dom-vinted
---

<!--
Le cas le plus fréquent sur ce projet. L'extension s'ancre sur les `data-testid`
de Vinted (jamais sur ses classes CSS, qui sont obfusquées) : quand Vinted les
renomme, l'extraction tombe en silence. docs/vinted-dom.md décrit quoi faire.
-->

## Symptôme

- [ ] Aucun bouton n'apparaît sur les cartes
- [ ] Les boutons apparaissent, mais les articles s'enregistrent sans titre / prix /
      image
- [ ] Le bouton de la fiche article a disparu
- [ ] Les blocs du bas de fiche (« Dressing du membre », « Articles similaires ») ne
      sont plus servis

## Rapport de diagnostic

<!--
Indispensable ici : `cardsFound` à 0 dit que le sélecteur de carte ne matche plus ;
`cardsParsed` inférieur à `cardsFound` dit que ce sont les sélecteurs d'enfants qui
ont bougé ; `missing` dit lesquels.
-->

```json

```

## Ancre observée

<!--
Si vous avez inspecté la page : le nouveau `data-testid` de la carte produit.
Un clic droit → Inspecter sur une carte suffit.
-->
