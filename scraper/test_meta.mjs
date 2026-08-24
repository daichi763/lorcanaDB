#!/usr/bin/env node
/**
 * test_meta.mjs — 「最新環境情報」機能の検証
 *
 * 前提: pm2 で lorcana-fandb が起動しており、migrations 0005〜0008 が
 *       ローカルD1に適用済みであること。プロジェクトディレクトリから実行する
 *       （jsdom の解決のため）。
 *
 *   cd /home/user/webapp && node scraper/test_meta.mjs
 *
 * 検証の柱
 *  1. 公開API（report / snapshot / events / decks / status / credits）が壊れていない
 *  2. 仕様§1.3 引用方針: 公開レスポンスに非公式URLが混ざらない
 *     （例外は「デッキレシピの出典」と「可視クレジット必須ソースの帰属表示」のみ）
 *  3. スナップショットの出自が混ざらない（initial_seed と lh_meta の同居防止）
 *  4. 表示側の受け皿（トップ左ウィジェット / /meta / デッキタブ / 管理画面）が存在する
 *  5. 管理APIの認証ガードと、APIキー未設定ソースの「スキップ＝成功扱い」
 *  6. TopDeck.gg の帰属表示が §1.3 の例外として実際に出ること
 */
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';

const BASE = 'http://localhost:3000';
let pass = 0,
  fail = 0;
const ok = (c, m, extra = '') =>
  c ? (pass++, console.log(`  ✅ ${m} ${extra}`)) : (fail++, console.log(`  ❌ ${m} ${extra}`));

const j = async (path, init) => {
  const r = await fetch(BASE + path, init);
  let body = null;
  try {
    body = await r.json();
  } catch {
    /* JSONでない */
  }
  return { status: r.status, body, res: r };
};

/** 公式ドメイン（サーバ側 OFFICIAL_HOSTS と対応） */
const OFFICIAL = [
  'takaratomy.co.jp',
  'disneylorcana.com',
  'tcg.ravensburgerplay.com',
  'ravensburgerplay.com',
  'disney.co.jp',
];
const isOfficial = (u) => {
  try {
    const h = new URL(u).hostname.toLowerCase();
    return OFFICIAL.some((o) => h === o || h.endsWith('.' + o));
  } catch {
    return false;
  }
};
/** JSON文字列から http(s) URL を全部拾う */
const urlsIn = (obj) => String(JSON.stringify(obj ?? {})).match(/https?:\/\/[^\s"'\\)]+/g) || [];

console.log('\n[1] 公開API の疎通');
const report = await j('/api/meta/report');
ok(report.status === 200, 'GET /api/meta/report が 200');
ok('report' in (report.body || {}), 'report キーがある（未生成なら null）');
ok(/^\d{4}-\d{2}-\d{2}$/.test(report.body?.today || ''), `today が JST 日付 (${report.body?.today})`);

const snapEn = await j('/api/meta/snapshot?region=en&kind=ink_pair&limit=20');
ok(snapEn.status === 200, 'GET /api/meta/snapshot?region=en が 200');
const rows = snapEn.body?.rows || [];
ok(Array.isArray(rows), 'rows が配列');

const events = await j('/api/meta/events?scope=upcoming');
ok(events.status === 200, 'GET /api/meta/events?scope=upcoming が 200');
ok(Array.isArray(events.body?.events), 'events が配列');

const decks = await j('/api/meta/decks?jp_only=1&limit=6');
ok(decks.status === 200, 'GET /api/meta/decks?jp_only=1 が 200');
ok(Array.isArray(decks.body?.decks), 'decks が配列');

const status = await j('/api/meta/status');
ok(status.status === 200, 'GET /api/meta/status が 200');
ok(Array.isArray(status.body?.sources) && status.body.sources.length > 0, `sources が取れる (${status.body?.sources?.length})`);

console.log('\n[2] 仕様§1.3 引用方針（公開レスポンスに非公式URLを出さない）');
for (const [name, payload] of [
  ['report', report.body],
  ['snapshot', snapEn.body],
  ['events', events.body],
  ['status', status.body],
]) {
  const bad = urlsIn(payload).filter((u) => !isOfficial(u));
  ok(bad.length === 0, `${name} に非公式URLが無い`, bad.length ? `→ ${bad.slice(0, 3).join(' , ')}` : '');
}
// status は非公式ソースの「ラベル」までは出すが URL は出さない設計
ok(
  (status.body?.sources || []).every((s) => !('url' in s)),
  'status のソース一覧に url フィールドが無い'
);

console.log('\n[3] スナップショットの出自が混ざらない');
{
  const seen = new Map();
  for (const r of rows) {
    // detail はAPI側でパース済みのオブジェクト。文字列で返る場合にも備える
    let d = r.detail;
    if (typeof d === 'string') {
      try {
        d = JSON.parse(d);
      } catch {
        d = {};
      }
    }
    seen.set(String((d || {}).source ?? ''), (seen.get(String((d || {}).source ?? '')) || 0) + 1);
  }
  ok(seen.size <= 1, `出自は1系統のみ (${[...seen.keys()].join(',') || 'なし'})`);
  ok(rows.length === 0 || [...seen.keys()][0] !== '', '出自（detail.source）が記録されている');
  const labels = rows.map((r) => r.label);
  ok(new Set(labels).size === labels.length, 'インク組み合わせが重複しない');
  const ranks = rows.map((r) => Number(r.rank));
  ok(
    ranks.every((v, i) => i === 0 || ranks[i - 1] <= v),
    'rank の昇順で返る'
  );
}

console.log('\n[4] 帰属表示（可視クレジット必須ソース＝§1.3の例外）');
const credits = await j('/api/meta/credits');
ok(credits.status === 200, 'GET /api/meta/credits が 200');
const cl = credits.body?.credits || [];
ok(Array.isArray(cl), 'credits が配列');
const td = cl.find((x) => x.key === 'topdeck_gg');
ok(!!td, 'TopDeck.gg がクレジット対象として返る');
ok(td?.label === 'TopDeck.gg', `クレジット表記 (${td?.label})`);
ok(/^https:\/\/topdeck\.gg/.test(td?.url || ''), `リンクバック先 (${td?.url})`);
// クレジット欄はラベルとURLだけ。記事本文などを漏らさない
ok(
  cl.every((x) => Object.keys(x).sort().join(',') === 'key,label,url'),
  'クレジットが key/label/url のみを返す'
);

console.log('\n[5] 表示側の受け皿');
{
  const top = await fetch(BASE + '/').then((r) => r.text());
  const dTop = new JSDOM(top).window.document;
  ok(!!dTop.getElementById('meta-widget'), 'トップページに左カラムのウィジェット枠がある');
  // 左カラム（aside）の内側にあること
  ok(
    !!dTop.querySelector('aside #meta-widget'),
    'ウィジェットが左カラム（aside）内にある'
  );
  ok(!!dTop.querySelector('a[href="/meta"]'), 'ナビに /meta への導線がある');

  const meta = await fetch(BASE + '/meta').then((r) => r.text());
  const dMeta = new JSDOM(meta).window.document;
  for (const id of [
    'meta-updated',
    'meta-countdown',
    'meta-jp',
    'meta-en',
    'meta-diff',
    'meta-spotlight',
    'meta-snap-jp',
    'meta-snap-en',
    'meta-decks',
    'meta-links',
    'meta-credits',
  ]) {
    ok(!!dMeta.getElementById(id), `/meta に #${id} がある`);
  }
  ok(/page-meta\.js/.test(meta), '/meta が page-meta.js を読み込む');

  const deck = await fetch(BASE + '/deck').then((r) => r.text());
  const dDeck = new JSDOM(deck).window.document;
  for (const id of ['meta-recipes', 'meta-recipes-filters', 'meta-recipes-list', 'meta-recipes-more', 'meta-recipe-detail', 'meta-credits']) {
    ok(!!dDeck.getElementById(id), `/deck に #${id} がある`);
  }

  const admin = await fetch(BASE + '/x7f2q9').then((r) => r.text());
  const dAdm = new JSDOM(admin).window.document;
  for (const id of [
    'op-btn-meta-collect',
    'op-btn-meta-aggregate',
    'op-btn-meta-summarize',
    'op-btn-meta-memory',
    'op-btn-meta-all',
    'op-meta-status',
  ]) {
    ok(!!dAdm.getElementById(id), `管理画面に #${id} がある`);
  }
}

console.log('\n[6] フロント側スクリプトの静的検査');
{
  const pm = readFileSync('public/static/page-meta.js', 'utf8');
  ok(/window\.LorMeta\s*=/.test(pm), 'page-meta.js が LorMeta を公開する');
  ok(/renderCredits/.test(pm), 'renderCredits を実装している');
  ok(/LorMeta\s*=\s*\{[^}]*renderCredits/.test(pm), 'renderCredits を LorMeta 経由で共有する');

  const pd = readFileSync('public/static/page-deck.js', 'utf8');
  ok(/LorMeta\?\.renderCredits/.test(pd), 'page-deck.js が帰属表示を呼ぶ');
  ok(/jp_only=1/.test(pd), 'デッキタブは playable_jp=1 のみ取得する');
  ok(/rel="noopener noreferrer nofollow"/.test(pd), 'レシピ出典リンクに nofollow を付ける');

  const pa = readFileSync('public/static/page-admin.js', 'utf8');
  ok(/\/meta\/collect/.test(pa) && /\/meta\/aggregate/.test(pa) && /\/meta\/summarize/.test(pa) && /\/meta\/memory/.test(pa), '管理画面が4段すべてを叩く');
  ok(/r\.done\s*&&\s*!r\.remaining/.test(pa), '収集は done かつ remaining=0 まで繰り返す');

  const wf = readFileSync('.github/workflows/meta-daily.yml', 'utf8');
  ok(/cron:\s*'0 13 \* \* \*'/.test(wf), 'cron が 13:00 UTC（=22:00 JST）');
  ok(/meta\/collect/.test(wf) && /meta\/memory/.test(wf), 'ワークフローが4段を実行する');
}

console.log('\n[7] 管理APIの認証ガード');
for (const p of ['/api/_ops/meta/collect', '/api/_ops/meta/aggregate', '/api/_ops/meta/summarize', '/api/_ops/meta/memory']) {
  const r = await j(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  ok(r.status === 401, `${p} は未認証で401`);
}
{
  const r = await j('/api/_ops/meta/status');
  ok(r.status === 401, '/api/_ops/meta/status は未認証で401');
}

console.log('\n[8] APIキー未設定ソースは「スキップ＝成功扱い」');
{
  // .dev.vars のローカルパスワードでログイン（本番パスワードとは別物）
  const pw = (readFileSync('.dev.vars', 'utf8').match(/^ADMIN_PASSWORD=(.*)$/m) || [])[1];
  ok(!!pw, '.dev.vars から ADMIN_PASSWORD を読める');
  const lg = await fetch(BASE + '/api/_ops/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: pw }),
  });
  const cookie = (lg.headers.get('set-cookie') || '').split(';')[0];
  ok(lg.status === 200 && /__ops_sess=/.test(cookie), '管理APIにログインできる');

  const H = { Cookie: cookie, 'Content-Type': 'application/json' };
  const ms = await fetch(BASE + '/api/_ops/meta/status', { headers: { Cookie: cookie } }).then((r) => r.json());
  ok(Array.isArray(ms.sources), `認証後に詳細な状態が取れる (${ms.sources?.length} ソース)`);
  ok(typeof ms.collected_today === 'number', '本日の収集数が取れる');

  // TopDeck.gg は TOPDECK_API_KEY 未設定なのでスキップされ、ok:true で返る
  const cx = await fetch(BASE + '/api/_ops/meta/collect', {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ source: 'topdeck_gg' }),
  }).then((r) => r.json());
  ok(cx.ok === true, 'TopDeck.gg はAPIキー未設定でも失敗扱いにならない');
  ok(cx.detail?.skipped === 'no_topdeck_api_key', `スキップ理由が明示される (${cx.detail?.skipped})`);

  // X 公式APIも同様（有料プラン前提のため未設定時はスキップ）
  const xx = await fetch(BASE + '/api/_ops/meta/collect', {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ source: 'x_official_jp' }),
  }).then((r) => r.json());
  ok(xx.ok === true, 'X 公式APIはトークン未設定でも失敗扱いにならない');
  ok(xx.detail?.skipped === 'no_x_bearer_token', `スキップ理由が明示される (${xx.detail?.skipped})`);

  // robots で禁止されているソースは収集しない
  // （無効化済みなので収集対象にならず、対象なしで完了として返る）
  const rb = await fetch(BASE + '/api/_ops/meta/collect', {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ source: 'reddit_lorcana' }),
  }).then((r) => r.json());
  ok(
    rb.detail?.skipped === 'blocked_by_robots' || (rb.done === true && !rb.source),
    `robots 禁止ソースは収集対象にならない (${rb.detail?.skipped ?? '無効化済み'})`
  );
}

console.log('\n[9] ソース定義の整合性');
{
  const pw = (readFileSync('.dev.vars', 'utf8').match(/^ADMIN_PASSWORD=(.*)$/m) || [])[1];
  const lg = await fetch(BASE + '/api/_ops/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: pw }),
  });
  const cookie = (lg.headers.get('set-cookie') || '').split(';')[0];
  const ms = await fetch(BASE + '/api/_ops/meta/status', { headers: { Cookie: cookie } }).then((r) => r.json());
  const byKey = new Map((ms.sources || []).map((s) => [s.key, s]));

  ok(byKey.has('lh_meta') && byKey.get('lh_meta').enabled === 1, 'lorcanahunter メタ集計が有効');
  ok(byKey.has('topdeck_gg') && byKey.get('topdeck_gg').enabled === 1, 'TopDeck.gg が有効');
  ok(byKey.get('topdeck_gg')?.method === 'topdeck_api', 'TopDeck.gg の収集方式が topdeck_api');
  ok(byKey.get('x_official_jp')?.method === 'x_api', 'X 公式（日本）が x_api');
  ok(byKey.get('x_official_jp')?.is_official === 1, 'X 公式アカウントは公式扱い');
  ok(byKey.get('x_community_jp')?.is_official === 0, 'X コミュニティは非公式扱い');
  ok(byKey.get('lorcana_gg')?.enabled === 0, 'lorcana.gg は無効（内容がアフィリエイト化）');
  ok(byKey.get('api_lorcana')?.enabled === 0, 'api-lorcana.com は無効（データが2024年で停止）');
  ok(byKey.get('mushureport')?.enabled === 0, 'mushureport は無効（403でブロック）');
  ok(byKey.get('reddit_lorcana')?.enabled === 0, 'reddit は無効（robots で全面 Disallow）');
  // 公式ソースは信頼度が高いこと
  ok(
    (ms.sources || []).filter((s) => s.is_official === 1).every((s) => Number(s.trust) >= 4),
    '公式ソースの trust は 4 以上'
  );
}

console.log(`\n  ${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
