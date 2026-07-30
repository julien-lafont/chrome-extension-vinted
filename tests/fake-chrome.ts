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

export type FakeChrome = {
  /** Contenu courant du storage, observable directement par le test. */
  db: FakeStore;
  /** Déclenche les écoutes `onChanged`, comme Chrome le fait pour l'onglet écrivain. */
  listeners: ChangeListener[];
  action: FakeAction;
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
  options: { notify?: boolean; latency?: number } = {}
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
    runtime: {
      getURL: (path: string) => `chrome-extension://test/${path}`,
    },
  };

  // Seul point de contact avec `@types/chrome` : le faux ne couvre que la part
  // de l'API que l'extension utilise réellement.
  (globalThis as { chrome?: unknown }).chrome = fake;

  return { db, listeners, action: recorded };
}

/** À appeler entre deux tests : sans ça, l'état fuit d'un cas au suivant. */
export function uninstallFakeChrome(): void {
  delete (globalThis as { chrome?: unknown }).chrome;
}
