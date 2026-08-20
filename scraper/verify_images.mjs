#!/usr/bin/env node
/**
 * verify_images.mjs — カード画像 URL の到達性を検証（BUILD_SPEC §10）
 *
 * 全カードの 5% をランダムサンプリングして HEAD リクエストで 200 を確認する。
 * 画像は保存しない（§5: 公開Webサイトからの配信はしない）。
 * リクエスト間 1.2s スリープ / 直列。
 *
 * 使い方: node scraper/verify_images.mjs [--ratio 0.05] [--fast]
 *   --fast : スリープを 300ms に短縮（検収時のみ。通常運用では使わない）
 */
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const UA = 'LorcanaFanDB/0.1 (unofficial fan database; image availability check)';
const DATA = path.join(import.meta.dirname, 'data');
const argv = process.argv.slice(2);
const RATIO = argv.includes('--ratio') ? Number(argv[argv.indexOf('--ratio') + 1]) : 0.05;
const DELAY = argv.includes('--fast') ? 300 : 1200;

const cards = fs
  .readFileSync(path.join(DATA, 'cards.jsonl'), 'utf8')
  .split('\n')
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l));

// 決定的なサンプリング（n 件ごとに 1 件）で全セットを均等にカバー
const step = Math.max(Math.round(1 / RATIO), 1);
const sample = cards.filter((_, i) => i % step === 0);

console.log(`全 ${cards.length} 枚から ${sample.length} 枚（${((sample.length / cards.length) * 100).toFixed(1)}%）を検証`);
console.log(`リクエスト間隔: ${DELAY}ms\n`);

const IMG = 'https://www.takaratomy.co.jp/products/disneylorcana/cardlist/img/card';
const failures = [];
let ok = 0;

for (let i = 0; i < sample.length; i++) {
  const c = sample[i];
  const url = `${IMG}/${c.card_file}.png`;
  try {
    const r = await fetch(url, { method: 'HEAD', headers: { 'User-Agent': UA } });
    if (r.status === 200) {
      ok++;
    } else {
      failures.push({ card_file: c.card_file, status: r.status });
      console.log(`  ✗ ${r.status} ${c.card_file}`);
    }
  } catch (e) {
    failures.push({ card_file: c.card_file, error: String(e.message) });
    console.log(`  ! ERR ${c.card_file}: ${e.message}`);
  }
  if ((i + 1) % 25 === 0) console.log(`  … ${i + 1}/${sample.length} (OK ${ok})`);
  if (i < sample.length - 1) await sleep(DELAY);
}

console.log(`\n=== 結果 ===`);
console.log(`検証: ${sample.length} 枚`);
console.log(`200 : ${ok} 枚`);
console.log(`失敗: ${failures.length} 枚`);
console.log(failures.length === 0 ? '✅ すべて到達可能' : `⚠️ ${failures.length} 件が失敗`);

fs.writeFileSync(
  path.join(DATA, 'image_verify_report.json'),
  JSON.stringify({ checked_at: new Date().toISOString(), total: cards.length, sampled: sample.length, ok, failures }, null, 2)
);

process.exit(failures.length === 0 ? 0 : 1);
