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

// ショップのリンクとして扱うテキスト。
// 前方一致ではなく «完全一致» で見る。前方一致だと
// 「Amazon Echo Dot」のような商品名をショップリンクと誤判定し、
// その商品名がボックスの外に取り残される。
// 実測では 1,868 件すべてがこのいずれかと完全一致していた
const SHOP_NAMES = new Set([
  'Amazon',
  '楽天市場',
  'Yahooショッピング',
  'ヤフオク!',
  '7net',
  'セブンネット',
  '価格.com',
  'ソニーストア',
])

/**
 * 商品リンクとして扱うリンク先。
 *
 * これを見ないと、商品ボックスの直前にある «著者自身の» リンク
 * （Flickr のアルバム、関連記事、A8 のバナー）まで巻き込んでしまう。
 * 実際に 17 件で起き、「今回撮影した全ての写真はこちら↓」という
 * 文が指すリンクが商品カードの内側に入っていた。
 *
 * 正当な先頭リンクは実測 1,090 件で、うち 1,088 件が Amazon の
 * ASIN リンク、2 件が楽天アフィリエイト（Amazon に無い商品）だった
 */
const isProductHref = (href: string): boolean =>
  href.includes('/exec/obidos/ASIN/') ||
  href.includes('afl.rakuten.co.jp') ||
  href.includes('valuecommerce.com') ||
  href.includes('7netshopping.jp') ||
  href.includes('omni7.jp')

// 「posted with カエレバ」より前に並ぶ画像リンク・商品名リンクの数。
// 実測では最大 3 だった（502 件が 2、59 件が 1）
const MAX_LEADING = 3

// ショップリンクだけが並ぶブロック（posted with が失われたもの）を
// 拾うときの最小連続数。1 にすると「Amazonで詳しく見る」のような
// 単独ウィジェットまで拾ってしまう
const MIN_SHOP_RUN = 2

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

const hrefOf = (anchor: Element): string =>
  typeof anchor.properties?.href === 'string' ? anchor.properties.href : ''

/** 「posted with カエレバ」の段落か。 */
const isPostedWith = (node: RootContent | ElementContent): boolean => {
  if (!isElement(node) || node.tagName !== 'p') return false
  if (!textOf(node).includes('posted with')) return false
  // リンク先でも確かめる。本文中の「posted with」を巻き込まないため
  return node.children.some(
    (child) =>
      isElement(child) &&
      child.tagName === 'a' &&
      hrefOf(child).includes('kaereba.com')
  )
}

/** ショップへのリンクの段落か。 */
const isShopLink = (node: RootContent | ElementContent): boolean => {
  const anchor = soleAnchor(node)
  return anchor !== null && SHOP_NAMES.has(textOf(anchor).trim())
}

/** 商品画像・商品名のリンクの段落か。 */
const isProductLink = (node: RootContent | ElementContent): boolean => {
  const anchor = soleAnchor(node)
  if (!anchor || isShopLink(node)) return false
  return isProductHref(hrefOf(anchor))
}

/** 文字だけの段落か（ブランド名や発売日）。 */
const isPlainText = (node: RootContent | ElementContent): boolean => {
  if (!isElement(node) || node.tagName !== 'p') return false
  return meaningfulChildren(node).every((child) => child.type === 'text')
}

/** 既にまとめ済みのボックスか。 */
const isProductBox = (node: RootContent | ElementContent): boolean =>
  isElement(node) &&
  node.tagName === 'div' &&
  Array.isArray(node.properties?.className) &&
  node.properties.className.includes('product-box')

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

/** index から前に向かって、ブランド名と商品リンクを取り込んだ開始位置。 */
const extendBackward = (children: RootContent[], index: number): number => {
  let start = index
  for (let taken = 0; taken < MAX_LEADING; taken++) {
    const prev = prevIndex(children, start)
    if (prev < 0 || !isProductLink(children[prev])) break
    start = prev
  }
  return start
}

/** posted with を起点にした範囲 [start, end)。 */
const rangeFromPosted = (
  children: RootContent[],
  index: number
): [number, number] => {
  const start = extendBackward(children, index)

  // 後方向: ブランド名（直後に 1 つだけ）とショップリンクを取り込む。
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
  // Doctype は Root 直下にしか現れず、ここへ来る並びには含まれない。
  // 型の上では RootContent に含まれるので、明示的に取り除いておく
  children: nodes.filter(
    (node): node is ElementContent => node.type !== 'doctype'
  ),
})

const replaceRange = (
  children: RootContent[],
  start: number,
  end: number
): void => {
  children.splice(start, end - start, wrap(children.slice(start, end)))
}

/** posted with があるブロックをまとめる。 */
const wrapPostedBlocks = (children: RootContent[]): void => {
  // 後ろから見ていく。前から置き換えると添字がずれる
  for (let i = children.length - 1; i >= 0; i--) {
    if (!isPostedWith(children[i])) continue
    const [start, end] = rangeFromPosted(children, i)
    replaceRange(children, start, end)
    i = start
  }
}

/**
 * posted with が失われたブロックをまとめる。
 *
 * 8 記事 18 ブロックで、移行時に「posted with カエレバ」の段落だけが
 * 失われており、画像・商品名・ブランド・ショップリンクがばらけたまま
 * 残っていた。ショップリンクが 2 つ以上続く箇所を起点に拾う。
 * 先に wrapPostedBlocks を通しておけば、既にまとめた分のショップ
 * リンクは div の中に入っていて、ここでは兄弟として見えない
 */
const wrapShopRuns = (children: RootContent[]): void => {
  for (let i = children.length - 1; i >= 0; i--) {
    if (!isShopLink(children[i])) continue

    // 連続するショップリンクの先頭まで戻る
    let first = i
    for (;;) {
      const prev = prevIndex(children, first)
      if (prev < 0 || !isShopLink(children[prev])) break
      first = prev
    }

    let count = 0
    for (let j = first; j <= i; j++) if (isShopLink(children[j])) count++
    if (count < MIN_SHOP_RUN) {
      i = first
      continue
    }

    // ブランド名（1 つだけ）と商品リンクを前に向かって取り込む
    let start = first
    const beforeShops = prevIndex(children, start)
    if (beforeShops >= 0 && isPlainText(children[beforeShops])) {
      start = beforeShops
    }
    start = extendBackward(children, start)

    // 商品リンクが 1 つも無いならカエレバのブロックではない
    let hasProduct = false
    for (let j = start; j < first; j++) {
      if (isProductLink(children[j])) hasProduct = true
    }
    if (!hasProduct) {
      i = first
      continue
    }

    replaceRange(children, start, i + 1)
    i = start
  }
}

const transform = (node: Root | Element): void => {
  // 子を先に処理する。入れ子の中にボックスがあっても拾えるようにするため
  for (const child of node.children) {
    if (child.type === 'element' && !isProductBox(child)) transform(child)
  }

  wrapPostedBlocks(node.children)
  wrapShopRuns(node.children)
}

export default function rehypeProductBox() {
  return (tree: Root): void => {
    transform(tree)
  }
}
