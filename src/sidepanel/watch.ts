/**
 * Vinted Favoris — bouton de rafraîchissement et pilotage du cycle de suivi.
 *
 * Le rafraîchissement tourne dans le content script d'un onglet Vinted, jamais
 * ici (§1 de `docs/specs/suivi-prix.md`) : ce module élit un onglet, lui
 * transmet l'ordre, et lit `chrome.storage.local` (clé `watch`) pour afficher
 * la progression — pas de port, pas de second message, le panneau écoute déjà
 * `chrome.storage.onChanged`.
 */
import { isThrottled, orderForCheck, isMeaningfulDrop } from '../shared/watch.ts';
import type { SavedItem, WatchState } from '../shared/types.ts';
import type { WatchStartResponse } from '../shared/messages.ts';

const WATCH_KEY = 'watch';

/** `chrome.tabs.sendMessage` n'est pas typé : la conversion est concentrée ici, comme dans offer.ts. */
function sendToTab<T>(tabId: number, message: unknown): Promise<T> {
  return chrome.tabs.sendMessage(tabId, message);
}

/**
 * Journal de bord temporaire pour diagnostiquer « je clique sur Rafraîchir et
 * rien ne se passe » : cette console (celle du panneau) montre le côté
 * élection d'onglet / envoi du message ; `[Vinted Favoris][watch]` dans la
 * console de l'onglet Vinted montre ce que le content script en a fait.
 */
function log(...args: unknown[]): void {
  // `warn` plutôt que `log` : la règle ESLint `no-console` du projet n'autorise
  // que `warn`/`error`. Ce n'est pas une erreur, seulement un jaune plus visible.
  console.warn('[VF panneau][watch]', ...args);
}

/** §5.2 : silencieux, et seulement si le dernier cycle date d'assez loin — plus de plafond d'articles. */
const SILENT_SWEEP_AFTER_MS = 60 * 60 * 1000;

export type WatchElements = {
  button: HTMLButtonElement;
  label: HTMLElement;
  /** Avertissement affiché seulement pendant un cycle en cours. */
  notice: HTMLElement;
};

export type WatchHooks = {
  /** Articles actuellement affichés (collection + recherche) : ce que rafraîchit le bouton manuel. */
  visibleIds: () => string[];
  /** Tous les articles connus, pour mesurer ce qu'un cycle a changé et pour le déclencheur silencieux. */
  getItems: () => SavedItem[];
  /** Résumé de fin de cycle (§6.7) ; jamais appelé si rien n'a été trouvé. */
  onSweepSummary: (message: string) => void;
};

let el: WatchElements;
let hooks: WatchHooks;

/**
 * Pris au lancement d'un cycle, vidé à sa fin pour produire le résumé (§6.7).
 * `null` signifie qu'aucun cycle suivi par ce panneau n'est en cours — un cycle
 * démarré par un autre onglet ou une session précédente ne produit donc pas de
 * résumé ici, ce qui est le comportement voulu : personne ne l'attend.
 */
let snapshot: Map<string, { status?: SavedItem['status']; priceValue: number | null }> | null =
  null;

async function readWatch(): Promise<WatchState | undefined> {
  const res: { watch?: WatchState } = await chrome.storage.local.get(WATCH_KEY);
  return res.watch;
}

/** Un onglet Vinted quelconque : peu importe lequel, un seul suffit à porter l'ordre. */
async function findVintedTab(): Promise<chrome.tabs.Tab | null> {
  const tabs = await chrome.tabs.query({ url: 'https://www.vinted.fr/*' });
  return tabs.find((tab) => tab.id !== undefined) ?? null;
}

function takeSnapshot(): void {
  snapshot = new Map(
    hooks.getItems().map((item) => [item.id, { status: item.status, priceValue: item.priceValue }])
  );
}

/** Compare l'état au lancement du cycle à l'état courant, et le dit en une ligne. */
function reportSweepSummary(): void {
  if (!snapshot) return;
  const before = snapshot;
  snapshot = null;

  let drops = 0;
  let sold = 0;

  for (const item of hooks.getItems()) {
    const previous = before.get(item.id);
    if (!previous) continue;

    if (!previous.status && item.status === 'sold') {
      sold += 1;
    } else if (typeof previous.priceValue === 'number' && typeof item.priceValue === 'number') {
      if (isMeaningfulDrop(previous.priceValue, item.priceValue)) drops += 1;
    }
  }

  if (!drops && !sold) return; // rien trouvé : une notification de trop, voir §6.7

  const parts: string[] = [];
  if (drops) parts.push(`${drops} baisse${drops > 1 ? 's' : ''} de prix`);
  if (sold) parts.push(`${sold} vendu${sold > 1 ? 's' : ''}`);
  hooks.onSweepSummary(parts.join(', '));
}

/** Fraîcheur relative, en français — aussi utilisé par le popover d'historique (§6.4). */
export function formatAgo(at: number): string {
  const minutes = Math.max(0, Math.round((Date.now() - at) / 60000));
  if (minutes < 1) return "à l'instant";
  if (minutes < 60) return `il y a ${minutes} min`;
  return `il y a ${Math.round(minutes / 60)} h`;
}

function formatEta(until: number): string {
  return new Date(until).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

function setButton({
  label,
  title,
  disabled,
  running,
}: {
  label: string;
  title: string;
  disabled: boolean;
  running: boolean;
}): void {
  el.label.textContent = label;
  el.button.title = title;
  el.button.setAttribute('aria-label', title);
  el.button.disabled = disabled;
  // L'icône ne tourne que pendant le cycle — voir §6.1 et le CSS de `.dir.is-running`.
  el.button.classList.toggle('is-running', running);
}

/**
 * Rappel affiché seulement pendant un cycle : changer d'onglet suspend le
 * rafraîchissement (§3.6, l'onglet doit rester visible), et ce n'est pas une
 * évidence pour qui regarde juste le bouton tourner.
 */
const RUNNING_NOTICE =
  "Rafraîchissement en cours — ne change pas d'onglet Vinted, ça mettrait le cycle en pause.";

/** Repeint le bouton — quatre états, §6.1, jamais plus d'une ligne à la fois. */
async function render(): Promise<void> {
  const watch = await readWatch();
  const now = Date.now();

  if (watch?.progress) {
    // Le panneau a pu s'ouvrir en cours de cycle (démarré par le déclencheur
    // silencieux, ou par ce même panneau juste avant) : sans snapshot, on ne
    // peut pas mesurer ce que ce cycle-là aura trouvé, mais on peut au moins
    // commencer à le mesurer à partir de maintenant.
    if (!snapshot) takeSnapshot();

    setButton({
      label: `${watch.progress.done}/${watch.progress.total}`,
      title: 'Annuler le rafraîchissement',
      disabled: false,
      running: true,
    });
    el.notice.hidden = false;
    el.notice.textContent = RUNNING_NOTICE;
    return;
  }

  el.notice.hidden = true;

  // Le cycle qu'on suivait vient de se terminer.
  if (snapshot) reportSweepSummary();

  if (watch && isThrottled(watch, now)) {
    const minutes = Math.max(1, Math.round(((watch.throttledUntil ?? now) - now) / 60000));
    setButton({
      label: `Réessai ${minutes} min`,
      title: `Vinted nous a freinés, reprise à ${formatEta(watch.throttledUntil ?? now)}`,
      disabled: true,
      running: false,
    });
    return;
  }

  const tab = await findVintedTab();

  if (!tab) {
    setButton({
      label: 'Rafraîchir',
      title: 'Ouvre un onglet Vinted pour rafraîchir',
      disabled: true,
      running: false,
    });
    return;
  }

  setButton({
    label: 'Rafraîchir',
    title: watch?.lastSweepAt
      ? `Dernière vérification ${formatAgo(watch.lastSweepAt)}`
      : 'Jamais vérifié',
    disabled: false,
    running: false,
  });
}

async function sendStart(tabId: number, ids: string[]): Promise<void> {
  takeSnapshot();
  log(`envoi de VF_WATCH_START à l'onglet ${tabId} (${ids.length} article(s)) :`, ids);
  try {
    const response = await sendToTab<WatchStartResponse | undefined>(tabId, {
      type: 'VF_WATCH_START',
      ids,
    });

    if (response?.accepted) {
      log('cycle accepté par le content script');
    } else {
      log(`cycle refusé par le content script : ${response?.reason ?? 'raison inconnue'}`);
    }
  } catch (err) {
    // Content script pas encore injecté (onglet tout juste ouvert, ou pas
    // rechargé depuis la dernière modification — voir CLAUDE.md) : rien
    // d'actionnable de plus que ce que dit déjà l'absence de progression.
    log('échec de l’envoi du message, content script injoignable :', err);
    snapshot = null;
  }
  void render();
}

async function startFromButton(): Promise<void> {
  log('clic sur Rafraîchir');

  const tab = await findVintedTab();
  if (!tab?.id) {
    log('abandon : aucun onglet Vinted ouvert');
    return;
  }

  const ids = hooks.visibleIds();
  if (!ids.length) {
    log('abandon : aucun article affiché dans la collection courante');
    return;
  }

  log(`onglet ${tab.id} élu, ${ids.length} article(s) affiché(s) à vérifier`);
  await sendStart(tab.id, ids);
}

/** Diffusé à tous les onglets Vinted : peu importe lequel tient le bail. */
async function cancelFromButton(): Promise<void> {
  log('clic sur Annuler, diffusion de VF_WATCH_CANCEL');
  const tabs = await chrome.tabs.query({ url: 'https://www.vinted.fr/*' });
  log(`${tabs.length} onglet(s) Vinted trouvé(s)`);
  await Promise.all(
    tabs
      .filter((tab): tab is chrome.tabs.Tab & { id: number } => tab.id !== undefined)
      .map((tab) =>
        chrome.tabs.sendMessage(tab.id, { type: 'VF_WATCH_CANCEL' }).catch(() => undefined)
      )
  );
}

/** Câble le bouton. À appeler une fois, au démarrage du panneau. */
export function initWatch(elements: WatchElements, watchHooks: WatchHooks): void {
  el = elements;
  hooks = watchHooks;

  el.button.addEventListener('click', () => {
    log('clic détecté sur le bouton', {
      running: el.button.classList.contains('is-running'),
      disabled: el.button.disabled,
    });
    if (el.button.classList.contains('is-running')) void cancelFromButton();
    else void startFromButton();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[WATCH_KEY]) void render();
  });

  void render();
}

/**
 * Déclencheur silencieux (§5.2) : à l'ouverture du panneau, si `lastSweepAt`
 * remonte à plus d'une heure et qu'un onglet Vinted est ouvert, un cycle
 * démarre sans rien signaler — seul le compteur discret du bouton en
 * témoigne. Sans onglet Vinted, on ne fait rien, et on ne le dit pas non
 * plus : rien n'y serait actionnable.
 */
export async function maybeStartSilentSweep(): Promise<void> {
  log('vérification du déclencheur silencieux (§5.2)');

  const watch = await readWatch();
  const now = Date.now();

  if (watch?.progress) {
    log('abandon : un cycle est déjà en cours');
    return;
  }
  if (watch && isThrottled(watch, now)) {
    log(`abandon : freiné jusqu'à ${formatEta(watch.throttledUntil ?? now)}`);
    return;
  }
  if (watch && now - watch.lastSweepAt < SILENT_SWEEP_AFTER_MS) {
    log(`abandon : dernier cycle ${formatAgo(watch.lastSweepAt)} (< 1 h)`);
    return;
  }

  const tab = await findVintedTab();
  if (!tab?.id) {
    log('abandon : aucun onglet Vinted ouvert');
    return;
  }

  const ids = orderForCheck(hooks.getItems()).map((item) => item.id);
  if (!ids.length) {
    log('abandon : aucun article éligible (en attente, vendu ou disparu)');
    return;
  }

  log(`démarrage du cycle silencieux : ${ids.length} article(s)`);
  await sendStart(tab.id, ids);
}
