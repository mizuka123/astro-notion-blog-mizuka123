import type { AstroIntegration } from 'astro'
import type { FileObject } from '../lib/interfaces'
import { getDatabase, downloadFiles } from '../lib/notion/client'

export default (): AstroIntegration => ({
  name: 'custom-icon-downloader',
  hooks: {
    'astro:build:start': async () => {
      const database = await getDatabase()

      if (!database.Icon || database.Icon.Type !== 'file') {
        return
      }

      const icon = database.Icon as FileObject

      await downloadFiles('custom-icon-downloader', [icon.Url])
    },
  },
})
