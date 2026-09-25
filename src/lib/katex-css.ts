import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

/**
 * KaTeX の CSS（cdn.jsdelivr.net の katex.min.css）を読み込む <link> の
 * href と integrity。SiteHead.astro が、数式のある Notion 記事でだけ使う。
 *
 * 版も integrity も、ビルド時にインストール済みの katex から求める。
 * 以前は SiteHead.astro に katex@0.16.4 の URL と integrity を直書き
 * していたが、数式を HTML にする katex（Equation.astro / RichText.astro の
 * renderToString）は package.json で ^0.16.19、インストール済みも 0.16.19
 * で、CSS だけ古い版を読み込んでいた（Issue #136）。直書きの値を 0.16.19
 * に書き換えるだけだと、次に katex が上がったときにまた食い違う。
 *
 * integrity をローカルのファイルから計算してよい根拠（2026-09-25 に実測）:
 *   - node_modules/katex/dist/katex.min.css（0.16.19、23352 バイト）と
 *     https://cdn.jsdelivr.net/npm/katex@0.16.19/dist/katex.min.css は
 *     バイト単位で同一で、sha384 は
 *     sha384-7lU0muIg/i1plk7MgygDUp3/bNRA65orrBub4/OSWHECgwEsY83HaS1x3bljA/XV
 *   - 以前の直書きの integrity（sha384-vKruj+a1...）は CDN の 0.16.4 の
 *     ハッシュと一致していた。値そのものは 0.16.4 として正しかった
 *   jsdelivr の npm の配信は、版を固定した URL ではパッケージのファイルを
 *   そのまま返すので、同じ版なら同じハッシュになる。
 *
 * CDN からの読み込みは続けている。katex の CSS を import して自サイトから
 * 配信する方法は採らなかった。Astro は import した CSS を «描画されたか
 * どうか» ではなく import の関係でページに含めるので、«数式のある記事で
 * だけ読み込む»（#135）を壊しやすく、フォントの同梱も要るため。
 *
 * 読めなかったときは例外を投げてビルドを止める。integrity 無しで出すと
 * SRI を外した状態になり、間違ったハッシュを出すとブラウザが CSS を
 * ブロックして数式の見た目が崩れる。どちらもビルドは通るので気づけない。
 */

// ファイルの場所は、カレントディレクトリ（リポジトリの直下。npm run の
// 実行位置）を起点に Node の解決規則で探す。起点はリポジトリの他の
// ファイル読み込み（archive-image-file.ts の 'public/archive/images' など）
// と同じカレントディレクトリにそろえ、探し方は `import katex from 'katex'`
// と同じ解決にする。'node_modules/katex/...' を直接組み立てると、katex が
// 別の場所に入った場合に «描画に使う katex» と別のものを読みうる。
// import.meta.url を起点にしないのは、ビルド時はこのモジュールが dist の
// 下のチャンクに束ねられて場所が変わるため。
// katex の package.json の exports には "./*": "./*" があるので、
// katex/package.json も katex/dist/katex.min.css も解決できる
// （0.16.19 で確認）
const requireFromCwd = createRequire(path.join(process.cwd(), 'package.json'))

const computeKatexCss = (): { href: string; integrity: string } => {
  try {
    const pkgPath = requireFromCwd.resolve('katex/package.json')
    const version: unknown = JSON.parse(
      fs.readFileSync(pkgPath, 'utf-8')
    ).version
    if (typeof version !== 'string' || !/^\d+\.\d+\.\d+/.test(version)) {
      throw new Error(`katex の version が読めない: ${String(version)}`)
    }
    const css = fs.readFileSync(
      requireFromCwd.resolve('katex/dist/katex.min.css')
    )
    const hash = createHash('sha384').update(css).digest('base64')
    return {
      href: `https://cdn.jsdelivr.net/npm/katex@${version}/dist/katex.min.css`,
      integrity: `sha384-${hash}`,
    }
  } catch (err) {
    throw new Error(
      'KaTeX の CSS の版と integrity を、インストール済みの katex から' +
        '求められなかった（src/lib/katex-css.ts）',
      { cause: err }
    )
  }
}

// モジュールの読み込み時に 1 回だけ計算する。ページごと（942 ページ）に
// ファイルを読んでハッシュを取り直す必要は無い
export const KATEX_CSS = computeKatexCss()
