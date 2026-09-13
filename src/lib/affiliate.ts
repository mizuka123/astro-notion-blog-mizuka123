// アフィリエイトの各種 ID をこのファイルに直書きしている理由:
//
// 1. これらの ID は元々「公開されることを前提にした識別子」である。
//    既にサイト上の HTML（ValueCommerce の MyLinkBox / LinkSwitch）と、
//    コミット済みの 600 件超の Markdown に平文で含まれており、
//    秘匿しても意味が無い。環境変数にしても隠せないうえ、
//    ビルド時に NOTION_API_SECRET 以外の必須変数が増えるだけで割に合わない。
// 2. 一方で「散らばっていること」は実害があった。PR #57 で、死んだドメインに
//    飛んでいたリンクを 651 件まとめて直す羽目になったのは、リンクの形が
//    記事本文にコピペされていて 1 箇所で直せなかったため。
//    ID とリンクの組み立て方を今後変更するときは、このファイルだけを見れば済む
//    ようにしておく。
//
// 各 URL 形式は実測で HTTP 200 を確認したものに揃えてある。

/** Amazon アソシエイトのトラッキング ID */
const AMAZON_ASSOCIATE_TAG = 'mizuka123-22'

/**
 * 楽天アフィリエイトのリンク ID。
 * hb.afl.rakuten.co.jp/hgc/<この値>/ というパスの一部になる
 */
const RAKUTEN_AFFILIATE_ID = '032b53ee.4b34c5ee.0f4a541e.f440145e'

/** ValueCommerce のサイト ID（このブログ 1 サイトに対して 1 つ） */
const VALUECOMMERCE_SID = '3066752'

/** ValueCommerce のプログラム ID（提携先ショップごとに 1 つ） */
const VALUECOMMERCE_PID_YAHOO_SHOPPING = '881990642'
const VALUECOMMERCE_PID_SEVEN_NET = '881990643'

// NOTE: Yahoo!オークション（pid=881990645）はあえて含めない。
// ヒット 0 件の検索に対して Yahoo 側が 404 を返す仕様のため、
// 商品名で検索を投げるだけのこのボックスとは相性が悪い。

/** 1 ショップ分のリンク */
export interface ShopLink {
  /** ボタンに出すショップ名 */
  name: string
  /** 遷移先（アフィリエイト計測を通した URL） */
  url: string
}

/**
 * ValueCommerce のリファラル経由でショップの URL へ飛ばす。
 *
 * 遷移先 URL は vc_url= というクエリパラメータの「値」として丸ごと包まれるので、
 * ここで encodeURIComponent を掛けるのが二重エンコードの外側にあたる。
 * 内側（検索キーワード）は各 build 関数側で既にエンコード済みで、
 * その結果に含まれる % や & や = が、ここでさらに %25 / %26 / %3D になる。
 * どちらか片方でも欠けると vc_url の値が途中で切れて別のページに飛ぶ。
 */
const buildValueCommerceURL = (pid: string, destinationURL: string): string =>
  `https://ck.jp.ap.valuecommerce.com/servlet/referral?sid=${VALUECOMMERCE_SID}&pid=${pid}&vc_url=${encodeURIComponent(destinationURL)}`

/**
 * 商品名から 4 ショップ分の検索リンクを組み立てる。
 *
 * .astro に URL 生成を埋め込まず純粋関数として切り出しているのは、
 * エンコードの正しさを画面を起動せずに検証できるようにするため
 * （商品名には &, #, +, /, 空白, 日本語が普通に含まれる）。
 */
export const buildProductLinks = (productName: string): ShopLink[] => {
  const keyword = productName.trim()

  // encodeURIComponent は ! ' ( ) * を素通しするが、いずれもクエリ値および
  // パスセグメントとしては合法な文字なので、URL の構造は壊れない。
  // 壊れうるのは & # + / 空白と非 ASCII の方で、こちらは確実に変換される
  const encodedKeyword = encodeURIComponent(keyword)

  // 楽天の検索はキーワードをクエリではなくパスセグメントに置く。
  // 商品名に / が含まれても %2F になり 1 セグメントのまま保たれる
  const rakutenSearchURL = `https://search.rakuten.co.jp/search/mall/${encodedKeyword}/`
  const yahooShoppingSearchURL = `https://shopping.yahoo.co.jp/search?p=${encodedKeyword}`
  const sevenNetSearchURL = `https://7net.omni7.jp/search?q=${encodedKeyword}`

  return [
    {
      name: 'Amazon',
      // Amazon だけは中間サーバを挟まず、検索 URL に tag を足すだけで計測される
      url: `https://www.amazon.co.jp/s?k=${encodedKeyword}&tag=${AMAZON_ASSOCIATE_TAG}`,
    },
    {
      name: '楽天市場',
      // 楽天は pc= の値として遷移先 URL を包む。vc_url= と同じ二重エンコード
      url: `https://hb.afl.rakuten.co.jp/hgc/${RAKUTEN_AFFILIATE_ID}/?pc=${encodeURIComponent(rakutenSearchURL)}`,
    },
    {
      name: 'Yahoo!ショッピング',
      url: buildValueCommerceURL(
        VALUECOMMERCE_PID_YAHOO_SHOPPING,
        yahooShoppingSearchURL
      ),
    },
    {
      name: 'セブンネット',
      url: buildValueCommerceURL(
        VALUECOMMERCE_PID_SEVEN_NET,
        sevenNetSearchURL
      ),
    },
  ]
}

/**
 * 段落のテキストが「商品リンク: <商品名>」の形かを判定し、商品名を取り出す。
 *
 * 全角コロンも受け付ける。Notion で英数字の後に日本語コロンを打つと
 * IME の状態次第でどちらにもなるため、書き手に区別を強いたくない。
 * 前後の空白（全角スペース U+3000 を含む。JS の \s と trim は両方カバーする）は無視する。
 *
 * 商品名が空なら null を返す。「商品リンク:」とだけ書かれた段落で
 * 空のボックスを出すより、ただの段落として見せた方が書き手が異常に気づける。
 */
export const extractProductName = (text: string): string | null => {
  // /s を付けないのは、段落に改行が含まれる場合（Notion で Shift+Enter を
  // 使うと 1 つの段落に改行が入る）にマッチさせないため。
  // 付けると「商品リンク: 商品名」の後ろに続く説明文まで商品名に含まれて
  // しまう。マーカー行だけの段落でなければ通常の段落として描画する方が
  // 予測しやすく、本文を取りこぼすこともない
  const matched = text.trim().match(/^商品リンク\s*[:：]\s*(.+)$/)
  if (!matched) {
    return null
  }

  const productName = matched[1].trim()
  return productName === '' ? null : productName
}
