const fs = require('fs');
const { setTimeout } = require('timers/promises');
const { Client } = require('@notionhq/client');

const notion = new Client({
  auth: process.env.NOTION_API_SECRET,
  notionVersion: '2026-03-11',
});

const requestDuration = 300;

const retry = (maxRetries, fn) => {
  return fn().catch(function (err) {
    if (maxRetries <= 0) {
      throw err;
    }
    return retry(maxRetries - 1, fn);
  });
};

const retrieveAndWriteBlockChildren = async (blockId) => {
  const params = { block_id: blockId };

  let results = [];

  while (true) {
    // For Notion API Requests limits
    // See https://developers.notion.com/reference/request-limits
    await setTimeout(requestDuration);

    const res = await retry(3, () => notion.blocks.children.list(params));

    results = results.concat(res.results);

    if (!res.has_more) {
      break;
    }

    params['start_cursor'] = res.next_cursor;
  }

  fs.writeFileSync(`tmp/${blockId}.json`, JSON.stringify(results));

  // forEach(async ...) だと await されず、この関数が子や synced_block の
  // 取得を待たずに返ってしまう（キャッシュが未完成のまま「完了」する）。
  // さらに下の throw は未処理の rejection になり、終了コードに出ない。
  // 直列の for...of にする。各呼び出しの中で API のレート制限のために
  // sleep しているので、並列化せず順に回すのが正しい
  for (const block of results) {
    if (
      block.type === 'synced_block' &&
      block.synced_block.synced_from &&
      block.synced_block.synced_from.block_id
    ) {
      try {
        await retrieveAndWriteBlock(block.synced_block.synced_from.block_id);
      } catch (err) {
        console.error(
          `Could not retrieve the original synced_block. block_id: ${block.id}, synced_from: ${block.synced_block.synced_from.block_id}`
        );
        console.error(err);
        throw err;
      }
    } else if (block.has_children) {
      await retrieveAndWriteBlockChildren(block.id);
    }
  }
};

const retrieveAndWriteBlock = async (blockId) => {
  const params = { block_id: blockId };

  // For Notion API Requests limits
  // See https://developers.notion.com/reference/request-limits
  await setTimeout(requestDuration);

  const block = await retry(3, () => notion.blocks.retrieve(params));

  fs.writeFileSync(`tmp/${blockId}.json`, JSON.stringify(block));

  if (block.has_children) {
    await retrieveAndWriteBlockChildren(block.id);
  }
};

(async () => {
  const blockId = process.argv[2];
  await retrieveAndWriteBlockChildren(blockId);
})().catch((err) => {
  // 取得に失敗したままキャッシュが不完全な状態で「成功」として扱われると、
  // その後のビルドが古い内容や欠けた内容で通ってしまう
  console.error(`Failed to cache block children. block_id: ${process.argv[2]}`);
  console.error(err);
  process.exit(1);
});
