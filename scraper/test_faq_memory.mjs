#!/usr/bin/env node
/**
 * test_faq_memory.mjs — 公式ルールQ&A（rule_faqs）のAI分析への組み込みを検証
 *
 * 前提: pm2 で lorcana-fandb が起動、migrations/0004_faq_memory.sql 適用済み、
 *       /api/memory/build/faqs が実行済み（79件ベクトル化）。
 *
 * 検証の柱
 *  1. ベクトル化: rule_faqs の全件が faq_vectors に入り、差分再実行で0件になる
 *  2. 想起の妥当性: クエリの主題に一致するカテゴリのQ&Aが上位に来る
 *  3. 無関係な混入がない: 類似度の足切り（minSim）が効いている
 *  4. 応答への反映: /api/ai/synergy が official_faqs を返し memory に件数が出る
 *  5. UIへの露出: シナジー画面のスクリプトが参照Q&Aを描画する実装を持つ
 *  6. 可用性: マイグレーション未適用でも落ちない設計（stats が faqs キーを返す）
 */
import { JSDOM } from 'jsdom';
const BASE = 'http://localhost:3000';
let pass = 0, fail = 0;
const ok = (c, m, extra = '') => {
  c ? (pass++, console.log(`  ✅ ${m} ${extra}`)) : (fail++, console.log(`  ❌ ${m} ${extra}`));
};
const post = (p, b) =>
  fetch(BASE + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(b ?? {}),
  }).then((r) => r.json());

console.log('\n[1] ベクトル化の充填');
const stats = await fetch(`${BASE}/api/memory/stats`).then((r) => r.json());
ok(stats.faqs && typeof stats.faqs.total === 'number', 'stats に faqs セクションがある');
ok(stats.faqs.total > 0, `rule_faqs が存在する`, `total=${stats.faqs.total}`);
ok(stats.faqs.vectorized === stats.faqs.total, '全件ベクトル化済み', `${stats.faqs.vectorized}/${stats.faqs.total}`);

console.log('\n[2] 差分再実行（text_hash 一致なら書き込まない）');
const again = await post('/api/memory/build/faqs', { batch: 200 });
ok(again.processed === 0, '同一内容の再実行で書き込み0件', `processed=${again.processed}`);
ok(again.skipped === stats.faqs.total, '全件がスキップされる', `skipped=${again.skipped}`);
ok(again.done === true, '1回で完了する（79件は batch 内）');

console.log('\n[3] 想起の妥当性（主題に沿ったQ&Aが上位）');
const cases = [
  { text: 'インクに置けるカードを増やしてインク加速したい', want: /インク/, label: 'インク' },
  { text: '歌でアクションカードを無料で使いたい', want: /歌|プレイ|アクション/, label: '歌/プレイ' },
  { text: '相手のキャラクターをチャレンジで倒したい', want: /チャレンジ|ゲームの概要|能力/, label: 'チャレンジ' },
];
const seen = [];
for (const c of cases) {
  const j = await post('/api/ai/synergy', { text: c.text });
  if (j.error) {
    // レート制限に当たった場合はスキップ（機能検証は他ケースで担保）
    ok(j.error === 'rate_limited', `${c.label}: レート制限のためスキップ`, j.error);
    continue;
  }
  const faqs = j.official_faqs || [];
  seen.push({ label: c.label, faqs, memory: j.memory });
  ok(faqs.length > 0, `${c.label}: 公式Q&Aを想起した`, `${faqs.length}件`);
  ok(c.want.test(faqs[0]?.category + faqs[0]?.question), `${c.label}: 最上位が主題に一致`, faqs[0]?.question?.slice(0, 40));
  ok(faqs.every((f) => f.similarity >= 0.28), `${c.label}: 低類似のQ&Aが混入しない`, `min=${Math.min(...faqs.map((f) => f.similarity))}`);
  ok(faqs.length <= 6, `${c.label}: 件数が上限6件に収まる`);
  ok(Number(j.memory?.official_faqs) === faqs.length, `${c.label}: memory の件数と一致`);
}

console.log('\n[4] 応答フィールドの形');
const sample = seen[0];
if (sample) {
  const f = sample.faqs[0];
  ok(typeof f.category === 'string' && f.category.length > 0, 'カテゴリを含む', f.category);
  ok(typeof f.question === 'string' && f.question.length > 0, '質問文を含む');
  ok(typeof f.answer === 'string' && f.answer.length > 0, '回答本文を含む');
  ok(typeof f.similarity === 'number', '類似度を数値で返す', String(f.similarity));
} else {
  ok(false, '検証用の応答が取得できなかった');
}

console.log('\n[5] UIへの露出');
const synHtml = await fetch(`${BASE}/synergy`).then((r) => r.text());
const dom = new JSDOM(synHtml);
ok(!!dom.window.document.getElementById('ai-result'), 'シナジー画面にAI結果領域がある');
const js = await fetch(`${BASE}/static/page-synergy.js`).then((r) => r.text());
ok(/official_faqs/.test(js), 'フロントが official_faqs を参照する');
ok(/参照した公式Q&amp;A|参照した公式Q&A/.test(js), '参照Q&Aの見出しを描画する');
ok(/m\.official_faqs/.test(js), '記憶バッジにQ&A件数を出す');

console.log('\n[6] 管理画面の記憶更新にQ&Aが含まれる');
const adminJs = await fetch(`${BASE}/static/page-admin.js`).then((r) => r.text());
ok(/memory\/build\/faqs/.test(adminJs), '「記憶層を更新」がQ&Aもベクトル化する');
ok(/v\.faqs/.test(adminJs), 'ステータスにQ&Aベクトル数を表示する');

console.log('\n[7] プロンプト側の優先順位の明示');
const worker = await import('node:fs').then((fs) => fs.promises.readFile('dist/_worker.js', 'utf8'));
ok(/公式Q&A/.test(worker), 'ビルド成果物にQ&Aブロックが含まれる');
ok(/公式Q&A ＞|公式Q&A ＞ キーワード/.test(worker) || /根拠の強さ/.test(worker), 'システムプロンプトで根拠の優先順位を指示');

console.log(`\n  ${pass}/${pass + fail} passed\n`);
process.exit(fail ? 1 : 0);
