import fs from 'node:fs'

/**
 * 画像ファイルの寸法を、ヘッダだけ読んで返す。
 *
 * もとは archive-og-image.ts の中で幅だけを読んでいたもの。
 * <img> に width/height を付けるために高さも要るようになったので、
 * 共有できる形に切り出した。
 *
 * sharp を使わないのは速度のため。506 ファイルで比較したとき
 * sharp は 1313ms、この実装は 132ms で、前者はビルドを 37 秒伸ばした。
 * 対象は 5000 枚規模なので差はさらに大きくなる。
 */

// 最初 64KB にしたところ R0011614.jpg だけ判定できなかった。
// EXIF(39KB) と APP2(39KB) が大きく、SOF マーカーが 78,640 バイト目に
// あったため。念のため大きめに取り、それでも足りなければ読み直す
const HEADER_BYTES = 256 * 1024
const MAX_HEADER_BYTES = 4 * 1024 * 1024

// 壊れたファイルから桁違いの値を読んでしまったときに気づけるようにする。
// このブログの実画像は最大 6240px なので、65535（JPEG の寸法フィールドの
// 上限）を超えるものは画像として読めていないとみなす
const MAX_SANE_SIZE = 65535

export type ImageSize = { width: number; height: number }

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

/** ヘッダから寸法を読む。判定できなければ null。 */
const parse = (buf: Buffer): ImageSize | null => {
  // PNG: 署名の次は必ず IHDR チャンクで、その先頭が幅・高さ。
  // 署名だけ見て読むと、IHDR 以外が先頭に来る壊れたファイルで
  // 0xdeadbeef のような値をそのまま返してしまう
  if (
    buf.length >= 24 &&
    buf.readUInt32BE(0) === 0x89504e47 &&
    buf.readUInt32BE(4) === 0x0d0a1a0a &&
    buf.readUInt32BE(12) === 0x49484452
  ) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
  }

  // GIF: ヘッダ直後にリトルエンディアンで幅・高さ
  if (buf.length >= 10 && buf.toString('latin1', 0, 3) === 'GIF') {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) }
  }

  // WebP: VP8 / VP8L / VP8X で格納場所が違う
  if (
    buf.length >= 30 &&
    buf.toString('latin1', 0, 4) === 'RIFF' &&
    buf.toString('latin1', 8, 12) === 'WEBP'
  ) {
    const kind = buf.toString('latin1', 12, 16)
    if (kind === 'VP8X') {
      return {
        width: (buf.readUIntLE(24, 3) & 0xffffff) + 1,
        height: (buf.readUIntLE(27, 3) & 0xffffff) + 1,
      }
    }
    if (kind === 'VP8L') {
      // 14 ビットずつ詰まっている。幅の次に高さ
      const bits = buf.readUInt32LE(21)
      return {
        width: (bits & 0x3fff) + 1,
        height: ((bits >> 14) & 0x3fff) + 1,
      }
    }
    if (kind === 'VP8 ') {
      return {
        width: buf.readUInt16LE(26) & 0x3fff,
        height: buf.readUInt16LE(28) & 0x3fff,
      }
    }
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
        return {
          width: buf.readUInt16BE(i + 7),
          height: buf.readUInt16BE(i + 5),
        }
      }
      i += 2 + length
    }
  }

  return null
}

const isSane = (size: ImageSize | null): size is ImageSize =>
  size !== null &&
  size.width > 0 &&
  size.height > 0 &&
  size.width <= MAX_SANE_SIZE &&
  size.height <= MAX_SANE_SIZE

// 同じ画像を複数の記事が使うため、1 ファイルにつき 1 回だけ読む。
// ビルド 1 回分しか生きないので寿命の管理は不要。
// 読めなかったことも覚えておく（値として null を入れる）
const cache = new Map<string, ImageSize | null>()

/**
 * 画像の寸法を返す。読めない・値が不自然なら null。
 * 呼び出し側が存在確認済みのパスを渡すこと。
 */
export const imageSize = (filePath: string): ImageSize | null => {
  const cached = cache.get(filePath)
  if (cached !== undefined) {
    return cached
  }

  let result: ImageSize | null = null
  try {
    // 先頭だけで判定できなければ、一度だけ広げて読み直す
    let size = parse(readHead(filePath, HEADER_BYTES))
    if (size === null && fs.statSync(filePath).size > HEADER_BYTES) {
      size = parse(readHead(filePath, MAX_HEADER_BYTES))
    }
    if (isSane(size)) {
      result = size
    }
  } catch {
    // 呼び出し側が「取れなかった」として扱えるよう null のままにする。
    // ここで投げるとビルドが 1 ファイルの破損で止まってしまう
    result = null
  }

  cache.set(filePath, result)
  return result
}
