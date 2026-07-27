/**
 * Photos d'une fiche article : où les lire, et dans quelle qualité.
 *
 * Trois sources cohabitent sur une fiche, et elles ne se valent pas :
 *
 *   1. le flux React Server Components, bloc `{"name":"gallery",…}` — **toutes**
 *      les photos, ordonnées, avec l'original en 1200×1600 (`full_size_url`) ;
 *   2. le DOM `item-photo-{N}--img` — toutes les photos aussi, mais plafonnées à
 *      `f800` (600×800) et sans couleur dominante ;
 *   3. le JSON-LD, qui n'expose que la photo principale — inutilisable ici, mais
 *      c'est lui qui alimente `imageUrl`.
 *
 * D'où l'ordre de `extractPhotos()` : le flux d'abord pour la qualité maximale,
 * le DOM en repli. Les deux sont présents dans le HTML **servi**, ce qui les rend
 * lisibles aussi bien sur la page ouverte que sur le document `fetch()` de
 * l'enrichissement.
 *
 * Ce module ne dépend que d'un `Document` : il est testable seul, et le panneau
 * comme le content script peuvent l'appeler. Voir `docs/vinted-dom.md`.
 */
import type { ItemPhoto } from './types.ts';

/**
 * Forme d'une photo dans le flux RSC, réduite à ce qu'on en lit. Tout est
 * optionnel : c'est du contenu tiers, rien ne garantit sa structure.
 */
type RawPhoto = {
  image_no?: number;
  width?: number;
  height?: number;
  url?: string;
  full_size_url?: string;
  dominant_color?: string;
  is_hidden?: boolean;
  thumbnails?: { type?: string; url?: string }[];
};

/**
 * Le flux RSC transporte du JSON encodé dans une chaîne JavaScript : les
 * guillemets y sont échappés (`\"`). On accepte les deux formes — la seconde
 * n'est pas observée aujourd'hui, mais un flux non échappé ne doit pas faire
 * silencieusement disparaître la galerie.
 */
const GALLERY_MARKERS = ['\\"name\\":\\"gallery\\"', '"name":"gallery"'] as const;

/** Entre le bloc `gallery` et son `photos` : `item_id`, `seller_id`, guère plus. */
const HEADER_WINDOW = 400;

/** Un tableau de photos dépasse rarement 30 Ko ; au-delà, on ne balaie pas. */
const ARRAY_LIMIT = 200_000;

/** Par ordre de préférence : la miniature de la bande de navigation. */
const THUMB_TYPES = ['thumb310x430', 'thumb150x210', 'thumb70x100'] as const;

/**
 * Sous-chaîne du tableau qui commence au premier `[` après `from`, crochets
 * équilibrés. Les valeurs du tableau (URLs signées, nombres, couleurs hex) n'en
 * contiennent pas : inutile de suivre l'état « dans une chaîne ».
 *
 * @returns null si le tableau n'est pas refermé dans la limite balayée
 */
function balancedArray(source: string, from: number): string | null {
  const start = source.indexOf('[', from);
  if (start === -1) return null;

  const end = Math.min(source.length, start + ARRAY_LIMIT);
  let depth = 0;

  for (let i = start; i < end; i += 1) {
    const char = source[i];
    if (char === '[') depth += 1;
    else if (char === ']') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }

  return null;
}

/** Retient la meilleure miniature disponible, ou l'image d'affichage à défaut. */
function pickThumb(raw: RawPhoto, fallback: string): string {
  for (const type of THUMB_TYPES) {
    const found = raw.thumbnails?.find((thumb) => thumb.type === type)?.url;
    if (found) return found;
  }
  return fallback;
}

/**
 * Normalise, filtre et ordonne les photos brutes du flux.
 *
 * Une photo masquée par Vinted (`is_hidden`) ne doit pas réapparaître dans la
 * galerie, et une photo sans URL n'est rien : les deux sont écartées avant le
 * tri, qui suit `image_no` — l'ordre choisi par le vendeur, que l'ordre du
 * tableau ne garantit pas.
 */
function normalize(raws: RawPhoto[]): ItemPhoto[] {
  const photos: ItemPhoto[] = [];
  const seen = new Set<string>();

  const ordered = [...raws].sort(
    (a, b) => (a.image_no ?? Number.MAX_SAFE_INTEGER) - (b.image_no ?? Number.MAX_SAFE_INTEGER)
  );

  for (const raw of ordered) {
    if (raw.is_hidden) continue;

    const url = raw.url || raw.full_size_url;
    if (!url || seen.has(url)) continue;
    seen.add(url);

    const photo: ItemPhoto = {
      thumb: pickThumb(raw, url),
      url,
      full: raw.full_size_url || url,
    };

    if (typeof raw.width === 'number') photo.width = raw.width;
    if (typeof raw.height === 'number') photo.height = raw.height;
    if (raw.dominant_color) photo.dominantColor = raw.dominant_color;

    photos.push(photo);
  }

  return photos;
}

/**
 * Photos lues dans le flux React Server Components — la source complète.
 *
 * Le bloc visé porte son propre nom et l'article qu'il décrit :
 *
 *   {"name":"gallery","type":"gallery","section":"content",
 *    "data":{"item_id":9504133342,"seller_id":148532183,"photos":[…]}}
 *
 * Vérifier `item_id` juste après le marqueur n'est pas une précaution de
 * principe : la fiche affiche aussi le dressing du membre et les articles
 * similaires, et rien ne dit que Vinted continuera de les charger séparément
 * — le jour où leur bloc arrivera dans le HTML servi, la galerie de l'article
 * ne doit pas se retrouver mélangée à celle d'un voisin. C'est la même
 * précaution que dans `favouriteCountFromHydration()`.
 *
 * Le flux répète le bloc (5 fois sur une fiche observée) : le premier qui parse
 * suffit.
 */
export function photosFromHydration(doc: Document, itemId: string): ItemPhoto[] {
  for (const script of doc.querySelectorAll('script')) {
    const source = script.textContent;
    if (!source || source.indexOf('gallery') === -1) continue;

    for (const marker of GALLERY_MARKERS) {
      let at = source.indexOf(marker);

      while (at !== -1) {
        const header = source.slice(at, at + HEADER_WINDOW);
        const escaped = marker.startsWith('\\');
        const idPattern = escaped ? /\\"item_id\\":\s*(\d+)/ : /"item_id":\s*(\d+)/;

        if (header.match(idPattern)?.[1] === itemId) {
          const key = escaped ? '\\"photos\\":' : '"photos":';
          const keyAt = source.indexOf(key, at);
          const raw = keyAt === -1 ? null : balancedArray(source, keyAt);

          if (raw) {
            const json = escaped ? raw.replace(/\\"/g, '"').replace(/\\\\/g, '\\') : raw;
            try {
              const photos = normalize(JSON.parse(json) as RawPhoto[]);
              if (photos.length) return photos;
            } catch {
              // Bloc non parsable : on tente l'occurrence suivante.
            }
          }
        }

        at = source.indexOf(marker, at + 1);
      }
    }
  }

  return [];
}

/**
 * Photos lues dans le DOM de la fiche — repli, plafonné à `f800`.
 *
 * Vinted rend le carrousel plusieurs fois dans la même page (cinq exemplaires
 * sur une fiche observée : versions bureau, mobile, bande de miniatures). Sans
 * dédoublonnage, une fiche à trois photos en produirait quinze. Le `data-testid`
 * porte le numéro de la photo : il sert de clé, et d'ordre.
 */
export function photosFromDom(doc: Document): ItemPhoto[] {
  const byNumber = new Map<number, ItemPhoto>();
  const images = doc.querySelectorAll<HTMLImageElement>(
    '[data-testid^="item-photo-"][data-testid$="--img"]'
  );

  for (const img of images) {
    const no = Number(img.dataset.testid?.match(/^item-photo-(\d+)--img$/)?.[1]);
    if (!Number.isFinite(no) || byNumber.has(no)) continue;

    const url = img.getAttribute('src') || img.src;
    if (!url) continue;

    // Le DOM ne sert qu'une taille : elle fait office des trois. La galerie
    // reste utilisable, seul le zoom pleine résolution est perdu.
    byNumber.set(no, { thumb: url, url, full: url });
  }

  return [...byNumber.entries()].sort(([a], [b]) => a - b).map(([, photo]) => photo);
}

/**
 * Toutes les photos de la fiche, qualité maximale d'abord.
 *
 * @returns `undefined` plutôt qu'un tableau vide quand la fiche n'en donne
 *   aucune — **la distinction compte** : `mergeDetail()` ignore `undefined` mais
 *   recopierait un `[]`, et une extraction dégradée effacerait alors une galerie
 *   déjà lue.
 */
export function extractPhotos(doc: Document, itemId: string): ItemPhoto[] | undefined {
  const photos = photosFromHydration(doc, itemId);
  if (photos.length) return photos;

  const fallback = photosFromDom(doc);
  return fallback.length ? fallback : undefined;
}
