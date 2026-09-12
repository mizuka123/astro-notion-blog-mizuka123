import type { AstroIntegration } from 'astro'
import { getDatabase, downloadFiles } from '../lib/notion/client'

export default (): AstroIntegration => ({
  name: 'custom-icon-downloader',
  hooks: {
    'astro:build:start': async () => {
      const database = await getDatabase()

      // Type がリテラル型になったので、この判定だけで FileObject に絞り込める
      // （以前は Type: string で絞り込めず as FileObject のキャストが要った）
      if (!database.Icon || database.Icon.Type !== 'file') {
        return
      }

      await downloadFiles('custom-icon-downloader', [database.Icon.Url])
    },
  },
})
