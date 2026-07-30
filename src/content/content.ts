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
import {
  COLLECTIONS_KEY,
  DEFAULT_COLLECTION_ID,
  placeInOrder,
  withDefault,
} from '../shared/collections.ts';
import { errorText } from '../shared/errors.ts';
import { hydrationNumbers, hydrationSellerMap } from '../shared/hydration.ts';
import {
  NOISE_KEY,
  addRule,
  addSeller,
  emptyNoise,
  normalizeNoise,
  pushHidden,
  unhide,
  verdictFor,
} from '../shared/noise.ts';
import type { NoiseFilters } from '../shared/noise.ts';
import { patchNoise } from '../shared/noise-storage.ts';
import {
  NOISE_OVERLAY_SELECTOR,
  closeNoiseMenu,
  hasDismissPanel,
  isNoiseMenuOpen,
  openNoiseMenu,
  renderPill,
  showDismissPanel,
} from './noise-ui.ts';
import type {
  ExtensionMessage,
  OffersScanResponse,
  WatchStartResponse,
} from '../shared/messages.ts';
import { scanOffers } from './offers-scan.ts';
import { photosFromDom, photosFromHydration } from '../shared/photos.ts';
import { ratingFromReputation, sellerCountryFrom } from '../shared/seller.ts';
import { sizeIdFor } from '../shared/size-ids.ts';
import {
  ITEMS_KEY,
  SETTINGS_KEY,
  WATCH_KEY,
  read as readStorage,
  update as updateStorage,
} from '../shared/storage.ts';
import {
  applyCheckResult,
  nextDelay,
  nextThrottle,
  orderForCheck,
  takeDailyBudget,
  takeToken,
  isThrottled,
  RATE,
} from '../shared/watch.ts';
import type { CheckOutcome } from '../shared/watch.ts';
import type {
  CollectionMap,
  ItemCategory,
  ItemMap,
  SavedItem,
  WatchState,
} from '../shared/types.ts';
import {
  OVERLAY_SELECTOR,
  closePicker,
  isPickerOpen,
  openCollectionPicker,
  toast,
} from './collection-picker.ts';
import { readTabDefault, renderDefaultPill, writeTabDefault } from './tab-default.ts';
import { PILLS_SELECTOR } from './ui.ts';
import { showSweepProgress, SWEEP_BAR_SELECTOR, type SweepDisplay } from './watch-ui.ts';
import {
  HYDRATED_KEYS,
  brandIdFromBreadcrumb,
  cardId,
  extractFromCard,
  extractFromDetail,
  extractIdFromUrl,
  formatPrice,
  isDetailPage,
  isSoldDetail,
  parsePriceValue,
  parseTitleFromLabel,
  readBreadcrumbCategory,
  readJsonLd,
  readSeller,
  text,
  titleFromUrl,
} from './extract.ts';

(() => {
  'use strict';

  const BTN_FLAG = 'vfInjected'; // dataset posé sur les cartes déjà traitées

  /** Cache local du contenu du storage : { [id]: item }. */
  let saved: ItemMap = {};

  /**
   * Les collections, lues pour une seule raison : annoncer « Déjà dans Vestes »
   * au survol du marque-page. Quelques centaines d'octets, tenus à jour par le
   * même écouteur `onChanged` que le reste.
   */
  let collections: CollectionMap = {};

  /** Télémétrie de debug, remontée par le diagnostic du panneau latéral. */
  const debug = {
    clicks: 0,
    writes: 0,
    // Gestes d'appui long (ou Alt+clic) qui ont ouvert le choix de collection.
    // Un compteur à zéro alors que l'utilisateur dit avoir appuyé longuement
    // désigne un geste avalé, pas un menu cassé — voir docs/diagnostic.md.
    longPress: 0,
    enriched: 0,
    enrichFailed: 0,
    // Tailles résolues en identifiant de catalogue, et libellés restés sans —
    // catégorie inexacte, table ambiguë, ou API muette. Voir completeSizeId().
    sizesResolved: 0,
    sizesUnresolved: 0,
    // Profils vendeur lus pour en tirer le pays, et lectures restées sans —
    // profil sans localisation exposée, ou requête échouée. Voir
    // completeSellerCountry().
    sellerProfiles: 0,
    sellerProfilesEmpty: 0,
    // Ajouts depuis une carte annulés parce que la fiche s'avère vendue —
    // voir enrichFromDetail() / discardSoldItem().
    soldBlocked: 0,
    // Cartes écartées à la main depuis cette page, et cartes masquées par une
    // règle au dernier scan — voir docs/specs/filtrage-bruit.md.
    dismissed: 0,
    hiddenCards: 0,
    // Conversations détaillées par le balayage des offres, articles dont l'offre
    // en a été modifiée, et raison d'un arrêt anticipé — voir docs/specs/offres.md.
    // `offersRead` à zéro alors qu'une offre existe désigne un scan qui ne part
    // pas (compte non lu, freinage), pas une lecture qui se trompe.
    offersRead: 0,
    offersWritten: 0,
    offersStopped: null as string | null,
    lastError: null as string | null,
  };

  // ---------------------------------------------------------------------------
  // Storage
  // ---------------------------------------------------------------------------

  async function readItems(): Promise<ItemMap> {
    const res = await readStorage(ITEMS_KEY);
    return res[ITEMS_KEY] || {};
  }

  /**
   * Relit-transforme-écrit `savedItems` sans qu'aucune autre écriture de cet
   * onglet ne s'intercale — voir `shared/storage.ts`. Toutes les écritures d'ici
   * passent par là : cette page fait tourner en parallèle la file
   * d'enrichissement, le cycle de suivi et les gestes de l'utilisateur.
   *
   * `mutate` rend la carte à écrire, ou `null` pour renoncer.
   */
  async function updateItems(mutate: (current: ItemMap) => ItemMap | null): Promise<void> {
    await updateStorage([ITEMS_KEY], (stored) => {
      const next = mutate(stored[ITEMS_KEY] || {});
      return next ? { [ITEMS_KEY]: next } : null;
    });
  }

  async function loadSaved(): Promise<void> {
    saved = await readItems();
  }

  /** Ce qu'un geste d'enregistrement a fait, et ce qu'il a écarté au passage. */
  type ToggleResult = {
    action: 'added' | 'removed';
    /**
     * L'article tel qu'il était **avant** un retrait : sa collection, sa date
     * d'ajout, son historique de prix. L'appui long en a besoin pour remettre
     * intact ce que son propre `pointerdown` vient de retirer.
     */
    previous?: SavedItem;
  };

  /**
   * Ajoute ou retire un article. On relit le storage juste avant d'écrire
   * pour ne pas écraser ce qu'un autre onglet Vinted aurait enregistré.
   *
   * @param into collection où ranger l'ajout — celle épinglée sur l'onglet, s'il
   *   y en a une. Le rangement part dans le **même** `set` que l'article :
   *   deux écritures produiraient deux `onChanged`, donc deux rendus du panneau,
   *   dont le premier montrerait un article rangé nulle part.
   */
  async function toggleItem(item: SavedItem, into: string | null = null): Promise<ToggleResult> {
    let result: ToggleResult = { action: 'added' };

    await updateStorage([ITEMS_KEY, COLLECTIONS_KEY], (stored) => {
      const current = stored[ITEMS_KEY] || {};
      const previous = current[item.id];
      const next = { ...current };

      if (previous) {
        delete next[item.id];
        result = { action: 'removed', previous };
        return { [ITEMS_KEY]: next };
      }

      // La collection épinglée a pu être supprimée depuis le panneau pendant que
      // la page était ouverte : on enregistre alors sans elle, plutôt que
      // d'écrire une référence morte. `syncTabDefault()` retirera l'épingle à la
      // notification du storage.
      const collections = withDefault(stored[COLLECTIONS_KEY]);
      const target = into && collections[into] ? into : null;

      next[item.id] = { ...item, savedAt: Date.now(), ...(target ? { collectionId: target } : {}) };
      result = { action: 'added' };

      return target
        ? { [ITEMS_KEY]: next, [COLLECTIONS_KEY]: placeInOrder(collections, item.id, target) }
        : { [ITEMS_KEY]: next };
    });

    return result;
  }

  // ---------------------------------------------------------------------------
  // Collection par défaut de l'onglet
  // ---------------------------------------------------------------------------

  /**
   * La collection épinglée, si elle existe encore.
   *
   * On ne se fie jamais au seul `sessionStorage` : la collection a pu être
   * supprimée depuis le panneau, ou dans un autre onglet, pendant que celui-ci
   * était ouvert.
   */
  function tabDefaultId(): string | null {
    const id = readTabDefault();
    if (!id) return null;
    // Collections pas encore lues (ou lecture échouée) : on n'invente pas leur
    // absence, l'épingle survit jusqu'à ce qu'on sache.
    if (!Object.keys(collections).length) return id;
    return collections[id] ? id : null;
  }

  function tabDefaultName(): string | null {
    const id = tabDefaultId();
    if (!id) return null;
    return collections[id]?.name || (id === DEFAULT_COLLECTION_ID ? 'Mes favoris' : null);
  }

  /** Pose ou retire l'épingle, et met à jour tout ce qui la montre. */
  function setTabDefault(id: string | null): void {
    writeTabDefault(id);
    renderTabDefault();
    // Les boutons annoncent la destination du prochain clic : elle vient de changer.
    repaintAll();

    // Le nom affiché vient du cache des collections, qu'une collection créée à
    // l'instant depuis le menu n'a pas encore atteint — `onChanged` peut arriver
    // après ce clic. On relit, et on réaffiche : les deux rendus sont idempotents.
    void loadCollections().then(() => {
      renderTabDefault();
      repaintAll();
    });
  }

  function renderTabDefault(): void {
    renderDefaultPill(tabDefaultName(), () => {
      setTabDefault(null);
      toast('Enregistrements dans « Mes favoris »');
    });
  }

  /**
   * Efface l'épingle dont la collection a disparu. Appelé à chaque changement de
   * `collections` : le panneau peut supprimer une collection à tout moment, et
   * une pastille qui nomme un tiroir inexistant est pire que pas de pastille.
   */
  function syncTabDefault(): void {
    if (readTabDefault() && !tabDefaultId()) writeTabDefault(null);
    renderTabDefault();
  }

  /**
   * Réécrit un article tel qu'il était, sans toucher au reste du storage.
   *
   * Sert à l'appui long, qui doit défaire le retrait déclenché par son propre
   * `pointerdown` — voir `pickCollectionAfter()`. Ne recrée rien si un autre
   * onglet a réenregistré l'article entre-temps.
   */
  async function restoreItem(item: SavedItem): Promise<void> {
    await updateItems((current) => (current[item.id] ? null : { ...current, [item.id]: item }));
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

  /**
   * Un complément à apporter à un article déjà enregistré.
   *
   * `sizeOnly` distingue les deux provenances : un article venu d'une **carte**
   * a toute sa fiche à lire, un article enregistré **depuis sa fiche** n'a plus
   * qu'à faire résoudre sa taille et lire le profil de son vendeur — voir
   * `completeSizeId()` et `completeSellerCountry()`. Les deux passent par
   * la même file, pour que ces requêtes de fond restent sérialisées entre elles.
   */
  type EnrichJob = { id: string; url: string; sizeOnly?: boolean };

  /** Articles en attente d'enrichissement, traités un par un. */
  const enrichQueue: EnrichJob[] = [];
  let enrichRunning = false;

  /**
   * Le storage porte l'état d'avancement pour que le panneau l'affiche :
   *   pending: true   → fiche en cours de lecture, l'article n'a que les
   *                     données de sa carte
   *   pending absent  → article complet, ou fiche définitivement illisible
   */
  function queueEnrich(id: string, url: string, sizeOnly = false): void {
    if (enrichQueue.some((job) => job.id === id)) return;
    enrichQueue.push({ id, url, sizeOnly });
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
        if (!job.sizeOnly) await enrichFromDetail(job.id, job.url);
        await completeSizeId(job.id);
        // En dernier : c'est la seule étape qui lise une **autre** page que la
        // fiche, et la moins urgente des trois.
        await completeSellerCountry(job.id);
      } catch (err) {
        debug.lastError = `enrichissement ${job.id} : ${errorText(err)}`;
        debug.enrichFailed += 1;
        if (!job.sizeOnly) await finishEnrich(job.id, null);
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

      // La carte ne sait pas qu'un article est vendu — Vinted continue de le
      // lister. L'ajout provisoire posé au clic est donc annulé plutôt que
      // complété, dès que la fiche le révèle.
      if (isSoldDetail(doc)) {
        await discardSoldItem(id);
        debug.soldBlocked += 1;
        return;
      }

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
    await updateItems((current) => {
      const existing = current[id];
      if (!existing) return null;

      const merged = detail ? mergeDetail(existing, detail) : { ...existing };
      delete merged.pending;

      return { ...current, [id]: merged };
    });
  }

  /**
   * Retire un ajout provisoire dont la fiche révèle qu'il est vendu.
   *
   * Le garde-fou `pending` évite de supprimer autre chose qu'un ajout tout
   * juste posé depuis une carte : un article déjà complet ne passe jamais par
   * ici (`enrichFromDetail()` n'est mis en file que pour un ajout fraîchement
   * fait — voir `activate()`), et s'il a disparu du storage entretemps
   * (retiré par l'utilisateur), il n'y a rien à faire.
   */
  async function discardSoldItem(id: string): Promise<void> {
    await updateItems((current) => {
      if (!current[id]?.pending) return null;

      const next = { ...current };
      delete next[id];
      return next;
    });
  }

  /**
   * Complète un article par l'identifiant de sa taille.
   *
   * **Écriture séparée, après celle de la fiche**, et volontairement : la
   * résolution passe par une requête à l'API du site (voir `shared/size-ids.ts`),
   * et l'article ne doit pas rester en attente pour un champ qui ne sert qu'à la
   * recherche d'articles similaires. `pending` est donc déjà levé quand on arrive
   * ici — le panneau affiche l'article complet, la taille exacte le rejoint.
   *
   * Trois cas où l'on ne demande rien :
   *  - l'article a déjà son identifiant, ou n'a pas de taille (accessoires) ;
   *  - sa catégorie n'est pas **exacte** : la table des tailles d'un rayon large
   *    est ambiguë (« M » y vaut vêtement, chapeau ou gant) ;
   *  - il a disparu du storage pendant la requête.
   */
  async function completeSizeId(id: string): Promise<void> {
    const current = await readItems();
    const item = current[id];

    if (!item || item.sizeId || !item.size) return;
    if (!item.category?.exact || !item.category.id) return;

    const sizeId = await sizeIdFor(item.category.id, item.size);
    if (!sizeId) {
      debug.sizesUnresolved += 1;
      return;
    }

    // La requête a laissé le temps à un autre onglet d'écrire, et à l'utilisateur
    // de retirer l'article : l'écriture repart donc de l'état relu, et pas de
    // `item`. C'est aussi pourquoi la requête est faite **hors** de la section
    // critique — elle y retiendrait toutes les autres écritures de l'onglet.
    let written = false;

    await updateItems((current) => {
      const target = current[id];
      if (!target) return null;

      written = true;
      return { ...current, [id]: { ...target, sizeId } };
    });

    if (written) debug.sizesResolved += 1;
  }

  /**
   * Pays des vendeurs déjà consultés pendant la vie de cette page.
   *
   * Chiner, c'est ouvrir cinq pièces du même dressing : sans ce cache, chacune
   * relirait le même profil. Il vit en mémoire et pas en storage — le pays est
   * déjà écrit sur chaque article, et une clé de plus à maintenir (et à purger)
   * ne rachèterait qu'une requête par session.
   *
   * Une entrée peut valoir `null` : profil lu, localisation non exposée. C'est
   * une réponse, pas un échec — on ne la redemande pas.
   */
  const sellerCountries = new Map<string, string | null>();

  /**
   * Lit `/member/{id}` pour en tirer le pays du vendeur.
   *
   * @returns le code ISO, `null` si le profil n'expose pas sa localisation, et
   *   `undefined` si la lecture a échoué — seul cas où l'on réessaiera plus tard
   */
  async function fetchSellerCountry(sellerId: string): Promise<string | null | undefined> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ENRICH_TIMEOUT_MS);

    try {
      const response = await fetch(`https://www.vinted.fr/member/${sellerId}`, {
        credentials: 'include',
        signal: controller.signal,
      });
      if (!response.ok) return undefined;

      const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
      return sellerCountryFrom(doc);
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Complète un article par le pays de son vendeur.
   *
   * **Écriture séparée, après celle de la fiche**, pour la même raison que
   * `completeSizeId()` : c'est une requête de plus, et l'article ne doit pas
   * rester en attente pour une information secondaire. La fiche ne porte le pays
   * nulle part — voir `shared/seller.ts`.
   *
   * **Le pays d'un compte ne change pas** : un article qui a déjà la réponse
   * n'en redemande jamais, `null` compris. Seul `undefined` — profil jamais lu —
   * déclenche la requête, ce qui laisse aussi une seconde chance aux articles
   * dont la lecture avait échoué.
   */
  async function completeSellerCountry(id: string): Promise<void> {
    const current = await readItems();
    const item = current[id];

    if (!item?.sellerId || item.sellerCountry !== undefined) return;
    const sellerId = item.sellerId;

    let country: string | null | undefined;
    if (sellerCountries.has(sellerId)) {
      country = sellerCountries.get(sellerId);
    } else {
      country = await fetchSellerCountry(sellerId);
      if (country === undefined) return; // requête échouée : rien à écrire
      sellerCountries.set(sellerId, country);
    }

    // Même raison qu'à `completeSizeId()` : la requête est faite hors section
    // critique, et l'écriture repart de l'état relu.
    let written = false;

    await updateItems((current) => {
      const target = current[id];
      if (!target) return null;

      written = true;
      return { ...current, [id]: { ...target, sellerCountry: country ?? null } };
    });

    if (!written) return;
    if (country) debug.sellerProfiles += 1;
    else debug.sellerProfilesEmpty += 1;
  }

  // ---------------------------------------------------------------------------
  // Suivi de prix et de disponibilité — docs/specs/suivi-prix.md
  //
  // Le rafraîchissement tourne ici, jamais dans le service worker (§1 de la
  // spec) : cookies de session first-party, Referer cohérent, rien qui signe un
  // automate. Un seul rafraîchisseur à la fois entre plusieurs onglets Vinted,
  // via un bail dans `watch.lease` — voir `acquireOrRenewLease()`.
  // ---------------------------------------------------------------------------

  const LEASE_MS = 60000;

  /**
   * Journal de bord temporaire pour diagnostiquer « je clique sur Rafraîchir
   * et rien ne se passe » : la console de l'onglet Vinted (pas celle du
   * panneau) montre chaque décision du cycle, notamment celles qui ne sont
   * pas des erreurs — bail perdu, débit épuisé, aucun article éligible…
   *
   * Se neutralise en `function watchLog(..._args: unknown[]): void {}` une fois
   * le diagnostic terminé — les points d'appel restent en place pour une
   * réactivation rapide en cas de nouveau bug muet.
   */
  function watchLog(...args: unknown[]): void {
    // eslint-disable-next-line no-console -- journal de diagnostic assumé, pas une erreur
    console.log('[Vinted Favoris][watch]', ...args);
  }

  /**
   * Identifiant de cette instance de content script, pas un vrai id d'onglet
   * Chrome — inaccessible depuis un content script. Il ne sert qu'à distinguer
   * « c'est moi qui tiens le bail » d'un autre onglet, ce qui suffit au bail.
   */
  const instanceId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

  let watchRunning = false;
  let watchCancelled = false;

  function defaultWatch(): WatchState {
    return { lastSweepAt: 0, bucket: { tokens: RATE.capacity, at: Date.now() } };
  }

  async function readWatch(): Promise<WatchState> {
    const res = await readStorage(WATCH_KEY);
    return res[WATCH_KEY] || defaultWatch();
  }

  /**
   * Relit puis réécrit `watch`, sans écriture concurrente possible (règle 6 et
   * `shared/storage.ts`). Le bail et le seau à jetons en dépendent de près : deux
   * `patchWatch()` entrelacés — la boucle du cycle en lance plusieurs par
   * article — rendaient un jeton déjà consommé, ou effaçaient le bail que le
   * précédent venait de poser.
   */
  async function patchWatch(mutate: (current: WatchState) => WatchState): Promise<WatchState> {
    const written = await updateStorage([WATCH_KEY], (stored) => ({
      [WATCH_KEY]: mutate(stored[WATCH_KEY] || defaultWatch()),
    }));
    return written[WATCH_KEY] ?? defaultWatch();
  }

  /**
   * Prend ou renouvelle le bail. Refuse si un autre onglet le tient encore —
   * un bail expiré (onglet fermé en plein cycle) est repris sans condition.
   */
  async function acquireOrRenewLease(now: number): Promise<boolean> {
    let ok = false;
    await patchWatch((current) => {
      if (current.lease && current.lease.until > now && current.lease.tabId !== instanceId) {
        ok = false;
        return current;
      }
      ok = true;
      return { ...current, lease: { tabId: instanceId, until: now + LEASE_MS } };
    });
    return ok;
  }

  async function consumeToken(now: number): Promise<boolean> {
    let ok = false;
    await patchWatch((current) => {
      const result = takeToken(current.bucket, now);
      ok = result.ok;
      return { ...current, bucket: result.bucket };
    });
    return ok;
  }

  async function consumeDailyBudget(now: number): Promise<boolean> {
    let ok = false;
    await patchWatch((current) => {
      const result = takeDailyBudget(current.dailyBudget, now);
      ok = result.ok;
      return ok ? { ...current, dailyBudget: result.budget } : current;
    });
    return ok;
  }

  /** 429, 403, ou challenge : arrêt immédiat et fenêtre de silence — §3.5. */
  async function enterThrottle(): Promise<void> {
    await patchWatch((current) => {
      const strikes = (current.throttleStrikes ?? 0) + 1;
      return {
        ...current,
        throttledUntil: nextThrottle(Date.now(), strikes - 1),
        throttleStrikes: strikes,
      };
    });
  }

  /**
   * Une réponse dont aucune des trois sources qu'on lit par ailleurs (JSON-LD,
   * prix affiché, titre) n'est présente. Deux causes bien différentes, que le
   * contenu ne permet pas de départager :
   *
   * - un challenge (Cloudflare, DataDome) : il faut freiner tout le cycle ;
   * - un article dont Vinted ne sert plus les informations. Sa page affiche
   *   brièvement la fiche puis renvoie vers le dressing du vendeur, redirection
   *   décidée côté client : il n'y a rien à lire dans la réponse. Il faut passer
   *   à l'article suivant.
   *
   * C'est la **répétition** qui tranche, pas le contenu — voir `runWatchQueue()`.
   */
  function looksAnchorless(doc: Document): boolean {
    if (readJsonLd(doc)) return false;
    if (doc.querySelector('[data-testid="item-price"]')) return false;
    if (doc.querySelector('h1')) return false;
    return true;
  }

  type CheckStep = {
    outcome: CheckOutcome;
    /** Signal de freinage sans ambiguïté (429, 403) : arrêt immédiat du cycle. */
    block?: boolean;
    /** Réponse illisible : ne freine que si elle se répète — §3.5. */
    suspect?: boolean;
  };

  /**
   * Vérifie un article suivi. Reprend les mêmes ancres que `enrichFromDetail()`
   * (badge « Vendu », garde-fou d'id divergent) : c'est la même fiche, lue pour
   * un motif différent.
   */
  async function checkOne(item: SavedItem): Promise<CheckStep> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ENRICH_TIMEOUT_MS);

    try {
      const response = await fetch(item.url, { credentials: 'include', signal: controller.signal });

      // Signal de freinage : arrêt du cycle entier, jamais interprété par article.
      if (response.status === 429 || response.status === 403) {
        return { outcome: { kind: 'failure' }, block: true };
      }
      if (response.status === 404 || response.status === 410)
        return { outcome: { kind: 'notFound' } };
      if (!response.ok) return { outcome: { kind: 'failure' } };

      const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
      if (looksAnchorless(doc)) return { outcome: { kind: 'unreadable' }, suspect: true };

      if (isSoldDetail(doc)) return { outcome: { kind: 'sold' } };

      const detail = extractFromDetail(doc, item.url);
      const servedId = detail ? extractIdFromUrl(detail.url) : null;
      if (servedId && servedId !== item.id) return { outcome: { kind: 'idMismatch' } };

      const price = detail?.priceValue ?? parsePriceValue(detail?.price);
      if (!detail || price == null) return { outcome: { kind: 'failure' } };

      // Le texte affiché suit le nombre : sans lui, `.item-price-value` resterait
      // figé sur le prix d'enregistrement même après un changement détecté.
      const priceText = detail.price || formatPrice(price, undefined);

      return { outcome: { kind: 'active', price, priceText } };
    } catch {
      return { outcome: { kind: 'failure' } };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Relit `savedItems` juste avant d'écrire : l'utilisateur a pu retirer l'article entretemps. */
  async function writeCheckResult(id: string, outcome: CheckOutcome, now: number): Promise<void> {
    await updateItems((current) => {
      const item = current[id];
      if (!item) return null;

      const patch = applyCheckResult(item, outcome, now);
      if (Object.keys(patch).length === 0) return null;

      return { ...current, [id]: { ...item, ...patch } };
    });
  }

  const wait = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    });

  /** Battement de cœur pendant une pause : voir `WatchProgress.at`. */
  const PAUSE_HEARTBEAT_MS = 20000;

  /**
   * Au-delà, on rend la main plutôt que de tenir le cycle ouvert
   * indéfiniment. L'utilisateur a fermé l'onglet des yeux depuis un quart
   * d'heure : reprendre ne lui rendrait plus service, et le prochain clic (ou
   * le déclencheur de §5.2) repartira de la file recomposée.
   */
  const PAUSE_GIVE_UP_MS = 15 * 60 * 1000;

  /**
   * Réveille l'attente d'une pause en cours. Armé par {@link waitVisibleOrTimeout},
   * déclenché par `cancelWatch()` : sans lui, une annulation demandée pendant une
   * pause n'était prise en compte qu'au battement suivant — jusqu'à 20 s de
   * bouton qui ne répond pas, exactement le symptôme qu'on corrige.
   */
  let wakePause: (() => void) | null = null;

  /**
   * Attend le retour au premier plan, l'échéance, ou une annulation. Écoute
   * `visibilitychange` plutôt que de sonder : la reprise doit être immédiate,
   * sinon l'utilisateur revient sur l'onglet et croit le cycle mort le temps du
   * prochain sondage.
   */
  function waitVisibleOrTimeout(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = (): void => {
        document.removeEventListener('visibilitychange', done);
        clearTimeout(timer);
        wakePause = null;
        resolve();
      };
      const timer = setTimeout(done, ms);
      document.addEventListener('visibilitychange', done);
      wakePause = done;
    });
  }

  /**
   * §3.6 : l'onglet doit être au premier plan pour émettre. Un onglet caché ne
   * fait plus **abandonner** le cycle, il le **suspend** — c'est ce que dit la
   * spec, et c'est ce qui rend la contrainte supportable : l'utilisateur change
   * d'onglet, revient, et le cycle reprend là où il en était au lieu d'être
   * perdu sans un mot.
   *
   * Le battement de `progress.at` pendant l'attente n'est pas décoratif : c'est
   * lui qui distingue « en pause » de « onglet fermé » pour le panneau
   * (`isSweepStale()`).
   *
   * Le bail n'est **pas** renouvelé pendant la pause, volontairement : il expire
   * au bout d'une minute et un autre onglet Vinted, lui visible, peut reprendre
   * le travail. Un cycle qui dort ne doit pas garder le verrou contre un cycle
   * qui peut tourner.
   *
   * @param display avancement du cycle, pour la pastille et le titre de l'onglet
   *   (`watch-ui.ts`) : c'est en pause qu'on cherche le plus à savoir *quel*
   *   onglet attend, et le storage n'en dit rien à la page.
   * @returns `false` s'il faut arrêter le cycle (annulation, ou attente trop
   *   longue).
   */
  async function awaitForeground(display: SweepDisplay): Promise<boolean> {
    // Par une fonction, et non par la lecture directe : TypeScript réduirait
    // sinon le type de `visibilityState` après le premier test et refuserait le
    // second, alors que la valeur change justement entre les deux.
    const foreground = (): boolean => document.visibilityState === 'visible';
    if (foreground()) return true;

    const pausedAt = Date.now();
    watchLog('pause : onglet passé en arrière-plan (§3.6), attente du retour');

    while (!foreground()) {
      if (watchCancelled) {
        watchLog('arrêt pendant la pause : annulation demandée');
        return false;
      }
      if (Date.now() - pausedAt > PAUSE_GIVE_UP_MS) {
        watchLog('arrêt : onglet resté en arrière-plan trop longtemps');
        return false;
      }

      await patchWatch((w) =>
        w.progress ? { ...w, progress: { ...w.progress, at: Date.now(), paused: true } } : w
      );
      // La pastille et le titre suivent l'état : l'onglet caché qu'on cherche
      // dans la barre d'onglets porte un ⏸, pas un 🔄 qui tournerait pour rien.
      showSweepProgress({ ...display, paused: true });
      await waitVisibleOrTimeout(PAUSE_HEARTBEAT_MS);
    }

    watchLog(`reprise après ${Math.round((Date.now() - pausedAt) / 1000)} s de pause`);
    await patchWatch((w) =>
      w.progress ? { ...w, progress: { ...w.progress, at: Date.now(), paused: false } } : w
    );
    showSweepProgress(display);
    return true;
  }

  /**
   * Cycle de vérification sur les articles donnés. S'arrête — sans backoff — dès
   * que le bail est perdu, le débit ou le budget du jour épuisé, ou une
   * annulation est demandée ; s'arrête avec backoff sur un signal de freinage
   * (§3.5). Un onglet passé en arrière-plan ne l'arrête pas : il le suspend, voir
   * `awaitForeground()`. `lastSweepAt` n'avance que si la file entière a été
   * parcourue — c'est ce qui déclenche §5.2.
   */
  async function runWatchQueue(ids: string[]): Promise<void> {
    const idSet = new Set(ids);
    const candidates = Object.values(saved).filter((item) => idSet.has(item.id));
    const queue = orderForCheck(candidates);
    const total = queue.length;
    const startedAt = Date.now();

    watchLog(
      `file constituée : ${total}/${ids.length} article(s) éligible(s)` +
        (total < ids.length
          ? ' (les autres sont en attente de fiche, déjà vendus, ou déjà disparus)'
          : '')
    );

    if (!total) {
      watchLog('rien à vérifier, cycle terminé immédiatement');
    }

    let done = 0;
    let completed = true;
    let hitBlock = false;
    /** Réponses illisibles consécutives — voir le traitement de `suspect`. */
    let suspects = 0;

    await patchWatch((w) => ({ ...w, progress: { done: 0, total, startedAt, at: startedAt } }));
    // Dès le premier article : c'est cette pastille et ce 🔄 qui désignent
    // l'onglet porteur, et le panneau y renvoie par un lien (§6.10).
    if (total) showSweepProgress({ done: 0, total });

    for (const item of queue) {
      if (watchCancelled) {
        watchLog('arrêt : annulation demandée');
        completed = false;
        break;
      }
      if (!(await awaitForeground({ done, total }))) {
        completed = false;
        break;
      }

      const now = Date.now();

      if (!(await acquireOrRenewLease(now))) {
        watchLog('arrêt : bail perdu au profit d’un autre onglet');
        completed = false;
        break;
      }
      if (!(await consumeDailyBudget(now))) {
        watchLog('arrêt : plafond quotidien de requêtes atteint');
        completed = false;
        break;
      }
      if (!(await consumeToken(now))) {
        watchLog('arrêt : seau à jetons vide, débit déjà consommé');
        completed = false;
        break;
      }

      const fresh = (await readItems())[item.id];
      if (!fresh) {
        watchLog(`article ${item.id} retiré entretemps, ignoré`);
      } else {
        watchLog(`vérification de l’article ${item.id} (${fresh.url})`);
        const step = await checkOne(fresh);
        watchLog(`→ résultat pour ${item.id} :`, step.outcome, step.block ? '(freinage)' : '');

        if (step.block) {
          hitBlock = true;
          completed = false;
          await enterThrottle();
          watchLog('arrêt : signal de freinage (429/403), fenêtre de silence posée');
          break;
        }

        // Une réponse illisible ne dit pas d'elle-même s'il s'agit d'un
        // challenge ou d'un seul article indisponible. Ce qui les sépare : un
        // challenge frappe *toutes* les requêtes, jamais une seule. On ne freine
        // donc qu'à la deuxième d'affilée — le prix de cette prudence est une
        // requête de plus, là où freiner dès la première mettait tout le cycle
        // en sommeil 30 min pour une fiche momentanément indisponible.
        if (step.suspect) {
          suspects += 1;
          if (suspects >= 2) {
            hitBlock = true;
            completed = false;
            await enterThrottle();
            watchLog(
              'arrêt : deux réponses illisibles d’affilée, challenge probable, fenêtre de silence posée'
            );
            break;
          }
          watchLog(`article ${item.id} illisible, passé sans freiner le cycle`);
        } else {
          suspects = 0;
        }

        await writeCheckResult(item.id, step.outcome, Date.now());
      }

      done += 1;
      // Ne recrée jamais un `progress` effacé : le panneau l'efface lui-même en
      // annulant (il ne peut pas attendre le battement d'un onglet en pause), et
      // le rétablir ici ferait clignoter le bouton en « en cours » juste après
      // un clic sur Annuler.
      await patchWatch((w) =>
        w.progress ? { ...w, progress: { done, total, startedAt, at: Date.now() } } : w
      );
      showSweepProgress({ done, total });

      if (done < total) await wait(nextDelay());
    }

    watchLog(
      `cycle terminé : ${done}/${total} vérifiés, ${completed ? 'file entièrement parcourue' : 'interrompu avant la fin'}`
    );

    // La page redevient une page Vinted ordinaire : plus de pastille, plus de
    // marque dans le titre. À faire même si le cycle s'est arrêté en chemin.
    showSweepProgress(null);

    await patchWatch((w) => ({
      ...w,
      ...(completed ? { lastSweepAt: Date.now() } : {}),
      ...(hitBlock ? {} : { throttleStrikes: 0 }),
      progress: undefined,
      // Ne libère que le bail qu'on tient encore soi-même : un autre onglet a
      // pu le reprendre après qu'on l'a perdu plus haut dans la boucle.
      lease: w.lease?.tabId === instanceId ? undefined : w.lease,
    }));
  }

  function cancelWatch(): void {
    watchCancelled = true;
    wakePause?.();
  }

  async function startWatch(ids: string[]): Promise<WatchStartResponse> {
    watchLog(`VF_WATCH_START reçu pour ${ids.length} article(s) :`, ids);

    if (watchRunning) {
      watchLog('refusé : un cycle tourne déjà dans cet onglet');
      return { accepted: false, reason: 'déjà en cours dans cet onglet' };
    }

    const now = Date.now();
    const current = await readWatch();

    if (isThrottled(current, now)) {
      const remaining = Math.round(((current.throttledUntil ?? now) - now) / 60000);
      watchLog(
        `refusé : encore freiné ${remaining} min (throttledUntil = ${current.throttledUntil})`
      );
      return { accepted: false, reason: 'Vinted a limité les requêtes récemment.' };
    }

    if (!(await acquireOrRenewLease(now))) {
      watchLog('refusé : bail déjà tenu par un autre onglet', current.lease);
      return { accepted: false, reason: 'Un autre onglet Vinted rafraîchit déjà.' };
    }

    watchLog('bail acquis, lancement du cycle');
    watchRunning = true;
    watchCancelled = false;
    void runWatchQueue(ids).finally(() => {
      watchRunning = false;
    });

    return { accepted: true };
  }

  // ---------------------------------------------------------------------------
  // Offres en cours — docs/specs/offres.md
  //
  // Le balayage vit dans `offers-scan.ts` ; il n'y a ici qu'un verrou d'onglet.
  // Pas de bail partagé comme le suivi de prix : un second scan lancé depuis un
  // autre onglet ne ferait que relire les mêmes conversations sans rien écrire
  // de faux, là où deux cycles de suivi doublaient le trafic de fiches.
  // ---------------------------------------------------------------------------

  let offersScanRunning = false;

  /**
   * Répond immédiatement et laisse le balayage tourner : comme le cycle de
   * suivi, le résultat se lit dans le storage, jamais dans la réponse au message.
   */
  function startOffersScan(): OffersScanResponse {
    if (offersScanRunning) return { accepted: false, reason: 'déjà en cours dans cet onglet' };

    offersScanRunning = true;
    void scanOffers()
      .then((summary) => {
        debug.offersRead += summary.read;
        debug.offersWritten += summary.written;
        if (summary.stopped) debug.offersStopped = summary.stopped;
      })
      .catch((err: unknown) => {
        debug.lastError = errorText(err);
      })
      .finally(() => {
        offersScanRunning = false;
      });

    return { accepted: true };
  }

  // ---------------------------------------------------------------------------
  // Filtrage du bruit — docs/specs/filtrage-bruit.md
  // ---------------------------------------------------------------------------

  let noise: NoiseFilters = emptyNoise();

  /**
   * Incrémenté à chaque arrivée de nouvelles règles.
   *
   * Sans lui, une carte jugée visible sous les anciennes règles ne serait jamais
   * réévaluée : la garde d'idempotence sortirait avant même de calculer le
   * verdict, et masquer une marque n'aurait d'effet que sur les cartes chargées
   * après coup.
   */
  let noiseRev = 0;

  /** Réglage d'affichage, pas une règle : il vit dans `settings`. */
  let revealHidden = false;
  /** Masque les encarts publicitaires du fil (Braze). Désactivé par défaut. */
  let hideAds = false;

  /**
   * `item_id → seller_id` du flux d'hydratation, calculé une fois par page.
   *
   * Peut légitimement rester vide — voir `hydrationSellerMap()` et §7 de la spec.
   * On ne le recalcule qu'au premier besoin, et jamais sur une fiche : là, le
   * vendeur se lit dans le DOM, proprement.
   */
  let cardSellers: Map<string, string> | null = null;

  function sellerOfCard(id: string): string | null {
    cardSellers ??= hydrationSellerMap(document);
    return cardSellers.get(id) ?? null;
  }

  async function loadNoise(): Promise<void> {
    try {
      const res = await readStorage(NOISE_KEY);
      noise = normalizeNoise(res[NOISE_KEY]);
    } catch (err) {
      // Extension rechargée sans recharger l'onglet : le filtrage se tait plutôt
      // que de faire tomber l'injection des boutons, qui compte davantage.
      debug.lastError = errorText(err);
    }
  }

  async function loadCollections(): Promise<void> {
    try {
      const res = await readStorage(COLLECTIONS_KEY);
      collections = res[COLLECTIONS_KEY] || {};
    } catch (err) {
      debug.lastError = errorText(err);
    }
  }

  /** Les deux seuls réglages du panneau que le content script lise. */
  async function loadDisplaySettings(): Promise<void> {
    try {
      const res = await readStorage(SETTINGS_KEY);
      revealHidden = Boolean(res[SETTINGS_KEY]?.revealHidden);
      hideAds = Boolean(res[SETTINGS_KEY]?.hideAds);
    } catch (err) {
      debug.lastError = errorText(err);
    }
  }

  /**
   * Applique le mode révision. Une **seule** écriture d'attribut, sur `<html>` —
   * un élément que le MutationObserver ne surveille même pas (il observe
   * `document.body`, et sans `attributes`). Révéler 96 cartes coûte donc zéro
   * mutation et zéro scan.
   */
  function applyRevealClass(): void {
    document.documentElement.classList.toggle('vf-reveal', revealHidden);
  }

  /** Même mécanisme que `applyRevealClass()`, pour le réglage « Masquer les pubs ». */
  function applyAdsClass(): void {
    document.documentElement.classList.toggle('vf-hide-ads', hideAds);
  }

  /**
   * L'élément à masquer pour que la grille se referme d'elle-même.
   *
   * La carte (`product-item-id-…`) est enfouie **trois niveaux** sous sa cellule
   * de grille (`grid-item`, ancre documentée dans `docs/vinted-dom.md`). Masquer
   * la carte laissait donc la cellule en place, vide : la grille gardait un trou,
   * et une ligne ne se refermait que lorsque ses quatre cartes étaient masquées.
   * En masquant la cellule, l'auto-placement CSS Grid fait remonter les suivantes
   * sans qu'on ait rien à calculer.
   *
   * On ne remonte que si la cellule ne porte qu'une carte : deux cartes dans la
   * même cellule et l'on emporterait la voisine. Le résultat est mémoïsé — la
   * structure d'une carte ne change pas de sa vie, et `closest()` sur 96 cartes à
   * chaque scan est du travail répété pour rien.
   */
  const GRID_CELL = '[data-testid="grid-item"]';

  const hideTargets = new WeakMap<HTMLElement, HTMLElement>();

  /**
   * Combien de cartes chaque cellule de grille porte, sur les cartes trouvées.
   *
   * Ce comptage se faisait au sélecteur du catalogue, donc ne voyait que les
   * cartes `product-item-id-…` : sur la page d'accueil, dont les cartes
   * s'appellent toutes `feed-item`, la cellule paraissait n'en porter aucune, la
   * garde échouait et c'était la carte qui était masquée — la cellule restait, et
   * son trou avec elle, les suivantes ne remontant pas. On compte donc les cartes
   * réellement trouvées, quelle que soit leur famille de `data-testid`.
   */
  function cellLoad(cards: readonly HTMLElement[]): Map<HTMLElement, number> {
    const load = new Map<HTMLElement, number>();

    for (const card of cards) {
      const cell = card.closest<HTMLElement>(GRID_CELL);
      if (cell) load.set(cell, (load.get(cell) ?? 0) + 1);
    }

    return load;
  }

  function hideTargetOf(box: HTMLElement, load: Map<HTMLElement, number>): HTMLElement {
    const known = hideTargets.get(box);
    if (known) return known;

    const cell = box.closest<HTMLElement>(GRID_CELL);
    const target = cell && load.get(cell) === 1 ? cell : box;

    hideTargets.set(box, target);
    return target;
  }

  // --- Encarts publicitaires du fil -------------------------------------------
  // Réglage indépendant du filtrage du bruit ci-dessus (pas une règle, pas de
  // mode révision) : voir sidepanel.html, bouton « Masquer les pubs ».

  /**
   * Braze est le seul vendeur d'encart vu à ce jour (`feed-braze--promo-box`,
   * signalé sur la page d'accueil) : son nom dans le `data-testid` suffit et ne
   * risque pas de confondre une carte produit, qui n'en porte jamais.
   */
  const AD_SELECTOR = '[data-testid*="braze"]';

  /**
   * Marque la cellule de grille d'un encart, comme `hideTargetOf()` le fait pour
   * une carte écartée — sinon masquer le seul bloc intérieur laisse la cellule
   * vide, et le trou qu'elle creuse dans la grille (même raison qu'au-dessus).
   *
   * Posé à **chaque** scan, que le réglage soit actif ou non : seule
   * `applyAdsClass()` décide de l'affichage, en CSS (`.vf-hide-ads`). Activer ou
   * désactiver le réglage devient ainsi instantané, sans repasser par un scan.
   */
  function markAdBlocks(): void {
    for (const ad of document.querySelectorAll<HTMLElement>(AD_SELECTOR)) {
      const target = ad.closest<HTMLElement>(GRID_CELL) ?? ad;
      if (target.dataset.vfAd !== '1') target.dataset.vfAd = '1';
    }
  }

  /**
   * Pose le verdict de filtrage sur une carte, et rend le compte des masquées.
   *
   * Le masquage passe par un **attribut**, pas par une classe : React réécrit
   * `className` à chaque rendu de la carte et emporterait la nôtre, alors qu'il
   * ne touche pas aux `data-*` qu'il ne connaît pas. C'est aussi le mécanisme le
   * plus économe — les mutations d'attributs ne sont pas observées, donc le
   * masquage ne peut pas boucler (règle 3).
   *
   * La garde compare **l'état réel** à l'état voulu, et pas seulement un drapeau
   * « déjà traité » : si Vinted re-rend une carte et emporte nos attributs, les
   * deux lectures rendent `undefined`, le verdict est reposé, et la carte ne
   * reste pas visible pour toujours sans que rien ne le signale.
   */
  function applyFilters(): void {
    let hiddenCount = 0;

    const cards = cardBoxes();
    const load = cellLoad(cards);

    for (const box of cards) {
      const id = cardId(box);
      if (!id) continue;

      const hideBtn = box.querySelector<HTMLButtonElement>('.vf-hide-btn');
      if (hideBtn) paintHideButton(hideBtn, Boolean(saved[id]), Boolean(noise.hidden[id]));

      // Une carte en cours de repli garde son panneau d'annulation : la masquer
      // tout de suite escamoterait le « Annuler » avant qu'on l'ait lu.
      if (hasDismissPanel(box)) {
        hiddenCount += 1;
        continue;
      }

      const decision = verdictFor(
        {
          id,
          title: cardTitle(box),
          brand: text(box.querySelector('[data-testid$="--description-title"]')),
          sellerId: sellerOfCard(id),
        },
        noise,
        saved
      );

      if (decision.verdict !== '0') hiddenCount += 1;

      const target = hideTargetOf(box, load);
      if (
        target.dataset.vfRev === String(noiseRev) &&
        target.dataset.vfHidden === decision.verdict
      ) {
        continue;
      }

      target.dataset.vfHidden = decision.verdict;
      target.dataset.vfRev = String(noiseRev);

      // Le motif se lit au survol en mode révision. On ne pose le `title` que
      // lorsqu'on masque, et on le retire sinon : écraser celui de Vinted sur
      // une carte visible serait un effet de bord gratuit.
      if (decision.verdict === '0') target.removeAttribute('title');
      else target.title = `Masqué : ${decision.reason}`;
    }

    debug.hiddenCards = hiddenCount;

    // Le basculement est **transitoire et local à la page** : rien n'est écrit en
    // storage. Le réglage durable vit dans le panneau — un « tout afficher »
    // global qu'on oublie d'éteindre donne une extension qui semble avoir perdu
    // ses réglages.
    renderPill(hiddenCount, revealHidden, () => {
      revealHidden = !revealHidden;
      applyRevealClass();
      applyFilters();
    });
  }

  /** Le titre d'une carte, tel que le lit `extractFromCard()`, sans tout ré-extraire. */
  function cardTitle(box: HTMLElement): string {
    const link =
      box.querySelector<HTMLAnchorElement>('[data-testid$="--overlay-link"]') ||
      box.querySelector<HTMLAnchorElement>('a[href*="/items/"]');
    const img =
      box.querySelector<HTMLImageElement>('[data-testid$="--image--img"]') ||
      box.querySelector('img');
    const label = link?.title || img?.alt || '';
    return parseTitleFromLabel(label) || titleFromUrl(link?.href || '');
  }

  /** Écarte un article, et rend de quoi l'annuler. Écriture immédiate. */
  async function dismissItem(id: string, title: string): Promise<void> {
    noise = await patchNoise((current) => pushHidden(current, { id, title, at: Date.now() }));
    noiseRev += 1;
    debug.dismissed += 1;
  }

  async function restoreDismissed(id: string): Promise<void> {
    noise = await patchNoise((current) => unhide(current, id));
    noiseRev += 1;
    applyFilters();
  }

  async function muteBrand(brand: string): Promise<void> {
    noise = await patchNoise((current) => addRule(current, 'brands', brand));
    noiseRev += 1;
    applyFilters();
  }

  async function muteSeller(id: string, name: string): Promise<void> {
    noise = await patchNoise((current) => addSeller(current, id, name));
    noiseRev += 1;
    applyFilters();
  }

  // ---------------------------------------------------------------------------
  // Rendu des boutons
  // ---------------------------------------------------------------------------

  const ICON_OUTLINE =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>';
  const ICON_FILLED =
    '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>';

  /**
   * Le nom de la collection où l'article est rangé, pour l'annoncer au survol.
   *
   * `''` quand l'article n'est pas enregistré, qu'il est dans la collection par
   * défaut (le dire n'apprendrait rien), ou que les collections n'ont pas encore
   * été lues.
   */
  function collectionNameOf(id: string): string {
    const item = saved[id];
    if (!item?.collectionId || item.collectionId === DEFAULT_COLLECTION_ID) return '';
    return collections[item.collectionId]?.name || '';
  }

  function paintButton(btn: HTMLButtonElement, isSaved: boolean): void {
    const isDetail = btn.classList.contains('vf-detail-btn');
    // Un article vendu ne peut pas être ajouté — mais s'il l'était déjà avant
    // de se vendre, il reste consultable et retirable normalement, voir
    // docs/limitations.md.
    const blocked = isDetail && btn.dataset.vfSold === 'true' && !isSaved;

    // Le nom de la collection entre dans la garde ci-dessous : sans lui, le
    // `title` d'un article déplacé d'une collection à l'autre ne se mettrait
    // jamais à jour, et rien ne le signalerait.
    const collection = isSaved && btn.dataset.vfId ? collectionNameOf(btn.dataset.vfId) : '';

    // Où ira le prochain clic, quand l'onglet a une collection épinglée. Comme le
    // nom ci-dessus, il entre dans la garde : sans lui, épingler ne changerait
    // les libellés qu'au prochain repeint provoqué par autre chose.
    const target = (!isSaved && tabDefaultName()) || '';

    // Idempotent, et c'est vital : réécrire innerHTML déclenche le MutationObserver,
    // qui relance un scan, qui repeint… Sans cette garde, la page part en boucle
    // à chaque frame et le bouton devient incliquable (ses enfants sont détruits
    // entre le mousedown et le mouseup, donc aucun événement "click" n'est émis).
    if (
      btn.dataset.vfPainted === '1' &&
      btn.dataset.vfSaved === String(isSaved) &&
      btn.dataset.vfBlocked === String(blocked) &&
      btn.dataset.vfCol === collection &&
      btn.dataset.vfTarget === target
    )
      return;

    btn.dataset.vfSaved = String(isSaved);
    btn.dataset.vfBlocked = String(blocked);
    btn.dataset.vfCol = collection;
    btn.dataset.vfTarget = target;
    btn.dataset.vfPainted = '1';
    btn.disabled = blocked;
    btn.setAttribute('aria-pressed', String(isSaved));

    // « Déjà dans Vestes » : la seule chose que l'icône pleine ne dit pas.
    const where = collection ? `Déjà dans « ${collection} » — ` : '';

    // La destination du clic, annoncée là où la question se pose. La pastille dit
    // qu'un défaut est actif ; le survol du bouton dit ce qu'il va en faire.
    const into = target ? `Enregistrer dans « ${target} »` : 'Enregistrer dans mes favoris';

    if (isDetail) {
      if (blocked) {
        btn.innerHTML = `${ICON_OUTLINE}<span>Article vendu</span>`;
        btn.title = "Cet article est vendu : impossible de l'enregistrer.";
      } else {
        btn.innerHTML =
          (isSaved ? ICON_FILLED : ICON_OUTLINE) +
          `<span>${isSaved ? 'Enregistré' : 'Enregistrer'}</span>`;
        btn.title = isSaved ? `${where}retirer de mes favoris` : into;
      }
    } else {
      btn.innerHTML = isSaved ? ICON_FILLED : ICON_OUTLINE;
      btn.title = isSaved ? `${where}retirer de mes favoris (extension)` : `${into} (extension)`;
    }
    btn.setAttribute('aria-label', btn.title);
  }

  /** Ce qu'un geste sur un bouton a produit, ou `null` si rien n'a été écrit. */
  type Activation = (ToggleResult & { item: SavedItem }) | null;

  /**
   * Durée d'appui qui ouvre le choix de collection.
   *
   * 480 ms : au-dessus du clic le plus lent (~300 ms observés sur un geste
   * appuyé), en dessous du seuil où l'on croit que le bouton ne répond pas.
   * C'est aussi l'ordre de grandeur du `contextmenu` tactile, qu'on neutralise
   * pendant l'appui pour ne pas se disputer le geste avec le navigateur.
   */
  const LONG_PRESS_MS = 480;

  /**
   * Au-delà, le geste est un glissement, pas un appui : on désarme.
   *
   * Indispensable sur les cartes du catalogue — le doigt ou la souris qui
   * démarre un scroll sur le bouton ne doit pas ouvrir un menu à l'arrivée.
   */
  const LONG_PRESS_SLOP_PX = 10;

  /**
   * Ouvre le choix de collection à la suite d'un geste d'enregistrement.
   *
   * L'appui long veut dire « range cet article », jamais « retire-le ». Or son
   * propre `pointerdown` a déjà basculé l'état — c'est la règle 1 du projet, et
   * on n'y touche pas : différer l'écriture jusqu'au seuil rendrait la capture
   * dépendante d'un `pointerup` que le navigateur supprime une fois sur trois.
   * Quand le geste vient donc de **retirer** un article, on le remet tel qu'il
   * était (collection, date d'ajout, historique de prix compris) avant
   * d'ouvrir le menu.
   */
  async function pickCollectionAfter(
    pending: Promise<Activation>,
    btn: HTMLButtonElement
  ): Promise<void> {
    try {
      const result = await pending;
      if (!result) return;

      // `previous` porte les champs que la carte ne connaît pas : c'est lui qui
      // fait foi dès qu'il existe.
      const item = result.previous || result.item;

      if (result.action === 'removed') {
        await restoreItem(item);
        saved = await readItems();
        repaintAll();
      }

      debug.longPress += 1;

      const box = btn.getBoundingClientRect();
      await openCollectionPicker({
        itemId: item.id,
        itemTitle: item.title || '',
        currentCollectionId: item.collectionId || DEFAULT_COLLECTION_ID,
        anchor: { top: box.top, bottom: box.bottom, left: box.left, right: box.right },
        pinnedCollectionId: tabDefaultId(),
        onPin: setTabDefault,
      });
    } catch (err) {
      debug.lastError = errorText(err);
      console.error('[Vinted Favoris] choix de collection échoué :', err);
    }
  }

  /** @param getItem recalcule l'article au moment du clic */
  function createButton(className: string, getItem: () => SavedItem | null): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = className;

    const activate = async (event: Event): Promise<Activation> => {
      // Sur une carte, le bouton est posé au-dessus du lien overlay :
      // sans ça, le clic navigue vers l'article.
      event.preventDefault();
      event.stopPropagation();

      // `disabled` supprime "click", pas "pointerdown" — c'est justement ce
      // dernier qu'on écoute (règle du survol/clic, voir CLAUDE.md). Sans ce
      // garde, le bouton "Article vendu" restait activable à la souris.
      if (btn.disabled) return null;

      debug.clicks += 1;

      try {
        const item = getItem();
        if (!item) {
          debug.lastError = 'extraction vide';
          return null;
        }

        // Une carte n'a pas tout : on l'enregistre telle quelle, marquée en
        // attente, et la fiche complétera. L'écriture est immédiate — le panneau
        // affiche l'article dès le clic, pas au retour de la requête.
        const fromCard = item.source === 'catalog';
        const stored = fromCard ? { ...item, pending: true } : item;
        const result = await toggleItem(stored, tabDefaultId());
        debug.writes += 1;

        // Repeint immédiatement : si le storage échoue silencieusement ou si
        // onChanged ne se déclenche pas, l'utilisateur voit quand même l'état.
        saved = await readItems();
        repaintAll();

        // Depuis une carte : toute la fiche est à lire, la taille suivra.
        // Depuis une fiche : tout est déjà là sauf l'identifiant de taille, que
        // seule l'API du site peut donner — voir completeSizeId().
        if (result.action === 'added') queueEnrich(item.id, item.url, !fromCard);

        // L'article **tel qu'il est en storage**, et non celui qu'on croyait
        // écrire : la collection épinglée sur l'onglet vient peut-être de lui
        // être posée, et l'appui long doit ouvrir son menu dessus.
        return { ...result, item: saved[item.id] || stored };
      } catch (err) {
        // Cas classique : extension rechargée sans recharger l'onglet
        // ("Extension context invalidated") — le clic échoue en silence.
        debug.lastError = errorText(err);
        console.error('[Vinted Favoris] clic échoué :', err);
        return null;
      }
    };

    // --- Appui long -----------------------------------------------------------

    let pressTimer: number | null = null;
    let disarm: (() => void) | null = null;

    function cancelLongPress(): void {
      if (pressTimer !== null) clearTimeout(pressTimer);
      pressTimer = null;
      disarm?.();
      disarm = null;
      btn.classList.remove('vf-pressing');
    }

    function armLongPress(event: PointerEvent | MouseEvent, pending: Promise<Activation>): void {
      cancelLongPress();

      const startX = event.clientX;
      const startY = event.clientY;

      const onMove = (move: PointerEvent | MouseEvent): void => {
        if (Math.abs(move.clientX - startX) + Math.abs(move.clientY - startY) > LONG_PRESS_SLOP_PX)
          cancelLongPress();
      };
      const onEnd = (): void => {
        cancelLongPress();
      };
      // Sur tactile, l'appui long lève un `contextmenu` : c'est exactement notre
      // geste, et le menu natif du navigateur passerait par-dessus le nôtre.
      const onContextMenu = (menu: Event): void => {
        menu.preventDefault();
      };

      // Sur le document, pas sur le bouton : relâcher hors du bouton compte
      // comme une fin de geste, et un repeint peut avoir remplacé les enfants
      // du bouton entre-temps.
      document.addEventListener('pointerup', onEnd, true);
      document.addEventListener('pointercancel', onEnd, true);
      document.addEventListener('pointermove', onMove, true);
      btn.addEventListener('contextmenu', onContextMenu);

      disarm = () => {
        document.removeEventListener('pointerup', onEnd, true);
        document.removeEventListener('pointercancel', onEnd, true);
        document.removeEventListener('pointermove', onMove, true);
        btn.removeEventListener('contextmenu', onContextMenu);
      };

      btn.classList.add('vf-pressing');

      pressTimer = setTimeout(() => {
        cancelLongPress();
        void pickCollectionAfter(pending, btn);
      }, LONG_PRESS_MS) as unknown as number;
    }

    // Le déclencheur souris est "pointerdown", pas "click" : un "click" n'est émis
    // que si le navigateur juge le geste comme tel. Il est supprimé quand une
    // sélection de texte démarre sur le libellé, quand le pointeur glisse un peu,
    // ou quand la cible du mousedown a disparu avant le mouseup. "pointerdown"
    // est inconditionnel.
    // `void` : l'écouteur ne doit rien renvoyer, et personne n'attend l'écriture.
    btn.addEventListener('pointerdown', (event) => {
      // Un menu déjà ouvert se ferme sur ce geste (voir collection-picker) :
      // le bouton ne doit pas en profiter pour basculer l'article.
      if (isPickerOpen()) {
        closePicker();
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      const pending = activate(event);
      void pending;

      // Bouton secondaire : le geste appartient au navigateur (menu contextuel),
      // on n'arme rien dessus.
      if (event.button !== 0 || btn.disabled) return;

      // Alt+clic : même destination que l'appui long, sans l'attente. C'est le
      // chemin clavier-souris pour qui connaît déjà la fonction.
      if (event.altKey) {
        void pickCollectionAfter(pending, btn);
        return;
      }

      armLongPress(event, pending);
    });

    // Le "click" qui suit ce même geste doit être neutralisé sans re-déclencher.
    // MouseEvent.detail vaut 0 pour un click synthétisé par le clavier (Entrée /
    // Espace) et >= 1 pour un clic souris : c'est ce qui distingue les deux.
    btn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.detail !== 0) return;

      // Volontairement non attendu : rien ne dépend de la fin de l'écriture ici.
      const pending = activate(event);
      void pending;

      // Alt+Entrée : le seul accès clavier au choix de collection — un appui
      // long n'existe pas au clavier, la répétition de touche n'en est pas un.
      if (event.altKey) void pickCollectionAfter(pending, btn);
    });

    return btn;
  }

  /**
   * Œil barré : le bouton « Écarter ». Plus petit que le marque-page (28 contre
   * 32 px) et révélé au survol de la carte — le geste fréquent et positif reste
   * le plus gros, et le catalogue reste visuellement calme.
   */
  const ICON_HIDE =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.9 5.1A9.5 9.5 0 0 1 12 4.9c5 0 9 4.6 9 7.1a9 9 0 0 1-2 3.6M6.3 6.7C3.9 8.2 3 10.6 3 12c0 2.5 4 7.1 9 7.1 1.8 0 3.4-.6 4.7-1.4"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/><path d="M3 3l18 18"/></svg>';

  /** Œil ouvert : le même bouton, quand il sert à **remettre** un article écarté. */
  const ICON_SHOW =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12s3.6-7.1 9-7.1 9 7.1 9 7.1-3.6 7.1-9 7.1S3 12 3 12z"/><circle cx="12" cy="12" r="2.6"/></svg>';

  /**
   * Le bouton d'écart d'une carte.
   *
   * Il ne réutilise pas `createButton()` — celui-ci porte tout le protocole
   * d'enregistrement (appui long, choix de collection, enrichissement) qui n'a
   * rien à voir ici. Les règles 1 et 2 sont en revanche reprises telles quelles :
   * `pointerdown` pour la souris, `click` pour le seul clavier.
   */
  function createHideButton(box: HTMLElement, host: HTMLElement): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'vf-hide-btn';
    btn.innerHTML = ICON_HIDE;

    const run = (): void => {
      const id = cardId(box);
      if (!id) return;

      // Un article enregistré n'est jamais masqué : le bouton le dit plutôt que
      // de ne rien faire en silence.
      if (saved[id]) return;

      // Article déjà écarté : le même bouton le remet. C'est le geste inverse au
      // même endroit — utile surtout en mode révision, où les cartes masquées
      // sont à l'écran et où l'on veut en repêcher une sans ouvrir le panneau.
      if (noise.hidden[id]) {
        void restoreDismissed(id);
        return;
      }

      const title = cardTitle(box);
      const brand = text(box.querySelector('[data-testid$="--description-title"]'));
      const sellerId = sellerOfCard(id);

      void dismissItem(id, title).catch((err: unknown) => {
        debug.lastError = errorText(err);
      });

      showDismissPanel({
        card: box,
        host,
        brand,
        // Le pseudo n'est pas lisible depuis une carte : seul l'identifiant l'est.
        seller: sellerId ? { id: sellerId, name: '' } : null,
        onUndo: () => {
          void restoreDismissed(id);
        },
        onExpire: applyFilters,
        onMuteBrand: () => {
          void muteBrand(brand);
        },
        onMuteSeller: () => {
          if (sellerId) void muteSeller(sellerId, '');
        },
      });
    };

    btn.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (btn.disabled) return;
      run();
    });

    btn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.detail === 0 && !btn.disabled) run();
    });

    return btn;
  }

  /**
   * Met à jour le bouton d'écart : inerte sur un article enregistré, inversé sur
   * un article déjà écarté.
   *
   * Idempotent pour la même raison que `paintButton()` — réécrire un attribut
   * sans condition à chaque scan est ce qui fabrique les boucles de repeint. Et
   * comme lui, la garde compare **tous** les états qui décident du rendu : oublier
   * `dismissed` laisserait un œil barré sur une carte qu'un clic remettrait.
   *
   * Un article masqué par une **règle** (marque, mot, vendeur) n'est pas
   * concerné : le bouton ne connaît que l'écart individuel, et une règle se
   * retire depuis le panneau. Le `title` le dit plutôt que de laisser un clic
   * sans effet.
   */
  function paintHideButton(btn: HTMLButtonElement, isSaved: boolean, dismissed: boolean): void {
    if (btn.dataset.vfSaved === String(isSaved) && btn.dataset.vfDismissed === String(dismissed)) {
      return;
    }
    btn.dataset.vfSaved = String(isSaved);
    btn.dataset.vfDismissed = String(dismissed);

    btn.disabled = isSaved;
    btn.innerHTML = dismissed ? ICON_SHOW : ICON_HIDE;

    if (isSaved) btn.title = 'Article enregistré — retire-le de tes favoris pour l’écarter';
    else if (dismissed) btn.title = 'Remettre cet article dans le catalogue';
    else btn.title = 'Écarter cet article du catalogue';

    btn.setAttribute('aria-label', btn.title);
    btn.setAttribute('aria-pressed', String(dismissed));
  }

  function injectCardButton(box: HTMLElement): void {
    const item = extractFromCard(box);
    if (!item) return;

    // Une carte masquée (déjà écartée) est un candidat que Vinted peut recycler
    // pour un autre article sans remplacer son noeud `feed-item` — le repère
    // resterait posé, mais nos boutons pointeraient encore sur l'ancien
    // identifiant : icône d'enregistrement figée, et un clic sauvegarderait
    // l'article affiché à la place de celui qu'on croit viser. Le repère porte
    // donc l'identifiant, pas un simple booléen, pour détecter l'écart.
    if (box.dataset[BTN_FLAG] === item.id) return;
    if (box.dataset[BTN_FLAG]) {
      box.querySelectorAll('.vf-card-btn, .vf-hide-btn').forEach((el) => el.remove());
    }

    // Le bouton doit être ancré dans un parent positionné.
    const host =
      box.querySelector<HTMLElement>('.new-item-box__image-container') ||
      box.querySelector('img')?.closest<HTMLElement>('div') ||
      box;
    if (getComputedStyle(host).position === 'static') {
      host.style.position = 'relative';
    }
    // Cible du survol qui révèle le bouton d'écart : la carte entière, pas le
    // bouton lui-même — un bouton invisible ne peut pas être visé.
    host.classList.add('vf-host');

    box.dataset[BTN_FLAG] = item.id;

    const btn = createButton('vf-card-btn', () => extractFromCard(box));
    btn.dataset.vfId = item.id;
    paintButton(btn, Boolean(saved[item.id]));
    host.appendChild(btn);

    const hide = createHideButton(box, host);
    hide.dataset.vfId = item.id;
    paintHideButton(hide, Boolean(saved[item.id]), Boolean(noise.hidden[item.id]));
    host.appendChild(hide);
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

    const sold = String(isSoldDetail(document));

    // Navigation SPA vers un autre article : on recible le bouton existant.
    if (existing) {
      existing.dataset.vfId = item.id;
      existing.dataset.vfPath = location.pathname;
      existing.dataset.vfSold = sold;
      existing.dataset.vfPainted = ''; // force le repeint pour le nouvel article
      paintButton(existing, Boolean(saved[item.id]));
      return;
    }

    const btn = createButton('vf-detail-btn', extractFromDetail);
    btn.dataset.vfId = item.id;
    btn.dataset.vfPath = location.pathname;
    btn.dataset.vfSold = sold;
    paintButton(btn, Boolean(saved[item.id]));
    document.body.appendChild(btn);
  }

  /**
   * Le bouton d'écart de la fiche : il ouvre un menu au lieu d'agir directement.
   *
   * La fiche est le seul endroit où l'identifiant du vendeur est **certain**
   * (lien `/member/{id}` + `profile-username`), et elle a la place pour trois
   * entrées là où une carte n'en a pas.
   */
  function injectDetailHideButton(): void {
    const existing = document.querySelector<HTMLButtonElement>('.vf-detail-hide');

    if (!isDetailPage()) {
      if (existing) existing.remove();
      return;
    }
    if (existing) return;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'vf-detail-hide';
    btn.innerHTML = ICON_HIDE;
    btn.title = 'Masquer…';
    btn.setAttribute('aria-label', btn.title);

    const run = (): void => {
      // Un menu déjà ouvert se ferme sur ce geste, comme le choix de collection.
      if (isNoiseMenuOpen()) {
        closeNoiseMenu();
        return;
      }

      const item = extractFromDetail();
      if (!item) return;

      const seller = readSeller(document);
      openNoiseMenu({
        anchor: btn.getBoundingClientRect(),
        brand: item.brand || '',
        seller: seller.id ? { id: seller.id, name: seller.name } : null,
        onDismiss: () => {
          void dismissItem(item.id, item.title).then(() => {
            toast('Article écarté du catalogue');
          });
        },
        onMuteBrand: () => {
          void muteBrand(item.brand || '').then(() => {
            toast(`Marque « ${item.brand} » masquée`);
          });
        },
        onMuteSeller: () => {
          if (!seller.id) return;
          void muteSeller(seller.id, seller.name).then(() => {
            toast(`${seller.name || 'Vendeur'} masqué`);
          });
        },
      });
    };

    btn.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      event.stopPropagation();
      run();
    });
    btn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.detail === 0) run();
    });

    document.body.appendChild(btn);
  }

  /** Resynchronise l'état visuel de tous les boutons déjà en place. */
  function repaintAll(): void {
    document.querySelectorAll<HTMLButtonElement>('.vf-card-btn, .vf-detail-btn').forEach((btn) => {
      paintButton(btn, Boolean(btn.dataset.vfId && saved[btn.dataset.vfId]));
    });
    document.querySelectorAll<HTMLButtonElement>('.vf-hide-btn').forEach((btn) => {
      const id = btn.dataset.vfId;
      paintHideButton(btn, Boolean(id && saved[id]), Boolean(id && noise.hidden[id]));
    });
  }

  /** Cartes du catalogue et des pages de recherche. */
  const CATALOG_CARDS = '[data-testid^="product-item-id-"]:not([data-testid*="--"])';

  /**
   * Cartes du fil de la page d'accueil (`https://www.vinted.fr/`).
   *
   * Même markup de carte que le catalogue — `new-item-box__container`, enfants
   * suffixés `--overlay-link`, `--image--img`, `--price-text` — mais un
   * `data-testid` **fixe** : les vingt cartes de la page s'appellent
   * `feed-item`, sans identifiant. Le sélecteur du catalogue ne les voyait donc
   * pas, et l'extension était inerte sur la page d'accueil, qui est pourtant le
   * premier écran d'une session de chine. Voir `cardId()` pour la lecture de
   * l'identifiant.
   */
  const FEED_CARDS = '[data-testid="feed-item"]';

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
    return [
      ...document.querySelectorAll<HTMLElement>(CATALOG_CARDS),
      ...document.querySelectorAll<HTMLElement>(FEED_CARDS),
      ...blockCards(),
    ];
  }

  function scan(): void {
    cardBoxes().forEach((box) => {
      injectCardButton(box);
    });
    injectDetailButton();
    injectDetailHideButton();
    markAdBlocks();

    // Après l'injection : une carte tout juste apparue doit être jugée dans le
    // même passage, sinon elle clignote — visible une frame, masquée la suivante.
    applyFilters();

    // Rendu ici, et pas seulement à l'épinglage : Vinted remplace le corps de la
    // page à certaines navigations, ce qui emporterait la pastille sans qu'aucun
    // événement de l'extension ne le signale. L'appel est idempotent.
    renderTabDefault();
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
        // Les menus sont ancrés à un bouton d'une page qu'on quitte.
        closePicker();
        closeNoiseMenu();

        // Le flux d'hydratation appartient au document servi : après une
        // navigation SPA, il ne décrit plus les cartes affichées. Le garder
        // rattacherait à un article le vendeur d'un autre.
        cardSellers = null;
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
    /**
     * Collection épinglée sur cet onglet — où part un clic court. `null` quand
     * il n'y en a pas. Répond à « pourquoi mes articles atterrissent-ils là ? »
     * sans avoir à ouvrir le storage de session.
     */
    collectionParDefaut: string | null;
    debug: typeof debug;
    sample: SavedItem | null;

    // --- Filtrage du bruit, voir docs/specs/filtrage-bruit.md ---
    regles: Record<string, number>;
    cartesMasquees: number;
    /**
     * Comptage **par motif**. C'est la ligne qui rend une plainte diagnosticable
     * en une seconde : « pourquoi ce truc a disparu ? » se répond par un 20 en
     * face de `brand`. Sans elle, la seule voie est de vider les règles une par
     * une.
     */
    motifs: Record<string, number>;
    /**
     * Taux de résolution du vendeur sur les cartes — la question laissée ouverte
     * par §7 de la spec. `0/48` dit que le flux d'hydratation d'une page de
     * catalogue ne porte pas les vendeurs, et donc que « masquer ce vendeur » ne
     * mord que depuis une fiche.
     */
    vendeursSurCartes: string;

    blocsArticles?: string[];
    blockCardsFound?: number;
    photos?: { flux: number; dom: number };
    identifiants?: Record<string, string | number | null>;
    /** Réputation du vendeur, ses deux sources côte à côte — voir diagnose(). */
    vendeur?: Record<string, string | number | null>;
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
    const load = cellLoad(boxes);
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

    const motifs: Record<string, number> = { item: 0, seller: 0, brand: 0, word: 0 };
    for (const box of boxes) {
      // Le verdict est posé sur la cellule de grille, pas sur la carte — voir
      // hideTargetOf().
      const verdict = hideTargetOf(box, load).dataset.vfHidden;
      if (verdict && verdict !== '0') motifs[verdict] = (motifs[verdict] ?? 0) + 1;
    }

    const sellersResolved = items.filter((item) => sellerOfCard(item.id)).length;

    const report: DiagnoseReport = {
      url: location.href,
      isDetailPage: isDetailPage(),
      cardsFound: boxes.length,
      cardsParsed: items.length,
      cardButtons: document.querySelectorAll('.vf-card-btn').length,
      missing,
      categorie: category || 'aucun fil d’Ariane (recherche par mots-clés ?)',
      savedCount: Object.keys(saved).length,
      collectionParDefaut: tabDefaultName(),
      debug: { ...debug },
      sample: items[0] || null,

      regles: {
        ecartes: Object.keys(noise.hidden).length,
        vendeurs: Object.keys(noise.sellers).length,
        marques: noise.brands.length,
        mots: noise.words.length,
      },
      cartesMasquees: boxes.filter((box) => {
        const verdict = hideTargetOf(box, load).dataset.vfHidden;
        return verdict !== undefined && verdict !== '0';
      }).length,
      motifs,
      vendeursSurCartes: `${sellersResolved}/${items.length}`,
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

    // Marque et vendeur ont chacun deux sources : le DOM rendu côté serveur, et
    // le flux d'hydratation en repli. Les afficher côte à côte dit laquelle des
    // deux a lâché — un `filDAriane: null` avec un `flux` renseigné signale que
    // Vinted a retiré le maillon de marque, pas que l'article n'en a pas.
    const hydrated = detailId ? hydrationNumbers(document, detailId, HYDRATED_KEYS) : {};
    const seller = readSeller(document);
    report.identifiants = {
      marqueFilDAriane: brandIdFromBreadcrumb(document),
      marqueFlux: hydrated.brand_id ?? null,
      vendeurLien: seller.id,
      vendeurFlux: hydrated.seller_id ?? null,
      vendeurPseudo: seller.name || null,
      taille: 'non exposée par Vinted — voir docs/limitations.md',
    };

    // Réputation du vendeur, ses deux sources côte à côte pour la même raison :
    // un flux muet avec un DOM fourni dit que le bloc `user_info_header` a changé
    // de nom, pas que le vendeur n'a pas d'avis. Le pays n'apparaît pas ici : il
    // n'est sur aucune fiche, il vient de `/member/{id}` — voir shared/seller.ts.
    report.vendeur = {
      noteFlux: ratingFromReputation(hydrated.feedback_reputation),
      noteDom: seller.feedback.rating,
      avisFlux: hydrated.feedback_count ?? null,
      avisDom: seller.feedback.count,
      paysLus: `${debug.sellerProfiles} profil(s), ${debug.sellerProfilesEmpty} sans localisation`,
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
      return false;
    }

    // Sonde du panneau : répondre suffit, c'est la réponse elle-même qui prouve
    // qu'un content script à jour est branché sur cet onglet.
    if (message?.type === 'VF_PING') {
      sendResponse({ ok: true });
      return false;
    }

    if (message?.type === 'VF_WATCH_START') {
      void startWatch(message.ids).then(sendResponse);
      return true; // réponse asynchrone : le canal doit rester ouvert
    }

    if (message?.type === 'VF_OFFERS_SCAN') {
      sendResponse(startOffersScan());
      return false;
    }

    if (message?.type === 'VF_WATCH_CANCEL') {
      cancelWatch();
      sendResponse({ accepted: true });
      return false;
    }

    return false;
  });

  // ---------------------------------------------------------------------------
  // Démarrage
  // ---------------------------------------------------------------------------

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;

    const items = changes[ITEMS_KEY];
    if (items) {
      saved = (items.newValue as ItemMap | undefined) || {};
      repaintAll();
      // Un article enregistré n'est plus masqué, et un article retiré des favoris
      // redevient masquable : le verdict dépend de `saved`, il doit être rejoué.
      noiseRev += 1;
      applyFilters();
    }

    // Les règles peuvent venir du panneau, ou d'un autre onglet Vinted. Aucun
    // message n'est échangé : le storage est le seul canal (§1 de la spec).
    // Un article rangé ailleurs change le « Déjà dans… » de son marque-page.
    const cols = changes[COLLECTIONS_KEY];
    if (cols) {
      collections = (cols.newValue as CollectionMap | undefined) || {};
      // Renommée, la collection épinglée change de nom sur la pastille ;
      // supprimée, l'épingle tombe avec elle.
      syncTabDefault();
      repaintAll();
    }

    const rules = changes[NOISE_KEY];
    if (rules) {
      noise = normalizeNoise(rules.newValue as Partial<NoiseFilters> | undefined);
      noiseRev += 1;
      applyFilters();
    }

    const settings = changes[SETTINGS_KEY];
    if (settings) {
      const value = settings.newValue as { revealHidden?: boolean; hideAds?: boolean } | undefined;

      const nextReveal = Boolean(value?.revealHidden);
      if (nextReveal !== revealHidden) {
        revealHidden = nextReveal;
        applyRevealClass();
        applyFilters();
      }

      const nextHideAds = Boolean(value?.hideAds);
      if (nextHideAds !== hideAds) {
        hideAds = nextHideAds;
        applyAdsClass();
      }
    }
  });

  void Promise.all([loadSaved(), loadCollections(), loadNoise(), loadDisplaySettings()]).then(
    () => {
      applyRevealClass();
      applyAdsClass();
      // Avant le scan : les boutons injectés annoncent la collection épinglée,
      // et une épingle posée à la session précédente est déjà en session storage.
      syncTabDefault();
      scan();

      /** Nos propres nœuds : leurs mutations ne doivent jamais relancer un scan. */
      const OWN = `.vf-card-btn, .vf-detail-btn, .vf-hide-btn, .vf-detail-hide, ${OVERLAY_SELECTOR}, ${NOISE_OVERLAY_SELECTOR}, ${SWEEP_BAR_SELECTOR}`;

      /**
       * Le menu de collection et sa confirmation sont posés sur `document.body` :
       * la mutation a alors pour cible le body, que `closest()` ne rattachera
       * jamais à nous. On regarde donc aussi ce qui entre et sort.
       */
      const BODY_OVERLAYS = `${OVERLAY_SELECTOR}, ${PILLS_SELECTOR}, .vf-pill, .vf-noise-menu, .vf-detail-hide, ${SWEEP_BAR_SELECTOR}`;

      const ownNodesOnly = (nodes: NodeList): boolean =>
        [...nodes].every((node) => node instanceof Element && node.matches(BODY_OVERLAYS));

      // Second garde-fou contre la boucle : on ignore les mutations que nos propres
      // boutons génèrent, pour ne réagir qu'aux changements venant de Vinted.
      const observer = new MutationObserver((mutations) => {
        const fromVinted = mutations.some((m) => {
          const target = m.target;
          if (!(target instanceof Element)) return true;
          if (target.closest(OWN)) return false;
          if (m.addedNodes.length && ownNodesOnly(m.addedNodes)) return false;
          if (m.removedNodes.length && ownNodesOnly(m.removedNodes)) return false;
          return true;
        });
        if (fromVinted) scheduleScan();
      });

      observer.observe(document.body, { childList: true, subtree: true });
    }
  );
})();
