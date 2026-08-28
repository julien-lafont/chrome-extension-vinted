/**
 * Le transport de l'API des favoris : jeton, en-têtes, requêtes, pagination.
 *
 * Extrait de `fav-drain.ts` quand les rattrapages explicites
 * (`fav-catchup.ts`) ont eu besoin des mêmes trois choses. Rien ici ne décide :
 * ce module va chercher, et rend soit une réponse, soit un échec **qualifié** —
 * la distinction entre « freiné », « réseau » et « compte inconnu » n'est pas
 * cosmétique, c'est elle qui dit s'il faut poser un silence, réessayer plus
 * tard, ou renoncer.
 *
 * Deux choses n'existent que dans une page Vinted, et c'est pour elles que tout
 * ceci vit dans un content script : les cookies de session, et le jeton
 * anti-CSRF sans lequel l'API répond 403.
 */
import { parseFavouritesPage, readCsrfToken } from '../shared/fav-sync.ts';
import { parseCurrentUserId } from '../shared/offers.ts';
import { OFFERS_KEY, read } from '../shared/storage.ts';

/** Pages de favoris lues au plus. Un compte à 2 000 favoris n'est pas notre cas. */
const MAX_PAGES = 25;

/** Demandé à l'API ; c'est `pagination.total_pages` qui fait foi ensuite. */
const PER_PAGE = 100;

/** Au-delà, la requête est abandonnée : rien n'est urgent ici. */
const TIMEOUT_MS = 8000;

/** Réponse JSON, ou l'échec qualifié : `blocked` doit poser un silence. */
export type Fetched = { data?: unknown; blocked?: boolean; failed?: boolean };

/** Pourquoi la liste des favoris n'a pas pu être lue. */
export type FavFailure = 'freiné' | 'réseau' | 'compte inconnu' | 'jeton absent';

export type FavListResult =
  { ok: true; entries: unknown[] } | { ok: false; reason: Exclude<FavFailure, 'jeton absent'> };

export type FavApiDeps = {
  fetchImpl?: typeof fetch;
  doc?: Document;
  /** Le cookie `anon_id`, que l'API réclame en en-tête. */
  cookie?: () => string;
};

export type FavApi = {
  /** En-têtes communs : jeton anti-CSRF et identifiant anonyme. */
  headers: Record<string, string>;
  request: (url: string, init?: RequestInit) => Promise<Fetched>;
  /**
   * Toutes les entrées de la liste des favoris, brutes.
   *
   * **Un échec n'est jamais une liste vide.** Le confondre ferait conclure que
   * rien n'est en favori, ce qui inverse toutes les décisions qui en dépendent.
   */
  favourites: () => Promise<FavListResult>;
};

/**
 * Le cookie `anon_id`, tel quel. C'est la valeur de l'en-tête `x-anon-id`, et
 * elle n'a pas d'autre source : le content script partage le `document.cookie`
 * de la page, ce qui suffit — le cookie n'est pas `HttpOnly`.
 */
function anonId(cookie: string): string | null {
  return /(?:^|;\s*)anon_id=([^;]+)/.exec(cookie)?.[1] ?? null;
}

/**
 * Ouvre l'accès à l'API, ou renonce faute de jeton.
 *
 * @returns `null` quand la page ne porte pas de `CSRF_TOKEN` — session expirée,
 *   ou clé renommée par Vinted. L'appelant doit alors **ne rien faire** : mieux
 *   vaut un geste en retard qu'un geste inversé.
 */
export function openFavApi(deps: FavApiDeps = {}): FavApi | null {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const doc = deps.doc ?? document;
  const cookie = deps.cookie ?? ((): string => doc.cookie);

  const token = readCsrfToken(doc);
  if (!token) return null;

  const anon = anonId(cookie());
  const headers: Record<string, string> = {
    'x-csrf-token': token,
    ...(anon ? { 'x-anon-id': anon } : {}),
  };

  const request = async (url: string, init: RequestInit = {}): Promise<Fetched> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const response = await fetchImpl(url, {
        method: 'GET',
        ...init,
        credentials: 'include',
        headers: { accept: 'application/json', ...headers, ...(init.headers ?? {}) },
        signal: controller.signal,
      });

      // Signal de freinage. Jamais interprété comme une réponse : le prendre
      // pour tel ferait basculer des favoris à l'envers.
      if (response.status === 429 || response.status === 403) return { blocked: true };
      if (!response.ok) return { failed: true };

      return { data: await response.json() };
    } catch {
      return { failed: true };
    } finally {
      clearTimeout(timer);
    }
  };

  const favourites = async (): Promise<FavListResult> => {
    const stored = await read(OFFERS_KEY);
    let userId = stored[OFFERS_KEY]?.userId;

    // Le compte est déjà connu quand le balayage des offres est passé : c'est la
    // même donnée, et elle ne change pas.
    if (!userId) {
      const me = await request('/api/v2/users/current');
      if (me.blocked) return { ok: false, reason: 'freiné' };
      userId = parseCurrentUserId(me.data) ?? undefined;
    }
    if (!userId) return { ok: false, reason: 'compte inconnu' };

    const entries: unknown[] = [];
    let totalPages = 1;

    for (let page = 1; page <= Math.min(totalPages, MAX_PAGES); page += 1) {
      const url = `/api/v2/users/${userId}/items/favourites?page=${page}&per_page=${PER_PAGE}`;
      const response = await request(url);

      if (response.blocked) return { ok: false, reason: 'freiné' };
      if (response.failed) return { ok: false, reason: 'réseau' };

      const parsed = parseFavouritesPage(response.data);
      // Forme inattendue : Vinted a changé son API. Même verdict qu'un échec
      // réseau — surtout pas « rien n'est en favori ».
      if (!parsed) return { ok: false, reason: 'réseau' };

      entries.push(...parsed.entries);
      totalPages = parsed.totalPages;
    }

    return { ok: true, entries };
  };

  return { headers, request, favourites };
}

/** La bascule elle-même. Voir `docs/vinted-dom.md` : ajout et retrait sont la même requête. */
export function toggleFavourite(api: FavApi, id: string): Promise<Fetched> {
  return api.request('/api/v2/user_favourites/toggle', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'item', user_favourites: [Number(id)] }),
  });
}
