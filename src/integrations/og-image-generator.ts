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

// 元画像を引き伸ばしてぼかした背景の上に、全体が収まるよう縮めた画像を重ねる。
// 切り取らずに 1.91:1 を埋めるための手法
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

  // withoutEnlargement を付けないと、1200x630 より小さい画像が引き伸ばされて
  // 一番目立つ前景がぼやける。背景は元々ぼかすので拡大しても困らない
  const foreground = await sharp(src)
    .resize(OG_WIDTH, OG_HEIGHT, { fit: 'inside', withoutEnlargement: true })
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
    // Astro は integrations の配列順に astro:build:start を直列で await する
    // （node_modules/astro/dist/integrations/hooks.js の runHookBuildStart）
    'astro:build:start': async () => {
      const posts = await getAllPosts()

      const rawUrls = posts
        .map((post) => post.FeaturedImage?.Url)
        .filter((url): url is string => !!url)

      const failures: string[] = []

      // 複数の記事が同じ画像を使っていると同じパスへ二重に書き込むことになる。
      // downloadFiles() と同じく、保存先パスをキーに重複を除く
      const urls: URL[] = []
      const seen = new Set<string>()
      for (const rawUrl of rawUrls) {
        let url!: URL
        try {
          url = new URL(rawUrl)
        } catch (err) {
          console.error(`og-image-generator: invalid URL: ${rawUrl}`)
          console.error(err)
          failures.push(`${rawUrl} (invalid URL)`)
          continue
        }
        const key = url.pathname.split('/').slice(-2).join('/')
        if (seen.has(key)) {
          continue
        }
        seen.add(key)
        urls.push(url)
      }

      // 生成し直すかどうかを元画像の更新時刻で判定しようとしたが、
      // downloadFile() は毎回無条件に上書きするため元が常に新しくなり、
      // 判定が効かない。さらに生成パラメータ（サイズやぼかし量）を変えても
      // 時刻は変わらないので、古い画像が残ったことに気づけない。
      // 毎回作り直す方が安全で、実測でも 20 枚で数十秒に収まる
      let generated = 0

      for (const url of urls) {
        const src = localSourcePath(url)
        const dest = ogImageLocalPath(url)

        if (!fs.existsSync(src)) {
          // featured-image-downloader が落とせていれば起こらない。
          // 起きたなら両者のパスの組み立てがずれているということなので、
          // 黙って飛ばさず失敗として扱う
          console.error(`og-image-generator: source not found: ${src}`)
          failures.push(`${src} (source not found)`)
          continue
        }

        try {
          await generate(src, dest)
          generated++
        } catch (err) {
          // 途中まで書かれた JPEG が残ると、[slug].astro の existsSync が
          // 「生成済み」と判定して壊れた画像を og:image にしてしまう。
          // downloadFile() と同じく消しておく。
          // 後始末の失敗で本来のエラーを覆い隠さないよう、ここでは投げない
          try {
            fs.rmSync(dest, { force: true })
          } catch (cleanupErr) {
            console.error(`og-image-generator: failed to remove ${dest}`)
            console.error(cleanupErr)
          }
          console.error(`og-image-generator: failed to generate from ${src}`)
          console.error(err)
          failures.push(src)
        }
      }

      console.log(
        `og-image-generator: generated ${generated} of ${urls.length}` +
          ` (${rawUrls.length} posts with a featured image)`
      )

      // 黙って元画像にフォールバックすると、数 MB の画像が OGP として
      // 配信され続けても誰も気づかない。downloadFiles() と同じく、
      // 1 件でも失敗したらビルドを止める
      if (failures.length > 0) {
        throw new Error(
          `og-image-generator: ${failures.length} of ${urls.length} images failed:\n` +
            failures.map((failure) => `  - ${failure}`).join('\n')
        )
      }
    },
  },
})
