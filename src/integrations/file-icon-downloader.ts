import type { AstroIntegration } from 'astro'
import {
  getAllPosts,
  getAllBlocksByBlockId,
  downloadFiles,
} from '../lib/notion/client'
import { extractTargetBlocks } from '../lib/blog-helpers'
import type { Emoji, FileObject, Unsupported } from '../lib/interfaces'

/**
 * file タイプのアイコンだけ Url を返す。
 *
 * external は外部ホストの URL なのでダウンロード不要。file は署名付き URL で
 * 失効するため、ここで集めてビルド時にローカルへ落とす必要がある。
 */
const fileIconURL = (
  icon: FileObject | Emoji | Unsupported | null | undefined
): string | undefined => {
  if (!icon || icon.Type !== 'file') {
    return undefined
  }
  return icon.Url
}

/**
 * 記事のアイコンと callout ブロックのアイコンのうち、file タイプのものを
 * ビルド時にローカルへダウンロードする。
 *
 * データベースのアイコンは custom-icon-downloader、記事のアイキャッチは
 * featured-image-downloader が担当していて、この 2 つが拾えていなかった分を
 * 補う。Mention のアイコンはメンション先が必ずブログ DB 内の記事なので、
 * 記事アイコンのダウンロードでカバーされる。
 */
export default (): AstroIntegration => ({
  name: 'file-icon-downloader',
  hooks: {
    'astro:build:start': async () => {
      const posts = await getAllPosts()

      const postIconURLs = posts
        .map((post) => fileIconURL(post.Icon))
        .filter((url): url is string => !!url)

      const calloutIconURLs: string[] = []
      let calloutCount = 0
      for (const post of posts) {
        const blocks = await getAllBlocksByBlockId(post.PageId)
        // extractTargetBlocks は Children を持つブロック（段落・見出し・
        // リスト・トグル・引用・callout・同期ブロック・カラム）を再帰的に
        // 辿るので、ネストした callout も漏れなく拾える
        const callouts = extractTargetBlocks('callout', blocks)
        calloutCount += callouts.length
        callouts.forEach((block) => {
          const url = fileIconURL(block.Callout?.Icon)
          if (url) {
            calloutIconURLs.push(url)
          }
        })
      }

      // Notion 側に file タイプのアイコンが実在するかどうかは、認証情報のある
      // ビルド環境のログでしか確認できない。0 件でも必ず出して、
      // 「対応したのに何も起きていない」のか「そもそも存在しない」のかを
      // 切り分けられるようにする。
      // 走査した母数も出すのは、0 件が「アイコンが無い」のか
      // 「そもそも走査できていない」のかを区別できないと意味が無いため
      console.log(
        `[file-icon-downloader] 走査: 記事 ${posts.length} 件 / callout ${calloutCount} 件。` +
          `うち file タイプのアイコン: 記事 ${postIconURLs.length} 件 / callout ${calloutIconURLs.length} 件`
      )

      const urls = [...postIconURLs, ...calloutIconURLs]
      if (urls.length === 0) {
        return
      }

      await downloadFiles('file-icon-downloader', urls)
    },
  },
})
