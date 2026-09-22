import type { Root, RootContent } from 'mdast'
import type { VFile } from 'vfile'
import { buildDescription } from './description'

/**
 * アーカイブ記事の本文から meta description を作る remark プラグイン。
 *
 * 全 642 ページの description が Notion のデータベース説明
 * （「ガジェットやカメラ、ちょっとだけ技術の話題が中心のブログ」）で
 * 同一だった。検索結果でどのページも同じ説明が出る状態で、
 * ページごとの内容が伝わらない。
 *
 * WordPress から移行した 609 記事の frontmatter には description に
 * 使える項目が無い（あるのは layout / title / date / categories /
 * tags / coverImage だけ）ので、本文から作る。
 *
 * 正規表現ではなく構文木から取るのが要点。本文には画像・生 HTML・
 * カエレバの商品ボックスが混ざっており、正規表現で剥がすと
 * 「') 設定はこんな感じ。」のような取り残しが混入する（実際に起きた）。
 * mdast なら image は image ノードとして分かれているので取り違えない。
 */

/**
 * ノードから «地の文» を取り出す。
 * 画像・コード・生 HTML は説明文にならないので無視し、
 * リンクは表示テキストだけを残す。
 */
const textOf = (node: RootContent): string => {
  switch (node.type) {
    case 'text':
      return node.value
    case 'inlineCode':
      return node.value
    // 行末スペース 2 つによる強制改行。空文字を返すと前後がくっついて
    // 「SONY α7RSONY SEL55F18Z」のようになる。採用した段落の中に
    // 実測 1434 個あり、出力の 62.9%（383/609）に結合痕が出ていた
    case 'break':
      return ' '
    // 画像・コードブロック・生 HTML は中身を説明文に入れない
    case 'image':
    case 'imageReference':
    case 'code':
    case 'html':
      return ''
    default:
      return 'children' in node
        ? node.children.map((child) => textOf(child as RootContent)).join('')
        : ''
  }
}

/** 段落が «リンクだけ» でできているか（カエレバの商品ボックスなど）。 */
const isLinkOnly = (node: RootContent): boolean => {
  if (node.type !== 'paragraph') return false
  const meaningful = node.children.filter(
    (child) => !(child.type === 'text' && child.value.trim() === '')
  )
  return (
    meaningful.length > 0 &&
    meaningful.every(
      (child) =>
        child.type === 'link' ||
        child.type === 'linkReference' ||
        child.type === 'image'
    )
  )
}

/** 段落テキストを文書順に並べて返す。除外の判断はここで行う。 */
const paragraphTexts = (tree: Root): string[] => {
  const texts: string[] = []
  for (const node of tree.children) {
    if (node.type !== 'paragraph') continue
    // 商品ボックスや画像だけの段落は飛ばす
    if (isLinkOnly(node)) continue
    texts.push(textOf(node))
  }
  return texts
}

export default function remarkArchiveDescription() {
  return (tree: Root, file: VFile): void => {
    const description = buildDescription(paragraphTexts(tree))
    if (!description) return

    // Astro は file.data.astro.frontmatter を通じて frontmatter を書き換えられる。
    // レイアウト側は frontmatter.description として読む
    const data = file.data as {
      astro?: { frontmatter?: Record<string, unknown> }
    }
    // Astro が必ず {} を入れるので実行時には通らないが、
    // 続く 2 行で frontmatter を触るための型の絞り込みとして要る
    if (!data.astro?.frontmatter) return
    // 記事側が明示していれば尊重する（現状 0 件だが将来のため）
    if (data.astro.frontmatter.description) return

    data.astro.frontmatter.description = description
  }
}
