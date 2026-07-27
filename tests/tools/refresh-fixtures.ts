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
import { writeFileSync, readFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, '..', 'fixtures');

const CATALOG_URL = 'https://www.vinted.fr/catalog?search_text=nike';

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
 * chance : on complète l'échantillon d'un exemplaire de chaque cas s'il en
 * existe un dans la page.
 */
function pickCards(cards: Element[]): Element[] {
  const picked = cards.slice(0, CARDS_KEPT);

  const cases: ((label: string) => boolean)[] = [
    (label) => Boolean(label) && !/taille\s*:/i.test(label),
    (label) => Boolean(label) && !/marque\s*:/i.test(label),
  ];

  for (const matches of cases) {
    if (picked.some((card) => matches(cardLabel(card)))) continue;
    const found = cards.find((card) => matches(cardLabel(card)) && !picked.includes(card));
    if (found) picked.push(found);
  }

  return picked;
}

/**
 * @param title titre du document produit
 * @param keep nombre de cartes ; par défaut l'échantillon complet
 */
function buildCatalogFixture(html: string, title = 'Fixture catalogue Vinted', keep = 0) {
  const doc = new JSDOM(html).window.document;
  const all = [...doc.querySelectorAll('[data-testid="grid-item"]')];
  if (!all.length) throw new Error('aucune carte [data-testid="grid-item"] trouvée');

  const cards = keep ? all.slice(0, keep) : pickCards(all);
  const parts = cards.map((card) => card.outerHTML);

  // Sur une page catégorie seulement : c'est de ce fil que les cartes tirent
  // leur catégorie, faute de la porter elles-mêmes.
  const crumbs = doc.querySelector('ul.breadcrumbs');
  const body = `${crumbs ? `${crumbs.outerHTML}\n` : ''}<div class="feed-grid">\n${parts.join('\n')}\n</div>`;

  return { html: wrap(title, body), count: cards.length, crumbs: Boolean(crumbs) };
}

function buildItemFixture(html: string, title = 'Fixture fiche article Vinted') {
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
  if (!ld) throw new Error('JSON-LD Product introuvable sur la fiche');
  parts.push(ld.outerHTML);

  // Les ancres de repli, utilisées si le JSON-LD venait à disparaître.
  const h1 = doc.querySelector('h1');
  if (h1) parts.push(h1.outerHTML);

  for (const sel of [
    '[data-testid="item-price"]',
    '[data-testid="item-attributes-size"]',
    '[data-testid="item-attributes-status"]',
    '[data-testid="item-attributes-brand-menu-button"]',
    '[data-testid="favourite-button"]',
    'ul.breadcrumbs', // le fil d'Ariane porte la catégorie de l'article
  ]) {
    const el = doc.querySelector(sel);
    if (el) parts.push(el.outerHTML);
  }

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

  for (const script of new Set([favourites, gallery])) {
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

const [catalogArg, itemArg, categoryArg, photosArg] = process.argv.slice(2);

const catalogHtml = catalogArg ? readFileSync(catalogArg, 'utf8') : await fetchPage(CATALOG_URL);
const itemUrl = firstItemUrl(catalogHtml);
const itemHtml = itemArg ? readFileSync(itemArg, 'utf8') : await fetchPage(itemUrl);
const categoryHtml = categoryArg
  ? readFileSync(categoryArg, 'utf8')
  : await fetchPage(CATEGORY_URL);

mkdirSync(FIXTURES, { recursive: true });

const catalog = buildCatalogFixture(catalogHtml);
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

// L'URL de la fiche est nécessaire aux tests : l'ID de l'article s'y trouve.
writeFileSync(
  join(FIXTURES, 'meta.json'),
  JSON.stringify(
    {
      itemUrl,
      catalogUrl: CATALOG_URL,
      categoryUrl: CATEGORY_URL,
      photosUrl: PHOTOS_URL,
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
if (photos) console.log(`item-photos.html  ${photos.count} blocs   ${photoCount(photos)}`);
console.log(`meta.json      ${itemUrl}`);
