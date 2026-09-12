import { APIResponseError, Client } from '@notionhq/client'
import retry from 'async-retry'
import ExifTransformer from 'exif-be-gone'
import fs, { createWriteStream } from 'node:fs'
import { Readable, Transform } from 'node:stream'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import { pipeline } from 'node:stream/promises'
import sharp from 'sharp'
import {
  DATABASE_ID,
  NOTION_API_SECRET,
  NUMBER_OF_POSTS_PER_PAGE,
  REQUEST_TIMEOUT_MS,
} from '../../server-constants'
import type {
  Annotation,
  Block,
  Bookmark,
  BulletedListItem,
  Callout,
  Code,
  Column,
  ColumnList,
  Database,
  Embed,
  Emoji,
  Equation,
  File,
  FileObject,
  Heading1,
  Heading2,
  Heading3,
  Image,
  LinkPreview,
  LinkToPage,
  Mention,
  NumberedListItem,
  Paragraph,
  Post,
  Quote,
  Reference,
  RichText,
  SelectProperty,
  SyncedBlock,
  SyncedFrom,
  Table,
  TableCell,
  TableOfContents,
  TableRow,
  Text,
  ToDo,
  Toggle,
  Video,
} from '../interfaces'
// NOTE: リクエストパラメータの型は SDK のものを直接使う。
// upstream（otoyo/astro-notion-blog）にあった src/lib/notion/request-params.ts は
// これらと構造的に等価だったため削除した。upstream 側でパラメータ型が追加・変更
// されると `git merge upstream/main` で request-params.ts の modify/delete 衝突と
// この import 周りの衝突が起きる。その際はファイルを復活させるのではなく、
// 追加されたフィールドを対応する SDK の型の使い方に読み替えること。
import type {
  GetBlockParameters,
  GetDatabaseParameters,
  GetDataSourceParameters,
  ListBlockChildrenParameters,
  QueryDataSourceParameters,
} from '@notionhq/client'
// レスポンス側は手書きの型のまま。SDK の実際の戻り値は partial を含む union だが、
// responses.ts は full のみをモデル化している。ブロックについては
// _warnUnreadableBlocks / _filterReadableBlocks と getBlock の実行時チェックで
// 実害を塞いであるが、型の上では依然 partial を表現できていない。
// responses.ts を SDK 由来の型に置き換えて型ガードで扱うのは別途対応する
import type * as responses from './responses'

const client = new Client({
  auth: NOTION_API_SECRET,
  notionVersion: '2026-03-11',
})

let postsCache: Post[] | null = null
let dbCache: Database | null = null

const numberOfRetry = 2

export async function getAllPosts(): Promise<Post[]> {
  if (postsCache !== null) {
    return Promise.resolve(postsCache)
  }

  const dbResponse = (await client.databases.retrieve({
    database_id: DATABASE_ID,
  })) as responses.RetrieveDatabaseResponse
  if (!dbResponse || dbResponse.in_trash) {
    // 空配列を返すと記事 0 件のサイトがビルド成功として出てしまうため、
    // 設定ミスや DB の削除はビルドを止めて気づけるようにする
    throw new Error(
      `The database either does not exist or is in trash. Please restore it to fetch posts. database_id: ${DATABASE_ID}`
    )
  }

  const dataSouceId = dbResponse.data_sources?.[0]?.id
  if (!dataSouceId) {
    throw new Error(
      `No data source found for the database. Please add a data source to fetch posts. database_id: ${DATABASE_ID}`
    )
  }

  const params: QueryDataSourceParameters = {
    data_source_id: dataSouceId,
    filter: {
      and: [
        {
          property: 'Published',
          checkbox: {
            equals: true,
          },
        },
        {
          property: 'Date',
          date: {
            on_or_before: new Date().toISOString(),
          },
        },
      ],
    },
    sorts: [
      {
        property: 'Date',
        direction: 'descending',
      },
    ],
    page_size: 100,
  }

  let results: responses.PageObject[] = []
  while (true) {
    const res = await retry(
      async (bail) => {
        try {
          return (await client.dataSources.query(
            params
          )) as responses.QueryDataSourceResponse
        } catch (error: unknown) {
          if (error instanceof APIResponseError) {
            if (error.status && error.status >= 400 && error.status < 500) {
              bail(error)
            }
          }
          throw error
        }
      },
      {
        retries: numberOfRetry,
      }
    )

    results = results.concat(res.results)

    if (!res.has_more) {
      break
    }

    params['start_cursor'] = res.next_cursor as string
  }

  postsCache = results
    .filter((pageObject) => _validPageObject(pageObject))
    .map((pageObject) => _buildPost(pageObject))
  return postsCache
}

export async function getPosts(pageSize = 10): Promise<Post[]> {
  const allPosts = await getAllPosts()
  return allPosts.slice(0, pageSize)
}

export async function getRankedPosts(pageSize = 10): Promise<Post[]> {
  const allPosts = await getAllPosts()
  return allPosts
    .filter((post) => !!post.Rank)
    .sort((a, b) => {
      if (a.Rank > b.Rank) {
        return -1
      } else if (a.Rank === b.Rank) {
        return 0
      }
      return 1
    })
    .slice(0, pageSize)
}

export async function getPostBySlug(slug: string): Promise<Post | null> {
  const allPosts = await getAllPosts()
  return allPosts.find((post) => post.Slug === slug) || null
}

export async function getPostByPageId(pageId: string): Promise<Post | null> {
  const allPosts = await getAllPosts()
  return allPosts.find((post) => post.PageId === pageId) || null
}

export async function getPostsByTag(
  tagName: string,
  pageSize = 10
): Promise<Post[]> {
  if (!tagName) return []

  const allPosts = await getAllPosts()
  return allPosts
    .filter((post) => post.Tags.find((tag) => tag.name === tagName))
    .slice(0, pageSize)
}

// page starts from 1 not 0
export async function getPostsByPage(page: number): Promise<Post[]> {
  if (page < 1) {
    return []
  }

  const allPosts = await getAllPosts()

  const startIndex = (page - 1) * NUMBER_OF_POSTS_PER_PAGE
  const endIndex = startIndex + NUMBER_OF_POSTS_PER_PAGE

  return allPosts.slice(startIndex, endIndex)
}

// page starts from 1 not 0
export async function getPostsByTagAndPage(
  tagName: string,
  page: number
): Promise<Post[]> {
  if (page < 1) {
    return []
  }

  const allPosts = await getAllPosts()
  const posts = allPosts.filter((post) =>
    post.Tags.find((tag) => tag.name === tagName)
  )

  const startIndex = (page - 1) * NUMBER_OF_POSTS_PER_PAGE
  const endIndex = startIndex + NUMBER_OF_POSTS_PER_PAGE

  return posts.slice(startIndex, endIndex)
}

export async function getNumberOfPages(): Promise<number> {
  const allPosts = await getAllPosts()
  return (
    Math.floor(allPosts.length / NUMBER_OF_POSTS_PER_PAGE) +
    (allPosts.length % NUMBER_OF_POSTS_PER_PAGE > 0 ? 1 : 0)
  )
}

export async function getNumberOfPagesByTag(tagName: string): Promise<number> {
  const allPosts = await getAllPosts()
  const posts = allPosts.filter((post) =>
    post.Tags.find((tag) => tag.name === tagName)
  )
  return (
    Math.floor(posts.length / NUMBER_OF_POSTS_PER_PAGE) +
    (posts.length % NUMBER_OF_POSTS_PER_PAGE > 0 ? 1 : 0)
  )
}

export async function getAllBlocksByBlockId(blockId: string): Promise<Block[]> {
  let results: responses.BlockObject[] = []

  if (fs.existsSync(`tmp/${blockId}.json`)) {
    results = JSON.parse(fs.readFileSync(`tmp/${blockId}.json`, 'utf-8'))
  } else {
    const params: ListBlockChildrenParameters = {
      block_id: blockId,
    }

    while (true) {
      const res = await retry(
        async (bail) => {
          try {
            return (await client.blocks.children.list(
              params
            )) as responses.RetrieveBlockChildrenResponse
          } catch (error: unknown) {
            if (error instanceof APIResponseError) {
              if (error.status && error.status >= 400 && error.status < 500) {
                bail(error)
              }
            }
            throw error
          }
        },
        {
          retries: numberOfRetry,
        }
      )

      results = results.concat(res.results)

      if (!res.has_more) {
        break
      }

      params['start_cursor'] = res.next_cursor as string
    }
  }

  const allBlocks = _filterReadableBlocks(blockId, results).map((blockObject) =>
    _buildBlock(blockObject)
  )

  for (let i = 0; i < allBlocks.length; i++) {
    const block = allBlocks[i]

    if (block.Type === 'table' && block.Table) {
      block.Table.Rows = await _getTableRows(block.Id)
    } else if (block.Type === 'column_list' && block.ColumnList) {
      block.ColumnList.Columns = await _getColumns(block.Id)
    } else if (
      block.Type === 'bulleted_list_item' &&
      block.BulletedListItem &&
      block.HasChildren
    ) {
      block.BulletedListItem.Children = await getAllBlocksByBlockId(block.Id)
    } else if (
      block.Type === 'numbered_list_item' &&
      block.NumberedListItem &&
      block.HasChildren
    ) {
      block.NumberedListItem.Children = await getAllBlocksByBlockId(block.Id)
    } else if (block.Type === 'to_do' && block.ToDo && block.HasChildren) {
      block.ToDo.Children = await getAllBlocksByBlockId(block.Id)
    } else if (block.Type === 'synced_block' && block.SyncedBlock) {
      block.SyncedBlock.Children = await _getSyncedBlockChildren(block)
    } else if (block.Type === 'toggle' && block.Toggle) {
      block.Toggle.Children = await getAllBlocksByBlockId(block.Id)
    } else if (
      block.Type === 'paragraph' &&
      block.Paragraph &&
      block.HasChildren
    ) {
      block.Paragraph.Children = await getAllBlocksByBlockId(block.Id)
    } else if (
      block.Type === 'heading_1' &&
      block.Heading1 &&
      block.HasChildren
    ) {
      block.Heading1.Children = await getAllBlocksByBlockId(block.Id)
    } else if (
      block.Type === 'heading_2' &&
      block.Heading2 &&
      block.HasChildren
    ) {
      block.Heading2.Children = await getAllBlocksByBlockId(block.Id)
    } else if (
      block.Type === 'heading_3' &&
      block.Heading3 &&
      block.HasChildren
    ) {
      block.Heading3.Children = await getAllBlocksByBlockId(block.Id)
    } else if (block.Type === 'quote' && block.Quote && block.HasChildren) {
      block.Quote.Children = await getAllBlocksByBlockId(block.Id)
    } else if (block.Type === 'callout' && block.Callout && block.HasChildren) {
      block.Callout.Children = await getAllBlocksByBlockId(block.Id)
    }
  }

  return allBlocks
}

export async function getBlock(blockId: string): Promise<Block> {
  const params: GetBlockParameters = {
    block_id: blockId,
  }

  const res = await retry(
    async (bail) => {
      try {
        return (await client.blocks.retrieve(
          params
        )) as responses.RetrieveBlockResponse
      } catch (error: unknown) {
        if (error instanceof APIResponseError) {
          if (error.status && error.status >= 400 && error.status < 500) {
            bail(error)
          }
        }
        throw error
      }
    },
    {
      retries: numberOfRetry,
    }
  )

  if (!res.type) {
    // 一覧取得と違い、ここは呼び出し側が「このブロックが読める」前提で
    // 期限切れの署名付き URL を取り直すために呼ぶ。黙って空の Block を返すと
    // posts/[slug].astro で block.Image も block.File も undefined になり、
    // どのブロックかも分からない TypeError になるため、ここでは落とす
    throw new Error(
      `The block could not be read. Check the integration's access to it in Notion. block_id: ${blockId}`
    )
  }

  return _buildBlock(res)
}

export async function getAllTags(): Promise<SelectProperty[]> {
  const allPosts = await getAllPosts()

  const tagNames: string[] = []
  return allPosts
    .flatMap((post) => post.Tags)
    .reduce((acc, tag) => {
      if (!tagNames.includes(tag.name)) {
        acc.push(tag)
        tagNames.push(tag.name)
      }
      return acc
    }, [] as SelectProperty[])
    .sort((a: SelectProperty, b: SelectProperty) =>
      a.name.localeCompare(b.name)
    )
}

/**
 * Notion の署名付き URL はクエリ文字列に署名を含み、ビルドログは保存されるため、
 * ログやエラーメッセージにはクエリを落としたものを使う。
 */
const displayUrl = (url: URL): string => `${url.origin}${url.pathname}`

export async function downloadFile(url: URL) {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  let res!: Response
  try {
    res = await fetch(url.toString(), {
      method: 'GET',
      signal: controller.signal,
    })

    if (!res.ok) {
      throw new Error(`HTTP error! status: ${res.status}`)
    }

    if (!res.body) {
      throw new Error('Response body is null')
    }
  } catch (err) {
    throw new Error(`Failed to fetch ${displayUrl(url)}`, { cause: err })
  } finally {
    // fetch が失敗した場合も必ずタイマーを解放する
    clearTimeout(timeoutId)
  }

  const dir = './public/notion/' + url.pathname.split('/').slice(-2)[0]
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }

  const filename = decodeURIComponent(url.pathname.split('/').slice(-1)[0])
  const filepath = `${dir}/${filename}`

  const writeStream = createWriteStream(filepath)
  // fetch の Response.body は DOM の ReadableStream、Readable.fromWeb が受けるのは
  // node:stream/web の ReadableStream。同名だが別宣言で構造的に互換にならないため
  // ここだけ明示的に変換する（any で潰さない）
  const source = Readable.fromWeb(res.body as WebReadableStream<Uint8Array>)

  // ヘッダを受け取った時点で fetch の signal は本文の転送に効かなくなる。
  // 一定時間データが流れてこなければ中断しないと、転送が停止したときに
  // ビルドが無限に待ち続け、どの URL で止まったのかも分からなくなる。
  // 進んでいる限りタイマーを張り直すので、単に遅いだけの転送は中断しない
  let stallTimeoutId: NodeJS.Timeout | undefined
  const restartStallTimeout = () => {
    clearTimeout(stallTimeoutId)
    stallTimeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  }
  const stallGuard = new Transform({
    transform(chunk, _encoding, callback) {
      restartStallTimeout()
      callback(null, chunk)
    },
  })

  // sharp を先に stream.pipe() で繋ぐと転送元が pipeline の管理外になり、
  // 転送中のエラーが catch されず未処理例外になるため、全段を pipeline に渡す
  const stages =
    res.headers.get('content-type') === 'image/jpeg'
      ? [
          source,
          stallGuard,
          sharp().rotate(),
          new ExifTransformer(),
          writeStream,
        ]
      : [source, stallGuard, new ExifTransformer(), writeStream]

  restartStallTimeout()

  try {
    // pipeline は Promise を返すため await しないと書き込み時のエラーを捕捉できない
    await pipeline(stages, { signal: controller.signal })
  } catch (err) {
    // 途中まで書かれたファイルは public/notion に残り続け、後続のビルドで
    // public-notion-copier がそのまま dist にコピーしてしまうため削除する。
    // 後始末の失敗で本来のエラーを覆い隠さないよう、ここでは投げない
    try {
      fs.rmSync(filepath, { force: true })
    } catch (cleanupErr) {
      console.error(`Failed to remove partial file ${filepath}`)
      console.error(cleanupErr)
    }
    throw new Error(`Failed to write ${filepath} from ${displayUrl(url)}`, {
      cause: err,
    })
  } finally {
    clearTimeout(stallTimeoutId)
  }
}

/**
 * 渡された URL をすべてダウンロードし、1 件でも失敗したらエラーを投げる。
 *
 * 最初の失敗で打ち切らず全件を試すので、この呼び出しに渡した URL については
 * 失敗したものを 1 回のビルドですべて列挙できる。不正な URL もダウンロード
 * できない以上は失敗として扱う（取りこぼすと本番に壊れた <img> が出るため）。
 *
 * なお astro:build:start フックは integration ごとに直列に実行されるため、
 * 先に走った integration が投げた時点でビルドは止まり、後続の integration の
 * 失敗はそのビルドでは分からない。
 */
export async function downloadFiles(
  label: string,
  rawUrls: string[]
): Promise<void> {
  const urls: URL[] = []
  const failures: string[] = []
  // 同じファイルを指す URL が複数含まれていると、同一パスへ並行に書き込んで
  // ファイルが壊れる（失敗側の後始末が成功側の書き込みを消すこともある）。
  // 保存先パスは pathname の末尾 2 要素だけで決まるので、それをキーに重複を除く
  const seenPaths = new Set<string>()

  rawUrls.forEach((rawUrl) => {
    let url!: URL
    try {
      url = new URL(rawUrl)
    } catch (err) {
      console.error(`[${label}] invalid URL: ${rawUrl}`)
      console.error(err)
      failures.push(`${rawUrl} (invalid URL)`)
      return
    }

    const destPath = url.pathname.split('/').slice(-2).join('/')
    if (seenPaths.has(destPath)) {
      return
    }
    seenPaths.add(destPath)
    urls.push(url)
  })

  const results = await Promise.allSettled(urls.map((url) => downloadFile(url)))

  results.forEach((result, i) => {
    if (result.status === 'rejected') {
      console.error(`[${label}] download failed: ${displayUrl(urls[i])}`)
      console.error(result.reason)
      failures.push(displayUrl(urls[i]))
    }
  })

  if (failures.length > 0) {
    throw new Error(
      `[${label}] ${failures.length} of ${rawUrls.length} files failed to download:\n` +
        failures.map((failure) => `  - ${failure}`).join('\n')
    )
  }
}

export async function getDatabase(): Promise<Database> {
  if (dbCache !== null) {
    return Promise.resolve(dbCache)
  }

  const params: GetDatabaseParameters = {
    database_id: DATABASE_ID,
  }

  const res = await retry(
    async (bail) => {
      try {
        return (await client.databases.retrieve(
          params
        )) as responses.RetrieveDatabaseResponse
      } catch (error: unknown) {
        if (error instanceof APIResponseError) {
          if (error.status && error.status >= 400 && error.status < 500) {
            bail(error)
          }
        }
        throw error
      }
    },
    {
      retries: numberOfRetry,
    }
  )

  const dataSource = await _getDataSource(res.data_sources?.[0]?.id || '')

  // アイコンとカバーはデータソースとデータベースの両方に存在しうるため、
  // データソース側が未設定ならデータベース側にフォールバックする
  const rawIcon = dataSource.icon || res.icon
  const rawCover = dataSource.cover || res.cover

  let icon: FileObject | Emoji | null = null
  if (rawIcon) {
    if (rawIcon.type === 'emoji' && 'emoji' in rawIcon) {
      icon = {
        Type: rawIcon.type,
        Emoji: rawIcon.emoji,
      }
    } else if (rawIcon.type === 'external' && 'external' in rawIcon) {
      icon = {
        Type: rawIcon.type,
        Url: rawIcon.external?.url || '',
      }
    } else if (rawIcon.type === 'file' && 'file' in rawIcon) {
      icon = {
        Type: rawIcon.type,
        Url: rawIcon.file?.url || '',
      }
    } else if (rawIcon.type === 'icon' && 'icon' in rawIcon) {
      // Notion 標準アイコンは名前と色で返るため、画像 URL を組み立てて
      // external として扱う (例: camera + gray -> camera_gray.svg)
      icon = {
        Type: 'external',
        Url: `https://www.notion.so/icons/${rawIcon.icon.name}_${rawIcon.icon.color}.svg`,
      }
    } else if (rawIcon.type === 'custom_emoji' && 'custom_emoji' in rawIcon) {
      icon = {
        Type: 'external',
        Url: rawIcon.custom_emoji.url || '',
      }
    }
  }

  let cover: FileObject | null = null
  if (rawCover) {
    cover = {
      Type: rawCover.type,
      Url: rawCover.external?.url || rawCover?.file?.url || '',
    }
  }

  const database: Database = {
    Title: res.title.map((richText) => richText.plain_text).join(''),
    Description: res.description
      .map((richText) => richText.plain_text)
      .join(''),
    Icon: icon,
    Cover: cover,
  }

  dbCache = database
  return database
}

export async function _getDataSource(
  data_source_id: string
): Promise<responses.DataSourceObject> {
  const params: GetDataSourceParameters = {
    data_source_id: data_source_id,
  }

  return await retry(
    async (bail) => {
      try {
        return (await client.dataSources.retrieve(
          params
        )) as responses.RetrieveDataSourceResponse
      } catch (error: unknown) {
        if (error instanceof APIResponseError) {
          if (error.status && error.status >= 400 && error.status < 500) {
            bail(error)
          }
        }
        throw error
      }
    },
    {
      retries: numberOfRetry,
    }
  )
}

/**
 * 統合（integration）がそのブロックを読めない場合、Notion は id だけを持つ
 * partial なオブジェクトを返す（type も has_children も無い）。
 * responses.ts は full のみをモデル化しているため型では検出できず、素通りすると
 * _buildBlock が Type: undefined の中身の無い Block を作り、NotionBlocks.astro が
 * どの case にも当たらず null を返して、記事からブロックが黙って消える。
 *
 * ビルドは止めない。Notion 側で共有が外れたブロックが 1 つあるだけで
 * サイト全体がビルド不能になってしまうため（_getSyncedBlockChildren と同じ判断）。
 * ただしどのブロックが落ちたかは分かるようにする。
 */
function _warnUnreadableBlocks(
  parentBlockId: string,
  blockObjects: responses.BlockObject[]
): void {
  blockObjects.forEach((blockObject) => {
    if (!blockObject.type) {
      console.error(
        `A block could not be read. Check the integration's access to it in Notion. block_id: ${blockObject.id}, parent_block_id: ${parentBlockId}`
      )
    }
  })
}

function _filterReadableBlocks(
  parentBlockId: string,
  blockObjects: responses.BlockObject[]
): responses.BlockObject[] {
  _warnUnreadableBlocks(parentBlockId, blockObjects)
  return blockObjects.filter((blockObject) => !!blockObject.type)
}

function _buildBlock(blockObject: responses.BlockObject): Block {
  const block: Block = {
    Id: blockObject.id,
    Type: blockObject.type,
    HasChildren: blockObject.has_children,
  }

  switch (blockObject.type) {
    case 'paragraph':
      if (blockObject.paragraph) {
        const paragraph: Paragraph = {
          RichTexts: blockObject.paragraph.rich_text.map(_buildRichText),
          Color: blockObject.paragraph.color,
        }
        block.Paragraph = paragraph
      }
      break
    case 'heading_1':
      if (blockObject.heading_1) {
        const heading1: Heading1 = {
          RichTexts: blockObject.heading_1.rich_text.map(_buildRichText),
          Color: blockObject.heading_1.color,
          IsToggleable: blockObject.heading_1.is_toggleable,
        }
        block.Heading1 = heading1
      }
      break
    case 'heading_2':
      if (blockObject.heading_2) {
        const heading2: Heading2 = {
          RichTexts: blockObject.heading_2.rich_text.map(_buildRichText),
          Color: blockObject.heading_2.color,
          IsToggleable: blockObject.heading_2.is_toggleable,
        }
        block.Heading2 = heading2
      }
      break
    case 'heading_3':
      if (blockObject.heading_3) {
        const heading3: Heading3 = {
          RichTexts: blockObject.heading_3.rich_text.map(_buildRichText),
          Color: blockObject.heading_3.color,
          IsToggleable: blockObject.heading_3.is_toggleable,
        }
        block.Heading3 = heading3
      }
      break
    case 'bulleted_list_item':
      if (blockObject.bulleted_list_item) {
        const bulletedListItem: BulletedListItem = {
          RichTexts:
            blockObject.bulleted_list_item.rich_text.map(_buildRichText),
          Color: blockObject.bulleted_list_item.color,
        }
        block.BulletedListItem = bulletedListItem
      }
      break
    case 'numbered_list_item':
      if (blockObject.numbered_list_item) {
        const numberedListItem: NumberedListItem = {
          RichTexts:
            blockObject.numbered_list_item.rich_text.map(_buildRichText),
          Color: blockObject.numbered_list_item.color,
        }
        block.NumberedListItem = numberedListItem
      }
      break
    case 'to_do':
      if (blockObject.to_do) {
        const toDo: ToDo = {
          RichTexts: blockObject.to_do.rich_text.map(_buildRichText),
          Checked: blockObject.to_do.checked,
          Color: blockObject.to_do.color,
        }
        block.ToDo = toDo
      }
      break
    case 'video':
      if (blockObject.video) {
        const video: Video = {
          Caption: blockObject.video.caption?.map(_buildRichText) || [],
          Type: blockObject.video.type,
        }
        if (
          blockObject.video.type === 'external' &&
          blockObject.video.external
        ) {
          video.External = { Url: blockObject.video.external.url }
        }
        block.Video = video
      }
      break
    case 'image':
      if (blockObject.image) {
        const image: Image = {
          Caption: blockObject.image.caption?.map(_buildRichText) || [],
          Type: blockObject.image.type,
        }
        if (
          blockObject.image.type === 'external' &&
          blockObject.image.external
        ) {
          image.External = { Url: blockObject.image.external.url }
        } else if (
          blockObject.image.type === 'file' &&
          blockObject.image.file
        ) {
          image.File = {
            Type: blockObject.image.type,
            Url: blockObject.image.file.url,
            ExpiryTime: blockObject.image.file.expiry_time,
          }
        }
        block.Image = image
      }
      break
    case 'file':
      if (blockObject.file) {
        const file: File = {
          Caption: blockObject.file.caption?.map(_buildRichText) || [],
          Type: blockObject.file.type,
        }
        if (blockObject.file.type === 'external' && blockObject.file.external) {
          file.External = { Url: blockObject.file.external.url }
        } else if (blockObject.file.type === 'file' && blockObject.file.file) {
          file.File = {
            Type: blockObject.file.type,
            Url: blockObject.file.file.url,
            ExpiryTime: blockObject.file.file.expiry_time,
          }
        }
        block.File = file
      }
      break
    case 'code':
      if (blockObject.code) {
        const code: Code = {
          Caption: blockObject.code.caption?.map(_buildRichText) || [],
          RichTexts: blockObject.code.rich_text.map(_buildRichText),
          Language: blockObject.code.language,
        }
        block.Code = code
      }
      break
    case 'quote':
      if (blockObject.quote) {
        const quote: Quote = {
          RichTexts: blockObject.quote.rich_text.map(_buildRichText),
          Color: blockObject.quote.color,
        }
        block.Quote = quote
      }
      break
    case 'equation':
      if (blockObject.equation) {
        const equation: Equation = {
          Expression: blockObject.equation.expression,
        }
        block.Equation = equation
      }
      break
    case 'callout':
      if (blockObject.callout) {
        let icon: FileObject | Emoji | null = null
        if (blockObject.callout.icon) {
          if (
            blockObject.callout.icon.type === 'emoji' &&
            'emoji' in blockObject.callout.icon
          ) {
            icon = {
              Type: blockObject.callout.icon.type,
              Emoji: blockObject.callout.icon.emoji,
            }
          } else if (
            blockObject.callout.icon.type === 'external' &&
            'external' in blockObject.callout.icon
          ) {
            icon = {
              Type: blockObject.callout.icon.type,
              Url: blockObject.callout.icon.external?.url || '',
            }
          }
        }

        const callout: Callout = {
          RichTexts: blockObject.callout.rich_text.map(_buildRichText),
          Icon: icon,
          Color: blockObject.callout.color,
        }
        block.Callout = callout
      }
      break
    case 'synced_block':
      if (blockObject.synced_block) {
        let syncedFrom: SyncedFrom | null = null
        if (
          blockObject.synced_block.synced_from &&
          blockObject.synced_block.synced_from.block_id
        ) {
          syncedFrom = {
            BlockId: blockObject.synced_block.synced_from.block_id,
          }
        }

        const syncedBlock: SyncedBlock = {
          SyncedFrom: syncedFrom,
        }
        block.SyncedBlock = syncedBlock
      }
      break
    case 'toggle':
      if (blockObject.toggle) {
        const toggle: Toggle = {
          RichTexts: blockObject.toggle.rich_text.map(_buildRichText),
          Color: blockObject.toggle.color,
          Children: [],
        }
        block.Toggle = toggle
      }
      break
    case 'embed':
      if (blockObject.embed) {
        const embed: Embed = {
          Url: blockObject.embed.url,
        }
        block.Embed = embed
      }
      break
    case 'bookmark':
      if (blockObject.bookmark) {
        const bookmark: Bookmark = {
          Caption: blockObject.bookmark.caption?.map(_buildRichText) || [],
          Url: blockObject.bookmark.url,
        }
        block.Bookmark = bookmark
      }
      break
    case 'link_preview':
      if (blockObject.link_preview) {
        const linkPreview: LinkPreview = {
          Url: blockObject.link_preview.url,
        }
        block.LinkPreview = linkPreview
      }
      break
    case 'table':
      if (blockObject.table) {
        const table: Table = {
          TableWidth: blockObject.table.table_width,
          HasColumnHeader: blockObject.table.has_column_header,
          HasRowHeader: blockObject.table.has_row_header,
          Rows: [],
        }
        block.Table = table
      }
      break
    case 'column_list':
      const columnList: ColumnList = {
        Columns: [],
      }
      block.ColumnList = columnList
      break
    case 'table_of_contents':
      if (blockObject.table_of_contents) {
        const tableOfContents: TableOfContents = {
          Color: blockObject.table_of_contents.color,
        }
        block.TableOfContents = tableOfContents
      }
      break
    case 'link_to_page':
      if (blockObject.link_to_page && blockObject.link_to_page.page_id) {
        const linkToPage: LinkToPage = {
          Type: blockObject.link_to_page.type,
          PageId: blockObject.link_to_page.page_id,
        }
        block.LinkToPage = linkToPage
      }
      break
  }

  return block
}

async function _getTableRows(blockId: string): Promise<TableRow[]> {
  let results: responses.BlockObject[] = []

  if (fs.existsSync(`tmp/${blockId}.json`)) {
    results = JSON.parse(fs.readFileSync(`tmp/${blockId}.json`, 'utf-8'))
  } else {
    const params: ListBlockChildrenParameters = {
      block_id: blockId,
    }

    while (true) {
      const res = await retry(
        async (bail) => {
          try {
            return (await client.blocks.children.list(
              params
            )) as responses.RetrieveBlockChildrenResponse
          } catch (error: unknown) {
            if (error instanceof APIResponseError) {
              if (error.status && error.status >= 400 && error.status < 500) {
                bail(error)
              }
            }
            throw error
          }
        },
        {
          retries: numberOfRetry,
        }
      )

      results = results.concat(res.results)

      if (!res.has_more) {
        break
      }

      params['start_cursor'] = res.next_cursor as string
    }
  }

  // 表だけは読めない行も取り除かない。Table.astro はヘッダー行を配列の位置
  // （j === 0）だけで判定しているため、先頭行を落とすと 2 行目がヘッダーに
  // 繰り上がってしまう。読めない行は Cells が空のまま空行として描画される
  _warnUnreadableBlocks(blockId, results)

  return results.map((blockObject) => {
    const tableRow: TableRow = {
      Id: blockObject.id,
      Type: blockObject.type,
      HasChildren: blockObject.has_children,
      Cells: [],
    }

    if (blockObject.type === 'table_row' && blockObject.table_row) {
      const cells: TableCell[] = blockObject.table_row.cells.map((cell) => {
        const tableCell: TableCell = {
          RichTexts: cell.map(_buildRichText),
        }

        return tableCell
      })

      tableRow.Cells = cells
    }

    return tableRow
  })
}

async function _getColumns(blockId: string): Promise<Column[]> {
  let results: responses.BlockObject[] = []

  if (fs.existsSync(`tmp/${blockId}.json`)) {
    results = JSON.parse(fs.readFileSync(`tmp/${blockId}.json`, 'utf-8'))
  } else {
    const params: ListBlockChildrenParameters = {
      block_id: blockId,
    }

    while (true) {
      const res = await retry(
        async (bail) => {
          try {
            return (await client.blocks.children.list(
              params
            )) as responses.RetrieveBlockChildrenResponse
          } catch (error: unknown) {
            if (error instanceof APIResponseError) {
              if (error.status && error.status >= 400 && error.status < 500) {
                bail(error)
              }
            }
            throw error
          }
        },
        {
          retries: numberOfRetry,
        }
      )

      results = results.concat(res.results)

      if (!res.has_more) {
        break
      }

      params['start_cursor'] = res.next_cursor as string
    }
  }

  return await Promise.all(
    _filterReadableBlocks(blockId, results).map(async (blockObject) => {
      const children = await getAllBlocksByBlockId(blockObject.id)

      const column: Column = {
        Id: blockObject.id,
        Type: blockObject.type,
        HasChildren: blockObject.has_children,
        Children: children,
      }

      return column
    })
  )
}

async function _getSyncedBlockChildren(block: Block): Promise<Block[]> {
  let originalBlock: Block = block
  if (
    block.SyncedBlock &&
    block.SyncedBlock.SyncedFrom &&
    block.SyncedBlock.SyncedFrom.BlockId
  ) {
    try {
      originalBlock = await getBlock(block.SyncedBlock.SyncedFrom.BlockId)
    } catch (err) {
      // ここはビルドを止めない。Notion 側で共有が外れた synced_block が
      // 1 つあるだけでサイト全体がビルド不能になってしまうため。
      // ただしどのブロックが落ちたかは分かるようにする
      console.error(
        `Could not retrieve the original synced_block. block_id: ${block.Id}, synced_from: ${block.SyncedBlock?.SyncedFrom?.BlockId}`
      )
      console.error(err)
      return []
    }
  }

  const children = await getAllBlocksByBlockId(originalBlock.Id)
  return children
}

function _validPageObject(pageObject: responses.PageObject): boolean {
  const prop = pageObject.properties

  const missing: string[] = []
  if (!prop.Page.title || prop.Page.title.length === 0) {
    missing.push('Page')
  }
  if (!prop.Slug.rich_text || prop.Slug.rich_text.length === 0) {
    missing.push('Slug')
  }
  if (!prop.Date.date) {
    missing.push('Date')
  }

  if (missing.length > 0) {
    // Published にチェックが入っているのに必須プロパティが空の記事は、
    // ここで黙って除外されるとサイトから消えたことに気づけない。
    // ビルドは止めない（記事 1 件の記入漏れで全体を止めない）が、
    // どのページが落ちたかは分かるようにする
    console.error(
      `Skipped a published page with empty required properties. page_id: ${pageObject.id}, missing: ${missing.join(', ')}`
    )
    return false
  }

  return true
}

function _buildPost(pageObject: responses.PageObject): Post {
  const prop = pageObject.properties

  let icon: FileObject | Emoji | null = null
  if (pageObject.icon) {
    if (pageObject.icon.type === 'emoji' && 'emoji' in pageObject.icon) {
      icon = {
        Type: pageObject.icon.type,
        Emoji: pageObject.icon.emoji,
      }
    } else if (
      pageObject.icon.type === 'external' &&
      'external' in pageObject.icon
    ) {
      icon = {
        Type: pageObject.icon.type,
        Url: pageObject.icon.external?.url || '',
      }
    }
  }

  let cover: FileObject | null = null
  if (pageObject.cover) {
    cover = {
      Type: pageObject.cover.type,
      Url: pageObject.cover.external?.url || '',
    }
  }

  let featuredImage: FileObject | null = null
  if (prop.FeaturedImage.files && prop.FeaturedImage.files.length > 0) {
    if (prop.FeaturedImage.files[0].external) {
      featuredImage = {
        Type: prop.FeaturedImage.type,
        Url: prop.FeaturedImage.files[0].external.url,
      }
    } else if (prop.FeaturedImage.files[0].file) {
      featuredImage = {
        Type: prop.FeaturedImage.type,
        Url: prop.FeaturedImage.files[0].file.url,
        ExpiryTime: prop.FeaturedImage.files[0].file.expiry_time,
      }
    }
  }

  const post: Post = {
    PageId: pageObject.id,
    Title: prop.Page.title
      ? prop.Page.title.map((richText) => richText.plain_text).join('')
      : '',
    Icon: icon,
    Cover: cover,
    Slug: prop.Slug.rich_text
      ? prop.Slug.rich_text.map((richText) => richText.plain_text).join('')
      : '',
    Date: prop.Date.date ? prop.Date.date.start : '',
    Tags: prop.Tags.multi_select ? prop.Tags.multi_select : [],
    Excerpt:
      prop.Excerpt.rich_text && prop.Excerpt.rich_text.length > 0
        ? prop.Excerpt.rich_text.map((richText) => richText.plain_text).join('')
        : '',
    FeaturedImage: featuredImage,
    Rank: prop.Rank.number ? prop.Rank.number : 0,
  }

  return post
}

function _buildRichText(richTextObject: responses.RichTextObject): RichText {
  const annotation: Annotation = {
    Bold: richTextObject.annotations.bold,
    Italic: richTextObject.annotations.italic,
    Strikethrough: richTextObject.annotations.strikethrough,
    Underline: richTextObject.annotations.underline,
    Code: richTextObject.annotations.code,
    Color: richTextObject.annotations.color,
  }

  const richText: RichText = {
    Annotation: annotation,
    PlainText: richTextObject.plain_text,
    Href: richTextObject.href,
  }

  if (richTextObject.type === 'text' && richTextObject.text) {
    const text: Text = {
      Content: richTextObject.text.content,
    }

    if (richTextObject.text.link) {
      text.Link = {
        Url: richTextObject.text.link.url,
      }
    }

    richText.Text = text
  } else if (richTextObject.type === 'equation' && richTextObject.equation) {
    const equation: Equation = {
      Expression: richTextObject.equation.expression,
    }
    richText.Equation = equation
  } else if (richTextObject.type === 'mention' && richTextObject.mention) {
    const mention: Mention = {
      Type: richTextObject.mention.type,
    }

    if (richTextObject.mention.type === 'page' && richTextObject.mention.page) {
      const reference: Reference = {
        Id: richTextObject.mention.page.id,
      }
      mention.Page = reference
    }

    richText.Mention = mention
  }

  return richText
}
