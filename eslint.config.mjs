import { defineConfig } from 'eslint/config';
import typescriptEslint from '@typescript-eslint/eslint-plugin';
import parser from 'astro-eslint-parser';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import js from '@eslint/js';
import { FlatCompat } from '@eslint/eslintrc';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const compat = new FlatCompat({
  baseDirectory: __dirname,
  recommendedConfig: js.configs.recommended,
  allConfig: js.configs.all,
});

export default defineConfig([
  {
    extends: compat.extends(
      // eslint:recommended を入れていなかったため、ESLint 本体のルールが
      // 一切効いていなかった。`let icon` と `const icon` の二重宣言を
      // lint が素通りし、astro check のビルドで初めて気づいた実例がある
      'eslint:recommended',
      'plugin:@typescript-eslint/recommended',
      'plugin:astro/recommended'
    ),

    plugins: {
      '@typescript-eslint': typescriptEslint,
    },

    rules: {
      '@typescript-eslint/no-unused-vars': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      // ESLint 本体の no-redeclare は @typescript-eslint/recommended が
      // 無効化するため、TypeScript 版を明示的に有効にする
      '@typescript-eslint/no-redeclare': 'error',
    },
  },
  {
    files: ['**/*.astro'],

    languageOptions: {
      parser: parser,
      ecmaVersion: 5,
      sourceType: 'script',

      parserOptions: {
        parser: '@typescript-eslint/parser',
        extraFileExtensions: ['.astro'],
      },
    },

    rules: {},
  },
]);
