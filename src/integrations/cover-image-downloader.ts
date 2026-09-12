import type { AstroIntegration } from 'astro'
import { getDatabase, downloadFiles } from '../lib/notion/client'

export default (): AstroIntegration => ({
  name: 'cover-image-downloader',
  hooks: {
    'astro:build:start': async () => {
      const database = await getDatabase()

      if (!database.Cover || database.Cover.Type !== 'file') {
        return
      }

      await downloadFiles('cover-image-downloader', [database.Cover.Url])
    },
  },
})
