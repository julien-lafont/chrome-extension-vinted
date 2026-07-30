import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

/**
 * Configuration ESLint (flat config).
 *
 * Écrite en `.js` et non en `.ts` à dessein : un fichier de configuration en
 * TypeScript oblige ESLint à passer par un transpileur à chaque exécution, ce
 * qui ajoute une dépendance et un mode de panne pour zéro bénéfice ici.
 *
 * Trois blocs de règles au-delà des presets :
 *   — les globales Node sont interdites dans `src/` (le code tourne dans un
 *     navigateur, pas dans Node, alors que le tsconfig expose les deux) ;
 *   — les classes CSS obfusquées de Vinted sont interdites (règle 4 du projet) ;
 *   — l'outillage (`scripts/`, `tests/`) est en environnement Node.
 */
export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'artifacts/**',
      'node_modules/**',
      'coverage/**',
      // Markup Vinted authentique : ni formaté, ni linté, jamais réécrit à la main.
      'tests/fixtures/**',
    ],
  },

  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: {
          // Les fichiers de configuration et le plugin stylelint sont en `.js` et
          // hors du tsconfig (qui ne décrit que le code de l'extension) : sans ça,
          // le service de types refuse de les analyser.
          allowDefaultProject: ['*.js', 'tools/*.js'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Le code du projet préfère `type` partout ; l'uniformité facilite la relecture.
      '@typescript-eslint/consistent-type-definitions': ['error', 'type'],
      '@typescript-eslint/consistent-type-imports': 'error',

      // Une promesse non attendue, dans une extension, se traduit par une écriture
      // en storage qui n'a pas eu lieu — sans aucune erreur en console.
      //
      // `describe`/`test` de node:test renvoient une promesse que le runner
      // attend lui-même : les déclarer sûres évite d'avoir à parsemer les tests
      // de `void`, ce qui affaiblirait la règle là où elle sert vraiment.
      '@typescript-eslint/no-floating-promises': [
        'error',
        {
          allowForKnownSafeCalls: [
            {
              from: 'package',
              package: 'node:test',
              name: ['describe', 'it', 'test', 'before', 'after', 'beforeEach', 'afterEach'],
            },
          ],
        },
      ],

      // Les variables préfixées `_` sont des paramètres de signature imposés.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],

      eqeqeq: ['error', 'smart'],
      'no-var': 'error',
      'prefer-const': 'error',
    },
  },

  // --- Code de l'extension : navigateur uniquement -----------------------------
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      globals: { ...globals.browser, chrome: 'readonly' },
    },
    rules: {
      // Le tsconfig charge @types/node pour l'outillage : sans ce garde-fou, un
      // `process.env` dans un content script passerait le typecheck et casserait
      // seulement à l'exécution, dans Chrome, sans trace.
      'no-restricted-globals': [
        'error',
        { name: 'process', message: "Code navigateur : `process` n'existe pas dans Chrome." },
        { name: 'Buffer', message: "Code navigateur : `Buffer` n'existe pas dans Chrome." },
        { name: '__dirname', message: 'Code navigateur : pas de globales CommonJS.' },
        { name: 'require', message: 'Code navigateur : utiliser les imports ES.' },
      ],

      // Règle 4 du projet : Vinted obfusque ses classes CSS
      // (`Grid-module-scss-module__HmDNda__…`), leur hash change à chaque
      // déploiement. On s'ancre sur les `data-testid`.
      'no-restricted-syntax': [
        'error',
        {
          selector: 'Literal[value=/module-scss-module__|module__[A-Za-z0-9]{6,}__/]',
          message:
            'Classe CSS obfusquée de Vinted : elle changera au prochain déploiement. ' +
            "S'ancrer sur un data-testid — voir docs/vinted-dom.md.",
        },
        // Règle 6 du projet. Un `get` suivi d'un `set` laisse la boucle
        // d'événements passer la main entre les deux : deux écritures du même
        // contexte s'écrasent, sans erreur. `shared/storage.ts` est le seul
        // fichier autorisé à toucher l'API — d'où l'exception ci-dessous.
        {
          selector:
            "MemberExpression[object.object.object.name='chrome'][object.object.property.name='storage'][object.property.name='local'][property.name=/^(get|set|remove|clear)$/]",
          message:
            'Écrire ou lire le storage passe par `shared/storage.ts` (read/update) : ' +
            "l'accès direct rouvre la fenêtre d'entrelacement — voir CLAUDE.md, règle 6.",
        },
      ],

      // Le diagnostic passe par le panneau, pas par la console (voir CLAUDE.md) ;
      // `console.error` reste permis pour ce qui ne doit jamais passer inaperçu.
      'no-console': ['error', { allow: ['error', 'warn'] }],
    },
  },

  // Le seul fichier qui a le droit de parler à `chrome.storage.local` : c'est
  // lui qui implémente la relecture-écriture sérialisée que les autres utilisent.
  {
    files: ['src/shared/storage.ts'],
    rules: {
      'no-restricted-syntax': 'off',
    },
  },

  // --- Outillage : environnement Node ------------------------------------------
  {
    files: ['scripts/**/*.ts', 'tests/**/*.ts', 'eslint.config.js', '*.config.js'],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      'no-console': 'off',
    },
  },

  // Les tests manipulent des objets jsdom typés `any` par nature ; exiger le
  // typage strict des accès DOM simulés apporterait du bruit, pas de sûreté.
  {
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
    },
  },

  // Le plugin stylelint dialogue avec l'API PostCSS, que stylelint ne type pas
  // pour cet usage : chaque `rule.walkDecls` devient un accès sur `any`. Plutôt
  // que de parsemer 15 exceptions dans 50 lignes, on renonce au lint typé sur
  // l'outillage en `.js` — les règles non typées, elles, s'appliquent toujours.
  {
    files: ['tools/**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },

  // Doit rester en dernier : neutralise les règles qui entreraient en conflit
  // avec le formatage de Prettier.
  prettier
);
