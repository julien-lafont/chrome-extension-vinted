/**
 * Confirmation visuelle sur l'icône de la barre d'outils quand un article vient
 * d'être enregistré.
 *
 * L'enregistrement se fait dans la page Vinted, souvent sur une carte de
 * catalogue dont le bouton est minuscule. Panneau fermé, rien ne bouge côté
 * extension : le clic a beau avoir écrit, l'utilisateur n'en a aucune preuve.
 *
 * Deux effets, volontairement redondants :
 *   — le **badge** vert, qui ne dépend que de `chrome.action` et marche partout ;
 *   — la **pulsation** de l'icône, dessinée hors écran, qui suppose
 *     `OffscreenCanvas`. Elle est « au mieux » : une erreur de dessin ne doit
 *     jamais faire disparaître la confirmation, d'où le badge à côté.
 *
 * Chrome n'anime pas l'icône lui-même — aucune API de transition n'existe. La
 * pulsation est donc une suite d'images posées à la main. L'icône occupant
 * toute sa surface (carré arrondi plein), elle ne peut que *rentrer* : agrandir
 * rognerait les coins. Le geste est un enfoncement suivi d'un retour, teinté de
 * vert au plus fort.
 */
import { ICON_PATHS } from '../shared/icons.ts';
import { ITEMS_KEY } from '../shared/storage.ts';

const BADGE_COLOR = '#16a34a';
const BADGE_TEXT_COLOR = '#ffffff';

/**
 * Durée d'affichage du badge. Court : le service worker peut être arrêté après
 * ~30 s d'inactivité, et un `setTimeout` qui n'arrive jamais à terme laisserait
 * le badge collé sur l'icône jusqu'au prochain réveil.
 */
export const BADGE_MS = 1400;

const FRAME_MS = 90;
const TINT = '34, 197, 94';

type Frame = { scale: number; tint: number };

/** Enfoncement puis retour ; la dernière image rend l'icône d'origine. */
const FRAMES: Frame[] = [
  { scale: 0.72, tint: 0.55 },
  { scale: 0.86, tint: 0.35 },
  { scale: 1, tint: 0.18 },
];

/** 16 pour un écran standard, 32 pour un écran à haute densité. */
const RENDER_SIZES = [16, 32];

/**
 * Numéro de la pulsation en cours. Deux articles enregistrés coup sur coup
 * lancent deux animations : sans ce compteur, la première rendrait l'icône
 * d'origine et effacerait le badge en plein milieu de la seconde.
 */
let generation = 0;

export type StoredChange = { oldValue?: unknown; newValue?: unknown };

function asMap(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

/**
 * Nombre d'articles **apparus** dans le storage.
 *
 * Ni les retraits ni les mises à jour ne comptent : un clic sur une carte écrit
 * deux fois (l'article en attente, puis la fiche complétée), et la seconde
 * écriture ne doit pas rejouer l'effet.
 */
export function countAdded(change: StoredChange | undefined): number {
  if (!change) return 0;

  const before = asMap(change.oldValue);
  const after = asMap(change.newValue);

  let added = 0;
  for (const id of Object.keys(after)) if (!(id in before)) added += 1;
  return added;
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function flashBadge(count: number, mine: number): Promise<void> {
  try {
    await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR });
    await chrome.action.setBadgeTextColor({ color: BADGE_TEXT_COLOR });
    await chrome.action.setBadgeText({ text: count > 1 ? `+${count}` : '✓' });

    await wait(BADGE_MS);
    if (mine !== generation) return; // une autre sauvegarde a repris la main

    await chrome.action.setBadgeText({ text: '' });
  } catch (err) {
    console.error('[Vinted Smart Bookmarks] badge', err);
  }
}

/**
 * L'icône source, décodée une fois. Sur échec, le cache est vidé : une
 * pulsation suivante retentera plutôt que de rejouer la même erreur.
 */
let basePromise: Promise<ImageBitmap> | null = null;

function loadBase(): Promise<ImageBitmap> {
  basePromise ??= (async () => {
    const response = await fetch(chrome.runtime.getURL(ICON_PATHS[128]));
    return await createImageBitmap(await response.blob());
  })().catch((err: unknown) => {
    basePromise = null;
    throw err;
  });

  return basePromise;
}

function renderSize(base: ImageBitmap, frame: Frame, size: number): ImageData {
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('contexte 2d indisponible');

  ctx.imageSmoothingQuality = 'high';

  const drawn = size * frame.scale;
  const offset = (size - drawn) / 2;
  ctx.drawImage(base, offset, offset, drawn, drawn);

  if (frame.tint > 0) {
    // `source-atop` ne peint que les pixels déjà dessinés : la teinte épouse le
    // carré arrondi de l'icône au lieu de remplir tout le canevas.
    ctx.globalCompositeOperation = 'source-atop';
    ctx.fillStyle = `rgba(${TINT}, ${frame.tint})`;
    ctx.fillRect(0, 0, size, size);
  }

  return ctx.getImageData(0, 0, size, size);
}

function render(base: ImageBitmap, frame: Frame): Record<number, ImageData> {
  const out: Record<number, ImageData> = {};
  for (const size of RENDER_SIZES) out[size] = renderSize(base, frame, size);
  return out;
}

function restoreIcon(): Promise<void> {
  return chrome.action.setIcon({ path: { ...ICON_PATHS } });
}

async function bumpIcon(mine: number): Promise<void> {
  // Absents des tests (Node n'a pas ces API navigateur) et d'un éventuel worker
  // dégradé : le badge suffit alors.
  if (typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap === 'undefined') return;

  try {
    const base = await loadBase();

    for (const frame of FRAMES) {
      if (mine !== generation) return;
      await chrome.action.setIcon({ imageData: render(base, frame) });
      await wait(FRAME_MS);
    }

    if (mine !== generation) return;
    await restoreIcon();
  } catch (err) {
    console.error('[Vinted Smart Bookmarks] pulsation de l icône', err);
    // Ne pas laisser la barre d'outils figée sur une image intermédiaire.
    void restoreIcon().catch(() => undefined);
  }
}

/** Joue les deux effets. Résolue quand l'icône et le badge sont revenus au repos. */
export async function pulseSaved(count: number): Promise<void> {
  const mine = ++generation;
  await Promise.all([flashBadge(count, mine), bumpIcon(mine)]);
}

/**
 * Branche l'effet sur le storage plutôt que sur un message du content script :
 * c'est le seul point par lequel *toutes* les sauvegardes passent, quel que soit
 * l'onglet Vinted qui écrit.
 */
export function watchSavedItems(): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;

    const added = countAdded(changes[ITEMS_KEY]);
    if (added > 0) void pulseSaved(added);
  });
}
