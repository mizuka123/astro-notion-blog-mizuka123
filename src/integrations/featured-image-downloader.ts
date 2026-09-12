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

      await downloadFiles('featured-image-downloader', urls)
    },
  },
})
