import type { Root, RootContent } from 'mdast'
import type { VFile } from 'vfile'
import { archiveImageName } from './archive-image-file'

/**
 * アーカイブ記事の本文にあるローカル画像の URL を、出現順に
 * frontmatter.bodyImages として渡す remark プラグイン。
 *
 * LayoutMd.astro はこれを archive-og-image.ts に渡し、coverImage が
 * 小さい・空の記事でも本文の画像から og:image と JSON-LD の image を選ぶ。
 * frontmatter の coverImage だけで選んでいたときは、609 記事のうち
 * 377 件（空 94 件＋幅 600px 未満 283 件）が共通画像に落ちていた（#103）。
 *
 * remark-archive-description.ts に足さず別のプラグインにしたのは、
 * 向こうは «説明文が作れなければ何もせず抜ける» 作りで、画像の収集を
 * 同居させると早期 return の条件が 2 つの関心で絡むため。走査も
 * 向こうはトップレベルの段落・リスト・引用だけを見るのに対し、
 * こちらはリンクの中の画像や表の中の生 HTML まで全ノードを見る必要があり、
 * 共有できる部分が無い。
 *
 * 渡すのは «URL の文字列» まで。寸法を読むのはレイアウト側
 * （archive-og-image.ts）に任せる。remark プラグインは記事ごとに
 * 呼ばれ、ここで寸法を読むと画像を選ぶ規則が 2 か所に分かれるため。
 */

// 生 HTML の <img> から src を取り出す。アーカイブ記事は WordPress からの
// 移行で生 HTML が混ざっており、mdast では html ノードの «文字列» のまま
// なので、構文木からは取れない。
// 属性値の引用符は "..." / '...' / 無し のいずれも受ける。
// 実測では html ノードの中の <img> は 609 記事で 19 個あり、
// /archive/images/ を指すものは 0 個（外部の計測画像が 6 個、相対パスの
// images/... が 13 個で、うち 12 個は Amazon の 160px サムネイル）。
// 相対パスは記事の URL（/archive/<slug>/）から解決すると
// /archive/images/ を指さないので対象にしない。
// 今は 0 個でも、記事が増えたときに取りこぼさないよう拾っておく
const IMG_SRC =
  /<img\b[^>]*?\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi

// 生 HTML の属性値に入り得る文字参照のうち、ファイル名に現れうるもの。
// &amp; 以外は現状の記事に出てこないが、&#39; などを残したままだと
// ファイルが見つからず黙って候補から外れる
const decodeEntities = (value: string): string =>
  value
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')

const collect = (node: Root | RootContent, urls: string[]): void => {
  if (node.type === 'image') {
    urls.push(node.url)
  } else if (node.type === 'html') {
    for (const match of node.value.matchAll(IMG_SRC)) {
      urls.push(decodeEntities(match[1] ?? match[2] ?? match[3] ?? ''))
    }
  }
  if ('children' in node) {
    for (const child of node.children) collect(child, urls)
  }
}

export default function remarkArchiveImages() {
  return (tree: Root, file: VFile): void => {
    const urls: string[] = []
    collect(tree, urls)

    // /archive/images/ の下を指すものだけを残す。外部 URL（アフィリエイトの
    // 計測画像を含む）はここで落とすので、後段で取得されることは無い。
    // 同じ画像が 2 回出てくる記事もあるので、最初の出現だけを残す
    const seen = new Set<string>()
    const images = urls.filter((url) => {
      if (archiveImageName(url) === null || seen.has(url)) return false
      seen.add(url)
      return true
    })

    const data = file.data as {
      astro?: { frontmatter?: Record<string, unknown> }
    }
    // Astro が必ず {} を入れるので実行時には通らないが、
    // 続く行で frontmatter を触るための型の絞り込みとして要る
    if (!data.astro?.frontmatter) return

    data.astro.frontmatter.bodyImages = images
  }
}
