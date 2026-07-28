/**
 * Filtrage du bruit — les règles, sans DOM ni storage.
 *
 * Le test qui vaut tous les autres est le premier : c'est celui qui empêche la
 * version où « lot » masque les culottes, et cette version-là ferait désinstaller
 * l'extension avant qu'on ait lu le rapport de bug.
 *
 * Voir `docs/specs/filtrage-bruit.md` §3 et §11.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  FAST_FASHION,
  NOISE_HIDDEN_MAX,
  NOISE_RECENT_MAX,
  NOISE_RULES_MAX,
  addRule,
  addSeller,
  emptyNoise,
  hasActiveRules,
  matchesBrand,
  matchesWord,
  normalize,
  pushHidden,
  removeRule,
  unhide,
  verdictFor,
} from '../src/shared/noise.ts';
import type { NoiseFilters } from '../src/shared/noise.ts';
import type { ItemMap, SavedItem } from '../src/shared/types.ts';

/** Un article enregistré, réduit à ce que le verdict regarde. */
const savedItem = (id: string): ItemMap => ({ [id]: { id } as SavedItem });

function withRules(patch: Partial<NoiseFilters>): NoiseFilters {
  return { ...emptyNoise(), ...patch };
}

describe('mots exclus — la correspondance par mot entier', () => {
  test('« lot » ne masque ni « culotte » ni « salopette »', () => {
    const rules = ['lot'];

    assert.equal(matchesWord('Culotte en dentelle', rules), null);
    assert.equal(matchesWord('Salopette Levis', rules), null);
    assert.equal(matchesWord('Philosophie di Alberta Ferretti', rules), null);

    // Et il masque bien ce pour quoi on l'a écrit.
    assert.equal(matchesWord('Lot de 3 t-shirts', rules), 'lot');
    assert.equal(matchesWord('Superbe lot enfant', rules), 'lot');
  });

  test('la ponctuation borne les mots comme un espace', () => {
    assert.equal(matchesWord('Veste (lot) à saisir', ['lot']), 'lot');
    assert.equal(matchesWord('Nike, inspiré vintage', ['inspire']), 'inspire');
  });

  test('les accents ne changent rien, dans un sens comme dans l’autre', () => {
    assert.equal(matchesWord('Sac INSPIRÉ d’un modèle', ['inspire']), 'inspire');
    assert.equal(matchesWord('Réplique fidèle', ['replique']), 'replique');
  });

  test('une règle de plusieurs mots marche sans traitement particulier', () => {
    assert.equal(
      matchesWord('Robe neuf avec etiquette taille S', ['neuf avec etiquette']),
      'neuf avec etiquette'
    );
    assert.equal(matchesWord('Robe neuve, etiquette absente', ['neuf avec etiquette']), null);
  });

  test('aucune règle : aucun travail, aucun faux positif', () => {
    assert.equal(matchesWord('Lot de 3 t-shirts', []), null);
  });
});

describe('marques masquées', () => {
  test('« zara » masque ses déclinaisons mais pas « zarautz »', () => {
    const rules = ['zara'];

    assert.equal(matchesBrand('Zara', rules), 'zara');
    assert.equal(matchesBrand('Zara Kids', rules), 'zara');
    assert.equal(matchesBrand('ZARA MAN', rules), 'zara');
    assert.equal(matchesBrand('Zarautz', rules), null);
    assert.equal(matchesBrand('Zaram', rules), null);
  });

  test('la ponctuation d’une marque est conservée', () => {
    // `h&m` amputé de son esperluette deviendrait introuvable.
    assert.equal(normalize('H&M'), 'h&m');
    assert.equal(matchesBrand('H&M', ['h&m']), 'h&m');
    assert.equal(matchesBrand('Pull & Bear', ['pull & bear']), 'pull & bear');
  });

  test('une marque vide ne correspond à rien', () => {
    assert.equal(matchesBrand('', ['zara']), null);
    assert.equal(matchesBrand('   ', ['zara']), null);
  });
});

describe('verdict', () => {
  test('un article enregistré n’est jamais masqué, quelle que soit la règle', () => {
    const noise = withRules({
      brands: ['zara'],
      words: ['lot'],
      hidden: { '42': 1 },
      sellers: { '7': { name: 'pro', at: 1 } },
    });

    const decision = verdictFor(
      { id: '42', title: 'Lot de vestes', brand: 'Zara', sellerId: '7' },
      noise,
      savedItem('42')
    );

    assert.equal(decision.verdict, '0', "l'enregistrement l'emporte sur toute règle générale");
  });

  test('l’ordre des motifs va du plus précis au plus large', () => {
    const base = { id: '42', title: 'Lot de vestes', brand: 'Zara', sellerId: '7' };

    assert.equal(verdictFor(base, withRules({ hidden: { '42': 1 } }), {}).verdict, 'item');
    assert.equal(
      verdictFor(base, withRules({ sellers: { '7': { name: 'pro', at: 1 } } }), {}).verdict,
      'seller'
    );
    assert.equal(verdictFor(base, withRules({ brands: ['zara'] }), {}).verdict, 'brand');
    assert.equal(verdictFor(base, withRules({ words: ['lot'] }), {}).verdict, 'word');
    assert.equal(verdictFor(base, emptyNoise(), {}).verdict, '0');
  });

  test('un vendeur inconnu ne fait jamais correspondre une règle de vendeur', () => {
    const noise = withRules({ sellers: { '7': { name: 'pro', at: 1 } } });

    // C'est le cas d'une carte de catalogue quand le flux ne porte pas les
    // vendeurs (§7) : rien ne doit être masqué par hasard.
    assert.equal(verdictFor({ id: '42', sellerId: null }, noise, {}).verdict, '0');
    assert.equal(verdictFor({ id: '42' }, noise, {}).verdict, '0');
  });

  test('le motif est lisible : c’est ce qui s’affiche au survol', () => {
    const decision = verdictFor({ id: '42', brand: 'Zara' }, withRules({ brands: ['zara'] }), {});
    assert.match(decision.reason, /zara/);
  });

  test('la marque est examinée aussi par les mots exclus', () => {
    // « inspiré » vit souvent dans le nom de marque libre, pas dans le titre.
    const decision = verdictFor(
      { id: '42', title: 'Sac à main', brand: 'Inspiré Dior' },
      withRules({ words: ['inspire'] }),
      {}
    );
    assert.equal(decision.verdict, 'word');
  });
});

describe('écarts individuels', () => {
  test('pushHidden pose l’article et l’empile dans les récents', () => {
    const next = pushHidden(emptyNoise(), { id: '42', title: 'Veste', at: 10 });

    assert.equal(next.hidden['42'], 10);
    assert.deepEqual(next.recent[0], { id: '42', title: 'Veste', at: 10 });
  });

  test('écarter deux fois le même article ne le duplique pas dans les récents', () => {
    let noise = pushHidden(emptyNoise(), { id: '42', title: 'Veste', at: 10 });
    noise = pushHidden(noise, { id: '42', title: 'Veste', at: 20 });

    assert.equal(noise.recent.length, 1);
    assert.equal(noise.hidden['42'], 20);
  });

  test('les récents sont bornés, les plus anciens sortent', () => {
    let noise = emptyNoise();
    for (let i = 0; i < NOISE_RECENT_MAX + 5; i += 1) {
      noise = pushHidden(noise, { id: String(i), title: `Article ${i}`, at: i });
    }

    assert.equal(noise.recent.length, NOISE_RECENT_MAX);
    assert.equal(noise.recent[0]?.id, String(NOISE_RECENT_MAX + 4), 'le plus récent en tête');
    assert.equal(Object.keys(noise.hidden).length, NOISE_RECENT_MAX + 5, 'les ids, eux, restent');
  });

  test('l’éviction au-delà du plafond retire les plus anciens', () => {
    const hidden: Record<string, number> = {};
    for (let i = 0; i < NOISE_HIDDEN_MAX; i += 1) hidden[`old-${i}`] = i;

    const noise = pushHidden(withRules({ hidden }), { id: 'neuf', title: 'Neuf', at: 10 ** 9 });

    assert.equal(Object.keys(noise.hidden).length, NOISE_HIDDEN_MAX);
    assert.equal(noise.hidden['neuf'], 10 ** 9, 'le dernier écarté survit');
    assert.equal(noise.hidden['old-0'], undefined, 'le plus ancien est évincé');
    assert.equal(noise.hidden['old-1'], 1, 'et lui seul');
  });

  test('unhide est l’inverse exact de pushHidden', () => {
    const noise = pushHidden(emptyNoise(), { id: '42', title: 'Veste', at: 10 });
    const back = unhide(noise, '42');

    assert.deepEqual(back.hidden, {});
    assert.deepEqual(back.recent, []);
  });
});

describe('règles de marque et de mot', () => {
  test('une règle est normalisée à l’écriture', () => {
    const noise = addRule(emptyNoise(), 'brands', '  ZARA  ');
    assert.deepEqual(noise.brands, ['zara']);
  });

  test('une règle déjà présente rend l’objet inchangé', () => {
    const noise = addRule(emptyNoise(), 'brands', 'zara');
    // L'identité de référence est ce qui permet à l'appelant de savoir qu'il n'a
    // rien à écrire, et à la modale de dire « déjà là ».
    assert.equal(addRule(noise, 'brands', 'Zara'), noise);
  });

  test('une règle vide est refusée sans rien changer', () => {
    const noise = emptyNoise();
    assert.equal(addRule(noise, 'words', '   '), noise);
  });

  test('la liste pleine refuse, sans erreur', () => {
    let noise = emptyNoise();
    for (let i = 0; i < NOISE_RULES_MAX; i += 1) noise = addRule(noise, 'words', `mot${i}`);

    assert.equal(noise.words.length, NOISE_RULES_MAX);
    assert.equal(addRule(noise, 'words', 'un-de-plus'), noise);
  });

  test('removeRule ne touche qu’à la règle visée', () => {
    let noise = addRule(emptyNoise(), 'brands', 'zara');
    noise = addRule(noise, 'brands', 'shein');

    assert.deepEqual(removeRule(noise, 'brands', 'zara').brands, ['shein']);
  });
});

describe('jeu fast fashion', () => {
  test('il n’est jamais posé par défaut', () => {
    assert.deepEqual(emptyNoise().brands, []);
  });

  test('l’ajouter deux fois ne dédouble rien', () => {
    const once = FAST_FASHION.reduce((acc, b) => addRule(acc, 'brands', b), emptyNoise());
    const twice = FAST_FASHION.reduce((acc, b) => addRule(acc, 'brands', b), once);

    assert.equal(twice.brands.length, FAST_FASHION.length);
    assert.equal(twice, once, 'aucune écriture à faire la seconde fois');
  });

  test('ses libellés sont déjà normalisés — sinon ils ne mordraient jamais', () => {
    for (const brand of FAST_FASHION) {
      assert.equal(brand, normalize(brand), `« ${brand} » n'est pas sous forme normalisée`);
    }
  });
});

describe('témoin de la bande de réglages', () => {
  test('aucune règle générale : le témoin est éteint', () => {
    // Des articles écartés un par un n'allument pas le témoin : ce n'est pas
    // une règle qui façonne le catalogue, c'est une décision ponctuelle.
    const noise = pushHidden(emptyNoise(), { id: '1', title: 'A', at: 1 });
    assert.equal(hasActiveRules(noise), false);
  });

  test('une marque, un mot ou un vendeur suffit à l’allumer', () => {
    assert.equal(hasActiveRules(addRule(emptyNoise(), 'brands', 'zara')), true);
    assert.equal(hasActiveRules(addRule(emptyNoise(), 'words', 'lot')), true);
    assert.equal(hasActiveRules(addSeller(emptyNoise(), '7', 'pro')), true);
  });
});
