#!/usr/bin/env node
/**
 * test_admin.mjs — 隠し管理画面（データ更新）の動作・秘匿性・認証を検証
 *
 * 前提: pm2 で lorcana-fandb が起動しており、.dev.vars に
 *       ADMIN_PASSWORD=lorcana-ops-2026 / ADMIN_PATH=x7f2q9 が入っている。
 *
 * 検証の柱
 *  1. 秘匿性: 導線が無い・noindex・robots.txt Disallow・catch-all化していない
 *  2. 認証: 全書き込みAPIが401、誤パスワード拒否、署名改ざん拒否、Cookie属性
 *  3. 越境防止: 管理APIにCORS許可を出さない（通常APIとの差分も確認）
 *  4. 機能: 認証後に件数・ジョブ履歴・ルール文書の版が取得できる
 */
import { JSDOM } from 'jsdom';
const BASE = 'http://localhost:3000';
let pass = 0, fail = 0;
const ok = (c, m, extra='') => { c ? (pass++, console.log(`  ✅ ${m} ${extra}`)) : (fail++, console.log(`  ❌ ${m} ${extra}`)); };

// 1. ページが返る＆noindex
const res = await fetch(`${BASE}/_ops`);
const html = await res.text();
ok(res.status === 200, 'ページが表示される');
ok(/noindex/.test(html), 'meta robots に noindex がある');
ok(res.headers.get('x-robots-tag')?.includes('noindex'), 'X-Robots-Tag ヘッダがある');
ok(res.headers.get('cache-control') === 'no-store', 'キャッシュ無効');
ok(!/main-nav|site-footer/.test(html), '共通ナビ/フッターを含まない（導線なし）');
ok(/<title>maintenance<\/title>/.test(html), 'タイトルが目立たない');

// 2. 他ページから管理画面へのリンクが無いこと
for (const p of ['/', '/synergy', '/rules', '/about', '/deck']) {
  const h = await fetch(BASE + p).then(r => r.text());
  ok(!/_ops|x7f2q9/.test(h), `${p} に管理画面へのリンクが無い`);
}

// 3. robots.txt
const rb = await fetch(`${BASE}/robots.txt`).then(r => r.text());
ok(/Disallow: \/_ops/.test(rb), 'robots.txt で Disallow');

// 4. DOM構造
const dom = new JSDOM(html, { runScripts: 'outside-only' });
const d = dom.window.document;
ok(!!d.getElementById('op-login'), 'ログインフォームがある');
ok(d.getElementById('op-panel')?.classList.contains('hidden'), '管理パネルは初期状態で非表示');
ok(!!d.getElementById('op-btn-cards'), 'カード更新ボタンがある');
ok(!!d.getElementById('op-btn-rules'), 'ルール確認ボタンがある');
ok(!!d.getElementById('op-btn-faqs'), 'Q&A取得ボタンがある');
ok(!!d.getElementById('op-btn-memory'), '記憶層更新ボタンがある');
ok(d.getElementById('op-password')?.type === 'password', 'パスワード欄がマスクされる');

// 4-2. 記憶層ブラウザの部品が揃っている
// JS は要素IDで DOM を掴むので、markup 側でIDが1つ消えると機能が黙って死ぬ
for (const id of ['mem-overview','mem-recall-q','mem-btn-recall','mem-recall-out',
                  'mem-kind','mem-scope','mem-q','mem-btn-list','mem-list',
                  'mem-btn-prev','mem-page','mem-btn-next']) {
  ok(!!d.getElementById(id), `記憶層ブラウザの要素 #${id} がある`);
}
{
  const kinds = [...(d.getElementById('mem-kind')?.options ?? [])].map(o => o.value);
  ok(kinds.length === 6 && kinds.includes('meta_knowledge') && kinds.includes('faq_vectors'),
     '系統プルダウンに6系統がある', `(${kinds.join(',')})`);
}

// 5. 認証ガード（全書き込みAPI）
for (const p of ['/status','/update/cards','/update/rules-check','/update/faqs','/update/cancel','/update/rules-mark']) {
  const m = p === '/status' ? 'GET' : 'POST';
  const r = await fetch(`${BASE}/api/_ops${p}`, { method: m, headers: {'Content-Type':'application/json'}, body: m==='POST'?'{}':undefined });
  ok(r.status === 401, `未認証で ${p} が401`, `(${r.status})`);
}

// 6. 誤ったパスワード
const bad = await fetch(`${BASE}/api/_ops/login`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:'nope'})});
ok(bad.status === 401, '誤パスワードは401');
ok(!bad.headers.get('set-cookie'), '誤パスワードでCookieを発行しない');

// 7. 正しいパスワード → Cookie属性
const good = await fetch(`${BASE}/api/_ops/login`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:'lorcana-ops-2026'})});
const setc = good.headers.get('set-cookie') || '';
ok(good.status === 200, '正パスワードで認証成功');
ok(/HttpOnly/i.test(setc), 'Cookie が HttpOnly');
ok(/SameSite=Strict/i.test(setc), 'Cookie が SameSite=Strict');
const cookie = setc.split(';')[0];

// 8. 認証後は通る
const st = await fetch(`${BASE}/api/_ops/status`, { headers: { Cookie: cookie } });
const sj = await st.json();
ok(st.status === 200, '認証後は状態取得できる');
ok(sj.counts.cards === 2500, `カード数が取れる (${sj.counts.cards})`);
ok(sj.counts.rules === 463, `ルール節数が取れる (${sj.counts.rules})`);
ok(sj.counts.rule_faqs === 79, `公式Q&A数が取れる (${sj.counts.rule_faqs})`);
ok(Array.isArray(sj.jobs) && sj.jobs.length >= 2, `ジョブ履歴が取れる (${sj.jobs.length})`);
ok(Array.isArray(sj.sources) && sj.sources.length === 4, `ルール文書の版が取れる (${sj.sources?.length})`);

// 9. 改ざんCookieを弾く
const tampered = cookie.replace(/.$/, 'X');
const tv = await fetch(`${BASE}/api/_ops/status`, { headers: { Cookie: tampered } });
ok(tv.status === 401, '署名を改ざんしたCookieは拒否');

// 10. ヘッダトークンでも入れる（自動化用）
const ht = await fetch(`${BASE}/api/_ops/status`, { headers: { 'x-admin-token': 'lorcana-ops-2026' } });
ok(ht.status === 200, 'x-admin-token でも認証できる');
const hw = await fetch(`${BASE}/api/_ops/status`, { headers: { 'x-admin-token': 'wrong-token-value' } });
ok(hw.status === 401, '誤ったトークンは拒否');

// 11. ログアウト
const lo = await fetch(`${BASE}/api/_ops/logout`, {method:'POST', headers:{Cookie:cookie}});
ok(/Max-Age=0/.test(lo.headers.get('set-cookie')||''), 'ログアウトでCookieを失効');

// 12. CORS が付いていない（他サイトから叩けない）
const co = await fetch(`${BASE}/api/_ops/session`, { headers: { Origin: 'https://evil.example' } });
ok(!co.headers.get('access-control-allow-origin'), '管理APIにCORS許可ヘッダが無い');
const co2 = await fetch(`${BASE}/api/cards?posts_per_page=1`, { headers: { Origin: 'https://evil.example' } });
ok(!!co2.headers.get('access-control-allow-origin'), '通常APIにはCORSが付く（差分の確認）');

// 13. ADMIN_PATH の別URL
const alt = await fetch(`${BASE}/x7f2q9`);
ok(alt.status === 200 && /op-login-form/.test(await alt.text()), 'ADMIN_PATH の別URLでも開ける');
const nf = await fetch(`${BASE}/zzz-not-exist`);
ok(nf.status === 404, '無関係なパスは404（catch-allになっていない）');

// 13-2. 認証ガードの網羅（ルートを増やしたときに requireAuth を書き忘れる事故を防ぐ）
// 実際に /memory/* で書き忘れが起きたので、以後は全ルートを機械的に確認する。
console.log('\n[13-2] 全管理APIの認証ガード');
{
  // 公開して良いのは「ログイン」「ログアウト」「認証状態の問い合わせ」だけ
  const PUBLIC = ['/login', '/logout', '/session'];
  const ROUTES = [
    ['GET','/session'], ['GET','/status'],
    ['POST','/update/cards'], ['POST','/update/cancel'], ['POST','/update/rules-check'],
    ['POST','/update/rules-mark'], ['POST','/update/faqs'],
    ['POST','/meta/collect'], ['POST','/meta/aggregate'], ['POST','/meta/summarize'],
    ['POST','/meta/memory'], ['POST','/meta/ocr'], ['GET','/meta/status'],
    ['GET','/memory/overview'], ['GET','/memory/list'], ['POST','/memory/recall'],
  ];
  for (const [m, p] of ROUTES) {
    const r = await fetch(`${BASE}/api/_ops${p}`, {
      method: m, headers: { 'Content-Type': 'application/json' },
      body: m === 'POST' ? '{}' : undefined,
    });
    if (PUBLIC.includes(p)) ok(r.status === 200, `${p} は未認証でも応答（公開ルート）`, `(${r.status})`);
    else ok(r.status === 401, `${m} ${p} は未認証で401`, `(${r.status})`);
  }
}

// 14. 記憶層ブラウザAPI
// 記憶層は「AIが何を根拠に答えるか」そのものなので、未認証で覗けてはいけない。
// また、読み取り専用であること（書き込み口が無いこと）も確認する。
console.log('\n[14] 記憶層ブラウザAPI');
{
  // 14-1. 未認証は401
  for (const [p, m] of [['/memory/overview','GET'], ['/memory/list?kind=meta_knowledge','GET'], ['/memory/recall','POST']]) {
    const r = await fetch(`${BASE}/api/_ops${p}`, {
      method: m, headers: {'Content-Type':'application/json'},
      body: m === 'POST' ? JSON.stringify({query:'テスト'}) : undefined,
    });
    ok(r.status === 401, `未認証で ${p} が401`, `(${r.status})`);
  }

  // 認証取り直し（11でログアウトしているため）
  const lg = await fetch(`${BASE}/api/_ops/login`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:'lorcana-ops-2026'})});
  const ck = (lg.headers.get('set-cookie') || '').split(';')[0];
  const get = (p) => fetch(`${BASE}/api/_ops${p}`, { headers: { Cookie: ck } }).then(r => r.json().then(j => ({ status: r.status, j })));

  // 14-2. 概要
  const { j: ov } = await get('/memory/overview');
  ok(Array.isArray(ov.kinds) && ov.kinds.length === 6, '概要が6系統を返す', `(${ov.kinds?.length})`);
  ok(typeof ov.health?.ok === 'boolean' && Array.isArray(ov.health?.issues), '健全性(ok/issues)を返す');
  ok(Array.isArray(ov.scopes) && ov.scopes.length > 0, '区分一覧を返す', `(${(ov.scopes||[]).map(s=>s.scope).join(',')})`);
  {
    // 未ベクトル化・孤児が出たら AI が引けない記憶があるということ。0でなければ検知したい
    const dirty = (ov.kinds || []).filter(k => Number(k.missing || 0) || Number(k.orphans || 0));
    ok(dirty.length === 0, '未ベクトル化・孤児ベクトルが0件',
       dirty.length ? `(${dirty.map(k=>`${k.kind}:欠${k.missing}/余${k.orphans}`).join(' ')})` : '');
    ok(ov.health.ok === (dirty.length === 0), 'health.ok が実データと整合する');
  }

  // 14-3. 全系統の一覧が引ける
  const KINDS = ['meta_knowledge','ability_knowledge','synergy_memory','card_vectors','rule_vectors','faq_vectors'];
  for (const k of KINDS) {
    const { j } = await get(`/memory/list?kind=${k}&limit=3`);
    ok(j.kind === k && Number(j.total) > 0 && Array.isArray(j.items) && j.items.length > 0,
       `${k} の一覧が引ける`, `(total=${j.total} items=${j.items?.length})`);
  }

  // 14-4. ベクトル系は生値(BLOB)を返さない（1KB×2500を画面に流さないため）
  for (const k of ['card_vectors','rule_vectors','faq_vectors']) {
    const { j } = await get(`/memory/list?kind=${k}&limit=2`);
    const it = j.items[0] || {};
    ok(!('vec' in it), `${k} は vec(BLOB) を返さない`);
    ok(it.dims === 256 && it.dims_ok === true, `${k} は256次元`, `(${it.dims})`);
    ok(it.norm_ok === true && it.norm > 0.5 && it.norm < 1.5, `${k} のノルムが正常`, `(${it.norm})`);
  }

  // 14-5. 不正な系統は弾く（SQL組み立てにユーザ入力を通していないことの確認）
  const badKind = await fetch(`${BASE}/api/_ops/memory/list?kind=cards`, { headers: { Cookie: ck } });
  const bkj = await badKind.json();
  ok(badKind.status === 400 && bkj.error === 'bad_kind', '未知の系統は400 bad_kind', `(${badKind.status}/${bkj.error})`);
  ok(Array.isArray(bkj.allowed) && bkj.allowed.length === 6, 'エラー時に許可系統を返す');

  // 14-6. ページング
  const p1 = (await get('/memory/list?kind=meta_knowledge&limit=5&offset=0')).j;
  const p2 = (await get('/memory/list?kind=meta_knowledge&limit=5&offset=5')).j;
  ok(p1.items.length === 5 && p2.items.length === 5, 'limit が効く');
  ok(p1.total === p2.total, 'total は offset に依らず同じ', `(${p1.total})`);
  ok(!p1.items.some(a => p2.items.some(b => b.id === a.id)), 'ページ間で行が重複しない');
  // 上限を超える limit は丸められる（1回のレスポンスを爆発させないため）
  const big = (await get('/memory/list?kind=card_vectors&limit=9999')).j;
  ok(big.limit === 100 && big.items.length === 100, 'limit は100で打ち止め', `(${big.limit})`);

  // 14-7. 絞り込み
  const ev = (await get('/memory/list?kind=meta_knowledge&scope=event&limit=50')).j;
  ok(ev.items.length > 0 && ev.items.every(i => i.scope === 'event'), 'scope 絞り込みが効く', `(${ev.total}件)`);
  const q = (await get('/memory/list?kind=faq_vectors&q=' + encodeURIComponent('デッキ'))).j;
  ok(Number(q.total) > 0, '本文検索が効く', `(${q.total}件)`);

  // 14-8. 環境知識はベクトル整合(text_hash一致)を返す
  const mk = (await get('/memory/list?kind=meta_knowledge&limit=28')).j;
  ok(mk.items.every(i => typeof i.vector_ok === 'boolean'), '環境知識は vector_ok を返す');
  ok(mk.items.every(i => i.vector_ok === true), '全ての環境知識がベクトル化済み（AIから引ける）');

  // 14-9. 想起の再現
  const rc = await fetch(`${BASE}/api/_ops/memory/recall`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ck },
    body: JSON.stringify({ query: '次のイベントはいつ開催される？', top_k: 3 }),
  });
  if (rc.status === 503) {
    // 埋め込みAPIキーが無い環境では飛ばす（CIで落とさない）
    ok(true, '想起の再現: 埋め込みAPI未設定のためスキップ');
  } else {
    const rj = await rc.json();
    ok(rc.status === 200, '想起の再現が200', `(${rc.status})`);
    ok(['meta','cards','rules','faqs'].every(k => Array.isArray(rj[k])), '4区分すべて配列で返す');
    ok(rj.model === 'text-embedding-3-small', '本番と同じ埋め込みモデル', `(${rj.model})`);
    ok(rj.meta.length > 0 && rj.meta.every(m => m.sim >= 0 && m.sim <= 1), '環境知識が類似度付きで引ける');
    // 類似度降順でないと「なぜこの記憶が使われたか」の説明にならない
    const desc = (a) => a.every((x, i) => i === 0 || a[i-1].sim >= x.sim);
    ok(['meta','cards','rules','faqs'].every(k => desc(rj[k])), '各区分が類似度の降順');
    ok(rj.meta.length <= 3 && rj.cards.length <= 3, 'top_k が効く');
    ok(rj.cards.every(c => c.name && !/^\(id=/.test(c.name)), 'カード名が解決されている（idのままでない）');
  }

  // 14-10. 空の質問
  const empty = await fetch(`${BASE}/api/_ops/memory/recall`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ck },
    body: JSON.stringify({ query: '   ' }),
  });
  ok(empty.status === 400, '空の質問は400', `(${empty.status})`);

  // 14-11. 読み取り専用（書き込み口を作っていない）
  // 記憶の更新は既存の再構築パイプライン経由に限る。ここから壊せてはいけない
  for (const p of ['/memory/overview', '/memory/list']) {
    const w = await fetch(`${BASE}/api/_ops${p}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ck }, body: '{}',
    });
    ok(w.status === 404 || w.status === 405, `${p} に POST 口が無い`, `(${w.status})`);
  }
  const del = await fetch(`${BASE}/api/_ops/memory/list?kind=meta_knowledge`, { method: 'DELETE', headers: { Cookie: ck } });
  ok(del.status === 404 || del.status === 405, 'DELETE 口が無い', `(${del.status})`);
}

console.log(`\n  ${pass}/${pass+fail} passed`);
process.exit(fail ? 1 : 0);
