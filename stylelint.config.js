/**
 * Configuration stylelint.
 *
 * Au-delà du preset standard, une règle maison encode la règle 2 du projet :
 * pas de `transform` au survol de nos boutons injectés. Voir
 * `tools/stylelint-no-hover-transform.js` pour le bug qui la motive.
 */
export default {
  extends: ['stylelint-config-standard'],
  plugins: ['./tools/stylelint-no-hover-transform.js'],
  rules: {
    'vinted-favoris/no-hover-transform': true,

    // Les classes injectées dans le DOM de Vinted sont toutes préfixées `vf-`
    // pour ne jamais entrer en collision avec les siennes.
    'selector-class-pattern': [
      '^(vf-[a-z0-9-]+|[a-z][a-z0-9-]*)$',
      { message: 'Classe en kebab-case ; celles injectées chez Vinted sont préfixées « vf- ».' },
    ],

    // Le projet écrit ses couleurs en rgba() lisible plutôt qu'en notation moderne.
    'color-function-notation': 'legacy',
    'color-function-alias-notation': null,
    'alpha-value-notation': 'number',

    // Trop bruyante sur un CSS d'interface où les états (:hover, :focus-visible)
    // sont regroupés par composant plutôt que par spécificité croissante.
    'no-descending-specificity': null,
  },
};
