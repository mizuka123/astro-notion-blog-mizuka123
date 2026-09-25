import fs from 'node:fs'
import path from 'path'
import { fileURLToPath } from 'url'
import type { AstroIntegration } from 'astro'

// サイズが同じなら中身も読んで比べる。再エンコードなどで同じバイト数の
// 別の画像になることがあり、サイズだけでは見分けられないため。
// ハッシュではなくバイト列をそのまま比べる（一致の判定には十分で、計算も要らない）。
// 読む量は dist/notion と public/notion を合わせて 44MB 程度（2026-09-26 実測、
// 85 ファイル × 2。全部を読んでハッシュまで計算しても 0.2 秒弱）で、
// ビルド全体（約 2 分）に比べて無視できる
const sameContent = (a: string, b: string) =>
  fs.statSync(a).size === fs.statSync(b).size &&
  fs.readFileSync(a).equals(fs.readFileSync(b))

const copyFiles = (src: string, dest: string, overwritten: string[]) => {
  const entries = fs.readdirSync(src, { withFileTypes: true })
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true })
  }

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name)
    const destPath = path.join(dest, entry.name)

    if (entry.isDirectory()) {
      copyFiles(srcPath, destPath, overwritten)
    } else if (fs.existsSync(destPath)) {
      // Astro が public/ を dist/ にコピーするため、ここに来る時点で同じ
      // ファイルが既に置かれているのが正常な状態（実測で 21 件）。
      // 問題になるのは中身が違うときで、Vite が public/ をコピーするのは
      // ページの生成より前なので、public/notion に前回のビルドのファイルが
      // 残っている（手元のビルド）と、それが dist に入る。本文の画像の
      // ダウンロードと縮小はページの生成中に public/notion 側だけを書き換える
      // ため、ここで違っていれば public/notion 側がビルドの中で最後に書かれた
      // 正しいファイルで、dist 側が古い。報告だけで残すと古いファイルが黙って
      // 配信されるので、public/notion 側で上書きして正しい状態にする（#157）。
      // ビルドは止めない（上書きすれば直っているため）
      if (!sameContent(srcPath, destPath)) {
        fs.copyFileSync(srcPath, destPath)
        overwritten.push(destPath)
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

      const overwritten: string[] = []
      copyFiles('public/notion', outDir, overwritten)

      for (const filePath of overwritten) {
        console.warn(`Overwrote stale file with public/notion: ${filePath}`)
      }
      if (overwritten.length > 0) {
        console.warn(
          `${overwritten.length} file(s) in the output directory differed from public/notion and were overwritten`
        )
      }

      console.log('Finished copying notion files to root!')
    },
  },
})
