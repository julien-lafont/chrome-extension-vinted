/**
 * Faux `chrome.storage.local` (en mémoire, avec la sérialisation du vrai) et
 * faux `chrome.action`, qui se contente d'enregistrer ce qu'on lui demande.
 *
 * Le `structuredClone` n'est pas décoratif : le vrai storage sérialise, donc
 * l'objet relu n'est jamais celui qui a été écrit. Sans clonage, un test peut
 * passer parce qu'il mute par référence un objet que le code croit avoir relu —
 * et masquer un bug de lecture-écriture concurrente.
 *
 * `@types/chrome` décrit l'API complète (quotas, `remove`, `getBytesInUse`…) dont
 * le projet n'utilise que `get` et `set`. Plutôt que d'implémenter le reste ou de
 * parsemer les tests d'assertions de type, la conversion est faite **ici, une
 * fois**, et commentée.
 */

import { resetStorageQueue } from '../src/shared/storage.ts';

export type FakeStore = Record<string, unknown>;

type ChangeListener = (
  changes: Record<string, { oldValue?: unknown; newValue?: unknown }>,
  areaName: string
) => void;

/**
 * Journal de ce qui a été posé sur l'icône de la barre d'outils. Les tableaux
 * gardent l'ordre : c'est lui qui dit si l'icône a bien été rendue *après*
 * l'animation, et non l'inverse.
 */
export type FakeAction = {
  /** Textes de badge successifs ; `''` efface. */
  badgeText: string[];
  badgeColors: string[];
  /** `'path'` = icône d'origine, `'imageData'` = image d'animation. */
  icons: ('path' | 'imageData')[];
};

/**
 * Un onglet du faux navigateur. Le minimum dont l'élection d'onglet a besoin :
 * son URL (est-ce Vinted ?), son état actif et sa fenêtre — c'est exactement le
 * triplet que `chrome.tabs.query` sait filtrer, et celui sur lequel le bouton
 * « Rafraîchir » se trompait.
 */
export type FakeTab = { id: number; url: string; active: boolean; windowId: number };

/** Ce que le faux navigateur a subi, pour que le test l'affirme. */
export type FakeTabs = {
  tabs: FakeTab[];
  /** Messages envoyés aux onglets, dans l'ordre. */
  sent: { tabId: number; message: { type?: string; ids?: string[] } }[];
  /** Onglets créés par l'extension. */
  created: { url?: string; active?: boolean }[];
  /** Onglets activés par l'extension (`chrome.tabs.update`). */
  activated: number[];
  /** Fenêtres remises au premier plan (`chrome.windows.update`). */
  focused: number[];
};

export type FakeChrome = {
  /** Contenu courant du storage, observable directement par le test. */
  db: FakeStore;
  /** Déclenche les écoutes `onChanged`, comme Chrome le fait pour l'onglet écrivain. */
  listeners: ChangeListener[];
  action: FakeAction;
  tabs: FakeTabs;
};

/**
 * Installe le faux `chrome` sur `globalThis` et renvoie de quoi l'inspecter.
 *
 * @param initial état initial du storage, par clé (`savedItems`, `collections`…)
 * @param options `notify: true` propage les écritures aux écoutes `onChanged` —
 *   nécessaire pour tester ce qui réagit aux changements, à éviter sinon.
 */
export function installFakeChrome(
  initial: FakeStore = {},
  options: {
    notify?: boolean;
    latency?: number;
    /** Onglets ouverts au départ. Sans eux, `chrome.tabs.query` ne rend rien. */
    tabs?: FakeTab[];
    /** Fenêtre que `currentWindow: true` doit désigner — celle du panneau. */
    currentWindowId?: number;
    /**
     * Réponse du content script à un message. Lever simule un onglet muet
     * (content script pas injecté), ce que Chrome rend par une erreur.
     */
    respond?: (tabId: number, message: { type?: string }) => unknown;
  } = {}
): FakeChrome {
  // Une file laissée pleine par le cas précédent s'exécuterait sur ce storage-ci.
  resetStorageQueue();

  const db: FakeStore = structuredClone(initial);
  const listeners: ChangeListener[] = [];

  /**
   * Le vrai `chrome.storage` répond de façon asynchrone. Par défaut le faux se
   * contente d'une micro-tâche, ce qui suffit à laisser la boucle d'événements
   * passer la main ; `latency` allonge le délai, seul moyen de faire s'entrelacer
   * deux lectures-écritures de façon déterministe (voir `storage.test.ts`).
   */
  const settle = <T>(value: T): Promise<T> =>
    options.latency
      ? new Promise((resolve) => setTimeout(() => resolve(value), options.latency))
      : Promise.resolve(value);

  const local = {
    get(keys: string | string[]) {
      const list = Array.isArray(keys) ? keys : [keys];
      const out: FakeStore = {};
      for (const key of list) if (key in db) out[key] = structuredClone(db[key]);
      return settle(out);
    },

    set(obj: FakeStore) {
      return settle(undefined).then(() => {
        const changes: Record<string, { oldValue?: unknown; newValue?: unknown }> = {};
        for (const [key, value] of Object.entries(obj)) {
          changes[key] = { oldValue: db[key], newValue: value };
          db[key] = structuredClone(value);
        }
        if (options.notify) listeners.forEach((fn) => fn(changes, 'local'));
      });
    },
  };

  const recorded: FakeAction = { badgeText: [], badgeColors: [], icons: [] };

  const action = {
    setBadgeText({ text }: { text: string }) {
      recorded.badgeText.push(text);
      return Promise.resolve();
    },
    setBadgeBackgroundColor({ color }: { color: string }) {
      recorded.badgeColors.push(color);
      return Promise.resolve();
    },
    setBadgeTextColor() {
      return Promise.resolve();
    },
    setIcon(details: { path?: unknown; imageData?: unknown }) {
      recorded.icons.push(details.imageData ? 'imageData' : 'path');
      return Promise.resolve();
    },
  };

  const recordedTabs: FakeTabs = {
    tabs: options.tabs ? [...options.tabs] : [],
    sent: [],
    created: [],
    activated: [],
    focused: [],
  };

  let nextTabId = Math.max(0, ...recordedTabs.tabs.map((tab) => tab.id)) + 1;

  /**
   * Le seul motif d'URL que l'extension interroge est `https://www.vinted.fr/*`.
   * Un vrai comparateur de motifs serait du code non testé au service des
   * tests ; le préfixe suffit et se lit.
   */
  const matches = (tab: FakeTab, pattern?: string): boolean =>
    !pattern || tab.url.startsWith(pattern.replace(/\*$/, ''));

  const tabs = {
    query(info: { url?: string; active?: boolean; currentWindow?: boolean }) {
      return settle(
        recordedTabs.tabs.filter(
          (tab) =>
            matches(tab, info.url) &&
            (info.active === undefined || tab.active === info.active) &&
            (!info.currentWindow || tab.windowId === (options.currentWindowId ?? 1))
        )
      );
    },

    update(tabId: number, props: { active?: boolean }) {
      const target = recordedTabs.tabs.find((tab) => tab.id === tabId);
      // Chrome lève sur un onglet fermé, et le panneau compte sur cette erreur
      // pour dire que l'onglet porteur a disparu.
      if (!target) return Promise.reject(new Error(`No tab with id: ${tabId}.`));
      if (props.active) {
        recordedTabs.activated.push(tabId);
        // Chrome désactive l'onglet actif de la même fenêtre : sans ça, deux
        // onglets « actifs » cohabiteraient et le test mentirait.
        for (const tab of recordedTabs.tabs) {
          if (tab.windowId === target.windowId) tab.active = tab.id === tabId;
        }
      }
      return settle(target);
    },

    create(props: { url?: string; active?: boolean }) {
      recordedTabs.created.push(props);
      const tab: FakeTab = {
        id: nextTabId,
        url: props.url ?? 'about:blank',
        active: props.active ?? true,
        windowId: options.currentWindowId ?? 1,
      };
      nextTabId += 1;
      recordedTabs.tabs.push(tab);
      return settle(tab);
    },

    sendMessage(tabId: number, message: { type?: string; ids?: string[] }) {
      recordedTabs.sent.push({ tabId, message });
      try {
        return settle(options.respond?.(tabId, message));
      } catch (err) {
        return Promise.reject(err instanceof Error ? err : new Error(String(err)));
      }
    },

    // Le panneau repeint le bouton sur ces événements ; les tests n'ont pas
    // besoin de les déclencher, seulement que l'abonnement ne lève pas.
    onActivated: { addListener() {} },
    onRemoved: { addListener() {} },
    onUpdated: { addListener() {} },
  };

  const windows = {
    update(windowId: number, props: { focused?: boolean }) {
      if (props.focused) recordedTabs.focused.push(windowId);
      return settle({ id: windowId });
    },
  };

  const fake = {
    storage: {
      local,
      onChanged: {
        addListener(fn: ChangeListener) {
          listeners.push(fn);
        },
      },
    },
    action,
    tabs,
    windows,
    runtime: {
      getURL: (path: string) => `chrome-extension://test/${path}`,
    },
  };

  // Seul point de contact avec `@types/chrome` : le faux ne couvre que la part
  // de l'API que l'extension utilise réellement.
  (globalThis as { chrome?: unknown }).chrome = fake;

  return { db, listeners, action: recorded, tabs: recordedTabs };
}

/** À appeler entre deux tests : sans ça, l'état fuit d'un cas au suivant. */
export function uninstallFakeChrome(): void {
  delete (globalThis as { chrome?: unknown }).chrome;
}
