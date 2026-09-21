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

  // BASE_PATH を設定している場合は取り除いてから見る
  const withoutBase =
    BASE_PATH && src.startsWith(BASE_PATH) ? src.slice(BASE_PATH.length) : src
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
          const props = (child.properties ??= {})
          // 記事側が明示していれば尊重する
          if (props.width === undefined && props.height === undefined) {
            const filePath = toFilePath(props.src)
            const size = filePath ? imageSize(filePath) : null
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
