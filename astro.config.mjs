import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'astro/config';
import icon from 'astro-icon';
import { CUSTOM_DOMAIN, BASE_PATH } from './src/server-constants';
import { stripBasePath } from './src/lib/blog-helpers';
import CoverImageDownloader from './src/integrations/cover-image-downloader';
import CustomIconDownloader from './src/integrations/custom-icon-downloader';
import FeaturedImageDownloader from './src/integrations/featured-image-downloader';
import FileIconDownloader from './src/integrations/file-icon-downloader';
import OgImageGenerator from './src/integrations/og-image-generator';
import PublicNotionCopier from './src/integrations/public-notion-copier';
import rehypeArchiveHeadings from './src/lib/rehype-archive-headings';
import rehypeImageDimensions from './src/lib/rehype-image-dimensions';
import remarkArchiveDescription from './src/lib/remark-archive-description';
import rehypeLazyImages from './src/lib/rehype-lazy-images';
import rehypeProductBox from './src/lib/rehype-product-box';
import sitemap from '@astrojs/sitemap';

/*
 * sitemap に載せないページ。
 *
 * これまで sitemap() は無指定で、出力された 643 ページのうち 642 件
 * （sitemap が元から外す 404.html を除く全部）が載っていた。今回
 * /category/ と /tag/ を 299 ページ増やすが、そのうち 186 ページ
 * （カテゴリー pc-web の 1 件 + タグ 185 件）には noindex を出している。
 * 「インデックスするな」と書いたページを sitemap で「インデックスしろ」と
 * 差し出すのは自己矛盾で、Google は sitemap 全体の信頼度を下げる。
 *
 * 判定は «出来上がった HTML に noindex が入っているか» で行う。
 * どのページを noindex にするかは src/lib/archive-taxonomy.ts が決めていて
 * （記事数が INDEX_MIN_POSTS 未満か、記事集合が他のタクソノミーと完全一致
 * するか）、ページ側はその結果を noindex として出しているだけ。
 * ここで同じ条件をもう一度書くと、条件を足したときに «noindex なのに
 * sitemap に載る» 食い違いが生まれる。出力を見れば食い違いようがない。
 *
 * ここで frontmatter を読み直さないのには別の理由もある。astro.config.mjs は
 * Markdown プラグインが入る前に評価されるため、この文脈で
 * import.meta.glob('src/pages/archive/*.md') を実行すると .md の解析に
 * 失敗して設定の読み込みごと落ちる（実際に落ちた）。
 *
 * @astrojs/sitemap の filter は astro:build:done、つまり全ページを
 * 書き出した後に呼ばれるので、この時点で dist の HTML は揃っている。
 *
 * この «出力を読む» 作りのせいで、integrations の並びに制約がある。
 * astro:build:done で dist の HTML を «後加工する» インテグレーションを
 * 下の sitemap() より «後ろ» に足さないこと。Astro は build:done を
 * integrations の登録順に呼ぶので、後ろに置いたものが noindex の meta を
 * 足したり消したりしても、sitemap はもう判定を終えている。
 * 現在 build:done を持つのは src/integrations/public-notion-copier.ts だけで
 * （実測、src 配下の build:done は 1 件）、書き込み先が dist/notion 配下に
 * 閉じている＝ページの HTML を触らないので、sitemap() より前にある今の
 * 並びでも後ろでも結果は変わらない。無害なのは «たまたま» ではなく
 * 書き込み範囲が閉じているからで、そこが変わったら並びも見直すこと
 */
// outDir は下の defineConfig で指定していない＝既定の ./dist。
// もし outDir を変えるなら、ここも合わせること
const DIST_DIR = fileURLToPath(new URL('./dist', import.meta.url));

// robots の meta は SiteHead.astro が <head> のほぼ先頭に出す。
// 全文を読むと 900 ページ分の HTML（数十 MB）をビルドの最後に
// 読み込むことになるので、先頭だけで足りる大きさに切る
const HEAD_BYTES = 4096;

const hasNoindexMeta = (filePath) => {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(HEAD_BYTES);
    const read = fs.readSync(fd, buffer, 0, HEAD_BYTES, 0);
    // content の «一部に» noindex があれば拾う。以前は content="noindex" と
    // 完全一致で見ていたが、それは src/components/SiteHead.astro が今ちょうど
    // その 1 語だけを出しているから通っていただけで、'noindex, follow' のような
    // «robots の書式として普通の» 追記をした瞬間にどのページもマッチしなくなり、
    // 183 ページが無言で sitemap に戻る（ビルドも lint も通ってしまう）。
    // SiteHead.astro 側の meta の直前にも、この正規表現の存在を注記してある。
    //
    // name と content を先読みで別々に見ているのは、属性の «順序» に
    // 依存しないため。name="robots" が content より前に来ることを当てに
    // すると、SiteHead.astro 側で属性を並べ替えただけで（出力する値は
    // 何も変えていないのに）186 ページが無言で sitemap に戻る
    return /<meta(?=[^>]*name="robots")[^>]*content="[^"]*noindex/.test(
      buffer.toString('utf8', 0, read)
    );
  } catch {
    // 読めなかったページは «載せる» 側に倒す。sitemap から取りこぼすと
    // 新しいページが発見されなくなるのに対し、余分に載っているだけなら
    // ページ側の noindex が効いて実害が出ない
    return false;
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
  }
};

const isIndexablePage = (page) => {
  let pathname;
  try {
    // filter に渡るのは site を含む絶対 URL。日本語スラッグは
    // %E6%B0%B4... の形で来るので、実ファイル名に戻してから突き合わせる
    pathname = decodeURIComponent(new URL(page).pathname);
  } catch {
    return true;
  }

  // BASE_PATH は URL には入るが dist の中には入らないので剥がす。
  // build.format は未指定＝既定の 'directory' なので、/category/gadget/ は
  // dist/category/gadget/index.html に対応する
  const relative = stripBasePath(pathname).replace(/^\/+/, '');
  const filePath = path.join(DIST_DIR, relative, 'index.html');

  return !hasNoindexMeta(filePath);
};

const getSite = function () {
  if (CUSTOM_DOMAIN) {
    return new URL(BASE_PATH, `https://${CUSTOM_DOMAIN}`).toString();
  }
  if (process.env.VERCEL && process.env.VERCEL_URL) {
    return new URL(BASE_PATH, `https://${process.env.VERCEL_URL}`).toString();
  }
  if (process.env.CF_PAGES) {
    if (process.env.CF_PAGES_BRANCH !== 'main') {
      return new URL(BASE_PATH, process.env.CF_PAGES_URL).toString();
    }
    return new URL(
      BASE_PATH,
      `https://${new URL(process.env.CF_PAGES_URL).host
        .split('.')
        .slice(1)
        .join('.')}`
    ).toString();
  }

  return new URL(BASE_PATH, 'http://localhost:4321').toString();
};

// https://astro.build/config
export default defineConfig({
  site: getSite(),
  base: BASE_PATH,
  markdown: {
    // カエレバの商品ボックスがばらけた <p> のままだと、
    // 自動広告が商品名と購入リンクの間に入る。1 つの要素にまとめる。
    // そのうえで自前の画像に loading="lazy" と width/height を付ける。
    // rehypeProductBox は <p> を <div> で包み直すだけで画像の順序を
    // 変えないため、3 つの順序はどれでも結果は同じ。
    // rehypeArchiveHeadings は見出しのタグ名しか触らず、他の 3 つは
    // <p> と <img> しか触らないので、これもどこに置いても結果は変わらない
    rehypePlugins: [
      rehypeProductBox,
      rehypeLazyImages,
      rehypeImageDimensions,
      rehypeArchiveHeadings,
    ],
    // 本文から meta description を作る。frontmatter に description の
    // 項目が無いため、remark 側で file.data.astro.frontmatter に書き込む
    remarkPlugins: [remarkArchiveDescription],
  },
  integrations: [
    icon(),
    CoverImageDownloader(),
    CustomIconDownloader(),
    FeaturedImageDownloader(),
    // FeaturedImageDownloader の後であること。落としたファイルを読んで
    // OGP 用の 1200x630 を作る
    OgImageGenerator(),
    FileIconDownloader(),
    PublicNotionCopier(),
    sitemap({ filter: isIndexablePage }),
  ],
});
