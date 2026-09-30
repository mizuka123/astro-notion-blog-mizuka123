// はてなブログ 3 つ（blog / tech / money.mizuka123.net）の記事をアーカイブ記事として取り込む。
//
//   node scripts/import-hatena-blogs.mjs [--export-dir <dir>] [--gyazo-json <file>] [--offline]
//
// 一度だけ実行して、できたファイルをコミットするためのもの（ビルドでは呼ばない）。
// はてなは解約するので、元のエクスポートはもう手に入らない前提で手順を残している。
//
// 入力は管理画面の「エクスポート」で落とした Movable Type 形式のファイル
// （<sub>.mizuka123.net.export.txt）。既定では ~/Downloads から読む。
// エクスポートにはコメント投稿者の情報が入りうるので、リポジトリには入れない。
//
// 出力:
//   - src/pages/archive/<sub>-<YYYYMMDD>-<HHMMSS>.md
//     旧 URL /entry/YYYY/MM/DD/HHMMSS から機械的に決まる名前にしてあり、
//     Cloudflare のリダイレクトはサブドメインごとに 1 本で書ける。
//     サブフォルダにしないのは、アーカイブ記事を列挙する箇所
//     （archive-frontmatter.ts・search-index.json.ts など）が
//     src/pages/archive/*.md しか見ないため
//   - public/archive/images/hatena-<sub>-<元のファイル名>
//     画像は /archive/images/ 直下にしか置けない（archive-image-file.ts）。
//     既存の 01.jpg などと衝突しないよう接頭辞を付ける
//
// 画像の扱い:
//   - Flickr・はてなフォトライフ・Gyazo・Google フォトの写真はダウンロードして取り込む。
//     取れなかったもの（404 など）は「画像は失われました」に置き換える
//   - mizuka123.net/zenphoto の画像は、ギャラリーごと消えていて元ファイルも
//     残っていないので、同じく「画像は失われました」に置き換える
//   - 広告・計測用の画像、はてなのバッジ類、サイトのサムネイル画像は捨てる
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import TurndownService from 'turndown';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARCHIVE_DIR = path.join(ROOT, 'src/pages/archive');
const IMAGE_DIR = path.join(ROOT, 'public/archive/images');
const CACHE_DIR = path.join(os.tmpdir(), 'hatena-import-cache');

const args = process.argv.slice(2);
const argValue = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const EXPORT_DIR =
  argValue('--export-dir') ?? path.join(os.homedir(), 'Downloads');
const OFFLINE = args.includes('--offline');

const SUBS = ['blog', 'tech', 'money'];
const LOST_IMAGE = '*（画像は失われました）*';

// はてなのカテゴリー → 既存アーカイブのカテゴリーとタグ。
// カテゴリーは archive-taxonomy.ts の CATEGORY_DISPLAY_NAMES にあるスラッグに寄せ、
// 機種名などは既存のタグ（eos-5d-mark-iii など）に合わせる。
// money だけは既存に受け皿が無いので money カテゴリーを新設する
const CATEGORY_MAP = {
  blog: {
    'EOS 5D MarkⅢ': { categories: ['camera-lens'], tags: ['eos-5d-mark-iii'] },
    'EOS-1D X': { categories: ['camera-lens'], tags: ['eos-1d-x'] },
    RX100M3: { categories: ['camera-lens'], tags: ['dsc-rx100m3'] },
    GR: { categories: ['camera-lens'], tags: ['ricoh-gr'] },
    カメラ: { categories: ['camera-lens'], tags: [] },
    ガジェット: { categories: ['gadget'], tags: [] },
    モバイル: { categories: ['mobile-line'], tags: [] },
    日記: { categories: ['note'], tags: [] },
    ブログ: { categories: ['blog'], tags: [] },
  },
  tech: {
    Webサービス: { categories: ['pc-web'], tags: ['webサービス'] },
    Windows: { categories: ['pc-web'], tags: ['windows'] },
    Linux: { categories: ['pc-web'], tags: ['linux'] },
    ESXi: { categories: ['pc-web'], tags: ['esxi'] },
    'Office Insider': { categories: ['pc-web'], tags: ['office-insider'] },
    Tips: { categories: ['pc-web'], tags: [] },
    ブログ運営: { categories: ['blog'], tags: [] },
    はてなブログ: { categories: ['blog'], tags: ['はてなブログ'] },
    お知らせ: { categories: ['blog'], tags: [] },
  },
  money: {
    クレジットカード: { categories: ['money'], tags: ['クレジットカード'] },
    仮想通貨: { categories: ['money'], tags: ['仮想通貨'] },
    投資信託: { categories: ['money'], tags: ['投資信託'] },
    株: { categories: ['money'], tags: ['株'] },
    ポイント: { categories: ['money'], tags: ['ポイント'] },
  },
};

// ---------------------------------------------------------------------------
// Movable Type 形式の読み込み

const parseExport = (text) =>
  text
    .replace(/\r\n/g, '\n')
    .split(/^--------\n/m)
    .filter((chunk) => chunk.trim())
    .map((chunk) => {
      const [head, ...sections] = chunk.split(/^-----\n/m);
      const meta = { CATEGORY: [] };
      for (const line of head.split('\n')) {
        const m = line.match(/^([A-Z ]+): ?(.*)$/);
        if (!m) continue;
        if (m[1] === 'CATEGORY') meta.CATEGORY.push(m[2]);
        else meta[m[1]] = m[2];
      }
      for (const section of sections) {
        const m = section.match(/^([A-Z ]+):\n([\s\S]*)$/);
        if (m && m[1] === 'BODY') meta.BODY = m[2];
      }
      return meta;
    });

// BASENAME は全記事 YYYY/MM/DD/HHMMSS（カスタム URL は使っていない）
const slugOf = (sub, basename) => {
  const m = basename.match(/^(\d{4})\/(\d{2})\/(\d{2})\/(\d{6})$/);
  if (!m) throw new Error(`想定外の BASENAME: ${sub} ${basename}`);
  return `${sub}-${m[1]}${m[2]}${m[3]}-${m[4]}`;
};

// ---------------------------------------------------------------------------
// 画像

const IMAGE_HOSTS_TO_KEEP =
  /^https?:\/\/(farm\d+\.staticflickr\.com|live\.staticflickr\.com|cdn-ak\.f\.st-hatena\.com|i\.gyazo\.com|lh\d\.googleusercontent\.com)\//;
const ZENPHOTO = /^https?:\/\/mizuka123\.net\/zenphoto\//;

const imageKind = (src) => {
  if (ZENPHOTO.test(src)) return 'lost';
  if (IMAGE_HOSTS_TO_KEEP.test(src)) return 'keep';
  return 'drop';
};

// Flickr は 500px 版（接尾辞なし）で貼られているものが多い。同じ写真の
// 1024px 版（_b）があればそちらを取る。無ければ貼られていた版を取る
const candidateUrls = (src) => {
  const m = src.match(
    /^(https?:\/\/farm\d+\.staticflickr\.com\/\d+\/\d+_[0-9a-f]+)(_[a-z])?\.jpg$/
  );
  if (m && m[2] !== '_b' && m[2] !== '_h' && m[2] !== '_k')
    return [`${m[1]}_b.jpg`, src];
  return [src];
};

const localNameOf = (sub, src) => {
  const base = decodeURIComponent(new URL(src).pathname.split('/').pop());
  const safe = base.replace(/[^A-Za-z0-9._-]/g, '_');
  return `hatena-${sub}-${safe}`;
};

// Gyazo は不正アクセスの件で過去画像が配信停止になっていて、
// ログインした本人のブラウザからしか取れない。ブラウザで
// { "<i.gyazo.com の URL>": { type, data: <base64> } } の JSON に
// まとめて落とし、--gyazo-json で渡す
const GYAZO = (() => {
  const file = argValue('--gyazo-json');
  return file ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
})();

const fetchCached = async (url) => {
  if (GYAZO[url]) return Buffer.from(GYAZO[url].data, 'base64');
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const key = path.join(CACHE_DIR, encodeURIComponent(url));
  if (fs.existsSync(key)) return fs.readFileSync(key);
  if (fs.existsSync(`${key}.fail`)) return null;
  if (OFFLINE) return null;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const type = res.headers.get('content-type') ?? '';
    if (!res.ok || !type.startsWith('image/')) {
      fs.writeFileSync(`${key}.fail`, `${res.status} ${type}`);
      return null;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(key, buf);
    return buf;
  } catch (e) {
    fs.writeFileSync(`${key}.fail`, String(e));
    return null;
  }
};

const report = { downloaded: [], failed: [], lost: 0, dropped: new Map() };

// src → 取り込んだファイル名（取れなければ null）
const importImage = async (sub, src) => {
  const name = localNameOf(sub, src);
  const dest = path.join(IMAGE_DIR, name);
  if (fs.existsSync(dest)) return name;
  for (const url of candidateUrls(src)) {
    const buf = await fetchCached(url);
    if (buf) {
      fs.writeFileSync(dest, buf);
      report.downloaded.push(name);
      return name;
    }
  }
  report.failed.push(src);
  return null;
};

// ---------------------------------------------------------------------------
// HTML → Markdown

const hostOf = (url) => {
  try {
    return new URL(url, 'https://example.com').host;
  } catch {
    return '';
  }
};

// 3 ブログ間の内部リンクを新しい URL に書き換える
// blog は独自ドメインにする前の mizuka123.hatenablog.com でも貼られている。
// 元の href に HTML が紛れ込んでいる記事がある（Amazon のリンク作成ツールの
// 貼り間違い）ので、" 以降は捨てる
const rewriteHref = (raw) => {
  const href = raw?.split('"')[0];
  const m = href?.match(
    /^https?:\/\/(blog|tech|money|mizuka123)\.(?:mizuka123\.net|hatenablog\.com)\/entry\/(\d{4}\/\d{2}\/\d{2}\/\d{6})\/?(#.*)?$/
  );
  if (m) {
    const sub = m[1] === 'mizuka123' ? 'blog' : m[1];
    return `https://mizuka123.net/archive/${slugOf(sub, m[2])}/${m[3] ?? ''}`;
  }
  if (/^https?:\/\/mizuka123\.hatenablog\.com\/?$/.test(href))
    return 'https://mizuka123.net/archive/';
  return href;
};

// hatenablog-parts の埋め込みカードは中身の URL を src の url= に持っている
const embedTarget = (src) => {
  try {
    return new URL(src, 'https:').searchParams.get('url');
  } catch {
    return null;
  }
};

const text = (node) => (node.textContent ?? '').replace(/\s+/g, ' ').trim();
const mdLink = (label, href) =>
  `[${label.replace(/([[\]])/g, '\\$1')}](${href})`;

const createTurndown = (images) => {
  const td = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    emDelimiter: '*',
  });
  td.keep(['table']);
  // addRule は後から足した規則ほど優先される（先頭に積まれる）。
  // リンクの規則は商品カードなどの枠の内側にも当たるので、
  // 枠の規則に負けるよう最初に足しておく
  // 画像だけを包むリンク（Flickr の写真ページ・フォトライフ・zenphoto など）は外す。
  // 中身が空になったリンク（広告バナーを捨てた跡）も消える
  td.addRule('link', {
    filter: (n) => n.nodeName === 'A' && n.getAttribute('href'),
    replacement: (content, n) => {
      // はてなキーワードへの自動リンクは本文の一部なので、文字だけ残す
      if (n.classList.contains('keyword')) return content;
      const onlyImages = n.querySelectorAll('img').length > 0 && !text(n);
      if (onlyImages || !content.trim()) return content;
      return mdLink(content, rewriteHref(n.getAttribute('href')));
    },
  });

  // Amazon・楽天の商品カード（はてなの ASIN 記法）→ 商品名のリンク 1 行
  td.addRule('asin-detail', {
    filter: (n) =>
      n.nodeName === 'DIV' && n.classList.contains('hatena-asin-detail'),
    replacement: (_c, n) => {
      const a =
        n.querySelector('.hatena-asin-detail-title a') ?? n.querySelector('a');
      return a ? `\n\n${mdLink(text(a), a.getAttribute('href'))}\n\n` : '';
    },
  });

  // カエレバ・ヨメレバ → 商品名のリンク 1 行
  td.addRule('kaereba', {
    filter: (n) =>
      n.nodeName === 'DIV' &&
      (n.classList.contains('kaerebalink-box') ||
        n.classList.contains('booklink-box')),
    replacement: (_c, n) => {
      const a = n.querySelector('.kaerebalink-name a, .booklink-name a');
      return a ? `\n\n${mdLink(text(a), a.getAttribute('href'))}\n\n` : '';
    },
  });

  // App Store の埋め込み → アプリ名のリンク 1 行
  td.addRule('itunes-embed', {
    filter: (n) => n.nodeName === 'DIV' && n.classList.contains('itunes-embed'),
    replacement: (_c, n) => {
      const a =
        n.querySelector('.itunes-embed-title a') ?? n.querySelector('a');
      return a ? `\n\n${mdLink(text(a), a.getAttribute('href'))}\n\n` : '';
    },
  });

  // 関連記事の枠 → 記事名のリンク 1 行
  td.addRule('intro-article', {
    filter: (n) =>
      n.nodeName === 'DIV' && n.classList.contains('intro-article-wrapper'),
    replacement: (_c, n) => {
      const a = n.querySelector('a.intro-article-title');
      return a
        ? `\n\n${mdLink(text(a), rewriteHref(a.getAttribute('href')))}\n\n`
        : '';
    },
  });

  // 埋め込みカード（iframe）→ リンク。見出しは title 属性、無ければ URL
  td.addRule('embed-card', {
    filter: (n) => n.nodeName === 'IFRAME',
    replacement: (_c, n) => {
      const src = n.getAttribute('src') ?? '';
      if (/youtube\.com\/embed\//.test(src)) {
        const id = src.match(/embed\/([\w-]+)/)?.[1];
        return id
          ? `\n\n${mdLink('YouTube', `https://www.youtube.com/watch?v=${id}`)}\n\n`
          : '';
      }
      const url = embedTarget(src);
      if (!url) return '';
      const label = n.getAttribute('title') || url;
      return `\n\n${mdLink(label, rewriteHref(url))}\n\n`;
    },
  });

  // 埋め込みカードに付く出典表示（「github.com」だけのリンク）は捨てる
  td.addRule('hatena-citation', {
    filter: (n) =>
      n.nodeName === 'CITE' && n.classList.contains('hatena-citation'),
    replacement: () => '',
  });

  td.addRule('code', {
    filter: (n) => n.nodeName === 'PRE' && n.classList.contains('code'),
    replacement: (_c, n) => {
      const lang = n.getAttribute('data-lang') ?? '';
      return `\n\n\`\`\`${lang}\n${n.textContent.replace(/\n$/, '')}\n\`\`\`\n\n`;
    },
  });

  td.addRule('image', {
    filter: 'img',
    replacement: (_c, n) => {
      const src = n.getAttribute('src') ?? '';
      const info = images.get(src);
      if (!info) return '';
      if (!info.name) return `\n\n${LOST_IMAGE}\n\n`;
      // 画像の URL・フォトライフの記法（f:id:...）・「Image from Gyazo」は
      // ツールが自動で入れた値で、説明になっていないので空にする。
      // ファイル名（4X3A4962.jpg など）は既存のアーカイブ記事に合わせて残す
      const rawAlt = (n.getAttribute('alt') ?? '').replace(/[[\]]/g, '');
      const alt = /^(https?:\/\/|f:id:|Image from Gyazo$)/.test(rawAlt)
        ? ''
        : rawAlt;
      return `![${alt}](/archive/images/${info.name})`;
    },
  });

  return td;
};

// 「画像は失われました」が続く箇所は 1 つにまとめる
const collapseLost = (md) =>
  md.replace(
    new RegExp(
      `(${LOST_IMAGE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*){2,}`,
      'g'
    ),
    `${LOST_IMAGE}\n\n`
  );

const decodeEntities = (s) =>
  s
    .replace(/&#(\d+);/g, (_m, d) => String.fromCharCode(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

const yamlString = (s) => `'${s.replace(/'/g, "''")}'`;

// ---------------------------------------------------------------------------

const main = async () => {
  const written = [];
  for (const sub of SUBS) {
    const file = path.join(EXPORT_DIR, `${sub}.mizuka123.net.export.txt`);
    const entries = parseExport(fs.readFileSync(file, 'utf8')).filter(
      (e) => e.STATUS === 'Publish'
    );

    for (const entry of entries) {
      const slug = slugOf(sub, entry.BASENAME);
      // 最後の <li> を閉じ忘れたまま空行と見出しが続く記事がある
      // （blog-20160308-220531）。そのままだと後ろの見出しと段落が
      // リスト項目の中に入るので、見出しの手前でリストを閉じる
      const body = (entry.BODY ?? '').replace(
        /(<li>(?:(?!<\/li>|<li>)[\s\S])*?)\n\n(?=<h[1-6]>)/g,
        '$1</li></ul>\n\n'
      );

      // 本文の画像を先に集めて取り込んでおく（turndown の規則は同期なので）
      const images = new Map();
      // turndown 側は DOM の getAttribute で読むので、実体参照を戻して鍵を揃える
      // （zenphoto の URL は &amp; を含む）
      for (const [, raw] of body.matchAll(/<img[^>]*?\ssrc="([^"]+)"/g)) {
        const src = decodeEntities(raw);
        if (images.has(src)) continue;
        const kind = imageKind(src);
        if (kind === 'drop') {
          const host = hostOf(src);
          report.dropped.set(host, (report.dropped.get(host) ?? 0) + 1);
          continue;
        }
        if (kind === 'lost') {
          report.lost++;
          images.set(src, { name: null });
          continue;
        }
        images.set(src, { name: await importImage(sub, src) });
      }

      const td = createTurndown(images);
      // 目次のページ内リンクは元の見出しの大文字を残しているが、
      // Astro が振る見出しの id は小文字になるので合わせる
      const markdown = collapseLost(td.turndown(body))
        .replace(/\]\((#[^)]+)\)/g, (_m, hash) => `](${hash.toLowerCase()})`)
        .replace(/\n{3,}/g, '\n\n')
        .trim();

      const mapped = entry.CATEGORY.map((c) => {
        const m = CATEGORY_MAP[sub][c];
        if (!m) throw new Error(`カテゴリーの対応が無い: ${sub} ${c}`);
        return m;
      });
      const categories = [...new Set(mapped.flatMap((m) => m.categories))];
      const tags = [...new Set(mapped.flatMap((m) => m.tags))];

      // アイキャッチ（IMAGE）が本文の取り込んだ画像と同じならそれを、
      // 違えば本文の最初の取り込み画像をカバーにする
      const cover =
        (entry.IMAGE && images.get(entry.IMAGE)?.name) ??
        [...images.values()].find((i) => i.name)?.name;

      const [mm, dd, yyyy] = entry.DATE.split(' ')[0].split('/');
      const frontmatter = [
        '---',
        'layout: ../../layouts/LayoutMd.astro',
        `title: ${yamlString(entry.TITLE)}`,
        `date: '${yyyy}-${mm}-${dd}'`,
        'categories:',
        ...categories.map((c) => `  - ${yamlString(c)}`),
        ...(tags.length
          ? ['tags:', ...tags.map((t) => `  - ${yamlString(t)}`)]
          : []),
        ...(cover ? [`coverImage: ${yamlString(cover)}`] : []),
        '---',
      ].join('\n');

      const out = path.join(ARCHIVE_DIR, `${slug}.md`);
      fs.writeFileSync(out, `${frontmatter}\n\n${markdown}\n`);
      written.push(path.relative(ROOT, out));
    }
  }

  console.log(`記事: ${written.length} 件`);
  console.log(
    `画像: 取り込み ${report.downloaded.length} / 取れず ${report.failed.length} / zenphoto ${report.lost}`
  );
  console.log('捨てた画像（ホスト別）:', Object.fromEntries(report.dropped));
  if (report.failed.length)
    console.log('取れなかった画像:\n' + report.failed.join('\n'));
};

await main();
