import type { Root, RootContent } from 'mdast'
import type { VFile } from 'vfile'

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

// 日本語の検索結果で表示される目安。全角で 110 文字あれば
// 大半は途中で切れずに収まる。超える分は末尾を … にする
const MAX_LENGTH = 110

// これより短い段落は前置き（「どうも。」など）とみなして読み飛ばす。
// ただし本文がそれしか無い場合に備えて、拾えたものは捨てない
const MIN_PARAGRAPH = 10

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

const truncate = (text: string): string =>
  text.length <= MAX_LENGTH ? text : `${text.slice(0, MAX_LENGTH)}…`

export default function remarkArchiveDescription() {
  return (tree: Root, file: VFile): void => {
    const parts: string[] = []

    for (const node of tree.children) {
      if (node.type !== 'paragraph') continue
      // 商品ボックスや画像だけの段落は飛ばす
      if (isLinkOnly(node)) continue

      const text = textOf(node).replace(/\s+/g, ' ').trim()
      if (!text) continue
      // 短すぎる段落は、まだ何も拾えていないときだけ捨てる。
      // 「どうも。」のような前置きで description が埋まるのを避ける
      if (text.length < MIN_PARAGRAPH && parts.length === 0) continue

      parts.push(text)
      if (parts.join(' ').length >= MAX_LENGTH) break
    }

    const description = truncate(parts.join(' ').trim())
    if (!description) return

    // Astro は file.data.astro.frontmatter を通じて frontmatter を書き換えられる。
    // レイアウト側は frontmatter.description として読む
    const data = file.data as {
      astro?: { frontmatter?: Record<string, unknown> }
    }
    if (!data.astro?.frontmatter) return
    // 記事側が明示していれば尊重する（現状 0 件だが将来のため）
    if (data.astro.frontmatter.description) return

    data.astro.frontmatter.description = description
  }
}
