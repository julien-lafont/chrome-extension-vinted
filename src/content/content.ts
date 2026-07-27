/**
 * Vinted Favoris — content script
 *
 * Injecte un bouton d'enregistrement sur chaque carte produit du catalogue,
 * sur celles des blocs d'une fiche article (dressing du membre, articles
 * similaires), et sur la page détail elle-même.
 *
 * Ancres DOM utilisées (relevées sur vinted.fr) :
 *   Catalogue — [data-testid="product-item-id-{ID}"] porte l'ID de l'article,
 *   ses enfants suffixés `--overlay-link`, `--image--img`, `--description-title`,
 *   `--description-subtitle`, `--price-text` portent les métadonnées.
 *   Blocs de la fiche — mêmes cartes, préfixe différent : voir blockCards().
 *   Détail — un <script type="application/ld+json"> schema.org expose tout ;
 *   les data-testid `item-*` servent de repli.
 */
import { errorText } from '../shared/errors.ts';
import type { ExtensionMessage } from '../shared/messages.ts';
import { extractPhotos, photosFromDom, photosFromHydration } from '../shared/photos.ts';
import { parsePriceString } from '../shared/price.ts';
import type { ItemCategory, ItemMap, SavedItem } from '../shared/types.ts';

(() => {
  'use strict';

  const STORAGE_KEY = 'savedItems';
  const BTN_FLAG = 'vfInjected'; // dataset posé sur les cartes déjà traitées

  /** Cache local du contenu du storage : { [id]: item }. */
  let saved: ItemMap = {};

  /** Télémétrie de debug, remontée par le diagnostic du panneau latéral. */
  const debug = {
    clicks: 0,
    writes: 0,
    enriched: 0,
    enrichFailed: 0,
    lastError: null as string | null,
  };

  // ---------------------------------------------------------------------------
  // Storage
  // ---------------------------------------------------------------------------

  /** `chrome.storage.local.get` n'est pas typé : la conversion est concentrée ici. */
  async function readItems(): Promise<ItemMap> {
    const res: { savedItems?: ItemMap } = await chrome.storage.local.get(STORAGE_KEY);
    return res[STORAGE_KEY] || {};
  }

  async function loadSaved(): Promise<void> {
    saved = await readItems();
  }

  /**
   * Ajoute ou retire un article. On relit le storage juste avant d'écrire
   * pour ne pas écraser ce qu'un autre onglet Vinted aurait enregistré.
   *
   * @returns ce que le clic a fait
   */
  async function toggleItem(item: SavedItem): Promise<'added' | 'removed'> {
    const current = await readItems();

    if (current[item.id]) {
      delete current[item.id];
      await chrome.storage.local.set({ [STORAGE_KEY]: current });
      return 'removed';
    }

    current[item.id] = { ...item, savedAt: Date.now() };
    await chrome.storage.local.set({ [STORAGE_KEY]: current });
    return 'added';
  }

  /**
   * Applique les champs d'une fiche sur un article déjà enregistré.
   *
   * Une valeur vide de la fiche ne doit pas effacer celle de la carte : si Vinted
   * casse une ancre de fiche, on garde ce que la carte affichait. `0` est en
   * revanche une valeur (aucun favori), d'où le test explicite plutôt qu'un
   * simple test de véracité.
   */
  function mergeDetail(base: SavedItem, detail: Partial<SavedItem>): SavedItem {
    const merged: Record<string, unknown> = { ...base };

    for (const [key, value] of Object.entries(detail)) {
      if (value === null || value === undefined || value === '') continue;
      merged[key] = value;
    }

    return merged as SavedItem;
  }

  // ---------------------------------------------------------------------------
  // Extraction — champs communs
  // ---------------------------------------------------------------------------

  const text = (el: Element | null): string => el?.textContent?.trim() ?? '';

  /**
   * Vocabulaire des états Vinted. Sert à reconnaître un état quand rien ne dit
   * si une valeur isolée est une taille ou un état — voir parseSubtitle().
   */
  const CONDITION_WORDS = /neuf\s+(avec|sans)|(tr[eè]s\s+)?bon\s+[ée]tat|satisfaisant/i;

  /** Voir `shared/price.ts` — le parseur est commun au panneau et à l'extraction. */
  const parsePriceValue = parsePriceString;

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
  function readFavouriteButton(scope: ParentNode, selector: string): number | null {
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
  function readBreadcrumbCategory(doc: Document): Omit<ItemCategory, 'exact'> | null {
    const list =
      doc.querySelector('ul.breadcrumbs') ??
      doc.querySelector('a[itemprop="url"][href*="/catalog/"]')?.parentElement;

    const links = list
      ? [...list.querySelectorAll('a[href*="/catalog/"]')].filter(
          (a) => !(a.getAttribute('href') ?? '').includes('/brand/')
        )
      : [];

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
  function categoryOf(doc: Document, exact: boolean): ItemCategory | null {
    const category = readBreadcrumbCategory(doc);
    return category ? { ...category, exact } : null;
  }

  // ---------------------------------------------------------------------------
  // Extraction — cartes (catalogue, et blocs d'articles d'une fiche)
  // ---------------------------------------------------------------------------

  const isDetailPage = () => /^\/items\/\d+/.test(location.pathname);

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
  function parseTitleFromLabel(label: string): string {
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

    return CONDITION_WORDS.test(only)
      ? { size: '', condition: only }
      : { size: only, condition: '' };
  }

  /** Repli ultime : reconstruit un titre lisible depuis le slug de l'URL. */
  function titleFromUrl(url: string): string {
    const m = url ? url.match(/\/items\/\d+-([^?#/]+)/) : null;
    if (!m?.[1]) return '';
    const words = m[1].replace(/-/g, ' ').trim();
    return words.charAt(0).toUpperCase() + words.slice(1);
  }

  function extractIdFromUrl(url: string): string | null {
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
  function cardId(testid: string | undefined): string | null {
    const match = String(testid || '').match(/-(\d+)$/);
    return match?.[1] ?? null;
  }

  /** @param box conteneur de carte, ex. [data-testid="product-item-id-{ID}"] */
  function extractFromCard(box: HTMLElement): SavedItem | null {
    const id = cardId(box.dataset.testid);
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

  /** Formate un prix numérique à la française : 1 → "1,00 €". */
  function formatPrice(value: number, currency: string | undefined): string {
    try {
      return new Intl.NumberFormat('fr-FR', {
        style: 'currency',
        currency: currency || 'EUR',
      }).format(value);
    } catch {
      return `${String(value).replace('.', ',')} ${currency || ''}`.trim();
    }
  }

  /**
   * Forme du JSON-LD de Vinted, réduite à ce qu'on en lit. Tous les champs sont
   * optionnels : c'est du contenu tiers, rien ne garantit sa structure.
   */
  type ProductJsonLd = {
    '@type'?: string;
    name?: string;
    brand?: { name?: string };
    category?: string;
    image?: string;
    offers?: { price?: number | string; priceCurrency?: string; url?: string };
  };

  /** Lit le JSON-LD schema.org de la page détail. Source la plus stable. */
  function readJsonLd(doc: Document): ProductJsonLd | null {
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
   * Nombre de favoris de la fiche, lu dans le flux React Server Components.
   *
   * Le bouton cœur de la fiche arrive `disabled`, sans compteur ni libellé :
   * Vinted l'hydrate côté client, et l'enregistrement peut survenir avant. Le
   * nombre, lui, est présent dès le HTML dans les `self.__next_f.push(...)`, sous
   *   {"name":"favourite",…,"data":{"item_id":<id>,…,"favourite_count":N,…}}
   * Les guillemets y sont échappés (\"), d'où les `\\?"` du motif ; `[^}]` borne
   * la recherche à l'objet courant, pour ne pas rattacher à cet article le
   * compteur d'un article voisin (« autres articles du membre »).
   *
   * Balayer les ~240 scripts d'une fiche coûte 16 ms (mesuré sous jsdom, donc
   * majoré), quelques fois par article : pas de cache, pour la même raison que
   * `readBreadcrumbCategory()` — un document fetché et la page courante n'ont pas
   * le même contenu, et une valeur mémorisée finit toujours par être servie au
   * mauvais article.
   *
   */
  function favouriteCountFromHydration(doc: Document, id: string): number | null {
    const pattern = new RegExp(
      `\\\\?"item_id\\\\?":\\s*${id}\\b[^}]{0,300}?\\\\?"favourite_count\\\\?":\\s*(\\d+)`
    );

    for (const script of doc.querySelectorAll('script')) {
      const source = script.textContent;
      if (!source || source.indexOf('favourite_count') === -1) continue;

      const match = source.match(pattern);
      if (match?.[1]) return Number.parseInt(match[1], 10);
    }

    return null;
  }

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
  function extractFromDetail(doc: Document = document, pageUrl = location.href): SavedItem | null {
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
    const favouriteCount =
      readFavouriteButton(doc, '[data-testid="favourite-button"]') ??
      favouriteCountFromHydration(doc, id);

    // Ici le fil d'Ariane décrit l'article lui-même : catégorie exacte.
    const category = categoryOf(doc, true);

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
      source: 'detail',
    };
  }

  // ---------------------------------------------------------------------------
  // Enrichissement : compléter une carte par sa fiche
  // ---------------------------------------------------------------------------

  /**
   * Une carte de catalogue ne porte ni catégorie, ni couleur, ni description, et
   * sa taille comme son état ne viennent que d'un libellé d'accessibilité. La
   * fiche porte tout : on la récupère en tâche de fond pour que l'article
   * enregistré depuis une recherche vaille celui enregistré depuis sa fiche.
   *
   * `fetch()` plutôt qu'un onglet : même origine, cookies inclus, aucun JS de
   * Vinted exécuté, rien de visible pour l'utilisateur. Le HTML servi contient
   * déjà tout ce qu'on lit (JSON-LD, fil d'Ariane, compteur de favoris dans le
   * flux d'hydratation) — c'est d'ailleurs ainsi que les fixtures de test sont
   * produites, par simple requête HTTP.
   */
  const ENRICH_TIMEOUT_MS = 15000;

  /** Un article dont il reste à lire la fiche. */
  type EnrichJob = { id: string; url: string };

  /** Articles en attente d'enrichissement, traités un par un. */
  const enrichQueue: EnrichJob[] = [];
  let enrichRunning = false;

  /**
   * Le storage porte l'état d'avancement pour que le panneau l'affiche :
   *   pending: true   → fiche en cours de lecture, l'article n'a que les
   *                     données de sa carte
   *   pending absent  → article complet, ou fiche définitivement illisible
   */
  function queueEnrich(id: string, url: string): void {
    if (enrichQueue.some((job) => job.id === id)) return;
    enrichQueue.push({ id, url });
    // Volontairement non attendu : le clic ne doit pas patienter sur la requête.
    if (!enrichRunning) void runEnrichQueue();
  }

  /**
   * Une fiche à la fois : enregistrer dix articles d'affilée ne doit pas lancer
   * dix requêtes de 2 Mo en parallèle. L'utilisateur ne les attend pas — chaque
   * article est déjà affiché avec les données de sa carte.
   */
  async function runEnrichQueue(): Promise<void> {
    enrichRunning = true;

    let job: EnrichJob | undefined;
    while ((job = enrichQueue.shift())) {
      try {
        await enrichFromDetail(job.id, job.url);
      } catch (err) {
        debug.lastError = `enrichissement ${job.id} : ${errorText(err)}`;
        debug.enrichFailed += 1;
        await finishEnrich(job.id, null);
      }
    }

    enrichRunning = false;
  }

  async function enrichFromDetail(id: string, url: string): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ENRICH_TIMEOUT_MS);

    try {
      const response = await fetch(url, { credentials: 'include', signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      // DOMParser produit un document inerte : ni script exécuté, ni image chargée.
      const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
      const detail = extractFromDetail(doc, url);
      if (!detail) throw new Error('extraction vide');

      // Vinted redirige les articles retirés ou fusionnés : la page servie peut
      // décrire un autre article. L'écraser avec ces données serait pire que de
      // s'en tenir à ce que la carte affichait. L'identifiant de contrôle est
      // celui du contenu (le JSON-LD porte l'URL canonique), pas celui de l'URL
      // demandée — dont `extractFromDetail()` tire justement `detail.id`.
      const servedId = extractIdFromUrl(detail.url);
      if (servedId && servedId !== id) throw new Error(`fiche ${servedId} reçue pour ${id}`);

      await finishEnrich(id, detail);
      debug.enriched += 1;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Écrit le résultat, ou lève seulement l'état d'attente si la fiche n'a rien
   * donné. Relit le storage juste avant, comme toute écriture (plusieurs onglets),
   * et **n'écrit rien si l'article n'y est plus** : l'utilisateur a pu le retirer
   * pendant la requête, le ressusciter serait pire que de perdre l'enrichissement.
   */
  async function finishEnrich(id: string, detail: SavedItem | null): Promise<void> {
    const current = await readItems();
    const existing = current[id];
    if (!existing) return;

    const merged = detail ? mergeDetail(existing, detail) : { ...existing };
    delete merged.pending;

    current[id] = merged;
    await chrome.storage.local.set({ [STORAGE_KEY]: current });
  }

  // ---------------------------------------------------------------------------
  // Rendu des boutons
  // ---------------------------------------------------------------------------

  const ICON_OUTLINE =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>';
  const ICON_FILLED =
    '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>';

  function paintButton(btn: HTMLButtonElement, isSaved: boolean): void {
    // Idempotent, et c'est vital : réécrire innerHTML déclenche le MutationObserver,
    // qui relance un scan, qui repeint… Sans cette garde, la page part en boucle
    // à chaque frame et le bouton devient incliquable (ses enfants sont détruits
    // entre le mousedown et le mouseup, donc aucun événement "click" n'est émis).
    if (btn.dataset.vfPainted === '1' && btn.dataset.vfSaved === String(isSaved)) return;

    const isDetail = btn.classList.contains('vf-detail-btn');
    btn.dataset.vfSaved = String(isSaved);
    btn.dataset.vfPainted = '1';
    btn.setAttribute('aria-pressed', String(isSaved));

    if (isDetail) {
      btn.innerHTML =
        (isSaved ? ICON_FILLED : ICON_OUTLINE) +
        `<span>${isSaved ? 'Enregistré' : 'Enregistrer'}</span>`;
      btn.title = isSaved ? 'Retirer de mes favoris' : 'Enregistrer dans mes favoris';
    } else {
      btn.innerHTML = isSaved ? ICON_FILLED : ICON_OUTLINE;
      btn.title = isSaved
        ? 'Retirer de mes favoris (extension)'
        : 'Enregistrer dans mes favoris (extension)';
    }
    btn.setAttribute('aria-label', btn.title);
  }

  /** @param getItem recalcule l'article au moment du clic */
  function createButton(className: string, getItem: () => SavedItem | null): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = className;

    const activate = async (event: Event): Promise<void> => {
      // Sur une carte, le bouton est posé au-dessus du lien overlay :
      // sans ça, le clic navigue vers l'article.
      event.preventDefault();
      event.stopPropagation();
      debug.clicks += 1;

      try {
        const item = getItem();
        if (!item) {
          debug.lastError = 'extraction vide';
          return;
        }

        // Une carte n'a pas tout : on l'enregistre telle quelle, marquée en
        // attente, et la fiche complétera. L'écriture est immédiate — le panneau
        // affiche l'article dès le clic, pas au retour de la requête.
        const fromCard = item.source === 'catalog';
        const action = await toggleItem(fromCard ? { ...item, pending: true } : item);
        debug.writes += 1;

        // Repeint immédiatement : si le storage échoue silencieusement ou si
        // onChanged ne se déclenche pas, l'utilisateur voit quand même l'état.
        saved = await readItems();
        repaintAll();

        if (fromCard && action === 'added') queueEnrich(item.id, item.url);
      } catch (err) {
        // Cas classique : extension rechargée sans recharger l'onglet
        // ("Extension context invalidated") — le clic échoue en silence.
        debug.lastError = errorText(err);
        console.error('[Vinted Favoris] clic échoué :', err);
      }
    };

    // Le déclencheur souris est "pointerdown", pas "click" : un "click" n'est émis
    // que si le navigateur juge le geste comme tel. Il est supprimé quand une
    // sélection de texte démarre sur le libellé, quand le pointeur glisse un peu,
    // ou quand la cible du mousedown a disparu avant le mouseup. "pointerdown"
    // est inconditionnel.
    // `void` : l'écouteur ne doit rien renvoyer, et personne n'attend l'écriture.
    btn.addEventListener('pointerdown', (event) => {
      void activate(event);
    });

    // Le "click" qui suit ce même geste doit être neutralisé sans re-déclencher.
    // MouseEvent.detail vaut 0 pour un click synthétisé par le clavier (Entrée /
    // Espace) et >= 1 pour un clic souris : c'est ce qui distingue les deux.
    btn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      // Volontairement non attendu : rien ne dépend de la fin de l'écriture ici.
      if (event.detail === 0) void activate(event);
    });

    return btn;
  }

  function injectCardButton(box: HTMLElement): void {
    if (box.dataset[BTN_FLAG]) return;

    const item = extractFromCard(box);
    if (!item) return;

    // Le bouton doit être ancré dans un parent positionné.
    const host =
      box.querySelector<HTMLElement>('.new-item-box__image-container') ||
      box.querySelector('img')?.closest<HTMLElement>('div') ||
      box;
    if (getComputedStyle(host).position === 'static') {
      host.style.position = 'relative';
    }

    box.dataset[BTN_FLAG] = '1';

    const btn = createButton('vf-card-btn', () => extractFromCard(box));
    btn.dataset.vfId = item.id;
    paintButton(btn, Boolean(saved[item.id]));
    host.appendChild(btn);
  }

  function injectDetailButton(): void {
    const existing = document.querySelector<HTMLButtonElement>('.vf-detail-btn');

    if (!isDetailPage()) {
      if (existing) existing.remove();
      return;
    }

    // Bouton déjà en place sur le même article : rien à ré-extraire.
    // Le scan tourne à chaque mutation de la SPA, donc ce raccourci compte.
    if (existing && existing.dataset.vfPath === location.pathname) {
      paintButton(existing, Boolean(existing.dataset.vfId && saved[existing.dataset.vfId]));
      return;
    }

    const item = extractFromDetail();
    if (!item) return;

    // Navigation SPA vers un autre article : on recible le bouton existant.
    if (existing) {
      existing.dataset.vfId = item.id;
      existing.dataset.vfPath = location.pathname;
      existing.dataset.vfPainted = ''; // force le repeint pour le nouvel article
      paintButton(existing, Boolean(saved[item.id]));
      return;
    }

    const btn = createButton('vf-detail-btn', extractFromDetail);
    btn.dataset.vfId = item.id;
    btn.dataset.vfPath = location.pathname;
    paintButton(btn, Boolean(saved[item.id]));
    document.body.appendChild(btn);
  }

  /** Resynchronise l'état visuel de tous les boutons déjà en place. */
  function repaintAll(): void {
    document.querySelectorAll<HTMLButtonElement>('.vf-card-btn, .vf-detail-btn').forEach((btn) => {
      paintButton(btn, Boolean(btn.dataset.vfId && saved[btn.dataset.vfId]));
    });
  }

  /** Cartes du catalogue et des pages de recherche. */
  const CATALOG_CARDS = '[data-testid^="product-item-id-"]:not([data-testid*="--"])';

  /** Conteneur d'un bloc d'articles de fiche : `item-page-{plugin}-plugin`. */
  const BLOCK_TESTID = /^item-page-([a-z_]+)-plugin$/;

  /**
   * Cartes des blocs d'articles d'une fiche : « Dressing du membre », « Articles
   * similaires ».
   *
   * Ces blocs réutilisent la carte du catalogue, mais **pas son `data-testid`** :
   * `product-item-id-{ID}` n'est qu'un défaut, et chaque bloc passe à la carte
   * son propre préfixe — le nom du plugin, que porte le conteneur du bloc. Une
   * carte du dressing est donc `other_user_items-{ID}`, une carte des similaires
   * `similar_items-{ID}`. Le sélecteur du catalogue ne les voyait pas, et le
   * bouton n'apparaissait que sur la fiche elle-même.
   *
   * On dérive le préfixe du conteneur plutôt que de lister les plugins connus :
   * Vinted en ajoute (« Tu pourrais aussi aimer »…), et un bloc de plus doit
   * marcher sans changer de code. Les enfants d'une carte gardent le suffixe
   * `--…` habituel, d'où l'exclusion ; les voisins sans identifiant numérique
   * (`{plugin}-items`, `{plugin}-plugin-empty-state`) sont écartés par cardId().
   *
   * Le contenu de ces blocs **n'est pas dans le HTML servi** : Vinted rend un
   * squelette et charge les articles par requête à l'approche du bloc. C'est le
   * MutationObserver qui les voit arriver, jamais le scan initial.
   */
  function blockCards(): HTMLElement[] {
    const cards: HTMLElement[] = [];

    for (const block of document.querySelectorAll<HTMLElement>('[data-testid$="-plugin"]')) {
      const match = BLOCK_TESTID.exec(block.dataset.testid || '');
      if (!match) continue;

      cards.push(
        ...block.querySelectorAll<HTMLElement>(
          `[data-testid^="${match[1]}-"]:not([data-testid*="--"])`
        )
      );
    }

    return cards;
  }

  /** Toutes les cartes produit de la page, quel que soit le contexte. */
  function cardBoxes(): HTMLElement[] {
    return [...document.querySelectorAll<HTMLElement>(CATALOG_CARDS), ...blockCards()];
  }

  function scan(): void {
    cardBoxes().forEach((box) => {
      injectCardButton(box);
    });
    injectDetailButton();
  }

  // ---------------------------------------------------------------------------
  // Observation du DOM (SPA + scroll infini)
  // ---------------------------------------------------------------------------

  let scanScheduled = false;
  let lastUrl = location.href;

  function scheduleScan() {
    if (scanScheduled) return;
    scanScheduled = true;
    requestAnimationFrame(() => {
      scanScheduled = false;

      // Vinted est une SPA : l'URL change sans rechargement de page.
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        const stale = document.querySelector('.vf-detail-btn');
        if (stale && !isDetailPage()) stale.remove();
      }

      scan();
    });
  }

  // ---------------------------------------------------------------------------
  // Diagnostic (déclenché depuis le panneau latéral)
  // ---------------------------------------------------------------------------

  /**
   * Rapport lu par le panneau (`docs/diagnostic.md`). Les champs propres à la
   * fiche article ne sont renseignés que sur une fiche, d'où les optionnels.
   */
  type DiagnoseReport = {
    url: string;
    isDetailPage: boolean;
    cardsFound: number;
    cardsParsed: number;
    cardButtons: number;
    missing: Record<string, number>;
    categorie: Omit<ItemCategory, 'exact'> | string;
    savedCount: number;
    debug: typeof debug;
    sample: SavedItem | null;

    blocsArticles?: string[];
    blockCardsFound?: number;
    photos?: { flux: number; dom: number };
    detailJsonLd?: boolean;
    detailExtraction?: SavedItem | null;
    detailButton?: string;
    detailButtonBox?: Record<string, string | number>;
    clickablePoints?: string;
    BLOQUÉ_PAR?: Record<string, number>;
    inViewport?: boolean;
  };

  function diagnose(): DiagnoseReport {
    const boxes = cardBoxes();
    const items = boxes
      .map((box) => extractFromCard(box))
      .filter((item): item is SavedItem => item !== null);

    const TEXT_FIELDS = ['title', 'brand', 'price', 'imageUrl', 'size', 'condition'] as const;
    // Champs de tri numériques : 0 est une valeur, pas une absence.
    const NUMBER_FIELDS = ['priceValue', 'favouriteCount'] as const;

    const missing: Record<string, number> = {};
    [...TEXT_FIELDS, ...NUMBER_FIELDS].forEach((field) => {
      missing[field] = 0;
    });

    items.forEach((item) => {
      TEXT_FIELDS.forEach((field) => {
        if (!item[field]) missing[field] = (missing[field] ?? 0) + 1;
      });
      NUMBER_FIELDS.forEach((field) => {
        if (typeof item[field] !== 'number') missing[field] = (missing[field] ?? 0) + 1;
      });
    });

    // La catégorie vient de la page, pas de la carte : elle est la même pour
    // toutes, et absente sur une recherche par mots-clés. Un compte par carte
    // n'apprendrait rien — on montre la valeur.
    const category = readBreadcrumbCategory(document);

    const report: DiagnoseReport = {
      url: location.href,
      isDetailPage: isDetailPage(),
      cardsFound: boxes.length,
      cardsParsed: items.length,
      cardButtons: document.querySelectorAll('.vf-card-btn').length,
      missing,
      categorie: category || 'aucun fil d’Ariane (recherche par mots-clés ?)',
      savedCount: Object.keys(saved).length,
      debug: { ...debug },
      sample: items[0] || null,
    };

    if (!isDetailPage()) return report;

    // Les blocs d'articles de la fiche se chargent après le rendu : un compte à
    // zéro alors qu'ils sont visibles à l'écran dit que leur préfixe de testid a
    // changé, pas que la page est vide. Voir blockCards().
    report.blocsArticles = [...document.querySelectorAll<HTMLElement>('[data-testid$="-plugin"]')]
      .map((el) => el.dataset.testid)
      .filter((id): id is string => id !== undefined && BLOCK_TESTID.test(id));
    report.blockCardsFound = blockCards().length;

    const btn = document.querySelector<HTMLButtonElement>('.vf-detail-btn');
    report.detailJsonLd = Boolean(readJsonLd(document));
    report.detailExtraction = extractFromDetail();
    report.detailButton = !btn ? 'ABSENT' : 'présent';

    // Les deux voies de la galerie, comptées séparément : un flux muet et un DOM
    // fourni disent que le bloc `gallery` a changé de nom, pas que l'article n'a
    // qu'une photo. L'inverse (flux fourni, DOM muet) est normal après une
    // navigation SPA. Voir shared/photos.ts.
    const detailId = extractIdFromUrl(location.href);
    report.photos = {
      flux: detailId ? photosFromHydration(document, detailId).length : 0,
      dom: photosFromDom(document).length,
    };

    if (btn) {
      const r = btn.getBoundingClientRect();
      const style = getComputedStyle(btn);
      report.detailButtonBox = {
        top: Math.round(r.top),
        left: Math.round(r.left),
        w: Math.round(r.width),
        h: Math.round(r.height),
        visible: style.visibility,
        display: style.display,
        opacity: style.opacity,
        zIndex: style.zIndex,
      };

      // Un élément Vinted (barre d'achat sticky, overlay…) intercepte-t-il le clic ?
      // On sonde 9 points : un recouvrement partiel ne se voit pas au centre seul,
      // et se manifeste par un bouton qui ne répond que « à certains endroits ».
      if (typeof document.elementFromPoint === 'function') {
        const blockers: Record<string, number> = {};
        let free = 0;

        for (const fy of [0.15, 0.5, 0.85]) {
          for (const fx of [0.15, 0.5, 0.85]) {
            const hit = document.elementFromPoint(r.left + r.width * fx, r.top + r.height * fy);
            if (hit && (hit === btn || btn.contains(hit))) {
              free += 1;
              continue;
            }
            const testid = hit instanceof HTMLElement ? hit.dataset.testid : undefined;
            const name = hit
              ? `${hit.tagName.toLowerCase()}${testid ? `[${testid}]` : `.${String(hit.className).split(' ')[0]}`}`
              : 'hors viewport';
            blockers[name] = (blockers[name] || 0) + 1;
          }
        }

        report.clickablePoints = `${free}/9`;
        if (free < 9) report.BLOQUÉ_PAR = blockers;
      } else {
        report.clickablePoints = 'indéterminé';
      }

      // Hors viewport ? (bouton fixed, ne devrait jamais arriver)
      report.inViewport =
        r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth;
    }

    return report;
  }

  chrome.runtime.onMessage.addListener((raw, _sender, sendResponse) => {
    const message = raw as ExtensionMessage | null;
    if (message?.type === 'VF_DIAGNOSE') {
      sendResponse(diagnose());
    }
    return false;
  });

  // ---------------------------------------------------------------------------
  // Démarrage
  // ---------------------------------------------------------------------------

  chrome.storage.onChanged.addListener((changes, area) => {
    const change = changes[STORAGE_KEY];
    if (area !== 'local' || !change) return;
    saved = (change.newValue as ItemMap | undefined) || {};
    repaintAll();
  });

  void loadSaved().then(() => {
    scan();

    // Second garde-fou contre la boucle : on ignore les mutations que nos propres
    // boutons génèrent, pour ne réagir qu'aux changements venant de Vinted.
    const observer = new MutationObserver((mutations) => {
      const fromVinted = mutations.some((m) => {
        const target = m.target;
        if (!(target instanceof Element)) return true;
        return !target.closest('.vf-card-btn, .vf-detail-btn');
      });
      if (fromVinted) scheduleScan();
    });

    observer.observe(document.body, { childList: true, subtree: true });
  });
})();
