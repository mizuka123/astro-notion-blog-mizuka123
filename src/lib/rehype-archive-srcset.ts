import fs from 'node:fs'
import path from 'node:path'
import type { Element, Root } from 'hast'
import {
  ARCHIVE_IMAGE_DIR,
  archiveImageFilePath,
  archiveImageName,
} from './archive-image-file'
import {
  ARCHIVE_IMAGE_VARIANT_WIDTHS,
  archiveImageVariantName,
} from './archive-image-variants'
import { imageSize } from './image-size'

/**
 * アーカイブ記事の画像に srcset と sizes を付ける rehype プラグイン（#134）。
 *
 * public/archive/images/ の画像は幅 1600px 以下（#84）のまま配信していて、
 * スマートフォンでも 1600px を読み込んでいた（PageSpeed Insights で
 * archive/7668 の表示 658x494 に対して 1600x1200）。
 * 幅 640 / 1024 の版を scripts/generate-archive-image-variants.mjs で事前に
 * 作ってコミットしてあり、ここでは «ディスクにある版だけ» を srcset に載せる。
 * 元の画像は最大の候補として必ず最後に入れる（元の幅の w 記述子を付ける）。
 * 版が 1 つも無い画像（幅 640 以下、縮小版が元より大きくなった、CMYK など）には
 * 何も付けない。
 *
 * 対象は markdown の画像（![](...)）だけ。生 HTML の <img> はこの段階では
 * まだ raw ノードの文字列で見えない（rehype-image-dimensions.ts と同じ）。
 * 該当する 13 個はどれも幅 160px 以下で、版が作られる大きさでもない。
 *
 * width / height / loading / decoding は触らない。width / height は
 * rehype-image-dimensions.ts が元の画像の寸法で付けていて、表示される大きさは
 * それと .content img の max-width: 100% で決まる。srcset から選ばれる候補が
 * 変わっても表示の大きさは変わらない。
 */

/*
 * 本文の画像の表示幅。値は src/layouts/LayoutMd.astro の CSS から出した:
 *
 * - 幅 640px 以下: `.container > div` が display: block になり、main が画面幅
 *   いっぱいになる。`div.content` の padding が 0 18px なので、本文の幅は
 *   100vw - 36px
 * - 幅 641〜1280px: `.container > div` は display: flex で max-width: 1280px
 *   （中央寄せはしない）。aside は width: 300px（src/styles/layout-global.css の
 *   `* { box-sizing: border-box }` により padding 20px を含む）で、残りを
 *   main（flex: 1）が取る。`div.content` の padding が 20px 40px なので、
 *   本文の幅は 100vw - 300px - 80px = 100vw - 380px
 * - 幅 1281px 以上: 1280px - 380px = 900px で頭打ち
 *
 * body と html の margin / padding は layout-global.css で 0。本文と .content の
 * 間に幅を絞る要素は無い（<slot /> が .content の直下）。
 * `.content img` は max-width: 100%; height: auto; なので、画像はこの幅に
 * 収まる（元の幅の方が狭ければ元の幅で表示されるが、そのときは sizes が
 * 大きめでも候補は結局元の画像になるので、画像ごとに上限を書く必要は無い）。
 *
 * 誤差: デスクトップの 100vw は縦スクロールバーの幅（Windows で 17px 前後）を
 * 含むので、641〜1280px では実際より最大 17px ほど大きく見積もる（候補が
 * 1 段上がることがあるだけで、ぼやけはしない）。スマートフォンの
 * スクロールバーは幅を取らないので 100vw - 36px はそのまま。
 * 表・リスト・引用の中の画像は本文の幅より狭く表示されるが、sizes は
 * 上限として扱い、同じ値にしている。
 * LayoutMd.astro の padding や aside の幅を変えたら、ここも直すこと
 */
export const ARCHIVE_IMAGE_SIZES =
  '(max-width: 640px) calc(100vw - 36px), (max-width: 1280px) calc(100vw - 380px), 900px'

/**
 * srcset の中の URL として安全な形にする。srcset はカンマと空白で候補を
 * 区切るので、URL の中にあると別の候補の区切りとして読まれてしまう。
 * 今の対象（版がある画像）のファイル名にカンマと空白は無い（全件で確認）が、
 * 念のためエンコードしておく。% は既にエンコード済みの参照（%2B など）を
 * 壊さないよう触らない
 */
const escapeSrcsetUrl = (url: string): string =>
  url.replace(/,/g, '%2C').replace(/\s/g, (c) => encodeURIComponent(c))

/**
 * src の URL から、幅 width の版の URL を作る。src の最後の「.」の前に
 * -<幅>w を挟む。エンコードの形（%2B など）は src のまま残すので、
 * 元の画像と同じ書き方で配信される。
 * 作った URL が指すファイル名が、archive-image-variants.ts の決まりの名前と
 * 一致することを確かめ、ずれていれば null
 */
const variantUrl = (
  src: string,
  name: string,
  width: number
): string | null => {
  const expected = archiveImageVariantName(name, width)
  const dot = src.lastIndexOf('.')
  if (expected === null || dot <= src.lastIndexOf('/')) return null
  const url = `${src.slice(0, dot)}-${width}w${src.slice(dot)}`
  return archiveImageName(url) === expected ? url : null
}

// 同じ画像を複数の記事が使うので、ファイルの有無は 1 回だけ調べる
const exists = new Map<string, boolean>()
const fileExists = (filePath: string): boolean => {
  let result = exists.get(filePath)
  if (result === undefined) {
    result = fs.existsSync(filePath)
    exists.set(filePath, result)
  }
  return result
}

const srcsetFor = (src: unknown): string | null => {
  const name = archiveImageName(src)
  const filePath = archiveImageFilePath(src)
  if (typeof src !== 'string' || name === null || filePath === null) {
    return null
  }
  const size = imageSize(filePath)
  if (!size) return null

  const candidates: string[] = []
  for (const width of ARCHIVE_IMAGE_VARIANT_WIDTHS) {
    // 版は元の幅がこれを超えるものにしか作っていない。元より広い候補を
    // 載せると、ブラウザがそれを «大きい画像» と誤って選びうる
    if (size.width <= width) continue
    const url = variantUrl(src, name, width)
    const variant = archiveImageVariantName(name, width)
    if (url === null || variant === null) continue
    if (!fileExists(path.join(ARCHIVE_IMAGE_DIR, variant))) continue
    candidates.push(`${escapeSrcsetUrl(url)} ${width}w`)
  }
  if (candidates.length === 0) return null

  candidates.push(`${escapeSrcsetUrl(src)} ${size.width}w`)
  return candidates.join(', ')
}

export default function rehypeArchiveSrcset() {
  return (tree: Root): void => {
    const walk = (node: Root | Element): void => {
      for (const child of node.children) {
        if (child.type !== 'element') continue

        if (child.tagName === 'img') {
          const props = child.properties
          // 記事側が書いていれば尊重する（今の入力では起きない）
          if (
            props &&
            props.srcSet === undefined &&
            props.sizes === undefined
          ) {
            const srcset = srcsetFor(props.src)
            if (srcset !== null) {
              props.srcSet = srcset
              props.sizes = ARCHIVE_IMAGE_SIZES
            }
          }
        }

        walk(child)
      }
    }

    walk(tree)
  }
}
