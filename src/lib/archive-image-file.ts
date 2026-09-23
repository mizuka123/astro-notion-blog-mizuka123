import path from 'node:path'
import { BASE_PATH } from '../server-constants'

/**
 * アーカイブ記事の本文にある画像 URL を、public/ の下のファイルに対応づける。
 *
 * もとは rehype-image-dimensions.ts の中にあった toFilePath。
 * OGP 画像を本文から選ぶ（archive-og-image.ts）ようになり、同じ URL を
 * «別の場所でも» ファイルに変換する必要が出たので切り出した。
 * 片方だけ安全策を直すと、もう片方から public/ の外を読めてしまうため、
 * 変換は必ずここを通すこと。
 */

// 対象はこの下にある画像だけ。移行した記事の画像はすべてここにある。
// 外部の画像は寸法が分からないうえ、アフィリエイトの計測ビーコンも
// 画像なので触らない（取得すると成果計測が汚れる）
export const ARCHIVE_IMAGE_URL_PREFIX = '/archive/images/'
export const ARCHIVE_IMAGE_DIR = 'public/archive/images'

/**
 * URL のパスから、public/archive/images/ の下のファイル名（デコード済み）を
 * 返す。対象外なら null。
 */
export const archiveImageName = (src: unknown): string | null => {
  if (typeof src !== 'string') return null

  // BASE_PATH を設定している場合は取り除いてから見る。
  // 切り落とした残りが / で始まることまで確かめる。単なる前方一致だと
  // BASE_PATH='/arch' のような値のときに /archive/images/x.jpg を
  // 削りすぎて、黙って対象外になってしまう
  const rest =
    BASE_PATH && src.startsWith(BASE_PATH) ? src.slice(BASE_PATH.length) : null
  const withoutBase = rest !== null && rest.startsWith('/') ? rest : src
  if (!withoutBase.startsWith(ARCHIVE_IMAGE_URL_PREFIX)) return null

  // 記事には %2B（+ のエンコード）を含む参照が 76 件ある。
  // デコードしないとファイルが見つからない
  let name: string
  try {
    name = decodeURIComponent(
      withoutBase.slice(ARCHIVE_IMAGE_URL_PREFIX.length)
    )
  } catch {
    // 不正なエスケープ。対象外として扱う
    return null
  }

  // ディレクトリを抜け出す参照は扱わない
  if (!name || name.includes('/') || name.includes('\\') || name === '..') {
    return null
  }

  return name
}

/** URL のパスから、読み出すファイルのパスを返す。対象外なら null。 */
export const archiveImageFilePath = (src: unknown): string | null => {
  const name = archiveImageName(src)
  return name === null ? null : path.join(ARCHIVE_IMAGE_DIR, name)
}

/**
 * frontmatter の coverImage から、public/archive/images/ の下のファイル名を
 * 返す。空や、ディレクトリを抜け出す値なら null。
 *
 * coverImage は URL ではなくファイル名だけが書かれている（609 記事の
 * 実データで / や \ を含む値は 0 件）ので、デコードはせず、
 * archiveImageName() と同じ «ディレクトリを抜けない» 確認だけをする
 */
export const archiveCoverImageName = (
  coverImage: string | undefined
): string | null => {
  const name = coverImage?.trim()
  if (!name || name.includes('/') || name.includes('\\') || name === '..') {
    return null
  }
  return name
}
