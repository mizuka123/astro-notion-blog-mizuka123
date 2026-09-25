import fs from 'node:fs'
import sharp from 'sharp'

// Notion 記事の画像を、ダウンロードした後に幅 MAX_WIDTH まで縮めて同じパスに書き戻す（#128）。
//
// 基準はアーカイブ記事の画像を縮小・再圧縮した #84 / #85 に揃えている:
//   - 幅 1600px 上限（#84。本文カラムの表示幅 約 900px + 高 DPI 相当）。縦横比は保ち、拡大はしない
//   - JPEG は mozjpeg の品質 85（#85。#84 は q82 だったが、#85 で代表 40 枚を比べて
//     q82 → q85 で削減 −7 ポイント / PSNR +1.0 dB となり、写真が主役のブログなので
//     画質側に寄せて q85 にした。今の配信画像の基準はこちら）
//   - PNG は compressionLevel 9（#84）。アルファチャンネルは保持する（sharp の既定）
//   - EXIF の向きを画素に反映してから縮小する（#84 と同じ rotate()）。出力には
//     EXIF を書かないので、ブラウザがもう一度回転させることはない
//   - sRGB 以外の ICC プロファイルは保持する（#85 のレビュー対応。Generic RGB の
//     2 枚でプロファイルを落とし、平均輝度が 101.7 → 90.2 と暗くなった）。sRGB の
//     プロファイルは落とす（戻しても表示は変わらず、1 枚 3KB 前後増えるだけ）
//   - 再エンコードで逆に大きくなるものは触らない（#84）
//   - 一時ファイルに書いてから rename する（#84）
// WebP はアーカイブに無く基準が無いので、JPEG と同じ品質 85 にした。
//
// 形式とファイル名は変えない。URL は Notion のファイル名から決まっていて、
// 本文の <img>・og:image・既存のリンクがそのパスを指しているため。
// GIF（アニメーション）と SVG、複数フレームの WebP、CMYK の JPEG は触らない。
//
// 縮小後の幅は MAX_WIDTH になるので、次のビルドで同じファイルに対して呼ばれても
// 幅の判定で何もせずに返る（再圧縮を繰り返して劣化が積み重ならない）。
export const MAX_WIDTH = 1600
const JPEG_QUALITY = 85
const WEBP_QUALITY = 85
const PNG_COMPRESSION_LEVEL = 9

type Size = { width: number; height: number; bytes: number }

export type ResizeResult =
  | { status: 'skipped' }
  | { status: 'resized'; before: Size; after: Size; ms: number }
  | { status: 'kept'; before: Size; after: Size; ms: number }
  | { status: 'failed'; error: unknown }

/**
 * ICC プロファイルの説明（desc タグ）を返す。読めなければ null。
 * v2 のプロファイルは 'desc' 型（ASCII）、v4 は 'mluc' 型（UTF-16BE）で持つ
 */
export const iccDescription = (icc: Buffer): string | null => {
  try {
    const count = icc.readUInt32BE(128)
    for (let i = 0; i < count; i++) {
      const entry = 132 + i * 12
      if (icc.toString('latin1', entry, entry + 4) !== 'desc') {
        continue
      }
      const offset = icc.readUInt32BE(entry + 4)
      const type = icc.toString('latin1', offset, offset + 4)
      if (type === 'desc') {
        const length = icc.readUInt32BE(offset + 8)
        return icc
          .toString('latin1', offset + 12, offset + 12 + length)
          .replace(/\0+$/, '')
      }
      if (type === 'mluc') {
        const recordLength = icc.readUInt32BE(offset + 20)
        const recordOffset = icc.readUInt32BE(offset + 24)
        const utf16be = icc.subarray(
          offset + recordOffset,
          offset + recordOffset + recordLength
        )
        return Buffer.from(utf16be).swap16().toString('utf16le')
      }
      return null
    }
  } catch {
    // 壊れたプロファイル。呼び出し側で「sRGB ではない」として扱う
  }
  return null
}

const isSrgbProfile = (icc: Buffer): boolean =>
  /sRGB/i.test(iccDescription(icc) ?? '')

/**
 * filepath の画像の幅が MAX_WIDTH を超えていれば、幅 MAX_WIDTH に縮めて同じパスに書き戻す。
 *
 * 投げない。失敗したら元の画像を残して console.error に書く。止めるより元の画像で
 * 配信を続ける方が安全なため（本番ビルドの失敗はサイトの見た目に出ず気付きにくい）
 */
export async function resizeDownloadedImage(
  filepath: string,
  label: string
): Promise<ResizeResult> {
  const tmp = `${filepath}.resize-tmp`
  try {
    // ファイルのパスを sharp に直接渡さず Buffer で読む。Windows では sharp が
    // 開いたままのファイルを rename で置き換えられないことがあるため
    const input = await fs.promises.readFile(filepath)
    const metadata = await sharp(input).metadata()

    if (
      !metadata.width ||
      !metadata.height ||
      !['jpeg', 'png', 'webp'].includes(metadata.format ?? '') ||
      (metadata.pages ?? 1) > 1
    ) {
      return { status: 'skipped' }
    }

    // CMYK の画像は縮小せず元のまま残す。sharp は CMYK（4 チャンネル）を sRGB
    // （3 チャンネル）に変換して書き出すので、#85 で ICC プロファイルを落として色が
    // 暗くなったのと同じ種類の色の変化が起きうる。出力の検査は形式と幅しか見ないので
    // 気付けない。元のまま（ブラウザの今の表示のまま）配信する方を選ぶ。
    // 今の Notion 記事の画像に CMYK は無い（public/notion の 64 枚を sharp の
    // metadata で確かめて 0 枚。すべて srgb）
    if (metadata.space === 'cmyk') {
      console.log(
        `[${label}] kept the original (CMYK; converting to sRGB could shift colours): ${filepath}`
      )
      return { status: 'skipped' }
    }

    // EXIF の向きが 5〜8 なら表示では縦横が入れ替わる。表示上の幅で判定する
    const swapsAxes = (metadata.orientation ?? 1) >= 5
    const displayWidth = swapsAxes ? metadata.height : metadata.width
    const displayHeight = swapsAxes ? metadata.width : metadata.height
    if (displayWidth <= MAX_WIDTH) {
      return { status: 'skipped' }
    }

    const started = performance.now()
    let image = sharp(input)
      .rotate()
      .resize({ width: MAX_WIDTH, withoutEnlargement: true })
    if (metadata.icc && !isSrgbProfile(metadata.icc)) {
      image = image.keepIccProfile()
    }
    if (metadata.format === 'jpeg') {
      image = image.jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
    } else if (metadata.format === 'png') {
      image = image.png({ compressionLevel: PNG_COMPRESSION_LEVEL })
    } else {
      image = image.webp({ quality: WEBP_QUALITY })
    }
    const { data, info } = await image.toBuffer({ resolveWithObject: true })
    const ms = Math.round(performance.now() - started)

    const before = {
      width: displayWidth,
      height: displayHeight,
      bytes: input.length,
    }
    const after = { width: info.width, height: info.height, bytes: data.length }

    // 書き戻す前に、形式と寸法が意図どおりかを確かめる
    if (info.format !== metadata.format || info.width !== MAX_WIDTH) {
      throw new Error(
        `unexpected output: ${info.format} ${info.width}x${info.height}`
      )
    }

    if (data.length >= input.length) {
      console.log(
        `[${label}] kept the original (re-encoding made it larger): ${filepath} ` +
          `${before.width}x${before.height} ${before.bytes} B -> ` +
          `${after.width}x${after.height} ${after.bytes} B (${ms} ms)`
      )
      return { status: 'kept', before, after, ms }
    }

    await fs.promises.writeFile(tmp, data)
    await fs.promises.rename(tmp, filepath)

    console.log(
      `[${label}] resized: ${filepath} ` +
        `${before.width}x${before.height} ${before.bytes} B -> ` +
        `${after.width}x${after.height} ${after.bytes} B (${ms} ms)`
    )
    return { status: 'resized', before, after, ms }
  } catch (error) {
    console.error(
      `[${label}] failed to resize; serving the original: ${filepath}`
    )
    console.error(error)
    return { status: 'failed', error }
  } finally {
    await fs.promises.rm(tmp, { force: true }).catch(() => {})
  }
}
