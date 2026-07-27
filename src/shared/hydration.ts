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
 *
 * Ce module n'en extrait que des **nombres**, et toujours rattachés à un
 * `item_id` : une fiche affiche aussi le dressing du membre et les articles
 * similaires, et un compteur pris au voisin serait faux sans que rien ne le
 * signale. Même précaution que dans `photos.ts`.
 *
 * Les valeurs textuelles (pseudo du vendeur, description) ne passent pas par ici :
 * elles sont dans le DOM ou dans le JSON-LD, sources plus stables.
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

const patternFor = (itemId: string, key: string): RegExp =>
  new RegExp(`${QUOTE}item_id${QUOTE}:\\s*${itemId}\\b${WINDOW}${QUOTE}${key}${QUOTE}:\\s*(\\d+)`);

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

      found[key] = Number.parseInt(match[1], 10);
      remaining.delete(key);
    }

    if (!remaining.size) break;
  }

  return found;
}
