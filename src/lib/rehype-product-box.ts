import type { Element, ElementContent, Root, RootContent } from 'hast'

/**
 * WordPress 由来のアーカイブ記事にあるカエレバの商品ボックスを、
 * 1 つの <div class="product-box"> にまとめる rehype プラグイン。
 *
 * カエレバの出力は移行時にばらけて、画像リンク・商品名・
 * 「posted with カエレバ」・ブランド名・各ショップへのリンクが
 * すべて独立した <p> になっている。自動広告は本文コンテナ直下の
 * 兄弟要素の「間」に広告を挿し込むため、この状態だと商品名と
 * 購入ボタンの間に広告が入る。実測で 4 例あり、うち 1 例は
 * 商品ボックスの枠線の内側に広告が描画されていた。
 *
 * 記事側（609 ファイル）は書き換えず、ビルド時に包む。
 * テキストの中身は変えず、入れ子だけを変える。
 */

// ショップのリンクとして扱う表記。リンクテキストがこれで始まるものを
// ボックスの一部とみなす
const SHOP_PREFIXES = [
  'Amazon',
  '楽天市場',
  'Yahooショッピング',
  'ヤフオク!',
  '7net',
  'セブンネット',
  '価格.com',
  'ソニーストア',
]

// 「posted with カエレバ」より前に並ぶ画像リンク・商品名リンクの数。
// 実測では最大 3 だった（502 件が 2、59 件が 1）
const MAX_LEADING = 3

const isElement = (node: RootContent | ElementContent): node is Element =>
  node.type === 'element'

/** 空白だけのテキストノードを除いた子要素。 */
const meaningfulChildren = (node: Element): ElementContent[] =>
  node.children.filter(
    (child) => !(child.type === 'text' && child.value.trim() === '')
  )

const textOf = (node: ElementContent | Element): string => {
  if (node.type === 'text') return node.value
  if (node.type === 'element') return node.children.map(textOf).join('')
  return ''
}

/** 中身が 1 つの <a> だけの <p> なら、その <a> を返す。 */
const soleAnchor = (node: RootContent | ElementContent): Element | null => {
  if (!isElement(node) || node.tagName !== 'p') return null
  const children = meaningfulChildren(node)
  if (children.length !== 1) return null
  const only = children[0]
  if (!isElement(only) || only.tagName !== 'a') return null
  return only
}

/** 「posted with カエレバ」の段落か。 */
const isPostedWith = (node: RootContent | ElementContent): boolean => {
  if (!isElement(node) || node.tagName !== 'p') return false
  if (!textOf(node).includes('posted with')) return false
  // リンク先でも確かめる。本文中の「posted with」を巻き込まないため
  return node.children.some(
    (child) =>
      isElement(child) &&
      child.tagName === 'a' &&
      typeof child.properties?.href === 'string' &&
      child.properties.href.includes('kaereba.com')
  )
}

/**
 * 商品画像・商品名のリンク段落か。
 *
 * ショップリンクを除くのが要点。カエレバの並びは
 * 画像 → 商品名 → posted with → ブランド → ショップ の順で、
 * ショップリンクが商品名より前に来ることはない。除かないと、
 * 商品ボックスが連続しているときに «前のボックスの» 楽天市場や
 * Yahooショッピング を次のボックスの先頭として飲み込んでしまう
 * （実際に 3557.md で起きた）。
 * 商品名がショップ名で始まる例は 609 記事に 1 件も無いことを確認済み
 */
const isLeadingLink = (node: RootContent | ElementContent): boolean =>
  soleAnchor(node) !== null && !isShopLink(node)

/** ショップへのリンクの段落か。 */
const isShopLink = (node: RootContent | ElementContent): boolean => {
  const anchor = soleAnchor(node)
  if (!anchor) return false
  const text = textOf(anchor).trim()
  return SHOP_PREFIXES.some((shop) => text.startsWith(shop))
}

/** 文字だけの段落か（ブランド名）。 */
const isPlainText = (node: RootContent | ElementContent): boolean => {
  if (!isElement(node) || node.tagName !== 'p') return false
  return meaningfulChildren(node).every((child) => child.type === 'text')
}

/**
 * markdown 由来の構文木では要素の間に改行のテキストノードが挟まる。
 * 前後の «要素» を探すので、空白だけのノードは読み飛ばす
 * （これを忘れて、最初は posted with の段落しか包めていなかった）
 */
const isBlank = (node: RootContent): boolean =>
  node.type === 'text' && node.value.trim() === ''

const prevIndex = (children: RootContent[], i: number): number => {
  let j = i - 1
  while (j >= 0 && isBlank(children[j])) j--
  return j
}

const nextIndex = (children: RootContent[], i: number): number => {
  let j = i + 1
  while (j < children.length && isBlank(children[j])) j++
  return j
}

/** children[index] を起点に、ボックスの範囲 [start, end) を決める。 */
const blockRange = (
  children: RootContent[],
  index: number
): [number, number] => {
  let start = index
  // 前方向: 画像リンク・商品名リンクを最大 MAX_LEADING 個まで取り込む
  for (let taken = 0; taken < MAX_LEADING; taken++) {
    const prev = prevIndex(children, start)
    if (prev < 0 || !isLeadingLink(children[prev])) break
    start = prev
  }

  // 後方向: ブランド名（1 つだけ）とショップリンクを取り込む。
  // 著者の地の文を巻き込まないよう、ブランド名は直後に来たときだけ
  let last = index
  const afterPosted = nextIndex(children, last)
  if (afterPosted < children.length && isPlainText(children[afterPosted])) {
    last = afterPosted
  }
  for (;;) {
    const next = nextIndex(children, last)
    if (next >= children.length || !isShopLink(children[next])) break
    last = next
  }

  return [start, last + 1]
}

const wrap = (nodes: RootContent[]): Element => ({
  type: 'element',
  tagName: 'div',
  properties: { className: ['product-box'] },
  children: nodes as ElementContent[],
})

const transform = (node: Root | Element): void => {
  // 子を先に処理する。入れ子の中にボックスがあっても拾えるようにするため
  for (const child of node.children) {
    if (child.type === 'element') transform(child)
  }

  // 後ろから見ていく。前から置き換えると添字がずれる
  for (let i = node.children.length - 1; i >= 0; i--) {
    if (!isPostedWith(node.children[i])) continue
    const [start, end] = blockRange(node.children, i)
    const taken = node.children.slice(start, end)
    node.children.splice(start, end - start, wrap(taken))
    i = start
  }
}

export default function rehypeProductBox() {
  return (tree: Root): void => {
    transform(tree)
  }
}
