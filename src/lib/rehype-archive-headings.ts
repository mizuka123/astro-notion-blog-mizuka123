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
 * 「#### が 1,979 個」と「# が 4 ファイルに 5 個」の計 1,984 個だけで、
 * ## / ### / ##### / ###### は 1 つも無い（要素を持つのは 397 ファイル）。
 * 1,979 のうち 1 個は 3518.md:30 の «> #### あっぷでーと！» で、
 * 引用の中にある。行頭の #### だけを数えると 1,978 個になって
 * ビルド後の要素数 1,984 と合わなくなるので注意。
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
 * 対象は «markdown 記法の見出し» だけで、本文に直接書かれた生 HTML の
 * <h1>〜<h6> は対象外。@astrojs/markdown-remark はユーザーの rehype
 * プラグインを rehypeRaw より «前» に走らせるため、この時点では生 HTML は
 * まだ raw ノードのままで要素になっていない。609 記事に生 HTML の見出しは
 * 0 件なので現状は問題にならないが、足すときは注意。
 *
 * 書き方は src/lib/rehype-lazy-images.ts と
 * src/lib/rehype-image-dimensions.ts に合わせてある
 * （astro.config.mjs の markdown.rehypePlugins に並べて登録する）。
 */

// 置き換え先。h1 は記事タイトルが使うので本文では使えない
const TARGET = 'h2'

/*
 * 付けておく class。LayoutMd.astro の <style is:global> がこの class で
 * 見た目を当てる。
 *
 * «.content h2» のようにタグ名で当てると、アーカイブ記事以外にも効きうる。
 * 以前は src/lib/archive-taxonomy.ts が import.meta.glob('../pages/archive/*.md')
 * でアーカイブの md をモジュールグラフに引き込んでいたため、md の layout である
 * LayoutMd.astro の global CSS が /category/ 27 枚・/tag/ 271 枚・
 * /tag/ 1 枚・/archive/ 1 枚にも «配信されていた»（実測で .content h2 を含む
 * HTML は 909 枚）。実際に /archive/ の «カテゴリーから探す» と
 * «すべての記事» が 1.2rem/400 から 1rem/700 に変わってしまっていた。
 * 漏れは #123 で止めた（src/lib/archive-frontmatter.ts）が、md を
 * モジュールとして import し直すと黙って戻る。
 * class にしておけば、CSS が配信されてもアーカイブ本文以外には当たらない
 */
const CLASS_NAME = 'archive-body-heading'

const HEADINGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'])

export default function rehypeArchiveHeadings() {
  return (tree: Root): void => {
    const walk = (node: Root | Element): void => {
      for (const child of node.children) {
        if (child.type !== 'element') continue

        if (HEADINGS.has(child.tagName)) {
          child.tagName = TARGET
          const properties = (child.properties ??= {})
          // hast の className は配列とは限らず文字列も取り得る。
          // Array.isArray だけで分けると «配列でない＝無い» と見なして
          // 既存の class を無言で捨てることになるので、値の型で分ける
          const existing = properties.className
          properties.className = [
            ...(Array.isArray(existing)
              ? existing
              : typeof existing === 'string'
                ? existing.split(/\s+/).filter(Boolean)
                : []),
            CLASS_NAME,
          ]
        }

        // 見出しの中に見出しは入らないが、引用やリストの中の見出しも
        // 拾えるよう、無条件に下まで降りる
        walk(child)
      }
    }

    walk(tree)
  }
}
