/**
 * Logique pure du suivi de prix — voir docs/specs/suivi-prix.md.
 *
 * Chacun de ces tests doit rougir si l'on neutralise le correctif correspondant
 * (méthode de debug, point 3 du CLAUDE.md) : c'est vérifié dans les commentaires
 * de chaque cas, pas seulement affirmé ici.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyCheckResult,
  dueForCheck,
  isMeaningfulDrop,
  isSweepRunning,
  isSweepStale,
  isThrottled,
  SWEEP_STALE_MS,
  nextThrottle,
  orderForCheck,
  priceDropRatio,
  pushPricePoint,
  takeDailyBudget,
  takeToken,
  DAILY_CAP,
  RATE,
} from '../src/shared/watch.ts';
import type { TokenBucket } from '../src/shared/watch.ts';
import { PRICE_HISTORY_MAX } from '../src/shared/types.ts';
import { makeItem } from './factories.ts';

describe('pushPricePoint', () => {
  test('un prix identique n’ajoute pas de point', () => {
    const history = [{ at: 1000, price: 20 }];
    assert.equal(pushPricePoint(history, 20, 2000), history);
  });

  test('un prix qui change ajoute un point', () => {
    const history = [{ at: 1000, price: 20 }];
    const next = pushPricePoint(history, 18, 2000);
    assert.deepEqual(next, [
      { at: 1000, price: 20 },
      { at: 2000, price: 18 },
    ]);
  });

  test('l’historique vide pose son premier point sans rien avoir à comparer', () => {
    assert.deepEqual(pushPricePoint(undefined, 20, 1000), [{ at: 1000, price: 20 }]);
  });

  test('le premier point survit à l’éviction, les intermédiaires non', () => {
    const history = Array.from({ length: PRICE_HISTORY_MAX }, (_, i) => ({
      at: i,
      price: 100 + i,
    }));

    const next = pushPricePoint(history, 999, PRICE_HISTORY_MAX);

    assert.equal(next.length, PRICE_HISTORY_MAX);
    assert.deepEqual(next[0], { at: 0, price: 100 }, 'le premier point (référence) doit rester');
    assert.deepEqual(
      next.at(-1),
      { at: PRICE_HISTORY_MAX, price: 999 },
      'le nouveau point doit être posé'
    );
    // Le point juste après le premier a été évincé : celui d'après (index 2
    // d'origine) doit maintenant se trouver en position 1.
    assert.deepEqual(next[1], { at: 2, price: 102 });
  });
});

describe('priceDropRatio', () => {
  test('un seul point : rien à comparer', () => {
    assert.equal(priceDropRatio([{ at: 1, price: 20 }]), null);
  });

  test('aucun historique : rien à comparer', () => {
    assert.equal(priceDropRatio(undefined), null);
  });

  test('compare le premier point à jamais, pas le point précédent', () => {
    const history = [
      { at: 1, price: 100 },
      { at: 2, price: 90 },
      { at: 3, price: 80 },
    ];
    const change = priceDropRatio(history);
    assert.ok(change);
    assert.equal(change.fromPrice, 100);
    assert.equal(change.toPrice, 80);
    assert.equal(change.ratio, -0.2);
  });
});

describe('isMeaningfulDrop', () => {
  test('une hausse n’est jamais une baisse', () => {
    assert.equal(isMeaningfulDrop(100, 110), false);
  });

  test('un fort pourcentage sur un article bon marché ne suffit pas', () => {
    // 30 % d'un article à 5 € : 1,50 € de baisse, sous le seuil absolu.
    assert.equal(isMeaningfulDrop(5, 3.5), false);
  });

  test('un faible pourcentage sur un article cher ne suffit pas', () => {
    // 2 % de 200 € : 4 €, au-dessus du seuil absolu mais sous le seuil relatif.
    assert.equal(isMeaningfulDrop(200, 196), false);
  });

  test('les deux seuils réunis déclenchent le signalement', () => {
    assert.equal(isMeaningfulDrop(100, 80), true);
  });
});

describe('applyCheckResult', () => {
  const now = 5000;

  test('un 404 isolé ne marque pas gone', () => {
    const item = makeItem({ id: '1' });
    const patch = applyCheckResult(item, { kind: 'notFound' }, now);
    assert.equal(patch.status, undefined);
    assert.equal(patch.missCount, 1);
    assert.equal(patch.lastCheckedAt, now);
  });

  test('deux 404 consécutifs marquent gone', () => {
    const item = makeItem({ id: '1', missCount: 1 });
    const patch = applyCheckResult(item, { kind: 'notFound' }, now);
    assert.equal(patch.status, 'gone');
    assert.equal(patch.missCount, 2);
  });

  test('un badge vendu marque sold en une seule occurrence', () => {
    const item = makeItem({ id: '1' });
    const patch = applyCheckResult(item, { kind: 'sold' }, now);
    assert.equal(patch.status, 'sold');
    assert.equal(patch.missCount, 0);
  });

  test('une réponse illisible n’avance que lastCheckedAt', () => {
    // Ni disparu (aucun `missCount`, sinon deux cycles suffiraient à marquer
    // gone un article bien vivant), ni intact : seulement interrogé. La date
    // avance pour qu'il cède sa place en tête de file au cycle suivant.
    const item = makeItem({ id: '1', missCount: 1, lastCheckedAt: 1 });
    assert.deepEqual(applyCheckResult(item, { kind: 'unreadable' }, now), { lastCheckedAt: now });
  });

  test('un timeout ne touche à rien', () => {
    const item = makeItem({ id: '1', missCount: 1, lastCheckedAt: 1 });
    assert.deepEqual(applyCheckResult(item, { kind: 'failure' }, now), {});
  });

  test('un id divergent ne touche à rien', () => {
    const item = makeItem({ id: '1', missCount: 1, lastCheckedAt: 1 });
    assert.deepEqual(applyCheckResult(item, { kind: 'idMismatch' }, now), {});
  });

  test('une lecture aboutie remet missCount à 0 et pousse le prix', () => {
    const item = makeItem({
      id: '1',
      missCount: 1,
      priceValue: 30,
      priceHistory: [{ at: 1, price: 30 }],
    });
    const patch = applyCheckResult(item, { kind: 'active', price: 25, priceText: '25,00 €' }, now);
    assert.equal(patch.missCount, 0);
    assert.deepEqual(patch.priceHistory, [
      { at: 1, price: 30 },
      { at: now, price: 25 },
    ]);
  });

  test('met à jour le prix affiché, sinon la ligne reste figée sur le prix d’enregistrement', () => {
    const item = makeItem({ id: '1', price: '100,00 €', priceValue: 100 });
    const patch = applyCheckResult(item, { kind: 'active', price: 80, priceText: '80,00 €' }, now);
    assert.equal(patch.price, '80,00 €');
    assert.equal(patch.priceValue, 80);
  });

  test('amorce l’historique avec le prix déjà connu si le tout premier contrôle voit un prix différent', () => {
    // Un article dont le prix a déjà bougé avant sa toute première vérification :
    // sans amorçage, le nouveau prix serait enregistré comme s'il avait toujours
    // été celui-là, et le badge de variation n'aurait plus rien à comparer.
    const item = makeItem({ id: '1', savedAt: 1000, priceValue: 100, priceHistory: undefined });
    const patch = applyCheckResult(item, { kind: 'active', price: 80, priceText: '80,00 €' }, now);
    assert.deepEqual(patch.priceHistory, [
      { at: 1000, price: 100 },
      { at: now, price: 80 },
    ]);
  });

  test('n’amorce rien si le premier contrôle confirme le prix déjà connu', () => {
    const item = makeItem({ id: '1', savedAt: 1000, priceValue: 100, priceHistory: undefined });
    const patch = applyCheckResult(
      item,
      { kind: 'active', price: 100, priceText: '100,00 €' },
      now
    );
    assert.deepEqual(patch.priceHistory, [{ at: now, price: 100 }]);
  });

  test('n’amorce pas une seconde fois un historique déjà commencé', () => {
    const item = makeItem({
      id: '1',
      savedAt: 1000,
      priceValue: 90,
      priceHistory: [{ at: 500, price: 90 }],
    });
    const patch = applyCheckResult(item, { kind: 'active', price: 80, priceText: '80,00 €' }, now);
    assert.deepEqual(patch.priceHistory, [
      { at: 500, price: 90 },
      { at: now, price: 80 },
    ]);
  });
});

describe('dueForCheck', () => {
  test('un ajout en attente n’est pas éligible', () => {
    assert.equal(dueForCheck(makeItem({ id: '1', pending: true })), false);
  });

  test('un article vendu ou disparu n’est plus revérifié', () => {
    assert.equal(dueForCheck(makeItem({ id: '1', status: 'sold' })), false);
    assert.equal(dueForCheck(makeItem({ id: '2', status: 'gone' })), false);
  });

  test('un article actif est éligible', () => {
    assert.equal(dueForCheck(makeItem({ id: '1' })), true);
  });
});

describe('orderForCheck', () => {
  test('le plus périmé passe en premier', () => {
    const items = [
      makeItem({ id: 'a', lastCheckedAt: 3000 }),
      makeItem({ id: 'b', lastCheckedAt: 1000 }),
      makeItem({ id: 'c' }), // jamais vérifié : doit passer avant tout le monde
    ];
    // random proche de 1 : le tirage Fisher-Yates retombe systématiquement sur
    // l'indice courant (aucun échange), ce qui isole le tri de tout mélange.
    const ordered = orderForCheck(items, () => 0.999);
    assert.deepEqual(
      ordered.map((i) => i.id),
      ['c', 'b', 'a']
    );
  });

  test('exclut les articles non éligibles', () => {
    const items = [makeItem({ id: 'a' }), makeItem({ id: 'b', pending: true })];
    assert.deepEqual(
      orderForCheck(items).map((i) => i.id),
      ['a']
    );
  });

  test('mélange à l’intérieur d’une tranche sans sortir de la tranche', () => {
    const items = Array.from({ length: 12 }, (_, i) =>
      makeItem({ id: String(i), lastCheckedAt: i })
    );
    // Source d'aléa qui choisit systématiquement le dernier indice de la tranche.
    const ordered = orderForCheck(items, () => 0.999);
    const ids = ordered.map((i) => Number(i.id));
    // La seconde tranche (items 10 et 11) ne doit jamais remonter dans la première.
    assert.ok(ids.slice(0, 10).every((id) => id < 10));
    assert.ok(ids.slice(10).every((id) => id >= 10));
  });
});

describe('seau à jetons', () => {
  test('refuse au-delà du débit', () => {
    let bucket: TokenBucket = { tokens: RATE.capacity, at: 0 };
    let refused = 0;
    for (let i = 0; i < RATE.capacity + 1; i += 1) {
      const result = takeToken(bucket, 0);
      bucket = result.bucket;
      if (!result.ok) refused += 1;
    }
    assert.equal(refused, 1, 'exactement une requête doit être refusée après la pointe');
  });

  test('se recharge avec le temps, plafonné à la capacité', () => {
    const empty = { tokens: 0, at: 0 };
    const oneMinuteLater = takeToken(empty, 60000);
    assert.equal(
      oneMinuteLater.ok,
      true,
      'le régime de croisière doit avoir rechargé au moins un jeton'
    );

    const farLater = takeToken({ tokens: 0, at: 0 }, 10 * 60000);
    // Même après un temps très long, le seau ne dépasse jamais sa capacité.
    assert.ok(farLater.bucket.tokens <= RATE.capacity - 1);
  });
});

describe('budget quotidien', () => {
  test('refuse au-delà du plafond', () => {
    const full = { day: '2026-07-28', used: DAILY_CAP };
    const result = takeDailyBudget(full, Date.parse('2026-07-28T10:00:00Z'));
    assert.equal(result.ok, false);
  });

  test('repart de zéro un autre jour', () => {
    const full = { day: '2026-07-27', used: DAILY_CAP };
    const result = takeDailyBudget(full, Date.parse('2026-07-28T00:00:01Z'));
    assert.equal(result.ok, true);
    assert.equal(result.budget.used, 1);
  });
});

describe('backoff', () => {
  test('isThrottled est vrai pendant la fenêtre, faux après', () => {
    assert.equal(isThrottled({ throttledUntil: 2000 }, 1000), true);
    assert.equal(isThrottled({ throttledUntil: 2000 }, 3000), false);
    assert.equal(isThrottled({}, 1000), false);
  });

  test('nextThrottle croît avec les coups de frein successifs', () => {
    const first = nextThrottle(0, 0) - 0;
    const second = nextThrottle(0, 1) - 0;
    assert.ok(second > first, 'un deuxième coup de frein doit imposer une pause plus longue');
  });
});

describe('signe de vie d’un cycle', () => {
  const now = 1_000_000_000;

  test('un cycle qui bat est vivant, même en pause', () => {
    // La pause de §3.6 fait battre `at` exprès : c'est ce qui la distingue d'un
    // onglet fermé, et le seul moyen de garder l'avancement acquis à l'écran.
    const paused = { done: 3, total: 9, startedAt: now - 300_000, at: now - 5_000, paused: true };
    assert.equal(isSweepStale(paused, now), false);
    assert.equal(isSweepRunning({ progress: paused }, now), true);
  });

  test('un cycle silencieux depuis trop longtemps est mort', () => {
    // Onglet fermé en plein cycle : personne ne nettoiera `progress`. Sans ce
    // verdict, le bouton reste figé sur « 3/9 » et chaque clic annule un cycle
    // qui n'existe plus.
    const orphan = { done: 3, total: 9, startedAt: now - 600_000, at: now - SWEEP_STALE_MS - 1 };
    assert.equal(isSweepStale(orphan, now), true);
    assert.equal(isSweepRunning({ progress: orphan }, now), false);
  });

  test('sans cycle annoncé, il n’y a rien de périmé ni rien en cours', () => {
    assert.equal(isSweepStale(undefined, now), false);
    assert.equal(isSweepRunning({}, now), false);
    assert.equal(isSweepRunning(undefined, now), false);
  });
});
