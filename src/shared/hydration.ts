/**
 * Identifiants numériques lus dans le flux React Server Components d'une fiche.
 *
 * Vinted rend la fiche côté serveur puis l'hydrate : plusieurs valeurs n'existent
 * dans aucun nœud au moment où l'extension lit la page, mais sont présentes dès
 * le HTML servi dans les `self.__next_f.push([1,"…"])`, sous forme de blocs JSON
 * échappés :
 *
 *   {"name":"favourite",…,"data":{"item_id":9497504182,"seller_id":286459945,
 *                                 "favourite_count":1,"is_favourite":false}}
 *   {"name":"breadcrumbs",…,"data":{"item_id":9497504182,"brand_id":53,
 *                                   "catalog_id":584,"breadcrumbs":[…]}}
 *   {"name":"user_info_header",…,"data":{"item_id":9508569835,"seller_id":237208752,
 *                                        "name":"ramikljk","feedback_count":4,
 *                                        "feedback_reputation":0.8}}
 *
 * Ce module n'en extrait que des **nombres** — entiers ou décimaux —, et
 * toujours rattachés à un `item_id` : une fiche affiche aussi le dressing du
 * membre et les articles similaires, et un compteur pris au voisin serait faux
 * sans que rien ne le signale. Même précaution que dans `photos.ts`.
 *
 * Les valeurs textuelles (pseudo du vendeur, description) ne passent pas par ici :
 * elles sont dans le DOM ou dans le JSON-LD, sources plus stables. Le pays du
 * vendeur non plus, mais pour une autre raison : il n'est sur aucune fiche —
 * voir `shared/seller.ts`.
 */

/**
 * Les guillemets du flux sont échappés (`\"`), l'échappement étant lui-même
 * facultatif selon la façon dont Next.js sérialise le bloc. `\\?"` accepte les
 * deux formes.
 */
const QUOTE = '\\\\?"';

/**
 * Fenêtre de recherche entre `item_id` et la clé visée. `[^}]` borne à l'objet
 * courant : sans cela, un `favourite_count` situé deux articles plus loin serait
 * rattaché à celui-ci.
 */
const WINDOW = '[^}]{0,300}?';

/**
 * La capture accepte les décimales : `feedback_reputation` vaut 0,8 pour une
 * note de 4 sur 5. Sans la partie fractionnaire, elle serait lue « 0 » — une
 * note nulle, silencieusement fausse. Les clés entières ne changent pas de
 * valeur pour autant.
 */
const patternFor = (itemId: string, key: string): RegExp =>
  new RegExp(
    `${QUOTE}item_id${QUOTE}:\\s*${itemId}\\b${WINDOW}${QUOTE}${key}${QUOTE}:\\s*(\\d+(?:\\.\\d+)?)`
  );

/**
 * Lit plusieurs identifiants en **une seule passe** sur les scripts de la page.
 *
 * Une fiche en porte ~240, dont un de 1 Mo (les traductions, qui mentionnent
 * plusieurs de ces clés sans valeur chiffrée) : balayer une fois par clé coûtait
 * 16 ms à chaque fois. On ne teste donc un motif que sur les scripts qui citent
 * sa clé, et l'on s'arrête dès que tout est trouvé.
 *
 * **Jamais mis en cache**, pour la même raison que le fil d'Ariane : un document
 * `fetch()` et la page courante n'ont pas le même contenu, et une valeur
 * mémorisée finit par être servie au mauvais article.
 *
 * @param itemId article auquel les valeurs doivent se rattacher
 * @param keys clés du flux (`favourite_count`, `brand_id`, `seller_id`…)
 * @returns les clés trouvées, celles qui manquent restant absentes
 */
export function hydrationNumbers(
  doc: Document,
  itemId: string,
  keys: readonly string[]
): Partial<Record<string, number>> {
  const found: Partial<Record<string, number>> = {};
  const remaining = new Set(keys);
  if (!itemId || !remaining.size) return found;

  for (const script of doc.querySelectorAll('script')) {
    const source = script.textContent;
    if (!source || source.indexOf('item_id') === -1) continue;

    for (const key of [...remaining]) {
      if (source.indexOf(key) === -1) continue;

      const match = source.match(patternFor(itemId, key));
      if (!match?.[1]) continue;

      found[key] = Number.parseFloat(match[1]);
      remaining.delete(key);
    }

    if (!remaining.size) break;
  }

  return found;
}

/**
 * Tous les couples `item_id → seller_id` du flux, en **une seule passe**.
 *
 * `hydrationNumbers()` cherche un article précis ; sur une page de catalogue on a
 * la question inverse — quel vendeur pour chacune des 96 cartes ? — et l'appeler
 * 96 fois rebalaierait 96 fois les ~240 scripts de la page. Ici, un seul balayage
 * et une expression régulière globale.
 *
 * **Le résultat peut légitimement être vide** : rien ne garantit que le flux d'une
 * page de catalogue porte les vendeurs, là où celui d'une fiche le fait
 * (`docs/vinted-dom.md`). C'est précisément la question laissée ouverte par
 * `docs/specs/filtrage-bruit.md` §7, et elle se tranche à l'exécution plutôt
 * qu'en pariant : une carte sans vendeur connu n'est simplement pas filtrable par
 * vendeur, et le Diagnostic rapporte le taux de résolution (`vendeursSurCartes`).
 *
 * La borne `[^}]{0,300}` joue le même rôle que dans `patternFor()` : rester dans
 * l'objet courant, pour ne pas rattacher à un article le vendeur du suivant.
 */
export function hydrationSellerMap(doc: Document): Map<string, string> {
  const map = new Map<string, string>();
  const pattern = new RegExp(
    `${QUOTE}item_id${QUOTE}:\\s*(\\d+)${WINDOW}${QUOTE}seller_id${QUOTE}:\\s*(\\d+)`,
    'g'
  );

  for (const script of doc.querySelectorAll('script')) {
    const source = script.textContent;
    if (!source || source.indexOf('seller_id') === -1) continue;

    pattern.lastIndex = 0;
    let match = pattern.exec(source);
    while (match) {
      // Le premier gagne : le flux répète un même article dans plusieurs blocs
      // (`gallery`, `favourite`, `report`), toujours avec le même vendeur.
      if (match[1] && match[2] && !map.has(match[1])) map.set(match[1], match[2]);
      match = pattern.exec(source);
    }
  }

  return map;
}
