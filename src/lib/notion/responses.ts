import type { RichTextItemResponse } from '@notionhq/client'

// Retrieve a database response
// https://developers.notion.com/reference/retrieve-a-database
export type RetrieveDatabaseResponse = DatabaseObject

// Retrieve a data source response
// https://developers.notion.com/reference/retrieve-a-data-source
export type RetrieveDataSourceResponse = DataSourceObject

// common interfaces
interface UserObject {
  object: string
  id: string
}

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

interface Parent {
  type: string
  database_id?: string
  page_id?: string
}

// SDK の型をそのまま使う。手書きの RichTextObject は href が `string | undefined`
// だったが、実際の API と SDK は `string | null` を返しており乖離していた。
// これに伴い Annotations / Text / Link / Mention / Reference は不要になったため削除。
export type RichTextObject = RichTextItemResponse

// Database object
// https://developers.notion.com/reference/database
interface DatabaseObject {
  object: string
  id: string
  created_time: string
  created_by: UserObject
  last_edited_time: string
  last_edited_by: UserObject
  data_sources: DataSourceObject[]
  title: RichTextObject[]
  description: RichTextObject[]
  icon: FileObject | Emoji | NoticonIcon | CustomEmojiIcon | null
  cover: FileObject
  parent: Parent
  url: string
  public_url: string | null
  in_trash: boolean
  is_inline: boolean
}

// Data source object
// https://developers.notion.com/reference/data-source
export interface DataSourceObject {
  object: string
  id: string
  created_time: string
  created_by: UserObject
  last_edited_time: string
  last_edited_by: UserObject
  title: RichTextObject[]
  description: RichTextObject[]
  icon: FileObject | Emoji | NoticonIcon | CustomEmojiIcon | null
  cover: FileObject | Emoji | null
  properties: DataSourceProperties
  parent: Parent
  database_parent: Parent
  in_trash: boolean
}

interface DataSourceProperties {
  [key: string]: DataSourceProperty
}

interface DataSourceProperty {
  id: string
  name: string
  description: string
  type: string

  title?: Record<string, never>
  rich_text?: Record<string, never>
  number?: NumberConfiguration
  select?: SelectConfiguration
  status?: StatusConfiguration
  multi_select?: SelectConfiguration
  date?: Record<string, never>
  people?: Record<string, never>
  files?: Record<string, never>
  checkbox?: Record<string, never>
  url?: Record<string, never>
  email?: Record<string, never>
  phone_number?: Record<string, never>
  formula?: FormulaConfiguration
  relation?: RelationConfiguration
  rollup?: RollupConfiguration
  created_time?: Record<string, never>
  created_by?: Record<string, never>
  last_edited_time?: Record<string, never>
  last_edited_by?: Record<string, never>
}

interface NumberConfiguration {
  format: string
}

interface SelectConfiguration {
  options: SelectOptionObject[]
}

interface SelectOptionObject {
  name: string
  id: string
  color: string
}

interface StatusConfiguration {
  options: StatusOptionObject[]
  groups: StatusGroupObject[]
}

interface StatusOptionObject {
  name: string
  id: string
  color: string
}

interface StatusGroupObject {
  name: string
  id: string
  color: string
  option_ids: string[]
}

interface FormulaConfiguration {
  expression: string
}

interface RelationConfiguration {
  database_id: string
  type: string

  single_property?: Record<string, never>
  dual_property?: DualPropertyRelationConfiguration
}

interface DualPropertyRelationConfiguration {
  synced_property_name: string
  synced_property_id: string
}

interface RollupConfiguration {
  relation_property_name: string
  relation_property_id: string
  rollup_property_name: string
  rollup_property_id: string
  function: string
}
