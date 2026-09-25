import type { AstroIntegration } from 'astro'
import { getAllPosts, downloadFiles } from '../lib/notion/client'

export default (): AstroIntegration => ({
  name: 'featured-image-downloader',
  hooks: {
    'astro:build:start': async () => {
      const posts = await getAllPosts()

      const urls = posts
        .map((post) => post.FeaturedImage?.Url)
        .filter((url): url is string => !!url)

      // 幅 1600px 超は縮小する（#128、src/lib/notion/resize-image.ts）。
      // 次の og-image-generator は縮小後の画像から 1200x630 を作るが、縮小後も
      // 幅は 1600px あり、前景を 1200x630 に収めるのに拡大は要らない
      await downloadFiles('featured-image-downloader', urls, {
        shouldResize: () => true,
      })
    },
  },
})
