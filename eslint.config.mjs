import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';
import globals from 'globals';
import prettier from 'eslint-config-prettier/flat';

export default defineConfig([
  globalIgnores([
    'node_modules/',
    'dist/',
    'demo/',
    '.test-output/',
    '.husky/_/',
    'test/demo.test.mjs',
    'test/fixtures/',
    '.readme-check.mts',
  ]),
  {
    files: ['**/*.{js,mjs,ts}'],
    languageOptions: { globals: globals.node, ecmaVersion: 'latest', sourceType: 'module' },
    extends: [js.configs.recommended],
    rules: {
      'no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
    },
  },
  {
    files: ['src/**/*.ts'],
    extends: [tseslint.configs.recommended],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
    },
  },
  prettier,
]);
