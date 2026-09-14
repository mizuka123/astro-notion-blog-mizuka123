// build:local / dev:local の前に .env が使える状態かを確かめる。
//
// これが無いと、.env を用意し忘れたときに Notion SDK の
// 「Authorization header must use the format "Bearer <token>".」だけが出る。
// 原因が「トークンが間違っている」のか「そもそも読み込まれていない」のか
// 分からず、実際に一度ここで詰まった。
import fs from 'node:fs'

const REQUIRED = ['NOTION_API_SECRET', 'DATABASE_ID']

if (!fs.existsSync('.env')) {
  console.error(`
.env がありません。ローカルでビルドするには次の内容で作成してください。

  NOTION_API_SECRET=<Notion のインテグレーショントークン>
  DATABASE_ID=<ブログのデータベース ID>

  トークン: https://www.notion.so/my-integrations
  DB ID  : Notion でデータベースを開いた URL の 32 桁

.env は .gitignore されているのでコミットされません。
Cloudflare では環境変数が設定済みなので、この手順は不要です（npm run build）。
`)
  process.exit(1)
}

// 値そのものは絶対に出さない。未設定かどうかだけを見る
const missing = REQUIRED.filter((name) => !process.env[name])
if (missing.length > 0) {
  console.error(`
.env はありますが ${missing.join(' と ')} が空です。
プレースホルダ（<...>）のままになっていないか確認してください。
`)
  process.exit(1)
}
