import fs from 'node:fs'
import path from 'path'
import { fileURLToPath } from 'url'
import type { AstroIntegration } from 'astro'

const copyFiles = (src: string, dest: string, stale: string[]) => {
  const entries = fs.readdirSync(src, { withFileTypes: true })
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true })
  }

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name)
    const destPath = path.join(dest, entry.name)

    if (entry.isDirectory()) {
      copyFiles(srcPath, destPath, stale)
    } else if (fs.existsSync(destPath)) {
      // Astro が public/ を dist/ にコピーするため、ここに来る時点で同じ
      // ファイルが既に置かれているのが正常な状態（実測で 21 件）。
      // 問題になるのは中身が違うときで、その場合は public/notion 側の修正が
      // 反映されないまま古いファイルが残る。サイズが一致していれば正常と
      // みなし、違うものだけ報告する
      if (fs.statSync(srcPath).size !== fs.statSync(destPath).size) {
        stale.push(destPath)
      }
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

      const stale: string[] = []
      copyFiles('public/notion', outDir, stale)

      if (stale.length > 0) {
        console.error(
          `${stale.length} file(s) in the output directory differ from public/notion and were NOT overwritten:\n` +
            stale.map((filePath) => `  - ${filePath}`).join('\n')
        )
      }

      console.log('Finished copying notion files to root!')
    },
  },
})
