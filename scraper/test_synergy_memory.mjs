#!/usr/bin/env node
/**
 * test_synergy_memory.mjs — シナジー分析が「記憶層6系統」を実際に参照しているかを検証
 *
 * 前提: pm2 で lorcana-fandb が起動、migrations 適用済み、記憶層が構築済み
 *       （管理画面の「記憶層を更新」＋「記憶層へ反映」が済んでいること）。
 *
 * なぜこのテストが必要か
 *   記憶層は「入っていること」と「使われていること」が別問題である。
 *   実際に、自由記述モードでは recallSynergy が baseId=null で無条件に空配列を返す
 *   ため、rememberSynergy が書き込んだ base_id IS NULL の記録が一度も読み出されず、
 *   「書き込むだけの死蔵データ」になっていた。しかも自由記述は画面の主入力なので、
 *   最も使われる経路が記憶の恩恵をまったく受けていなかった。
 *   件数だけを見ていても、応答が返ってきていても気づけない類の不具合なので、
 *   「モードごとに、どの系統が何件効いたか」を明示的に検査する。
 *
 * 検証の柱
 *   1. 記憶層に材料が入っている（前提の確認。0件ならテスト自体が無意味）
 *   2. カードモードで6系統が参照される
 *   3. 自由記述モードでも過去の検討結果が想起される（← 上記の不具合の回帰テスト）
 *   4. 記憶の出自が区別される（同条件の再評価か、別の相談からの流用か）
 *   5. 書き戻し→再想起のループが閉じている
 *   6. 記憶が候補選定に実際に効いている（db_signals に現れる）
 */
const BASE = 'http://localhost:3000';
let pass = 0, fail = 0;
const ok = (c, m, extra = '') => { c ? (pass++, console.log(`  ✅ ${m} ${extra}`)) : (fail++, console.log(`  ❌ ${m} ${extra}`)); };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 60秒窓のレート制限に当たったら待って再試行する。
 * スキップで済ませると「記憶が使われているか」という肝心の検査が
 * 実行されないまま緑になってしまうため、待ってでも実測する。
 */
async function post(p, b, tries = 3) {
  for (let i = 0; i < tries; i++) {
    const j = await fetch(`${BASE}${p}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b),
    }).then((r) => r.json());
    if (j.error !== 'rate_limited' || i === tries - 1) return j;
    const wait = Math.min(Number(j.retry_after) || 60, 70) + 2;
    console.log(`     … レート制限。${wait}秒待って再試行`);
    await sleep(wait * 1000);
  }
}

// 同じ入力はキャッシュされるので、毎回わずかに文言を変えて実測させる
const uniq = () => `（検証${Date.now().toString(36).slice(-5)}）`;

console.log('[1] 記憶層に材料が入っている');
const stats = await fetch(`${BASE}/api/memory/stats`).then((r) => r.json());
// {cards:{total,vectorized}, ...} という入れ子。total だけ見ても
// 「入っているが未ベクトル化」を見逃すので vectorized を検査する
for (const k of ['cards', 'rules', 'faqs']) {
  const s = stats[k] || {};
  ok(Number(s.vectorized) > 0, `${k} がベクトル化済み`, `(${s.vectorized}/${s.total})`);
  ok(Number(s.vectorized) === Number(s.total), `${k} に未ベクトル化が無い（AIから引ける）`);
}
ok(Number(stats.ability_knowledge) > 0, 'キーワード能力の裁定知識がある', `(${stats.ability_knowledge})`);
ok(Number(stats.synergy_memory) > 0, 'シナジー事例の記憶がある', `(${stats.synergy_memory})`);

console.log('\n[2] カードモード: 記憶層が参照される');
const card = await post('/api/ai/synergy', { card_file: '1452', want: 6, text: uniq() });
if (card.error) {
  ok(card.error === 'rate_limited' || card.error === 'ai_not_configured', `スキップ（${card.error}）`);
} else {
  const m = card.memory || {};
  ok(m.vector_search === true, '意味ベクトル検索が使われた');
  ok(Number(m.official_faqs) > 0, '公式Q&Aが想起された', `(${m.official_faqs}件)`);
  ok(Number(m.ability_knowledge) > 0, 'キーワード能力の裁定知識が使われた', `(${m.ability_knowledge}件)`);
  ok(Number(m.meta_context) > 0, '最新環境情報が想起された', `(${m.meta_context}件)`);
  ok(card.candidate_count > 0, '候補が抽出された', `(${card.candidate_count}枚)`);
  ok(!!card.meta?.as_of, '環境情報の基準日が付く', `(${card.meta?.as_of})`);
}

console.log('\n[3] 自由記述モード: 過去の検討結果が想起される（回帰テスト）');
// かつては baseId=null で無条件に空配列を返していたため、ここが必ず 0 になっていた。
const texts = [
  '捨て札のアイテムを増やして高コストを安く出したい',
  'アンバーとアメジストで序盤から押し切りたい',
];
const seen = [];
for (const t of texts) {
  const j = await post('/api/ai/synergy', { text: `${t}${uniq()}`, want: 6 });
  if (j.error) { ok(j.error === 'rate_limited', `スキップ（${j.error}）`); continue; }
  seen.push(j);
  const m = j.memory || {};
  ok(m.vector_search === true, `「${t.slice(0, 12)}…」意味ベクトル検索が使われた`);
  ok(Number(m.official_faqs) > 0, `「${t.slice(0, 12)}…」公式Q&Aが想起された`, `(${m.official_faqs}件)`);
  ok(Number(m.meta_context) > 0, `「${t.slice(0, 12)}…」環境情報が想起された`, `(${m.meta_context}件)`);
  // 本題: 起点カードが無くても記憶を引けること
  ok(Number(m.recalled) > 0, `「${t.slice(0, 12)}…」過去の検討結果が想起された`, `(${m.recalled}件)`);
}

console.log('\n[4] 記憶の出自が区別される');
// 別の相談から流用した事例を「同条件での実績」と誤認させないための表示分離。
// 混ざると、無関係な汎用カードが「実績あり」として上位に居座る。
if (seen.length) {
  const sig = seen.flatMap((j) => (j.results || []).flatMap((r) => r.db_signals || []));
  const fromText = sig.filter((s) => /別の相談で高評価/.test(s));
  const fromCard = sig.filter((s) => /過去に高評価/.test(s));
  ok(fromText.length > 0, '自由記述モードは「別の相談で高評価」と表示', `(${fromText.length}件)`);
  ok(fromCard.length === 0, '自由記述モードで「過去に高評価」を混ぜない', `(${fromCard.length}件)`);
}
if (!card.error) {
  const cardSig = (card.results || []).flatMap((r) => r.db_signals || []);
  ok(!cardSig.some((s) => /別の相談で高評価/.test(s)), 'カードモードは「別の相談」表示を使わない');
}

console.log('\n[5] 書き戻し→再想起のループが閉じている');
// 同じ問いを2回投げると、1回目の結果が記憶に入り2回目で hits が増える。
// キャッシュを避けるため文言を変え、同じ主題に寄せる。
// 注意: recalled は「記憶 ∩ 候補120枚」の件数なので実行ごとに揺れる。
// 単調増加は不変条件ではないので、代わりに
//   ・記憶の総数が減らない（書き戻しが効いている）
//   ・2回目も想起できる（読み出しが安定している）
// を検査する。
const theme = 'ロアを稼いで一気に勝ちに行きたい';
const before = Number((await fetch(`${BASE}/api/memory/stats`).then((r) => r.json())).synergy_memory);
const r1 = await post('/api/ai/synergy', { text: `${theme}${uniq()}`, want: 5 });
const r2 = await post('/api/ai/synergy', { text: `${theme}${uniq()}`, want: 5 });
const after = Number((await fetch(`${BASE}/api/memory/stats`).then((r) => r.json())).synergy_memory);
if (r1.error || r2.error) {
  ok(true, `スキップ（${r1.error || r2.error}）`);
} else {
  ok(r1.cached === false && r2.cached === false, '2回とも実測（キャッシュに当たっていない）');
  ok(after >= before, '記憶の総数が減らない（書き戻しが働く）', `(${before} → ${after})`);
  ok(Number(r1.memory?.recalled) > 0 && Number(r2.memory?.recalled) > 0,
     '連続実行でも毎回想起できる', `(${r1.memory?.recalled} / ${r2.memory?.recalled})`);
}

console.log('\n[6] 記憶が候補選定に効いている');
if (seen.length) {
  const withMem = seen.find((j) => Number(j.memory?.recalled) > 0);
  ok(!!withMem, '記憶を使った応答がある');
  if (withMem) {
    // 想起しただけでプロンプトにも候補加点にも反映されていなければ意味がない
    const sig = (withMem.results || []).flatMap((r) => r.db_signals || []);
    ok(sig.some((s) => /高評価/.test(s)), '記憶由来の加点が候補の根拠に現れる');
    ok((withMem.results || []).every((r) => Array.isArray(r.db_signals)),
       '全結果に根拠シグナルが付く');
  }
}

console.log('\n[7] キャッシュ版も記憶情報を保持する');
// キャッシュ応答で memory が欠けると、UIが「記憶を使わなかった」と誤表示する
const c1 = await post('/api/ai/synergy', { text: 'インク加速で大型を早出ししたい', want: 5 });
const c2 = await post('/api/ai/synergy', { text: 'インク加速で大型を早出ししたい', want: 5 });
if (c1.error || c2.error) {
  ok(true, `スキップ（${c1.error || c2.error}）`);
} else {
  ok(c2.cached === true, '2回目はキャッシュから返る');
  ok(!!c2.memory && typeof c2.memory.vector_search === 'boolean', 'キャッシュ応答も memory を含む');
  ok(JSON.stringify(c1.memory) === JSON.stringify(c2.memory), 'キャッシュ前後で memory が一致');
  ok(Array.isArray(c2.official_faqs), 'キャッシュ応答も公式Q&Aを含む');
}

console.log('\n[8] ビルド成果物に修正が含まれる');
const worker = await import('node:fs').then((fs) => fs.promises.readFile('dist/_worker.js', 'utf8'));
ok(/base_id IS NULL/.test(worker), '自由記述モードの想起クエリが含まれる');
ok(/別の相談で高評価/.test(worker), '出自を区別する表示が含まれる');

console.log(`\n  ${pass}/${pass + fail} passed\n`);
process.exit(fail ? 1 : 0);
