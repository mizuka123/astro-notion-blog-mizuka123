import fs from 'node:fs'
import path from 'node:path'
import type { AstroIntegration } from 'astro'
import sharp from 'sharp'
import { getDatabase, downloadFiles } from '../lib/notion/client'
import { coverImageLocalPath } from '../lib/blog-helpers'
import { REQUEST_TIMEOUT_MS } from '../server-constants'

// external のカバーの変換方法は 2 通り。
//
// Notion 標準のグラデーションと単色（isNotionFlatCover）は、幅 FLAT_COVER_WIDTH に
// 縮小して（縦横比は保つ。カーネルは sharp の既定の lanczos3）ロスレスの WebP にし、
// 表示の大きさへの拡大はブラウザに任せる。
// #147 では寸法そのままの quality 90 の WebP にしていた。元画像との PSNR が 50 dB 程度で
// 画素の最大誤差も小さいので見分けにくいと判断したが、緩やかなグラデーションでは、
// 非可逆の WebP がブロック単位で近似した階調の段差が縦の縞とムラとして見えた（#149）。
// 今のカバー（https://app.notion.com/images/page-cover/gradients_3.png、
// PNG 1500x1500、264,487 バイト）を sharp 0.33.5 で変換し、表示と同じ幅 1920px・
// 高さ 216px（縦位置 60% で切り抜き）に拡大して、元の PNG を同じ手順で拡大・切り抜いた
// ものと比べた実測（2026-09-25。拡大の補間は nearest / linear / cubic の 3 通り）。
// 「逆転」は、横に隣り合う画素の値の増減の向きが入れ替わった回数（216 行 x 3 チャンネル）
// で、縞の目安。元の PNG はどの補間でも 0:
//   - 1500px ロスレス: 269,116 バイト（元の PNG より大きい）
//   - 500px ロスレス: 54,604 バイト、画素ごとの最大誤差 1/255、逆転 0（3 通りとも）
//   - 375px ロスレス: 38,114 バイト、最大誤差 1/255、逆転 0（3 通りとも）
//   - 250px ロスレス: 20,404 バイト、最大誤差 1/255、逆転は nearest と linear で 0、
//     cubic で 1,292（ごく薄い縦の段差として見える）
//   - 1500px quality 90（#147）: 16,644 バイト、最大誤差 3/255、逆転 2 万余り（縞が見える）
// 試した幅（250 / 375 / 500 / 750px）のうち、ブラウザがどの補間で拡大しても逆転が
// 0 になる最小の幅として 375px を採る。
//
// それ以外（写真など。Notion 標準でも nasa_ や met_ などは写真）は、寸法そのままの
// quality 90 の WebP にする。375px に縮小すると細部が潰れるため。
// AVIF はさらに小さいが、非対応ブラウザ向けに <picture> が要り、全ページの
// マークアップが増えるので採らない
const WEBP_QUALITY = 90
const FLAT_COVER_WIDTH = 375

const NOTION_COVER_HOSTS = new Set([
  'app.notion.com',
  'www.notion.so',
  'notion.so',
])
const NOTION_FLAT_COVER_PATH_PREFIXES = [
  '/images/page-cover/gradients_',
  '/images/page-cover/solid_',
]

/**
 * Notion 標準のグラデーションか単色のカバーか。URL のホストとパスで判定する
 */
export const isNotionFlatCover = (url: URL): boolean =>
  NOTION_COVER_HOSTS.has(url.hostname) &&
  NOTION_FLAT_COVER_PATH_PREFIXES.some((prefix) =>
    url.pathname.startsWith(prefix)
  )

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
// 切り抜きはしない。表示は CSS の object-fit: cover / object-position: center 60% で
// ブラウザが切り抜いており、縦横比を変えると見え方が変わりうるため。
// グラデーションと単色の縮小は縦横比を保つので、切り抜かれる範囲は変わらない。
//
// 毎回のビルドで取得・変換し、同じファイル名に上書きする。変換の方法を変えたときに、
// 前のビルドの変換結果（public/notion/cover/ に残る）がそのまま使われることはない。
// ただし取得や変換に失敗した回は上書きされず、残っている前の結果が使われる。
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
    const image = sharp(input)
    const converted = isNotionFlatCover(url)
      ? image
          .resize({ width: FLAT_COVER_WIDTH, withoutEnlargement: true })
          .webp({ lossless: true })
      : image.webp({ quality: WEBP_QUALITY })
    await converted.toFile(tmp)
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
