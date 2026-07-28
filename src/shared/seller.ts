/**
 * Réputation d'un vendeur : note, nombre d'évaluations, pays.
 *
 * Trois informations, deux pages. La fiche article porte la note et le nombre
 * d'évaluations ; **le pays n'y est nulle part** — ni DOM, ni JSON-LD, ni flux
 * d'hydratation (relevé le 28/07/2026 sur quatre fiches : les seules occurrences
 * de `country_code` dans les 2,3 Mo servis sont des chaînes de traduction). Il
 * n'existe que sur `/member/{id}`, d'où la requête supplémentaire de
 * `completeSellerCountry()`.
 *
 * Ce module ne fait que lire des documents : il ne connaît ni `chrome`, ni le
 * réseau, et se teste donc directement sur les fixtures — comme `photos.ts` et
 * `hydration.ts`. Voir `docs/vinted-dom.md`.
 */
import { codeFromName, normalizeCountry } from './countries.ts';

/** Ce que la cellule vendeur d'une fiche apprend sur sa réputation. */
export type SellerFeedback = {
  /** Note sur 5, une décimale. `null` si elle n'a pas pu être lue. */
  rating: number | null;
  /** Nombre d'évaluations. `0` est une valeur, `null` veut dire « pas lu ». */
  count: number | null;
};

/**
 * Note sur 5 à partir de `feedback_reputation`, que le flux donne entre 0 et 1.
 *
 * Arrondi à la décimale : le flux rend des valeurs comme `0.9400000000000001`,
 * et l'aria-label de Vinted affiche « 4.7 » pour celle-là. Les deux sources
 * doivent produire le même nombre, sans quoi la note changerait selon la voie
 * empruntée.
 */
export function ratingFromReputation(reputation: number | undefined): number | null {
  if (typeof reputation !== 'number' || !Number.isFinite(reputation)) return null;
  if (reputation < 0 || reputation > 1) return null;
  return Math.round(reputation * 50) / 10;
}

/**
 * Note lue dans le libellé d'accessibilité du bloc d'étoiles :
 *   <div role="group" aria-label="Le membre est noté 4.7 sur 5">
 *
 * Repli du flux, et seule ancre du DOM qui ne soit pas une classe : Vinted ne
 * pose aucun `data-testid` sur ce bloc. Le libellé est traduit — le motif ne
 * s'accroche donc qu'au nombre et à son séparateur, pas à la phrase.
 */
export function parseRatingLabel(label: string | null | undefined): number | null {
  const match = /(\d+(?:[.,]\d+)?)\s*(?:sur|\/|out of)\s*5/i.exec(label ?? '');
  if (!match?.[1]) return null;

  const value = Number.parseFloat(match[1].replace(',', '.'));
  return Number.isFinite(value) && value >= 0 && value <= 5 ? value : null;
}

/**
 * Note et nombre d'évaluations dans le DOM de la fiche.
 *
 * Structure de la cellule vendeur, rendue côté serveur :
 *
 *   <a href="/member/237208752">
 *     <span data-testid="profile-username">ramikljk</span>
 *     <div role="group" aria-label="Le membre est noté 4 sur 5">
 *       …cinq étoiles…
 *       <div class="web_ui__Rating__label"><span>4</span></div>
 *     </div>
 *   </a>
 *
 * Le compteur d'évaluations est le **dernier enfant du groupe**, seul à porter
 * un nombre en clair. On l'atteint par sa position plutôt que par sa classe :
 * `web_ui__Rating__label` n'est pas obfusquée aujourd'hui, mais s'y accrocher
 * enfreindrait la règle 4 du projet pour une donnée dont le flux est de toute
 * façon la source principale.
 *
 * @param root cellule du vendeur si on a su l'isoler, le document sinon
 */
export function readSellerFeedback(root: ParentNode): SellerFeedback {
  const group = root.querySelector('[role="group"][aria-label]');
  if (!group) return { rating: null, count: null };

  const rating = parseRatingLabel(group.getAttribute('aria-label'));

  // Un groupe dont le libellé ne parle pas de note n'est pas le bloc d'étoiles :
  // on ne lui prend pas son dernier enfant pour un compteur d'évaluations.
  if (rating === null) return { rating: null, count: null };

  const label = group.lastElementChild?.textContent?.trim() ?? '';
  const count = /^\d+$/.test(label) ? Number.parseInt(label, 10) : null;

  return { rating, count };
}

/**
 * Cellule du vendeur sur une fiche, à laquelle borner la lecture de la note.
 *
 * Sans cette borne, le premier `[role="group"]` venu ferait l'affaire — et les
 * blocs « Dressing du membre » et « Articles similaires », qui arrivent plus
 * tard dans la page, en portent aussi. Même précaution que pour les photos et
 * le compteur de favoris.
 */
export function sellerCell(doc: Document): ParentNode {
  return (
    doc.querySelector('[data-testid="profile-username"]')?.closest('a[href*="/member/"]') ?? doc
  );
}

/**
 * Pays du vendeur sur sa page profil, en code ISO alpha-2.
 *
 * Deux sources, dans cet ordre :
 *
 *  1. le flux, qui donne le code tel quel :
 *     `"expose_location":true,"city":"Bad Soden am Taunus","city_id":812,"country_code":"DE"` ;
 *  2. le DOM en repli, qui l'affiche traduit :
 *     `<div data-testid="profile-location-info--content">Cenon, France</div>`.
 *
 * Le flux passe devant alors que la convention du projet privilégie le DOM : ici
 * le DOM ne porte que le **nom** du pays, dans la langue de la page, qu'il faut
 * reconvertir en code — une étape de plus, et une reconnaissance qui peut
 * échouer. Le flux, lui, porte la forme que le storage retient.
 *
 * Le pays n'est retenu que si le profil n'en désigne **qu'un** : la page ne
 * décrit qu'un membre aujourd'hui, mais l'ambiguïté d'un jour ne doit pas se
 * transformer en pays faux affiché avec aplomb.
 *
 * @returns le code, ou `null` si le profil n'expose pas sa localisation
 */
export function sellerCountryFrom(doc: Document): string | null {
  const codes = new Set<string>();
  const pattern = /\\?"country_code\\?":\s*\\?"([A-Za-z]{2})\\?"/g;

  for (const script of doc.querySelectorAll('script')) {
    const source = script.textContent;
    if (!source || source.indexOf('country_code') === -1) continue;

    for (const match of source.matchAll(pattern)) {
      const code = normalizeCountry(match[1]);
      if (code) codes.add(code);
    }
  }

  if (codes.size === 1) return [...codes][0] ?? null;

  // Repli DOM : « Bad Soden am Taunus, Allemagne » — le pays est le dernier
  // segment. Une localisation réduite au seul pays passe par le même chemin.
  const shown = doc
    .querySelector('[data-testid="profile-location-info--content"]')
    ?.textContent?.trim();
  if (!shown) return null;

  const parts = shown.split(',');
  return codeFromName(parts[parts.length - 1]);
}
