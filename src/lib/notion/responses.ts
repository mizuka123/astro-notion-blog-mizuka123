// Notion のアイコン / ファイルの型。ここだけ手書きが残っている。
// SDK 由来の判別可能 union に置き換えるのは次の PR で行う。

export interface FileObject {
  type: string
  name?: string
  external?: External
  file?: File
}

interface File {
  url: string
  expiry_time: string
}

interface External {
  url: string
}

export interface Emoji {
  type: string
  emoji: string
}

// Notion 標準アイコン (noticon)
// API version 2025-09-03 以降、標準アイコンは外部 URL ではなく名前と色で返る
export interface NoticonIcon {
  type: string
  icon: {
    name: string
    color: string
  }
}

export interface CustomEmojiIcon {
  type: string
  custom_emoji: {
    id: string
    name: string
    url: string
  }
}
