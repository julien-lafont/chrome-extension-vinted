/**
 * Identifiant Vinted d'une taille, résolu depuis son libellé.
 *
 * Le catalogue ne filtre que par identifiant (`size_ids[]`), et **aucune page ne
 * porte celui de l'article** : le HTML servi d'une fiche n'expose que le libellé
 * (`itemprop="size"` → « M », « S / 36 / 8 »), et le flux d'hydratation ne
 * mentionne jamais de `size_id`. La marque, elle, est dans le fil d'Ariane ; la
 * taille n'a pas d'équivalent.
 *
 * Elle se résout en revanche par l'API du site, qui donne la table des tailles
 * d'une catégorie :
 *
 *     GET /api/v2/size_groups?catalog_ids=584
 *     { "size_groups": [ { "description": "Tailles hommes",
 *                          "sizes": [ { "id": 208, "title": "M" }, … ] } ] }
 *
 * Trois relevés qui justifient ce module (27/07/2026, sur vinted.fr) :
 *
 *  1. **`catalog_ids` au pluriel** filtre la réponse sur la catégorie et ne rend
 *     que ses groupes. Au singulier — `catalog_id` — le paramètre est ignoré et
 *     l'API rend les 51 groupes du site, où « M » vaut aussi bien 208
 *     (vêtements homme) que 1390 (chapeaux) ou 1426 (gants) ;
 *  2. le libellé de la fiche correspond **au caractère près** au `title` de
 *     l'API, titres composés compris (« S / 36 / 8 ») : aucune normalisation
 *     n'est nécessaire, et aucune ne doit être ajoutée sans la revérifier ;
 *  3. sur une catégorie **feuille** — la seule que l'extension enregistre, voir
 *     `category.exact` — la table n'a aucune collision. Les catégories larges
 *     (« Vêtements hommes ») en ont, d'où le renoncement explicite ci-dessous.
 *
 * L'appel n'a lieu que depuis le content script : il est alors same-origin, avec
 * la session de l'utilisateur. Sans cookies, l'API répond 403.
 */

/** Réponse de l'API, réduite à ce qu'on en lit. Tout est optionnel : contenu tiers. */
type SizeGroupsResponse = {
  size_groups?: { sizes?: { id?: number; title?: string }[] }[];
};

/**
 * Libellé → identifiant. `null` marque un libellé **ambigu** : deux groupes de
 * la même catégorie lui donnent des identifiants différents. On préfère alors ne
 * pas filtrer plutôt que filtrer sur la mauvaise échelle — une recherche « M »
 * qui renverrait des chapeaux serait pire que la recherche textuelle qu'elle
 * remplace.
 */
type SizeTable = Map<string, string | null>;

const ENDPOINT = 'https://www.vinted.fr/api/v2/size_groups?catalog_ids=';

/** L'API est petite mais reste une requête : au-delà, l'article s'en passe. */
const TIMEOUT_MS = 5000;

/**
 * Tables déjà demandées, **par catégorie**. On mémorise la promesse et non son
 * résultat : enregistrer cinq articles du même rayon d'affilée ne doit lancer
 * qu'une requête, y compris pendant qu'elle est en vol.
 *
 * Cache mémoire seulement, donc vidé à chaque chargement de page. Le persister
 * dans le storage économiserait une requête par catégorie et par page — pour le
 * risque qu'une table périmée y reste indéfiniment, sans que rien ne le signale.
 * Le mauvais côté du compromis pour quelques kilo-octets.
 */
const tables = new Map<string, Promise<SizeTable | null>>();

/** Vide le cache. Réservé aux tests : une page réelle n'en a jamais besoin. */
export function resetSizeTables(): void {
  tables.clear();
}

/**
 * Construit la table d'une catégorie, en marquant les libellés ambigus.
 *
 * Un même `title` peut apparaître dans plusieurs groupes d'une catégorie large
 * (« XS » vaut 206 en vêtements, 1388 en chapeaux, 1424 en gants). Le premier vu
 * ne vaut pas mieux que les autres : on note l'ambiguïté et on n'en tire rien.
 */
function buildTable(data: SizeGroupsResponse): SizeTable {
  const table: SizeTable = new Map();

  for (const group of data.size_groups ?? []) {
    for (const size of group.sizes ?? []) {
      const title = (size.title ?? '').trim();
      if (!title || typeof size.id !== 'number') continue;

      const id = String(size.id);
      const known = table.get(title);

      if (known === undefined) table.set(title, id);
      else if (known !== id) table.set(title, null);
    }
  }

  return table;
}

async function fetchTable(catalogId: string, fetchImpl: typeof fetch): Promise<SizeTable | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetchImpl(`${ENDPOINT}${encodeURIComponent(catalogId)}`, {
      credentials: 'include',
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) return null;

    return buildTable((await response.json()) as SizeGroupsResponse);
  } catch {
    // Requête refusée, coupée, ou réponse illisible : l'article gardera son
    // libellé et la recherche retombera sur le texte. Jamais bloquant.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Identifiant de la taille d'un article, ou `null` s'il n'est pas résolvable.
 *
 * @param catalogId catégorie **exacte** de l'article (`category.id`). Une
 *   catégorie héritée de la page de navigation donnerait la table d'un rayon
 *   plus large, donc des ambiguïtés — l'appelant doit vérifier `category.exact`.
 * @param label libellé tel que la fiche l'affiche, sans retouche
 * @param fetchImpl injecté par les tests ; `fetch` de la page sinon
 */
export async function sizeIdFor(
  catalogId: string | null | undefined,
  label: string | null | undefined,
  fetchImpl: typeof fetch = fetch
): Promise<string | null> {
  const title = (label ?? '').trim();
  if (!catalogId || !title) return null;

  let pending = tables.get(catalogId);
  if (!pending) {
    pending = fetchTable(catalogId, fetchImpl);
    tables.set(catalogId, pending);
  }

  const table = await pending;
  return table?.get(title) ?? null;
}
