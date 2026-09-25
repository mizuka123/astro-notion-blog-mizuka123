// アーカイブ記事の画像の幅違い（640w / 1024w）を作る（#134）。
//
//   node scripts/generate-archive-image-variants.mjs [--dry-run] [--report <path>]
//
// 一度だけ実行して、できたファイルをコミットするためのもの（ビルドでは呼ばない）。
// ビルドのたびに作ると毎回数分延びるうえ、アーカイブ記事はもう増えないので
// 一度作れば作り直しは要らない。手順を残すためにコミットしてある。
// 作ったファイルは src/lib/rehype-archive-srcset.ts が srcset に載せる。
//
// 対象は «アーカイブ記事の markdown の画像（![](...)）が参照している» 画像だけ。
// 参照を集める方法は src/lib/remark-archive-images.ts の collect に揃えて
// ある（mdast の image ノード）。どこからも参照されていないファイル（#129）
// には作らない。生 HTML の <img> は srcset を付ける経路（rehype）から見えない
// ので対象外（該当する 13 個はどれも幅 160px 以下で、元から作る大きさでもない）。
//
// エンコードの基準は #84 / #85 と src/lib/notion/resize-image.ts（#128）に揃える:
//   - rotate() で EXIF の向きを画素に反映する。幅の判定も表示上の幅で行う
//   - JPEG は mozjpeg の品質 85、PNG は compressionLevel 9
//   - sRGB 以外の ICC プロファイルは保持し、sRGB のプロファイルは落とす
//   - CMYK は作らない（sRGB に変換されて色が変わりうる。元だけを配信する）
//   - GIF・SVG・WebP・複数フレームは対象外（JPEG と PNG だけ）
//   - 縮小版が元より大きくなるなら作らない（元を配信した方が軽い）
//   - 一時ファイルに書いてから rename する
// 形式は元と同じ（JPEG は JPEG、PNG は PNG）。WebP / AVIF はこの Issue の範囲外。
//
// 既にある版は作り直さない（途中で止まっても続きから再開できる。
// 再エンコードを重ねて劣化することもない）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
// 以下の 2 つは .ts を Node の型の除去で直接読む（Node 22.18 以降は既定で有効）
import {
  ARCHIVE_IMAGE_VARIANT_WIDTHS,
  archiveImageVariantName,
  isArchiveImageVariantName,
} from '../src/lib/archive-image-variants.ts';
import { iccDescription } from '../src/lib/notion/resize-image.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARCHIVE_DIR = path.join(ROOT, 'src/pages/archive');
const IMAGE_DIR = path.join(ROOT, 'public/archive/images');
// src/lib/archive-image-file.ts の ARCHIVE_IMAGE_URL_PREFIX と同じ
const IMAGE_URL_PREFIX = '/archive/images/';

const JPEG_QUALITY = 85;
const PNG_COMPRESSION_LEVEL = 9;
// sharp は 1 枚の処理の中でも libvips のスレッドを使うので、並べすぎない
const CONCURRENCY = Math.max(1, Math.min(4, os.availableParallelism() - 1));

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const reportIndex = args.indexOf('--report');
const reportPath = reportIndex >= 0 ? args[reportIndex + 1] : null;

/** URL から public/archive/images/ の下のファイル名を返す（archiveImageName と同じ規則） */
const imageNameFromUrl = (url) => {
  if (typeof url !== 'string' || !url.startsWith(IMAGE_URL_PREFIX)) {
    return null;
  }
  let name;
  try {
    // %2B（+）を含む参照があるのでデコードする
    name = decodeURIComponent(url.slice(IMAGE_URL_PREFIX.length));
  } catch {
    return null;
  }
  if (!name || name.includes('/') || name.includes('\\') || name === '..') {
    return null;
  }
  return name;
};

/** アーカイブ記事の markdown の画像が参照しているファイル名の集合 */
const collectReferencedImages = () => {
  const processor = unified().use(remarkParse).use(remarkGfm);
  const names = new Set();
  let references = 0;
  for (const file of fs.readdirSync(ARCHIVE_DIR)) {
    if (!file.endsWith('.md')) continue;
    // frontmatter は画像ノードを含まないが、本文と混ぜないよう先に外す
    const source = fs
      .readFileSync(path.join(ARCHIVE_DIR, file), 'utf8')
      .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
    const tree = processor.runSync(processor.parse(source));
    const definitions = new Map();
    const urls = [];
    const refs = [];
    const walk = (node) => {
      if (node.type === 'image') urls.push(node.url);
      if (node.type === 'imageReference') refs.push(node.identifier);
      if (node.type === 'definition') {
        definitions.set(node.identifier, node.url);
      }
      for (const child of node.children ?? []) walk(child);
    };
    walk(tree);
    for (const ref of refs) urls.push(definitions.get(ref));
    for (const url of urls) {
      const name = imageNameFromUrl(url);
      if (name === null) continue;
      references++;
      names.add(name);
    }
  }
  return { names: [...names].sort(), references };
};

/**
 * 幅違いのファイル名が、既存のファイル（元の画像）や他の版と衝突しないことを
 * 確かめる。Windows と macOS の既定のファイルシステムは大文字小文字を
 * 区別しないので、小文字にして比べる
 */
const checkCollisions = (targets) => {
  const originals = new Set(
    fs
      .readdirSync(IMAGE_DIR)
      .filter((name) => !isArchiveImageVariantName(name))
      .map((name) => name.toLowerCase())
  );
  const problems = [];
  const variants = new Map();
  for (const name of targets) {
    if (isArchiveImageVariantName(name)) {
      problems.push(`an original already looks like a variant: ${name}`);
    }
    for (const width of ARCHIVE_IMAGE_VARIANT_WIDTHS) {
      const variant = archiveImageVariantName(name, width);
      if (variant === null) {
        problems.push(`no extension: ${name}`);
        continue;
      }
      const key = variant.toLowerCase();
      if (originals.has(key)) {
        problems.push(`collides with an existing file: ${variant}`);
      }
      if (variants.has(key)) {
        problems.push(`collides with ${variants.get(key)}: ${variant}`);
      }
      variants.set(key, variant);
    }
  }
  return { problems, checked: variants.size };
};

const isSrgbProfile = (icc) => /sRGB/i.test(iccDescription(icc) ?? '');

/** 1 枚の画像について、必要な幅の版を作る。結果を配列で返す */
const processImage = async (name) => {
  const filePath = path.join(IMAGE_DIR, name);
  let input;
  try {
    input = await fs.promises.readFile(filePath);
  } catch {
    return [{ name, status: 'missing' }];
  }
  const metadata = await sharp(input).metadata();
  // EXIF の向きが 5〜8 なら表示では縦横が入れ替わる。表示上の幅で判定する
  const swapsAxes = (metadata.orientation ?? 1) >= 5;
  const displayWidth = swapsAxes ? metadata.height : metadata.width;
  const base = {
    name,
    format: metadata.format,
    space: metadata.space,
    orientation: metadata.orientation ?? 1,
    icc: metadata.icc ? (iccDescription(metadata.icc) ?? '(unreadable)') : null,
    displayWidth,
    bytes: input.length,
  };

  const widths = ARCHIVE_IMAGE_VARIANT_WIDTHS.filter((w) => displayWidth > w);
  if (widths.length === 0) {
    return [{ ...base, status: 'small' }];
  }
  if (!['jpeg', 'png'].includes(metadata.format ?? '')) {
    return [{ ...base, status: 'format' }];
  }
  if ((metadata.pages ?? 1) > 1) {
    return [{ ...base, status: 'animated' }];
  }
  if (metadata.space === 'cmyk') {
    return [{ ...base, status: 'cmyk' }];
  }

  const results = [];
  for (const width of widths) {
    const variant = archiveImageVariantName(name, width);
    const variantPath = path.join(IMAGE_DIR, variant);
    if (fs.existsSync(variantPath)) {
      results.push({
        ...base,
        width,
        variant,
        status: 'exists',
        variantBytes: fs.statSync(variantPath).size,
      });
      continue;
    }
    let image = sharp(input)
      .rotate()
      .resize({ width, withoutEnlargement: true });
    if (metadata.icc && !isSrgbProfile(metadata.icc)) {
      image = image.keepIccProfile();
    }
    image =
      metadata.format === 'jpeg'
        ? image.jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
        : image.png({ compressionLevel: PNG_COMPRESSION_LEVEL });
    const { data, info } = await image.toBuffer({ resolveWithObject: true });
    if (info.format !== metadata.format || info.width !== width) {
      throw new Error(
        `unexpected output for ${name}: ${info.format} ${info.width}x${info.height}`
      );
    }
    if (data.length >= input.length) {
      results.push({
        ...base,
        width,
        variant,
        status: 'larger',
        variantBytes: data.length,
      });
      continue;
    }
    if (!dryRun) {
      const tmp = `${variantPath}.tmp`;
      await fs.promises.writeFile(tmp, data);
      await fs.promises.rename(tmp, variantPath);
    }
    results.push({
      ...base,
      width,
      variant,
      status: dryRun ? 'would-create' : 'created',
      variantBytes: data.length,
    });
  }
  return results;
};

const main = async () => {
  const started = performance.now();
  const { names, references } = collectReferencedImages();
  console.log(
    `referenced: ${names.length} files (${references} references in markdown images)`
  );

  const { problems, checked } = checkCollisions(names);
  if (problems.length > 0) {
    for (const problem of problems) console.error(problem);
    throw new Error(`${problems.length} naming problems; nothing was written`);
  }
  console.log(`naming: ${checked} variant names, no collisions`);

  const results = [];
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < names.length) {
      const name = names[next++];
      results.push(...(await processImage(name)));
      if (++done % 500 === 0) console.log(`  ${done}/${names.length}`);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const summary = {};
  for (const r of results) {
    const key = r.width ? `${r.width}w ${r.status}` : r.status;
    summary[key] ??= { count: 0, bytes: 0 };
    summary[key].count++;
    summary[key].bytes += r.variantBytes ?? 0;
  }
  console.log(summary);
  console.log(`done in ${Math.round((performance.now() - started) / 1000)} s`);
  if (reportPath) {
    results.sort(
      (a, b) => a.name.localeCompare(b.name) || (a.width ?? 0) - (b.width ?? 0)
    );
    fs.writeFileSync(reportPath, JSON.stringify({ summary, results }, null, 2));
  }
};

await main();
