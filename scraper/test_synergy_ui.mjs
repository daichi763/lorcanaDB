/**
 * test_synergy_ui.mjs — /synergy ページのフロントエンドを jsdom で実動作検証
 * （Playwright ツールがサンドボックスで動かないため代替の自動テスト）
 *
 *   node scraper/test_synergy_ui.mjs
 */
import { JSDOM } from 'jsdom';
import fs from 'node:fs';

const BASE = process.env.BASE || 'http://localhost:3000';
const results = [];
const ok = (name, cond, extra = '') =>
  results.push({ name, pass: !!cond, extra: cond ? extra : `NG ${extra}` });

const html = await (await fetch(`${BASE}/synergy?tab=ai`)).text();

const dom = new JSDOM(html, {
  url: `${BASE}/synergy?tab=ai`,
  runScripts: 'outside-only',
  pretendToBeVisual: true,
});
const { window } = dom;

// fetch を実サーバへ橋渡し
window.fetch = async (input, init) => {
  const url = typeof input === 'string' ? (input.startsWith('http') ? input : BASE + input) : input;
  const r = await fetch(url, init);
  return {
    ok: r.ok,
    status: r.status,
    json: () => r.json(),
    text: () => r.text(),
  };
};
window.localStorage.clear?.();

// スクリプトを読み込み（renderer.tsx と同じ順序）
for (const f of ['icons.js', 'app.js', 'page-synergy.js']) {
  window.eval(fs.readFileSync(`public/static/${f}`, 'utf8'));
}

ok('LorIcons が公開される', typeof window.LorIcons === 'object');
ok('LorApp が公開される', typeof window.LorApp === 'object');
ok('initSynergyPage が定義される', typeof window.initSynergyPage === 'function');

// DOMContentLoaded ディスパッチャ相当を実行
window.LorApp.initLightbox?.();
window.LorApp.initFavButtons?.();
window.initSynergyPage();

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await wait(2500); // boot() の /api/masters・status 取得待ち

const $ = (s) => window.document.querySelector(s);
const $$ = (s) => [...window.document.querySelectorAll(s)];

// ---- 初期描画 ----
ok('AIパネルが初期表示', !$('#panel-ai').classList.contains('hidden'));
ok('種族パネルは初期非表示', $('#panel-class').classList.contains('hidden'));
ok('AI利用可能（警告非表示）', $('#ai-unavailable').classList.contains('hidden'));
ok('AI実行ボタンが有効', !$('#ai-run').disabled);
ok('インク色ボタン6色', $$('.js-ai-ink').length === 6, `${$$('.js-ai-ink').length}個`);
ok('起点カード未選択メッセージ', /未選択/.test($('#ai-card-picked').textContent));
const opts = $$('#synergy-select option').length;
ok('種族セレクトが構築される', opts > 40, `${opts}件`);

// ---- 例文ボタン ----
$$('.js-ai-example')[0].click();
ok('例文クリックでテキスト反映', $('#ai-text').value.length > 5, JSON.stringify($('#ai-text').value));

// ---- インク色トグル（最大2色）----
const inks = $$('.js-ai-ink');
inks[0].click();
inks[1].click();
inks[2].click();
const pressed = $$('.js-ai-ink').filter((b) => b.getAttribute('aria-pressed') === 'true');
ok('インク色は2色まで', pressed.length === 2, `${pressed.length}色`);

// ---- タブ切替 ----
$('#tab-class').click();
ok('種族タブでAIパネルが隠れる', $('#panel-ai').classList.contains('hidden'));
ok('種族タブでパネル表示', !$('#panel-class').classList.contains('hidden'));
ok('URLにtab=class', window.location.search.includes('tab=class'));

// ---- 種族逆引きの実動作 ----
$('#synergy-select').value = 'トイ';
$('#synergy-select').dispatchEvent(new window.Event('change'));
await wait(2000);
const sres = $('#synergy-result').textContent;
ok('種族逆引きが描画される', /参照する効果を持つカード/.test(sres) && /を持つカード/.test(sres));
const tiles = $$('#synergy-result .card-tile').length;
ok('種族逆引きでカードが並ぶ', tiles > 10, `${tiles}枚`);
ok('画像はloading=lazy', $$('#synergy-result img').every((i) => i.getAttribute('loading') === 'lazy'));
ok(
  '画像は公式サーバ直リンク',
  $$('#synergy-result img').every((i) => /takaratomy\.co\.jp/.test(i.src)),
  ($$('#synergy-result img')[0] || {}).src || ''
);

$('#tab-ai').click();
ok('AIタブへ戻れる', !$('#panel-ai').classList.contains('hidden'));

// ---- カードオートコンプリート ----
$('#ai-card-input').value = 'エルサ';
$('#ai-card-input').dispatchEvent(new window.Event('input'));
await wait(1800);
const sug = $$('#ai-card-suggest .js-suggest');
ok('候補が出る', sug.length > 0, `${sug.length}件`);
if (sug.length) {
  sug[0].click();
  await wait(200);
  ok('起点カードが選択される', /エルサ/.test($('#ai-card-picked').textContent));
  ok('候補リストが閉じる', $('#ai-card-suggest').classList.contains('hidden'));
  $('#ai-card-clear')?.click();
  await wait(100);
  ok('起点カード解除できる', /未選択/.test($('#ai-card-picked').textContent));
}

// ---- 入力なしバリデーション ----
$('#ai-text').value = '';
$('#ai-result').innerHTML = '';
$('#ai-run').click();
await wait(300);
ok('未入力で警告表示', /カードを選ぶか/.test($('#ai-result').textContent));

// ---- AI探索の実行（キャッシュ済みクエリでレート制限を回避）----
// インク色の絞りを解除してキャッシュキーを一致させる
$$('.js-ai-ink')
  .filter((b) => b.getAttribute('aria-pressed') === 'true')
  .forEach((b) => b.click());
$('#ai-text').value = '変身のコストを軽くして高コストのキャラを早く出したい';
$('#ai-want').value = '8';
$('#ai-run').click();
// AI応答は20〜30秒かかるため固定待機ではなく描画完了までポーリングする
// （スケルトン表示が消え「AIの見立て」かエラーが出るまで待つ）
const deadline = Date.now() + 75_000;
while (Date.now() < deadline) {
  const t = $('#ai-result').textContent;
  if (/AIの見立て/.test(t) || /失敗|エラー|上限/.test(t)) break;
  await wait(500);
}
const air = $('#ai-result').textContent;
ok('AIの見立てが描画される', /AIの見立て/.test(air), air.slice(0, 80));
ok('シナジー候補が描画される', /シナジー候補/.test(air));
const aiCards = $$('#ai-result .card-tile').length;
ok('AI結果カードが並ぶ', aiCards > 0, `${aiCards}枚`);
ok('スコアが表示される', $$('#ai-result .card-tile').some((el) => /\d/.test(el.textContent)));
ok('理由テキストが入る', /思われる|ため|できる/.test(air));
ok(
  'AI結果画像もlazy＋公式直リンク',
  $$('#ai-result img').every((i) => i.getAttribute('loading') === 'lazy' && /takaratomy\.co\.jp/.test(i.src))
);
ok('URLが共有可能形式', /tab=ai/.test(window.location.search) && /q=/.test(window.location.search));
ok('免責文が存在する', /参考情報/.test($('#ai-disclaimer').textContent));

// ---- クリア ----
$('#ai-reset').click();
await wait(200);
ok('クリアで結果が消える', $('#ai-result').innerHTML === '');
ok('クリアでテキストが空', $('#ai-text').value === '');

// ---- 結果出力 ----
const pass = results.filter((r) => r.pass).length;
console.log('');
for (const r of results) console.log(`  ${r.pass ? '✅' : '❌'} ${r.name}${r.extra ? `  (${r.extra})` : ''}`);
console.log(`\n  ${pass}/${results.length} passed\n`);
process.exit(pass === results.length ? 0 : 1);
