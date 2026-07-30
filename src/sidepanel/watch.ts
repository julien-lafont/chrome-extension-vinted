/**
 * Vinted Favoris — bouton de rafraîchissement et pilotage du cycle de suivi.
 *
 * Le rafraîchissement tourne dans le content script d'un onglet Vinted, jamais
 * ici (§1 de `docs/specs/suivi-prix.md`) : ce module élit un onglet, lui
 * transmet l'ordre, et lit `chrome.storage.local` (clé `watch`) pour afficher
 * la progression — pas de port, pas de second message, le panneau écoute déjà
 * `chrome.storage.onChanged`.
 */
import { WATCH_KEY, read, update } from '../shared/storage.ts';
import {
  isThrottled,
  isSweepRunning,
  orderForCheck,
  isMeaningfulDrop,
  RATE,
} from '../shared/watch.ts';
import type { SavedItem, WatchState } from '../shared/types.ts';
import type { PingResponse, WatchStartResponse } from '../shared/messages.ts';

/** `chrome.tabs.sendMessage` n'est pas typé : la conversion est concentrée ici. */
function sendToTab<T>(tabId: number, message: unknown): Promise<T> {
  return chrome.tabs.sendMessage(tabId, message);
}

/**
 * Journal de bord temporaire pour diagnostiquer « je clique sur Rafraîchir et
 * rien ne se passe » : cette console (celle du panneau) montre le côté
 * élection d'onglet / envoi du message ; `[Vinted Favoris][watch]` dans la
 * console de l'onglet Vinted montre ce que le content script en a fait.
 *
 * Se neutralise en `function log(..._args: unknown[]): void {}` une fois le
 * diagnostic terminé — les points d'appel restent en place pour une
 * réactivation rapide en cas de nouveau bug muet.
 */
function log(...args: unknown[]): void {
  // eslint-disable-next-line no-console -- journal de diagnostic assumé, pas une erreur
  console.log('[Vinted Favoris][panneau]', ...args);
}

/** §5.2 : silencieux, et seulement si le dernier cycle date d'assez loin — plus de plafond d'articles. */
const SILENT_SWEEP_AFTER_MS = 60 * 60 * 1000;

export type WatchElements = {
  button: HTMLButtonElement;
  label: HTMLElement;
  /**
   * Ligne d'**état** sous la barre de tri : cycle en cours, en pause, freinage,
   * absence d'onglet Vinted. Elle dure autant que l'état qu'elle décrit — les
   * messages passagers passent par `WatchHooks.onFlash`.
   */
  notice: HTMLElement;
};

export type WatchHooks = {
  /** Articles actuellement affichés (collection + recherche) : ce que rafraîchit un clic court. */
  visibleIds: () => string[];
  /**
   * Tous les articles connus : de quoi mesurer ce qu'un cycle a changé, alimenter
   * le déclencheur silencieux, et servir l'appui long (§5.1 bis), qui rafraîchit
   * toutes les collections d'un coup.
   */
  getItems: () => SavedItem[];
  /**
   * Message passager, câblé sur le `flash()` du panneau (5 s puis il s'effacce) :
   * résumé de fin de cycle (§6.7), mais aussi retour immédiat d'un clic —
   * onglet Vinted ouvert, cycle refusé, onglet à recharger. Un clic sans aucun
   * retour visible est ce qui faisait passer le bouton pour cassé.
   *
   * À distinguer de `WatchElements.notice`, qui dit un **état** durable (cycle
   * en cours, en pause, freiné) et reste affiché tant qu'il dure.
   */
  onFlash: (message: string) => void;
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
  const res = await read(WATCH_KEY);
  return res[WATCH_KEY];
}

const VINTED_MATCH = 'https://www.vinted.fr/*';
const VINTED_HOME = 'https://www.vinted.fr/';

/** Les onglets Vinted répondant au filtre, réduits à ceux qui portent un id utilisable. */
async function queryVinted(
  extra: chrome.tabs.QueryInfo = {}
): Promise<(chrome.tabs.Tab & { id: number })[]> {
  const tabs = await chrome.tabs.query({ url: VINTED_MATCH, ...extra });
  return tabs.filter((tab): tab is chrome.tabs.Tab & { id: number } => tab.id !== undefined);
}

/**
 * L'onglet Vinted qui portera le cycle, **par ordre de capacité réelle à
 * émettre** — et non le premier de la liste comme avant.
 *
 * C'est la correction du « le bouton ne marche pas alors que Vinted est
 * ouvert » : `chrome.tabs.query` rend les onglets dans l'ordre des fenêtres,
 * donc avec trois onglets Vinted l'ordre partait souvent vers un onglet en
 * arrière-plan — que §3.6 mettait aussitôt en pause, sans rien afficher.
 *
 * - `foreground` : l'onglet actif de la fenêtre du panneau. Le cycle tourne
 *   tout de suite.
 * - `otherWindow` : actif, mais dans une autre fenêtre. Il émet aussi (il est
 *   visible), on le dit seulement pour que le compteur qui avance ailleurs ne
 *   surprenne pas.
 * - `background` : ouvert mais caché. Le cycle démarre en pause et reprend au
 *   retour de l'utilisateur ; c'est ce qu'il faut lui dire.
 * - `none` : aucun onglet Vinted.
 */
export type TabChoice =
  ({ kind: 'foreground' | 'otherWindow' | 'background' } & Host) | { kind: 'none' };

/** L'onglet porteur du cycle, tel qu'il est rangé en storage pour le lien de §6.10. */
type Host = NonNullable<WatchState['host']>;

export async function electVintedTab(): Promise<TabChoice> {
  const [here] = await queryVinted({ active: true, currentWindow: true });
  if (here) return { kind: 'foreground', tabId: here.id, windowId: here.windowId };

  // Un onglet Vinted de cette fenêtre, mais pas celui qu'on regarde : l'activer
  // est exactement ce que le clic demande, et c'est un geste que l'utilisateur
  // aurait fait lui-même.
  const [sameWindow] = await queryVinted({ currentWindow: true });
  if (sameWindow) {
    await chrome.tabs.update(sameWindow.id, { active: true });
    return { kind: 'foreground', tabId: sameWindow.id, windowId: sameWindow.windowId };
  }

  const [activeElsewhere] = await queryVinted({ active: true });
  if (activeElsewhere) {
    return {
      kind: 'otherWindow',
      tabId: activeElsewhere.id,
      windowId: activeElsewhere.windowId,
    };
  }

  const [any] = await queryVinted();
  if (any) return { kind: 'background', tabId: any.id, windowId: any.windowId };

  return { kind: 'none' };
}

/**
 * Un onglet Vinted *visible*, seul cas où un cycle démarre sans attendre. Le
 * déclencheur silencieux (§5.2) s'en sert : lancer un cycle qui se mettrait
 * aussitôt en pause afficherait un compteur figé que personne n'a demandé.
 */
async function findVisibleVintedTab(): Promise<(chrome.tabs.Tab & { id: number }) | null> {
  const [here] = await queryVinted({ active: true, currentWindow: true });
  if (here) return here;
  const [elsewhere] = await queryVinted({ active: true });
  return elsewhere ?? null;
}

/** Y a-t-il au moins un onglet Vinted, visible ou non ? Sert au libellé du bouton. */
async function hasVintedTab(): Promise<boolean> {
  return (await queryVinted()).length > 0;
}

/**
 * Un onglet Vinted quelconque, **le plus apte à émettre d'abord**. Le balayage
 * des offres (`offers.ts`) s'en sert : lui aussi s'arrête sur un onglet caché,
 * et il n'a pas de bouton pour le dire.
 */
export async function findVintedTab(): Promise<(chrome.tabs.Tab & { id: number }) | null> {
  return (await findVisibleVintedTab()) ?? (await queryVinted())[0] ?? null;
}

/** Cadence et patience de la sonde `VF_PING`, le temps qu'un onglet neuf s'injecte. */
const PING_TRIES = 40;
const PING_INTERVAL_MS = 250;

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Attend qu'un content script réponde dans cet onglet. Un onglet tout juste
 * créé n'a rien d'injecté avant `document_idle` : envoyer l'ordre sans attendre
 * échouait silencieusement, ce qui donnait « le bouton n'a rien fait ».
 */
async function waitForContentScript(tabId: number): Promise<boolean> {
  for (let attempt = 0; attempt < PING_TRIES; attempt += 1) {
    try {
      const response = await sendToTab<PingResponse | undefined>(tabId, { type: 'VF_PING' });
      if (response?.ok) return true;
    } catch {
      // Pas encore injecté : on réessaie. C'est le cas normal juste après
      // `chrome.tabs.create`, pas une anomalie à journaliser quarante fois.
    }
    await delay(PING_INTERVAL_MS);
  }
  return false;
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
  hooks.onFlash(parts.join(', '));
}

/**
 * Fraîcheur relative, en français — le popover d'historique (§6.4) et le badge
 * d'offre (`docs/specs/offres.md` §5) s'en servent aussi.
 *
 * Les jours au-delà de 48 h ne sont pas cosmétiques : une offre reste en attente
 * des semaines, et « il y a 168 h » ne se lit pas.
 */
export function formatAgo(at: number): string {
  const minutes = Math.max(0, Math.round((Date.now() - at) / 60000));
  if (minutes < 1) return "à l'instant";
  if (minutes < 60) return `il y a ${minutes} min`;

  const hours = Math.round(minutes / 60);
  if (hours < 48) return `il y a ${hours} h`;
  return `il y a ${Math.round(hours / 24)} j`;
}

function formatEta(until: number): string {
  return new Date(until).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

function setButton({
  label,
  title,
  running,
}: {
  label: string;
  title: string;
  running: boolean;
}): void {
  el.label.textContent = label;
  el.button.title = title;
  el.button.setAttribute('aria-label', title);
  // L'icône ne tourne que pendant le cycle — voir §6.1 et le CSS de `.dir.is-running`.
  el.button.classList.toggle('is-running', running);
}

/**
 * Ramène sur l'onglet qui porte le cycle : c'est le geste que les deux messages
 * de cycle demandent, autant le rendre cliquable plutôt que de le décrire.
 *
 * L'onglet peut avoir été fermé entretemps — `chrome.tabs.update` lève alors, et
 * la seule chose utile à dire est qu'il n'y a plus d'onglet où retourner.
 */
async function focusHostTab(): Promise<void> {
  const host = (await readWatch())?.host;
  if (!host) return;

  try {
    await chrome.tabs.update(host.tabId, { active: true });
    // La fenêtre aussi, sinon l'onglet devient actif dans une fenêtre restée
    // derrière — activé, mais toujours invisible, donc toujours en pause.
    if (host.windowId !== undefined) await chrome.windows.update(host.windowId, { focused: true });
  } catch {
    log('l’onglet porteur n’existe plus');
    hooks.onFlash('L’onglet Vinted qui rafraîchissait a été fermé.');
    void render();
  }
}

/** Libellé du lien, tel que demandé : il désigne un onglet précis, pas « un onglet Vinted ». */
const HOST_LINK_LABEL = 'l’onglet Vinted responsable du rafraîchissement';

/**
 * Écrit la ligne d'état, avec un lien vers l'onglet porteur si la phrase le
 * prévoit (`{lien}`) et si l'on sait où pointer.
 */
function setNotice(text: string | null, host?: WatchState['host']): void {
  el.notice.hidden = text === null;
  el.notice.textContent = '';
  if (text === null) return;

  const [before, after] = text.split('{lien}');

  // Sans onglet connu (cycle lancé par une version antérieure, ou storage
  // incomplet), la phrase reste lisible : le lien redevient du texte.
  if (after === undefined || !host) {
    el.notice.textContent = text.replace('{lien}', HOST_LINK_LABEL);
    return;
  }

  // `ownerDocument` plutôt que le `document` global : c'est l'élément qui sait
  // dans quel document il vit, et ça rend la fonction testable sur un DOM monté
  // à côté, sans installer de global.
  const doc = el.notice.ownerDocument;
  const link = doc.createElement('button');
  link.type = 'button';
  link.className = 'link';
  link.textContent = HOST_LINK_LABEL;
  link.addEventListener('click', () => {
    void focusHostTab();
  });

  el.notice.append(doc.createTextNode(before ?? ''), link, doc.createTextNode(after));
}

/**
 * Rappel affiché seulement pendant un cycle : changer d'onglet met le
 * rafraîchissement en pause (§3.6, l'onglet doit rester visible), et ce n'est
 * pas une évidence pour qui regarde juste le bouton tourner.
 */
const RUNNING_NOTICE =
  "Rafraîchissement en cours sur {lien} — si tu changes d'onglet, le cycle se met en pause et reprend à ton retour.";

/** Une pause n'est pas une panne : le seul geste à faire est de revenir sur l'onglet. */
const PAUSED_NOTICE =
  'Rafraîchissement en pause — reviens sur {lien}, il reprend tout seul là où il en était.';

const NO_TAB_NOTICE =
  'Aucun onglet Vinted ouvert : le bouton en ouvrira un et lancera le rafraîchissement.';

/**
 * Ce que le clic fera, décidé par le dernier rendu.
 *
 * Le clic lisait auparavant la classe `is-running` du bouton pour trancher
 * entre lancer et annuler. Ça ne tient plus : l'icône ne tourne pas pendant une
 * pause, alors que le cycle est bien en cours — et un état visuel n'a jamais été
 * une bonne source de vérité pour une décision.
 */
let mode: 'start' | 'cancel' = 'start';

/** Repeint le bouton — §6.1, jamais plus d'une ligne d'état à la fois. */
async function render(): Promise<void> {
  const watch = await readWatch();
  const now = Date.now();
  const progress = watch?.progress;

  // Un `progress` que plus personne ne fait avancer n'est pas un cycle en cours
  // (`isSweepStale()`) : le traiter comme tel figeait le bouton sur « 12/48 »
  // jusqu'à la fin des temps, et transformait chaque clic en annulation.
  if (progress && isSweepRunning(watch, now)) {
    // Le panneau a pu s'ouvrir en cours de cycle (démarré par le déclencheur
    // silencieux, ou par ce même panneau juste avant) : sans snapshot, on ne
    // peut pas mesurer ce que ce cycle-là aura trouvé, mais on peut au moins
    // commencer à le mesurer à partir de maintenant.
    if (!snapshot) takeSnapshot();

    mode = 'cancel';
    setButton({
      label: `${progress.done}/${progress.total}`,
      title: progress.paused
        ? 'En pause — reviens sur l’onglet Vinted, ou clique pour annuler'
        : 'Annuler le rafraîchissement',
      running: !progress.paused,
    });
    setNotice(progress.paused ? PAUSED_NOTICE : RUNNING_NOTICE, watch?.host);
    return;
  }

  mode = 'start';

  // Le cycle qu'on suivait vient de se terminer.
  if (snapshot) reportSweepSummary();

  // Freiné : le bouton le dit et **reste cliquable**. Un bouton `disabled` ne
  // déclenche aucun événement, donc aucune explication — c'était le pire des
  // deux mondes, et c'est ce que l'utilisateur décrivait comme « rien ne se
  // passe ». Le clic, lui, répète la raison et l'échéance.
  if (watch && isThrottled(watch, now)) {
    const minutes = Math.max(1, Math.round(((watch.throttledUntil ?? now) - now) / 60000));
    setButton({
      label: `Réessai ${minutes} min`,
      title: `Vinted nous a freinés, reprise à ${formatEta(watch.throttledUntil ?? now)}`,
      running: false,
    });
    setNotice(
      `Vinted a limité nos requêtes : le rafraîchissement reprend à ${formatEta(watch.throttledUntil ?? now)}.`
    );
    return;
  }

  const vintedOpen = await hasVintedTab();

  setButton({
    label: 'Rafraîchir',
    title: `${
      vintedOpen
        ? watch?.lastSweepAt
          ? `Dernière vérification ${formatAgo(watch.lastSweepAt)}`
          : 'Jamais vérifié'
        : 'Ouvre un onglet Vinted et lance le rafraîchissement'
    }${ALL_SCOPE_HINT}`,
    running: false,
  });
  setNotice(vintedOpen ? null : NO_TAB_NOTICE);
}

/**
 * Envoie l'ordre. Toute issue — acceptée, refusée, onglet muet — repart en
 * `onFlash` : c'est la règle du bouton, un clic ne peut pas ne rien produire.
 *
 * @param silent déclencheur automatique (§5.2) : personne n'a rien demandé, donc
 *   rien à annoncer, ni succès ni refus.
 */
async function sendStart(host: Host, ids: string[], silent = false): Promise<void> {
  const { tabId } = host;
  takeSnapshot();
  log(`envoi de VF_WATCH_START à l'onglet ${tabId} (${ids.length} article(s)) :`, ids);

  // Avant l'envoi : le content script écrit `progress` dès qu'il accepte, et le
  // panneau doit déjà savoir vers quel onglet pointer son lien à ce moment-là.
  await update([WATCH_KEY], (stored) => {
    // Premier cycle de la vie de l'extension : la clé n'existe pas encore. On la
    // crée avec le même état neutre que `defaultWatch()` du content script — seau
    // plein, aucun cycle passé — plutôt que de priver ce cycle-là de son lien.
    const current = stored[WATCH_KEY] ?? {
      lastSweepAt: 0,
      bucket: { tokens: RATE.capacity, at: Date.now() },
    };
    return { [WATCH_KEY]: { ...current, host } };
  });

  try {
    const response = await sendToTab<WatchStartResponse | undefined>(tabId, {
      type: 'VF_WATCH_START',
      ids,
    });

    if (response?.accepted) {
      log('cycle accepté par le content script');
    } else {
      const reason = response?.reason ?? 'raison inconnue';
      log(`cycle refusé par le content script : ${reason}`);
      snapshot = null;
      // Le refus portait déjà sa phrase en français dans `reason` (« Un autre
      // onglet Vinted rafraîchit déjà. ») ; elle ne sortait nulle part.
      if (!silent) hooks.onFlash(reason);
    }
  } catch (err) {
    // Content script injoignable : onglet Vinted ouvert avant le chargement de
    // l'extension, ou pas rechargé depuis sa dernière mise à jour (voir
    // CLAUDE.md). C'est le seul cas où l'utilisateur a un geste précis à faire.
    log('échec de l’envoi du message, content script injoignable :', err);
    snapshot = null;
    if (!silent) hooks.onFlash('Recharge l’onglet Vinted (Cmd+R) pour lancer le rafraîchissement.');
  }
  void render();
}

/**
 * Obtient un onglet capable de porter le cycle, quoi qu'il en coûte : à défaut
 * d'onglet Vinted, on en ouvre un. « L'action ne doit jamais être bloquée » —
 * l'ancien bouton `disabled` laissait l'utilisateur deviner.
 */
async function claimTab(): Promise<Host | null> {
  const choice = await electVintedTab();

  if (choice.kind === 'foreground') return { tabId: choice.tabId, windowId: choice.windowId };

  if (choice.kind === 'otherWindow') {
    hooks.onFlash('Le rafraîchissement tourne dans l’onglet Vinted de l’autre fenêtre.');
    return { tabId: choice.tabId, windowId: choice.windowId };
  }

  if (choice.kind === 'background') {
    // Le cycle va démarrer en pause : `PAUSED_NOTICE` prend le relais dès le
    // premier `progress` écrit, avec son lien vers l'onglet en question.
    hooks.onFlash('Le rafraîchissement attend son onglet Vinted, resté en arrière-plan.');
    return { tabId: choice.tabId, windowId: choice.windowId };
  }

  log('aucun onglet Vinted : ouverture de vinted.fr');
  hooks.onFlash('Ouverture d’un onglet Vinted, le rafraîchissement suit…');
  const created = await chrome.tabs.create({ url: VINTED_HOME, active: true });
  if (created.id === undefined) return null;

  if (!(await waitForContentScript(created.id))) {
    log('onglet créé mais content script muet');
    hooks.onFlash('L’onglet Vinted a mis trop de temps à répondre. Réessaie.');
    return null;
  }
  return { tabId: created.id, windowId: created.windowId };
}

/**
 * Ce que le geste demande de rafraîchir (§5.1 bis).
 *
 * - `visible` : la liste affichée — collection active, recherche comprise.
 * - `all` : tous les articles enregistrés, toutes collections confondues.
 */
type Scope = 'visible' | 'all';

/**
 * Les articles d'un cycle « toutes collections ».
 *
 * `orderForCheck()` plutôt que la liste brute, comme le déclencheur silencieux :
 * à cette échelle, envoyer les vendus, les disparus et les articles encore en
 * attente de leur première fiche ne ferait que brûler du débit (§3.2) pour des
 * verdicts déjà connus. Le clic court, lui, garde la liste affichée telle
 * quelle — l'utilisateur y désigne des articles précis, il est le seul juge.
 */
function allIds(): string[] {
  return orderForCheck(hooks.getItems()).map((item) => item.id);
}

async function startFromButton(scope: Scope): Promise<void> {
  log(`clic sur Rafraîchir (portée : ${scope})`);

  const ids = scope === 'all' ? allIds() : hooks.visibleIds();
  if (!ids.length) {
    log('abandon : aucun article à vérifier');
    hooks.onFlash(
      scope === 'all'
        ? 'Aucun article à rafraîchir.'
        : 'Aucun article à rafraîchir dans cette collection.'
    );
    return;
  }

  const watch = await readWatch();
  const now = Date.now();
  if (watch && isThrottled(watch, now)) {
    // Le bouton n'est plus `disabled` : c'est ce clic-ci qui doit expliquer.
    log(`abandon : freiné jusqu'à ${formatEta(watch.throttledUntil ?? now)}`);
    hooks.onFlash(
      `Vinted a limité nos requêtes ; le rafraîchissement reprend à ${formatEta(watch.throttledUntil ?? now)}.`
    );
    return;
  }

  // Avant `claimTab()`, pas après : lui aussi parle (onglet d'une autre fenêtre,
  // onglet caché, ouverture d'un onglet), et ce qu'il a à dire demande un geste.
  // Dans le cas courant — onglet Vinted sous les yeux — il se tait, et c'est
  // cette phrase qui reste : la seule confirmation que l'appui long a bien été
  // compris comme tel.
  if (scope === 'all') {
    hooks.onFlash(`Rafraîchissement de toutes les collections (${ids.length} articles)`);
  }

  const host = await claimTab();
  if (!host) return; // `claimTab()` a déjà dit ce qui manquait

  log(`onglet ${host.tabId} élu, ${ids.length} article(s) à vérifier`);
  await sendStart(host, ids);
}

/**
 * Diffusé à tous les onglets Vinted : peu importe lequel tient le bail.
 *
 * Le `progress` est effacé ici même, sans attendre que le porteur le fasse : il
 * peut être en pause dans un onglet caché, et son prochain battement peut être à
 * vingt secondes. Le bouton doit répondre au clic, pas dans vingt secondes.
 */
async function cancelFromButton(): Promise<void> {
  log('clic sur Annuler, diffusion de VF_WATCH_CANCEL');
  const tabs = await queryVinted();
  log(`${tabs.length} onglet(s) Vinted trouvé(s)`);
  await Promise.all(
    tabs.map((tab) =>
      chrome.tabs.sendMessage(tab.id, { type: 'VF_WATCH_CANCEL' }).catch(() => undefined)
    )
  );

  await update([WATCH_KEY], (stored) => {
    const current = stored[WATCH_KEY];
    if (!current?.progress) return null; // rien à effacer, pas d'écriture
    const next = { ...current };
    delete next.progress;
    return { [WATCH_KEY]: next };
  });

  void render();
}

/**
 * Durée d'appui qui fait passer le bouton de la collection affichée à toutes les
 * collections. Même seuil que l'appui long du content script (`LONG_PRESS_MS`
 * dans `content.ts`) : c'est le même geste, il doit avoir la même durée.
 *
 * **Couplé au CSS** : `@keyframes vf-hold` remplit le bouton en 480 ms, et ce
 * remplissage n'a de sens que s'il se termine à l'instant où le cycle part.
 */
const LONG_PRESS_MS = 480;

/** Au-delà, le pointeur glisse : l'appui n'escalade plus (le clic, lui, reste). */
const LONG_PRESS_SLOP_PX = 10;

/**
 * Un `click` émis dans la foulée d'un geste pointeur déjà traité est l'écho de
 * ce geste, pas un second clic — le navigateur émet toujours les deux.
 *
 * Fenêtre volontairement large : le `click` suit le `pointerup` immédiatement,
 * mais il n'est **pas garanti** (règle 1 : une sélection de texte ou un
 * glissement le supprime). Un simple booléen resterait alors armé et avalerait
 * le clic suivant.
 */
const POINTER_ECHO_MS = 700;

/** Rappel d'existence, ajouté au `title` du bouton au repos — voir §5.1 bis. */
const ALL_SCOPE_HINT = ' · appui long : toutes les collections';

/** Câble le bouton. À appeler une fois, au démarrage du panneau. */
export function initWatch(elements: WatchElements, watchHooks: WatchHooks): void {
  el = elements;
  hooks = watchHooks;

  /** Ce que fait un geste court, selon le dernier rendu. */
  const runShort = (): void => {
    if (mode === 'cancel') void cancelFromButton();
    else void startFromButton('visible');
  };

  // --- Appui long : toutes les collections -----------------------------------
  //
  // Le geste se décide au **relâchement**, contrairement aux boutons injectés du
  // content script : là-bas l'appui long ajoute une action à celle du
  // `pointerdown`, ici il en remplace une autre — on ne peut pas lancer un cycle
  // sur la collection affichée puis en lancer un second sur toutes.
  //
  // C'est `pointerup` qui tranche, jamais `click` : ce dernier disparaît dès
  // qu'une sélection démarre ou que le pointeur glisse (règle 1), et ce bouton a
  // déjà eu une longue histoire de « je clique et rien ne se passe ».

  const doc = el.button.ownerDocument;

  let pressTimer: number | null = null;
  let disarm: (() => void) | null = null;
  /** Le seuil a été franchi : le relâchement ne doit plus rien déclencher. */
  let longFired = false;
  /** Date du dernier geste pointeur déjà servi, pour ignorer son écho `click`. */
  let pointerHandledAt = 0;

  const stopHold = (): void => {
    if (pressTimer !== null) clearTimeout(pressTimer);
    pressTimer = null;
    el.button.classList.remove('is-holding');
  };

  const release = (): void => {
    stopHold();
    disarm?.();
    disarm = null;
  };

  el.button.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return; // bouton secondaire : geste du navigateur
    release();
    longFired = false;

    // Alt+clic : la même destination sans l'attente, comme sur les boutons
    // injectés. Ce sont deux chemins vers un seul comportement, pas deux
    // fonctions à documenter séparément.
    if (event.altKey) {
      pointerHandledAt = Date.now();
      void startFromButton('all');
      return;
    }

    const startX = event.clientX;
    const startY = event.clientY;

    const onMove = (move: PointerEvent): void => {
      // Un glissement annule **l'escalade**, pas le clic : le geste redevient un
      // rafraîchissement de la collection affichée, qui partira au relâchement.
      // Tout annuler ici rendrait au bouton son défaut historique — un clic un
      // peu tremblant qui ne produit rien.
      if (Math.abs(move.clientX - startX) + Math.abs(move.clientY - startY) > LONG_PRESS_SLOP_PX) {
        stopHold();
      }
    };

    const onUp = (): void => {
      release();
      if (longFired) return; // le cycle « toutes collections » est déjà parti
      pointerHandledAt = Date.now();
      runShort();
    };

    // Un `pointercancel` (le système reprend le pointeur : scroll, geste
    // d'interface) n'est pas un clic : on démonte sans rien lancer.
    const onCancel = (): void => {
      release();
    };

    // Sur le document et en capture : le relâchement peut avoir lieu hors du
    // bouton, et un repeint peut avoir remplacé le libellé entre-temps.
    doc.addEventListener('pointerup', onUp, true);
    doc.addEventListener('pointercancel', onCancel, true);
    doc.addEventListener('pointermove', onMove, true);
    disarm = () => {
      doc.removeEventListener('pointerup', onUp, true);
      doc.removeEventListener('pointercancel', onCancel, true);
      doc.removeEventListener('pointermove', onMove, true);
    };

    // Pendant un cycle, le bouton annule : rien à escalader, et un remplissage
    // qui progresse promettrait une action qui n'existe pas.
    if (mode === 'cancel') return;

    el.button.classList.add('is-holding');
    pressTimer = setTimeout(() => {
      stopHold();
      longFired = true;
      pointerHandledAt = Date.now();
      void startFromButton('all');
    }, LONG_PRESS_MS) as unknown as number;
  });

  el.button.addEventListener('click', (event) => {
    // L'écho du geste pointeur ci-dessus, déjà servi.
    if (Date.now() - pointerHandledAt < POINTER_ECHO_MS) return;

    log('clic détecté sur le bouton', { mode });

    // Alt+Entrée : le seul accès clavier aux autres collections — un appui long
    // n'existe pas au clavier, la répétition de touche n'en est pas un.
    if (event.altKey && mode === 'start') {
      void startFromButton('all');
      return;
    }

    runShort();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[WATCH_KEY]) void render();
  });

  // Le libellé du bouton dépend des onglets ouverts, qui changent sans que le
  // storage bouge : sans ces écoutes, un panneau ouvert avant Vinted gardait à
  // vie son « Ouvre un onglet Vinted » — et, du temps où ce libellé venait avec
  // un bouton `disabled`, un bouton mort alors que Vinted était sous les yeux.
  const repaintOnTabs = (): void => {
    void render();
  };
  chrome.tabs.onActivated.addListener(repaintOnTabs);
  chrome.tabs.onRemoved.addListener(repaintOnTabs);
  chrome.tabs.onUpdated.addListener((_tabId, change) => {
    // Seule l'URL nous intéresse : un onglet qui devient (ou cesse d'être) un
    // onglet Vinted. Repeindre à chaque `status` ferait une dizaine de rendus par
    // chargement de page.
    if (change.url) repaintOnTabs();
  });

  void render();
}

/** L'état des garde-fous de débit tel qu'il était avant leur remise à zéro. */
export type RateLimitCounters = {
  freine: boolean;
  coupsDeFrein: number;
  budgetDuJour: number;
  jetons: number;
};

/**
 * Remet à zéro tous les garde-fous de débit (§3.2 et §3.5) : seau à jetons
 * rempli, budget du jour effacé, fenêtre de silence levée et compteur de coups
 * de frein remis à zéro. Outil de mise au point : sans lui, un backoff de
 * plusieurs heures (30 min × 2^n) rend le rafraîchissement intestable pour le
 * reste de la session.
 *
 * Ne touche ni au bail ni à `lastSweepAt` : ce ne sont pas des compteurs de
 * débit, et reprendre un bail tenu par un autre onglet ferait tourner deux
 * cycles en parallèle — exactement ce que le bail empêche.
 *
 * Relit avant d'écrire (règle 6) : un onglet Vinted peut écrire la même clé au
 * même moment.
 */
export async function resetRateLimits(): Promise<RateLimitCounters> {
  const now = Date.now();
  let before: RateLimitCounters = {
    freine: false,
    coupsDeFrein: 0,
    budgetDuJour: 0,
    jetons: RATE.capacity,
  };

  await update([WATCH_KEY], (stored) => {
    const current = stored[WATCH_KEY];

    before = {
      freine: current ? isThrottled(current, now) : false,
      coupsDeFrein: current?.throttleStrikes ?? 0,
      budgetDuJour: current?.dailyBudget?.used ?? 0,
      jetons: Math.floor(current?.bucket.tokens ?? RATE.capacity),
    };

    const next: WatchState = {
      ...(current ?? { lastSweepAt: 0, bucket: { tokens: RATE.capacity, at: now } }),
      bucket: { tokens: RATE.capacity, at: now },
    };
    // `delete` plutôt que `undefined` : ces clés sont optionnelles, et le storage
    // sérialise — une clé à `undefined` disparaît de toute façon à la relecture.
    delete next.throttledUntil;
    delete next.throttleStrikes;
    delete next.dailyBudget;

    return { [WATCH_KEY]: next };
  });

  log('compteurs de débit remis à zéro', before);

  // Le repeint du bouton suit tout seul : `initWatch` écoute `onChanged`, qui
  // se déclenche aussi dans le contexte qui écrit.
  return before;
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

  if (isSweepRunning(watch, now)) {
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

  // Un onglet **visible** seulement : sans lui, le cycle démarrerait en pause
  // (§3.6) et laisserait un compteur figé dans un bouton que personne n'a
  // touché. Rien à faire, et rien à dire — comme avant.
  const tab = await findVisibleVintedTab();
  if (!tab) {
    log('abandon : aucun onglet Vinted visible');
    return;
  }

  const ids = allIds();
  if (!ids.length) {
    log('abandon : aucun article éligible (en attente, vendu ou disparu)');
    return;
  }

  log(`démarrage du cycle silencieux : ${ids.length} article(s)`);
  await sendStart({ tabId: tab.id, windowId: tab.windowId }, ids, true);
}
