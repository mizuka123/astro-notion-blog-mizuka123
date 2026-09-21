import type { Element, Root, RootContent } from 'hast'

/**
 * アーカイブ記事の画像に loading="lazy" と decoding="async" を付ける
 * rehype プラグイン。
 *
 * WordPress から移行した 609 記事は markdown の ![](...) 記法で
 * 画像を並べており、ビルド後の <img> には属性が何も付かない。
 * 実測すると /archive/images/ を指す <img> は 5098 個あって
 * «全件» に loading が無く、archive/6474 は 76 枚 9.9MB を
 * 最初から全部読み込んでいた。
 *
 * Notion 記事は Image.astro が loading="lazy" を出しているので、
 * 抜けているのは移行済み markdown が通る経路だけ。
 */

// 文書順で先頭のこの枚数だけは遅延させない。
// 画面内に入っている画像を遅延読み込みにすると LCP が遅くなるため。
// 記事によって先頭画像の位置は違うが、無駄に読み込むのは最大 1 枚で済む
const EAGER_COUNT = 1

const hasChildren = (node: RootContent): node is Element =>
  node.type === 'element'

export default function rehypeLazyImages() {
  return (tree: Root): void => {
    let seen = 0

    // 先に自分を処理してから子へ降りる（先行順）。
    // これで <img> を文書に現れる順で数えられる
    const walk = (node: Root | Element): void => {
      for (const child of node.children) {
        if (child.type !== 'element') continue

        if (child.tagName === 'img') {
          seen++
          const props = (child.properties ??= {})
          // 記事側が明示している場合は尊重する。
          // 移行元の生 <img> に属性が書かれていることがある
          if (props.decoding === undefined) {
            props.decoding = 'async'
          }
          if (props.loading === undefined && seen > EAGER_COUNT) {
            props.loading = 'lazy'
          }
        }

        if (hasChildren(child)) {
          walk(child)
        }
      }
    }

    walk(tree)
  }
}
