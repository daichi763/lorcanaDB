/**
 * meta.ts — 「最新環境情報」公開API
 *
 * 読み取り専用。認証不要。
 *
 * 設計方針:
 *   1. 公開APIから非公式URLを漏らさない。
 *      レポート本文は保存時にサニタイズ済みだが、デッキ以外の経路では
 *      source_url を返さない（デッキだけが仕様§1.3の出典明記の例外）。
 *   2. 当日分のレポートが無ければ直近分を stale=true で返す（仕様§6）。
 *      フロントは「最終更新」表示でユーザーに鮮度を伝える。
 *   3. デッキタブに出すのは playable_jp=1 のみ（ユーザー仕様）。
 *   4. Cache-Control を付けてエッジキャッシュに載せる（1日1更新なので長めでよい）。
 */
import { Hono } from 'hono';
import type { Bindings } from '../types';
import { loadReport, metaVectorsReady } from '../lib/metaReport';
import { jstToday, jstNow } from '../lib/meta';

const meta = new Hono<{ Bindings: Bindings }>();

/** 公開レスポンスは 10 分キャッシュ（更新は1日1回なので十分） */
meta.use('*', async (c, next) => {
  await next();
  if (c.res.status === 200) {
    c.header('Cache-Control', 'public, max-age=600, stale-while-revalidate=3600');
  }
});

const num = (v: unknown, def: number, max: number): number => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(Math.floor(n), max);
};

// ============================ 日次レポート ============================
/**
 * GET /api/meta/report?date=YYYY-MM-DD
 * トップページ左ウィジェットと /meta ページの本体。
 */
meta.get('/report', async (c) => {
  const date = c.req.query('date') || undefined;
  const report = await loadReport(c.env.DB, date);
  if (!report) {
    return c.json({
      report: null,
      today: jstToday(),
      now: jstNow(),
      message: 'no_report_yet',
    });
  }
  return c.json({ report, today: jstToday(), now: jstNow() });
});

// ============================ メタ集計 ============================
/**
 * GET /api/meta/snapshot?region=jp|en&kind=ink_pair|archetype|card
 * 最新ウィンドウの集計を rank 順で返す。
 */
meta.get('/snapshot', async (c) => {
  const region = c.req.query('region') === 'en' ? 'en' : 'jp';
  const kindQ = String(c.req.query('kind') || 'ink_pair');
  const kind = ['ink_pair', 'archetype', 'card'].includes(kindQ) ? kindQ : 'ink_pair';
  const limit = num(c.req.query('limit'), 8, 40);

  try {
    // 同じ窓に複数の由来（初期シード / 実測集計 / 自前デッキ集計）が同居しうる。
    // 混ぜると同じインクペアが二重に出て数値が矛盾するので、
    // 「最も新しく計算された1系統」だけを選び、その detail を丸ごと返す。
    const head = await c.env.DB.prepare(
      `SELECT window_from, window_to, computed_at, detail FROM meta_snapshots
        WHERE region = ? AND kind = ? ORDER BY computed_at DESC, id DESC LIMIT 1`
    )
      .bind(region, kind)
      .first<{ window_from: string; window_to: string; computed_at: string; detail: string | null }>();
    if (!head) return c.json({ region, kind, window: null, rows: [] });

    // 選ばれた系統の識別子。detail.source が無い場合は空文字として扱う
    let headSource = '';
    try {
      headSource = String((JSON.parse(String(head.detail ?? '{}')) || {}).source ?? '');
    } catch {
      headSource = '';
    }

    const rows = await c.env.DB.prepare(
      `SELECT label, deck_count, weighted, share, rank, share_delta, detail
         FROM meta_snapshots
        WHERE region = ? AND kind = ? AND window_to = ?
          AND (? = '' OR detail LIKE ?)
        ORDER BY rank ASC LIMIT ?`
    )
      .bind(region, kind, head.window_to, headSource, `%"${headSource}"%`, limit)
      .all();

    return c.json({
      region,
      kind,
      window: { from: head.window_from, to: head.window_to, computed_at: head.computed_at },
      rows: ((rows.results ?? []) as any[]).map((r) => ({
        label: String(r.label ?? ''),
        deck_count: Number(r.deck_count ?? 0),
        share: Number(r.share ?? 0),
        rank: r.rank == null ? null : Number(r.rank),
        share_delta: r.share_delta == null ? null : Number(r.share_delta),
        detail: (() => {
          try {
            return r.detail ? JSON.parse(String(r.detail)) : null;
          } catch {
            return null;
          }
        })(),
      })),
    });
  } catch {
    return c.json({ region, kind, window: null, rows: [] });
  }
});

// ============================ イベント（カウントダウン） ============================
/**
 * GET /api/meta/events?scope=upcoming|recent
 * 公式URLを持つものだけ url を返す（非公式イベント情報はURLを返さない）。
 */
meta.get('/events', async (c) => {
  const scope = c.req.query('scope') === 'recent' ? 'recent' : 'upcoming';
  const limit = num(c.req.query('limit'), 8, 30);
  const today = jstToday();

  const sql =
    scope === 'upcoming'
      ? `SELECT id,name,region,scale,held_on,players,season,is_official,source_url,note
           FROM meta_events WHERE held_on >= ? ORDER BY held_on ASC LIMIT ?`
      : `SELECT id,name,region,scale,held_on,players,season,is_official,source_url,note
           FROM meta_events WHERE held_on < ? ORDER BY held_on DESC LIMIT ?`;

  try {
    const rows = await c.env.DB.prepare(sql).bind(today, limit).all();
    const list = ((rows.results ?? []) as any[]).map((r) => {
      const held = r.held_on ? String(r.held_on) : null;
      const days =
        held == null
          ? null
          : Math.round(
              (Date.parse(`${held}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000
            );
      return {
        id: Number(r.id),
        name: String(r.name ?? ''),
        region: String(r.region ?? 'jp'),
        scale: r.scale ? String(r.scale) : null,
        held_on: held,
        players: r.players == null ? null : Number(r.players),
        season: r.season ? String(r.season) : null,
        is_official: Number(r.is_official ?? 0),
        // 公式のみリンクを返す（仕様§1.3）
        url: Number(r.is_official ?? 0) && r.source_url ? String(r.source_url) : null,
        note: r.note ? String(r.note) : null,
        days_until: days,
      };
    });
    return c.json({ scope, today, events: list });
  } catch {
    return c.json({ scope, today, events: [] });
  }
});

// ============================ デッキ一覧 ============================
/**
 * GET /api/meta/decks
 *   ?jp_only=1   日本で組めるものだけ（デッキタブの既定）
 *   ?region=jp|en&ink=アンバー&limit=&offset=
 *
 * デッキは出典URLを明記する（仕様§1.3の例外）。
 */
meta.get('/decks', async (c) => {
  const limit = num(c.req.query('limit'), 20, 60);
  const offset = Math.max(0, Number(c.req.query('offset') || 0) | 0);
  const jpOnly = c.req.query('jp_only') !== '0';
  const region = c.req.query('region');
  const ink = c.req.query('ink');

  const where: string[] = ['total_cards > 0'];
  const binds: unknown[] = [];
  if (jpOnly) where.push('playable_jp = 1');
  if (region === 'jp' || region === 'en') {
    where.push('region = ?');
    binds.push(region);
  }
  if (ink) {
    where.push('(ink1 = ? OR ink2 = ?)');
    binds.push(ink, ink);
  }
  const whereSql = where.join(' AND ');

  try {
    const total = await c.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM meta_decks WHERE ${whereSql}`
    )
      .bind(...(binds as any[]))
      .first<{ n: number }>();

    const rows = await c.env.DB.prepare(
      `SELECT id, deck_key, name, archetype, region, ink1, ink2, player, placement,
              weight, event_name, season, total_cards, playable_jp,
              source_url, source_label, observed_at
         FROM meta_decks WHERE ${whereSql}
        ORDER BY COALESCE(observed_at, fetched_at) DESC, weight DESC, id DESC
        LIMIT ? OFFSET ?`
    )
      .bind(...(binds as any[]), limit, offset)
      .all();

    return c.json({
      total: Number(total?.n ?? 0),
      limit,
      offset,
      decks: ((rows.results ?? []) as any[]).map(shapeDeck),
    });
  } catch {
    return c.json({ total: 0, limit, offset, decks: [] });
  }
});

function shapeDeck(r: Record<string, any>) {
  return {
    id: Number(r.id),
    deck_key: String(r.deck_key ?? ''),
    name: String(r.name ?? ''),
    archetype: r.archetype ? String(r.archetype) : null,
    region: String(r.region ?? 'jp'),
    ink1: r.ink1 ? String(r.ink1) : null,
    ink2: r.ink2 ? String(r.ink2) : null,
    player: r.player ? String(r.player) : null,
    placement: r.placement ? String(r.placement) : null,
    weight: Number(r.weight ?? 1),
    event_name: r.event_name ? String(r.event_name) : null,
    season: r.season ? String(r.season) : null,
    total_cards: Number(r.total_cards ?? 0),
    playable_jp: Number(r.playable_jp ?? 0),
    // デッキは出典明記が必須（仕様§1.3の例外）
    source_url: r.source_url ? String(r.source_url) : null,
    source_label: r.source_label ? String(r.source_label) : null,
    observed_at: r.observed_at ? String(r.observed_at) : null,
  };
}

/**
 * GET /api/meta/decks/:id
 * カードごとに自前DBの画像・コストを結合して返す（フロントでカード画像を出すため）。
 */
meta.get('/decks/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isFinite(id) || id <= 0) return c.json({ error: 'invalid_id' }, 400);

  try {
    const deck = await c.env.DB.prepare(
      `SELECT id, deck_key, name, archetype, region, ink1, ink2, player, placement,
              weight, event_name, season, total_cards, playable_jp, missing_cards,
              source_url, source_label, observed_at
         FROM meta_decks WHERE id = ?`
    )
      .bind(id)
      .first<any>();
    if (!deck) return c.json({ error: 'not_found' }, 404);

    const rows = await c.env.DB.prepare(
      `SELECT dc.qty, dc.card_name, dc.raw_name, dc.card_id,
              c.card_file, c.card_name AS db_name, c.card_group, c.image_url,
              c.ink_cost, c.ink_color, c.card_type, c.rarity, c.lore_value
         FROM meta_deck_cards dc
         LEFT JOIN cards c ON c.id = dc.card_id
        WHERE dc.deck_id = ?
        ORDER BY COALESCE(c.ink_cost, 99) ASC, dc.card_name ASC`
    )
      .bind(id)
      .all();

    const cards = ((rows.results ?? []) as any[]).map((r) => ({
      qty: Number(r.qty ?? 1),
      // 突合できていれば日本語版正式名称（card_group）を優先（仕様§4.2）
      name: String(r.card_group || r.db_name || r.card_name || ''),
      raw_name: r.raw_name ? String(r.raw_name) : null,
      card_id: r.card_id == null ? null : Number(r.card_id),
      card_file: r.card_file ? String(r.card_file) : null,
      image_url: r.image_url ? String(r.image_url) : null,
      ink_cost: r.ink_cost == null ? null : Number(r.ink_cost),
      ink_color: r.ink_color ? String(r.ink_color) : null,
      card_type: r.card_type ? String(r.card_type) : null,
      rarity: r.rarity ? String(r.rarity) : null,
      lore_value: r.lore_value == null ? null : Number(r.lore_value),
      matched: r.card_id != null,
    }));

    let missing: string[] = [];
    try {
      missing = deck.missing_cards ? JSON.parse(String(deck.missing_cards)) : [];
    } catch {
      missing = [];
    }

    return c.json({
      deck: { ...shapeDeck(deck), missing_cards: missing },
      cards,
      total_qty: cards.reduce((s, x) => s + x.qty, 0),
    });
  } catch {
    return c.json({ error: 'server_error' }, 500);
  }
});

// ============================ 帰属表示（クレジット必須ソース） ============================
/**
 * GET /api/meta/credits
 *
 * 仕様§1.3 は「非公式ソースは表示上クレジットしない」が原則だが、
 * 利用規約で可視クレジットが必須のソース（例: TopDeck.gg の Attribution Required）は
 * デッキレシピ欄と同じ扱いの「例外」として、専用の帰属表示欄に常時掲出する。
 * まとめ本文の文体は§1.3のまま保ち、規約はこの欄で満たす、という分離。
 *
 * 返すのは requires_credit=1 かつ enabled=1 のソースのみ。
 * ラベルとリンク先URL以外の情報（記事本文など）は一切返さない。
 */
meta.get('/credits', async (c) => {
  let credits: Array<{ key: string; label: string; url: string }> = [];
  try {
    const rows = await c.env.DB.prepare(
      `SELECT key, credit_label, label, credit_url, url
         FROM meta_sources
        WHERE requires_credit = 1 AND enabled = 1
        ORDER BY key ASC`
    ).all();
    credits = ((rows.results ?? []) as any[]).map((r) => ({
      key: String(r.key),
      label: String(r.credit_label ?? r.label ?? r.key),
      url: String(r.credit_url ?? r.url ?? ''),
    }));
  } catch {
    /* マイグレーション未適用でも 200 を返す（クレジット無しとして扱う） */
  }
  return c.json({ credits });
});

// ============================ 状態（監視・デバッグ用） ============================
/**
 * GET /api/meta/status
 * 収集の健全性。ここでは非公式ソースの「ラベル」までは出すが URL は出さない。
 */
meta.get('/status', async (c) => {
  const ready = await metaVectorsReady(c.env.DB);
  let sources: any[] = [];
  let lastJob: any = null;
  try {
    const rows = await c.env.DB.prepare(
      `SELECT key, label, region, kind, is_official, enabled,
              last_status, last_ok_at, fail_streak, checked_at
         FROM meta_sources ORDER BY is_official DESC, key ASC`
    ).all();
    sources = ((rows.results ?? []) as any[]).map((r) => ({
      key: String(r.key),
      label: String(r.label ?? ''),
      region: String(r.region ?? ''),
      kind: String(r.kind ?? ''),
      is_official: Number(r.is_official ?? 0),
      enabled: Number(r.enabled ?? 1),
      last_status: r.last_status == null ? null : Number(r.last_status),
      last_ok_at: r.last_ok_at ? String(r.last_ok_at) : null,
      fail_streak: Number(r.fail_streak ?? 0),
      checked_at: r.checked_at ? String(r.checked_at) : null,
    }));
    lastJob = await c.env.DB.prepare(
      `SELECT id, kind, status, ok_count, fail_count, new_items, message, started_at, finished_at
         FROM meta_jobs ORDER BY id DESC LIMIT 1`
    ).first<any>();
  } catch {
    /* マイグレーション未適用でも 200 を返す */
  }

  let raw = 0;
  try {
    const r = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM meta_raw_items`).first<{ n: number }>();
    raw = Number(r?.n ?? 0);
  } catch {
    /* noop */
  }

  return c.json({
    today: jstToday(),
    now: jstNow(),
    counts: { ...ready, raw_items: raw },
    sources,
    last_job: lastJob,
  });
});

export default meta;
