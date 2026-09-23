import type { MarkdownInstance } from 'astro'
import { getAllPosts } from '../lib/notion/client'
import { getNavLink, getPostLink, stripBasePath } from '../lib/blog-helpers'

/**
 * サイト内検索のインデックス。
 *
 * これまで SearchModal.astro は RSS（/feed）を取ってきて検索対象にしていた。
 * /feed は Notion のデータベースから作られるので、載るのは記事 23 件だけ。
 * WordPress から移行したアーカイブ 609 件は、ページとしては存在するのに
 * 検索からは 1 件も引けない状態だった（全 632 記事の 96.4% が対象外）。
 *
 * アーカイブを /feed に足す手もあったが、RSS は購読者向けのもので、
 * 2015 年前後の記事 609 件を流し込むと購読側の未読が一気に増える。
 * 「購読するための RSS」と「検索するためのインデックス」は用途が違うので、
 * 検索専用の JSON をここで別に出すことにした。/feed は一切触っていない。
 */

// src/pages/archive/*.md の frontmatter のうち、ここが読むものだけ。
// LayoutMd.astro と archive/index.astro にも別の宣言があるが、
// 読む項目がそれぞれ違うので名前を分けてある
interface ArchiveIndexFrontmatter {
  title: string
  date: string
  draft?: boolean
}

export interface SearchIndexItem {
  title: string
  link: string
  /**
   * アーカイブ記事には付けない（下の «インデックスの大きさ» を参照）。
   * 受け取る側は無い前提で扱うこと
   */
  description?: string
}

/**
 * «インデックスの大きさ»
 *
 * アーカイブ 609 件を足すと、検索インデックスは当然その分だけ重くなる。
 * 何をどこまで載せるかは、実際に JSON を組んでバイト数を測って決めた
 * （description は変更前の dist/archive/ * /index.html の
 *  <meta name="description"> をそのまま使って計測。609 件すべてが持っている）。
 *
 *   title + link のみ ............  63,753 B（gzip 19,197 B）
 *   + date ......................  75,913 B（gzip 21,400 B）
 *   + description ............... 243,712 B（gzip 76,687 B）
 *
 * description まで載せると gzip 後で 4.0 倍（19,197 → 76,687 B）になる。
 * その description は remark-archive-description が «本文の書き出し» から
 * 機械的に作ったもので、記事の要約ではない。検索語が当たることはあるが、
 * 4 倍の転送量に見合うほど確実に効くものではないと判断して外した。
 * まず title だけで入れて、足りないと分かってから足せばよい。
 * date も «検索対象にならないのに 2,203 B 増える» ので入れていない。
 *
 * Notion 記事 23 件の description（Excerpt）は従来どおり持たせる。
 * ただし «従来どおり» の中身は空で、実測すると 23 件すべて Excerpt が
 * 空文字だった。RSS の側も <item> の中に <description> を 1 つも
 * 出していない（変更前の dist/feed を確認。item 23 件 / description 0 件）。
 * つまり検索結果の説明文の行は元から空で、説明文に対する部分一致も
 * 効いていなかった。それでも項目を残しているのは、Notion 側で Excerpt を
 * 埋めればそのまま効くようにしておくためで、今の見た目は変わらない
 */

// import.meta.glob はパスをキーにしたオブジェクトを返すため Object.values で配列化する。
// archive/index.astro と同じ md 群を同じやり方で読んでいる
const archiveModules = Object.values(
  import.meta.glob<MarkdownInstance<ArchiveIndexFrontmatter>>(
    './archive/*.md',
    { eager: true }
  )
)

export async function GET() {
  const posts = await getAllPosts()

  // Notion 記事を先に置く。空欄で開いたときに出るのは先頭から数件なので、
  // 順番はそのまま «既定で何が見えるか» になる。
  // ここを入れ替えると 2015 年のアーカイブが最初に出ることになり、
  // 既存の検索の見え方が変わってしまう
  const notionItems: SearchIndexItem[] = posts.map((post) => ({
    title: post.Title,
    link: getPostLink(post.Slug),
    description: post.Excerpt,
  }))

  if (archiveModules.length === 0) {
    // archive/index.astro と同じ安全網。import.meta.glob は 0 件マッチでも
    // 例外を出さず空オブジェクトを返すので、黙って «アーカイブ 0 件の
    // インデックス» が出来上がってしまう。それは今回直した不具合そのもの
    throw new Error(
      "src/pages/archive に './archive/*.md' がひとつもマッチしませんでした。アーカイブ記事の配置を確認してください。"
    )
  }

  const archiveItems: SearchIndexItem[] = archiveModules
    .filter((post) => !post.frontmatter.draft)
    // 新しい順。アーカイブ内での並びだけの話で、Notion 記事より前には出ない
    .sort(
      (a, b) =>
        new Date(b.frontmatter.date).getTime() -
        new Date(a.frontmatter.date).getTime()
    )
    .map((post) => ({
      title: post.frontmatter.title,
      // post.url は BASE_PATH 込みで渡ってくるので、stripBasePath() で
      // 剥がしてから getNavLink() に渡す（二重付与を避ける）。
      // archive/index.astro のリンク生成と同じ手順
      link: getNavLink(stripBasePath(post.url ?? '')),
    }))

  return new Response(JSON.stringify([...notionItems, ...archiveItems]), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
    },
  })
}
