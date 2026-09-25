import dns from 'node:dns'
import net from 'node:net'

// ビルド時に、Notion で設定された任意の URL（記事のブックマーク、データベースの
// external のカバー）を取得するための関数（#148）。
// これまでは素の fetch で、プロトコルもホストも確かめず、リダイレクトも既定で
// 追っていた。URL を設定できるのは Notion で記事を編集できる人だけなので今の影響は
// 小さいが、共有範囲を広げたときに、ビルド環境から内部のアドレスへのリクエスト
// （SSRF）や、未検証の巨大なバイト列が sharp / metascraper に渡ることを防ぐ。
//
// Notion が発行する署名付き URL のダウンロード（client.ts の downloadFile）は
// Notion の管理下の URL なので対象にしていない。
//
// 防げないこと（DNS rebinding）: 取得の前に名前解決してアドレスを判定するが、
// fetch は接続のときに改めて名前解決するので、判定と接続の間で DNS の答えが
// 変われば（短い TTL で公開のアドレスから内部のアドレスに切り替えるなど）、
// 判定を通った後に内部のアドレスへ接続されうる。Node の組み込みの fetch には
// 名前解決を差し替える公開の手段が無く、防ぐには undici の Agent（connect.lookup）を
// 依存に足して dispatcher に渡す必要がある。URL を設定できるのは記事を編集できる
// 人だけで、その人はそもそも任意の内容を公開できるという今の影響の小ささに対して
// 重すぎるので足さない（接続先を固定しても、公開のプロキシ越しの転送はどのみち
// 防げない）。

/** 取得をやめた（弾いた）ことを表す。メッセージが理由の 1 行になる */
export class UnsafeFetchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnsafeFetchError'
  }
}

/**
 * ログやエラーメッセージに出す URL。client.ts の displayUrl と同じくクエリを落とす
 * （署名やアフィリエイトの計測のパラメータを含むことがあり、ビルドログは保存されるため）
 */
export const displayUrl = (url: URL): string =>
  // file: などは origin が 'null' になるので、プロトコルとパスで出す
  url.origin === 'null'
    ? `${url.protocol}${url.pathname}`
    : `${url.origin}${url.pathname}`

// https: だけに絞らないのは、ブックマークに http: のサイトがありうるため。
// 2026-09-26 時点の記事のブックマーク（dist の HTML で 21 件）はすべて https: だが、
// https に対応していない古いサイトをブックマークすることはありうる。
// http: を許しても、下のアドレスの判定は同じように掛かる
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:'])

// 取得しない IPv4 のアドレス。IANA の特殊用途のアドレスの一覧から、
// インターネット上の公開のサーバーではありえないものを並べる
const BLOCKED_IPV4 = new net.BlockList()
for (const [prefix, bits] of [
  ['0.0.0.0', 8], // 「このネットワーク」。0.0.0.0 への接続は自分自身に届く
  ['10.0.0.0', 8], // プライベート
  ['100.64.0.0', 10], // キャリアグレード NAT の共有アドレス
  ['127.0.0.0', 8], // ループバック
  ['169.254.0.0', 16], // リンクローカル（クラウドのメタデータ 169.254.169.254 を含む）
  ['172.16.0.0', 12], // プライベート
  ['192.0.0.0', 24], // IETF のプロトコル用
  ['192.0.2.0', 24], // 文書用
  ['192.88.99.0', 24], // 6to4 リレー（廃止）
  ['192.168.0.0', 16], // プライベート
  ['198.18.0.0', 15], // ベンチマーク用
  ['198.51.100.0', 24], // 文書用
  ['203.0.113.0', 24], // 文書用
  ['224.0.0.0', 4], // マルチキャスト
  ['240.0.0.0', 4], // 予約（255.255.255.255 を含む）
] as const) {
  BLOCKED_IPV4.addSubnet(prefix, bits, 'ipv4')
}

// IPv6 は逆に、グローバルユニキャスト（2000::/3）だけを通し、その中の特殊用途を除く。
// ループバック ::1、未指定 ::、ユニークローカル fc00::/7、リンクローカル fe80::/10、
// マルチキャスト ff00::/8 などは 2000::/3 の外なので、これで弾かれる
const GLOBAL_IPV6 = new net.BlockList()
GLOBAL_IPV6.addSubnet('2000::', 3, 'ipv6')
const BLOCKED_IPV6 = new net.BlockList()
for (const [prefix, bits] of [
  ['2001::', 23], // IETF のプロトコル用（Teredo 2001::/32 を含む）
  ['2001:db8::', 32], // 文書用
  ['2002::', 16], // 6to4（中に IPv4 を埋め込み、任意の IPv4 に届きうる）
  ['3fff::', 20], // 文書用
] as const) {
  BLOCKED_IPV6.addSubnet(prefix, bits, 'ipv6')
}

/** IPv6 のアドレスを 16 ビットずつ 8 つの数に展開する（net.isIPv6 を通ったものだけ渡す） */
const ipv6ToWords = (address: string): number[] => {
  let s = address.split('%')[0] // ゾーン ID（fe80::1%eth0 の %eth0）を落とす
  const v4Tail = s.match(/^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/)
  if (v4Tail) {
    const [a, b, c, d] = v4Tail.slice(2).map(Number)
    s = `${v4Tail[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
  }
  const [head, tail] = s.split('::')
  const headWords = head ? head.split(':') : []
  const tailWords = tail ? tail.split(':') : []
  const zeros = s.includes('::') ? 8 - headWords.length - tailWords.length : 0
  return [...headWords, ...Array(zeros).fill('0'), ...tailWords].map((w) =>
    parseInt(w, 16)
  )
}

/**
 * 取得してよい（インターネット上の公開の）アドレスか。
 * ループバック、プライベート、リンクローカル、0.0.0.0、そのほか特殊用途のアドレスは false
 */
export const isPublicAddress = (address: string): boolean => {
  if (net.isIPv4(address)) {
    return !BLOCKED_IPV4.check(address, 'ipv4')
  }
  if (!net.isIPv6(address)) {
    return false
  }
  const w = ipv6ToWords(address)
  const embeddedV4 = `${w[6] >> 8}.${w[6] & 0xff}.${w[7] >> 8}.${w[7] & 0xff}`
  // IPv4 射影アドレス（::ffff:127.0.0.1 など）は、中の IPv4 に接続するのと同じ
  if (w.slice(0, 5).every((x) => x === 0) && w[5] === 0xffff) {
    return isPublicAddress(embeddedV4)
  }
  // NAT64（64:ff9b::/96）も中の IPv4 に届く。IPv6 だけのネットワークでは
  // 公開のサーバーもこの形に変換されるので、一律には弾かず中の IPv4 で判定する
  if (w[0] === 0x64 && w[1] === 0xff9b && w.slice(2, 6).every((x) => x === 0)) {
    return isPublicAddress(embeddedV4)
  }
  const normalized = w.map((x) => x.toString(16)).join(':')
  return (
    GLOBAL_IPV6.check(normalized, 'ipv6') &&
    !BLOCKED_IPV6.check(normalized, 'ipv6')
  )
}

export type ResolvedAddress = { address: string; family: 4 | 6 }

export type SafeFetchOptions = {
  /** 取得全体（名前解決・リダイレクト・本文の受信）を打ち切るためのシグナル */
  signal?: AbortSignal
  /** 本文（展開後）の大きさの上限（バイト） */
  maxBytes: number
  /** リダイレクトを追う回数の上限 */
  maxRedirects?: number
  /**
   * アドレスの判定。試験で、127.0.0.1 に立てたサーバーへの取得を通すためだけに
   * 差し替える。本番のコードからは渡さないこと
   */
  isAllowedAddress?: (address: string) => boolean
}

export type SafeFetchResponse = {
  ok: boolean
  status: number
  /** リダイレクトを追った後の URL */
  url: URL
  /** ok のときの本文（Content-Encoding は展開済み）。ok でなければ空 */
  body: Buffer
}

const DEFAULT_MAX_REDIRECTS = 5

const abortError = (signal: AbortSignal): Error =>
  signal.reason instanceof Error
    ? signal.reason
    : new DOMException('This operation was aborted', 'AbortError')

/** 中断できない処理（dns.lookup）を、シグナルで待つのをやめられるようにする */
const untilAborted = <T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined
): Promise<T> => {
  if (!signal) {
    return promise
  }
  if (signal.aborted) {
    return Promise.reject(abortError(signal))
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError(signal))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort)
    })
  })
}

/**
 * URL のプロトコルとホストを確かめ、判定に使ったアドレスの一覧を返す。
 * 名前解決の結果に 1 つでも公開でないアドレスがあれば、全体を弾く
 * （どのアドレスに接続されるかは接続時の順序や到達性で変わるため）。
 * 返したアドレスに接続を固定するわけではない（冒頭の DNS rebinding の注意）
 */
export const resolveSafeAddresses = async (
  url: URL,
  {
    signal,
    isAllowedAddress = isPublicAddress,
  }: Pick<SafeFetchOptions, 'signal' | 'isAllowedAddress'> = {}
): Promise<ResolvedAddress[]> => {
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new UnsafeFetchError(
      `refused to fetch ${displayUrl(url)}: the protocol ${url.protocol} is not allowed`
    )
  }
  // IPv6 のアドレスを直接書いた URL は hostname が [::1] のように括弧付きになる
  const host = url.hostname.replace(/^\[(.*)\]$/, '$1')
  const family = net.isIP(host)
  const addresses: ResolvedAddress[] =
    family === 4 || family === 6
      ? [{ address: host, family }]
      : (
          await untilAborted(dns.promises.lookup(host, { all: true }), signal)
        ).map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 }))
  const blocked = addresses.find((a) => !isAllowedAddress(a.address))
  if (blocked || addresses.length === 0) {
    throw new UnsafeFetchError(
      `refused to fetch ${displayUrl(url)}: ${host} resolves to a non-public address (${blocked?.address ?? 'none'})`
    )
  }
  return addresses
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

/**
 * 本文を読む。Content-Length を信じ切らず（無いことも、偽ることもある）、
 * 読みながらバイト数を数え、上限を超えたら打ち切る。fetch の body は
 * Content-Encoding を展開した後のストリームなので、数えるのは展開後の大きさになる
 * （小さな gzip が巨大に展開される応答も止まる）
 */
const readBody = async (
  res: Response,
  url: URL,
  maxBytes: number
): Promise<Buffer> => {
  const tooLarge = () =>
    new UnsafeFetchError(
      `refused to fetch ${displayUrl(url)}: the response is larger than ${maxBytes} bytes`
    )
  const declared = Number(res.headers.get('content-length') ?? NaN)
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel()
    throw tooLarge()
  }
  if (!res.body) {
    return Buffer.alloc(0)
  }

  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) {
      break
    }
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel()
      throw tooLarge()
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks)
}

/**
 * 外部の URL を Node の組み込みの fetch で取得する。次のときは UnsafeFetchError を
 * 投げ、取得しない:
 * - プロトコルが http: / https: 以外
 * - ホストの名前解決の結果（IP アドレスを直接書いた URL はそのアドレス）が
 *   公開のアドレスでない（isPublicAddress）
 * - リダイレクトが maxRedirects 回を超える（redirect: 'manual' で自分で追い、
 *   行き先ごとに上の判定をやり直す）
 * - 本文が maxBytes を超える
 *
 * 2xx 以外の応答は投げずに ok: false で返す（本文は読まない）。
 * タイムアウトは呼び出し側が signal で掛ける（中断すると name が AbortError のエラー）。
 * 送るヘッダは fetch の既定のまま
 */
export const safeFetch = async (
  url: URL,
  {
    signal,
    maxBytes,
    maxRedirects = DEFAULT_MAX_REDIRECTS,
    isAllowedAddress,
  }: SafeFetchOptions
): Promise<SafeFetchResponse> => {
  let current = url
  for (let redirects = 0; ; redirects++) {
    await resolveSafeAddresses(current, { signal, isAllowedAddress })
    const res = await fetch(current, { signal, redirect: 'manual' })
    const location = res.headers.get('location')

    if (REDIRECT_STATUSES.has(res.status) && location) {
      await res.body?.cancel()
      if (redirects >= maxRedirects) {
        throw new UnsafeFetchError(
          `refused to fetch ${displayUrl(url)}: more than ${maxRedirects} redirects`
        )
      }
      // 行き先はループの先頭で、プロトコルとアドレスの判定をやり直す
      current = new URL(location, current)
      continue
    }

    if (!res.ok) {
      await res.body?.cancel()
      return {
        ok: false,
        status: res.status,
        url: current,
        body: Buffer.alloc(0),
      }
    }

    const body = await readBody(res, current, maxBytes)
    return { ok: true, status: res.status, url: current, body }
  }
}
