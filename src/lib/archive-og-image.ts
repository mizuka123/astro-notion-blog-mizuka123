import fs from 'node:fs'
import path from 'node:path'
import { BASE_PATH } from '../server-constants'
import {
  ARCHIVE_IMAGE_DIR,
  archiveCoverImageName,
  archiveImageName,
} from './archive-image-file'
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

// 本文から新しく選ぶ候補にだけかける条件（#103 のレビューで追加）。
// 幅だけを見ると、644x54（縦横比 11.9）のような «帯» のスクリーンショットが
// og:image に選ばれていた。SNS のカード（1.91:1）や Google の推奨比率
// （16:9 / 4:3 / 1:1）に切り抜くと中身がほぼ残らない。
// 3 は 16:9（1.78）と 1.91:1 に余裕を持たせた上限。
// 高さ 157px は上の MIN_WIDTH のコメントにある summary_large_image の
// 下限（300x157）の高さで、幅 600px 以上でも高さが足りない画像を外す
const MAX_ASPECT_RATIO = 3
const MIN_OG_HEIGHT = 157

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

const aspectRatio = ({ width, height }: ImageSize): number =>
  Math.max(width, height) / Math.min(width, height)

const isJsonLdSized = (size: ImageSize): boolean =>
  size.width * size.height >= MIN_JSON_LD_PIXELS &&
  aspectRatio(size) <= MAX_ASPECT_RATIO

const isOgSized = (size: ImageSize): boolean =>
  size.width >= MIN_WIDTH &&
  size.height >= MIN_OG_HEIGHT &&
  aspectRatio(size) <= MAX_ASPECT_RATIO

/**
 * アーカイブ記事の og:image と JSON-LD の image に使うパスを選ぶ。
 *
 * 1. coverImage が幅 600px 以上なら、og:image も JSON-LD もそれを使う。
 *    #82 から coverImage で決まっていた 232 件の結果を変えないため、
 *    ここには下の «共有されたファイル名» や縦横比の条件をかけない
 *    （この 232 件にも、共有ファイル名 6 件・縦横比 3 超 6 件・
 *    高さ 157px 未満 1 件（重複あり、計 9 記事）が残っている。別 Issue で扱う）
 * 2. それ以外の記事では、本文のローカル画像（出現順）と、幅 600px 未満の
 *    coverImage から «新しく» 選ぶ。どれも、2 記事以上から参照されている
 *    ファイル名（archive-shared-images.ts）と、縦横比 3 超のものは使わない
 *    - og:image: 本文の画像のうち、最初に幅 600px 以上・高さ 157px 以上の
 *      もの。無ければ空（共通画像）
 *    - JSON-LD: og:image が決まり、それが 50,000px 以上ならそれと同じもの。
 *      そうでなければ coverImage → 本文の順に、最初に «幅×高さ 50,000 以上»
 *      のもの。先に og:image と揃えるのは、SNS と検索結果で別の画像が
 *      出る «不必要な食い違い» を作らないため
 *
 * 609 記事での実測（main では og:image が coverImage 由来 232 件・
 * 共通画像 377 件で、JSON-LD の image も同じ 377 件が共通画像だった）:
 * - og:image: coverImage 232 件 / 本文の画像 145 件 / 共通画像 232 件
 * - JSON-LD: og:image と同じ 377 件 / 50,000px 以上の小さい画像 116 件 /
 *   image を出さない 116 件
 *
 * 寸法はローカルファイルのヘッダだけから読む（image-size.ts）。
 * 外部 URL は remark-archive-images.ts の時点で候補から外れている。
 */
export const archiveImages = (
  coverImage: string | undefined,
  bodyImages: readonly string[] | undefined,
  sharedNames: ReadonlySet<string>
): ArchiveImages => {
  // frontmatter に coverImage: の行はあるが値が空、という記事が 23 件ある
  const cover = archiveCoverImageName(coverImage)
  const coverSize = cover === null ? null : sizeOf(cover, 'coverImage')

  if (cover !== null && coverSize !== null && coverSize.width >= MIN_WIDTH) {
    const legacy = toUrlPath(cover)
    return { ogImage: legacy, jsonLdImage: legacy }
  }

  // ここから下は «新しく足した候補»。共有されたファイル名は、
  // どの記事の画像なのか決められないので最初から入れない
  const candidates: { name: string; size: ImageSize; fromBody: boolean }[] = []
  if (cover !== null && coverSize !== null && !sharedNames.has(cover)) {
    candidates.push({ name: cover, size: coverSize, fromBody: false })
  }
  for (const url of bodyImages ?? []) {
    const name = archiveImageName(url)
    if (name === null || sharedNames.has(name)) continue
    const size = sizeOf(name, 'body')
    if (size !== null) candidates.push({ name, size, fromBody: true })
  }

  const og = candidates.find((c) => c.fromBody && isOgSized(c.size))
  const ld =
    og && isJsonLdSized(og.size)
      ? og
      : candidates.find((c) => isJsonLdSized(c.size))

  return {
    ogImage: og ? toUrlPath(og.name) : '',
    jsonLdImage: ld ? toUrlPath(ld.name) : '',
  }
}
