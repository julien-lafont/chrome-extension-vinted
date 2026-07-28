/**
 * Vinted Favoris — la modale « Filtres du catalogue ».
 *
 * L'écran de gestion des règles écrites depuis les pages Vinted : marques et
 * mots exclus, vendeurs masqués, articles écartés. Voir
 * `docs/specs/filtrage-bruit.md` §5.
 *
 * Le module ne connaît que le storage : il ne parle à aucun onglet. Retirer une
 * marque ici écrit la clé `noise`, et les content scripts ouverts repeignent
 * d'eux-mêmes par `chrome.storage.onChanged` — aucun message n'est échangé.
 */
import {
  FAST_FASHION,
  NOISE_RULES_MAX,
  addRule,
  emptyNoise,
  hasActiveRules,
  normalize,
  removeRule,
  removeSeller,
  unhide,
} from '../shared/noise.ts';
import type { NoiseFilters } from '../shared/noise.ts';
import { saveSettings, updateNoise } from './store.ts';
import type { Settings } from '../shared/types.ts';

function required<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`sidepanel.html : #${id} introuvable`);
  return el as T;
}

const dialog = required('filters-dialog');
const openButton = required<HTMLButtonElement>('filters');
const dot = required('filters-dot');

const hiddenLine = required('filters-hidden');

// Modale des articles écartés : sa propre fenêtre, ouverte depuis la ligne
// ci-dessus. La liste est longue et rarement consultée — elle mangeait la moitié
// de la hauteur des filtres pour rien.
const hiddenDialog = required('hidden-dialog');
const hiddenSummary = required('hidden-summary');
const hiddenNote = required('hidden-note');
const recentEl = required('hidden-recent');

const brandsEl = required('filters-brands');
const brandsCountEl = required('filters-brands-count');
const sellersEl = required('filters-sellers');
const sellersCountEl = required('filters-sellers-count');
const wordsEl = required('filters-words');
const wordsCountEl = required('filters-words-count');
const revealEl = required<HTMLInputElement>('filters-reveal');
const statusEl = required('filters-status');

const brandForm = required<HTMLFormElement>('filters-brand-form');
const brandInput = required<HTMLInputElement>('filters-brand-input');
const wordForm = required<HTMLFormElement>('filters-word-form');
const wordInput = required<HTMLInputElement>('filters-word-input');
const fastFashionButton = required<HTMLButtonElement>('filters-fast-fashion');

/**
 * L'état affiché. Rafraîchi par le panneau à chaque `reload()` : la modale ne
 * relit pas le storage de son côté, mais toute écriture passe par
 * `updateNoise()`, qui relit — voir `shared/noise-storage.ts`.
 */
let noise: NoiseFilters = emptyNoise();
let settings: Settings | null = null;

function status(message: string): void {
  statusEl.textContent = message;
  statusEl.hidden = !message;
}

/** Une règle et sa croix. `.rule-chip` plutôt que `.chip`, qui est étiré à parts égales. */
function chip(label: string, title: string, onRemove: () => void): HTMLElement {
  const el = document.createElement('span');
  el.className = 'rule-chip';

  const text = document.createElement('span');
  text.textContent = label;
  el.appendChild(text);

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'rule-chip-remove';
  remove.textContent = '×';
  remove.title = title;
  remove.setAttribute('aria-label', title);
  remove.addEventListener('click', onRemove);
  el.appendChild(remove);

  return el;
}

function renderList(
  host: HTMLElement,
  countEl: HTMLElement,
  entries: { key: string; label: string }[],
  empty: string,
  onRemove: (key: string) => void
): void {
  host.textContent = '';
  countEl.textContent = entries.length ? String(entries.length) : '';

  if (!entries.length) {
    const none = document.createElement('p');
    none.className = 'filters-empty';
    none.textContent = empty;
    host.appendChild(none);
    return;
  }

  for (const entry of entries) {
    host.appendChild(
      chip(entry.label, `Ne plus masquer ${entry.label}`, () => {
        onRemove(entry.key);
      })
    );
  }
}

async function write(mutate: (current: NoiseFilters) => NoiseFilters): Promise<void> {
  noise = await updateNoise(mutate);
  render();
}

/** Le lien du bouton « Tout réafficher », partagé par les deux modales. */
function restoreAllButton(): HTMLButtonElement {
  const all = document.createElement('button');
  all.type = 'button';
  all.className = 'link';
  all.textContent = 'Tout réafficher';
  all.addEventListener('click', () => {
    void write((current) => ({ ...current, hidden: {}, recent: [] }));
  });
  return all;
}

/** La ligne des filtres : un compte, et la porte vers la modale dédiée. */
function renderHiddenLine(): void {
  const count = Object.keys(noise.hidden).length;

  hiddenLine.textContent = '';
  if (!count) {
    hiddenLine.textContent = 'Aucun article écarté.';
    return;
  }

  hiddenLine.append(document.createTextNode(`${count} article${count > 1 ? 's' : ''} · `));

  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'link';
  open.textContent = 'Gérer';
  open.addEventListener('click', () => {
    hiddenDialog.hidden = false;
  });
  hiddenLine.appendChild(open);
}

/** La modale dédiée : le compte, le « tout réafficher », et les récents nommés. */
function renderHiddenDialog(): void {
  const count = Object.keys(noise.hidden).length;

  hiddenSummary.textContent = '';
  if (!count) {
    hiddenSummary.textContent = 'Aucun article écarté.';
  } else {
    hiddenSummary.append(document.createTextNode(`${count} article${count > 1 ? 's' : ''} · `));
    hiddenSummary.appendChild(restoreAllButton());
  }

  recentEl.textContent = '';
  for (const entry of noise.recent) {
    const row = document.createElement('p');
    row.className = 'filters-recent-row';

    // Reconstruite depuis l'id seul, comme le repli d'extraction de content.ts
    // (`extractFromCard`) : sans le slug du titre dans l'URL, Vinted redirige
    // quand même vers la fiche.
    const title = document.createElement('a');
    title.href = `https://www.vinted.fr/items/${entry.id}`;
    title.target = '_blank';
    title.rel = 'noopener';
    title.textContent = entry.title || `Article ${entry.id}`;
    row.appendChild(title);

    const restore = document.createElement('button');
    restore.type = 'button';
    restore.className = 'rule-chip-remove';
    restore.textContent = '×';
    restore.title = 'Réafficher cet article';
    restore.setAttribute('aria-label', restore.title);
    restore.addEventListener('click', () => {
      void write((current) => unhide(current, entry.id));
    });
    row.appendChild(restore);

    recentEl.appendChild(row);
  }

  // Seuls les 20 derniers portent un titre : au-delà on ne stocke que des ids,
  // et afficher « 9497504182 » n'apprendrait rien. Le dire est plus honnête que
  // de laisser croire que la liste est complète.
  const untitled = count - noise.recent.length;
  hiddenNote.textContent = untitled
    ? `${untitled} article${untitled > 1 ? 's' : ''} plus ancien${untitled > 1 ? 's' : ''} ne ${untitled > 1 ? 'sont' : 'est'} pas listé${untitled > 1 ? 's' : ''} : seuls les derniers écartés gardent leur titre.`
    : '';
  hiddenNote.hidden = !untitled;
}

function render(): void {
  renderHiddenLine();
  renderHiddenDialog();

  renderList(
    brandsEl,
    brandsCountEl,
    noise.brands.map((brand) => ({ key: brand, label: brand })),
    'Aucune marque masquée.',
    (brand) => {
      void write((current) => removeRule(current, 'brands', brand));
    }
  );

  renderList(
    sellersEl,
    sellersCountEl,
    Object.entries(noise.sellers).map(([id, seller]) => ({
      key: id,
      label: seller.name || `Vendeur ${id}`,
    })),
    'Aucun vendeur masqué.',
    (id) => {
      void write((current) => removeSeller(current, id));
    }
  );

  renderList(
    wordsEl,
    wordsCountEl,
    noise.words.map((word) => ({ key: word, label: word })),
    'Aucun mot exclu.',
    (word) => {
      void write((current) => removeRule(current, 'words', word));
    }
  );

  // Le jeu complet est déjà posé : le bouton n'a plus rien à proposer, et un
  // bouton qui ne fait rien est pire qu'un bouton absent.
  fastFashionButton.hidden = FAST_FASHION.every((brand) => noise.brands.includes(brand));

  // Un témoin, pas un compte : la question posée est « le catalogue est-il
  // filtré ? », pas « par combien de règles ? ». Les articles écartés un par un
  // ne l'allument pas — voir hasActiveRules().
  const active = hasActiveRules(noise);
  dot.classList.toggle('filters-dot--active', active);
  openButton.title = active
    ? 'Filtres Vinted — au moins une règle masque des articles'
    : 'Filtres Vinted — aucune règle active';

  revealEl.checked = Boolean(settings?.revealHidden);
}

/** Appelé par le panneau à chaque rechargement : la modale suit l'état global. */
export function setFilters(next: NoiseFilters, nextSettings: Settings): void {
  noise = next;
  settings = nextSettings;
  render();
}

/**
 * Le refus se décide **sur ce que l'utilisateur a sous les yeux**, pas sur le
 * retour de l'écriture : `patchNoise()` relit le storage et rend donc toujours
 * un objet neuf, qu'il ait écrit ou non — comparer les références ne dirait
 * rien. `addRule()` reste l'autorité au moment d'écrire (il dédoublonne après
 * relecture) ; ici on ne fait que formuler le message.
 */
function addFrom(input: HTMLInputElement, list: 'brands' | 'words'): void {
  const raw = input.value.trim();
  if (!raw) return;

  if (noise[list].includes(normalize(raw))) {
    status('Cette règle est déjà là.');
    return;
  }
  if (noise[list].length >= NOISE_RULES_MAX) {
    status(`Liste pleine (${NOISE_RULES_MAX} entrées).`);
    return;
  }

  void write((current) => addRule(current, list, raw)).then(() => {
    input.value = '';
  });
}

brandForm.addEventListener('submit', (event) => {
  event.preventDefault();
  status('');
  addFrom(brandInput, 'brands');
});

wordForm.addEventListener('submit', (event) => {
  event.preventDefault();
  status('');
  addFrom(wordInput, 'words');
});

fastFashionButton.addEventListener('click', () => {
  status('');
  const before = noise.brands.length;
  void write((current) =>
    FAST_FASHION.reduce((acc, brand) => addRule(acc, 'brands', brand), current)
  ).then(() => {
    const added = noise.brands.length - before;
    status(
      added
        ? `${added} marque${added > 1 ? 's' : ''} ajoutée${added > 1 ? 's' : ''}.`
        : 'Ces marques étaient déjà masquées.'
    );
  });
});

revealEl.addEventListener('change', () => {
  void saveSettings({ revealHidden: revealEl.checked });
});

// --- Ouverture / fermeture ----------------------------------------------------

function close(): void {
  dialog.hidden = true;
  hiddenDialog.hidden = true;
  status('');
}

openButton.addEventListener('click', () => {
  dialog.hidden = false;
  render();
  brandInput.focus();
});

dialog.addEventListener('click', (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  // Le fond, ou un bouton `data-close` — même convention que les autres modales.
  if (target === dialog || target.closest('[data-close]')) close();
});

hiddenDialog.addEventListener('click', (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  if (target === hiddenDialog || target.closest('[data-close]')) hiddenDialog.hidden = true;
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;

  // La modale des écartés s'ouvre **par-dessus** celle des filtres : `Échap`
  // ferme la plus haute, une à la fois. Fermer les deux d'un coup renverrait à
  // la liste d'articles alors qu'on venait juste consulter une sous-liste.
  if (!hiddenDialog.hidden) {
    hiddenDialog.hidden = true;
    return;
  }
  if (!dialog.hidden) close();
});
