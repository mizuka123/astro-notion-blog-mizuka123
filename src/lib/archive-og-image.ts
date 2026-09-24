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

// og:image に使う画像にかける条件。#103 のレビューで本文から新しく選ぶ
// 候補に足し、#125 で coverImage をそのまま使う分岐にも広げた。
// 幅だけを見ると、644x54（縦横比 11.9）のような «帯» のスクリーンショットが
// og:image に選ばれていた。SNS のカード（1.91:1）や Google の推奨比率
// （16:9 / 4:3 / 1:1）に切り抜くと中身がほぼ残らない。
// 3 は 16:9（1.78）と 1.91:1 に余裕を持たせた上限。
// 高さ 157px は上の MIN_WIDTH のコメントにある summary_large_image の
// 下限（300x157）の高さ。
//
// ただし今の値の組み合わせでは、この高さの条件は «何も外していない»。
// 幅 600px 以上かつ縦横比 3 以下なら、高さは必ず 200px 以上になる
// （600 / 3 = 200）。実際に 644x54 を外しているのは縦横比の条件の方。
// #125 で外れた 5195 の coverImage（600x127）も高さ 157px 未満だが、
// 縦横比が 4.72 あり、縦横比の条件だけでも外れる。
// 同じ理由で、og:image に選ばれた画像は必ず 600 x 200 = 120,000px 以上あり、
// JSON-LD が og:image を引き継ぐときの 5 万 px の確認（下の isJsonLdSized）も
// 常に通る。どちらも MIN_WIDTH や MAX_ASPECT_RATIO を将来変えたときに
// 抜け道ができないよう残している保険で、今の出力には影響しない
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
 * 1. coverImage が、2 記事以上から参照されているファイル名
 *    （archive-shared-images.ts）でなく、幅 600px 以上・高さ 157px 以上・
 *    縦横比 3 以下なら、og:image も JSON-LD もそれを使う。
 *    #82 からは幅 600px 以上というだけで使っており、232 件がここで決まって
 *    いたが、そのうち 9 件は別の記事の画像（共有ファイル名 6 件）や
 *    SNS のカードに切り抜くと中身が残らない帯状の画像（縦横比 3 超 6 件、
 *    うち 1 件は高さ 157px 未満でもある。重複あり）だった。#125 で 2. の
 *    本文の画像と同じ条件をかけ、この 9 件を 2. に回した（残りは 223 件）。
 *
 *    共有ファイル名を «coverImage に書いている記事が持ち主» とみなして
 *    取り戻すことはしない。共有名 178 種のうち coverImage に書いている記事が
 *    1 つだけのものは 9 種しかなく、その 1 つの thumb.png は 571 の
 *    coverImage にあるが、中身は鎌倉の地図で 737（鎌倉散策の記事）の本文の
 *    画像だった。この規則だと 571 に誤った画像が戻る。また 5640 の
 *    NANA_MIZUKI_LIVE_FLIGHT_2014.png は 5724 も coverImage に書いており、
 *    この規則でも取り戻せない
 * 2. それ以外の記事では、本文のローカル画像（出現順）と、1. の条件を
 *    満たさなかった coverImage から «新しく» 選ぶ。どれも、共有ファイル名と
 *    縦横比 3 超のものは使わない
 *    - og:image: 本文の画像のうち、最初に幅 600px 以上・高さ 157px 以上の
 *      もの（1. と同じ条件）。無ければ空（共通画像）
 *    - JSON-LD: og:image が決まり、それが 50,000px 以上ならそれと同じもの。
 *      そうでなければ coverImage → 本文の順に、最初に «幅×高さ 50,000 以上»
 *      のもの。先に og:image と揃えるのは、SNS と検索結果で別の画像が
 *      出る «不必要な食い違い» を作らないため
 *
 * 609 記事での実測（ビルド後の dist の og:image と JSON-LD の image を数えた）:
 * - og:image: coverImage 223 件 / 本文の画像 146 件 / 共通画像 240 件
 * - JSON-LD: og:image と同じ 369 件 / 50,000px 以上の小さい画像 116 件 /
 *   image を出さない 124 件
 * #125 で 1. から外れた 9 件のうち、571 は og:image・JSON-LD とも本文の
 * 画像に、残る 8 件は共通画像（JSON-LD は image なし）になった。
 * #125 の前は og:image が 232 / 145 / 232 件、JSON-LD が 377 / 116 / 116 件。
 * #124 より前は og:image が coverImage 由来 232 件・共通画像 377 件で、
 * JSON-LD の image も同じ 377 件が共通画像だった
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

  if (
    cover !== null &&
    coverSize !== null &&
    !sharedNames.has(cover) &&
    isOgSized(coverSize)
  ) {
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
  // og が決まっていれば isJsonLdSized(og.size) は今の定数では常に真
  // （MIN_OG_HEIGHT のコメント参照）。定数を変えたときの保険として残している
  const ld =
    og && isJsonLdSized(og.size)
      ? og
      : candidates.find((c) => isJsonLdSized(c.size))

  return {
    ogImage: og ? toUrlPath(og.name) : '',
    jsonLdImage: ld ? toUrlPath(ld.name) : '',
  }
}
