import fs from 'node:fs'
import path from 'node:path'
import { BASE_PATH } from '../server-constants'
import { imageSize } from './image-size'
import { pathJoin } from './utils'

// WordPress から移行した記事の frontmatter にある coverImage は、
// 当時のサムネイルがそのまま入っている。実測すると 506 種類のうち
// 244 種類が幅 300〜599px、33 種類が 300px 未満（最小 60x75）で、
// Amazon の商品サムネイル（_SL75_ など）がそのまま使われているものが多い。
//
// SNS のカードは小さすぎる画像を大きく出せず、引き伸ばしても中身は
// 小さいままなので、一定の幅に満たないものは共通の OGP 画像に任せる。
// 600px は Twitter の summary_large_image が大きいカードとして扱う
// 下限（300x157）に対して十分な余裕を見た値
const MIN_WIDTH = 600

const IMAGE_DIR = 'public/archive/images'

// 同じ画像を複数の記事が使うため、1 ファイルにつき 1 回だけ読む。
// ビルド 1 回分しか生きないので寿命の管理は不要
const cache = new Map<string, string>()

/**
 * アーカイブ記事の coverImage から og:image に使うパスを返す。
 * 小さすぎる画像と、実体が無いものは空文字を返し、
 * 呼び出し側（SiteHead）が共通の OGP 画像にフォールバックする。
 */
export const archiveOgImagePath = (coverImage: string | undefined): string => {
  // frontmatter に coverImage: の行はあるが値が空、という記事が 23 件ある
  const name = coverImage?.trim()
  if (!name) {
    return ''
  }

  const cached = cache.get(name)
  if (cached !== undefined) {
    return cached
  }

  let result = ''
  const filePath = path.join(IMAGE_DIR, name)

  if (!fs.existsSync(filePath)) {
    // 移行時に画像が失われている場合。og:image が壊れるより
    // 共通画像に落とした方がよいので、止めずに空を返す
    console.error(`archive-og-image: not found: ${filePath}`)
  } else {
    const size = imageSize(filePath)
    if (size === null) {
      // 画像として読めないファイルが混ざっている場合。
      // 黙って共通画像になる理由が分からなくなるので出す
      console.error(
        `archive-og-image: unknown format or unreadable: ${filePath}`
      )
    } else if (size.width >= MIN_WIDTH) {
      // encodeURI だと # と ? を素通しするため、foo#1.jpg のような名前で
      // パスが途中までになり、残りがフラグメント扱いになる。
      // ここで encode するのは 1 つのパス要素なので Component の方
      result = pathJoin(
        BASE_PATH,
        `/archive/images/${encodeURIComponent(name)}`
      )
    }
  }

  cache.set(name, result)
  return result
}
