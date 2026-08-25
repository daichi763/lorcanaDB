/**
 * ocr.ts — 収集した画像から日本語テキストを取り出す工程（仕様§9-3）
 *
 * なぜ必要か:
 *   ロルカナ日本公式（X）の告知は、本文が極端に短く、
 *   肝心の情報（開催時刻・対象レベル・会場・条件）が画像の中にしか無い。
 *   実測では公式ポストの alt_text は全件空だったため、
 *   画像を読まない限りその情報は永久に取得できない。
 *
 * 設計の要点:
 *   1. 1回の呼び出しで処理する画像は既定1枚（resumable）。
 *      Vision 呼び出しは遅く、Workers の実行時間上限に収まらないため、
 *      collect と同じ「呼び出し側がループする」方式に揃える。
 *
 *   2. 同じ画像を二度OCRしない。
 *      meta_ocr.image_url が UNIQUE。失敗も status='failed' で行を残し、
 *      無限に再試行してコストを垂れ流さない（明示的な retry_failed のみ再挑戦）。
 *
 *   3. 引用方針（§1.3）は OCR にも適用する。
 *      公式画像のOCRは「公式1次情報」の一部＝URL引用可。
 *      非公式画像のOCRは非公式本文と同じ扱い＝材料のみ・出典非表示。
 *      その判定は meta_sources.is_official に従い、
 *      表示段（metaReport.pickOcr）で citable を決める。
 *
 *   4. コスト上限を構造で持つ。
 *      対象は「直近N日」かつ「公式優先」に限定する。
 *      過去の全画像を読み返す動作は原理的に起きない。
 */
import type { AiEnv } from '../types';
import { ocrImage, LlmError } from './ai';
import { jstToday } from './meta';

export type OcrCandidate = {
  raw_item_id: number;
  source_key: string;
  page_url: string;
  image_url: string;
  observed_at: string | null;
  is_official: number;
  label: string;
};

export type OcrRunResult = {
  processed: number;
  ok: number;
  empty: number;
  failed: number;
  remaining: number;
  done: boolean;
  items: {
    image_url: string;
    source: string;
    status: 'ok' | 'empty' | 'failed';
    char_count: number;
    preview: string;
    error?: string;
  }[];
};

/** meta_raw_items.image_urls（JSON配列）と image_url（単一）を1つのリストに畳む */
function imagesOf(row: any): string[] {
  const out: string[] = [];
  const push = (v: unknown) => {
    const s = String(v ?? '').trim();
    // pbs.twimg.com などの http(s) 画像のみ。data: や相対パスは扱わない
    if (!/^https?:\/\//i.test(s)) return;
    if (!out.includes(s)) out.push(s);
  };
  if (row?.image_urls) {
    try {
      const arr = JSON.parse(String(row.image_urls));
      if (Array.isArray(arr)) arr.forEach(push);
    } catch {
      /* 壊れたJSONは無視して image_url だけ使う */
    }
  }
  push(row?.image_url);
  return out.slice(0, 4);
}

/**
 * まだOCRしていない画像を探す。
 *
 * 公式（is_official=1）を先に処理する。予算が尽きても
 * 一番価値の高い公式告知画像は読めている状態にするため。
 */
export async function findOcrCandidates(
  db: D1Database,
  opts: { days?: number; limit?: number; sourceKey?: string; retryFailed?: boolean } = {}
): Promise<OcrCandidate[]> {
  const days = Math.max(1, Math.min(120, opts.days ?? 30));
  const limit = Math.max(1, Math.min(60, opts.limit ?? 20));
  const today = jstToday();

  const where: string[] = [
    `(r.image_url IS NOT NULL OR r.image_urls IS NOT NULL)`,
    `(r.observed_at IS NULL OR r.observed_at >= date(?, ?))`,
  ];
  const binds: unknown[] = [today, `-${days} days`];
  if (opts.sourceKey) {
    where.push('r.source_key = ?');
    binds.push(opts.sourceKey);
  }

  const sql = `SELECT r.id, r.source_key, r.url, r.image_url, r.image_urls, r.observed_at,
                      COALESCE(s.is_official, 0) AS is_official,
                      COALESCE(s.label, r.source_key) AS label
                 FROM meta_raw_items r
                 LEFT JOIN meta_sources s ON s.key = r.source_key
                WHERE ${where.join(' AND ')}
                ORDER BY COALESCE(s.is_official, 0) DESC,
                         COALESCE(r.observed_at, r.fetched_at) DESC
                LIMIT ?`;
  const rows = await db
    .prepare(sql)
    .bind(...binds, limit * 3)
    .all();

  const cands: OcrCandidate[] = [];
  for (const r of (rows.results ?? []) as any[]) {
    for (const img of imagesOf(r)) {
      cands.push({
        raw_item_id: Number(r.id),
        source_key: String(r.source_key),
        page_url: String(r.url ?? ''),
        image_url: img,
        observed_at: r.observed_at ? String(r.observed_at) : null,
        is_official: Number(r.is_official ?? 0),
        label: String(r.label ?? r.source_key),
      });
    }
  }
  if (!cands.length) return [];

  // すでにOCR済み（成功も失敗も）の画像を除外する。
  // 失敗を除外するのは、落ちる画像を毎日読み直して課金し続けないため。
  const seen = new Set<string>();
  const chunk = 80;
  for (let i = 0; i < cands.length; i += chunk) {
    const slice = cands.slice(i, i + chunk);
    const ph = slice.map(() => '?').join(',');
    const done = await db
      .prepare(
        `SELECT image_url FROM meta_ocr WHERE image_url IN (${ph})` +
          (opts.retryFailed ? ` AND status <> 'failed'` : '')
      )
      .bind(...slice.map((c) => c.image_url))
      .all();
    for (const d of (done.results ?? []) as any[]) seen.add(String(d.image_url));
  }

  const pending = cands.filter((c) => !seen.has(c.image_url));
  // 同一画像URLの重複（複数ポストに同じ画像）を1つに畳む
  const uniq: OcrCandidate[] = [];
  const u = new Set<string>();
  for (const c of pending) {
    if (u.has(c.image_url)) continue;
    u.add(c.image_url);
    uniq.push(c);
  }
  return uniq;
}

async function saveOcr(
  db: D1Database,
  c: OcrCandidate,
  r: { text: string; status: 'ok' | 'empty' | 'failed'; model: string | null; error: string | null }
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO meta_ocr
         (raw_item_id, source_key, image_url, page_url, ocr_text, char_count,
          status, error, model, observed_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?, datetime('now'), datetime('now'))
       ON CONFLICT(image_url) DO UPDATE SET
         ocr_text = excluded.ocr_text,
         char_count = excluded.char_count,
         status = excluded.status,
         error = excluded.error,
         model = excluded.model,
         updated_at = datetime('now')`
    )
    .bind(
      c.raw_item_id,
      c.source_key,
      c.image_url,
      c.page_url,
      r.text || null,
      r.text.length,
      r.status,
      r.error ? String(r.error).slice(0, 300) : null,
      r.model,
      c.observed_at
    )
    .run();
}

/**
 * OCRを進める。既定は1枚/回（呼び出し側が done=true まで繰り返す）。
 */
export async function runOcrBatch(
  env: AiEnv,
  db: D1Database,
  opts: {
    limit?: number;
    days?: number;
    sourceKey?: string;
    retryFailed?: boolean;
    model?: string;
  } = {}
): Promise<OcrRunResult> {
  const limit = Math.max(1, Math.min(4, opts.limit ?? 1));
  const cands = await findOcrCandidates(db, {
    days: opts.days,
    limit: 40,
    sourceKey: opts.sourceKey,
    retryFailed: opts.retryFailed,
  });

  const out: OcrRunResult = {
    processed: 0,
    ok: 0,
    empty: 0,
    failed: 0,
    remaining: Math.max(0, cands.length - Math.min(limit, cands.length)),
    done: cands.length === 0,
    items: [],
  };
  if (!cands.length) return out;

  for (const c of cands.slice(0, limit)) {
    try {
      const r = await ocrImage(env, c.image_url, { model: opts.model });
      const text = r.text.trim();
      const status: 'ok' | 'empty' = text.length >= 4 ? 'ok' : 'empty';
      await saveOcr(db, c, { text, status, model: r.model, error: null });
      out.processed++;
      if (status === 'ok') out.ok++;
      else out.empty++;
      out.items.push({
        image_url: c.image_url,
        source: c.label,
        status,
        char_count: text.length,
        preview: text.replace(/\n/g, ' / ').slice(0, 160),
      });
    } catch (e: any) {
      const msg = e instanceof LlmError ? e.message : String(e?.message ?? e);
      // 失敗も行に残す（= 二度読まない）。ただしレート制限は一時的なので残さない。
      const transient = /429|rate|timeout/i.test(msg);
      if (!transient) {
        await saveOcr(db, c, { text: '', status: 'failed', model: null, error: msg });
      }
      out.processed++;
      out.failed++;
      out.items.push({
        image_url: c.image_url,
        source: c.label,
        status: 'failed',
        char_count: 0,
        preview: '',
        error: msg.slice(0, 200),
      });
      if (transient) break; // レート制限に当たったらその回は打ち切る
    }
  }

  out.done = out.remaining === 0;
  return out;
}

/** 管理画面表示用の集計 */
export async function ocrStats(db: D1Database): Promise<{
  total: number;
  ok: number;
  empty: number;
  failed: number;
  chars: number;
  pending: number;
  latest: string | null;
}> {
  const agg = await db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status='ok' THEN 1 ELSE 0 END) AS ok,
              SUM(CASE WHEN status='empty' THEN 1 ELSE 0 END) AS empty,
              SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed,
              SUM(char_count) AS chars,
              MAX(updated_at) AS latest
         FROM meta_ocr`
    )
    .first<any>()
    .catch(() => null);
  const pending = await findOcrCandidates(db, { limit: 40 }).catch(() => []);
  return {
    total: Number(agg?.total ?? 0),
    ok: Number(agg?.ok ?? 0),
    empty: Number(agg?.empty ?? 0),
    failed: Number(agg?.failed ?? 0),
    chars: Number(agg?.chars ?? 0),
    pending: pending.length,
    latest: agg?.latest ? String(agg.latest) : null,
  };
}
