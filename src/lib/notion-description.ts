import type { Block, RichText } from './interfaces'
import { buildDescription } from './description'

/**
 * Notion 記事の本文から meta description を作る。
 *
 * データベースの Excerpt プロパティが空のときだけ使う。
 * 実測では 20 件中 19 件が空で、そのままだとサイト共通の説明
 * （「ガジェットやカメラ、ちょっとだけ技術の話題が中心のブログ」）が
 * 出ていた。アーカイブ 609 記事には同じ扱いを入れてあるので、
 * Notion 記事だけ取り残す理由が無い。
 *
 * 追加の API 呼び出しは発生しない。[slug].astro は記事を描画するために
 * getAllBlocksByBlockId() を «既に» 呼んでおり、その配列を走査するだけ。
 *
 * Excerpt を書けばそちらが優先されるので、手で書いた説明文が
 * これに上書きされることはない。
 */

const textOf = (richTexts: RichText[]): string =>
  richTexts.map((richText) => richText.PlainText).join('')

/**
 * 生 HTML だけの段落か。
 *
 * Notion には HTML を貼り付けた段落が混ざる（実例:
 * <div data-vc_mylinkbox_id="..."></div>）。説明文に入れる意味が無い。
 * 「仮名を含まない」判定で偶然弾かれていたが、それに頼らず明示的に外す
 */
const isRawHtml = (text: string): boolean => /^\s*<[a-z!/]/i.test(text.trim())

/**
 * 本文として扱うブロックのテキストを文書順に並べて返す。
 *
 * 段落だけでなくリスト項目と引用も拾う。段落しか見ないと、
 * 「その中で感じたこととしては」→ 箇条書き 4 項目 →「ということでした。」
 * という本文から箇条書きが丸ごと落ち、
 * 「その中で感じたこととしては ということでした。」という
 * 日本語として破綻した説明文が出る（parenting-the-9-week で実際に起きた）。
 */
const paragraphTexts = (blocks: Block[]): string[] =>
  blocks.flatMap((block) => {
    const richTexts =
      block.Paragraph?.RichTexts ??
      block.BulletedListItem?.RichTexts ??
      block.NumberedListItem?.RichTexts ??
      block.Quote?.RichTexts
    if (!richTexts) return []
    const text = textOf(richTexts)
    return isRawHtml(text) ? [] : [text]
  })

export const descriptionFromBlocks = (blocks: Block[]): string =>
  buildDescription(paragraphTexts(blocks))
