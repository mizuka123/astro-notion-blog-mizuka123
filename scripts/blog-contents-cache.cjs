const { exec } = require('child_process');
const { Client } = require('@notionhq/client');
const cliProgress = require('cli-progress');
const { PromisePool } = require('@supercharge/promise-pool');

const notion = new Client({
  auth: process.env.NOTION_API_SECRET,
  notionVersion: '2026-03-11',
});

const getAllPages = async () => {
  const dbResponse = await notion.databases.retrieve({
    database_id: process.env.DATABASE_ID,
  });
  if (!dbResponse) {
    throw new Error('Failed to retrieve database information');
  }

  const dataSourceId =
    dbResponse.data_sources && dbResponse.data_sources.length > 0
      ? dbResponse.data_sources[0].id
      : null;
  if (!dataSourceId) {
    throw new Error('Database does not have a data source ID');
  }

  const params = {
    data_source_id: dataSourceId,
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
  };

  let results = [];
  while (true) {
    const res = await notion.dataSources.query(params);

    results = results.concat(res.results);

    if (!res.has_more) {
      break;
    }

    params['start_cursor'] = res.next_cursor;
  }

  const pages = results.map((result) => {
    return {
      id: result.id,
      last_edited_time: result.last_edited_time,
      slug: result.properties.Slug.rich_text
        ? result.properties.Slug.rich_text[0].plain_text
        : '',
    };
  });

  return pages;
};

(async () => {
  const pages = await getAllPages();

  const concurrency = parseInt(process.env.CACHE_CONCURRENCY || '1', 10);

  const progressBar = new cliProgress.SingleBar(
    { stopOnComplete: true },
    cliProgress.Presets.shades_classic
  );
  progressBar.start(pages.length, 0);

  const failures = [];

  await PromisePool.withConcurrency(concurrency)
    .for(pages)
    .process(async (page) => {
      return new Promise((resolve) => {
        const command = `NX_BRANCH=main npx nx run astro-notion-blog:_fetch-notion-blocks ${page.id} ${page.last_edited_time}`;
        const options = { timeout: 60000 };

        exec(command, options, (err, stdout, stderr) => {
          if (err) {
            // 以前はここでログを出すだけで常に resolve しており、失敗した
            // ページも「処理済み」として数えられていた。終了コードにも
            // 出ないため、キャッシュが欠けたまま気づけなかった
            failures.push({ page, err, stderr });
          }
          progressBar.increment();
          return resolve();
        });
      });
    });

  progressBar.stop();

  if (failures.length > 0) {
    console.error(
      `Failed to cache ${failures.length} of ${pages.length} page(s):`
    );
    for (const { page, err, stderr } of failures) {
      console.error(`  - id: ${page.id}, slug: ${page.slug}`);
      console.error(`    ${err}`);
      if (stderr) {
        console.error(`    stderr: ${String(stderr).trim().slice(0, 500)}`);
      }
    }
    // 不完全なキャッシュで後続のビルドを通さない
    process.exit(1);
  }
})().catch((err) => {
  console.error('Failed to build the blog contents cache.');
  console.error(err);
  process.exit(1);
});
