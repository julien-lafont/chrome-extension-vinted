/**
 * Synchronisation des favoris — la moitié « lecture », dans la page.
 *
 * Voir `docs/specs/favoris-sync.md`. Ce module ne fait qu'une chose : constater
 * qu'un cœur Vinted **vient de changer d'état**, et le dire. Ce qu'on en fait
 * (enregistrer, archiver) appartient à `content.ts`, et la décision elle-même à
 * `shared/fav-sync.ts`.
 *
 * **On observe le résultat, jamais le geste.** Intercepter le clic sur le cœur
 * dirait l'intention, pas ce qui s'est produit : la requête de Vinted peut
 * échouer, et le favori peut aussi bouger sans clic sur cette page — un autre
 * onglet, l'application mobile, le bouton de la page « Favoris ». `aria-pressed`
 * est le seul témoin qui vaille, et c'est Vinted qui l'écrit.
 *
 * **Un état inconnu n'est pas une transition.** Une carte qu'on voit pour la
 * première fois, un bouton pas encore hydraté : on note et on se tait. Sans
 * cette règle, chaque chargement de page ferait constater le retrait de tous les
 * favoris qu'on n'avait jamais vus — c'est-à-dire exactement le contraire de ce
 * que l'utilisateur a fait.
 */
import { FAVOURITE_SELECTOR, favouriteTargetId, readFavouriteState } from './extract.ts';

/**
 * Plafond du relevé d'états. Un défilement infini de catalogue fait défiler des
 * milliers de cartes dans une seule page ; la borne évite que l'onglet laissé
 * ouvert une journée n'accumule sans fin. L'éviction ne fait perdre qu'une
 * chose : la capacité de constater une transition sur une carte oubliée, et
 * l'oubli penche donc du côté du silence — jamais de l'action.
 */
const MAX_KNOWN = 5000;

export type FavWatcher = {
  /**
   * Relève l'état des cœurs présents et signale ceux qui ont changé. Idempotent
   * et sans écriture dans le DOM : appelable à chaque scan sans risque de
   * boucle de repeint (règle 3).
   */
  sweep: () => void;
  /** Branche l'observation d'`aria-pressed`. À n'appeler qu'une fois. */
  observe: (root: Node) => void;
  /** Nombre d'états connus, pour le diagnostic. */
  size: () => number;
};

export type FavWatcherDeps = {
  /**
   * @param favourite l'état **après** la transition
   */
  onTransition: (id: string, favourite: boolean) => void;
  /** L'URL courante, pour rattacher le cœur d'une fiche à son article. */
  currentUrl?: () => string;
};

export function createFavWatcher({ onTransition, currentUrl }: FavWatcherDeps): FavWatcher {
  /** Dernier état connu, par article. Une clé absente = jamais vu. */
  const known = new Map<string, boolean>();

  const note = (id: string, favourite: boolean): void => {
    const before = known.get(id);

    // Réinsertion volontaire : `Map` conserve l'ordre d'insertion, et c'est lui
    // qui désigne le plus ancien à évincer ci-dessous. Sans le retrait
    // préalable, une carte revue mille fois garderait son rang initial.
    known.delete(id);
    known.set(id, favourite);

    if (known.size > MAX_KNOWN) {
      const oldest = known.keys().next();
      if (!oldest.done) known.delete(oldest.value);
    }

    if (before === undefined || before === favourite) return;
    onTransition(id, favourite);
  };

  const url = currentUrl ?? ((): string => location.href);

  const readAll = (scope: ParentNode): void => {
    for (const btn of scope.querySelectorAll(FAVOURITE_SELECTOR)) {
      const favourite = readFavouriteState(btn);
      if (favourite === null) continue;

      const id = favouriteTargetId(btn, url());
      if (id) note(id, favourite);
    }
  };

  return {
    sweep: () => {
      readAll(document);
    },

    /**
     * `aria-pressed` change **sans mutation de structure** : le `MutationObserver`
     * de `content.ts`, qui ne surveille que `childList`, ne voit rien passer.
     * D'où cet observateur séparé, restreint au seul attribut qui nous intéresse.
     *
     * Nos propres boutons en portent un eux aussi ; ils ne sont pas filtrés à
     * l'inscription — `attributeFilter` ne sait pas trier par sélecteur — mais
     * par `FAVOURITE_SELECTOR` à la lecture. Aucun risque de boucle pour autant :
     * ce module ne fait que lire.
     */
    observe: (root: Node) => {
      const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          const target = mutation.target;
          if (!(target instanceof Element) || !target.matches(FAVOURITE_SELECTOR)) continue;

          const favourite = readFavouriteState(target);
          if (favourite === null) continue;

          const id = favouriteTargetId(target, url());
          if (id) note(id, favourite);
        }
      });

      observer.observe(root, {
        subtree: true,
        attributes: true,
        attributeFilter: ['aria-pressed'],
      });
    },

    size: () => known.size,
  };
}

/**
 * Ce qu'a donné une tentative de mise à l'état voulu dans la page.
 *
 * `absent` n'est pas un échec : c'est le cas normal d'un article retiré depuis
 * le panneau, dont aucune carte n'est à l'écran. L'appelant le porte alors à la
 * file d'intentions, qu'un onglet videra par l'API.
 */
export type HeartOutcome = 'unchanged' | 'clicked' | 'absent' | 'unknown';

/** Le cœur Vinted de cet article dans la page, s'il y en a un. */
export function heartFor(id: string, doc: Document, url: string): HTMLElement | null {
  for (const btn of doc.querySelectorAll<HTMLElement>(FAVOURITE_SELECTOR)) {
    if (favouriteTargetId(btn, url) === id) return btn;
  }
  return null;
}

/**
 * Met le cœur Vinted à l'état voulu **en cliquant celui de Vinted**.
 *
 * C'est le chemin à privilégier partout où la carte est à l'écran, et de loin :
 * Vinted fait sa propre requête, avec son propre jeton, puis repeint son bouton,
 * son compteur et son icône. On n'a ni API à appeler, ni jeton à extraire, ni
 * rendu à réimplémenter — et l'utilisateur voit le cœur rougir à l'instant où il
 * enregistre, ce qui est précisément ce qu'on veut lui montrer.
 *
 * Trois précautions :
 *
 * - **on ne clique que si l'état diffère.** Le bouton de Vinted est une bascule :
 *   cliquer un cœur déjà rouge le retirerait ;
 * - **un état illisible ne se devine pas.** Sur une fiche, le bouton arrive
 *   `disabled` et nu le temps de l'hydratation ; `readFavouriteState()` rend
 *   alors `null`, et un clic à l'aveugle aurait une chance sur deux de faire
 *   l'inverse. On rend `unknown`, et l'appelant repasse par la file ;
 * - **`click()` et non `pointerdown`.** La règle 1 du projet vaut pour *nos*
 *   boutons, où le navigateur peut supprimer le `click` d'un geste humain. Ici
 *   on émet l'événement nous-mêmes, sur le bouton de Vinted, dont le gestionnaire
 *   React écoute `click` — c'est exactement ce que produit une activation au
 *   clavier.
 */
export function setHeart(id: string, want: boolean, doc: Document, url: string): HeartOutcome {
  const btn = heartFor(id, doc, url);
  if (!btn) return 'absent';

  const current = readFavouriteState(btn);
  if (current === null) return 'unknown';
  if (current === want) return 'unchanged';

  btn.click();
  return 'clicked';
}
