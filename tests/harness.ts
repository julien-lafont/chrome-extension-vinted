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

type FixtureMeta = { itemUrl: string; categoryUrl: string; catalogUrl: string } & Record<
  string,
  unknown
>;

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
export const ITEM_ID: string = (() => {
  const id = meta.itemUrl.match(/\/items\/(\d+)/)?.[1];
  if (!id) throw new Error(`meta.itemUrl ne porte pas d'identifiant : ${meta.itemUrl}`);
  return id;
})();

/** Nom d'une fixture de markup Vinted présente dans `tests/fixtures/`. */
export type Fixture = 'catalog' | 'item' | 'category';

/** L'URL compte : elle décide de la page détail, et du contexte de catégorie. */
const URLS: Record<Fixture, () => string> = {
  item: () => meta.itemUrl,
  category: () => meta.categoryUrl,
  catalog: () => meta.catalogUrl,
};

/** @param options état initial du storage */
export async function loadContentScript(
  fixture: Fixture,
  options: { saved?: Record<string, unknown> } = {}
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

  const store: Record<string, unknown> = options.saved ? { savedItems: { ...options.saved } } : {};
  const changeListeners: ((changes: unknown, area: string) => void)[] = [];
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

  window.eval(CONTENT_JS);
  await settle(300); // le script démarre sur loadSaved().then()

  return {
    window,
    document: window.document,
    store,

    /** Articles actuellement enregistrés. */
    saved: () => Object.values(store.savedItems || {}),
    savedCount: () => Object.keys(store.savedItems || {}).length,

    /** Rapport du bouton Diagnostic du panneau latéral. */
    diagnose: (): Promise<any> =>
      new Promise((resolve) => {
        messageListener?.({ type: 'VF_DIAGNOSE' }, null, resolve);
      }),

    cardButtons: (): any[] => [...window.document.querySelectorAll('.vf-card-btn')],
    detailButton: (): any => window.document.querySelector('.vf-detail-btn'),

    // --- Enrichissement d'une carte par sa fiche ---

    /** Requêtes de fiche parties et pas encore honorées. */
    pendingFetches: () => fetches.filter((call) => !call.settled),

    /** Répond à la plus ancienne requête en attente avec le HTML d'une fixture. */
    async respondWithFixture(fixture: Fixture = 'item') {
      const html = readFileSync(join(FIXTURES, `${fixture}.html`), 'utf8');
      return this.respond({ ok: true, status: 200, text: () => Promise.resolve(html) });
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
     */
    async appendItemBlock(plugin = 'other_user_items', count = 3) {
      const catalog = new JSDOM(readFileSync(join(FIXTURES, 'catalog.html'), 'utf8'));
      const cards = [
        ...catalog.window.document.querySelectorAll(
          '[data-testid^="product-item-id-"]:not([data-testid*="--"])'
        ),
      ].slice(0, count);

      const block = window.document.createElement('div');
      block.setAttribute('data-testid', `item-page-${plugin}-plugin`);
      block.innerHTML = cards
        .map((card) => card.outerHTML.split('product-item-id-').join(`${plugin}-`))
        .join('\n');

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
