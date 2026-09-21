import path from 'node:path'
import type { Element, Root } from 'hast'
import { BASE_PATH } from '../server-constants'
import { imageSize } from './image-size'

/**
 * アーカイブ記事の画像に width / height を付ける rehype プラグイン。
 *
 * markdown の ![](...) 記法は寸法を出力しないため、読み込みが終わるまで
 * ブラウザは高さを 0 として扱う。画像が届くたびに本文が下へ押し出され、
 * レイアウトシフト（CLS）になる。1 記事に 76 枚といった記事があるので
 * 影響が大きく、#86 で遅延読み込みにしたことでスクロール中にも起きる
 * ようになった。
 *
 * width / height があればブラウザが縦横比から場所を先に確保する。
 * LayoutMd.astro の .content img に max-width: 100%; height: auto; が
 * 既にあるので、属性を足しても «表示される大きさは変わらない»
 * （縦横比だけが伝わる）。
 */

// 対象はこの下にある画像だけ。移行した記事の画像はすべてここにある。
// 外部の画像は寸法が分からないうえ、アフィリエイトの計測ビーコンも
// <img> なので触らない
const URL_PREFIX = '/archive/images/'
const FILE_DIR = 'public/archive/images'

/** URL のパスから、読み出すファイルのパスを返す。対象外なら null。 */
const toFilePath = (src: unknown): string | null => {
  if (typeof src !== 'string') return null

  // BASE_PATH を設定している場合は取り除いてから見る。
  // 切り落とした残りが / で始まることまで確かめる。単なる前方一致だと
  // BASE_PATH='/arch' のような値のときに /archive/images/x.jpg を
  // 削りすぎて、黙って対象外になってしまう
  const rest =
    BASE_PATH && src.startsWith(BASE_PATH) ? src.slice(BASE_PATH.length) : null
  const withoutBase = rest !== null && rest.startsWith('/') ? rest : src
  if (!withoutBase.startsWith(URL_PREFIX)) return null

  // 記事には %2B（+ のエンコード）を含む参照が 76 件ある。
  // デコードしないとファイルが見つからない
  let name: string
  try {
    name = decodeURIComponent(withoutBase.slice(URL_PREFIX.length))
  } catch {
    // 不正なエスケープ。寸法を付けないだけで表示には影響しない
    return null
  }

  // ディレクトリを抜け出す参照は扱わない
  if (!name || name.includes('/') || name.includes('\\') || name === '..') {
    return null
  }

  return path.join(FILE_DIR, name)
}

export default function rehypeImageDimensions() {
  return (tree: Root): void => {
    const walk = (node: Root | Element): void => {
      for (const child of node.children) {
        if (child.type !== 'element') continue

        if (child.tagName === 'img') {
          const filePath = toFilePath(child.properties?.src)
          // 記事側が片方でも書いているなら何もしない。
          // 足りない方だけを埋めると、記事が意図した比率と混ざって
          // 表示が歪む方が困る（現状 /archive/images/ を指す生 <img> は
          // 0 件なので、この分岐に入る入力は今のところ存在しない）
          const props = child.properties
          if (
            filePath &&
            props &&
            props.width === undefined &&
            props.height === undefined
          ) {
            const size = imageSize(filePath)
            if (size) {
              props.width = size.width
              props.height = size.height
            }
          }
        }

        walk(child)
      }
    }

    walk(tree)
  }
}
