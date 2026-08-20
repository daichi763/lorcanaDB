/**
 * deck.ts — デッキコード取り込みプロキシ（BUILD_SPEC §6.2）
 *
 * 公式のデッキコードはサーバ側DB参照が絡むためローカルで復号できない。
 * よって公式 `get-deck-cards` にサーバ側から投げ、結果をローカルDBの
 * カード詳細と突合して返す。
 *
 * 公式に迷惑をかけないための実装:
 *  - CSRFトークン + Cookie を 5 分キャッシュ（毎回 token.json を叩かない）
 *  - IP 毎レート制限: 60 秒に 10 回 / 24 時間 200 回（D1 に記録）
 *  - 403 → キャッシュ破棄して 1 回だけ自動リトライ
 *  - User-Agent を正直に名乗る
 */
import { Hono } from 'hono';
import type { Bindings } from '../types';
import { splitConcat } from '../lib/search';

const deck = new Hono<{ Bindings: Bindings }>();

const BASE = 'https://www.takaratomy.co.jp/products/disneylorcana';
const UA = 'LorcanaFanDB/0.1 (unofficial fan database; contact via site footer)';

/** Worker isolate 内のセッションキャッシュ（5分） */
let sessionCache: { token: string; cookie: string; at: number } | null = null;

async function getSession(force = false) {
  if (!force && sessionCache && Date.now() - sessionCache.at < 5 * 60_000) return sessionCache;

  const r = await fetch(`${BASE}/api1.0/card-search/token.json`, {
    method: 'POST',
    headers: { 'User-Agent': UA, Referer: `${BASE}/cardlist/` },
  });
  if (!r.ok) throw new Error(`token_status_${r.status}`);

  // Workers の fetch は getSetCookie を持つ
  const setCookie = (r.headers as any).getSetCookie?.() ?? [];
  const cookie = setCookie.map((c: string) => c.split(';')[0]).join('; ');
  const json = (await r.json()) as { csrf?: string };
  if (!json.csrf) throw new Error('csrf_missing');

  sessionCache = { token: json.csrf, cookie, at: Date.now() };
  return sessionCache;
}

// ---- レート制限 -----------------------------------------------------------
const WINDOW_SHORT = 60;          // 秒
const LIMIT_SHORT = 10;
const WINDOW_LONG = 24 * 60 * 60; // 秒
const LIMIT_LONG = 200;

async function ensureRateTable(db: D1Database) {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS rate_limit (
         ip TEXT NOT NULL, ts INTEGER NOT NULL
       )`
    )
    .run();
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_rate_ip_ts ON rate_limit(ip, ts)').run();
}

async function checkRate(db: D1Database, ip: string) {
  await ensureRateTable(db);
  const now = Math.floor(Date.now() / 1000);

  // 古い記録を掃除
  await db.prepare('DELETE FROM rate_limit WHERE ts < ?').bind(now - WINDOW_LONG).run();

  const short = await db
    .prepare('SELECT COUNT(*) AS n FROM rate_limit WHERE ip = ? AND ts >= ?')
    .bind(ip, now - WINDOW_SHORT)
    .first<{ n: number }>();
  if ((short?.n ?? 0) >= LIMIT_SHORT) {
    return { ok: false as const, retry_after: WINDOW_SHORT, scope: '60s' };
  }

  const long = await db
    .prepare('SELECT COUNT(*) AS n FROM rate_limit WHERE ip = ? AND ts >= ?')
    .bind(ip, now - WINDOW_LONG)
    .first<{ n: number }>();
  if ((long?.n ?? 0) >= LIMIT_LONG) {
    return { ok: false as const, retry_after: WINDOW_LONG, scope: '24h' };
  }

  await db.prepare('INSERT INTO rate_limit (ip, ts) VALUES (?, ?)').bind(ip, now).run();
  return { ok: true as const, remaining_short: LIMIT_SHORT - (short?.n ?? 0) - 1 };
}

// ---- デッキコード取り込み -------------------------------------------------
deck.post('/import', async (c) => {
  let body: { code?: unknown } = {};
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  const code = typeof body.code === 'string' ? body.code.trim().toUpperCase() : '';
  // 公式は Base32 系（map = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567='）
  if (!/^[A-Z2-9=]{4,64}$/.test(code)) {
    return c.json({ error: 'invalid_code', message: 'デッキコードの形式が正しくありません。' }, 400);
  }

  const ip =
    c.req.header('CF-Connecting-IP') ??
    c.req.header('X-Forwarded-For')?.split(',')[0].trim() ??
    'unknown';

  const rate = await checkRate(c.env.DB, ip);
  if (!rate.ok) {
    return c.json(
      {
        error: 'rate_limited',
        message: `リクエストが多すぎます（${rate.scope} 制限）。しばらく待って再試行してください。`,
        retry_after: rate.retry_after,
      },
      429,
      { 'Retry-After': String(rate.retry_after) }
    );
  }

  // 公式APIへ（403 のときだけ 1 回リトライ）
  const call = async (force: boolean) => {
    const s = await getSession(force);
    return fetch(`${BASE}/api1.0/card-search/get-deck-cards`, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-CSRF-Token': s.token,
        Cookie: s.cookie,
        Referer: `${BASE}/deckbuilder/`,
      },
      body: new URLSearchParams({ deck_code: code }),
    });
  };

  let res: Response;
  try {
    res = await call(false);
    if (res.status === 403) {
      sessionCache = null;
      res = await call(true);
    }
  } catch (e) {
    return c.json({ error: 'upstream_unreachable', message: '公式サーバに接続できませんでした。' }, 502);
  }

  if (res.status === 422) {
    return c.json({ error: 'code_not_found', message: 'そのデッキコードは公式に存在しないか、期限切れです。' }, 404);
  }
  if (res.status === 403) {
    return c.json({ error: 'token_expired_retry', message: 'トークンを取得できませんでした。少し待って再試行してください。' }, 503);
  }
  if (!res.ok) {
    return c.json({ error: 'upstream', status: res.status }, 502);
  }

  let json: any;
  try {
    json = await res.json();
  } catch {
    return c.json({ error: 'upstream_parse' }, 502);
  }

  const d = json.deck ?? json.data?.deck ?? null;
  if (!d) return c.json({ error: 'unexpected_shape', raw_keys: Object.keys(json ?? {}) }, 502);

  let entries: { card_file: string; card_num: number }[] = [];
  try {
    const parsed = typeof d.cards === 'string' ? JSON.parse(d.cards) : d.cards;
    entries = (parsed ?? []).map((x: any) => ({
      card_file: String(x.card_file),
      card_num: Number(x.card_num) || 0,
    }));
  } catch {
    return c.json({ error: 'deck_cards_parse' }, 502);
  }

  // ローカルDBから詳細をひく
  const files = entries.map((e) => e.card_file).filter(Boolean);
  let detail: Record<string, any> = {};
  if (files.length) {
    const rows = await c.env.DB.prepare(
      `SELECT c.id, c.card_file, c.card_name, c.version, c.card_type, c.ink_color, c.ink_color2,
              c.rarity, c.inkwell, c.ink_cost, c.strength, c.willpower, c.move_cost, c.lore_value,
              c.rules_text, c.sets_name, c.limit_card, c.image_url,
              (SELECT GROUP_CONCAT(cl.classification, '|') FROM classifications cl WHERE cl.card_id = c.id) AS classifications,
              (SELECT GROUP_CONCAT(ab.ability, '|') FROM abilities ab WHERE ab.card_id = c.id) AS abilities
         FROM cards c WHERE c.card_file IN (${files.map(() => '?').join(',')})`
    )
      .bind(...files)
      .all();
    for (const r of (rows.results ?? []) as any[]) {
      detail[r.card_file] = {
        ...r,
        classifications: splitConcat(r.classifications),
        abilities: splitConcat(r.abilities),
      };
    }
  }

  const unknown = files.filter((f) => !detail[f]);

  return c.json({
    code,
    ink_colors: typeof d.ink_color === 'string' ? d.ink_color.split(',').filter(Boolean) : [],
    total: entries.reduce((s, e) => s + e.card_num, 0),
    cards: entries.map((e) => ({ ...e, card: detail[e.card_file] ?? null })),
    unknown_card_files: unknown,
    warning: unknown.length
      ? '新カードが含まれています。DB 更新（scraper の差分取得）を実行してください。'
      : null,
  });
});

export default deck;
