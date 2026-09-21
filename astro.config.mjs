import { defineConfig } from 'astro/config';
import icon from 'astro-icon';
import { CUSTOM_DOMAIN, BASE_PATH } from './src/server-constants';
import CoverImageDownloader from './src/integrations/cover-image-downloader';
import CustomIconDownloader from './src/integrations/custom-icon-downloader';
import FeaturedImageDownloader from './src/integrations/featured-image-downloader';
import FileIconDownloader from './src/integrations/file-icon-downloader';
import OgImageGenerator from './src/integrations/og-image-generator';
import PublicNotionCopier from './src/integrations/public-notion-copier';
import rehypeLazyImages from './src/lib/rehype-lazy-images';
import rehypeProductBox from './src/lib/rehype-product-box';
import sitemap from '@astrojs/sitemap';
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
    // そのうえで自前の画像に loading="lazy" を付ける。
    // rehypeProductBox は <p> を <div> で包み直すだけで画像の順序を
    // 変えないため、2 つの順序はどちらでも結果は同じ
    rehypePlugins: [rehypeProductBox, rehypeLazyImages],
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
    sitemap(),
  ],
});
