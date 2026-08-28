/**
 * Vinted Smart Bookmarks — lecture du DOM de Vinted.
 *
 * Tout ce qui transforme une page Vinted en `SavedItem` vit ici, et rien
 * d'autre : ces fonctions n'écrivent nulle part, ne touchent ni au storage ni
 * aux boutons injectés, et prennent le `Document` en paramètre. Elles valent
 * donc aussi bien pour la page ouverte que pour une fiche récupérée par
 * `fetch()` — c'est ce qui permet à l'enrichissement et au suivi de prix de
 * relire une fiche avec exactement les ancres de la page ouverte.
 *
 * Extrait de `content.ts`, qui portait les deux moitiés — l'extraction et
 * l'injection — dans une seule fermeture de 2 700 lignes où rien n'était
 * atteignable autrement qu'en montant un DOM complet. Ici les ancres Vinted,
 * c'est-à-dire la partie qui casse quand Vinted déploie, se lisent et se testent
 * seules (`tests/extraction.test.ts`).
 *
 * Ancres relevées sur vinted.fr :
 *   Catalogue — [data-testid="product-item-id-{ID}"] porte l'ID de l'article,
 *   ses enfants suffixés `--overlay-link`, `--image--img`, `--description-title`,
 *   `--description-subtitle`, `--price-text` portent les métadonnées.
 *   Blocs de la fiche — mêmes cartes, préfixe différent : voir `blockCards()`
 *   dans `content.ts`.
 *   Détail — un <script type="application/ld+json"> schema.org expose tout ;
 *   les data-testid `item-*` servent de repli.
 *
 * Quand une de ces ancres casse : `docs/vinted-dom.md`.
 */
import { hydrationNumbers } from '../shared/hydration.ts';
import { extractPhotos } from '../shared/photos.ts';
import { formatPrice, parsePriceString } from '../shared/price.ts';
import { ratingFromReputation, readSellerFeedback, sellerCell } from '../shared/seller.ts';
import type { SellerFeedback } from '../shared/seller.ts';
import { DESCRIPTION_MAX } from '../shared/types.ts';
import type { ItemCategory, SavedItem } from '../shared/types.ts';

// ---------------------------------------------------------------------------
// Extraction — champs communs
// ---------------------------------------------------------------------------

export const text = (el: Element | null): string => el?.textContent?.trim() ?? '';

/**
 * Identifiant Vinted ramené à la chaîne du modèle. Le flux d'hydratation les
 * donne en nombres, le DOM en chaînes : le storage n'en garde qu'une forme,
 * celle de `category.id`.
 */
const idOf = (value: number | undefined): string | null =>
  typeof value === 'number' ? String(value) : null;

/**
 * Description ramenée à la longueur que le storage accepte de porter pour des
 * milliers d'articles. Une valeur vide devient `null` : `mergeDetail()` ignore
 * les deux, mais `null` dit « lu, rien trouvé » là où `''` se confondrait avec
 * une description réellement vide.
 */
const truncate = (value: string | undefined): string | null => {
  const raw = (value ?? '').trim();
  if (!raw) return null;
  return raw.length <= DESCRIPTION_MAX ? raw : `${raw.slice(0, DESCRIPTION_MAX).trimEnd()}…`;
};

/**
 * Vocabulaire des états Vinted. Sert à reconnaître un état quand rien ne dit
 * si une valeur isolée est une taille ou un état — voir parseSubtitle().
 */
const CONDITION_WORDS = /neuf\s+(avec|sans)|(tr[eè]s\s+)?bon\s+[ée]tat|satisfaisant/i;

/** Voir `shared/price.ts` — le parseur est commun au panneau et à l'extraction. */
export const parsePriceValue = parsePriceString;

/** Réexporté : plusieurs appelants historiques le prennent ici. */
export { formatPrice };

/**
 * Nombre de favoris affiché sur un bouton « cœur » Vinted, carte ou fiche.
 *
 * Deux sources dans le même bouton : le compteur visible
 * (`favourite-count-text`) et le libellé d'accessibilité
 * ("Ajouter aux favoris, ajouté aux favoris par 9 utilisateurs").
 *
 * Le sélecteur est passé par l'appelant : la fiche affiche aussi les cartes des
 * articles similaires, dont les boutons `--favourite` ne concernent pas
 * l'article courant.
 *
 * @returns null si le bouton est absent ou pas encore hydraté —
 *   surtout pas 0, qui trierait l'article comme réellement sans favori.
 */
export function readFavouriteButton(scope: ParentNode, selector: string): number | null {
  const btn = scope.querySelector(selector);
  if (!btn) return null;

  const counter = btn.querySelector('[data-testid="favourite-count-text"]');
  if (counter) {
    const digits = (counter.textContent ?? '').replace(/[^\d]/g, '');
    if (digits) return Number.parseInt(digits, 10);
  }

  const label = btn.getAttribute('aria-label') || '';
  const fromLabel = label.match(/(\d+)/);
  if (fromLabel?.[1]) return Number.parseInt(fromLabel[1], 10);

  // Libellé présent mais sans nombre ("Ajouter aux favoris" tout court) :
  // le bouton est rendu, personne n'a mis l'article en favori.
  return label ? 0 : null;
}

/**
 * Le cœur natif de Vinted, partout où il existe.
 *
 * Un seul sélecteur pour quatre contextes, parce que Vinted y met le même
 * composant : les cartes du catalogue et des blocs d'une fiche le nomment
 * `{carte}--favourite`, le fil de la page d'accueil `feed-item--favourite`, et
 * la fiche article `favourite-button`.
 *
 * Il ne sert pas qu'au compteur : c'est aussi le seul témoin de l'état du favori
 * chez Vinted — voir `readFavouriteState()` et `docs/specs/favoris-sync.md`.
 */
export const FAVOURITE_SELECTOR = '[data-testid$="--favourite"], [data-testid="favourite-button"]';

/** Ancre du cœur de la fiche article, qui ne suit pas la convention des cartes. */
const DETAIL_FAVOURITE_TESTID = 'favourite-button';

const FAVOURITE_SUFFIX = '--favourite';

/**
 * L'état du favori porté par un cœur Vinted.
 *
 * `aria-pressed` est la seule source qui ne dépende ni de la langue ni d'une
 * classe obfusquée — le libellé dit « Ajouter aux favoris » / « Retirer des
 * favoris », et l'icône ne se distingue que par sa classe de couleur, ce que la
 * règle 4 interdit.
 *
 * @returns `null` quand l'attribut est absent, c'est-à-dire quand le bouton
 *   n'est **pas encore hydraté** — sur une fiche, il arrive `disabled` et nu.
 *   Surtout pas `false`, qui se lirait comme « pas en favori » et ferait
 *   constater un retrait à chaque chargement de page.
 */
export function readFavouriteState(btn: Element): boolean | null {
  const pressed = btn.getAttribute('aria-pressed');
  if (pressed === 'true') return true;
  if (pressed === 'false') return false;
  return null;
}

/**
 * L'article que désigne un cœur Vinted.
 *
 * Le testid du bouton ne suffit pas : sur le fil de la page d'accueil il vaut
 * `feed-item--favourite`, sans identifiant nulle part — même exception que pour
 * la carte elle-même. On remonte donc à la carte, dont le testid est celui du
 * bouton privé de son suffixe, et on laisse `cardId()` trancher. Cela a un
 * second effet, celui qui compte vraiment : `cardId()` relit l'identifiant **à
 * l'instant du geste**, si bien qu'une carte recyclée par Vinted pour un autre
 * article ne fait pas attribuer le cœur à l'ancien.
 *
 * @param url l'URL courante, seule source pour la fiche article
 */
export function favouriteTargetId(btn: Element, url: string): string | null {
  // `getAttribute` plutôt que `dataset` : la signature accepte un `Element`, et
  // un `instanceof HTMLElement` lierait la lecture au contexte global d'une
  // fenêtre — ce que ce module s'interdit, puisqu'il lit aussi des documents
  // récupérés par `fetch()`.
  const testid = btn.getAttribute('data-testid') || '';

  if (testid === DETAIL_FAVOURITE_TESTID) return extractIdFromUrl(url);
  if (!testid.endsWith(FAVOURITE_SUFFIX)) return null;

  const cardTestid = testid.slice(0, -FAVOURITE_SUFFIX.length);
  const box = btn.closest<HTMLElement>(`[data-testid="${cardTestid}"]`);
  return box ? cardId(box) : null;
}

/**
 * Catégorie Vinted, lue dans le fil d'Ariane de la page.
 *
 *   <ul class="breadcrumbs">
 *     <li><a href="/catalog/5-hommes" itemprop="url"><span itemprop="title">Hommes</span></a>
 *     … <a href="/catalog/584-hauts-et-t-shirts">Hauts et t-shirts</a>
 *
 * Le même fil existe sur la fiche article et sur les pages catégorie du
 * catalogue, ce qui donne les deux niveaux de fiabilité de `exact` — voir
 * `categoryOf()`. On s'ancre sur les `itemprop` schema.org plutôt que sur la
 * classe `breadcrumbs`, et l'on garde `.breadcrumbs` en repli.
 *
 * Le dernier maillon d'une fiche croise la marque
 * (« Nike Hauts et t-shirts » → `/catalog/584-…/brand/53-nike`) : on l'écarte,
 * une recherche relancée depuis là serait restreinte à la marque.
 *
 * **Relu à chaque appel, jamais mis en cache.** Une navigation SPA change
 * `location.href` avant que Vinted ait re-rendu le fil : une valeur mémorisée
 * par URL figerait la catégorie de l'article précédent sur le suivant, et
 * l'enregistrement serait faux sans que rien ne le signale. Le gain mesuré
 * (18 ms pour 96 cartes, sous jsdom donc majoré) ne vaut pas ce risque.
 *
 * @param doc page courante, ou fiche récupérée par fetch
 */
function breadcrumbLinks(doc: Document): Element[] {
  const list =
    doc.querySelector('ul.breadcrumbs') ??
    doc.querySelector('a[itemprop="url"][href*="/catalog/"]')?.parentElement;

  return list ? [...list.querySelectorAll('a[href*="/catalog/"]')] : [];
}

export function readBreadcrumbCategory(doc: Document): Omit<ItemCategory, 'exact'> | null {
  const links = breadcrumbLinks(doc).filter(
    (a) => !(a.getAttribute('href') ?? '').includes('/brand/')
  );

  const leaf = links.at(-1);
  if (!leaf) return null;

  const href = (leaf.getAttribute('href') ?? '').split('?')[0] ?? '';

  return {
    id: href.match(/\/catalog\/(\d+)/)?.[1] ?? null,
    name: text(leaf),
    path: links.map((link) => text(link)).filter(Boolean),
    url: `https://www.vinted.fr${href}`,
  };
}

/**
 * Catégorie à enregistrer avec un article.
 *
 * `exact` distingue deux situations que l'affichage confondrait :
 *  - sur une fiche article, le fil décrit **l'article** — catégorie exacte ;
 *  - sur une page catégorie du catalogue, il décrit **la page**. Tous les
 *    articles listés y appartiennent, mais souvent à une sous-catégorie plus
 *    fine ; la valeur reste bonne pour relancer une recherche, elle est juste
 *    plus large. Une recherche par mots-clés n'a pas de fil du tout : `null`.
 *
 * La catégorie n'existe nulle part sur une carte du catalogue — ni dans le DOM,
 * ni dans le flux d'hydratation, dont l'objet article ne porte pas de
 * `catalog_id`. Le contexte de navigation est donc la seule source disponible
 * sans requête supplémentaire. Voir docs/limitations.md.
 */
export function categoryOf(doc: Document, exact: boolean): ItemCategory | null {
  const category = readBreadcrumbCategory(doc);
  return category ? { ...category, exact } : null;
}

/**
 * Identifiant de marque, lu dans le maillon que la catégorie écarte.
 *
 * Le dernier maillon d'une fiche croise catégorie et marque
 * (« Nike Hauts et t-shirts » → `/catalog/584-tops-and-t-shirts/brand/53-nike`)
 * : inutilisable comme catégorie, mais c'est **la seule occurrence en clair de
 * l'identifiant de marque dans le DOM servi**. Le fil est rendu côté serveur et
 * Vinted a un intérêt SEO à le garder — on le préfère donc au flux
 * d'hydratation, qui reste en repli dans `extractFromDetail()`.
 *
 * Sans cet identifiant, le catalogue ne sait pas filtrer par marque :
 * `brand_ids[]` n'accepte pas de nom, et la recherche retombait sur du texte
 * libre. Voir `docs/vinted-dom.md`.
 *
 * @returns l'identifiant, ou null si l'article n'a pas de marque référencée
 */
export function brandIdFromBreadcrumb(doc: Document): string | null {
  for (const link of breadcrumbLinks(doc)) {
    const id = (link.getAttribute('href') ?? '').match(/\/brand\/(\d+)/)?.[1];
    if (id) return id;
  }
  return null;
}

/**
 * Vendeur de l'article : identifiant, pseudo, et sa réputation telle que le
 * DOM la porte.
 *
 * Trois ancres complémentaires, toutes rendues côté serveur :
 *   <a href="/member/3165663897">
 *     <span data-testid="profile-username">emma07297</span>
 *     <div role="group" aria-label="Le membre est noté 4.7 sur 5">…</div>
 *
 * L'identifiant vient du lien plutôt que du `data-testid`, parce que c'est lui
 * qui porte le nombre ; le pseudo vient du `data-testid`, seul endroit où il
 * est isolé du reste de la cellule (avatar, note, nombre d'évaluations).
 *
 * `/member/signup/...` traîne aussi dans la page (liens d'inscription) : le
 * motif exige des chiffres, ce qui les écarte sans avoir à les énumérer.
 *
 * La note et le compteur d'évaluations ne sont ici qu'un **repli** du flux
 * d'hydratation — contrairement au reste de l'extraction. Voir
 * `shared/seller.ts` : le DOM ne leur donne aucun `data-testid`, et son
 * libellé dépend de la langue de la page.
 */
export function readSeller(doc: Document): {
  id: string | null;
  name: string;
  feedback: SellerFeedback;
} {
  let id: string | null = null;

  for (const link of doc.querySelectorAll('a[href*="/member/"]')) {
    const found = (link.getAttribute('href') ?? '').match(/\/member\/(\d+)/)?.[1];
    if (found) {
      id = found;
      break;
    }
  }

  return {
    id,
    name: text(doc.querySelector('[data-testid="profile-username"]')),
    feedback: readSellerFeedback(sellerCell(doc)),
  };
}

/**
 * Un article vendu ne doit pas pouvoir être ajouté aux favoris.
 *
 * Vinted affiche alors une cellule dédiée en tête de la sidebar :
 *   <div data-testid="item-status"><div data-testid="item-status--content">Vendu</div></div>
 * Absente sur un article encore en vente. Elle existe aussi pour "Réservé" —
 * un état qui reste normalement enregistrable, d'où le texte exact plutôt que
 * la seule présence de la cellule.
 */
export function isSoldDetail(doc: Document): boolean {
  return /^vendu$/i.test(text(doc.querySelector('[data-testid="item-status--content"]')));
}

// ---------------------------------------------------------------------------
// Extraction — cartes (catalogue, et blocs d'articles d'une fiche)
// ---------------------------------------------------------------------------

export const isDetailPage = () => /^\/items\/\d+/.test(location.pathname);

/**
 * Séparateurs du libellé d'accessibilité d'une carte, au format
 *   "{titre}, marque: X, état: Y, taille: Z, {prix}, {protection acheteurs}"
 * La marque manque sur certaines cartes : couper au seul ", marque:" laissait
 * alors tout le libellé en guise de titre.
 */
const LABEL_FIELDS = /,\s*(marque|brand|[ée]tat|condition|taille|size)\s*:/i;

/**
 * Vinted ne rend le titre de l'article nulle part en clair sur une carte :
 * il n'existe que dans le libellé d'accessibilité. On coupe au premier
 * séparateur connu — le titre lui-même peut contenir des virgules, d'où la
 * coupe sur ", marque:" et non sur ",".
 */
export function parseTitleFromLabel(label: string): string {
  if (!label) return '';
  const cut = label.search(LABEL_FIELDS);
  return (cut === -1 ? label : label.slice(0, cut)).trim();
}

/**
 * Lit un attribut nommé du libellé d'accessibilité ("état: Très bon état").
 * Aucune des valeurs concernées ne contient de virgule.
 */
function parseLabelField(label: string, names: string): string {
  const match = String(label || '').match(new RegExp(`,\\s*(?:${names})\\s*:\\s*([^,]+)`, 'i'));
  return match?.[1]?.trim() ?? '';
}

/**
 * Sous-titre d'une carte : "42 · Neuf avec étiquette".
 *
 * La taille est omise sur les articles qui n'en ont pas (sacs, accessoires) et
 * le sous-titre se réduit alors à l'état, sans rien pour le signaler : prendre
 * la première partie pour la taille y enregistrait "Très bon état" comme
 * taille, et laissait l'état vide — deux tris faussés d'un coup.
 */
function parseSubtitle(subtitle: string): { size: string; condition: string } {
  const parts = String(subtitle || '')
    .split('·')
    .map((s) => s.trim())
    .filter(Boolean);

  if (parts.length >= 2) return { size: parts[0]!, condition: parts[1]! };

  const only = parts[0];
  if (!only) return { size: '', condition: '' };

  return CONDITION_WORDS.test(only) ? { size: '', condition: only } : { size: only, condition: '' };
}

/** Repli ultime : reconstruit un titre lisible depuis le slug de l'URL. */
export function titleFromUrl(url: string): string {
  const m = url ? url.match(/\/items\/\d+-([^?#/]+)/) : null;
  if (!m?.[1]) return '';
  const words = m[1].replace(/-/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function extractIdFromUrl(url: string): string | null {
  const m = url ? url.match(/\/items\/(\d+)/) : null;
  return m?.[1] ?? null;
}

/**
 * ID d'article porté par le `data-testid` d'une carte.
 *
 * `product-item-id-{ID}` n'est que le nom **par défaut** de la carte Vinted :
 * les blocs d'articles d'une fiche lui imposent leur propre préfixe
 * (`other_user_items-{ID}`, `similar_items-{ID}` — voir blockCards()). Seul le
 * suffixe numérique est commun aux deux, et le préfixe ne nous apprend rien :
 * on ne lit donc que le nombre final.
 *
 * Il fait aussi office de garde-fou — un testid voisin sans identifiant
 * (`{plugin}-plugin-empty-state`, `{plugin}-items`) ne matche pas, et la carte
 * est ignorée plutôt qu'extraite à vide.
 */
/** Testids de carte qui ne portent pas d'identifiant — voir le repli ci-dessous. */
const IDLESS_CARDS = new Set(['feed-item']);

export function cardId(box: HTMLElement): string | null {
  const testid = box.dataset.testid || '';

  const match = testid.match(/-(\d+)$/);
  if (match?.[1]) return match[1];

  // Le fil de la page d'accueil fait exception : ses cartes s'appellent
  // **toutes** `feed-item`, sans identifiant nulle part dans le testid. Seule
  // l'URL du lien overlay le porte.
  //
  // Ce repli est réservé aux testids connus pour ne pas porter d'identifiant,
  // et n'est surtout pas généralisé : `querySelector` descend dans tout le
  // sous-arbre, si bien qu'un conteneur qui *contient* des cartes — le voisin
  // `{plugin}-items` des blocs d'une fiche — passerait pour une carte et
  // recevrait un bouton en double, sur l'article de sa première carte.
  if (!IDLESS_CARDS.has(testid)) return null;

  const href = box
    .querySelector<HTMLAnchorElement>('[data-testid$="--overlay-link"]')
    ?.getAttribute('href');
  return href?.match(/\/items\/(\d+)/)?.[1] ?? null;
}

/** @param box conteneur de carte, ex. [data-testid="product-item-id-{ID}"] */
export function extractFromCard(box: HTMLElement): SavedItem | null {
  const id = cardId(box);
  if (!id) return null;

  const link =
    box.querySelector<HTMLAnchorElement>('[data-testid$="--overlay-link"]') ||
    box.querySelector<HTMLAnchorElement>('a[href*="/items/"]');
  const img =
    box.querySelector<HTMLImageElement>('[data-testid$="--image--img"]') ||
    box.querySelector('img');

  // L'URL du catalogue traîne un ?referrer= dont on n'a pas besoin.
  const rawUrl = link ? link.href : '';
  const url = rawUrl ? (rawUrl.split('?')[0] ?? rawUrl) : `https://www.vinted.fr/items/${id}`;

  const label = link?.title || img?.alt || '';
  const title = parseTitleFromLabel(label) || titleFromUrl(url) || `Article ${id}`;

  // Le libellé d'accessibilité nomme ses attributs ("état: X, taille: Y") là où
  // le sous-titre les juxtapose ; il est donc lu en premier, le sous-titre ne
  // servant que de repli si Vinted change le format du libellé.
  const fromSubtitle = parseSubtitle(
    text(box.querySelector('[data-testid$="--description-subtitle"]'))
  );
  const price = text(box.querySelector('[data-testid$="--price-text"]'));

  return {
    id,
    url,
    title,
    brand: text(box.querySelector('[data-testid$="--description-title"]')),
    size: parseLabelField(label, 'taille|size') || fromSubtitle.size,
    condition: parseLabelField(label, '[ée]tat|condition') || fromSubtitle.condition,
    price,
    priceValue: parsePriceValue(price),
    favouriteCount: readFavouriteButton(box, '[data-testid$="--favourite"]'),
    // Le fil d'Ariane décrit la page, pas la carte : catégorie approchée.
    // Elle sera remplacée par celle de la fiche dès l'enrichissement.
    //
    // Sur une fiche article, il ne décrit même plus la page mais l'article
    // affiché : les cartes du dressing du membre relèvent d'un tout autre
    // rayon (« Sacs à dos » sous une fiche de chaussures). Aucune catégorie
    // vaut mieux qu'une catégorie fausse, que rien ne signalerait si
    // l'enrichissement échouait.
    category: isDetailPage() ? null : categoryOf(document, false),
    imageUrl: img ? img.src : '',
    source: 'catalog',
  };
}

// ---------------------------------------------------------------------------
// Extraction — page détail
// ---------------------------------------------------------------------------

/**
 * Forme du JSON-LD de Vinted, réduite à ce qu'on en lit. Tous les champs sont
 * optionnels : c'est du contenu tiers, rien ne garantit sa structure.
 */
type ProductJsonLd = {
  '@type'?: string;
  name?: string;
  description?: string;
  brand?: { name?: string };
  category?: string;
  image?: string;
  offers?: { price?: number | string; priceCurrency?: string; url?: string };
};

/** Lit le JSON-LD schema.org de la page détail. Source la plus stable. */
export function readJsonLd(doc: Document): ProductJsonLd | null {
  const scripts = doc.querySelectorAll('script[type="application/ld+json"]');
  for (const script of scripts) {
    try {
      const data = JSON.parse(script.textContent ?? '') as ProductJsonLd | null;
      if (data && data['@type'] === 'Product') return data;
    } catch {
      // Bloc JSON-LD non parsable : on passe au suivant.
    }
  }
  return null;
}

/**
 * Valeur d'une ligne d'attribut de la fiche.
 *
 * La ligne empile son libellé et sa valeur :
 *   <div data-testid="item-attributes-size">
 *     <div>Taille</div><div itemprop="size">42<button aria-label="Informations…"></div>
 *   </div>
 * Lire le `textContent` du bloc entier donnait "Taille42" — inutilisable à
 * l'affichage, et une taille que le tri ne reconnaît que par accident. On cible
 * donc la valeur (`itemprop`), et on écarte le bouton d'aide qu'elle contient.
 *
 * Le clone reste hors du document : aucune mutation, donc aucun scan déclenché.
 */
function detailAttribute(doc: Document, name: string, prop: string): string {
  const row = doc.querySelector(`[data-testid="item-attributes-${name}"]`);
  if (!row) return '';

  const value = row.querySelector(`[itemprop="${prop}"]`) || row.lastElementChild || row;
  const clone = value.cloneNode(true) as Element;
  clone.querySelectorAll('button').forEach((btn) => {
    btn.remove();
  });
  return clone.textContent?.trim() ?? '';
}

/**
 * Ce que la fiche ne rend que dans son flux d'hydratation. Trois clés, une
 * seule passe sur les scripts de la page — voir `shared/hydration.ts`.
 *
 *   favourite_count  le bouton cœur arrive `disabled` et vide : Vinted
 *                    l'hydrate côté client, et l'enregistrement peut survenir
 *                    avant ;
 *   brand_id         repli du fil d'Ariane, qui n'a de maillon de marque que
 *                    si l'article en a une de référencée ;
 *   seller_id        repli du lien `/member/{id}` ;
 *   feedback_count   nombre d'évaluations du vendeur, et
 *   feedback_reputation  sa note entre 0 et 1 — les deux dans le bloc
 *                    `user_info_header`. Ici le flux passe **devant** le DOM,
 *                    qui n'a pour ces deux valeurs ni `data-testid` ni libellé
 *                    indépendant de la langue (voir `shared/seller.ts`).
 */
export const HYDRATED_KEYS = [
  'favourite_count',
  'brand_id',
  'seller_id',
  'feedback_count',
  'feedback_reputation',
] as const;

/**
 * Extraction complète d'une fiche article — **la seule source de vérité**.
 *
 * Elle travaille sur un `Document` quelconque : la page ouverte, ou la fiche
 * récupérée par `fetch()` pour un article enregistré depuis une carte. Les
 * deux chemins produisent donc exactement le même objet, avec les mêmes
 * ancres ; une carte ne fournit plus qu'un affichage immédiat, remplacé dès
 * que la fiche répond. Voir `enrichFromDetail()`.
 *
 * @param doc par défaut la page courante
 * @param pageUrl URL de cette fiche, par défaut celle de la page
 */
export function extractFromDetail(
  doc: Document = document,
  pageUrl = location.href
): SavedItem | null {
  const id = extractIdFromUrl(pageUrl);
  if (!id) return null;

  const path = pageUrl.replace(/^https?:\/\/[^/]+/, '').split('?')[0] ?? '';
  const url = `https://www.vinted.fr${path}`;
  const ld = readJsonLd(doc);

  // Taille et état ne sont pas dans le JSON-LD : les deux branches lisent le
  // même DOM. Idem pour les favoris, absents des deux sources.
  //
  // Les deux voies des favoris se complètent plutôt qu'elles ne se doublent :
  // le flux d'hydratation n'existe que dans le HTML initial (une navigation SPA
  // récupère ses données par fetch, sans ajouter de script), et c'est justement
  // là que le bouton n'est pas encore hydraté. Passé la navigation SPA, la page
  // est vivante depuis longtemps et le bouton porte le compteur.
  const size = detailAttribute(doc, 'size', 'size');
  const condition = detailAttribute(doc, 'status', 'status');

  const hydrated = hydrationNumbers(doc, id, HYDRATED_KEYS);
  const favouriteCount =
    readFavouriteButton(doc, '[data-testid="favourite-button"]') ??
    hydrated.favourite_count ??
    null;

  // Ici le fil d'Ariane décrit l'article lui-même : catégorie exacte.
  const category = categoryOf(doc, true);

  // DOM d'abord, flux en repli : le fil d'Ariane et le lien du vendeur sont
  // rendus côté serveur et visibles par Vinted comme du contenu, là où le flux
  // n'est qu'un détail d'implémentation de son rendu React.
  const brandId = brandIdFromBreadcrumb(doc) ?? idOf(hydrated.brand_id);
  const seller = readSeller(doc);
  const sellerId = seller.id ?? idOf(hydrated.seller_id);

  // Le pseudo n'a d'intérêt que s'il dit autre chose que l'identifiant, qui
  // suffit déjà à construire le lien vers le profil.
  const sellerName = seller.name && seller.name !== sellerId ? seller.name : null;

  // Réputation : flux d'abord, DOM en repli — l'inverse du reste, et pour la
  // raison donnée avec HYDRATED_KEYS. `??` et non `||` : zéro évaluation est
  // une valeur, et c'est même celle qui compte le plus.
  const sellerFeedbackCount = hydrated.feedback_count ?? seller.feedback.count;
  const rating = ratingFromReputation(hydrated.feedback_reputation) ?? seller.feedback.rating;

  // Un compte sans aucune évaluation n'a pas une note de 0 : il n'en a pas.
  // Vinted rend pourtant `feedback_reputation: 0`, qu'afficher tel quel
  // accuserait un vendeur neuf d'être un mauvais vendeur.
  const sellerRating = sellerFeedbackCount === 0 ? null : rating;

  // Les deux branches ci-dessous partagent la galerie : le JSON-LD ne porte
  // que la photo principale (une chaîne, pas un tableau, même à trois photos).
  const images = extractPhotos(doc, id);

  if (ld) {
    const offer = ld.offers || {};
    // Le JSON-LD donne un nombre brut (1) ; on le rend comme le catalogue ("1,00 €").
    const price =
      typeof offer.price === 'number'
        ? formatPrice(offer.price, offer.priceCurrency)
        : String(offer.price ?? '');

    return {
      id,
      url: offer.url || url,
      title: ld.name || titleFromUrl(url) || `Article ${id}`,
      brand: ld.brand?.name || '',
      size,
      condition,
      price,
      // Le JSON-LD porte déjà un nombre : inutile de le relire depuis l'affichage.
      priceValue: typeof offer.price === 'number' ? offer.price : parsePriceValue(offer.price),
      favouriteCount,
      // Repli sans fil d'Ariane : le JSON-LD nomme la catégorie
      // ("Hommes Chaussures de foot") mais sans identifiant — de quoi
      // l'afficher, pas de quoi relancer une recherche.
      category:
        category ||
        (ld.category ? { id: null, name: ld.category, path: [], url: null, exact: true } : null),
      imageUrl: ld.image || images?.[0]?.url || '',
      images,
      brandId,
      sellerId,
      sellerName,
      sellerRating,
      sellerFeedbackCount,
      // Le JSON-LD est la seule source de la description : la fiche ne porte
      // pas d'`itemprop="description"` (vérifié), et le bloc affiché est rendu
      // par React après hydratation.
      description: truncate(ld.description),
      source: 'detail',
    };
  }

  // Repli sans JSON-LD : on retombe sur les data-testid de la page.
  const img = doc.querySelector<HTMLImageElement>('[data-testid="item-photo-1--img"]');
  const price = text(doc.querySelector('[data-testid="item-price"]'));

  return {
    id,
    url,
    title: text(doc.querySelector('h1')) || titleFromUrl(url) || `Article ${id}`,
    brand: text(doc.querySelector('[data-testid="item-attributes-brand-menu-button"]')),
    size,
    condition,
    price,
    priceValue: parsePriceValue(price),
    favouriteCount,
    category,
    imageUrl: img ? img.src : images?.[0]?.url || '',
    images,
    brandId,
    sellerId,
    sellerName,
    sellerRating,
    sellerFeedbackCount,
    // Sans JSON-LD, la description n'est nulle part dans le HTML servi : on la
    // laisse absente plutôt que d'écraser celle d'une lecture précédente.
    description: null,
    source: 'detail',
  };
}
