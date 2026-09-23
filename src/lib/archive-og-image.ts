import fs from 'node:fs'
import path from 'node:path'
import { BASE_PATH } from '../server-constants'
import { ARCHIVE_IMAGE_DIR, archiveImageName } from './archive-image-file'
import { imageSize, type ImageSize } from './image-size'
import { pathJoin } from './utils'

// WordPress から移行した記事の frontmatter にある coverImage は、
// 当時のサムネイルがそのまま入っている。実測すると 506 種類のうち
// 244 種類が幅 300〜599px、33 種類が 300px 未満（最小 60x75）で、
// Amazon の商品サムネイル（_SL75_ など）がそのまま使われているものが多い。
//
// SNS のカードは小さすぎる画像を大きく出せず、引き伸ばしても中身は
// 小さいままなので、一定の幅に満たないものは og:image に使わない。
// 600px は Twitter の summary_large_image が大きいカードとして扱う
// 下限（300x157）に対して十分な余裕を見た値
const MIN_WIDTH = 600

// JSON-LD の image の下限。Google の Article 構造化データのドキュメントが
// "minimum of 50K pixels when multiplying width and height" と書いている。
// og:image と閾値を分けているのは用途が違うため。SNS のカードは
// 小さい画像を大きく引き伸ばして出すので幅が要るが、Google は
// 面積で足切りするだけで、300x200 でも «記事を表す画像» として受け取る
const MIN_JSON_LD_PIXELS = 50_000

export interface ArchiveImages {
  /**
   * og:image / twitter:image に使うパス（BASE_PATH 込み）。
   * 空なら呼び出し側（SiteHead）が共通の OGP 画像にフォールバックする
   */
  ogImage: string
  /**
   * JSON-LD の image に使うパス（BASE_PATH 込み）。
   * 空なら JSON-LD に image を出さない。共通画像には落とさない。
   * Google は "Images must represent the marked up content." としており、
   * 記事を表さない共通画像を出すより、推奨項目（必須ではない）を
   * 省く方が要件に沿う
   */
  jsonLdImage: string
}

// 同じ画像を複数の記事が使うため、1 ファイルにつき 1 回だけ判定する。
// ビルド 1 回分しか生きないので寿命の管理は不要
const sizeCache = new Map<string, ImageSize | null>()

const sizeOf = (name: string, source: string): ImageSize | null => {
  const cached = sizeCache.get(name)
  if (cached !== undefined) {
    return cached
  }

  const filePath = path.join(ARCHIVE_IMAGE_DIR, name)
  let size: ImageSize | null = null
  if (!fs.existsSync(filePath)) {
    // 移行時に画像が失われている場合。og:image が壊れるより
    // 次の候補か共通画像に落とした方がよいので、止めずに外す
    console.error(`archive-og-image: not found (${source}): ${filePath}`)
  } else {
    size = imageSize(filePath)
    if (size === null) {
      // 画像として読めないファイルが混ざっている場合。
      // 黙って候補から外れる理由が分からなくなるので出す
      console.error(
        `archive-og-image: unknown format or unreadable (${source}): ${filePath}`
      )
    }
  }

  sizeCache.set(name, size)
  return size
}

// encodeURI だと # と ? を素通しするため、foo#1.jpg のような名前で
// パスが途中までになり、残りがフラグメント扱いになる。
// ここで encode するのは 1 つのパス要素なので Component の方
const toUrlPath = (name: string): string =>
  pathJoin(BASE_PATH, `/archive/images/${encodeURIComponent(name)}`)

/**
 * アーカイブ記事の og:image と JSON-LD の image に使うパスを選ぶ。
 *
 * 候補は coverImage → 本文のローカル画像（出現順）の順に見る。
 * coverImage を先に見るのは、#82 から coverImage で決まっていた
 * 232 件の結果を変えないため。
 *
 * - og:image: 候補のうち最初に幅 600px 以上のもの。無ければ空（共通画像）
 * - JSON-LD: og:image が決まったならそれと同じもの。決まらなかった
 *   記事でだけ、最初に «幅×高さ 50,000 以上» のものを探す。
 *   先に og:image と揃えるのは、SNS と検索結果で別の画像が出る
 *   «不必要な食い違い» を作らないため
 *
 * 609 記事での実測（変更前は og:image が coverImage 由来 232 件・
 * 共通画像 377 件で、JSON-LD の image も同じ 377 件が共通画像だった）:
 * - og:image: coverImage 232 件 / 本文の画像 146 件 / 共通画像 231 件
 *   （本文由来の 146 件のうち 128 件は本文 1 枚目の画像）
 * - JSON-LD: og:image と同じ 378 件 / 50,000px 以上の小さい画像 124 件 /
 *   image を出さない 107 件（本文にローカル画像が無い 62 件（うち 1 件は
 *   外部の画像だけ）と、あっても coverImage を含めてすべて 50,000px 未満の
 *   45 件）
 *
 * 寸法はローカルファイルのヘッダだけから読む（image-size.ts）。
 * 外部 URL は remark-archive-images.ts の時点で候補から外れている。
 */
export const archiveImages = (
  coverImage: string | undefined,
  bodyImages: readonly string[] | undefined
): ArchiveImages => {
  const candidates: { name: string; source: string }[] = []

  // frontmatter に coverImage: の行はあるが値が空、という記事が 23 件ある。
  // coverImage はファイル名だけが書かれている（URL ではない）ので、
  // archiveImageName() と同じ «ディレクトリを抜けない» 確認だけをする
  const cover = coverImage?.trim()
  if (
    cover &&
    !cover.includes('/') &&
    !cover.includes('\\') &&
    cover !== '..'
  ) {
    candidates.push({ name: cover, source: 'coverImage' })
  }

  for (const url of bodyImages ?? []) {
    const name = archiveImageName(url)
    if (name !== null) {
      candidates.push({ name, source: 'body' })
    }
  }

  let ogImage = ''
  let smallImage = ''
  for (const { name, source } of candidates) {
    const size = sizeOf(name, source)
    if (size === null) continue
    if (size.width >= MIN_WIDTH) {
      ogImage = toUrlPath(name)
      break
    }
    if (!smallImage && size.width * size.height >= MIN_JSON_LD_PIXELS) {
      smallImage = toUrlPath(name)
    }
  }

  return { ogImage, jsonLdImage: ogImage || smallImage }
}
