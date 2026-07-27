/**
 * Faux `chrome.storage.local`, en mémoire, avec la sérialisation du vrai.
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

export type FakeStore = Record<string, unknown>;

type ChangeListener = (
  changes: Record<string, { oldValue?: unknown; newValue?: unknown }>,
  areaName: string
) => void;

export type FakeChrome = {
  /** Contenu courant du storage, observable directement par le test. */
  db: FakeStore;
  /** Déclenche les écoutes `onChanged`, comme Chrome le fait pour l'onglet écrivain. */
  listeners: ChangeListener[];
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
  options: { notify?: boolean } = {}
): FakeChrome {
  const db: FakeStore = structuredClone(initial);
  const listeners: ChangeListener[] = [];

  const local = {
    get(keys: string | string[]) {
      const list = Array.isArray(keys) ? keys : [keys];
      const out: FakeStore = {};
      for (const key of list) if (key in db) out[key] = structuredClone(db[key]);
      return Promise.resolve(out);
    },

    set(obj: FakeStore) {
      const changes: Record<string, { oldValue?: unknown; newValue?: unknown }> = {};
      for (const [key, value] of Object.entries(obj)) {
        changes[key] = { oldValue: db[key], newValue: value };
        db[key] = structuredClone(value);
      }
      if (options.notify) listeners.forEach((fn) => fn(changes, 'local'));
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
  };

  // Seul point de contact avec `@types/chrome` : le faux ne couvre que la part
  // de l'API que l'extension utilise réellement.
  (globalThis as { chrome?: unknown }).chrome = fake;

  return { db, listeners };
}

/** À appeler entre deux tests : sans ça, l'état fuit d'un cas au suivant. */
export function uninstallFakeChrome(): void {
  delete (globalThis as { chrome?: unknown }).chrome;
}
