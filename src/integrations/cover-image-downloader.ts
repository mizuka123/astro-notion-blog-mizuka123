import fs from 'node:fs'
import path from 'node:path'
import type { AstroIntegration } from 'astro'
import sharp from 'sharp'
import { getDatabase, downloadFiles } from '../lib/notion/client'
import { coverImageLocalPath } from '../lib/blog-helpers'
import { REQUEST_TIMEOUT_MS } from '../server-constants'

// external のカバーを変換するときの WebP の品質。
// 今のカバー（https://app.notion.com/images/page-cover/gradients_3.png、
// PNG 1500x1500、264,487 バイト）を sharp 0.33.5 で変換して元画像と比べた実測
// （2026-09-25。quality 90 の値はビルドで作られたファイルで測ったもの）:
//   - quality 80: 11,644 バイト、PSNR 49.6 dB、画素ごとの最大誤差 5/255
//   - quality 90: 16,644 バイト、PSNR 50.5 dB、画素ごとの最大誤差 4/255
// 80 との差は 5 KB 程度で、全ページの最上部に出る画像なので誤差の小さい 90 を採る。
// AVIF（quality 70 で 4,473 バイト）はさらに小さいが、非対応ブラウザ向けに
// <picture> が要り、全ページのマークアップが増えるので採らない
const WEBP_QUALITY = 90

// Notion のサーバーはこの画像に Cache-Control を付けず（ETag と
// Last-Modified だけ。2026-09-25 実測）、キャッシュの期間がブラウザの推測任せになる。
// 自サイトの静的ファイルには Cloudflare Pages の既定で
// Cache-Control: public, max-age=14400, must-revalidate が付く。
// そのためビルド時に取得して public/notion/cover/ に置き、自サイトから配信する。
// build:start はページの書き出しと public/ のコピーより前に走るので、ここで書いた
// ファイルは getDatabaseImageURLs() から見え、Astro（Vite）が public/ ごと dist にコピーする。
// 仮にそこで入らなくても、build:done の public-notion-copier が public/notion を
// dist/notion にコピーする（既に同じサイズのファイルがあれば何もしない）。
//
// 寸法はそのまま（縮小も切り抜きもしない）。表示は CSS の
// object-fit: cover / object-position: center 60% でブラウザが切り抜いており、
// 寸法を変えると見え方が変わりうるため。1500px は大きい画面での表示幅にほぼ見合う。
//
// 失敗しても投げない。getDatabaseImageURLs() は変換済みのファイルが無ければ
// 従来どおり外部 URL を返すので、表示は元に戻るだけで済む。Notion の画像サーバーの
// 一時的な障害で本番のデプロイが止まる方が困る（本番ビルドの失敗はサイトの見た目に
// 出ないので気付きにくい）。代わりにログには必ず残す
const convertExternalCover = async (rawUrl: string): Promise<void> => {
  const url = new URL(rawUrl)
  const dest = coverImageLocalPath(rawUrl)

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  let input: Buffer
  try {
    const res = await fetch(url.toString(), { signal: controller.signal })
    if (!res.ok) {
      throw new Error(`HTTP error! status: ${res.status}`)
    }
    // 本文の受信もタイマーの内側で待つ。ヘッダの後で転送が止まったときに
    // ビルドが待ち続けないようにするため
    input = Buffer.from(await res.arrayBuffer())
  } finally {
    clearTimeout(timeoutId)
  }

  fs.mkdirSync(path.dirname(dest), { recursive: true })
  // 一時ファイルに書いてから置き換える。変換の途中で落ちたときに、壊れた
  // ファイルが「変換済み」として参照され dist に入るのを避けるため
  const tmp = `${dest}.tmp`
  try {
    await sharp(input).webp({ quality: WEBP_QUALITY }).toFile(tmp)
    fs.renameSync(tmp, dest)
  } finally {
    fs.rmSync(tmp, { force: true })
  }
}

export default (): AstroIntegration => ({
  name: 'cover-image-downloader',
  hooks: {
    'astro:build:start': async () => {
      const database = await getDatabase()

      if (!database.Cover) {
        return
      }

      if (database.Cover.Type === 'external') {
        try {
          await convertExternalCover(database.Cover.Url)
        } catch (err) {
          // client.ts の displayUrl() と同じく、ログにはクエリを載せない
          // （Unsplash などの external の URL はクエリ付きのことがある）
          let shown = database.Cover.Url
          try {
            const url = new URL(shown)
            shown = `${url.origin}${url.pathname}`
          } catch {
            // 不正な URL はそのまま出す
          }
          console.error(
            `[cover-image-downloader] failed to convert the external cover image; falling back to the external URL: ${shown}`
          )
          console.error(err)
        }
        return
      }

      if (database.Cover.Type !== 'file') {
        return
      }

      await downloadFiles('cover-image-downloader', [database.Cover.Url])
    },
  },
})
