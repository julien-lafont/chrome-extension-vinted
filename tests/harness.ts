/**
 * Charge le content script dans un DOM jsdom bâti sur du markup Vinted réel,
 * avec un faux `chrome` suffisamment fidèle pour que les tests soient concluants.
 *
 * Le détail qui compte : `chrome.storage.onChanged` notifie l'onglet qui vient
 * d'écrire, exactement comme le vrai Chrome. Une première version des tests le
 * stubbait en no-op, ce qui coupait le chaînon déclencheur de la boucle de repeint
 * et produisait un faux négatif — le bug était bien là, le test disait le contraire.
 * Voir docs/pitfalls.md.
 *
 * **Le script testé est le bundle, pas le source.** `content.ts` importe
 * désormais du code partagé : `window.eval()` sur le fichier source échouerait
 * sur son premier `import`. On le passe donc par esbuild, avec exactement les
 * options du build de production — les tests valident ce qui est livré, y compris
 * la mise en IIFE dont dépend la règle 1 du projet.
 */
import * as esbuild from 'esbuild';
import { IIFE_ENTRIES, esbuildOptions } from '../scripts/build-config.ts';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

export const FIXTURES = join(HERE, 'fixtures');

type FixtureMeta = {
  itemUrl: string;
  categoryUrl: string;
  catalogUrl: string;
  photosUrl: string;
  soldUrl: string;
  homeUrl: string;
  memberUrl: string;
} & Record<string, unknown>;

export const meta = JSON.parse(readFileSync(join(FIXTURES, 'meta.json'), 'utf8')) as FixtureMeta;

/**
 * Bundle du content script, construit une fois pour tout le fichier de test.
 * `write: false` garde le résultat en mémoire : aucun `dist/` requis, et les
 * tests ne dépendent pas de l'ordre des scripts npm.
 */
const CONTENT_JS = await (async (): Promise<string> => {
  const contentEntry = IIFE_ENTRIES.filter((entry) => entry.source.endsWith('content.ts'));

  const result = await esbuild.build({
    // Les options du build de production, en mémoire (`write: false`) : aucun
    // `dist/` requis, et les tests ne dépendent pas de l'ordre des scripts npm.
    // `dev: true` évite seulement la minification, qui rendrait les erreurs
    // illisibles sans rien changer au comportement.
    ...esbuildOptions(contentEntry, 'iife', true),
    outdir: undefined,
    write: false,
  });

  const [output] = result.outputFiles;
  if (!output) throw new Error("esbuild n'a produit aucune sortie pour content.ts");
  return output.text;
})();

/** Laisse tourner les rAF/MutationObserver de jsdom avant d'observer le résultat. */
export const settle = (ms = 250): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Une requête de fiche interceptée, que le test résout quand il le décide. */
type FetchCall = {
  url: string;
  resolve: (response: unknown) => void;
  reject: (error: Error) => void;
  settled: boolean;
};

/** Requêtes de fiche émises par toutes les fenêtres du fichier de test. */
const allFetches: FetchCall[] = [];

/**
 * Solde les requêtes de fiche laissées sans réponse. **À appeler en `after()` de
 * chaque fichier de test qui charge le content script :**
 *
 * ```js
 * import { after } from 'node:test';
 * after(settleFetches);
 * ```
 *
 * Le content script pose un délai d'expiration de 15 s sur chaque requête ; tant
 * qu'elle n'a pas abouti, ce timer garde le process de test vivant — la suite
 * passerait de 8 s à plusieurs minutes. Les rejeter laisse le content script
 * suivre son cours normal (il lève l'état d'attente et passe au suivant), là où
 * fermer la fenêtre ferait échouer les rAF et observateurs encore en vol.
 */
export async function settleFetches(): Promise<void> {
  // Solder une requête libère la suivante dans la file : on boucle jusqu'au vide.
  for (let guard = 0; guard < 50; guard += 1) {
    const pending = allFetches.filter((call) => !call.settled);
    if (!pending.length) return;

    for (const call of pending) {
      call.settled = true;
      call.reject(new Error('fin du test'));
    }
    await settle(100);
  }
}

/**
 * Identifiant de l'article de la fixture `item`, dérivé de son URL.
 *
 * Plusieurs tests en ont besoin pour distinguer la fiche affichée des cartes de
 * ses blocs. Lever ici plutôt que d'échouer par un `undefined` diffus : si les
 * fixtures sont re-téléchargées et que l'URL change de forme, le message le dit.
 */
function itemIdOf(url: string, field: string): string {
  const id = url.match(/\/items\/(\d+)/)?.[1];
  if (!id) throw new Error(`meta.${field} ne porte pas d'identifiant : ${url}`);
  return id;
}

export const ITEM_ID: string = itemIdOf(meta.itemUrl, 'itemUrl');

/** Identifiant de la fiche multi-photos — la galerie est indexée par article. */
export const PHOTOS_ITEM_ID: string = itemIdOf(meta.photosUrl, 'photosUrl');

/**
 * Identifiant de la fiche vendue — voir `docs/specs/suivi-prix.md` §8. Égal à
 * `ITEM_ID` par coïncidence de calendrier : l'article épinglé pour `item.html`
 * s'est vendu entre deux rafraîchissements des fixtures. Les deux fixtures
 * restent indépendantes (deux fichiers distincts), ce n'est qu'un id partagé.
 */
export const SOLD_ITEM_ID: string = itemIdOf(meta.soldUrl, 'soldUrl');

/** Nom d'une fixture de markup Vinted présente dans `tests/fixtures/`. */
export type Fixture = 'catalog' | 'item' | 'category' | 'item-photos' | 'sold' | 'home' | 'member';

/** L'URL compte : elle décide de la page détail, et du contexte de catégorie. */
const URLS: Record<Fixture, () => string> = {
  item: () => meta.itemUrl,
  category: () => meta.categoryUrl,
  catalog: () => meta.catalogUrl,
  // Une fiche comme une autre pour l'extraction — sa seule particularité est de
  // porter plusieurs photos, ce que `itemUrl` ne garantit pas.
  'item-photos': () => meta.photosUrl,
  // Une fiche vendue, sans JSON-LD (Vinted le retire) : exerce isSoldDetail()
  // et le repli d'extractFromDetail() en même temps.
  sold: () => meta.soldUrl,
  // La page d'accueil : mêmes cartes que le catalogue, mais un `data-testid`
  // fixe et sans identifiant — voir cardId().
  home: () => meta.homeUrl,
  // Le profil du vendeur de la fiche. L'extension ne s'y injecte jamais : elle
  // ne le lit que par `fetch()`, pour le pays. Il n'est donc jamais chargé comme
  // page courante, seulement servi par `respondWithFixture('member')`.
  member: () => meta.memberUrl,
};

/**
 * Storage partagé entre plusieurs instances du content script — simule
 * plusieurs onglets Vinted pointant sur le même `chrome.storage.local`.
 * `watch-lease.test.ts` en a besoin : le bail n'a de sens qu'entre deux
 * instances qui voient réellement la même écriture.
 */
export type SharedBackend = {
  store: Record<string, unknown>;
  listeners: ((changes: unknown, area: string) => void)[];
};

export function createSharedBackend(saved: Record<string, unknown> = {}): SharedBackend {
  return { store: { savedItems: { ...saved } }, listeners: [] };
}

/** Ce qu'un test lit d'une collection rangée en storage. */
type StoredCollection = { id: string; name: string; createdAt: number; order: string[] };

/** Clé du storage de session où vit la collection par défaut de l'onglet. */
const TAB_DEFAULT_KEY = 'vf:defaultCollection';

/**
 * @param options état initial du storage, backend partagé entre plusieurs
 *   instances, ou collection déjà épinglée sur l'onglet — ce que voit un content
 *   script qui démarre dans un onglet où l'épinglage a été fait avant un
 *   rechargement de page.
 */
export async function loadContentScript(
  fixture: Fixture,
  options: { saved?: Record<string, unknown>; shared?: SharedBackend; tabDefault?: string } = {}
) {
  const url = (URLS[fixture] || URLS.catalog)();

  const dom = new JSDOM(readFileSync(join(FIXTURES, `${fixture}.html`), 'utf8'), {
    url,
    pretendToBeVisual: true, // requestAnimationFrame, utilisé par scheduleScan()
    runScripts: 'outside-only',
  });

  // jsdom expose un `Window` que l'on complète (chrome, fetch) : le type DOM ne
  // décrit ni l'un ni l'autre, et les tests manipulent ces ajouts librement.
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const window = dom.window as any;

  const backend: SharedBackend =
    options.shared ?? createSharedBackend(options.saved ? { ...options.saved } : {});
  const store = backend.store;
  const changeListeners = backend.listeners;
  let messageListener:
    ((message: unknown, sender: unknown, respond: (r: unknown) => void) => void) | null = null;

  // L'enrichissement d'une carte va lire sa fiche par fetch. Les requêtes ne se
  // résolvent pas d'elles-mêmes : c'est le test qui décide quand la fiche
  // répond, ce qui permet d'observer l'état intermédiaire — l'article affiché
  // dès le clic, avant que la fiche n'arrive.
  const fetches: FetchCall[] = [];

  window.fetch = (url: string, init: { signal?: AbortSignal } = {}) =>
    new Promise((resolve, reject) => {
      const call: FetchCall = { url, resolve, reject, settled: false };
      fetches.push(call);
      allFetches.push(call);

      // AbortController réel : le content script pose un timeout dessus.
      if (init.signal) {
        init.signal.addEventListener('abort', () => {
          call.settled = true;
          reject(new Error('AbortError'));
        });
      }
    });

  window.chrome = {
    storage: {
      local: {
        get: (key: string | string[]) => {
          const keys = Array.isArray(key) ? key : [key];
          return Promise.resolve(Object.fromEntries(keys.map((k) => [k, store[k]])));
        },
        set: (obj: Record<string, unknown>) => {
          const changes: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(obj)) {
            changes[k] = { oldValue: store[k], newValue: v };
            store[k] = v;
          }
          changeListeners.forEach((fn) => fn(changes, 'local'));
        },
      },
      onChanged: {
        addListener: (fn: (changes: unknown, area: string) => void) => changeListeners.push(fn),
      },
    },
    runtime: {
      onMessage: {
        addListener: (fn: typeof messageListener) => {
          messageListener = fn;
        },
      },
    },
  };

  // Chaque JSDOM a son propre `sessionStorage`, comme deux onglets ont le leur :
  // c'est ce qui rend testable la portée « cet onglet seulement ».
  if (options.tabDefault) window.sessionStorage.setItem(TAB_DEFAULT_KEY, options.tabDefault);

  window.eval(CONTENT_JS);
  await settle(300); // le script démarre sur loadSaved().then()

  return {
    window,
    document: window.document,
    store,

    /** Articles actuellement enregistrés. */
    saved: () => Object.values(store.savedItems || {}),
    savedCount: () => Object.keys(store.savedItems || {}).length,

    /** État du cycle de rafraîchissement — clé `watch` du storage. */
    watchState: (): any => store.watch,

    /** Envoie VF_WATCH_START comme le ferait le panneau, et attend la réponse. */
    startWatch: (ids: string[]): Promise<any> =>
      new Promise((resolve) => {
        messageListener?.({ type: 'VF_WATCH_START', ids }, null, resolve);
      }),

    /** Envoie VF_WATCH_CANCEL. Ne fait qu'armer le drapeau : pas de garantie d'arrêt immédiat. */
    cancelWatch: (): Promise<any> =>
      new Promise((resolve) => {
        messageListener?.({ type: 'VF_WATCH_CANCEL' }, null, resolve);
      }),

    /** Rapport du bouton Diagnostic du panneau latéral. */
    diagnose: (): Promise<any> =>
      new Promise((resolve) => {
        messageListener?.({ type: 'VF_DIAGNOSE' }, null, resolve);
      }),

    cardButtons: (): any[] => [...window.document.querySelectorAll('.vf-card-btn')],
    detailButton: (): any => window.document.querySelector('.vf-detail-btn'),

    // --- Filtrage du bruit (docs/specs/filtrage-bruit.md) ---

    /**
     * Écrit en storage **comme le ferait le panneau** : par `set`, donc en
     * notifiant les onglets. Poser directement `store.x = …` ne déclenche aucun
     * `onChanged`, et le content script ne verrait jamais le changement — c'est
     * précisément le chaînon que ces tests doivent exercer.
     */
    async write(obj: Record<string, unknown>) {
      window.chrome.storage.local.set(obj);
      await settle(250);
    },

    /** Range un jeu de règles complet et laisse le content script l'appliquer. */
    async setNoise(patch: Record<string, unknown>) {
      await this.write({
        noise: { hidden: {}, recent: [], sellers: {}, brands: [], words: [], ...patch },
      });
    },

    /** Règles de filtrage rangées en storage. */
    noise: (): any => store.noise,

    hideButtons: (): any[] => [...window.document.querySelectorAll('.vf-hide-btn')],

    /** Le bouton d'écart de la carte portant cet identifiant d'article. */
    hideButtonOf(id: string): any {
      return window.document.querySelector(`.vf-hide-btn[data-vf-id="${id}"]`);
    },

    /**
     * L'élément qui porte le verdict de filtrage pour cet article.
     *
     * Ce n'est **pas** la carte : le verdict est posé sur sa cellule de grille,
     * pour que la grille se referme au lieu de garder un trou (`hideTargetOf()`).
     * On part donc de la carte et on remonte au premier ancêtre jugé.
     */
    cardBox(id: string): any {
      const card = [...window.document.querySelectorAll('[data-testid]')].find(
        (el: any) => el.dataset.testid.endsWith(`-${id}`) && !el.dataset.testid.includes('--')
      );
      return card?.closest('[data-vf-hidden]') ?? card;
    },

    /** Verdict posé sur chaque carte : `'0'` quand elle reste visible. */
    verdicts: (): string[] =>
      [...window.document.querySelectorAll('[data-vf-hidden]')].map(
        (el: any) => el.dataset.vfHidden
      ),

    /** Cartes effectivement masquées, quel qu'en soit le motif. */
    hiddenCards: (): any[] => [
      ...window.document.querySelectorAll('[data-vf-hidden]:not([data-vf-hidden="0"])'),
    ],

    /** Panneau d'annulation, s'il est affiché. */
    undoPanel: (): any => window.document.querySelector('.vf-undo'),

    /** Phrases complètes des règles proposées par le panneau d'annulation. */
    undoRules: (): string[] =>
      [...window.document.querySelectorAll('.vf-undo-rule-row')].map((el: any) => el.textContent),

    /** Le lien d'une règle du panneau d'annulation, par son libellé exact. */
    undoRule(label: string): any {
      return [...window.document.querySelectorAll('.vf-undo-rule')].find(
        (el: any) => el.textContent === label
      );
    },

    undoCancel: (): any => window.document.querySelector('.vf-undo-cancel'),

    /** Pastille de comptage : son texte, ou `null` si elle n'est pas affichée. */
    pillText: (): string | null =>
      window.document.querySelector('.vf-pill-count')?.textContent ?? null,

    pillToggle: (): any => window.document.querySelector('.vf-pill-toggle'),

    /** Le bouton d'écart de la fiche, et son menu. */
    detailHideButton: (): any => window.document.querySelector('.vf-detail-hide'),
    noiseMenuLabels: (): string[] =>
      [...window.document.querySelectorAll('.vf-noise-item')].map((el: any) => el.textContent),

    // --- Choix de collection (appui long) ---

    /** Collections rangées en storage — écrites par le panneau comme par la page. */
    collections: (): Record<string, StoredCollection> =>
      (store.collections as Record<string, StoredCollection>) || {},

    /** Le menu de choix de collection, s'il est ouvert. */
    picker: (): any => window.document.querySelector('.vf-picker'),

    /** Libellés des collections proposées par le menu, dans l'ordre affiché. */
    pickerLabels: (): string[] =>
      [...window.document.querySelectorAll('.vf-picker-item')].map((el: any) => el.textContent),

    /** L'entrée du menu portant ce libellé exact. */
    pickerItem(name: string): any {
      return [...window.document.querySelectorAll('.vf-picker-item')].find(
        (el: any) => el.textContent === name
      );
    },

    /** Confirmation affichée après un rangement. */
    toastText: (): string | null => window.document.querySelector('.vf-toast')?.textContent ?? null,

    // --- Collection par défaut de l'onglet (épingle du menu) ---

    /** L'épingle de la ligne portant ce libellé : « ranger ici et en faire le défaut ». */
    pickerPin(name: string): any {
      return this.pickerItem(name)?.closest('.vf-picker-row')?.querySelector('.vf-picker-pin');
    },

    /** L'épingle du formulaire de création : créer, ranger et épingler d'un geste. */
    pickerPinNew: (): any => window.document.querySelector('.vf-picker-new .vf-picker-pin'),

    /** Pastille de la collection épinglée — son libellé, ou `null` si elle est absente. */
    defaultPillText: (): string | null =>
      window.document.querySelector('.vf-pill-default .vf-pill-label')?.textContent ?? null,

    /** Le « ✕ » qui retire l'épingle. */
    defaultPillClear: (): any => window.document.querySelector('.vf-pill-clear'),

    /** Collection épinglée telle qu'elle est rangée, du point de vue de cet onglet. */
    tabDefault: (): string | null => window.sessionStorage.getItem(TAB_DEFAULT_KEY),

    /** Les pastilles affichées, dans l'ordre du DOM — elles partagent une pile. */
    pills: (): any[] => [...window.document.querySelectorAll('.vf-pills > .vf-pill')],

    /**
     * Appui maintenu au-delà du seuil, puis relâché — le geste qui doit ouvrir
     * le choix de collection. Le `click` qui suit est émis comme le ferait le
     * navigateur : il ne doit pas re-basculer l'article.
     */
    async pressLong(el: any, ms = 700) {
      el.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, detail: 1 }));
      await settle(ms);
      window.document.dispatchEvent(new window.MouseEvent('pointerup', { bubbles: true }));
      el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, detail: 1 }));
      await settle(200);
    },

    /**
     * Appui qui glisse avant le seuil : un scroll démarré sur le bouton, pas un
     * appui long.
     */
    async pressAndDrag(el: any, distance = 40) {
      el.dispatchEvent(
        new window.MouseEvent('pointerdown', { bubbles: true, detail: 1, clientX: 0, clientY: 0 })
      );
      await settle(120);
      window.document.dispatchEvent(
        new window.MouseEvent('pointermove', { bubbles: true, clientX: 0, clientY: distance })
      );
      await settle(600);
      window.document.dispatchEvent(new window.MouseEvent('pointerup', { bubbles: true }));
      await settle(150);
    },

    /** Alt+clic : le raccourci immédiat vers le même menu. */
    async altClick(el: any) {
      el.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, altKey: true }));
      el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, detail: 1, altKey: true }));
      await settle(200);
    },

    /** Active une entrée du menu à la souris (pointerdown + click, comme le navigateur). */
    async choose(el: any) {
      el.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, detail: 1 }));
      el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, detail: 1 }));
      await settle(200);
    },

    /** Échappe : ferme le menu. */
    async pressEscape() {
      window.document.dispatchEvent(
        new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
      );
      await settle(100);
    },

    // --- Enrichissement d'une carte par sa fiche ---

    /** Requêtes de fiche parties et pas encore honorées. */
    pendingFetches: () => fetches.filter((call) => !call.settled),

    /** Répond à la plus ancienne requête en attente avec le HTML d'une fixture. */
    async respondWithFixture(fixture: Fixture = 'item') {
      const html = readFileSync(join(FIXTURES, `${fixture}.html`), 'utf8');
      return this.respond({ ok: true, status: 200, text: () => Promise.resolve(html) });
    },

    /**
     * Répond à la plus ancienne requête en attente avec du JSON — la table des
     * tailles de `shared/size-ids.ts`, seul appel d'API du projet.
     */
    async respondJson(body: unknown) {
      return this.respond({ ok: true, status: 200, json: () => Promise.resolve(body) });
    },

    /** Répond avec une réponse arbitraire (statut d'erreur, corps illisible…). */
    async respond(response: unknown) {
      const call = fetches.find((c) => !c.settled);
      if (!call) throw new Error('aucune requête de fiche en attente');

      call.settled = true;
      call.resolve(response);
      await settle(200);
      return call;
    },

    /** Fait échouer la requête, comme une coupure réseau. */
    async failFetch(message = 'network error') {
      const call = fetches.find((c) => !c.settled);
      if (!call) throw new Error('aucune requête de fiche en attente');

      call.settled = true;
      call.reject(new Error(message));
      await settle(200);
      return call;
    },

    /**
     * Bouton de la première carte dont le libellé d'accessibilité satisfait `test`.
     *
     * Les cas limites de l'extraction (article sans taille, sans marque) ne se
     * repèrent qu'à ce libellé, et la fixture en contient un exemplaire de chacun
     * — voir `pickCards()` dans tools/refresh-fixtures.mjs.
     */
    cardButtonWhere(test: (label: string) => boolean): any {
      // On part du lien plutôt que de la carte : son testid est celui de la
      // carte suffixé, ce qui évite d'avoir à connaître le préfixe — le
      // catalogue et les blocs d'une fiche n'ont pas le même.
      const link = [...window.document.querySelectorAll('[data-testid$="--overlay-link"]')].find(
        (a: any) => test(a.getAttribute('title') || '')
      );
      if (!link) return null;

      const base = link.dataset.testid.replace(/--overlay-link$/, '');
      return window.document.querySelector(`[data-testid="${base}"] .vf-card-btn`);
    },

    // Les gestes sont attendables : l'écriture en storage est asynchrone, et le
    // rapport de diagnostic répond lui de façon synchrone — l'attendre n'attend
    // donc rien. `await page.clickMouse(...)` évite ce piège à l'appelant.

    /**
     * Geste souris complet : pointerdown puis click. Un vrai clic souris porte
     * `detail >= 1` ; c'est ce qui le distingue d'une activation clavier.
     */
    async clickMouse(el: any) {
      el.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true }));
      el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, detail: 1 }));
      await settle(150);
    },

    /**
     * Appui dont le navigateur a supprimé le `click` — sélection de texte
     * démarrée, pointeur qui glisse, cible disparue avant le mouseup.
     */
    async pressOnly(el: any) {
      el.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true }));
      el.dispatchEvent(new window.MouseEvent('pointerup', { bubbles: true }));
      await settle(150);
    },

    /** Entrée / Espace sur un bouton focus : un `click` seul, avec `detail === 0`. */
    async pressKey(el: any) {
      el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await settle(150);
    },

    /**
     * Fait arriver un bloc d'articles de fiche — « Dressing du membre »,
     * « Articles similaires » — comme Vinted le fait : après le rendu initial,
     * une fois le bloc approché du viewport.
     *
     * Ce markup ne peut pas venir d'une fixture : la page servie ne contient
     * qu'un squelette, les articles sont chargés par requête et n'existent que
     * dans le DOM hydraté. Les cartes sont donc celles de `catalog.html` —
     * authentiques — avec pour seule retouche le préfixe de leur `data-testid`,
     * qui est exactement ce que Vinted change : la carte reçoit le nom du plugin
     * en guise d'`itemTestId` au lieu du `product-item-id` par défaut.
     *
     * @param {string} [plugin] nom du bloc, tel qu'il apparaît dans
     *   `item-page-{plugin}-plugin`
     * @param {boolean} [wrapped] enveloppe les cartes dans le conteneur
     *   `{plugin}-items` que Vinted interpose. Ce conteneur porte un `data-testid`
     *   du même préfixe **sans identifiant**, et il *contient* des liens
     *   d'article : c'est exactement ce qu'un repli d'identifiant trop permissif
     *   prendrait pour une carte. Sans lui, le garde-fou de `cardId()` n'est pas
     *   exercé et le test correspondant ne peut pas échouer.
     */
    async appendItemBlock(plugin = 'other_user_items', count = 3, wrapped = false) {
      const catalog = new JSDOM(readFileSync(join(FIXTURES, 'catalog.html'), 'utf8'));
      const cards = [
        ...catalog.window.document.querySelectorAll(
          '[data-testid^="product-item-id-"]:not([data-testid*="--"])'
        ),
      ].slice(0, count);

      const block = window.document.createElement('div');
      block.setAttribute('data-testid', `item-page-${plugin}-plugin`);

      const markup = cards
        .map((card) => card.outerHTML.split('product-item-id-').join(`${plugin}-`))
        .join('\n');

      block.innerHTML = wrapped ? `<div data-testid="${plugin}-items">\n${markup}\n</div>` : markup;

      window.document.body.appendChild(block);
      await settle(150); // le MutationObserver doit voir le bloc et repeindre
      return block;
    },

    /** Compte les remplacements d'enfants d'un élément — révèle une boucle de repeint. */
    watchChurn(el: any): () => number {
      let count = 0;
      const observer = new window.MutationObserver((mutations: any[]) => {
        for (const m of mutations) if (m.type === 'childList') count += 1;
      });
      observer.observe(el, { childList: true, subtree: true });
      return () => count;
    },
  };
  /* eslint-enable @typescript-eslint/no-explicit-any */
}
