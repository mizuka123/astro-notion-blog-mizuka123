import type { Element, Root } from 'hast'
import { archiveImageFilePath } from './archive-image-file'
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

// URL からファイルへの変換（/archive/images/ の下だけを対象にし、
// / や \、..、不正なエスケープを弾く）は archive-image-file.ts にある。
// archive-og-image.ts も本文の画像を読むので、安全策を 1 か所にまとめてある

export default function rehypeImageDimensions() {
  return (tree: Root): void => {
    const walk = (node: Root | Element): void => {
      for (const child of node.children) {
        if (child.type !== 'element') continue

        if (child.tagName === 'img') {
          const filePath = archiveImageFilePath(child.properties?.src)
          // 記事側が片方でも書いているなら何もしない。
          // 足りない方だけを埋めると、記事が意図した比率と混ざって
          // 表示が歪む方が困る（ここに来るのは markdown の画像だけで、
          // それは寸法を出力しないため、この分岐に入る入力は今のところ
          // 存在しない。生 HTML の <img> は rehypeRaw より前のここからは
          // 見えないので、remark-archive-raw-image-dimensions.ts が
          // 同じ規則で寸法を足している）
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
