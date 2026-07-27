/**
 * Message lisible d'une erreur attrapée.
 *
 * `catch (err)` donne un `unknown` : ce qui arrive là peut être une `Error`, une
 * chaîne, ou l'objet que Chrome pose dans `chrome.runtime.lastError`. Le détail
 * finit dans l'interface ou dans un rapport de diagnostic, jamais dans un
 * `throw` : mieux vaut une chaîne approximative qu'une exception de plus en
 * cours de traitement d'erreur.
 */
export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;

  if (typeof error === 'object' && error !== null) {
    // Récursif : rien ne garantit que `message` soit lui-même une chaîne.
    if ('message' in error) return errorText(error.message);

    // `String()` sur un objet donnerait « [object Object] », qui n'apprend rien.
    return JSON.stringify(error);
  }

  return String(error);
}
