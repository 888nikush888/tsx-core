import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// Codacy runs this rule in its analyzer. Declaring the namespace keeps reviewed
// inline exceptions parseable locally without enabling a second implementation.
const codacySecurityNamespace = {
  rules: {
    'detect-non-literal-fs-filename': { meta: { schema: [] }, create: () => ({}) },
  },
};

export default [
  {
    ignores: [
      'backups/**',
      'coverage/**',
      'dist/**',
      'frontend/**',
      'logs/**',
      'node_modules/**',
      'reports/**',
      'session_data/**',
      'session_files/**',
      'signals/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: { security: codacySecurityNamespace },
  },
  {
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: globals.node,
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'off',
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      complexity: ['warn', 15],
      'max-depth': ['warn', 4],
      'max-lines-per-function': ['warn', { max: 100, skipBlankLines: true, skipComments: true }],
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-control-regex': 'off',
      'no-empty': ['warn', { allowEmptyCatch: false }],
      'no-useless-assignment': 'off',
      'no-unused-vars': 'off',
    },
  }
];
