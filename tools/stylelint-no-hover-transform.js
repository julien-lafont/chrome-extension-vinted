import stylelint from 'stylelint';

const ruleName = 'vinted-favoris/no-hover-transform';

const messages = stylelint.utils.ruleMessages(ruleName, {
  rejected: (selector) =>
    `« transform » interdit au survol (${selector}). Déplacer un bouton sous le curseur ` +
    `le fait sortir de sa propre zone de survol près des bords : le navigateur alterne ` +
    `hover/unhover et avale le clic. Ne changer que des propriétés de peinture ` +
    `(background, box-shadow, color). Voir docs/pitfalls.md.`,
});

/**
 * Règle 2 du projet, rendue mécanique.
 *
 * Elle vient d'un bug réel et silencieux : le bouton « Enregistrer » de la fiche
 * article oscillait au survol et le clic n'était jamais émis. Le correctif avait
 * été appliqué à `.vf-detail-btn` mais pas à `.vf-card-btn`, qui a gardé son
 * `transform: scale()` pendant des mois — exactement le genre de régression
 * qu'un commentaire ne suffit pas à empêcher.
 *
 * Ne concerne que nos propres sélecteurs (`.vf-`) : le CSS du panneau latéral
 * vit dans un document que nous contrôlons entièrement, où le problème ne se
 * pose pas de la même façon.
 */
const ruleFunction = (primary) => {
  return (root, result) => {
    const validOptions = stylelint.utils.validateOptions(result, ruleName, {
      actual: primary,
      possible: [true],
    });
    if (!validOptions) return;

    root.walkRules((rule) => {
      if (!rule.selector.includes(':hover')) return;
      if (!rule.selector.includes('.vf-')) return;

      rule.walkDecls(/^transform$/, (decl) => {
        stylelint.utils.report({
          message: messages.rejected(rule.selector),
          node: decl,
          result,
          ruleName,
        });
      });
    });
  };
};

ruleFunction.ruleName = ruleName;
ruleFunction.messages = messages;
ruleFunction.meta = {
  url: 'https://github.com/julienlafont/vinted-favoris/blob/main/docs/pitfalls.md',
};

export default stylelint.createPlugin(ruleName, ruleFunction);
