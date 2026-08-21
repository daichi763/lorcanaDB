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

console.log(`\n  ${pass}/${pass+fail} passed`);
process.exit(fail ? 1 : 0);
