/**
 * Mode développeur : l'interrupteur de la bande d'outils de mise au point du
 * panneau (export JSON, diagnostic, déblocage du débit).
 *
 * Ces boutons ne s'adressent pas à l'utilisateur : ils sont là pour instruire
 * une panne. Ils restent donc invisibles tant qu'on ne les demande pas par le
 * clic droit sur l'icône de l'extension (« Ouvrir en mode développeur »).
 *
 * Le drapeau vit dans `chrome.storage.session`, pas dans `local` :
 *   — il ne survit pas à la fermeture de Chrome, ce qui est exactement la durée
 *     de vie voulue pour un mode de dépannage — personne ne le retrouve allumé
 *     des semaines plus tard ;
 *   — il n'entre donc pas dans les réglages (`Settings`), qui sont, eux, des
 *     choix durables de l'utilisateur, exportés et relus à chaque rendu.
 *
 * La règle 6 (tout passe par `update()` de `shared/storage.ts`) ne s'applique
 * pas ici : elle protège contre l'entrelacement de deux écritures concurrentes
 * sur `local`, alors que ce drapeau est un booléen écrit d'un seul endroit.
 */

/** Clé du drapeau dans `chrome.storage.session`. */
export const DEV_MODE_KEY = 'devMode';

/** Le mode développeur est-il actif dans cette session de navigateur ? */
export async function readDevMode(): Promise<boolean> {
  const stored: Record<string, unknown> = await chrome.storage.session.get(DEV_MODE_KEY);
  return stored[DEV_MODE_KEY] === true;
}

/**
 * Allume ou éteint le mode. L'extinction *retire* la clé plutôt que d'y écrire
 * `false` : l'absence est déjà l'état par défaut, deux façons de dire « non »
 * finiraient par diverger.
 */
export async function setDevMode(on: boolean): Promise<void> {
  if (on) await chrome.storage.session.set({ [DEV_MODE_KEY]: true });
  else await chrome.storage.session.remove(DEV_MODE_KEY);
}
