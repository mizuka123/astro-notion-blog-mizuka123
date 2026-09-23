import type { Element, Root } from 'hast'

/**
 * アーカイブ記事の本文見出しをすべて h2 に揃える rehype プラグイン。
 *
 * 変更前、アーカイブ記事 1 ページの見出しは
 * h1（サイト名）→ h3（記事タイトル）→ h4（本文見出し）と並んでいて、
 * h2 が 1 つも無かった（Issue #98）。
 * LayoutMd.astro 側でサイト名を見出しから外し、記事タイトルを h1 に
 * したので、本文の見出しは h2 から始まらなければならない。
 *
 * 609 記事の markdown を実測すると、使われている見出しは
 * 「#### が 397 ファイルに 1,978 個」と「# が 4 ファイルに 5 個」だけで、
 * ## / ### / ##### / ###### は 1 つも無い。
 * つまり本文の見出しは «実質 1 段しか使われていない» ので、
 * 全部 h2 にするのが素直な写像になる。
 *
 * «# を h2、#### を h3» のように段を残す案は採れない。
 * # を持つ 4 ファイルのうち 2 ファイルで、# より前に #### が出てくるためで、
 * ・1669.md: #### が 1 個（先頭）、# が 2 個（その後）
 * ・6924.md: #### が 15 個、# が 1 個（最後）
 * この 2 ファイルは «h1 の次がいきなり h3» になり、直したかった段飛ばしが
 * そのまま残る。そもそも 1669.md の #### は関連記事へのリンク 1 行、
 * # 2 個は「箱がでかい！」「設置してみた！」という本文の節で、
 * 両者に親子関係は無い（実際に読んで確認した）。同じ段に潰してよい。
 * 残る 7430.md と 7598.md の # は記事タイトルの重複で、こちらは
 * frontmatter の title（＝ h1）と同じ文言が本文の先頭にもう一度
 * 置かれているだけなので、h2 に落ちても意味は壊れない。
 *
 * 記事側の markdown（src/pages/archive/*.md）を 609 ファイル書き換えるのでは
 * なく変換で済ませているのは、移行した記事を «原文のまま» 置いておくため。
 * 見出しの段の付け方はサイト側の都合で、記事の内容ではない。
 *
 * 書き方は src/lib/rehype-lazy-images.ts と
 * src/lib/rehype-image-dimensions.ts に合わせてある
 * （astro.config.mjs の markdown.rehypePlugins に並べて登録する）。
 */

// 置き換え先。h1 は記事タイトルが使うので本文では使えない
const TARGET = 'h2'

const HEADINGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'])

export default function rehypeArchiveHeadings() {
  return (tree: Root): void => {
    const walk = (node: Root | Element): void => {
      for (const child of node.children) {
        if (child.type !== 'element') continue

        if (HEADINGS.has(child.tagName)) {
          child.tagName = TARGET
        }

        // 見出しの中に見出しは入らないが、引用やリストの中の見出しも
        // 拾えるよう、無条件に下まで降りる
        walk(child)
      }
    }

    walk(tree)
  }
}
