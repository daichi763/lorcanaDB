/**
 * admin.ts — 隠し管理画面のAPI（データ更新）
 *
 * ■ 公開方針
 *   このアプリは一般公開される想定なので、更新ボタンは
 *   「普段は見つけられない場所」＋「パスワード必須」の二重で守る。
 *     1. 導線を張らない: nav / footer / sitemap にリンクを置かない
 *     2. 検索エンジンに拾わせない: robots.txt で Disallow、meta noindex
 *     3. URL を推測されにくくする: ADMIN_PATH（既定 /_ops）で変更可能
 *     4. パスワード認証: ADMIN_PASSWORD と照合し、署名付き Cookie を発行
 *     5. 総当たり対策: 失敗回数を数えてロックアウト
 *
 * ■ なぜ Cookie に HMAC 署名を使うか
 *   Workers は状態を持てないので、セッションを D1 に持つと更新のたびに
 *   書き込みが発生する。ここでは「有効期限つきの署名文字列」を Cookie に入れ、
 *   サーバ側は検証するだけにしている（ステートレス）。
 *   署名鍵は ADMIN_PASSWORD から導出するので、パスワードを変えれば全セッションが失効する。
 */
import { Hono } from 'hono';
import type { Bindings } from '../types';
import {
  PER_PAGE,
  applyCards,
  checkRuleSources,
  fetchRuleFaqs,
  loadClassSet,
  markRuleImported,
  openSession,
  politeSleep,
} from '../lib/updater';

const admin = new Hono<{ Bindings: Bindings }>();

/** セッションの有効期間（秒）。作業単位としては十分で、放置リスクは抑えたい */
const SESSION_TTL = 60 * 60 * 2;
const COOKIE_NAME = '__ops_sess';
/** 1リクエストで処理するページ数。礼儀スリープ1.2s×5 + API応答 ≒ 8秒程度に収める */
const PAGES_PER_CALL = 5;

// ---------------------------------------------------------------- 認証基盤

const enc = new TextEncoder();

const b64url = (buf: ArrayBuffer | Uint8Array) => {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

async function hmac(key: string, msg: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', k, enc.encode(msg)));
}

/** タイミング攻撃を避けるため、長さと内容を定数時間で比較する */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function adminPassword(env: Bindings): string | null {
  // ADMIN_PASSWORD が未設定なら ADMIN_TOKEN で代替（記憶層構築と同じ鍵で運用できる）
  const pw = (env as any).ADMIN_PASSWORD || (env as any).ADMIN_TOKEN || '';
  return pw ? String(pw) : null;
}

async function issueSession(env: Bindings): Promise<string> {
  const pw = adminPassword(env);
  if (!pw) throw new Error('no password configured');
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL;
  const payload = `v1.${exp}`;
  return `${payload}.${await hmac(pw, payload)}`;
}

async function verifySession(env: Bindings, token: string | null): Promise<boolean> {
  const pw = adminPassword(env);
  if (!pw || !token) return false;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return false;
  const exp = Number(parts[1]);
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return false;
  const expected = await hmac(pw, `v1.${exp}`);
  return timingSafeEqual(expected, parts[2]);
}

function readCookie(c: any, name: string): string | null {
  const raw = c.req.header('cookie') || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

/** 総当たり対策。失敗はメモリ上で数える（Workers のインスタンス単位でよい） */
const failures = new Map<string, { n: number; until: number }>();
const LOCK_THRESHOLD = 5;
const LOCK_MS = 10 * 60 * 1000;

function lockedOut(ip: string): number {
  const f = failures.get(ip);
  if (!f) return 0;
  if (f.until > Date.now()) return Math.ceil((f.until - Date.now()) / 1000);
  if (f.until && f.until <= Date.now()) failures.delete(ip);
  return 0;
}

function noteFailure(ip: string) {
  const f = failures.get(ip) ?? { n: 0, until: 0 };
  f.n++;
  if (f.n >= LOCK_THRESHOLD) {
    f.until = Date.now() + LOCK_MS;
    f.n = 0;
  }
  failures.set(ip, f);
}

const clientIp = (c: any) =>
  c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 'local';

/** 認証必須ルートのガード */
async function requireAuth(c: any): Promise<Response | null> {
  // ヘッダ経由（CLI/自動化用）でも入れるようにする
  const hdr = c.req.header('x-admin-token') || '';
  const pw = adminPassword(c.env);
  if (pw && hdr && timingSafeEqual(hdr, pw)) return null;
  if (await verifySession(c.env, readCookie(c, COOKIE_NAME))) return null;
  return c.json({ error: 'unauthorized' }, 401);
}

// ---------------------------------------------------------------- 共通

admin.use('*', async (c, next) => {
  // 管理APIは絶対にキャッシュ・インデックスさせない
  c.header('Cache-Control', 'no-store');
  c.header('X-Robots-Tag', 'noindex, nofollow, noarchive');
  try {
    await next();
  } catch (e: any) {
    console.error('[ADMIN_ERROR]', e?.constructor?.name, '|', String(e?.message ?? '').slice(0, 300));
    return c.json({ error: 'admin_failed', detail: String(e?.message ?? e).slice(0, 300) }, 502);
  }
});

async function log(
  db: D1Database,
  jobId: number | null,
  kind: string,
  level: 'info' | 'warn' | 'error',
  message: string,
  detail?: unknown
) {
  await db
    .prepare('INSERT INTO update_log (job_id, kind, level, message, detail) VALUES (?,?,?,?,?)')
    .bind(jobId, kind, level, message.slice(0, 500), detail ? JSON.stringify(detail).slice(0, 4000) : null)
    .run();
}

// ---------------------------------------------------------------- 認証API

admin.post('/login', async (c) => {
  const ip = clientIp(c);
  const wait = lockedOut(ip);
  if (wait > 0) return c.json({ error: 'locked', retry_after: wait }, 429);

  const pw = adminPassword(c.env);
  if (!pw) {
    return c.json(
      { error: 'not_configured', detail: 'ADMIN_PASSWORD が未設定です。wrangler pages secret put ADMIN_PASSWORD で設定してください。' },
      503
    );
  }

  const body = await c.req.json().catch(() => ({}) as any);
  const given = String(body?.password ?? '');
  if (!given || !timingSafeEqual(given, pw)) {
    noteFailure(ip);
    // どちらが違うか（未設定/不一致）を漏らさない
    return c.json({ error: 'invalid' }, 401);
  }

  failures.delete(ip);
  const token = await issueSession(c.env);
  const secure = new URL(c.req.url).protocol === 'https:' ? ' Secure;' : '';
  c.header(
    'Set-Cookie',
    `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly;${secure} SameSite=Strict; Max-Age=${SESSION_TTL}`
  );
  return c.json({ ok: true, expires_in: SESSION_TTL });
});

admin.post('/logout', async (c) => {
  c.header('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
  return c.json({ ok: true });
});

admin.get('/session', async (c) => {
  const ok = !!(await verifySession(c.env, readCookie(c, COOKIE_NAME)));
  return c.json({ authenticated: ok, configured: !!adminPassword(c.env) });
});

// ---------------------------------------------------------------- 状態確認

admin.get('/status', async (c) => {
  const un = await requireAuth(c);
  if (un) return un;
  const db = c.env.DB;

  const q = async <T = any>(sql: string, ...args: any[]) => {
    try {
      return await db.prepare(sql).bind(...args).first<T>();
    } catch {
      return null;
    }
  };
  const all = async (sql: string, ...args: any[]) => {
    try {
      const r = await db.prepare(sql).bind(...args).all();
      return (r.results ?? []) as any[];
    } catch {
      return [];
    }
  };

  const counts = await q<any>(`
    SELECT (SELECT COUNT(*) FROM cards)          AS cards,
           (SELECT COUNT(*) FROM rules_sections) AS rules,
           (SELECT COUNT(*) FROM faqs)           AS faqs,
           (SELECT COUNT(*) FROM classifications) AS classifications,
           (SELECT COUNT(*) FROM abilities)      AS abilities`);
  const ruleFaqs = await q<{ n: number }>('SELECT COUNT(*) AS n FROM rule_faqs');
  const vectors = await q<any>(`
    SELECT (SELECT COUNT(*) FROM card_vectors) AS cards,
           (SELECT COUNT(*) FROM rule_vectors) AS rules`);
  // faq_vectors はマイグレーション0004。未適用環境でも status を落とさないため個別に取る
  const faqVec = await q<{ n: number }>('SELECT COUNT(*) AS n FROM faq_vectors');
  const latestSet = await q<any>(
    'SELECT sets_name, sets_order, COUNT(*) AS n FROM cards GROUP BY sets_name ORDER BY sets_order DESC LIMIT 1'
  );
  const meta = await all("SELECT key, value FROM meta WHERE key IN ('cards_count','imported_at','updated_at')");
  const jobs = await all('SELECT * FROM update_jobs ORDER BY id DESC LIMIT 5');
  const logs = await all('SELECT id, job_id, kind, level, message, created_at FROM update_log ORDER BY id DESC LIMIT 20');
  const sources = await all('SELECT * FROM source_versions ORDER BY source');

  return c.json({
    counts: { ...(counts ?? {}), rule_faqs: Number(ruleFaqs?.n ?? 0) },
    vectors: { ...(vectors ?? {}), faqs: Number(faqVec?.n ?? 0) },
    latest_set: latestSet ?? null,
    meta: Object.fromEntries(meta.map((m) => [m.key, m.value])),
    jobs,
    logs,
    sources,
  });
});

// ---------------------------------------------------------------- カード更新

/**
 * カード更新は「ジョブを作って数ページずつ進める」方式。
 * 1リクエストで全件（25ページ・礼儀スリープ込みで30秒超）は Workers で回せない。
 *
 * POST /update/cards            → 新規ジョブ開始（既存の running があればそれを返す）
 * POST /update/cards {job_id}   → そのジョブを PAGES_PER_CALL ページ分進める
 */
admin.post('/update/cards', async (c) => {
  const un = await requireAuth(c);
  if (un) return un;
  const db = c.env.DB;
  const body = await c.req.json().catch(() => ({}) as any);
  let jobId = Number(body?.job_id) || 0;

  // --- ジョブの用意 ---
  if (!jobId) {
    const running = await db
      .prepare("SELECT id FROM update_jobs WHERE kind='cards' AND status='running' ORDER BY id DESC LIMIT 1")
      .first<{ id: number }>();
    if (running?.id) {
      jobId = Number(running.id);
    } else {
      const ins = await db
        .prepare("INSERT INTO update_jobs (kind, status, page) VALUES ('cards','running',1)")
        .run();
      jobId = Number(ins.meta.last_row_id);
      await log(db, jobId, 'cards', 'info', 'カード更新を開始');
    }
  }

  const job = await db.prepare('SELECT * FROM update_jobs WHERE id = ?').bind(jobId).first<any>();
  if (!job) return c.json({ error: 'job_not_found' }, 404);
  if (job.status !== 'running') return c.json({ job, done: true });

  const classSet = await loadClassSet(db);
  const session = await openSession();

  let page = Math.max(1, Number(job.page) || 1);
  let totalPages = Number(job.total_pages) || 0;
  let apiCount = Number(job.api_count) || 0;
  let seen = Number(job.seen) || 0;
  let inserted = Number(job.inserted) || 0;
  let updated = Number(job.updated) || 0;
  let unchanged = Number(job.unchanged) || 0;
  const newCards: any[] = [];

  try {
    for (let i = 0; i < PAGES_PER_CALL; i++) {
      if (totalPages && page > totalPages) break;
      if (i > 0) await politeSleep();

      const { count, cards } = await session.searchPageResilient(page);
      if (!totalPages) {
        apiCount = count;
        totalPages = Math.max(1, Math.ceil(count / PER_PAGE));
      }
      if (!cards.length) {
        totalPages = page - 1;
        break;
      }

      const res = await applyCards(db, cards, classSet);
      inserted += res.inserted;
      updated += res.updated;
      unchanged += res.unchanged;
      seen += cards.length;
      newCards.push(...res.newCards);
      page++;
    }
  } catch (e: any) {
    await db
      .prepare(
        `UPDATE update_jobs SET status='failed', message=?, updated_at=datetime('now'), finished_at=datetime('now')
          WHERE id = ?`
      )
      .bind(String(e?.message ?? e).slice(0, 300), jobId)
      .run();
    await log(db, jobId, 'cards', 'error', `取得失敗: ${String(e?.message ?? e).slice(0, 200)}`);
    return c.json({ error: 'fetch_failed', detail: String(e?.message ?? e).slice(0, 300), job_id: jobId }, 502);
  }

  if (newCards.length) {
    await log(
      db,
      jobId,
      'cards',
      'info',
      `新規カード ${newCards.length} 枚を追加`,
      newCards.slice(0, 50).map((n) => `${n.card_name}${n.version ? '・' + n.version : ''}(${n.sets ?? ''})`)
    );
  }

  const finished = totalPages > 0 && page > totalPages;
  await db
    .prepare(
      `UPDATE update_jobs
          SET page=?, total_pages=?, api_count=?, seen=?, inserted=?, updated=?, unchanged=?,
              status=?, message=?, updated_at=datetime('now'),
              finished_at=CASE WHEN ? THEN datetime('now') ELSE finished_at END
        WHERE id = ?`
    )
    .bind(
      page, totalPages, apiCount, seen, inserted, updated, unchanged,
      finished ? 'done' : 'running',
      finished ? `完了: 新規${inserted} / 更新${updated} / 変更なし${unchanged}` : `進行中 ${page - 1}/${totalPages}ページ`,
      finished ? 1 : 0,
      jobId
    )
    .run();

  if (finished) {
    // 件数メタを更新しておく（トップの表示や整合性確認に使う）
    const n = await db.prepare('SELECT COUNT(*) AS n FROM cards').first<{ n: number }>();
    await db
      .prepare(
        `INSERT INTO meta (key,value) VALUES ('cards_count',?),('updated_at',?)
           ON CONFLICT(key) DO UPDATE SET value=excluded.value`
      )
      .bind(String(n?.n ?? 0), new Date().toISOString())
      .run();
    await log(db, jobId, 'cards', 'info', `カード更新完了: 総数 ${n?.n ?? 0} / API申告 ${apiCount}`);
  }

  return c.json({
    job_id: jobId,
    done: finished,
    page,
    total_pages: totalPages,
    api_count: apiCount,
    seen,
    inserted,
    updated,
    unchanged,
    new_cards: newCards.slice(0, 20),
    progress: totalPages ? Math.min(100, Math.round(((page - 1) / totalPages) * 100)) : 0,
  });
});

/** 途中で止めたいとき（誤操作の取り消し） */
admin.post('/update/cancel', async (c) => {
  const un = await requireAuth(c);
  if (un) return un;
  const db = c.env.DB;
  const body = await c.req.json().catch(() => ({}) as any);
  const jobId = Number(body?.job_id) || 0;
  if (jobId) {
    await db
      .prepare("UPDATE update_jobs SET status='canceled', updated_at=datetime('now'), finished_at=datetime('now') WHERE id=? AND status='running'")
      .bind(jobId)
      .run();
  } else {
    await db
      .prepare("UPDATE update_jobs SET status='canceled', updated_at=datetime('now'), finished_at=datetime('now') WHERE status='running'")
      .run();
  }
  await log(db, jobId || null, 'cards', 'warn', '更新をキャンセル');
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- ルール更新

/**
 * ルールPDFの改定チェック。
 * PDF は 4MB あり pdftotext も Workers では動かないため、
 * ここでは「改定されたか」を検知して知らせるところまでを担当する。
 */
admin.post('/update/rules-check', async (c) => {
  const un = await requireAuth(c);
  if (un) return un;
  const db = c.env.DB;
  const checks = await checkRuleSources(db);
  const changed = checks.filter((x) => x.changed);
  await log(
    db,
    null,
    'rules_check',
    changed.length ? 'warn' : 'info',
    changed.length ? `ルール改定を検知: ${changed.map((x) => x.label).join(', ')}` : 'ルール改定なし',
    checks
  );
  return c.json({ checks, changed: changed.map((x) => x.source) });
});

/** 開発機でテキスト化を反映したあと、取り込み済みとして記録する */
admin.post('/update/rules-mark', async (c) => {
  const un = await requireAuth(c);
  if (un) return un;
  const body = await c.req.json().catch(() => ({}) as any);
  const source = String(body?.source ?? '');
  if (!source) return c.json({ error: 'source required' }, 400);
  await markRuleImported(c.env.DB, source);
  await log(c.env.DB, null, 'rules_check', 'info', `取り込み済みとして記録: ${source}`);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- Q&A更新

admin.post('/update/faqs', async (c) => {
  const un = await requireAuth(c);
  if (un) return un;
  const db = c.env.DB;
  const res = await fetchRuleFaqs(db);
  await log(db, null, 'faqs', 'info', `公式Q&A取得: ${res.fetched}件（新規${res.inserted} / 更新${res.updated}）`, res);
  return c.json(res);
});

export default admin;
