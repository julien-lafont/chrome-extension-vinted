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

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const CARDS_KEPT = 8;

async function fetchPage(url) {
  const res = await fetch(url, { headers: { 'user-agent': UA } });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.text();
}

/** Enveloppe des fragments dans un document minimal. */
function wrap(title, body) {
  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8">
<title>${title}</title>
<!-- Fixture générée par tests/tools/refresh-fixtures.mjs — ne pas éditer à la main. -->
</head>
<body>
${body}
</body>
</html>
`;
}

const cardLabel = (card) => {
  const link = card.querySelector('[data-testid$="--overlay-link"]');
  return (link && link.getAttribute('title')) || '';
};

/**
 * Vinted omet la taille sur les accessoires (sacs, porte-clés) et la marque sur
 * certains articles. Ce sont les seules cartes qui exercent les replis
 * d'extraction, et les prendre dans l'ordre de la page ne les inclut que par
 * chance : on complète l'échantillon d'un exemplaire de chaque cas s'il en
 * existe un dans la page.
 */
function pickCards(cards) {
  const picked = cards.slice(0, CARDS_KEPT);

  const cases = [
    (label) => label && !/taille\s*:/i.test(label),
    (label) => label && !/marque\s*:/i.test(label),
  ];

  for (const matches of cases) {
    if (picked.some((card) => matches(cardLabel(card)))) continue;
    const found = cards.find((card) => matches(cardLabel(card)) && !picked.includes(card));
    if (found) picked.push(found);
  }

  return picked;
}

/**
 * @param {string} title titre du document produit
 * @param {number} [keep] nombre de cartes ; par défaut l'échantillon complet
 */
function buildCatalogFixture(html, title = 'Fixture catalogue Vinted', keep = 0) {
  const doc = new JSDOM(html).window.document;
  const all = [...doc.querySelectorAll('[data-testid="grid-item"]')];
  if (!all.length) throw new Error('aucune carte [data-testid="grid-item"] trouvée');

  const cards = keep ? all.slice(0, keep) : pickCards(all);
  const parts = cards.map((c) => c.outerHTML);

  // Sur une page catégorie seulement : c'est de ce fil que les cartes tirent
  // leur catégorie, faute de la porter elles-mêmes.
  const crumbs = doc.querySelector('ul.breadcrumbs');
  const body = `${crumbs ? `${crumbs.outerHTML}\n` : ''}<div class="feed-grid">\n${parts.join('\n')}\n</div>`;

  return { html: wrap(title, body), count: cards.length, crumbs: Boolean(crumbs) };
}

function buildItemFixture(html) {
  const doc = new JSDOM(html).window.document;
  const parts = [];

  // Le JSON-LD est la source principale de extractFromDetail().
  const ld = [...doc.querySelectorAll('script[type="application/ld+json"]')].find((s) => {
    try {
      return JSON.parse(s.textContent)['@type'] === 'Product';
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
    '[data-testid="item-photo-1--img"]',
    '[data-testid="favourite-button"]',
    'ul.breadcrumbs', // le fil d'Ariane porte la catégorie de l'article
  ]) {
    const el = doc.querySelector(sel);
    if (el) parts.push(el.outerHTML);
  }

  const hydration = favouriteHydrationScript(doc);
  if (hydration) parts.push(hydration);

  return { html: wrap('Fixture fiche article Vinted', parts.join('\n')), count: parts.length };
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
function favouriteHydrationScript(doc) {
  const CHIFFRE = /favourite_count\\*":\s*\d/;

  const candidates = [...doc.querySelectorAll('script')]
    .filter((s) => CHIFFRE.test(s.textContent))
    .sort((a, b) => a.textContent.length - b.textContent.length);

  return candidates.length ? candidates[0].outerHTML : null;
}

/** Première fiche article référencée par la page catalogue. */
function firstItemUrl(html) {
  const doc = new JSDOM(html).window.document;
  const link = doc.querySelector('a[href*="/items/"]');
  if (!link) throw new Error('aucun lien /items/ dans le catalogue');
  return link.href.split('?')[0];
}

const [catalogArg, itemArg, categoryArg] = process.argv.slice(2);

const catalogHtml = catalogArg ? readFileSync(catalogArg, 'utf8') : await fetchPage(CATALOG_URL);
const itemUrl = firstItemUrl(catalogHtml);
const itemHtml = itemArg ? readFileSync(itemArg, 'utf8') : await fetchPage(itemUrl);
const categoryHtml = categoryArg ? readFileSync(categoryArg, 'utf8') : await fetchPage(CATEGORY_URL);

mkdirSync(FIXTURES, { recursive: true });

const catalog = buildCatalogFixture(catalogHtml);
writeFileSync(join(FIXTURES, 'catalog.html'), catalog.html);

const item = buildItemFixture(itemHtml);
writeFileSync(join(FIXTURES, 'item.html'), item.html);

// Deux cartes suffisent : cette fixture n'est là que pour le fil d'Ariane.
const category = buildCatalogFixture(categoryHtml, 'Fixture page catégorie Vinted', 2);
if (!category.crumbs) throw new Error(`aucun fil d'Ariane sur ${CATEGORY_URL}`);
writeFileSync(join(FIXTURES, 'category.html'), category.html);

// L'URL de la fiche est nécessaire aux tests : l'ID de l'article s'y trouve.
writeFileSync(
  join(FIXTURES, 'meta.json'),
  JSON.stringify(
    {
      itemUrl,
      catalogUrl: CATALOG_URL,
      categoryUrl: CATEGORY_URL,
      cards: catalog.count,
      refreshedAt: new Date().toISOString(),
    },
    null,
    2
  ) + '\n'
);

const kb = (s) => `${Math.round(Buffer.byteLength(s) / 1024)} Ko`;
console.log(`catalog.html   ${catalog.count} cartes  ${kb(catalog.html)}`);
console.log(`item.html      ${item.count} blocs   ${kb(item.html)}`);
console.log(`category.html  ${category.count} cartes  ${kb(category.html)}`);
console.log(`meta.json      ${itemUrl}`);
