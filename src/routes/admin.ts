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
  COOKIE_NAME,
  SESSION_TTL,
  adminPassword,
  issueSession,
  readCookie,
  timingSafeEqual,
  verifySession,
} from '../lib/adminAuth';
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
import {
  COLLECT_ORDER,
  closeJob,
  collectJpDecksBySeason,
  rematchDeckCards,
  collectSocialDecks,
  collectOne,
  computeSnapshots,
  extractJpEvents,
  jstDateOf,
  jstToday,
  loadSources,
  openJob,
  type SourceRow,
} from '../lib/meta';
import { collectImageDecks } from '../lib/deckOcr';
import {
  buildKnowledgeRows,
  embedKnowledge,
  gatherEvidence,
  generateReport,
  loadReport,
  metaVectorsReady,
  upsertKnowledge,
} from '../lib/metaReport';
import {
  MEMORY_KINDS,
  memoryList,
  memoryOverview,
  memoryScopes,
  recallProbe,
  type MemoryKind,
} from '../lib/memoryBrowse';
import { ocrStats, runOcrBatch } from '../lib/ocr';

const admin = new Hono<{ Bindings: Bindings }>();

/** 1リクエストで処理するページ数。礼儀スリープ1.2s×5 + API応答 ≒ 8秒程度に収める */
const PAGES_PER_CALL = 5;

// ---------------------------------------------------------------- 認証基盤
// セッションの発行・検証は src/lib/adminAuth.ts に一本化している。
// 記憶層API（routes/memory.ts）も同じ実装を使うので、本番でも
// 管理画面のログインだけで記憶層の更新ができる。

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

// ---------------------------------------------------------------- 最新環境情報（meta）
/**
 * 日次パイプラインの4工程を個別エンドポイントに分けている理由:
 *   Workers には1リクエストあたりのCPU/実行時間の上限がある。
 *   「全ソース収集 → 集計 → LLM要約 → ベクトル化」を1回で回すと必ず超える。
 *   工程を分け、収集はさらに1ソースずつ処理して呼び出し側（cron）が
 *   順に叩く構造にすることで、途中で失敗しても再開できる。
 *
 *   collect（1ソース/回） → ocr（1画像/回） → aggregate → summarize → memory
 */

/**
 * POST /meta/collect  { source?: string, reset?: boolean }
 *
 * source 未指定なら「まだ今日収集していないソース」を1つ選んで処理する。
 * 呼び出し側は done=false の間、同じリクエストを繰り返す。
 */
admin.post('/meta/collect', async (c) => {
  const un = await requireAuth(c);
  if (un) return un;
  const db = c.env.DB;
  const body = await c.req.json().catch(() => ({}) as any);
  const only = body?.source ? String(body.source) : '';
  const reset = Boolean(body?.reset);

  const today = jstToday();

  // 収集対象の決定。COLLECT_ORDER の順に「今日まだ成功していない」ものを探す
  const all = await loadSources(db);
  const byKey = new Map(all.map((s) => [s.key, s]));
  const order = only ? [only] : (COLLECT_ORDER as readonly string[]);

  let target: SourceRow | undefined;
  const pending: string[] = [];
  for (const key of order) {
    const s = byKey.get(key);
    if (!s || !s.enabled) continue;
    // last_ok_at / checked_at は D1 の datetime('now')＝UTC。JST日付に直してから比較する
    // （直接比較すると JST 0:00〜9:00 の間は永遠に「未収集」と判定されてループする）
    //
    // checked_at も見るのは、失敗したソースを無限に選び直さないため。
    // 「今日1回でも試した」なら次へ進み、その日の再挑戦は明示的な reset/source 指定に任せる。
    const doneToday =
      !reset && !only
        ? (s.last_ok_at ? jstDateOf(s.last_ok_at) >= today : false) ||
          (s.checked_at ? jstDateOf(s.checked_at) >= today : false)
        : false;
    if (doneToday) continue;
    if (!target) target = s;
    else pending.push(key);
  }

  if (!target) {
    return c.json({ done: true, remaining: 0, message: '本日分の収集は完了しています' });
  }

  const jobId = await openJob(db, 'collect');
  const started = Date.now();
  // X 公式APIは有料プラン前提。TopDeck.gg も APIキー必須（かつ可視クレジット必須）。
  // どちらも未設定なら collectOne 側で「スキップ（成功扱い）」になるので日次ジョブは落ちない。
  const out = await collectOne(db, target, {
    xToken: (c.env as any).X_BEARER_TOKEN,
    topdeckKey: (c.env as any).TOPDECK_API_KEY,
  });
  const elapsed = Date.now() - started;

  await closeJob(db, jobId, {
    status: out.ok ? 'done' : 'failed',
    ok: out.ok ? 1 : 0,
    fail: out.ok ? 0 : 1,
    newItems: out.inserted,
    message: `${target.label}: ${out.ok ? 'OK' : 'NG'} status=${out.status} 新規${out.inserted} 更新${out.updated}`,
    detail: { ...out, elapsed_ms: elapsed },
  });
  await log(
    db,
    jobId,
    'meta_collect',
    out.ok ? 'info' : 'error',
    `環境情報収集 ${target.label}: 新規${out.inserted} / 更新${out.updated}`,
    out
  );

  return c.json({
    done: pending.length === 0,
    source: out.source,
    label: out.label,
    ok: out.ok,
    status: out.status,
    inserted: out.inserted,
    updated: out.updated,
    detail: out.detail ?? null,
    error: out.error ?? null,
    elapsed_ms: elapsed,
    remaining: pending.length,
    next: pending[0] ?? null,
  });
});

/**
 * POST /meta/decks/season  { season: string, max?: number, pages?: number }
 *
 * 弾（シーズン）を指定してデッキレシピをまとめて取り込む。
 *
 * 日次収集（/meta/collect）は sitemap の新着順なので「今の環境のデッキを揃える」
 * ことができない。弾が切り替わったときは、その弾のアーカイブから
 * まとめて取り込む操作が必要になるため専用の入口を用意する。
 *
 * Workers の実行時間に収めるため1回あたり max 件までにして、
 * 呼び出し側が remaining>0 の間くり返す（収集APIと同じ作法）。
 */
admin.post('/meta/decks/season', async (c) => {
  const un = await requireAuth(c);
  if (un) return un;
  const db = c.env.DB;
  const body = await c.req.json().catch(() => ({}) as any);
  const season = String(body?.season ?? '').trim();
  if (!season) return c.json({ error: 'season_required', message: 'season（シーズンslug）を指定してください' }, 400);

  const all = await loadSources(db);
  const src = all.find((s) => s.key === 'jp_community_deck');
  if (!src) return c.json({ error: 'source_missing', message: 'jp_community_deck が未登録です' }, 500);

  const jobId = await openJob(db, 'collect');
  const started = Date.now();
  const out = await collectJpDecksBySeason(db, src, {
    seasonSlug: season,
    maxDecks: Number(body?.max) || 8,
    maxPages: Number(body?.pages) || 12,
  });
  const elapsed = Date.now() - started;

  await closeJob(db, jobId, {
    status: out.status === 200 ? 'done' : 'failed',
    ok: out.status === 200 ? 1 : 0,
    fail: out.status === 200 ? 0 : 1,
    newItems: out.imported,
    message: `デッキ収集(${season}): 取込${out.imported} 除外${out.skipped} 残${out.remaining}`,
    detail: { ...out, elapsed_ms: elapsed },
  });
  await log(
    db,
    jobId,
    'meta_decks_season',
    out.status === 200 ? 'info' : 'error',
    `シーズン別デッキ収集 ${season}: 取込${out.imported} / 除外${out.skipped} / 残${out.remaining}`,
    out
  );

  return c.json({
    season,
    done: out.remaining === 0,
    found: out.found,
    imported: out.imported,
    skipped: out.skipped,
    remaining: out.remaining,
    rejected: out.rejected,
    status: out.status,
    elapsed_ms: elapsed,
  });
});

/** 取り込み済みデッキの未突合カードを、現在の突合ロジックで再照合する */
admin.post('/meta/decks/rematch', async (c) => {
  const un = await requireAuth(c);
  if (un) return un;
  const body = await c.req.json().catch(() => ({}) as any);
  const season = String(body?.season ?? '').trim() || undefined;
  const out = await rematchDeckCards(c.env.DB, { season });
  return c.json({ season: season ?? null, ...out });
});

/**
 * X / note の記事から公式デッキビルダーの共有リンクを見つけてデッキ化する。
 * 本文は保存せず、共有リンクに入ったカード構成だけを取り出す（仕様§1.3）。
 */
admin.post('/meta/decks/social', async (c) => {
  const un = await requireAuth(c);
  if (un) return un;
  const body = await c.req.json().catch(() => ({}) as any);
  const out = await collectSocialDecks(c.env.DB, {
    maxArticles: Number(body?.max) || 6,
    season: body?.season ? String(body.season) : undefined,
    sourceKeys: Array.isArray(body?.sourceKeys) && body.sourceKeys.length
      ? body.sourceKeys.map((x: unknown) => String(x))
      : undefined,
    // 記事URLを直接渡して狙い撃ちできる（収集一覧の順で埋もれる記事を試すため）
    urls: Array.isArray(body?.urls) && body.urls.length
      ? body.urls.map((x: unknown) => String(x))
      : undefined,
  });
  return c.json({ done: out.remaining === 0, ...out });
});

/**
 * X / note のデッキ「画像」を読んでデッキ化する。
 *
 * note / X は本文にデッキ表がなく、デッキは1枚の画像として貼られている。
 * 1記事あたり「画像数 × 段数」回 Vision を呼ぶので遅い。
 * 既定1記事/回とし、呼び出し側が done まで繰り返す。
 */
admin.post('/meta/decks/images', async (c) => {
  const un = await requireAuth(c);
  if (un) return un;
  const body = await c.req.json().catch(() => ({}) as any);
  const started = Date.now();
  const out = await collectImageDecks(c.env, c.env.DB, {
    maxArticles: Number(body?.max) || 1,
    maxImagesPerArticle: Number(body?.images) || 3,
    season: body?.season ? String(body.season) : undefined,
    sourceKeys: Array.isArray(body?.sourceKeys) && body.sourceKeys.length
      ? body.sourceKeys.map((x: unknown) => String(x))
      : undefined,
    // 記事URL直指定（デッキ表画像があると分かっている記事を狙い撃ちする）
    urls: Array.isArray(body?.urls) && body.urls.length
      ? body.urls.map((x: unknown) => String(x))
      : undefined,
    model: body?.model ? String(body.model) : undefined,
  });
  return c.json({ done: out.remaining === 0, ...out, elapsed_ms: Date.now() - started });
});

/**
 * POST /meta/aggregate
 * 収集済みデータからイベント抽出とメタシェア集計を行う（LLM不使用・決定的）。
 */
admin.post('/meta/aggregate', async (c) => {
  const un = await requireAuth(c);
  if (un) return un;
  const db = c.env.DB;
  const jobId = await openJob(db, 'aggregate');
  try {
    const ev = await extractJpEvents(db);
    const jp = await computeSnapshots(db, { region: 'jp', days: 60 });
    const en = await computeSnapshots(db, { region: 'en', days: 30 });
    const res = {
      events: ev.events,
      jp: { window: [jp.from, jp.to], rows: jp.rows.length },
      en: { window: [en.from, en.to], rows: en.rows.length },
    };
    await closeJob(db, jobId, {
      status: 'done',
      ok: 1,
      message: `集計完了: イベント${ev.events}件 / 日本${jp.rows.length}行 / 海外${en.rows.length}行`,
      detail: res,
    });
    await log(db, jobId, 'meta_aggregate', 'info', '環境情報の集計を更新', res);
    return c.json({ ok: true, ...res });
  } catch (e: any) {
    const msg = String(e?.message ?? e).slice(0, 300);
    await closeJob(db, jobId, { status: 'failed', fail: 1, message: msg });
    await log(db, jobId, 'meta_aggregate', 'error', `集計に失敗: ${msg}`);
    return c.json({ ok: false, error: msg }, 502);
  }
});

/**
 * POST /meta/summarize  { date?: string, dry_run?: boolean }
 *
 * LLM要約。失敗しても既存レポートは書き換えない（仕様§6: 前日データを維持）。
 */
admin.post('/meta/summarize', async (c) => {
  const un = await requireAuth(c);
  if (un) return un;
  const db = c.env.DB;
  const body = await c.req.json().catch(() => ({}) as any);
  const jobId = await openJob(db, 'summarize');
  try {
    const res = await generateReport(c.env, db, {
      reportDate: body?.date ? String(body.date) : undefined,
      dryRun: Boolean(body?.dry_run),
    });
    // 引用方針違反の除去は「起きたこと」として必ず記録する（黙って直さない）
    if (res.violations.length) {
      await log(
        db,
        jobId,
        'meta_summarize',
        'warn',
        `引用方針の自動修正 ${res.violations.length}件`,
        res.violations.slice(0, 50)
      );
    }
    if (res.lengthWarnings.length) {
      await log(db, jobId, 'meta_summarize', 'warn', '字数規定外のブロックあり', res.lengthWarnings);
    }
    await closeJob(db, jobId, {
      status: res.status === 'published' ? 'done' : 'failed',
      ok: res.status === 'published' ? 1 : 0,
      fail: res.status === 'published' ? 0 : 1,
      message:
        res.status === 'published'
          ? `${res.report_date} のレポートを生成（model=${res.model}）`
          : `生成せず: ${res.error ?? 'unknown'}（前回のレポートを維持）`,
      detail: res,
    });
    await log(
      db,
      jobId,
      'meta_summarize',
      res.status === 'published' ? 'info' : 'warn',
      `要約 ${res.report_date}: ${res.status}`,
      res.evidence_counts
    );
    return c.json(res);
  } catch (e: any) {
    const msg = String(e?.message ?? e).slice(0, 300);
    await closeJob(db, jobId, {
      status: 'failed',
      fail: 1,
      message: `要約に失敗（前回のレポートを維持）: ${msg}`,
    });
    await log(db, jobId, 'meta_summarize', 'error', `要約に失敗: ${msg}`);
    // 前日データが残っている限りフロントは表示を続けられるので 200 系では返さない
    return c.json({ ok: false, error: msg, kept_previous: true }, 502);
  }
});

/**
 * POST /meta/memory  { limit?: number }
 * レポート本文と集計を記憶層（meta_knowledge / meta_vectors）へ反映する。
 */
admin.post('/meta/memory', async (c) => {
  const un = await requireAuth(c);
  if (un) return un;
  const db = c.env.DB;
  const body = await c.req.json().catch(() => ({}) as any);
  const jobId = await openJob(db, 'memory');
  try {
    const report = await loadReport(db, body?.date ? String(body.date) : undefined);
    let inserted = 0;
    let skipped = 0;
    if (report) {
      const ev = await gatherEvidence(db, { reportDate: report.report_date });
      const rows = buildKnowledgeRows(report, ev, body?.season ? String(body.season) : null);
      const up = await upsertKnowledge(db, rows);
      inserted = up.inserted;
      skipped = up.skipped;
    }
    const emb = await embedKnowledge(c.env, db, { limit: Number(body?.limit) || 64 });
    const res = { report_date: report?.report_date ?? null, inserted, skipped, ...emb };
    await closeJob(db, jobId, {
      status: 'done',
      ok: 1,
      newItems: inserted,
      message: `記憶層更新: 新規${inserted}件 / ベクトル化${emb.embedded}件（残${emb.remaining}）`,
      detail: res,
    });
    await log(db, jobId, 'meta_memory', 'info', '環境情報を記憶層へ反映', res);
    return c.json({ ok: true, ...res });
  } catch (e: any) {
    const msg = String(e?.message ?? e).slice(0, 300);
    await closeJob(db, jobId, { status: 'failed', fail: 1, message: msg });
    await log(db, jobId, 'meta_memory', 'error', `記憶層更新に失敗: ${msg}`);
    return c.json({ ok: false, error: msg }, 502);
  }
});

/**
 * POST /meta/ocr  { limit?: number, days?: number, source?: string, retry_failed?: boolean }
 *
 * 収集済みの画像から文字を読む（仕様§9-3）。
 * 日本公式Xの告知は本文が短く、開催時刻・対象レベル・会場が画像内にしか無いため、
 * これを読まないと「明日以降の予定」ブロックが実質空になる。
 *
 * Vision呼び出しは1枚あたり数秒〜十数秒かかるので既定は1枚/回。
 * 呼び出し側は done=true になるまで繰り返す（collect と同じ作法）。
 */
admin.post('/meta/ocr', async (c) => {
  const un = await requireAuth(c);
  if (un) return un;
  const db = c.env.DB;
  const body = await c.req.json().catch(() => ({}) as any);

  const jobId = await openJob(db, 'ocr');
  const started = Date.now();
  try {
    const r = await runOcrBatch(c.env, db, {
      limit: Number(body?.limit) || 1,
      days: Number(body?.days) || undefined,
      sourceKey: body?.source ? String(body.source) : undefined,
      retryFailed: Boolean(body?.retry_failed),
    });
    const elapsed = Date.now() - started;
    await closeJob(db, jobId, {
      status: r.failed && !r.ok ? 'failed' : 'done',
      ok: r.ok + r.empty,
      fail: r.failed,
      newItems: r.ok,
      message: `画像OCR: 読取${r.ok}件 / 文字なし${r.empty}件 / 失敗${r.failed}件（残${r.remaining}）`,
      detail: { ...r, elapsed_ms: elapsed },
    });
    await log(
      db,
      jobId,
      'meta_ocr',
      r.failed && !r.ok ? 'error' : 'info',
      `画像OCR 読取${r.ok}件（残${r.remaining}）`,
      r
    );
    // r.ok は「読取に成功した枚数」なので、API の成否フラグとは別名で返す
    return c.json({ success: true, ...r, elapsed_ms: elapsed });
  } catch (e: any) {
    const msg = String(e?.message ?? e).slice(0, 300);
    await closeJob(db, jobId, { status: 'failed', fail: 1, message: msg });
    await log(db, jobId, 'meta_ocr', 'error', `画像OCRに失敗: ${msg}`);
    return c.json({ ok: false, error: msg }, 502);
  }
});

/** GET /meta/status — 管理画面用。公開APIより詳しく、失敗理由まで返す */
admin.get('/meta/status', async (c) => {
  const un = await requireAuth(c);
  if (un) return un;
  const db = c.env.DB;
  const counts = await metaVectorsReady(db);
  const today = jstToday();

  const q = async (sql: string, ...binds: unknown[]) => {
    try {
      const r = await db.prepare(sql).bind(...(binds as any[])).all();
      return (r.results ?? []) as any[];
    } catch {
      return [];
    }
  };
  const sources = await q(
    `SELECT key,label,region,kind,method,is_official,trust,enabled,
            last_status,last_ok_at,last_error,fail_streak,checked_at
       FROM meta_sources ORDER BY is_official DESC, key ASC`
  );
  const jobs = await q(
    `SELECT id,kind,status,ok_count,fail_count,new_items,message,started_at,finished_at
       FROM meta_jobs ORDER BY id DESC LIMIT 12`
  );
  const reports = await q(
    `SELECT report_date,status,sources_ok,sources_fail,freshest_at,model,generated_at
       FROM meta_reports ORDER BY report_date DESC LIMIT 7`
  );
  const raw = await q(
    `SELECT source_key, COUNT(*) AS n, MAX(observed_at) AS newest
       FROM meta_raw_items GROUP BY source_key ORDER BY n DESC`
  );
  const ocr = await ocrStats(db).catch(() => null);

  // 母数は「日次収集の対象（COLLECT_ORDER にあり、かつ有効）」に限定する。
  // 例: lorcast_api は enabled=1 だがカードデータ参照専用でコレクタを持たないため、
  //     全有効ソースを母数にすると永遠に 18/19 と表示され「失敗が1件ある」ように見えてしまう。
  const collectKeys = new Set(COLLECT_ORDER as readonly string[]);
  const targets = sources.filter(
    (s) => Number(s.enabled ?? 1) && collectKeys.has(String(s.key))
  );
  const collectedToday = targets.filter(
    (s) => s.last_ok_at && jstDateOf(s.last_ok_at) >= today
  ).length;

  return c.json({
    today,
    counts,
    collected_today: collectedToday,
    source_total: targets.length,
    sources,
    jobs,
    reports,
    raw_by_source: raw,
    ocr,
  });
});

// ============================ 記憶層ブラウザ（読み取り専用） ============================
//
// AIの回答品質は記憶層の中身で決まるが、記憶層はベクトル(BLOB)と要約テキストの塊で
// 外から見えない。不具合の切り分けができるよう、管理画面から覗けるようにする。
// 書き込み系は意図的に用意しない（記憶の更新は必ず既存パイプライン経由）。

/**
 * GET /memory/overview
 * 記憶層6系統のサマリと健全性（未ベクトル化・孤児ベクトルの検出）。
 */
admin.get('/memory/overview', async (c) => {
  const un = await requireAuth(c);
  if (un) return un;
  const db = c.env.DB;
  const [ov, scopes] = await Promise.all([memoryOverview(db), memoryScopes(db)]);
  return c.json({ success: true, ...ov, scopes });
});

/**
 * GET /memory/list?kind=&q=&scope=&offset=&limit=
 * 系統ごとの記憶を一覧する。ベクトルの生値は返さず健全性の指標のみ返す。
 */
admin.get('/memory/list', async (c) => {
  const un = await requireAuth(c);
  if (un) return un;
  const db = c.env.DB;
  const kind = String(c.req.query('kind') || 'meta_knowledge') as MemoryKind;
  if (!(MEMORY_KINDS as readonly string[]).includes(kind)) {
    return c.json({ error: 'bad_kind', allowed: MEMORY_KINDS }, 400);
  }
  const out = await memoryList(db, kind, {
    q: c.req.query('q') || '',
    scope: c.req.query('scope') || '',
    offset: Number(c.req.query('offset') || 0),
    limit: Number(c.req.query('limit') || 20),
  });
  return c.json({ success: true, ...out });
});

/**
 * POST /memory/recall  { query, top_k?, min_sim? }
 * 任意の質問文で「実際にどの記憶が引かれるか」を本番と同じ経路で再現する。
 * 一覧を見るだけでは届かない「なぜAIがこう答えたか」の切り分けに使う。
 */
admin.post('/memory/recall', async (c) => {
  const un = await requireAuth(c);
  if (un) return un;
  const db = c.env.DB;
  let body: Record<string, unknown> = {};
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }
  const query = String(body.query ?? '').trim().slice(0, 400);
  if (!query) return c.json({ error: 'empty_query', message: '質問文を入力してください' }, 400);

  try {
    const out = await recallProbe(c.env, db, query, {
      topK: Number(body.top_k) || 5,
      minSim: typeof body.min_sim === 'number' ? body.min_sim : undefined,
    });
    return c.json({ success: true, ...out });
  } catch (e: any) {
    const msg = e?.message || String(e);
    // AI未設定でも管理画面全体が落ちないよう、想起だけ失敗として返す
    return c.json({ error: 'recall_failed', message: msg }, e?.status === 503 ? 503 : 500);
  }
});

export default admin;
