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

/** 段落ブロックのテキストを文書順に並べて返す。 */
const paragraphTexts = (blocks: Block[]): string[] =>
  blocks.flatMap((block) =>
    block.Type === 'paragraph' && block.Paragraph
      ? [textOf(block.Paragraph.RichTexts)]
      : []
  )

export const descriptionFromBlocks = (blocks: Block[]): string =>
  buildDescription(paragraphTexts(blocks))
