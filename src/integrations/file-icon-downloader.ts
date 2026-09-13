import type { AstroIntegration } from 'astro'
import { getAllPosts, downloadFiles } from '../lib/notion/client'

/**
 * 記事のアイコンのうち file タイプのものをビルド時にローカルへ落とす。
 *
 * file（Notion にアップロードされたファイル）の Url は署名付きで失効するため、
 * そのまま静的 HTML に焼くとしばらくして画像が壊れる。
 * データベースのアイコンは custom-icon-downloader、アイキャッチは
 * featured-image-downloader が同じことをしていて、記事アイコンだけが
 * 抜けていた。
 *
 * Mention のアイコンはメンション先が必ずブログ DB 内の記事（getPostByPageId は
 * getAllPosts から探すだけ）なので、ここでカバーされる。
 * callout のアイコンはブロックを辿らないと分からないので、レンダリングに使う
 * blocks をそのまま流用できる posts/[slug].astro 側で落としている。
 * ここで別途ブロックを取り直すと、取得タイミングがずれて
 * 「ダウンロードしていない URL をレンダリングする」隙ができるため。
 */
export default (): AstroIntegration => ({
  name: 'file-icon-downloader',
  hooks: {
    'astro:build:start': async () => {
      const posts = await getAllPosts()

      const urls = posts
        .map((post) => (post.Icon?.Type === 'file' ? post.Icon.Url : undefined))
        .filter((url): url is string => !!url)

      // Notion 側に file タイプのアイコンが実在するかは、認証情報のある
      // ビルド環境のログでしか確認できない。0 件でも必ず出す。
      // 走査した母数も出すのは、0 件が「アイコンが無い」のか
      // 「そもそも走査できていない」のかを区別できないと意味が無いため
      console.log(
        `[file-icon-downloader] 記事 ${posts.length} 件を走査。` +
          `file タイプのアイコン: ${urls.length} 件`
      )

      if (urls.length === 0) {
        return
      }

      await downloadFiles('file-icon-downloader', urls)
    },
  },
})
