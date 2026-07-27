/**
 * Où se pose une carte qu'on fait glisser ?
 *
 * Le fantôme laissé dans le flux occupe la hauteur d'une carte et repousse tout ce
 * qui le suit. Une première version comparait le centre de la carte saisie aux
 * positions *courantes* des voisins : il fallait alors parcourir une carte entière
 * pour gagner un seul rang, au lieu d'une demi-carte. La carte semblait « figée
 * entre deux zones », et revenait à sa place au relâchement.
 *
 * Ces cas ne sont pas couverts par les tests d'ordre : la logique de tri était
 * juste, c'est la géométrie du geste qui ne l'était pas.
 * Voir docs/pitfalls.md.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { pickSlot } from '../src/sidepanel/dnd.js';

const H = 100; // hauteur d'une carte, chiffre rond pour lire les cas

/**
 * Liste de `count` cartes empilées depuis y=0, dont une — le fantôme — est retirée.
 * @param {number} ghostIndex emplacement occupé par le fantôme
 */
function layout(count, ghostIndex, height = H) {
  const boxes = [];
  for (let i = 0; i < count; i += 1) {
    // Les voisins placés après le fantôme sont décalés de sa hauteur.
    boxes.push({ top: i * height + (i >= ghostIndex ? height : 0), height });
  }
  return boxes;
}

/** Centre de la carte saisie après un déplacement de `cards` hauteurs. */
const centerAfter = (ghostIndex, cards, height = H) =>
  ghostIndex * height + height / 2 + cards * height;

describe('emplacement visé pendant un glisser', () => {
  test('sans mouvement, la carte garde son emplacement', () => {
    for (const ghostIndex of [0, 2, 4]) {
      const boxes = layout(5, ghostIndex);
      assert.equal(pickSlot(centerAfter(ghostIndex, 0), H, ghostIndex, boxes), ghostIndex);
    }
  });

  test('bascule à la demi-carte, pas à la carte entière', () => {
    const boxes = layout(5, 0);

    // Le bug : il fallait descendre d'une carte complète pour bouger d'un rang.
    assert.equal(pickSlot(centerAfter(0, 0.3), H, 0, boxes), 0, 'trop tôt sous le seuil');
    assert.equal(pickSlot(centerAfter(0, 0.7), H, 0, boxes), 1, '0,7 carte doit suffire');
    assert.equal(pickSlot(centerAfter(0, 1.0), H, 0, boxes), 1);
  });

  test('n hauteurs parcourues valent n rangs gagnés', () => {
    const boxes = layout(6, 0);
    for (const cards of [1, 2, 3, 4, 5]) {
      assert.equal(pickSlot(centerAfter(0, cards), H, 0, boxes), cards, `${cards} carte(s)`);
    }
  });

  test('remonter fonctionne symétriquement', () => {
    const ghostIndex = 4;
    const boxes = layout(6, ghostIndex);
    assert.equal(pickSlot(centerAfter(ghostIndex, -0.3), H, ghostIndex, boxes), 4);
    assert.equal(pickSlot(centerAfter(ghostIndex, -0.7), H, ghostIndex, boxes), 3);
    assert.equal(pickSlot(centerAfter(ghostIndex, -2), H, ghostIndex, boxes), 2);
    assert.equal(pickSlot(centerAfter(ghostIndex, -4), H, ghostIndex, boxes), 0);
  });

  test('le dernier emplacement est atteignable', () => {
    const boxes = layout(5, 0);
    assert.equal(pickSlot(centerAfter(0, 5), H, 0, boxes), 5, 'dépôt en fin de liste');
    // Bien au-delà du bas : on reste sur le dernier emplacement.
    assert.equal(pickSlot(centerAfter(0, 40), H, 0, boxes), 5);
  });

  test('des cartes de hauteurs inégales ne décalent pas la cible', () => {
    // Titres sur deux lignes : la 2e et la 4e carte sont plus hautes.
    const heights = [100, 140, 100, 140, 100];
    const ghostIndex = 0;
    const boxes = [];
    let y = H; // le fantôme (hauteur H) occupe le premier emplacement
    for (const height of heights) {
      boxes.push({ top: y, height });
      y += height;
    }

    // Le centre visé est celui du 3e emplacement, calculé sur les hauteurs réelles.
    const target = boxes[1].top - H + boxes[1].height + H / 2;
    assert.equal(pickSlot(target, H, ghostIndex, boxes), 2);
  });

  test('une liste sans voisin ne plante pas', () => {
    assert.equal(pickSlot(0, H, 0, []), 0);
  });
});
