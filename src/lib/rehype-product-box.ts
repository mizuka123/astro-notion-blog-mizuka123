import type { Element, ElementContent, Root, RootContent } from 'hast'
import { buildProductLinks } from './affiliate.ts'

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
 *
 * 包んだうえで、Notion 記事の商品リンクの箱（ProductLinkBox.astro）と
 * 同じ markup に組み直す。見た目は src/styles/product-link-box.css を共有する。
 * ショップへのテキストリンクは色付きのボタンに、商品画像と商品名は
 * 箱の上段に並べる。
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
  // 2026-10 にボタンを affiliate.ts の形へ揃えたときの表記（PR #186）
  'Yahoo!ショッピング',
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
  // 販売終了した商品の個別ページへのリンクは、2026-10 にタグ付きの
  // 検索リンクへ置き換えた（PR #184）。著者の地の文の Amazon リンクを
  // 巻き込まないよう、このブログのタグが付いた検索 URL に限る
  (href.startsWith('https://www.amazon.co.jp/s?k=') &&
    href.includes('tag=mizuka123-22')) ||
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

// ボタンの色とラベルは Notion の箱と揃える。affiliate.ts が持つ値を
// そのまま使い、ここに色を書き写さない
const SHOP_STYLE = new Map(
  buildProductLinks('_').map((link) => [link.name, link] as const)
)

/** 記事中のショップ名を、Notion の箱のラベルに寄せる。 */
const shopLabel = (name: string): string =>
  name === 'Yahooショッピング' || name === 'Yahoo!ショッピング'
    ? 'Yahoo!'
    : name

// affiliate.ts に無いショップ（ソニーストアなど）のボタンの色
const OTHER_SHOP_COLOR = '#6b6b6b'

const el = (
  tagName: string,
  className: string | null,
  children: ElementContent[],
  properties: Element['properties'] = {}
): Element => ({
  type: 'element',
  tagName,
  properties: className
    ? { ...properties, className: [className] }
    : properties,
  children,
})

const text = (value: string): ElementContent => ({ type: 'text', value })

const hasImage = (node: ElementContent): boolean =>
  isElement(node) &&
  (node.tagName === 'img' || node.children.some((child) => hasImage(child)))

/** ショップのリンクを、ProductLinkBox.astro と同じボタンにする。 */
const shopButton = (anchor: Element): Element => {
  const label = shopLabel(textOf(anchor).trim())
  const color = SHOP_STYLE.get(label)?.color ?? OTHER_SHOP_COLOR
  return el('li', null, [
    el(
      'a',
      null,
      [el('span', null, [text(label)]), el('span', null, [text('で探す')])],
      {
        href: hrefOf(anchor),
        target: '_blank',
        rel: ['nofollow', 'sponsored', 'noopener', 'noreferrer'],
        style: `--shop-color: ${color}`,
      }
    ),
  ])
}

/**
 * まとめた段落の並びを、Notion の商品リンクの箱と同じ形に組み直す。
 * ショップのリンクが 1 つも無ければ組み直さない（ボタンの無い箱になるため）
 */
const rebuild = (nodes: ElementContent[]): ElementContent[] | null => {
  const images: Element[] = []
  let title: Element | null = null
  const meta: string[] = []
  const shops: Element[] = []

  for (const node of nodes) {
    if (isPostedWith(node)) continue
    const anchor = soleAnchor(node)
    if (anchor && isShopLink(node)) shops.push(shopButton(anchor))
    else if (anchor && hasImage(anchor)) {
      images.push(anchor)
      // 画像と商品名が 1 つのリンクに入っている箱がある（移行時に
      // 改行で連結された）。商品名を別に持たないときは、その文字を使う
      const caption = textOf(anchor).trim()
      if (!title && caption) {
        title = { ...anchor, children: [text(caption)] }
        images[images.length - 1] = {
          ...anchor,
          children: anchor.children.filter((child) => hasImage(child)),
        }
      }
    } else if (anchor && !title) title = anchor
    else if (isPlainText(node)) meta.push(textOf(node).trim())
    // 想定外の段落は落とさず、箱の上段にそのまま残す
    else if (anchor) meta.push(textOf(anchor).trim())
  }
  if (shops.length === 0) return null

  const textPart: ElementContent[] = []
  if (title) textPart.push(el('p', 'product-name', [title]))
  const metaText = meta.filter(Boolean).join(' ')
  if (metaText) textPart.push(el('p', 'product-meta', [text(metaText)]))

  const head: ElementContent[] = []
  // 同じ商品の画像が大小 2 つ並ぶ箱があるので、先頭の 1 枚だけ使う
  if (images[0]) head.push(el('p', 'product-image', [images[0]]))
  if (textPart.length > 0) head.push(el('div', 'product-text', textPart))

  return [
    ...(head.length > 0 ? [el('div', 'product-head', head)] : []),
    el('ul', 'shops', shops),
  ]
}

const wrap = (nodes: RootContent[]): Element => {
  // Doctype は Root 直下にしか現れず、ここへ来る並びには含まれない。
  // 型の上では RootContent に含まれるので、明示的に取り除いておく
  const children = nodes.filter(
    (node): node is ElementContent => node.type !== 'doctype' && !isBlank(node)
  )
  const rebuilt = rebuild(children)
  return {
    type: 'element',
    tagName: 'div',
    properties: {
      className: rebuilt
        ? ['product-box', 'product-link-box']
        : ['product-box'],
    },
    children: rebuilt ?? children,
  }
}

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
