import type { Root, RootContent } from 'mdast'
import { ARCHIVE_IMAGE_URL_PREFIX } from './archive-image-file'
import { getStaticFilePath } from './blog-helpers'

/**
 * アーカイブ記事の生 HTML にある <img src="images/..."> を
 * /archive/images/... に書き換える remark プラグイン（#126）。
 *
 * 移行した記事の画像は public/archive/images/ にあるが、生 HTML の一部は
 * src="images/x.jpg" と «相対パス» で書かれている。相対パスは記事の URL
 * （/archive/372/）を起点に解決されるので /archive/372/images/x.jpg を
 * 見に行き、本番で 404 になっていた（実ファイルは /archive/images/ で 200）。
 * 実測では 609 記事のうち 9 記事に 13 個あり、うち 12 個は商品紹介の枠に
 * 置いた Amazon のサムネイル（_SL160_）で、読者には画像の欠けた枠が見えていた。
 *
 * md ファイルは書き換えない。移行した記事は原文のまま置く方針
 * （rehype-archive-headings.ts 参照）なので、ビルド時に直す。
 *
 * rehype ではなく remark で直すのは、@astrojs/markdown-remark が
 * ユーザーの rehype プラグインを rehypeRaw より «前» に走らせるため
 * （node_modules/@astrojs/markdown-remark/dist/index.js で rehypePlugins の
 * 後に rehypeRaw を use している）。rehype の段階では生 HTML はまだ raw
 * ノードの文字列で、<img> の element として見えない。mdast の html ノードの
 * 文字列を書き換えれば、後段の rehypeRaw がそれを element にする。
 *
 * remark-archive-images.ts に足さず別のプラグインにしたのは、向こうは
 * 本文を «読むだけ» で frontmatter に URL を渡す作りで、構文木を書き換える
 * 処理を同居させると «読むだけ» という前提が崩れるため。
 * astro.config.mjs ではこちらを remarkArchiveImages より前に置き、直した
 * URL が本文の画像として og:image の候補集め（bodyImages）にも届くようにする。
 */

// 書き換える対象は src が images/ で始まるものだけ。
// 実データ（609 記事の html ノード）で見ると:
// - images/ … 13 個（すべて public/archive/images/ に実在）
// - ./images/ … 0 個
// - ../images/ … 0 個。あっても /archive/<slug>/ から解決すると
//   /archive/images/ になり正しく表示されるので、触ってはいけない
const RELATIVE_PREFIX = 'images/'

// <img> タグ 1 つ分。属性値に > を含む記事は無い（該当 13 個の alt も含む）
const IMG_TAG = /<img\b[^>]*>/gi

// タグの中の src 属性。前が空白であることを求めるので srcset= や data-src= は
// 拾わない（srcset は \s*= の前に set が挟まり、data-src は前が - になる）。
// 引用符は "..." / '...' / 無し のいずれも受け、大文字小文字（SRC=）も区別しない。
// 属性名と値の書き方は remark-archive-images.ts の IMG_SRC と揃えてある
const SRC_ATTR = /(\ssrc\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i

// BASE_PATH を付けた /archive/images/。記事中の他の画像（/archive/images/...）は
// BASE_PATH 無しで書かれているが、archiveImageName() は BASE_PATH 付きも
// 受けるので、どちらの形でも og:image の候補集めから外れない
const ARCHIVE_IMAGE_BASE = getStaticFilePath(ARCHIVE_IMAGE_URL_PREFIX)

const fixSrc = (value: string): string | null => {
  if (!value.startsWith(RELATIVE_PREFIX)) return null
  // images/ より後ろはそのまま残す。706 の 61%2BOQxVZlSL._SL160_.jpg
  // （実ファイル名は 61+OQxVZlSL._SL160_.jpg）もデコードしない。
  // 本番（2026-09-24）で /archive/images/61%2BOQxVZlSL._SL160_.jpg と
  // /archive/images/61+OQxVZlSL._SL160_.jpg はどちらも 200 で、
  // Content-Length 11029・ETag も同一だった。他の記事の %2B を含む参照
  // （/archive/images/ を指すもの）も同じ書き方で表示できている
  return `${ARCHIVE_IMAGE_BASE}/${value.slice(RELATIVE_PREFIX.length)}`
}

const rewriteImgTag = (tag: string): string =>
  tag.replace(
    SRC_ATTR,
    (whole, head: string, dq?: string, sq?: string, bare?: string) => {
      const value = dq ?? sq ?? bare ?? ''
      const fixed = fixSrc(value)
      if (fixed === null) return whole
      // 元の引用符をそのまま使う。引用符無しの値は引用符無しで返すと
      // 値の中身次第で壊れうるので "..." で包む
      if (dq !== undefined) return `${head}"${fixed}"`
      if (sq !== undefined) return `${head}'${fixed}'`
      return `${head}"${fixed}"`
    }
  )

const visit = (node: Root | RootContent): void => {
  if (node.type === 'html') {
    node.value = node.value.replace(IMG_TAG, rewriteImgTag)
  }
  if ('children' in node) {
    for (const child of node.children) visit(child)
  }
}

export default function remarkArchiveRelativeImages() {
  return (tree: Root): void => {
    visit(tree)
  }
}
