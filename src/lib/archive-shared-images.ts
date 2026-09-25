import type { MarkdownInstance } from 'astro'
import { archiveImageName, archiveCoverImageName } from './archive-image-file'

/**
 * 2 つ以上のアーカイブ記事から参照されている画像ファイル名の一覧。
 *
 * public/archive/images/ は WordPress の年/月ディレクトリ
 * （wp-content/uploads/2012/05/ など）を 1 つに畳んだもので、
 * 別の月に上げた «同じ名前の別の画像» が 1 ファイルに潰れている。
 * 実測で、参照される画像名 5,068 種のうち 178 種が 2 記事以上から
 * 参照されている（本文の /archive/images/ 参照と coverImage を合わせて、
 * 記事単位で数えた）。たとえば image_thumb.png は 7 記事から参照
 * されているが、実ファイルは 1 つなので中身が合うのは多くて 1 記事で、
 * 残りの記事では «無関係な画像» になる（回線速度テストの画面が
 * 別の記事の画像として出ていた）。
 *
 * どの記事が本来の持ち主かは中身を見ないと決められないので、
 * archive-og-image.ts はここに入っている名前を、coverImage をそのまま使う
 * 分岐（#125 から）と «本文から新しく選ぶ候補» の両方からすべて外す
 * （保守側に倒す）。
 *
 * 索引は全記事を見ないと作れないが、remark プラグインは 1 ファイルずつ
 * 呼ばれ、他の記事を見られない。そこで Astro が md ごとに export する
 * frontmatter（remark-archive-images が入れた bodyImages を含む）を
 * import.meta.glob で読む。md を fs と正規表現で読み直すと、本文から
 * 画像を拾う規則が remark-archive-images と別に 2 つ目できてしまい、
 * «索引では共有なのに候補では別の名前» といった食い違いが起きうる。
 * glob なら候補と索引が同じ bodyImages から作られる。
 *
 * glob を eager にしないのは循環参照のため。この関数を呼ぶのは
 * LayoutMd.astro で、LayoutMd.astro は各 md から読み込まれる。eager だと
 * md の評価中に «評価途中の自分自身» を読みに行くことになる。
 * 遅延させて、最初に呼ばれた時点（全モジュールの評価が済んだ後の
 * レンダリング中）に 1 回だけ読む。
 */

type Frontmatter = { coverImage?: string; bodyImages?: string[] }

const archiveModules = import.meta.glob<MarkdownInstance<Frontmatter>>(
  '../pages/archive/*.md'
)

let shared: Promise<ReadonlySet<string>> | null = null

const build = async (): Promise<ReadonlySet<string>> => {
  const loaders = Object.values(archiveModules)
  // import.meta.glob は 0 件でも例外を投げない。ここが空だと
  // «共有された名前が 1 つも無い» ことになり、無関係な画像を黙って
  // 選び直してしまうので止める
  if (loaders.length === 0) {
    throw new Error(
      "src/lib/archive-shared-images.ts の '../pages/archive/*.md' がひとつもマッチしませんでした。アーカイブ記事の配置を確認してください。"
    )
  }

  const modules = await Promise.all(loaders.map((load) => load()))
  const articleCount = new Map<string, number>()
  for (const { frontmatter } of modules) {
    // 1 記事の中で同じ画像を 2 回使うのは «共有» ではないので、
    // 記事ごとに名前を重複なしで数える
    const names = new Set<string>()
    const cover = archiveCoverImageName(frontmatter.coverImage)
    if (cover !== null) names.add(cover)
    for (const url of frontmatter.bodyImages ?? []) {
      const name = archiveImageName(url)
      if (name !== null) names.add(name)
    }
    for (const name of names) {
      articleCount.set(name, (articleCount.get(name) ?? 0) + 1)
    }
  }

  return new Set(
    [...articleCount].filter(([, count]) => count >= 2).map(([name]) => name)
  )
}

/** 2 記事以上から参照されている画像ファイル名（デコード済み）。 */
export const sharedArchiveImageNames = (): Promise<ReadonlySet<string>> => {
  shared ??= build()
  return shared
}
