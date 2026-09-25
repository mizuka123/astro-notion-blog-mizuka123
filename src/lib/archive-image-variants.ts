/**
 * アーカイブ記事の画像の «幅違い» のファイル名の決まり（#134）。
 *
 * public/archive/images/ の画像は幅 1600px 以下（#84）のまま配信していて、
 * スマートフォン（表示 658px など）でも 1600px を読み込んでいた。
 * 幅 640 / 1024 の版を scripts/generate-archive-image-variants.mjs で
 * 事前に作ってコミットし、rehype-archive-srcset.ts が srcset を付ける。
 *
 * 名前の決まりを生成する側と使う側の 2 か所に書くと、片方だけ変えたときに
 * srcset が «ディスクに無いファイル» を指すか、黙って付かなくなる。
 * ここに 1 か所だけ置き、両方から import する。
 * 生成スクリプトは Node の型の除去で .ts を直接読むので、このファイルは
 * 型注釈以外の TypeScript 固有の構文（enum など）と、拡張子無しの
 * import を使わないこと
 */

// 作る幅。元の幅がこれを «超える» ものにだけ作る（拡大はしない）。
// 元の画像はそのまま最大の候補として srcset に入る
export const ARCHIVE_IMAGE_VARIANT_WIDTHS = [640, 1024] as const

/**
 * 元のファイル名（デコード済み）から、幅 width の版のファイル名を返す。
 * 拡張子の前に -<幅>w を挟む（foo.jpg → foo-640w.jpg）。
 * 拡張子の大文字小文字は元のまま（foo.PNG → foo-640w.PNG）。
 * 拡張子が無ければ null
 */
export const archiveImageVariantName = (
  name: string,
  width: number
): string | null => {
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return null
  return `${name.slice(0, dot)}-${width}w${name.slice(dot)}`
}

// 拡張子の前が -640w / -1024w のもの。「.」は正規表現では任意の 1 文字に
// なるので [.] と書く（テンプレート文字列の中の \. は ES の規則で . になり、
// エスケープが消える）
const VARIANT_NAME = new RegExp(
  `-(?:${ARCHIVE_IMAGE_VARIANT_WIDTHS.join('|')})w[.][^.]+$`
)

/** 幅違いの版の名前の形か（生成済みのファイルを元の画像と区別するのに使う） */
export const isArchiveImageVariantName = (name: string): boolean =>
  VARIANT_NAME.test(name)
