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
import { readFileSync, existsSync } from 'node:fs';

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

  /*
   * デッキレシピは /deck（デッキビルド）から /recipes へ分離した。
   * 「組む」編集画面と「読む」閲覧画面で目的が違い、同居させると
   * 双方の利用者が相手側の描画を跨ぐことになるため。
   * 分離が崩れる（要素が両方に出る／片方から消える）と気付きにくいので、
   * 存在確認だけでなく「反対側に無いこと」まで検査する。
   */
  const recipes = await fetch(BASE + '/recipes').then((r) => r.text());
  const dRec = new JSDOM(recipes).window.document;
  for (const id of ['meta-recipes', 'meta-recipes-filters', 'meta-recipes-list', 'meta-recipes-more', 'meta-recipe-detail', 'meta-credits']) {
    ok(!!dRec.getElementById(id), `/recipes に #${id} がある`);
  }
  ok(/page-recipes\.js/.test(recipes), '/recipes が page-recipes.js を読み込む');
  for (const id of ['pool-results', 'deck-drop-zone', 'deck-list']) {
    ok(!dRec.getElementById(id), `/recipes にビルダーの #${id} が無い`);
  }

  const deck = await fetch(BASE + '/deck').then((r) => r.text());
  const dDeck = new JSDOM(deck).window.document;
  for (const id of ['pool-results', 'deck-drop-zone', 'deck-list']) {
    ok(!!dDeck.getElementById(id), `/deck に #${id} がある`);
  }
  for (const id of ['meta-recipes', 'meta-recipes-list', 'meta-recipe-detail']) {
    ok(!dDeck.getElementById(id), `/deck にレシピの #${id} が無い`);
  }
  ok(/href="\/recipes"/.test(deck), '/deck からレシピタブへの導線がある');

  // 分離前に共有された /deck?meta=<id> のリンクが死なないこと
  const redir = await fetch(BASE + '/deck?meta=1', { redirect: 'manual' });
  ok(redir.status === 301, '/deck?meta= が 301 を返す');
  ok(
    (redir.headers.get('location') || '').includes('/recipes?meta=1'),
    '/deck?meta=1 が /recipes?meta=1 へ転送される'
  );

  // ナビゲーションに両タブが並ぶこと
  ok(/デッキビルド/.test(deck) && /デッキレシピ/.test(deck), 'ナビに「デッキビルド」「デッキレシピ」が並ぶ');

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

  // レシピ描画は page-deck.js から page-recipes.js へ移した（タブ分割）
  const pr = readFileSync('public/static/page-recipes.js', 'utf8');
  ok(/LorMeta\?\.renderCredits/.test(pr), 'page-recipes.js が帰属表示を呼ぶ');
  ok(/jp_only=1/.test(pr), 'デッキレシピタブは playable_jp=1 のみ取得する');
  ok(/rel="noopener noreferrer nofollow"/.test(pr), 'レシピ出典リンクに nofollow を付ける');

  // 分割後にレシピ処理が両ファイルへ二重化していないこと（片方だけ直す事故を防ぐ）
  const pd = readFileSync('public/static/page-deck.js', 'utf8');
  ok(!/meta-recipes-list/.test(pd), 'page-deck.js にレシピ描画が残っていない');
  ok(/lorfan\.deck/.test(pd) && /lorfan\.deck/.test(pr), 'ビルダーとレシピが同じ localStorage キーを使う');

  const pa = readFileSync('public/static/page-admin.js', 'utf8');
  ok(/\/meta\/collect/.test(pa) && /\/meta\/aggregate/.test(pa) && /\/meta\/summarize/.test(pa) && /\/meta\/memory/.test(pa), '管理画面が4段すべてを叩く');
  ok(/r\.done\s*&&\s*!r\.remaining/.test(pa), '収集は done かつ remaining=0 まで繰り返す');
  ok(/\/meta\/ocr/.test(pa), '管理画面が画像OCRを叩く');
  ok(/op-btn-meta-ocr/.test(pa), 'OCR ボタンのハンドラが登録されている');
  const idx = readFileSync('src/index.tsx', 'utf8');
  ok(/op-btn-meta-ocr/.test(idx), '管理画面に OCR ボタンがある');

  // ワークフロー定義の置き場所について:
  //   Genspark の GitHub App トークンには `workflows` 権限が無く、
  //   .github/workflows/ 配下のファイルは push が拒否される。
  //   そのため定義は ops/ で管理し、利用者が手動で .github/workflows/ へ配置する。
  //   （配置済みならそちらを優先して検査する）
  const wfPath = existsSync('.github/workflows/meta-daily.yml')
    ? '.github/workflows/meta-daily.yml'
    : 'ops/github-workflow-meta-daily.yml';
  const wf = readFileSync(wfPath, 'utf8');
  ok(/cron:\s*'0 13 \* \* \*'/.test(wf), 'cron が 13:00 UTC（=22:00 JST）');
  ok(
    /meta\/collect/.test(wf) &&
      /meta\/ocr/.test(wf) &&
      /meta\/aggregate/.test(wf) &&
      /meta\/summarize/.test(wf) &&
      /meta\/memory/.test(wf),
    'ワークフローが5段（収集→OCR→集計→要約→記憶層）を実行する'
  );
  // OCR で落ちても集計・要約は続けたい（画像が読めなくても本文でレポートは作れる）
  ok(/continue-on-error:\s*true/.test(wf), 'OCR段は失敗しても後続を止めない');
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

  // TopDeck.gg は APIキーの有無で挙動が変わる。どちらでも「失敗扱いにしない」ことが要件。
  //   キー未設定 → detail.skipped === 'no_topdeck_api_key'
  //   キー設定済 → 実際に収集し detail.events / decks_with_list が返る
  const cx = await fetch(BASE + '/api/_ops/meta/collect', {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ source: 'topdeck_gg' }),
  }).then((r) => r.json());
  ok(cx.ok === true, 'TopDeck.gg は成功扱いで返る（キー有無を問わず）');
  const tdSkipped = cx.detail?.skipped === 'no_topdeck_api_key';
  const tdCollected = typeof cx.detail?.events === 'number';
  ok(
    tdSkipped || tdCollected,
    tdSkipped
      ? 'APIキー未設定時はスキップ理由が明示される (no_topdeck_api_key)'
      : `APIキー設定済のため実収集された (大会${cx.detail?.events}件 / デッキリスト${cx.detail?.decks_with_list}件)`
  );

  // TopDeck は誰でも大会を立てられるため、デモ/テスト大会や
  // デッキリストの無い大会が混ざる。これらは材料にならないので除外していること。
  const recent = await fetch(BASE + '/api/meta/events?scope=recent&limit=30').then((r) => r.json());
  const tdEvents = (recent.events || []).filter((e) => (e.note || '').includes('TopDeck'));
  ok(
    tdEvents.every((e) => !/\b(demo|test|practica)\b/i.test(e.name || '')),
    `TopDeck 由来のデモ/テスト大会が混ざらない (${tdEvents.length}件検査)`
  );
  ok(
    tdEvents.every((e) => Number(e.players) > 0),
    'TopDeck 由来の大会は参加人数を持つ'
  );
  // §1.3: topdeck.gg は非公式ドメインなので大会URLは表に出さない
  ok(
    tdEvents.every((e) => !e.url),
    'TopDeck 由来の大会は本文側にURLを出さない（帰属は専用欄で表示）'
  );

  // X 公式APIも同様（有料プラン前提のため未設定時はスキップ）
  const xx = await fetch(BASE + '/api/_ops/meta/collect', {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ source: 'x_official_jp' }),
  }).then((r) => r.json());
  ok(xx.ok === true, 'X 公式APIはトークン未設定でも失敗扱いにならない');
  // TopDeck と同じ二態。トークン設定済なら実収集され username が返る
  const xSkipped = xx.detail?.skipped === 'no_x_bearer_token';
  ok(
    xSkipped || typeof xx.detail?.username === 'string',
    xSkipped
      ? 'トークン未設定時はスキップ理由が明示される (no_x_bearer_token)'
      : `トークン設定済のため実収集された (@${xx.detail?.username} / 新規${xx.inserted}件)`
  );

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

console.log('\n[8.5] 画像OCR（仕様§9-3）');
{
  const pw = (readFileSync('.dev.vars', 'utf8').match(/^ADMIN_PASSWORD=(.*)$/m) || [])[1];
  const lg = await fetch(BASE + '/api/_ops/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: pw }),
  });
  const cookie = (lg.headers.get('set-cookie') || '').split(';')[0];
  const H = { 'content-type': 'application/json', Cookie: cookie };

  // OCR 対象の画像URLは収集時に保存されていること。
  // 公式Xの告知は本文が短く、開催時刻や会場が画像内にしか無いため、
  // ここで画像URLを取り逃すと「明日以降の予定」が実質空になる。
  const st = await fetch(BASE + '/api/_ops/meta/status', { headers: { Cookie: cookie } }).then((r) => r.json());
  ok(st.ocr && typeof st.ocr.total === 'number', 'OCR の集計が管理ステータスに載る');

  // 1回1枚（resumable）で返り、done/remaining で進捗が分かること
  const r1 = await fetch(BASE + '/api/_ops/meta/ocr', {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ limit: 1 }),
  }).then((r) => r.json());
  ok(r1.success === true, 'OCR エンドポイントが成功で返る');
  ok(typeof r1.remaining === 'number' && typeof r1.done === 'boolean', 'OCR は done/remaining で再開可能');
  ok(Array.isArray(r1.items), 'OCR は処理した画像の内訳を返す');

  // 同じ画像を二度OCRしない（Vision呼び出しは有料なのでこれが崩れると課金が漏れ続ける）
  const r2 = await fetch(BASE + '/api/_ops/meta/ocr', {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ limit: 1 }),
  }).then((r) => r.json());
  const urls1 = (r1.items || []).map((i) => i.image_url);
  const urls2 = (r2.items || []).map((i) => i.image_url);
  ok(
    urls2.every((u) => !urls1.includes(u)),
    '同じ画像を二度OCRしない（処理済みは候補から除外される）'
  );

  // 抽出結果は要約材料として渡っていること
  const sm = await fetch(BASE + '/api/_ops/meta/summarize', {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ dry_run: true }),
  }).then((r) => r.json());
  ok(
    sm.evidence_counts && typeof sm.evidence_counts.ocr_jp === 'number',
    `OCR結果が要約材料に数えられる (ocr_jp=${sm.evidence_counts?.ocr_jp})`
  );

  // §1.3: 非公式画像のOCRは出典を表に出さない。
  // 公開レポートに非公式ドメインのURLや@ハンドルが出ていないこと。
  const rep = await fetch(BASE + '/api/meta/report').then((r) => r.json());
  const R = rep.report || {};
  const blob = [
    R.jp_summary, R.en_summary, R.diff_summary, R.upcoming_summary,
    ...(R.jp_topics || []).map((t) => `${t.title} ${t.body}`),
    ...(R.en_topics || []).map((t) => `${t.title} ${t.body}`),
    ...(R.spotlight_cards || []).map((s) => s.note || ''),
  ].filter(Boolean).join('\n');
  const OFFICIAL = ['takaratomy.co.jp', 'disneylorcana.com', 'ravensburgerplay.com'];
  const urls = blob.match(/https?:\/\/[^\s、。）)]+/g) || [];
  ok(
    urls.every((u) => OFFICIAL.some((h) => u.includes(h))),
    `本文中のURLは公式ドメインのみ (${urls.length}件検査)`
  );
  ok(!/@[A-Za-z0-9_]{2,}/.test(blob), '本文に @ハンドルが出ない（非公式の出典非表示）');
  ok(!/(x\.com|note\.com|twitter)/i.test(blob), '本文に非公式プラットフォーム名が出ない');
}

console.log('\n[8.6] レポートは全ブロック日本語で書かれる');
{
  // 実際に en_summary / en_topics が全文英語で出力される事故が起きたため回帰テスト化する。
  // フィールド名の "en_" は「海外の話題」の意味であり、英語で書く指示ではない。
  const jaRatio = (s) => {
    const t = String(s || '').replace(/https?:\/\/\S+/g, '').replace(/\s/g, '');
    if (!t.length) return 1;
    return (t.match(/[ぁ-んァ-ヶ一-龥]/g) || []).length / t.length;
  };
  const R = await fetch(BASE + '/api/meta/report').then((r) => r.json()).then((d) => d.report || {});

  for (const k of ['jp_summary', 'en_summary', 'diff_summary', 'upcoming_summary']) {
    const v = R[k] || '';
    if (!v) continue;
    ok(jaRatio(v) >= 0.15, `${k} が日本語で書かれている (和文比率 ${jaRatio(v).toFixed(2)})`);
  }
  for (const key of ['jp_topics', 'en_topics']) {
    for (const [i, t] of (R[key] || []).entries()) {
      const v = `${t.title || ''}${t.body || ''}`;
      if (v.replace(/\s/g, '').length < 12) continue;
      ok(jaRatio(v) >= 0.15, `${key}[${i}] が日本語で書かれている (和文比率 ${jaRatio(v).toFixed(2)})`);
    }
  }
  // 字数規定（仕様§1.2: 160〜300字）
  for (const k of ['jp_summary', 'en_summary', 'upcoming_summary']) {
    const n = String(R[k] || '').replace(/https?:\/\/\S+/g, '').replace(/\s/g, '').length;
    if (!n) continue;
    ok(n >= 160 && n <= 300, `${k} は規定字数 160〜300 に収まる (${n}字)`);
  }
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
