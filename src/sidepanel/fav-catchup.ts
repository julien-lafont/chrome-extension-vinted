/**
 * Les deux rattrapages de la synchro des favoris, côté panneau — clic droit sur
 * « Sync favoris ». Voir `docs/specs/favoris-sync.md` §5.
 *
 * Même architecture que le balayage des offres : le panneau **n'émet aucune
 * requête** vers Vinted, il élit un onglet et lui passe l'ordre. Ce n'est pas
 * une question de style — l'API des favoris répond 403 sans cookies de session,
 * et le jeton anti-CSRF ne se lit que dans une page.
 *
 * La différence avec les autres ordres du panneau : ici il **attend la
 * réponse**. Le résultat est un compte, il n'existe nulle part en storage où
 * aller le relire, et l'utilisateur vient de cliquer — il lui faut un retour.
 */
import type { FavCatchupResponse } from '../shared/messages.ts';
import { findVintedTab } from './watch.ts';

/** Ce que le panneau affiche à l'issue d'un rattrapage. */
export type CatchupOutcome = { message: string; ok: boolean };

const PHRASES: Record<string, string> = {
  'jeton absent': 'Vinted ne répond pas — recharge un onglet Vinted et réessaie',
  'compte inconnu': 'Session Vinted expirée — reconnecte-toi',
  freiné: 'Vinted freine les requêtes — réessaie dans quelques minutes',
  réseau: 'La liste des favoris Vinted n’a pas pu être lue',
};

/** Accord en nombre, pour que le compte-rendu se lise. */
const plural = (count: number, one: string, many: string): string =>
  `${count} ${count > 1 ? many : one}`;

async function send(type: 'VF_FAV_IMPORT' | 'VF_FAV_PUSH'): Promise<FavCatchupResponse | null> {
  const tab = await findVintedTab();
  if (!tab?.id) return null;

  // Content script pas encore injecté (onglet ouvert avant la dernière mise à
  // jour de l'extension) : Chrome rend une erreur laconique, qu'on traduit en
  // « pas d'onglet utilisable » plutôt que de la laisser remonter.
  return (await chrome.tabs
    .sendMessage(tab.id, { type })
    .catch(() => null)) as FavCatchupResponse | null;
}

const NO_TAB = {
  message: 'Ouvre un onglet Vinted pour lancer le rattrapage',
  ok: false,
};

/** Enregistre les favoris Vinted absents du panneau. N'écrit rien chez Vinted. */
export async function importFromVinted(): Promise<CatchupOutcome> {
  const result = await send('VF_FAV_IMPORT');
  if (!result) return NO_TAB;
  if (result.stopped) return { message: PHRASES[result.stopped] ?? result.stopped, ok: false };

  if (!result.done) {
    return {
      message: result.skipped
        ? 'Tes favoris Vinted sont déjà tous enregistrés'
        : 'Aucun favori Vinted à importer',
      ok: true,
    };
  }

  return { message: `${plural(result.done, 'article importé', 'articles importés')}`, ok: true };
}

/** Met en favori chez Vinted les articles enregistrés qui ne le sont pas. */
export async function pushToVinted(): Promise<CatchupOutcome> {
  const result = await send('VF_FAV_PUSH');
  if (!result) return NO_TAB;

  // Un arrêt en cours de route a pu poser des cœurs avant de s'interrompre : on
  // le dit, plutôt que de laisser croire que rien n'est parti.
  if (result.stopped) {
    const reason = PHRASES[result.stopped] ?? result.stopped;
    return {
      message: result.done
        ? `${plural(result.done, 'cœur posé', 'cœurs posés')} — ${reason}`
        : reason,
      ok: false,
    };
  }

  if (!result.done) {
    return {
      message: result.skipped
        ? 'Tous tes articles sont déjà en favoris sur Vinted'
        : 'Aucun article à mettre en favori',
      ok: true,
    };
  }

  const rest = result.remaining ? ` — ${result.remaining} restants, relance pour la suite` : '';
  return { message: `${plural(result.done, 'cœur posé', 'cœurs posés')}${rest}`, ok: true };
}
