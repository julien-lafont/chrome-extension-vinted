/**
 * Vinted Smart Bookmarks — la collection par défaut de l'onglet.
 *
 * Une session de chine a un sujet : on parcourt les Barbour une soirée, les
 * bottes la suivante. L'appui long range article par article, ce qui est le bon
 * geste pour un rangement occasionnel mais le mauvais quand *tout* ce qu'on
 * enregistre va au même endroit. Épingler une collection depuis le menu fait
 * alors du clic court un enregistrement direct dans celle-ci.
 *
 * **Pourquoi `sessionStorage` et non `chrome.storage.local`.** La portée demandée
 * est l'onglet, et c'est exactement ce que `sessionStorage` donne : propre à
 * l'onglet, conservé au rechargement comme à travers la navigation SPA de Vinted,
 * effacé à sa fermeture. Le storage de l'extension ferait l'inverse — le choix
 * fuirait sur les autres onglets ouverts et survivrait des jours à la session qui
 * l'a motivé, ce qui est précisément le mode de panne à éviter : enregistrer
 * pendant des semaines dans une collection qu'on a oublié d'avoir épinglée.
 *
 * Ce `sessionStorage` est celui de la page (le monde isolé n'en a pas de
 * séparé) : la clé est donc préfixée, et ne contient qu'un identifiant de
 * collection — rien qui ne soit déjà visible à l'écran.
 *
 * L'état est **lu à chaque fois**, jamais mémoïsé : le content script survit aux
 * navigations SPA, et un cache local finirait par décrire un onglet qui n'est
 * plus celui-là.
 *
 * `null` n'est pas « aucune destination » mais « Mes favoris » : c'est là que va
 * un clic court quand rien n'est épinglé. Le menu montre donc toujours une
 * épingle pleine (voir `collection-picker.ts`), et la collection par défaut ne
 * s'écrit jamais ici — elle *est* l'absence de valeur, et l'enregistrer
 * laisserait deux façons de dire la même chose.
 */
import { button, pillStack } from './ui.ts';

const KEY = 'vf:defaultCollection';

/**
 * L'identifiant de la collection épinglée sur cet onglet, `null` si aucune.
 *
 * `sessionStorage` lève quand le navigateur refuse le stockage à l'origine
 * (mode restreint, cookies tiers bloqués dans un cadre). La fonctionnalité se tait
 * alors plutôt que de faire tomber l'injection des boutons, qui compte davantage.
 */
export function readTabDefault(): string | null {
  try {
    return sessionStorage.getItem(KEY) || null;
  } catch {
    return null;
  }
}

/** Épingle une collection sur cet onglet, ou retire l'épingle avec `null`. */
export function writeTabDefault(collectionId: string | null): void {
  try {
    if (collectionId) sessionStorage.setItem(KEY, collectionId);
    else sessionStorage.removeItem(KEY);
  } catch {
    // Voir readTabDefault() : sans stockage de session, pas de collection par défaut.
  }
}

/**
 * L'épingle, en deux états. Contour tant que la collection n'est pas celle de
 * l'onglet, pleine quand elle l'est — la même grammaire que le marque-page des
 * boutons injectés, pour que l'état se lise sans avoir à survoler.
 */
const PIN_BODY =
  '<path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"/><line x1="12" y1="17" x2="12" y2="22"/>';

export const PIN_OUTLINE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PIN_BODY}</svg>`;

export const PIN_FILLED = `<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PIN_BODY}</svg>`;

// --- Pastille -----------------------------------------------------------------

let pill: HTMLElement | null = null;

/**
 * L'annulation du moment. Gardée à part du bouton : la pastille n'est construite
 * qu'une fois, alors que l'appelant peut passer une nouvelle fermeture à chaque
 * rendu — le bouton appellerait sinon celle du premier appel, pour toujours.
 */
let clear: () => void = () => {};

/**
 * Rend la pastille du défaut, ou la retire quand plus rien n'est épinglé.
 *
 * L'épinglage n'a aucune trace ailleurs — le panneau latéral est souvent fermé
 * quand on chine, et un clic court qui range silencieusement dans « Bottes »
 * serait indistinguable d'un bug. La pastille est donc permanente, et porte son
 * annulation.
 *
 * Idempotent, comme tout ce qui touche au DOM ici (règle 3) : on ne réécrit que
 * ce qui change réellement. Le `isConnected` couvre le cas où Vinted a remplacé
 * le corps de la page sous nos pieds : la variable pointerait alors sur un nœud
 * détaché, et la pastille aurait disparu sans jamais être reconstruite.
 */
export function renderDefaultPill(name: string | null, onClear: () => void): void {
  clear = onClear;

  if (!name) {
    pill?.remove();
    pill = null;
    return;
  }

  if (!pill?.isConnected) {
    pill = document.createElement('div');
    pill.className = 'vf-pill vf-pill-default';

    const icon = document.createElement('span');
    icon.className = 'vf-pill-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.innerHTML = PIN_FILLED;

    const label = document.createElement('span');
    label.className = 'vf-pill-label';

    const close = button('vf-pill-clear', '✕', () => {
      clear();
    });
    close.title = 'Ne plus enregistrer par défaut dans cette collection';
    close.setAttribute('aria-label', close.title);

    pill.append(icon, label, close);
    pillStack().appendChild(pill);
  }

  const label = pill.querySelector<HTMLElement>('.vf-pill-label');
  if (label && label.textContent !== name) {
    label.textContent = name;
    pill.setAttribute('aria-label', `Collection par défaut de cet onglet : ${name}`);
    pill.title = `Sur cet onglet, un clic enregistre dans « ${name} »`;
  }
}
