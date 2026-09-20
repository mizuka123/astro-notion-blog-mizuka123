import fs from 'node:fs'
import path from 'node:path'
import { BASE_PATH } from '../server-constants'
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

// ヘッダだけ読めば寸法は分かる。最初は sharp を使っていたが、
// 506 ファイルでビルドが 37 秒伸びたため自前で読むようにした
// （実測: sharp 1313ms に対して 132ms）。
//
// 最初 64KB にしたところ R0011614.jpg だけ判定できなかった。
// EXIF(39KB) と APP2(39KB) が大きく、SOF マーカーが 78,640 バイト目に
// あったため。念のため大きめに取り、それでも足りなければ読み直す
const HEADER_BYTES = 256 * 1024
const MAX_HEADER_BYTES = 4 * 1024 * 1024

const readHead = (filePath: string, bytes: number): Buffer => {
  const fd = fs.openSync(filePath, 'r')
  try {
    const buf = Buffer.alloc(bytes)
    const read = fs.readSync(fd, buf, 0, bytes, 0)
    return buf.subarray(0, read)
  } finally {
    fs.closeSync(fd)
  }
}

// 壊れたファイルから桁違いの値を読んでしまったときに気づけるようにする。
// このブログの実画像は最大 6240px なので、65535（JPEG の幅フィールドの
// 上限）を超えるものは画像として読めていないとみなす
const MAX_SANE_WIDTH = 65535

/** 画像の幅を返す。判定できなければ null。 */
const imageWidth = (buf: Buffer): number | null => {
  // PNG: 署名の次は必ず IHDR チャンクで、その先頭が幅。
  // 署名だけ見て幅を読むと、IHDR 以外が先頭に来る壊れたファイルで
  // 0xdeadbeef のような値をそのまま返してしまう
  if (
    buf.length >= 24 &&
    buf.readUInt32BE(0) === 0x89504e47 &&
    buf.readUInt32BE(4) === 0x0d0a1a0a &&
    buf.readUInt32BE(12) === 0x49484452
  ) {
    return buf.readUInt32BE(16)
  }

  // GIF: ヘッダ直後にリトルエンディアンで幅・高さ
  if (buf.length >= 10 && buf.toString('latin1', 0, 3) === 'GIF') {
    return buf.readUInt16LE(6)
  }

  // WebP: VP8 / VP8L / VP8X で格納場所が違う
  if (
    buf.length >= 30 &&
    buf.toString('latin1', 0, 4) === 'RIFF' &&
    buf.toString('latin1', 8, 12) === 'WEBP'
  ) {
    const kind = buf.toString('latin1', 12, 16)
    if (kind === 'VP8X') return (buf.readUIntLE(24, 3) & 0xffffff) + 1
    if (kind === 'VP8L') return (buf.readUInt32LE(21) & 0x3fff) + 1
    if (kind === 'VP8 ') return buf.readUInt16LE(26) & 0x3fff
    return null
  }

  // JPEG: SOF マーカー（0xC0〜0xCF のうち DHT/DAC/DNL を除く）を探す。
  // セグメント長を使って読み飛ばすので、走査は数回で終わる
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2
    // SOF から幅を読むのに必要なのは i+8 まで。i+9 にすると
    // バッファ末尾ちょうどで終わる SOF を 1 バイト差で取り逃す
    while (i + 8 < buf.length) {
      if (buf[i] !== 0xff) {
        i++
        continue
      }
      const marker = buf[i + 1]
      // 0xFF の詰め物と、長さを持たないマーカーは読み飛ばす
      if (marker === 0xff) {
        i++
        continue
      }
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
        i += 2
        continue
      }
      const length = buf.readUInt16BE(i + 2)
      const isSOF =
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc
      if (isSOF) {
        // SOF: 長さ(2) 精度(1) 高さ(2) 幅(2)
        return buf.readUInt16BE(i + 7)
      }
      i += 2 + length
    }
  }

  return null
}

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
    try {
      // 先頭だけで判定できなければ、一度だけ広げて読み直す。
      // それでも駄目なら共通画像に落とす
      let width = imageWidth(readHead(filePath, HEADER_BYTES))
      if (width === null && fs.statSync(filePath).size > HEADER_BYTES) {
        width = imageWidth(readHead(filePath, MAX_HEADER_BYTES))
      }
      if (width === null || width <= 0 || width > MAX_SANE_WIDTH) {
        // 画像として読めないファイルが混ざっている場合。
        // 黙って共通画像になる理由が分からなくなるので出す
        console.error(
          `archive-og-image: unknown format or implausible width` +
            ` (${width}): ${filePath}`
        )
      } else if (width >= MIN_WIDTH) {
        // encodeURI だと # と ? を素通しするため、foo#1.jpg のような名前で
        // パスが途中までになり、残りがフラグメント扱いになる。
        // ここで encode するのは 1 つのパス要素なので Component の方
        result = pathJoin(
          BASE_PATH,
          `/archive/images/${encodeURIComponent(name)}`
        )
      }
    } catch (err) {
      console.error(`archive-og-image: failed to read: ${filePath}`)
      console.error(err)
    }
  }

  cache.set(name, result)
  return result
}
