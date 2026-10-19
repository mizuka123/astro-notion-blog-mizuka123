import { archiveEntries } from './archive-frontmatter'
import { stripBasePath } from './blog-helpers'
import type { ArchivePostRef } from './archive-taxonomy'

/**
 * アーカイブ記事の末尾に出す「関連記事」を選ぶ。
 *
 * アーカイブ記事は検索から直接入ってくる読者がほとんどで、
 * 以前は本文を読み終えたあとに次に読む記事への導線が無かった
 * （サイドバーのおすすめ記事・最新記事は Notion の記事で、
 * アーカイブの話題とは無関係）。
 *
 * 選び方は frontmatter の tags と categories の重なり。
 * 「canon」のように記事数の多いタグが重なるより、
 * 「eos-5d-mark-iii」のように少ないタグが重なるほうが話題が近いので、
 * 重みは記事数の対数で割る。カテゴリーは 28 種しかなく 1 つあたりの
 * 記事数が多いため、タグより弱くしてある。同点なら日付の近いものを
 * 先にする（同じ機材を買った前後の記事やライブの連作がまとまりやすい）。
 *
 * draft と noindex の記事は候補に入れない。noindex は «中身が薄い» と
 * 判断した記事なので、読者を送っても次の記事にはつながりにくい。
 * frontmatter は src/lib/archive-frontmatter.ts から受け取る
 * （md をモジュールとして読まない理由はそちらの冒頭を参照）
 */

const RELATED_LIMIT = 5
const CATEGORY_WEIGHT = 0.3

interface Candidate extends ArchivePostRef {
  time: number
  categories: string[]
  tags: string[]
}

const candidates: Candidate[] = archiveEntries
  .filter((post) => !post.frontmatter.draft && !post.frontmatter.noindex)
  .map((post) => ({
    title: post.frontmatter.title,
    date: post.frontmatter.date,
    url: stripBasePath(post.url),
    time: new Date(post.frontmatter.date).getTime(),
    categories: post.frontmatter.categories ?? [],
    tags: post.frontmatter.tags ?? [],
  }))

// 重みは候補（draft と noindex を除いた記事）の中での記事数から求める
const countBy = (key: 'categories' | 'tags'): Map<string, number> => {
  const counts = new Map<string, number>()
  for (const post of candidates) {
    for (const name of post[key]) {
      counts.set(name, (counts.get(name) ?? 0) + 1)
    }
  }
  return counts
}
const tagCounts = countBy('tags')
const categoryCounts = countBy('categories')

const weight = (count: number | undefined): number =>
  count ? 1 / Math.log2(count + 1) : 0

/**
 * path は BASE_PATH を含まない生パス（例: '/archive/5007'）。
 * 返す記事の url も同じく生パスで、リンクを出す側が getNavLink() を通す
 */
export const getRelatedArchivePosts = (
  path: string,
  tags: string[] = [],
  categories: string[] = [],
  date?: string
): ArchivePostRef[] => {
  const base = path.replace(/\/$/, '')
  const time = date ? new Date(date).getTime() : NaN
  return candidates
    .filter((post) => post.url !== base)
    .map((post) => {
      let score = 0
      for (const tag of post.tags) {
        if (tags.includes(tag)) score += weight(tagCounts.get(tag))
      }
      for (const category of post.categories) {
        if (categories.includes(category)) {
          score += CATEGORY_WEIGHT * weight(categoryCounts.get(category))
        }
      }
      return { post, score, distance: Math.abs(post.time - time) || 0 }
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.distance - b.distance)
    .slice(0, RELATED_LIMIT)
    .map(({ post: { title, date, url } }) => ({ title, date, url }))
}
