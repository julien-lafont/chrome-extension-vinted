/**
 * Régénère les fixtures HTML à partir de vinted.fr.
 *
 * Les pages brutes pèsent 8 Mo (catalogue) et 2 Mo (fiche article), pour
 * l'essentiel du bundle Next.js dont les tests n'ont aucun usage. On n'extrait
 * donc que le markup réellement lu par le content script : quelques cartes
 * produit, et le JSON-LD + attributs de la fiche. Le markup reste authentique,
 * les fixtures tiennent en quelques dizaines de Ko.
 *
 * Les pages de recherche et de fiche sont rendues côté serveur et accessibles
 * sans être connecté : nul besoin de session pour rafraîchir.
 *
 *   npm run refresh-fixtures                    # télécharge depuis vinted.fr
 *   npm run refresh-fixtures -- cat.html it.html  # depuis des pages déjà capturées
 *
 * À relancer quand Vinted change son front et que les tests d'extraction cassent :
 * un test rouge avec des fixtures fraîches signale une vraie régression d'ancres.
 */
import { JSDOM } from 'jsdom';
import { errorText } from '../../src/shared/errors.ts';
import { writeFileSync, readFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, '..', 'fixtures');

const CATALOG_URL = 'https://www.vinted.fr/catalog?search_text=nike';

/**
 * La page d'accueil, dont le fil est le premier écran d'une session de chine.
 *
 * Ses cartes ont le markup du catalogue mais un `data-testid` **fixe**
 * (`feed-item`, sans identifiant) : c'est le seul endroit du site où l'ID doit
 * être lu dans l'URL du lien overlay. Sans cette fixture, rien ne le vérifie —
 * et l'extension y est restée inerte sans que personne le remarque.
 */
const HOME_URL = 'https://www.vinted.fr/';

// Une recherche par mots-clés n'a pas de fil d'Ariane, une page catégorie si :
// c'est là que les cartes reçoivent une catégorie. Les deux fixtures couvrent
// donc les deux moitiés de `categoryOf()`.
const CATEGORY_URL = 'https://www.vinted.fr/catalog/584-hauts-et-t-shirts';

/**
 * Une fiche à plusieurs photos, épinglée.
 *
 * `itemUrl` est pris au premier article du catalogue : le nombre de ses photos
 * change à chaque rafraîchissement, et rien ne garantit qu'il en ait plus d'une.
 * La galerie ne serait alors testée qu'à un exemplaire — c'est-à-dire pas
 * testée. Cette seconde fiche assure le cas multi-photos.
 *
 * L'article finira par être vendu et retiré : le refresh le signale alors et
 * conserve la fixture existante, plutôt que d'échouer d'un bloc. Le jour où cela
 * arrive, remplacer l'URL par n'importe quelle fiche à trois photos ou plus.
 */
const PHOTOS_URL = 'https://www.vinted.fr/items/9504133342-sac-a-dos-nike-rose';

/**
 * Une fiche **vendue**, pour `content-watch.test.ts` — voir
 * `docs/specs/suivi-prix.md` §4 et §8. `isSoldDetail()` s'ancre sur
 * `[data-testid="item-status--content"]` = « Vendu », qui n'existe que sur une
 * fiche réellement vendue : impossible à obtenir autrement qu'en pointant une
 * vraie fiche dans cet état, jamais en la fabriquant à la main (voir CLAUDE.md).
 *
 * Comme `PHOTOS_URL`, cet article finira par disparaître du tout (Vinted retire
 * les fiches vendues après un délai) : le refresh le signale alors sans faire
 * échouer les autres fixtures, et conserve la fixture existante. Remplacer par
 * n'importe quelle fiche affichant le badge « Vendu ».
 */
const SOLD_URL = 'https://www.vinted.fr/items/9508569835-t-shirt-nike';

/**
 * Catalogue de secours, où puiser les cas limites que la recherche principale
 * n'offre pas toujours.
 *
 * Les articles sans taille (sacs, accessoires) sont le cas le plus précieux de
 * l'extraction — c'est là que le sous-titre se réduit à l'état et qu'un parseur
 * naïf range « Très bon état » dans la taille. Or une recherche « nike » peut
 * n'en contenir aucun : le stock change tous les jours, et la fixture perdait
 * alors le cas sans que ce soit une régression de Vinted. Une recherche de sacs
 * en fournit à tous les coups.
 */
const SPARE_URL = 'https://www.vinted.fr/catalog?search_text=sac+a+main';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const CARDS_KEPT = 8;

async function fetchPage(url: string): Promise<string> {
  const res = await fetch(url, { headers: { 'user-agent': UA } });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.text();
}

/** Enveloppe des fragments dans un document minimal. */
function wrap(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8">
<title>${title}</title>
<!-- Fixture générée par tests/tools/refresh-fixtures.ts — ne pas éditer à la main. -->
</head>
<body>
${body}
</body>
</html>
`;
}

const cardLabel = (card: Element): string =>
  card.querySelector('[data-testid$="--overlay-link"]')?.getAttribute('title') || '';

/**
 * Vinted omet la taille sur les accessoires (sacs, porte-clés) et la marque sur
 * certains articles. Ce sont les seules cartes qui exercent les replis
 * d'extraction, et les prendre dans l'ordre de la page ne les inclut que par
 * chance : on complète l'échantillon d'un exemplaire de chaque cas.
 *
 * On le cherche d'abord dans la page principale, puis dans le catalogue de
 * secours — voir SPARE_URL. Sans lui, une journée sans accessoire chez « nike »
 * suffisait à retirer le cas de la fixture, et le test correspondant échouait
 * sur un échantillon appauvri plutôt que sur une régression.
 *
 * @param spare cartes d'une seconde recherche, où puiser ce qui manque
 */
function pickCards(cards: Element[], spare: Element[] = []): Element[] {
  const picked = cards.slice(0, CARDS_KEPT);

  // Le second cas exige une taille : c'est ce qui le rend probant. Une carte
  // sans marque *ni* taille — un sac du catalogue de secours — ne dirait pas si
  // le titre a été coupé au bon attribut, puisqu'il n'en resterait qu'un.
  const cases: ((label: string) => boolean)[] = [
    (label) => Boolean(label) && !/taille\s*:/i.test(label),
    (label) => Boolean(label) && !/marque\s*:/i.test(label) && /taille\s*:/i.test(label),
  ];

  for (const matches of cases) {
    if (picked.some((card) => matches(cardLabel(card)))) continue;

    const found = [...cards, ...spare].find(
      (card) => matches(cardLabel(card)) && !picked.includes(card)
    );
    if (found) picked.push(found);
  }

  return picked;
}

/** Cartes produit d'une page de catalogue, dans l'ordre de la page. */
function cardsOf(html: string): Element[] {
  return [...new JSDOM(html).window.document.querySelectorAll('[data-testid="grid-item"]')];
}

/**
 * @param title titre du document produit
 * @param keep nombre de cartes ; par défaut l'échantillon complet
 * @param spareHtml catalogue de secours, où puiser les cas limites manquants
 */
function buildCatalogFixture(
  html: string,
  title = 'Fixture catalogue Vinted',
  keep = 0,
  spareHtml = ''
) {
  const doc = new JSDOM(html).window.document;
  const all = [...doc.querySelectorAll('[data-testid="grid-item"]')];
  if (!all.length) throw new Error('aucune carte [data-testid="grid-item"] trouvée');

  const cards = keep ? all.slice(0, keep) : pickCards(all, spareHtml ? cardsOf(spareHtml) : []);
  const parts = cards.map((card) => card.outerHTML);

  // Sur une page catégorie seulement : c'est de ce fil que les cartes tirent
  // leur catégorie, faute de la porter elles-mêmes.
  const crumbs = doc.querySelector('ul.breadcrumbs');
  const body = `${crumbs ? `${crumbs.outerHTML}\n` : ''}<div class="feed-grid">\n${parts.join('\n')}\n</div>`;

  return { html: wrap(title, body), count: cards.length, crumbs: Boolean(crumbs) };
}

/**
 * @param requireJsonLd Vinted retire le JSON-LD Product d'une fiche **vendue**
 *   (rien à référencer pour le SEO) : `false` pour `SOLD_URL`, qui doit au
 *   contraire exercer le repli d'`extractFromDetail()` sans JSON-LD.
 */
export function buildItemFixture(
  html: string,
  title = 'Fixture fiche article Vinted',
  requireJsonLd = true
) {
  const doc = new JSDOM(html).window.document;
  const parts = [];

  // Le JSON-LD est la source principale de extractFromDetail().
  const ld = [...doc.querySelectorAll('script[type="application/ld+json"]')].find((s) => {
    try {
      return (JSON.parse(s.textContent ?? '') as { '@type'?: string })['@type'] === 'Product';
    } catch {
      return false;
    }
  });
  if (!ld && requireJsonLd) throw new Error('JSON-LD Product introuvable sur la fiche');
  if (ld) parts.push(ld.outerHTML);

  // Les ancres de repli, utilisées si le JSON-LD venait à disparaître.
  const h1 = doc.querySelector('h1');
  if (h1) parts.push(h1.outerHTML);

  for (const sel of [
    // Présent seulement sur une fiche vendue (ou réservée) : c'est l'ancre
    // d'`isSoldDetail()`, voir `docs/specs/suivi-prix.md` §4.
    '[data-testid="item-status"]',
    '[data-testid="item-price"]',
    '[data-testid="item-attributes-size"]',
    '[data-testid="item-attributes-status"]',
    '[data-testid="item-attributes-brand-menu-button"]',
    '[data-testid="favourite-button"]',
    // Le fil d'Ariane porte deux choses : la catégorie de l'article, et
    // l'identifiant de sa marque dans le maillon final (`/brand/53-nike`).
    'ul.breadcrumbs',
  ]) {
    const el = doc.querySelector(sel);
    if (el) parts.push(el.outerHTML);
  }

  // La cellule du vendeur, prise depuis son pseudo : c'est le lien qui l'englobe
  // qui porte l'identifiant (`/member/3165663897`), et les deux se lisent
  // ensemble. La cellule embarque l'avatar — quelques centaines d'octets, et du
  // markup authentique de plus.
  const seller = doc
    .querySelector('[data-testid="profile-username"]')
    ?.closest('a[href*="/member/"]');
  if (seller) parts.push(seller.outerHTML);

  // Toutes les photos, pas seulement la première : c'est le repli de la galerie
  // quand le flux d'hydratation ne donne rien.
  //
  // **Les doublons sont conservés délibérément.** Vinted rend le carrousel cinq
  // fois (bureau, mobile, bande de miniatures), et c'est précisément ce que
  // `photosFromDom()` doit absorber. Les dédoublonner ici rendrait la fixture
  // plus légère de 3 Ko et le test du dédoublonnage incapable d'échouer.
  const photos = doc.querySelectorAll('[data-testid^="item-photo-"][data-testid$="--img"]');
  const numbers = new Set<string>();

  for (const img of photos) {
    parts.push(img.outerHTML);
    const testid = img.getAttribute('data-testid');
    if (testid) numbers.add(testid);
  }

  // Les deux blocs voyagent parfois dans le même script (le flux les émet côte à
  // côte, et le plus petit script portant un compteur peut donc porter aussi la
  // galerie) : le garder deux fois ne ferait qu'alourdir la fixture.
  const favourites = favouriteHydrationScript(doc);
  const gallery = galleryHydrationScript(doc);
  const identifiers = identifiersHydrationScript(doc);

  for (const script of new Set([favourites, gallery, identifiers])) {
    if (script) parts.push(script);
  }

  return {
    html: wrap(title, parts.join('\n')),
    count: parts.length,
    photos: numbers.size,
    copies: photos.length,
    gallery: Boolean(gallery),
  };
}

/**
 * Le nombre de favoris de la fiche n'existe dans aucun nœud : le bouton cœur
 * arrive `disabled` et vide, Vinted l'hydrate côté client. Le compteur est en
 * revanche dans le flux React Server Components (`self.__next_f.push`), que
 * `favouriteCountFromHydration()` lit — d'où sa présence dans la fixture.
 *
 * Le flux est réparti sur ~150 scripts dont un de 1 Mo (les traductions, qui
 * mentionnent `favourite_count` sans valeur). On retient donc le plus petit
 * script portant un compteur chiffré.
 */
function favouriteHydrationScript(doc: Document): string | null {
  const CHIFFRE = /favourite_count\\*":\s*\d/;

  const candidates = [...doc.querySelectorAll('script')]
    .filter((s) => CHIFFRE.test(s.textContent ?? ''))
    .sort((a, b) => (a.textContent?.length ?? 0) - (b.textContent?.length ?? 0));

  return candidates[0]?.outerHTML ?? null;
}

/**
 * Le bloc `breadcrumbs` du flux, qui porte `brand_id` et `catalog_id`.
 *
 * C'est le repli de l'identifiant de marque quand le fil d'Ariane n'a pas de
 * maillon de marque, et la seconde source de `seller_id`. Sans lui dans la
 * fixture, ce repli ne serait jamais exercé — et casserait en silence.
 */
function identifiersHydrationScript(doc: Document): string | null {
  const CHIFFRE = /brand_id\\*":\s*\d/;

  const candidates = [...doc.querySelectorAll('script')]
    .filter((s) => CHIFFRE.test(s.textContent ?? ''))
    .sort((a, b) => (a.textContent?.length ?? 0) - (b.textContent?.length ?? 0));

  return candidates[0]?.outerHTML ?? null;
}

/**
 * Le bloc `gallery` du flux React Server Components, seul endroit où Vinted
 * livre **toutes** les photos et leur pleine résolution — le DOM plafonne à
 * `f800`, et le JSON-LD n'expose que la photo principale.
 *
 * Il n'est pas dans le script des favoris (3,6 Ko contre 6 Ko sur une fiche
 * mesurée) : les deux se capturent séparément. Le flux répète le bloc cinq fois,
 * on garde le plus petit script qui le porte.
 */
function galleryHydrationScript(doc: Document): string | null {
  const candidates = [...doc.querySelectorAll('script')]
    .filter((s) => (s.textContent ?? '').includes('\\"name\\":\\"gallery\\"'))
    .sort((a, b) => (a.textContent?.length ?? 0) - (b.textContent?.length ?? 0));

  return candidates[0]?.outerHTML ?? null;
}

/** Première fiche article référencée par la page catalogue. */
function firstItemUrl(html: string): string {
  const doc = new JSDOM(html).window.document;
  const link = doc.querySelector<HTMLAnchorElement>('a[href*="/items/"]');
  if (!link) throw new Error('aucun lien /items/ dans le catalogue');
  return link.href.split('?')[0] ?? link.href;
}

const [catalogArg, itemArg, categoryArg, photosArg, soldArg, homeArg] = process.argv.slice(2);

const catalogHtml = catalogArg ? readFileSync(catalogArg, 'utf8') : await fetchPage(CATALOG_URL);
const itemUrl = firstItemUrl(catalogHtml);
const itemHtml = itemArg ? readFileSync(itemArg, 'utf8') : await fetchPage(itemUrl);
const categoryHtml = categoryArg
  ? readFileSync(categoryArg, 'utf8')
  : await fetchPage(CATEGORY_URL);

mkdirSync(FIXTURES, { recursive: true });

// Le catalogue de secours ne sert qu'à compléter l'échantillon : son échec ne
// doit pas emporter le rafraîchissement, la fixture sera simplement plus pauvre
// — et c'est le test du cas manquant qui le dira.
const spareHtml = await fetchPage(SPARE_URL).catch((err: unknown) => {
  console.warn(`\n⚠  catalogue de secours indisponible (${errorText(err)}).\n`);
  return '';
});

const catalog = buildCatalogFixture(catalogHtml, 'Fixture catalogue Vinted', 0, spareHtml);
writeFileSync(join(FIXTURES, 'catalog.html'), catalog.html);

const item = buildItemFixture(itemHtml);
writeFileSync(join(FIXTURES, 'item.html'), item.html);

// Deux cartes suffisent : cette fixture n'est là que pour le fil d'Ariane.
const category = buildCatalogFixture(categoryHtml, 'Fixture page catégorie Vinted', 2);
if (!category.crumbs) throw new Error(`aucun fil d'Ariane sur ${CATEGORY_URL}`);
writeFileSync(join(FIXTURES, 'category.html'), category.html);

// Fiche multi-photos. Le seul cas où un échec n'interrompt pas le refresh : cet
// article-là finira par disparaître, et perdre les trois autres fixtures pour
// autant serait absurde. Le message dit quoi faire.
let photos: ReturnType<typeof buildItemFixture> | null = null;
try {
  const photosHtml = photosArg ? readFileSync(photosArg, 'utf8') : await fetchPage(PHOTOS_URL);
  const built = buildItemFixture(photosHtml, 'Fixture fiche article Vinted — plusieurs photos');
  if (built.photos < 2) throw new Error(`${built.photos} photo(s) — il en faut au moins 2`);

  writeFileSync(join(FIXTURES, 'item-photos.html'), built.html);
  photos = built;
} catch (err) {
  console.warn(
    `\n⚠  item-photos.html non régénérée (${err instanceof Error ? err.message : String(err)}).` +
      `\n   La fixture existante est conservée. Si l'article a été retiré, remplacer` +
      `\n   PHOTOS_URL par n'importe quelle fiche à trois photos ou plus.\n`
  );
}

// Fiche vendue, pour le suivi de prix. Même filet de sécurité que la fiche
// multi-photos : l'article finira retiré, et perdre les autres fixtures pour
// autant serait absurde.
let sold: ReturnType<typeof buildItemFixture> | null = null;
try {
  const soldHtml = soldArg ? readFileSync(soldArg, 'utf8') : await fetchPage(SOLD_URL);
  const built = buildItemFixture(soldHtml, 'Fixture fiche article Vinted — vendue', false);
  if (!built.html.includes('item-status--content')) {
    throw new Error('aucun badge « Vendu » sur cette fiche — trouver un autre article vendu');
  }

  writeFileSync(join(FIXTURES, 'sold.html'), built.html);
  sold = built;
} catch (err) {
  console.warn(
    `\n⚠  sold.html non régénérée (${err instanceof Error ? err.message : String(err)}).` +
      `\n   La fixture existante est conservée. Remplacer SOLD_URL par n'importe quelle` +
      `\n   fiche affichant le badge « Vendu ».\n`
  );
}

// Page d'accueil. Quatre cartes suffisent : cette fixture n'est là que pour le
// `data-testid` sans identifiant, pas pour les cas limites de l'extraction.
const homeHtml = homeArg ? readFileSync(homeArg, 'utf8') : await fetchPage(HOME_URL);
const home = buildCatalogFixture(homeHtml, "Fixture page d'accueil Vinted", 4);
if (!home.html.includes('data-testid="feed-item"')) {
  throw new Error("aucune carte `feed-item` sur la page d'accueil — le testid a changé");
}
writeFileSync(join(FIXTURES, 'home.html'), home.html);

// L'URL de la fiche est nécessaire aux tests : l'ID de l'article s'y trouve.
writeFileSync(
  join(FIXTURES, 'meta.json'),
  JSON.stringify(
    {
      itemUrl,
      catalogUrl: CATALOG_URL,
      categoryUrl: CATEGORY_URL,
      photosUrl: PHOTOS_URL,
      soldUrl: SOLD_URL,
      homeUrl: HOME_URL,
      cards: catalog.count,
      refreshedAt: new Date().toISOString(),
    },
    null,
    2
  ) + '\n'
);

const kb = (s: string): string => `${Math.round(Buffer.byteLength(s) / 1024)} Ko`;
const photoCount = (built: { photos: number; copies: number; gallery: boolean }): string =>
  `${built.photos} photo(s) en ${built.copies} exemplaires, flux ${built.gallery ? 'capturé' : 'ABSENT'}`;

console.log(`catalog.html   ${catalog.count} cartes  ${kb(catalog.html)}`);
console.log(`item.html      ${item.count} blocs   ${kb(item.html)}  ${photoCount(item)}`);
console.log(`category.html  ${category.count} cartes  ${kb(category.html)}`);
console.log(`home.html      ${home.count} cartes  ${kb(home.html)}`);
if (photos) console.log(`item-photos.html  ${photos.count} blocs   ${photoCount(photos)}`);
if (sold) console.log(`sold.html      ${sold.count} blocs   ${kb(sold.html)}`);
console.log(`meta.json      ${itemUrl}`);
