import fs from 'node:fs'
import path from 'node:path'
import type { AstroIntegration } from 'astro'
import sharp from 'sharp'
import { getAllPosts } from '../lib/notion/client'
import { ogImageLocalPath } from '../lib/blog-helpers'

// OGP の推奨サイズ。Twitter の summary_large_image も Facebook も
// 1.91:1 で切り出すため、この比率で作っておけば切られない
const OG_WIDTH = 1200
const OG_HEIGHT = 630

// 元画像を引き伸ばしてぼかし、その上に全体が収まるよう縮めた画像を重ねる。
// 切り取らずに 1.91:1 を埋めるための手法。縦長のスクリーンショットが
// 中央の帯だけになるのを防ぐのが目的
const BACKGROUND_BLUR = 24

const JPEG_QUALITY = 80

const localSourcePath = (url: URL): string => {
  const [dir, filename] = url.pathname.split('/').slice(-2)
  // downloadFile() と同じ規約。ディレクトリ名はエンコードのまま、
  // ファイル名は decodeURIComponent した名前で保存されている
  return path.join('public/notion', dir, decodeURIComponent(filename))
}

const generate = async (src: string, dest: string): Promise<void> => {
  const background = await sharp(src)
    .resize(OG_WIDTH, OG_HEIGHT, { fit: 'cover' })
    .blur(BACKGROUND_BLUR)
    .toBuffer()

  const foreground = await sharp(src)
    .resize(OG_WIDTH, OG_HEIGHT, { fit: 'inside' })
    .toBuffer()

  await sharp(background)
    .composite([{ input: foreground, gravity: 'center' }])
    .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
    .toFile(dest)
}

export default (): AstroIntegration => ({
  name: 'og-image-generator',
  hooks: {
    // featured-image-downloader より後に登録すること。
    // ダウンロード済みのファイルを読んで加工する
    'astro:build:start': async () => {
      const posts = await getAllPosts()

      const urls = posts
        .map((post) => post.FeaturedImage?.Url)
        .filter((url): url is string => !!url)
        .map((url) => new URL(url))

      let generated = 0
      let skipped = 0
      const missing: string[] = []
      const failed: { src: string; err: unknown }[] = []

      for (const url of urls) {
        const src = localSourcePath(url)
        const dest = ogImageLocalPath(url)

        if (!fs.existsSync(src)) {
          // featured-image-downloader が落とせなかったもの。
          // ここで止めはしないが、黙って飛ばすと og:image が元画像の
          // ままになっている理由が分からなくなるので必ず出す
          missing.push(src)
          continue
        }

        // 元画像より新しい生成物があれば作り直さない。
        // Notion で画像を差し替えると元が新しくなるので再生成される
        if (
          fs.existsSync(dest) &&
          fs.statSync(dest).mtimeMs >= fs.statSync(src).mtimeMs
        ) {
          skipped++
          continue
        }

        try {
          await generate(src, dest)
          generated++
        } catch (err) {
          // 1 枚壊れていてもサイト全体のビルドは通す。
          // 生成できなかった記事は [slug].astro が元画像に戻る
          failed.push({ src, err })
        }
      }

      console.log(
        `og-image-generator: generated ${generated}, up-to-date ${skipped}` +
          `, missing source ${missing.length}, failed ${failed.length}`
      )

      for (const src of missing) {
        console.error(`og-image-generator: source not found: ${src}`)
      }
      for (const { src, err } of failed) {
        console.error(`og-image-generator: failed to generate from ${src}`)
        console.error(err)
      }
    },
  },
})
