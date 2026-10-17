import { defineConfig } from 'eslint/config';
import typescriptEslint from '@typescript-eslint/eslint-plugin';
// astro-eslint-parser 3（eslint-plugin-astro 3 が依存）は default export を
// やめ、名前付き export（parseForESLint など）だけになった。パーサーとして
// 必要なのは parseForESLint を持つオブジェクトなので、名前空間ごと渡す
import * as parser from 'astro-eslint-parser';
import astro from 'eslint-plugin-astro';
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
  // eslint-plugin-astro 3 は eslintrc 形式の設定を持たなくなり、
  // configs.recommended が flat config の配列になった。FlatCompat の
  // 'plugin:astro/recommended' では読めないので、flat config のまま並べる。
  // 他の 2 つは下の no-redeclare の注記のとおり FlatCompat 経由の解決に
  // 依存しているので、そちらはそのまま残す
  ...astro.configs.recommended,
  {
    extends: compat.extends(
      // eslint:recommended を入れていなかったため、ESLint 本体のルールが
      // 一切効いていなかった。`let icon` と `const icon` の二重宣言を
      // lint が素通りし、astro check のビルドで初めて気づいた実例がある
      'eslint:recommended',
      'plugin:@typescript-eslint/recommended'
    ),

    plugins: {
      '@typescript-eslint': typescriptEslint,
    },

    rules: {
      '@typescript-eslint/no-unused-vars': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      // ESLint 本体の no-redeclare は @typescript-eslint/recommended が
      // 無効化するため、TypeScript 版を明示的に有効にする。
      // NOTE: この無効化は FlatCompat（compat.extends）を通した legacy 解決の
      // 結果としてのみ現れ、プラグインの configs.recommended.rules を直接見ても
      // 分からない。将来 FlatCompat を外して native flat config に移行する際は、
      // この行がまだ必要かを compat 抜きで再確認すること
      '@typescript-eslint/no-redeclare': 'error',
    },
  },
  {
    files: ['**/*.astro'],

    languageOptions: {
      parser: parser,
      // flat config では、Promise や Map などの組み込みのグローバルは
      // ecmaVersion から決まる。以前は eslint-plugin-astro 1 の eslintrc 版
      // recommended が env: es2020 でそれらを足していたので 5 のままでも
      // 動いていたが、3 の flat config 版は足さないため、5 だと
      // 'Promise' is not defined が 15 件出る。足されていた範囲と同じ
      // ES2020 にそろえる
      ecmaVersion: 2020,
      sourceType: 'script',

      parserOptions: {
        parser: '@typescript-eslint/parser',
        extraFileExtensions: ['.astro'],
      },
    },

    rules: {},
  },
  {
    // eslint-plugin-astro 3 の recommended は <script> の中身も lint する
    // （processor: astro/client-side-ts）。GA の公式スニペットの gtag() は
    // arguments をそのまま dataLayer に積む必要があり、rest 引数の配列に
    // 置き換えると gtag.js が命令として解釈しなくなる。ここだけ外す
    files: ['src/components/GoogleAnalytics.astro/*.ts'],
    rules: {
      'prefer-rest-params': 'off',
    },
  },
]);
