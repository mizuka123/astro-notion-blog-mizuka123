import dns from 'node:dns'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import zlib from 'node:zlib'

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
// fetch（undici）ではなく node:http / node:https で書いている理由:
// 判定と接続の間で DNS の答えが変わる「DNS rebinding」を防ぐには、判定に通った
// アドレスにそのまま接続させる必要がある。Node の組み込みの fetch には名前解決を
// 差し替える公開の手段が無い（undici の Agent の connect.lookup を dispatcher に
// 渡せば可能だが、Node は undici を node: のモジュールとして公開しておらず、依存に
// undici を足すことになる。組み込みの fetch と別の版の undici を混ぜる形にもなる）。
// node:http の request は lookup を受け取るので、判定済みのアドレスを返す lookup を
// 渡せば、依存を足さずに接続先を固定できる。

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
 * URL のプロトコルとホストを確かめ、接続してよいアドレスの一覧を返す。
 * 名前解決の結果に 1 つでも公開でないアドレスがあれば、全体を弾く
 * （どのアドレスに接続されるかは接続時の順序や到達性で変わるため）
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

// Node の組み込みの fetch が送るのと同じヘッダ（Node 24 で実測）。
// 送るヘッダで応答を変えるサイトがあり（403 を返すなど）、fetch から置き換えても
// ブックマークのプレビューが変わらないように揃える
const REQUEST_HEADERS = {
  accept: '*/*',
  'accept-language': '*',
  'sec-fetch-mode': 'cors',
  'user-agent': 'node',
  'accept-encoding': 'gzip, deflate',
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

/** 判定済みのアドレスだけを返す lookup。接続の直前の名前解決をこれに置き換える */
const pinnedLookup =
  (addresses: ResolvedAddress[]): net.LookupFunction =>
  (_hostname, options, callback) => {
    const candidates = options.family
      ? addresses.filter((a) => a.family === options.family)
      : addresses
    if (candidates.length === 0) {
      callback(
        Object.assign(new Error('no address of the requested family'), {
          code: 'ENOTFOUND',
        }),
        ''
      )
    } else if (options.all) {
      // Node 20 以降の既定（autoSelectFamily）では all: true で呼ばれ、配列を返す
      callback(null, candidates)
    } else {
      callback(null, candidates[0].address, candidates[0].family)
    }
  }

const requestOnce = (
  url: URL,
  addresses: ResolvedAddress[],
  signal: AbortSignal | undefined
): Promise<http.IncomingMessage> =>
  new Promise((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http
    const req = client.request(
      url,
      {
        method: 'GET',
        headers: REQUEST_HEADERS,
        lookup: pinnedLookup(addresses),
        // 接続を使い回さない。プールに残った接続が、判定したのと別のアドレスに
        // つながっていることがないようにするため（ビルド時の取得は数が少なく、
        // 使い回さないことによる遅れは小さい）
        agent: false,
        signal,
      },
      resolve
    )
    req.on('error', reject)
    req.end()
  })

/**
 * 本文を読む。Content-Length を信じ切らず（無いことも、偽ることもある）、
 * 展開後のバイト数を読みながら数え、上限を超えたら接続ごと打ち切る。
 * 展開後で数えるのは、小さな gzip が巨大に展開される応答を防ぐため
 */
const readBody = async (
  res: http.IncomingMessage,
  url: URL,
  maxBytes: number,
  signal: AbortSignal | undefined
): Promise<Buffer> => {
  const tooLarge = () =>
    new UnsafeFetchError(
      `refused to fetch ${displayUrl(url)}: the response is larger than ${maxBytes} bytes`
    )
  const declared = Number(res.headers['content-length'])
  if (Number.isFinite(declared) && declared > maxBytes) {
    res.destroy()
    throw tooLarge()
  }

  // fetch と同じく、Content-Encoding を後ろから順に展開する。知らない符号化は
  // fetch と同じくそのまま返す
  const decoders = (res.headers['content-encoding'] ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e && e !== 'identity')
    .reverse()
    .flatMap((e) =>
      e === 'gzip' || e === 'x-gzip'
        ? [zlib.createGunzip()]
        : e === 'deflate'
          ? [zlib.createInflate()]
          : e === 'br'
            ? [zlib.createBrotliDecompress()]
            : []
    )

  const chunks: Buffer[] = []
  let total = 0
  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      total += chunk.length
      if (total > maxBytes) {
        callback(tooLarge())
        return
      }
      chunks.push(chunk)
      callback()
    },
  })
  await pipeline([res, ...decoders, sink], { signal })
  return Buffer.concat(chunks)
}

/**
 * 外部の URL を安全に取得する。次のときは UnsafeFetchError を投げ、取得しない:
 * - プロトコルが http: / https: 以外
 * - ホストの名前解決の結果（IP アドレスを直接書いた URL はそのアドレス）が
 *   公開のアドレスでない（isPublicAddress）
 * - リダイレクトが maxRedirects 回を超える（行き先ごとに上の判定をやり直す）
 * - 本文が maxBytes を超える
 *
 * 2xx 以外の応答は投げずに ok: false で返す（本文は読まない）。
 * タイムアウトは呼び出し側が signal で掛ける（中断すると name が AbortError のエラー）
 *
 * DNS rebinding について: 判定に通ったアドレスに接続を固定しているので、判定の後に
 * DNS の答えが変わっても内部のアドレスには接続しない。ただし、公開のアドレスの
 * 先にあるサーバーがビルド環境の内部に転送する構成（公開のプロキシなど）までは防げない
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
  try {
    return await followRedirects(url, {
      signal,
      maxBytes,
      maxRedirects,
      isAllowedAddress,
    })
  } catch (err) {
    // 本文の受信中に中断すると、ソケットが先に壊れて「aborted」のような別の
    // エラーで失敗することがある。呼び出し側はタイムアウトを name が AbortError か
    // で見分けているので、中断されていたら AbortError に揃える
    if (signal?.aborted && !(err instanceof UnsafeFetchError)) {
      throw abortError(signal)
    }
    throw err
  }
}

const followRedirects = async (
  url: URL,
  {
    signal,
    maxBytes,
    maxRedirects,
    isAllowedAddress,
  }: Required<Pick<SafeFetchOptions, 'maxBytes' | 'maxRedirects'>> &
    Pick<SafeFetchOptions, 'signal' | 'isAllowedAddress'>
): Promise<SafeFetchResponse> => {
  let current = url
  for (let redirects = 0; ; redirects++) {
    const addresses = await resolveSafeAddresses(current, {
      signal,
      isAllowedAddress,
    })
    const res = await requestOnce(current, addresses, signal)
    const status = res.statusCode ?? 0
    const location = res.headers.location

    if (REDIRECT_STATUSES.has(status) && location) {
      res.destroy()
      if (redirects >= maxRedirects) {
        throw new UnsafeFetchError(
          `refused to fetch ${displayUrl(url)}: more than ${maxRedirects} redirects`
        )
      }
      // 行き先はループの先頭で、プロトコルとアドレスの判定をやり直す
      current = new URL(location, current)
      continue
    }

    if (status < 200 || status > 299) {
      res.destroy()
      return { ok: false, status, url: current, body: Buffer.alloc(0) }
    }

    const body = await readBody(res, current, maxBytes, signal)
    return { ok: true, status, url: current, body }
  }
}
