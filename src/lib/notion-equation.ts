import type { Block } from './interfaces'

/**
 * Notion 記事の本文に、KaTeX で描画する数式が 1 つでもあるか。
 *
 * KaTeX の CSS（cdn.jsdelivr.net の katex.min.css）は以前は全ページの
 * <head> に出していた。実測（2026-09-24）では dist の HTML 942 件すべてが
 * 読み込み、KaTeX を描画している（class="katex" を含む）HTML は 0 件。
 * PageSpeed Insights（archive/7668、モバイル）ではこの CSS が
 * «レンダリングをブロックしているリクエスト» として 750 ms を占めていた。
 * 数式のある記事でだけ読み込むために、この判定を [slug].astro で呼ぶ。
 *
 * KaTeX を描画するのは 2 か所だけで、どちらも «Equation というキー» を見て
 * いる（client.ts の _buildBlock と _buildRichText が作る）:
 *   - 数式ブロック: Block.Equation（Equation.astro）
 *   - インライン数式: RichText.Equation（RichText.astro）
 *
 * ブロックの種類ごとに «どのフィールドに RichText と子ブロックがあるか» を
 * 列挙せず、オブジェクトを丸ごと辿って Equation キーを探している。
 * インライン数式は段落・見出し・リスト・to-do・引用・コールアウト・トグルの
 * 本文、画像／動画／ファイル／コード／ブックマークのキャプション、表のセル
 * （Table.Rows[].Cells[].RichTexts）のどこにでも入り、さらにそれらが
 * 子ブロック（各 Children、ColumnList.Columns[].Children、
 * SyncedBlock.Children）の中に入れ子になる。列挙すると、client.ts に
 * 取得経路が増えたときにこちらの直し忘れで «数式があるのに CSS が無い»
 * 記事ができ、しかもビルドも lint も通るので気づけない（blog-helpers.ts の
 * extractTargetBlocks はまさにこの列挙で、表のセルとキャプションは辿らない）。
 * 丸ごと辿る方法なら、どの経路でも Block に載ってさえいれば拾える。
 *
 * 丸ごと辿ることで拾いすぎる心配は、Equation というキーを作るのが上の
 * 2 か所だけなので無い。仮に拾いすぎても «CSS を余計に読み込む» だけで
 * 表示は壊れないが、拾い漏れると数式が崩れて表示される。
 *
 * 追加の API 呼び出しは発生しない。[slug].astro が描画用に «既に» 取得した
 * blocks を走査するだけ（notion-description.ts と同じ）。
 */
export const hasEquation = (blocks: Block[]): boolean =>
  containsEquation(blocks)

const containsEquation = (value: unknown): boolean => {
  if (Array.isArray(value)) {
    return value.some(containsEquation)
  }
  if (value === null || typeof value !== 'object') {
    return false
  }
  const record = value as Record<string, unknown>
  if (record.Equation) {
    return true
  }
  return Object.values(record).some(containsEquation)
}
