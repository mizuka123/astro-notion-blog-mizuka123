import { archiveEntries } from './archive-frontmatter'
import { stripBasePath } from './blog-helpers'

/**
 * 旧 WordPress の /category/<slug>/ と /tag/<slug>/ に実ページを作るための、
 * アーカイブ記事の分類情報。
 *
 * 旧サイトの被リンクと検索結果はこの 2 つの URL を指したままで、現在は
 * 404 を返している。転送ではなく実ページを置く判断をしたので、
 * 「どの記事がどの分類に属するか」を 1 か所で決める必要がある。
 *
 * ここで分類を組み立てるのは、/category/[category] と /tag/[tag] の 2 ページが
 * それぞれ 609 件を読み直すと、同じ除外条件（draft）と同じ並び順（日付の
 * 新しい順）を 2 か所で書くことになるため。片方だけ直したときに
 * 「カテゴリー一覧とタグ一覧で同じ記事の並びが違う」状態になる。
 *
 * 記事の frontmatter は src/lib/archive-frontmatter.ts から受け取る。
 * ここで md を import.meta.glob の eager で読むと、このファイルを import する
 * 300 ページに LayoutMd.astro の global CSS が漏れる（#123。理由は
 * archive-frontmatter.ts の冒頭を参照）
 */

// 一覧に出すのに必要な最小限。記事本文や coverImage まで持ち回ると、
// 298 ページ分の getStaticPaths の戻り値が丸ごと重くなる
export interface ArchivePostRef {
  title: string
  date: string
  // BASE_PATH を «含まない» 生パス（例: '/archive/6474'）。
  // リンクを出す側が getNavLink() を通して BASE_PATH を足す。
  // ここで足してしまうと、getNavLink を通した時点で二重に付く
  url: string
}

/**
 * このタクソノミーを検索エンジンに載せるかどうかの境目（記事数）。
 *
 * «3 は Google が公表している基準ではない»。このサイトのタグ 271 種の
 * 分布（1 本だけ = 130 種、2 本 = 51 種、3 本以上 = 90 種）を数えて、
 * 「ほとんど中身の無いページ」と「一覧として読めるページ」が分かれる
 * ところに引いた線でしかない。外部に根拠があるわけではないので、
 * 分布が変われば引き直してよい。
 *
 * 3 本未満の 181 種は「アーカイブ記事 1〜2 件へのリンクがあるだけの
 * ページ」になる。その記事自身のページと中身がほぼ変わらず、
 * 検索エンジンから見れば薄いページを 181 枚増やすことになる。
 * それでも 200 で返すのは旧 URL の被リンクを 404 にしないためなので、
 * 「配信はするがインデックスはさせない」に倒す。
 *
 * カテゴリー 27 種でこの境目を下回るのは pc-web（1 本）だけ。
 *
 * export していないのは、この値を «直接» 見てよいのが下の
 * selectIndexableKeys だけだから。ページ側は archiveCategories /
 * archiveTags の indexable を受け取る。閾値の比較をページに書き戻すと、
 * 判断がもう 1 種類ある（記事集合の重複）ことを取りこぼす。
 * astro.config.mjs の sitemap 除外も同じ判断だが、あちらは閾値ではなく
 * «出来上がった HTML に noindex が入っているか» を見ていて、
 * 条件を二重に持たないようにしてある
 */
const INDEX_MIN_POSTS = 3

/**
 * カテゴリーのスラッグ → 画面に出す表示名。
 *
 * スラッグは旧 WordPress が発行した URL の一部で、これを変えると
 * 移行元の被リンクが切れるので変更できない。つまり日本語の表示名は
 * データから導けず、手で維持するしかない。カテゴリーは 27 種で
 * 打ち止め（アーカイブ記事は増えない）なので、全 27 行を書き切っている。
 *
 * 水樹奈々・茅原実里・田村ゆかり・伊藤かな恵・東山奈央の 5 つは
 * スラッグ自体が日本語なので、そのまま表示名になる。行を省かず
 * 書いているのは、この表を見れば 27 種すべてが揃っていると
 * 確認できるようにするため。
 *
 * タグ 271 種には同じ表を作らない。手で維持する行が 271 行に増える割に、
 * 181 種は記事 2 本以下の noindex ページで人目に触れない
 */
const CATEGORY_DISPLAY_NAMES: Record<string, string> = {
  'camera-lens': 'カメラ・レンズ',
  photographs: '写真',
  gadget: 'ガジェット',
  'voice-actor': '声優',
  anime: 'アニメ',
  android: 'Android',
  'photographic-equipment': 'カメラ周辺機器',
  水樹奈々: '水樹奈々',
  pc: 'PC',
  茅原実里: '茅原実里',
  'consumer-electronics': '家電',
  田村ゆかり: '田村ゆかり',
  blog: 'ブログ',
  ipad: 'iPad',
  audio: 'オーディオ',
  iphone: 'iPhone',
  mobilerouter: 'モバイルルーター',
  game: 'ゲーム',
  'mobile-line': 'モバイル回線',
  note: '雑記',
  伊藤かな恵: '伊藤かな恵',
  accessory: 'アクセサリー',
  column: 'コラム',
  smartwatch: 'スマートウォッチ',
  kindle: 'Kindle',
  東山奈央: '東山奈央',
  'pc-web': 'PC・Web',
}

/**
 * 表に無いスラッグはそのまま表示する。
 *
 * 表と実データがずれたときに «ビルドを落とす» のではなく «スラッグを出す»
 * のは、表示名の欠落だけで旧 URL のページごと出なくなると、
 * 404 を潰すという本来の目的まで巻き添えになるため
 */
export const getCategoryDisplayName = (slug: string): string =>
  CATEGORY_DISPLAY_NAMES[slug] ?? slug

/**
 * スラッグの並び順。
 *
 * localeCompare を使わないのは、引数を省いたときのロケールが実行環境で
 * 変わるため。実測でこの Windows 機は ja-JP、Cloudflare Pages の Linux は
 * 通常 en-US に解決される。並びが環境で変わると «どのページを index に
 * 残すか»（selectIndexableKeys）まで環境依存になり、ビルド成果物の
 * 突き合わせでも «変えていないのに差分が出る» ことになる。
 * 符号位置順なら実行環境に依らない
 */
export const compareSlugs = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0

interface ClassifiedPost extends ArchivePostRef {
  categories: string[]
  tags: string[]
}

// 並び替えは 1 回で済ませる。分類ごとに sort し直しても結果は同じだが、
// 「カテゴリー側だけ並び順を変える」改変が入り込む余地を残さない。
// date は全件 'YYYY-MM-DD' なので辞書順と日付順が一致するが、
// Notion 側の日付が ISO 8601 で来る例に合わせて Date で比較する。
// 同日の記事は url で決めて、ビルドのたびに並びが入れ替わらないようにする
// （並びが揺れると差分比較で «変わっていないのに差分が出る»）。
// localeCompare ではなく compareSlugs を使う理由は上の定義を参照
// 0 件のときは archive-frontmatter.ts が例外でビルドを止めるので、
// ここで «カテゴリーページが 1 枚も出ないビルド» が成功することは無い
const classifiedPosts: ClassifiedPost[] = archiveEntries
  .filter((post) => !post.frontmatter.draft)
  .map((post) => ({
    title: post.frontmatter.title,
    date: post.frontmatter.date,
    url: stripBasePath(post.url),
    categories: post.frontmatter.categories ?? [],
    tags: post.frontmatter.tags ?? [],
  }))
  .sort((a, b) => {
    const diff = new Date(b.date).getTime() - new Date(a.date).getTime()
    return diff !== 0 ? diff : compareSlugs(a.url, b.url)
  })

const groupBy = (
  key: 'categories' | 'tags'
): ReadonlyMap<string, ArchivePostRef[]> => {
  const groups = new Map<string, ArchivePostRef[]>()
  for (const post of classifiedPosts) {
    for (const name of post[key]) {
      const posts = groups.get(name)
      if (posts) {
        posts.push(post)
      } else {
        groups.set(name, [post])
      }
    }
  }
  return groups
}

const categoryPosts = groupBy('categories')
const tagPosts = groupBy('tags')

/**
 * 1 つのタクソノミーページ分のデータ。
 *
 * indexable をここに持たせているのは、「検索エンジンに載せるかどうか」の
 * 判断がもう 1 種類増えた（下の selectIndexableKeys 参照）ため。
 * 以前はページ側が posts.length < INDEX_MIN_POSTS を書いていたが、
 * 判断が 2 種類になった時点で «片方のページにだけ新しい条件を足し忘れる»
 * 事故が起きる形になる。条件はすべてこのファイルに閉じ込め、ページは
 * 出てきた真偽値をそのまま noindex / noAffiliate に渡すだけにする
 */
export interface ArchiveTaxonomy {
  /** この分類に属する記事（日付の新しい順） */
  posts: ArchivePostRef[]
  /** 検索エンジンに載せる（＝ noindex を出さず sitemap に載せる）かどうか */
  indexable: boolean
  /**
   * 記事が INDEX_MIN_POSTS 件未満で «中身が無いに等しい» かどうか。
   *
   * ページ側はこれを noAffiliate（アフィリエイトのスクリプトを出さない）に
   * 渡す。#112 では広告（noAds）をこれで止めていたが、#113 でタクソノミーの
   * ページは全件で広告を止めることにしたので、広告の判断には使わなくなった。
   * アフィリエイトは、noAds が広告とアフィリエイトを両方止めていた頃の状態を
   * 保つために、引き続きこれで止めている。
   *
   * indexable と分けてあるのは、両者が食い違うページが実測で 4 枚あるため。
   * 記事集合が他と完全に同じで index から外した 4 枚（記事 4 / 5 / 3 / 3 件）は
   * 薄くはない。indexable で判断すると «一字一句同じ相方はアフィリエイトを
   * 出しているのに、こちらは出さない» という説明の付かない状態になる
   */
  thin: boolean
}

/**
 * index 対象にするタクソノミーの識別子（'category/gadget' の形）を選ぶ。
 *
 * 条件は 2 つ。
 *
 * 1. 記事が INDEX_MIN_POSTS 件以上あること。
 *
 * 2. «記事集合がまったく同じ» タクソノミーが他にもあるとき、その中の
 *    1 つだけを残すこと。実測で 4 組ある（記事数は順に 4 / 5 / 3 / 3 件）:
 *      category/kindle ≡ tag/kindle-paperwhite
 *      tag/pentax      ≡ tag/pentax-k-3
 *      tag/epson       ≡ tag/moverio-bt-200av
 *      tag/irobot      ≡ tag/ルンバ980
 *    どちらを開いても «一字一句同じ記事リンクが並ぶページ» で、Google から
 *    見れば重複コンテンツそのもの。INDEX_MIN_POSTS は件数しか見ないので
 *    この 4 組は素通りしてしまう。
 *
 * 残す 1 つは「カテゴリー → タグ、同種ならスラッグ昇順」で決める。この順は
 * ビルドのたびに同じ結果を出すためのもので、意味づけは後付けだが、
 * 実測の 4 組では «より一般的な名前» が残る（kindle / pentax / epson /
 * irobot が残り、kindle-paperwhite / pentax-k-3 / moverio-bt-200av /
 * ルンバ980 が落ちる）。製品名より分類名のほうがカテゴリーに置かれやすく、
 * 同系統のタグではスラッグが短い＝上位概念のほうが辞書順で先に来るため、
 * 偶然ではなくこの規則から出てくる望ましい側。
 * 逆の結果になったら、規則ではなくこのコメントを疑うこと
 */
const selectIndexableKeys = (): ReadonlySet<string> => {
  const candidates = [
    ...[...categoryPosts.keys()].sort(compareSlugs).map((name) => ({
      key: `category/${name}`,
      posts: categoryPosts.get(name)!,
    })),
    ...[...tagPosts.keys()]
      .sort(compareSlugs)
      .map((name) => ({ key: `tag/${name}`, posts: tagPosts.get(name)! })),
  ].filter(({ posts }) => posts.length >= INDEX_MIN_POSTS)

  const seenSignatures = new Set<string>()
  const indexable = new Set<string>()
  for (const { key, posts } of candidates) {
    // 比べたいのは «同じ記事の集合か» であって並び順ではない。
    // classifiedPosts を 1 回だけ並べ替えてから配っている以上、今は
    // 並べ直さなくても順序は一致するが、それは配る側の実装に依存した
    // 偶然でしかない。将来どこかで並べ方を変えたとき、ここは黙って
    // 重複を «取りこぼす» 側に倒れるので、比較の前に並びを揃えておく
    const signature = JSON.stringify([...posts.map((post) => post.url)].sort())
    if (seenSignatures.has(signature)) {
      continue
    }
    seenSignatures.add(signature)
    indexable.add(key)
  }
  return indexable
}

const indexableKeys = selectIndexableKeys()

const toTaxonomyMap = (
  kind: 'category' | 'tag',
  groups: ReadonlyMap<string, ArchivePostRef[]>
): ReadonlyMap<string, ArchiveTaxonomy> =>
  new Map(
    [...groups].map(([name, posts]) => [
      name,
      {
        posts,
        indexable: indexableKeys.has(`${kind}/${name}`),
        thin: posts.length < INDEX_MIN_POSTS,
      },
    ])
  )

/**
 * カテゴリー名 → そのページのデータ。実測 27 種・のべ 746 件。
 *
 * モジュール読み込み時に 1 回だけ組み立てる。getStaticPaths と各ページの
 * 本体から合わせて 300 回近く参照されるため、呼ぶたびに 609 件を
 * 走査し直すのは無駄
 */
export const archiveCategories = toTaxonomyMap('category', categoryPosts)

/** タグ名 → そのページのデータ。実測 271 種 */
export const archiveTags = toTaxonomyMap('tag', tagPosts)
