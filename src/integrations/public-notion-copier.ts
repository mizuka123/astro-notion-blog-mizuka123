import fs from 'node:fs'
import path from 'path'
import { fileURLToPath } from 'url'
import type { AstroIntegration } from 'astro'

const copyFiles = (src: string, dest: string, skipped: string[]) => {
  const entries = fs.readdirSync(src, { withFileTypes: true })
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true })
  }

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name)
    const destPath = path.join(dest, entry.name)

    if (entry.isDirectory()) {
      copyFiles(srcPath, destPath, skipped)
    } else if (fs.existsSync(destPath)) {
      // Astro の emptyOutDir は既定で true なので通常ここには来ない。
      // 来た場合（emptyOutDir を切った、出力先を再利用した等）は、古い
      // ファイルが残り続けて public/notion 側の修正が反映されないため、
      // 黙ってスキップせずログに出す
      skipped.push(destPath)
    } else {
      fs.copyFileSync(srcPath, destPath)
    }
  }
}

export default (): AstroIntegration => ({
  name: 'public-notion-copier',
  hooks: {
    'astro:build:done': async ({ dir }) => {
      const dirPath = fileURLToPath(dir)
      const outDir = path.join(dirPath, 'notion')
      if (!fs.existsSync(outDir)) {
        fs.mkdirSync(outDir, { recursive: true })
      }

      const skipped: string[] = []
      copyFiles('public/notion', outDir, skipped)

      if (skipped.length > 0) {
        console.error(
          `Kept ${skipped.length} existing file(s) in the output directory instead of copying from public/notion:\n` +
            skipped.map((filePath) => `  - ${filePath}`).join('\n')
        )
      }

      console.log('Finished copying notion files to root!')
    },
  },
})
