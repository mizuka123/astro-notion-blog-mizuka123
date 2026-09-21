import type { Element, Root } from 'hast'

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

// 文書順で先頭のこの枚数は «一切触らない»。
// 画面内に入っている画像を遅延読み込みにすると LCP が遅くなるため。
// decoding も付けないのは、LCP になりうる 1 枚目については
// ブラウザ既定の判断に任せた方が安全なため。
// 実測では本文先頭から最初の画像までの表示テキストは中央値 253 文字
// （サイト名・日付・タイトルの定型 60〜115 文字を含む）で、
// 61% の記事が 300 文字以内に最初の画像を置いている。
// つまり先頭画像はファーストビュー内かすぐ下にあることが多い
const EAGER_COUNT = 1

/**
 * 自分のサイトが配信している画像か。
 *
 * これを見ないと «アフィリエイトの計測ビーコン» まで遅延読み込みになる。
 * 商品ボックスにはバリューコマースの
 * //ad.jp.ap.valuecommerce.com/servlet/gifbanner?sid=... が 658 個、
 * a8.net と楽天のものが 9 個あり、いずれも <img> として置かれている。
 * これらを遅延させるとスクロールされるまでインプレッションが発火せず、
 * 計測の数字が変わってしまう。速くしたいのは自前の重い画像なので、
 * 対象を絶対パス（/ 始まり。// はプロトコル相対で外部）に限る
 */
const isLocalImage = (src: unknown): boolean =>
  typeof src === 'string' && src.startsWith('/') && !src.startsWith('//')

export default function rehypeLazyImages() {
  return (tree: Root): void => {
    // ページごとに数え直す。トランスフォーマは 1 ドキュメントにつき
    // 1 回呼ばれるので、ここに置けば持ち越されない
    let seen = 0

    // 先に自分を処理してから子へ降りる（先行順）。
    // これで <img> を文書に現れる順で数えられる
    const walk = (node: Root | Element): void => {
      for (const child of node.children) {
        if (child.type !== 'element') continue

        if (child.tagName === 'img' && isLocalImage(child.properties?.src)) {
          seen++
          if (seen > EAGER_COUNT) {
            const props = (child.properties ??= {})
            // 記事側が明示していれば尊重する。
            // 現状の入力では起きない（Astro は rehypeRaw をユーザー
            // プラグインの後に走らせるため、記事中の生 <img> はここでは
            // まだ raw ノードで、element として見えない）が、
            // 将来その順序が変わったときに壊さないための保険
            if (props.decoding === undefined) {
              props.decoding = 'async'
            }
            if (props.loading === undefined) {
              props.loading = 'lazy'
            }
          }
        }

        walk(child)
      }
    }

    walk(tree)
  }
}
