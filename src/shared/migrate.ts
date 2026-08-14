/**
 * Vinted Smart Bookmarks — mises à niveau du storage.
 *
 * **Ce module ne conditionne aucune lecture.** Tout ce qu'il nettoie est déjà
 * compris par le code qui lit (`classifiedIn()` traite `collectionId:
 * 'default'` et les références mortes comme « non classé ») : un storage resté
 * en version 1 s'affiche exactement pareil. C'est délibéré — une migration dont
 * dépendrait l'affichage transformerait le moindre échec d'écriture en
 * extension cassée, alors qu'ici l'échec ne coûte qu'un passage de plus au
 * prochain chargement.
 *
 * Elle n'existe donc que pour l'hygiène : un `collectionId` qui ne veut plus
 * rien dire finit par être lu comme s'il voulait dire quelque chose, dans un
 * export, un diagnostic ou une session future.
 *
 * Lancée depuis le panneau seul (`readAll()`), pas depuis le content script :
 * elle n'a rien d'urgent, et faire relire le storage à chaque page Vinted
 * chargée coûterait plus que ce qu'elle rapporte.
 */
import { DEFAULT_COLLECTION_ID } from './collections.ts';
import { COLLECTIONS_KEY, ITEMS_KEY, SETTINGS_KEY, update } from './storage.ts';
import type { ItemMap, SavedItem } from './types.ts';

/**
 * Version courante du modèle.
 *
 * 2 — « Mes favoris » devient un récapitulatif : plus aucun article n'y est
 *     *rangé*, `collectionId` ne porte plus qu'un classement facultatif.
 */
export const SCHEMA_VERSION = 2;

/**
 * Nettoie le storage si besoin. Idempotente, et sans effet une fois à jour :
 * l'appeler à chaque ouverture du panneau ne coûte qu'une lecture.
 *
 * @returns le nombre d'articles dont le `collectionId` a été effacé
 */
export async function migrateStorage(): Promise<number> {
  let cleaned = 0;

  await update([ITEMS_KEY, COLLECTIONS_KEY, SETTINGS_KEY], (current) => {
    const settings = current[SETTINGS_KEY];
    if ((settings?.schemaVersion ?? 1) >= SCHEMA_VERSION) return null;

    const items = current[ITEMS_KEY] || {};
    const collections = current[COLLECTIONS_KEY] || {};

    const nextItems: ItemMap = {};
    for (const [id, item] of Object.entries(items)) {
      // « Rangé dans Mes favoris » et « rangé dans une collection disparue »
      // disent tous deux « non classé » depuis que le récapitulatif existe :
      // seule l'absence du champ l'écrit encore.
      const stale =
        item.collectionId !== undefined &&
        (item.collectionId === DEFAULT_COLLECTION_ID || !collections[item.collectionId]);

      if (!stale) {
        nextItems[id] = item;
        continue;
      }

      const next: SavedItem = { ...item };
      delete next.collectionId;
      nextItems[id] = next;
      cleaned += 1;
    }

    // `collections.default.order` est conservé tel quel : c'était déjà l'ordre
    // manuel des articles non classés, il devient celui de la vue globale sans
    // rien perdre. Les articles classés ailleurs n'y figurent simplement pas
    // encore, et un tri personnalisé les place en tête par date d'ajout.
    //
    // `savedItems` n'est réécrite que s'il y avait quelque chose à y nettoyer :
    // sur une installation neuve, la clé n'existe pas encore et l'écrire vide
    // ferait naître une clé que personne n'a demandée — et un `onChanged` de
    // plus au premier lancement.
    return {
      ...(cleaned ? { [ITEMS_KEY]: nextItems } : {}),
      [SETTINGS_KEY]: { ...settings, schemaVersion: SCHEMA_VERSION },
    };
  });

  return cleaned;
}
