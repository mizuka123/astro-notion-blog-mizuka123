import fs from 'node:fs'
import path from 'node:path'
import { parseFrontmatter } from '@astrojs/markdown-remark'

/**
 * アーカイブ記事（src/pages/archive/*.md）の frontmatter と URL の一覧。
 *
 * 一覧を作るページ（/archive/ と、src/lib/archive-taxonomy.ts を通す
 * /category/<slug>/ /tag/<slug>/ /tag/）は、以前は md を
 * import.meta.glob の eager で «モジュールとして» 読んでいた。md の
 * モジュールは frontmatter の layout（src/layouts/LayoutMd.astro）を
 * import しているので、それを読んだページには LayoutMd.astro の
 * <style is:global> まで一緒に配信されていた（Issue #123。実測で
 * アーカイブ記事 609 枚のほかに 300 枚）。
 *
 * 漏れた規則のうち、実際に見た目を変えていたのは 2 つだけだった。
 * .content a { text-decoration: underline } による一覧のリンクの下線と、
 * h2 { margin: 0 }（と 640px 以下の font-size: 1.15rem）による /archive/ 自身の
 * 見出し 2 つの余白。どちらも公開中の見た目なので、#123 で漏れを止めたときに
 * src/styles/archive-taxonomy.module.css と src/pages/archive/index.astro に
 * クラスや scoped の規則として書き直して保っている。
 * Issue では «サイドバーの見出し（最新記事など）の余白も変わっている» と
 * 疑ったが、BlogPostsLink / BlogTagsLink のスコープ付きの規則
 * （.blog-posts-link[data-astro-cid-*] h2[data-astro-cid-*] など。詳細度 0,3,1）が
 * 漏れた h2（0,0,1）に常に勝っていて、値は漏れの有無で変わっていなかった。
 *
 * ここでは md を fs で «ただの文字列» として読み、frontmatter だけを
 * 解析する。md をモジュールとして import しないので、LayoutMd.astro は
 * これを使うページのモジュールグラフに入らない。
 *
 * import.meta.glob の { query: '?raw' } は «使えない»。Astro の md の
 * プラグイン（astro:markdown）はクエリを外してから .md かどうかを
 * 判定するので、?raw を付けても md は通常どおりコンパイルされ、
 * 文字列ではなくモジュールが返ってくる。LayoutMd.astro の CSS も漏れた
 * ままで、frontmatter は空になり、それでもビルドは成功した（実際に
 * 試して、カテゴリーページが 1 枚も出ず /archive/ のリンク名が空になった）。
 * 下の title の検査は、この種の «黙って空になる» 読み方を止めるためのもの。
 *
 * 解析は Astro が md を読むときと同じ関数（@astrojs/markdown-remark の
 * parseFrontmatter。中身は js-yaml の load）を使う。自前の正規表現や
 * 別の YAML パーサーにすると、クォートの有無や日付の扱いで Astro と
 * 食い違いうる。package.json では astro が固定している版と同じ版に
 * 固定してあり、astro を上げるときはこちらも合わせること
 * （合わせないと node_modules に 2 つの版が入り、解析結果が揃う保証が消える）。
 *
 * Astro と違うのは remark プラグインを通さないこと。
 * remark-archive-description などが frontmatter に足す項目
 * （description / bodyImages）はここには無い。それが要るところ
 * （src/pages/search-index.json.ts と src/lib/archive-shared-images.ts）は
 * 引き続き md をモジュールとして読んでいる。前者は JSON で CSS が
 * 付かず、後者は LayoutMd.astro 自身からしか呼ばれないので漏れは起きない。
 * 一覧を作るページでモジュールとして読み直すと、この漏れがそのまま戻る
 */

// frontmatter のうち、一覧を作るのに使う項目だけを宣言する。
// 実ファイルには layout / coverImage もあるが、一覧には要らない。
// title / date は全 609 件が持つ（src/layouts/LayoutMd.astro の注記と同じ）。
// date は全件クォート付きの 'YYYY-MM-DD' で、YAML の日付ではなく文字列になる。
// categories は全 609 件にあり、tags は 435 件にしか無いので省略可能にする
export interface ArchiveFrontmatter {
  title: string
  date: string
  draft?: boolean
  categories?: string[]
  tags?: string[]
}

export interface ArchiveEntry {
  frontmatter: ArchiveFrontmatter
  // MarkdownInstance の url と同じ値（BASE_PATH を «含む»。例: '/archive/6474'）
  url: string
}

// import.meta.url を起点にしないのは、ビルド時はこのモジュールが dist の
// 下のチャンクに束ねられて場所が変わるため（src/lib/katex-css.ts と同じ）。
// astro build / dev はリポジトリの直下で動く
const ARCHIVE_DIR = path.join(process.cwd(), 'src', 'pages', 'archive')

// Astro が md の url を作る式（astro/dist/vite-plugin-utils の getFileInfo）を
// そのまま写す。base に site を当てて得たパス名に、src/pages/ から先の
// ファイルパスを拡張子なしで続ける。trailingSlash と build.format は
// このサイトでは既定値（'ignore' / 'directory'）なので、末尾の / も
// .html も付かない
const sitePathname = (
  import.meta.env.SITE
    ? new URL(import.meta.env.BASE_URL, import.meta.env.SITE).pathname
    : import.meta.env.BASE_URL
).replace(/\/?$/, '/')

/**
 * 全アーカイブ記事（draft も含む。除外と並べ替えは使う側が決める）。
 * 並びはファイル名の符号位置順で、import.meta.glob（ファイルパスを
 * sort() してから返す）でモジュールとして読んでいたときと同じ。
 * /archive/ の同日の記事の並びはこの順に依存している
 */
export const archiveEntries: readonly ArchiveEntry[] = fs
  .readdirSync(ARCHIVE_DIR)
  .filter((name) => name.endsWith('.md'))
  .sort()
  .map((name) => {
    const source = fs.readFileSync(path.join(ARCHIVE_DIR, name), 'utf-8')
    // Astro は frontmatter を JSON.stringify してモジュールに埋め込む。
    // YAML の日付（クォートなしの 2011-09-15）は js-yaml では Date になるが、
    // モジュール経由だと ISO 8601 の文字列になっていた。JSON を 1 往復させて
    // 型まで同じにしておく（今の 609 件はすべてクォート付きの文字列なので、
    // 実際にはどちらでも変わらない）
    const frontmatter = JSON.parse(
      JSON.stringify(parseFrontmatter(source).frontmatter)
    ) as ArchiveFrontmatter
    if (typeof frontmatter.title !== 'string') {
      throw new Error(
        `src/lib/archive-frontmatter.ts: src/pages/archive/${name} の frontmatter から title を読めませんでした。`
      )
    }
    return {
      frontmatter,
      url: `${sitePathname}archive/${name}`.replace(/(?:\/index)?\.md$/, ''),
    }
  })

// ディレクトリの場所を書き間違えると readdirSync が例外を投げるが、
// 中身が空になった場合は黙って «アーカイブ一覧もカテゴリーページも空の
// ビルド» が成功してしまうので、ここで止める
if (archiveEntries.length === 0) {
  throw new Error(
    'src/lib/archive-frontmatter.ts: src/pages/archive に .md がひとつもありませんでした。アーカイブ記事の配置を確認してください。'
  )
}
