import type { Root, RootContent } from 'mdast'
import { archiveImageFilePath } from './archive-image-file'
import { imageSize } from './image-size'
import { decodeEntities } from './remark-archive-images'

/**
 * アーカイブ記事の生 HTML にある <img> に width / height を足す
 * remark プラグイン（#152）。
 *
 * markdown の ![](...) には rehype-image-dimensions.ts が寸法を付けるが、
 * 生 HTML の <img> には付かない。@astrojs/markdown-remark はユーザーの
 * rehype プラグインを rehypeRaw より «前» に走らせるので、rehype の段階では
 * 生 HTML はまだ raw ノードの文字列で、<img> の element として見えないため
 * （remark-archive-relative-images.ts の冒頭のコメント参照）。
 * 実測（2026-09-25、main のビルド）では、/archive/images/ を指すのに
 * width / height の無い本文の <img> が 609 記事で 12 個あり、すべてこの経路
 * （687, 693, 699×2, 706×2, 720×2, 722, 724×2, 729 の Amazon のサムネイル。
 * 長辺 160px、短辺 39〜160px）だった。寸法が無いと画像が届くまで高さ 0 として
 * 扱われ、届いた時点で下の本文が押し下げられる（CLS）。
 *
 * そこで rehypeRaw より前の remark の段階で、mdast の html ノードの文字列に
 * 属性を書き足す。後段の rehypeRaw がそれを element にする。
 *
 * remark-archive-relative-images.ts に足さず別のプラグインにしたのは、
 * 向こうは «相対パスの src を直す»（#126）ためのもので、対象も images/ で
 * 始まる src に限っている。こちらは «/archive/images/ を指す生 <img> 全部» が
 * 対象で、原文から /archive/images/ と書かれた <img> が今後入っても同じように
 * 寸法を足したい。rehype-image-dimensions.ts が markdown の画像に対して
 * やっていることの生 HTML 版なので、関心で分けた。
 * その代わり順序の制約がある。astro.config.mjs では
 * remarkArchiveRelativeImages より «後» に置くこと。前に置くと、src がまだ
 * images/... のままで archiveImageFilePath() が対象外と判定し、12 個とも
 * 黙って寸法が付かない（ビルドは通る）。
 *
 * ファイルの読み方は rehype-image-dimensions.ts と揃えてある。URL から
 * ファイルへの変換は archiveImageFilePath() を通し（public/archive/images/
 * の外は読まない）、寸法が読めなければ何も足さない。
 *
 * Issue では 16 個と数えていたが、残りの 4 個（2299 の 2 個、2705 の 2 個）は
 * markdown の画像で、mdast でも image ノード、hast でも img の element として
 * 見えており、rehype-image-dimensions.ts が正しい寸法を既に付けていた。
 * alt に <上> <RELISH> のような «>» を含むので、出力を /<img[^>]*>/ で
 * 数えると width の手前でタグが切れ、付いていないように見えただけ。
 * 出力を数えるときは HTML パーサーを通すこと。
 */

// <img> タグ 1 つ分。属性値に > を含む生 <img> は無い
// （609 記事の html ノードにある <img> 19 個で確認）
const IMG_TAG = /<img\b[^>]*>/gi

// 属性を 1 つずつ取り出す。値を丸ごと読み飛ばすので、
// alt="... width=1 ..." のような «値の中の» 文字列を属性と取り違えない。
// 値の書き方（"..." / '...' / 引用符無し）は remark-archive-relative-images.ts の
// SRC_ATTR と揃えてある
const ATTR =
  /\s+([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g

const addDimensions = (tag: string): string => {
  const attrs = new Map<string, string>()
  for (const match of tag.slice('<img'.length).matchAll(ATTR)) {
    // HTML の属性名は大文字小文字を区別しない。同名が 2 回あれば
    // ブラウザは最初の方を使うので、最初の出現だけを覚える
    const name = match[1].toLowerCase()
    if (!attrs.has(name)) {
      attrs.set(name, match[2] ?? match[3] ?? match[4] ?? '')
    }
  }

  // 記事側が片方でも書いているなら何もしない（rehype-image-dimensions.ts と同じ）。
  // 足りない方だけを埋めると、記事が意図した比率と混ざって表示が歪む。
  // 372 の <img> は原文に width="160" height="160" があり、ここで素通りする
  if (attrs.has('width') || attrs.has('height')) return tag

  const src = attrs.get('src')
  if (src === undefined) return tag
  // 属性値の文字参照（&amp; など）は、rehypeRaw を通った後の src では
  // 解決済みになる。ここでも解決してからファイルに対応づける
  const filePath = archiveImageFilePath(decodeEntities(src))
  if (filePath === null) return tag

  const size = imageSize(filePath)
  if (size === null) return tag

  // タグの末尾ではなく <img の直後に足す。末尾（> や /> の前）に足すと、
  // 引用符無しの値で終わるタグ（src=a.jpg/>）では / が値の一部なので、
  // 値を壊さずに挿入位置を決めるのが面倒になる
  // タグ名は元の綴り（<IMG など）のまま残す
  const head = tag.slice(0, '<img'.length)
  return `${head} width="${size.width}" height="${size.height}"${tag.slice(head.length)}`
}

const visit = (node: Root | RootContent): void => {
  if (node.type === 'html') {
    node.value = node.value.replace(IMG_TAG, addDimensions)
  }
  if ('children' in node) {
    for (const child of node.children) visit(child)
  }
}

export default function remarkArchiveRawImageDimensions() {
  return (tree: Root): void => {
    visit(tree)
  }
}
