/**
 * Commits conventionnels (`feat:`, `fix:`, `docs:`…).
 *
 * Ce n'est pas de la cérémonie : le `CHANGELOG` et le choix de la version d'une
 * release se lisent directement dans les messages. Un historique où tout
 * s'appelle « wip » oblige à relire les diffs pour savoir ce qu'une version
 * apporte.
 *
 * Le sujet reste en français, comme le reste du projet ; seul le préfixe est
 * normalisé.
 */
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    // Portées utiles sur ce dépôt, pour ne pas en inventer une par commit.
    'scope-enum': [
      2,
      'always',
      ['content', 'sidepanel', 'background', 'shared', 'build', 'tests', 'ci', 'docs', 'deps'],
    ],

    // Les sujets en français commencent souvent par un nom propre ou un accent :
    // imposer une casse ferait plus de bruit que de bien.
    'subject-case': [0],

    // 100 caractères, comme la largeur du code.
    'header-max-length': [2, 'always', 100],
  },
};
