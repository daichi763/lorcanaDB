/**
 * ai.ts (routes) — AIシナジー探索API
 *
 *  POST /api/ai/synergy
 *    { card_file?: string, text?: string, restrict_ink?: string[], want?: number }
 *    → { mode, base, intent, results:[{card, score, role, reason}], summary, axes, caveats, cached, model }
 *
 *  GET  /api/ai/status  → AIが利用可能かどうか（UI出し分け用。鍵は返さない）
 *
 * 安全設計
 *  - APIキーは Cloudflare Secret / .dev.vars のみ。レスポンスにもHTMLにも出さない
 *  - IP毎レート制限（AI用に厳しめ: 60秒3回 / 24時間60回）
 *  - 同一入力は D1 にキャッシュ（24時間）してLLM再呼び出しを抑制
 *  - LLM が返した id を D1 の実データに突合し、存在しないカードは破棄
 */
import { Hono } from 'hono';
import type { Bindings } from '../types';
import { splitConcat } from '../lib/search';
import {
  aiConfigured,
  buildUserPrompt,
  chatJson,
  detectMechanics,
  fetchRuleContext,
  INTENT_SYSTEM_PROMPT,
  KEYWORDS,
  LlmError,
  retrieveCandidates,
  SYSTEM_PROMPT,
  type Candidate,
  type Intent,
  type RankResult,
} from '../lib/ai';

const ai = new Hono<{ Bindings: Bindings }>();

// ============================ レート制限 ============================
const WIN_SHORT = 60;
const LIM_SHORT = 3;
const WIN_LONG = 24 * 60 * 60;
const LIM_LONG = 60;

async function ensureTables(db: D1Database) {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS ai_rate_limit (ip TEXT NOT NULL, ts INTEGER NOT NULL)`
    )
    .run();
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_ai_rate_ip_ts ON ai_rate_limit(ip, ts)').run();
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS ai_cache (
         key TEXT PRIMARY KEY, payload TEXT NOT NULL, ts INTEGER NOT NULL
       )`
    )
    .run();
}

async function checkRate(db: D1Database, ip: string) {
  const now = Math.floor(Date.now() / 1000);
  await db.prepare('DELETE FROM ai_rate_limit WHERE ts < ?').bind(now - WIN_LONG).run();

  const s = await db
    .prepare('SELECT COUNT(*) AS n FROM ai_rate_limit WHERE ip = ? AND ts >= ?')
    .bind(ip, now - WIN_SHORT)
    .first<{ n: number }>();
  if ((s?.n ?? 0) >= LIM_SHORT) return { ok: false as const, retry_after: WIN_SHORT, scope: '60秒' };

  const l = await db
    .prepare('SELECT COUNT(*) AS n FROM ai_rate_limit WHERE ip = ? AND ts >= ?')
    .bind(ip, now - WIN_LONG)
    .first<{ n: number }>();
  if ((l?.n ?? 0) >= LIM_LONG) return { ok: false as const, retry_after: WIN_LONG, scope: '24時間' };

  await db.prepare('INSERT INTO ai_rate_limit (ip, ts) VALUES (?, ?)').bind(ip, now).run();
  return { ok: true as const };
}

/**
 * LLM の出力を配列として安全に扱う。
 * JSON モードでも配列であるべき項目が文字列・オブジェクト・null で返ることがあり、
 * そのまま .slice()/.map()/for..of すると TypeError（=HTTP 500）になる。
 *  - 配列       → そのまま
 *  - 文字列     → 1要素の配列（空文字は空配列）
 *  - オブジェクト → 値の配列（{"1":{...}} 形式の救済）
 *  - null/undefined/その他 → 空配列
 */
function toArray<T>(v: unknown): T[] {
  if (Array.isArray(v)) return v as T[];
  if (v == null) return [];
  if (typeof v === 'string') return v.trim() ? ([v] as unknown as T[]) : [];
  if (typeof v === 'object') return Object.values(v as Record<string, unknown>) as T[];
  return [v] as unknown as T[];
}

/** Workers に crypto.subtle はあるが同期ハッシュが無いのでシンプルな安定ハッシュを使う */
function cacheKey(s: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = (h1 ^ c) * 16777619 >>> 0;
    h2 = (h2 + c * (i + 7)) >>> 0;
  }
  return `${h1.toString(36)}-${h2.toString(36)}-${s.length.toString(36)}`;
}

// ============================ ステータス ============================
ai.get('/status', (c) =>
  c.json({
    available: aiConfigured(c.env),
    model: aiConfigured(c.env) ? c.env.AI_MODEL || 'gpt-5-mini' : null,
    limits: { per_minute: LIM_SHORT, per_day: LIM_LONG },
  })
);

// ============================ 候補カード検索（AI用オートコンプリート） ====
ai.get('/card-suggest', async (c) => {
  const q = (c.req.query('q') ?? '').trim();
  if (q.length < 1) return c.json({ cards: [] });
  const like = `%${q.replace(/([%_\\])/g, '\\$1')}%`;
  const r = await c.env.DB.prepare(
    `SELECT id, card_file, card_name, version, ink_color, ink_cost, card_type, sets_name, image_url
       FROM cards
      WHERE card_name LIKE ? ESCAPE '\\' OR version LIKE ? ESCAPE '\\' OR search_card_name LIKE ? ESCAPE '\\'
      ORDER BY (card_name = ?) DESC, LENGTH(card_name) ASC, sets_order DESC
      LIMIT 20`
  )
    .bind(like, like, like, q)
    .all();
  return c.json({ cards: r.results ?? [] });
});

// ============================ AIシナジー探索 ============================
ai.post('/synergy', async (c) => {
  if (!aiConfigured(c.env)) {
    return c.json(
      {
        error: 'ai_not_configured',
        message:
          'AI機能が未設定です。管理者は OPENAI_API_KEY / OPENAI_BASE_URL をシークレットに設定してください。',
      },
      503
    );
  }

  let body: Record<string, unknown> = {};
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  const cardFile = typeof body.card_file === 'string' ? body.card_file.trim() : '';
  const freeText = typeof body.text === 'string' ? body.text.trim().slice(0, 600) : '';
  const restrictInk = Array.isArray(body.restrict_ink)
    ? body.restrict_ink.map(String).filter(Boolean).slice(0, 2)
    : [];
  const want = Math.min(Math.max(Number(body.want) || 12, 4), 20);

  if (!cardFile && !freeText) {
    return c.json({ error: 'empty_input', message: 'カードを選ぶか、やりたいことを入力してください。' }, 400);
  }

  const db = c.env.DB;
  await ensureTables(db);

  // ---- キャッシュ照会（レート制限より前に見る = キャッシュヒットは無料）----
  const ck = cacheKey(JSON.stringify({ cardFile, freeText, restrictInk, want, v: 3 }));
  const now = Math.floor(Date.now() / 1000);
  const hit = await db
    .prepare('SELECT payload, ts FROM ai_cache WHERE key = ? AND ts >= ?')
    .bind(ck, now - 24 * 60 * 60)
    .first<{ payload: string; ts: number }>();
  if (hit) {
    try {
      return c.json({ ...JSON.parse(hit.payload), cached: true });
    } catch {
      /* 壊れていたら作り直す */
    }
  }

  // ---- レート制限 ----
  const ip =
    c.req.header('cf-connecting-ip') ||
    c.req.header('x-forwarded-for')?.split(',')[0].trim() ||
    'unknown';
  const rate = await checkRate(db, ip);
  if (!rate.ok) {
    return c.json(
      {
        error: 'rate_limited',
        message: `AI検索は${rate.scope}あたりの上限に達しました。しばらく待ってからお試しください。`,
        retry_after: rate.retry_after,
      },
      429,
      { 'Retry-After': String(rate.retry_after) }
    );
  }

  try {
    // ---- 起点カード ----
    let base: Record<string, any> | null = null;
    if (cardFile) {
      base = await db
        .prepare(
          `SELECT c.*,
                  (SELECT GROUP_CONCAT(cl.classification, '|') FROM classifications cl WHERE cl.card_id = c.id) AS classifications,
                  (SELECT GROUP_CONCAT(ab.ability, '|')        FROM abilities ab       WHERE ab.card_id = c.id) AS abilities
             FROM cards c WHERE ${/^\d+$/.test(cardFile) ? 'c.id = ?' : 'c.card_file = ?'}`
        )
        .bind(/^\d+$/.test(cardFile) ? Number(cardFile) : cardFile)
        .first<Record<string, any>>();
      if (!base) return c.json({ error: 'card_not_found' }, 404);
    }

    // ---- 第1段: 自由記述 → 構造化意図 ----
    let intent: Intent = {};
    if (freeText) {
      try {
        const r = await chatJson<Intent>(
          c.env,
          [
            { role: 'system', content: INTENT_SYSTEM_PROMPT },
            { role: 'user', content: freeText },
          ],
          {
            // 意図抽出は単純な変換なので最小コスト・最高速のモデルで十分
            model: c.env.AI_MODEL_FAST || 'gpt-5-nano',
            reasoningEffort: 'minimal',
            maxTokens: 700,
            timeoutMs: 15_000,
          }
        );
        intent = r.data && typeof r.data === 'object' && !Array.isArray(r.data) ? r.data : {};
      } catch {
        // 意図抽出に失敗しても、生テキストを語分割してフォールバック
        intent = { keywords: freeText.split(/[\s、。,.／/]+/).filter((w) => w.length >= 2).slice(0, 6) };
      }
    }

    // ---- 第2段: D1 から候補抽出（決定的） ----
    // 意図抽出の各項目も型がゆらぐため、SQL に渡す前に文字列配列へ正規化する
    const asStrings = (v: unknown) =>
      toArray<unknown>(v)
        .map((x) => String(x ?? '').trim())
        .filter(Boolean);

    const candidates: Candidate[] = await retrieveCandidates(db, {
      base,
      keywords: asStrings(intent.keywords),
      classifications: asStrings(intent.classifications),
      abilities: asStrings(intent.abilities),
      inkColors: asStrings(intent.ink_colors),
      cardTypes: asStrings(intent.card_types),
      restrictInk,
      limit: 60,
    });

    if (!candidates.length) {
      return c.json({
        mode: base ? (freeText ? 'card+text' : 'card') : 'text',
        base: base ? shape(base) : null,
        intent: intent.intent ?? null,
        summary: '条件に合う候補カードがデータベース内に見つかりませんでした。語を変えてお試しください。',
        axes: [],
        results: [],
        caveats: [],
        candidate_count: 0,
        cached: false,
      });
    }

    // ---- ルール抜粋（キーワード能力の正確な解釈のため） ----
    const kwTerms = new Set<string>();
    for (const k of String(base?.abilities ?? '').split('|')) if (k) kwTerms.add(k);
    for (const k of intent.abilities ?? []) kwTerms.add(k);
    for (const cand of candidates.slice(0, 25)) {
      for (const k of String(cand.abilities ?? '').split('|')) if (k && KEYWORDS.includes(k)) kwTerms.add(k);
    }
    const ruleContext = await fetchRuleContext(db, [...kwTerms]);

    // ---- 第3段: LLM で順位付け＋理由生成 ----
    const prompt = buildUserPrompt({
      base,
      freeText,
      candidates,
      ruleContext,
      wanted: want,
      restrictInk,
    });

    const ranked = await chatJson<RankResult>(
      c.env,
      [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
      { reasoningEffort: 'low', maxTokens: 4000, timeoutMs: 40_000 }
    );

    // ---- 第4段: LLM出力を D1 実データに突合（幻覚カードを除去） ----
    // LLM は JSON モードでも picks を文字列やオブジェクトで返すことがある。
    // 配列前提で反復・map すると TypeError で 500 になるため、必ず正規化する。
    const byId = new Map(candidates.map((x) => [Number(x.id), x]));
    const seen = new Set<number>();
    const results: any[] = [];
    for (const p of toArray<any>(ranked.data.picks)) {
      if (!p || typeof p !== 'object') continue;
      const id = Number(p.id);
      const card = byId.get(id);
      if (!card || seen.has(id)) continue;
      seen.add(id);
      results.push({
        card: shape(card),
        score: Math.max(0, Math.min(100, Math.round(Number(p.score) || 0))),
        role: typeof p.role === 'string' ? p.role.slice(0, 40) : '',
        reason: typeof p.reason === 'string' ? p.reason.slice(0, 400) : '',
        db_signals: card._why.slice(0, 3),
        mechanics: detectMechanics(card.rules_text_plain).slice(0, 4),
      });
      if (results.length >= want) break;
    }

    const payload = {
      mode: base ? (freeText ? 'card+text' : 'card') : 'text',
      base: base ? shape(base) : null,
      intent: intent.intent ?? null,
      intent_detail: freeText
        ? {
            keywords: toArray<string>(intent.keywords),
            classifications: toArray<string>(intent.classifications),
            abilities: toArray<string>(intent.abilities),
          }
        : null,
      summary: typeof ranked.data.summary === 'string' ? ranked.data.summary.slice(0, 900) : '',
      axes: toArray<unknown>(ranked.data.axes).slice(0, 6).map((x) => String(x).slice(0, 60)),
      caveats: toArray<unknown>(ranked.data.caveats).slice(0, 5).map((x) => String(x).slice(0, 240)),
      results,
      candidate_count: candidates.length,
      rule_context_count: ruleContext.length,
      model: ranked.model,
      cached: false,
    };

    // ---- キャッシュ保存（失敗しても本処理は成功扱い）----
    try {
      await db
        .prepare('INSERT OR REPLACE INTO ai_cache (key, payload, ts) VALUES (?, ?, ?)')
        .bind(ck, JSON.stringify(payload), now)
        .run();
      await db.prepare('DELETE FROM ai_cache WHERE ts < ?').bind(now - 7 * 24 * 60 * 60).run();
    } catch {
      /* noop */
    }

    return c.json(payload);
  } catch (e: any) {
    // 原因追跡用（メッセージのみ。プロンプトやキーは出さない）
    console.error('[AI_ERROR]', e?.constructor?.name, '|', String(e?.message ?? '').slice(0, 300));

    const isLlm = e instanceof LlmError;
    const raw = String(e?.message ?? '');
    const msg = isLlm
      ? raw.startsWith('ai_timeout')
        ? 'AIの応答がタイムアウトしました。もう一度お試しください。'
        : raw.startsWith('ai_bad_json') || raw.startsWith('ai_unexpected_shape') || raw.startsWith('ai_empty_response')
          ? 'AIの回答を解釈できませんでした。もう一度お試しください（内容を少し変えると成功しやすくなります）。'
          : 'AIの呼び出しに失敗しました。しばらく待ってからお試しください。'
      : 'AIの処理中に想定外のエラーが発生しました。もう一度お試しください。';

    return c.json(
      { error: 'ai_failed', message: msg, detail: raw.slice(0, 200) },
      (isLlm ? e.status : 502) as any
    );
  }
});

/** GROUP_CONCAT の '|' 区切りを配列化し、内部スコアを除去 */
function shape(row: Record<string, any>) {
  const { _score, _why, rules_text_plain, search_blob, ...rest } = row;
  return {
    ...rest,
    classifications: splitConcat(row.classifications),
    abilities: splitConcat(row.abilities),
  };
}

export default ai;
