/**
 * memory.ts (routes) — AIの記憶層の構築・点検エンドポイント
 *
 *  POST /api/memory/build/cards  { batch?, offset?, force? }  カードをベクトル化
 *  POST /api/memory/build/rules  { batch?, offset?, force? }  ルール条文をベクトル化
 *  POST /api/memory/build/abilities                            キーワード能力知識を生成
 *  GET  /api/memory/stats                                      記憶の充填状況
 *
 * 安全設計
 *  - 書き込み系は ADMIN_TOKEN 必須（未設定ならローカル開発のみ許可）。
 *    ベクトル化は LLM 課金を伴うため、公開状態で誰でも叩けてはならない。
 *  - 1リクエストで全件やろうとすると Workers の CPU/時間上限に当たるため、
 *    offset + batch で分割実行し、進捗を返す。
 */
import { Hono } from 'hono';
import type { Bindings } from '../types';
import { KEYWORDS, aiConfigured, chatJson, ruleFullText } from '../lib/ai';
import {
  EMBED_DIMS,
  EMBED_MODEL,
  cardEmbedText,
  embed,
  normalize,
  ruleEmbedText,
  sha256,
  toBlob,
  vectorsReady,
} from '../lib/memory';

const mem = new Hono<{ Bindings: Bindings }>();

/**
 * D1 は 1 クエリの変数（?）を約100個までに制限している。
 * IN (...) で数百件を一度に問い合わせると
 * "too many SQL variables" になるため、必ず分割して発行する。
 */
const SQL_VAR_CHUNK = 80;

async function fetchHashes(
  db: D1Database,
  table: 'card_vectors' | 'rule_vectors',
  idCol: 'card_id' | 'section_id',
  ids: number[]
): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  for (let i = 0; i < ids.length; i += SQL_VAR_CHUNK) {
    const chunk = ids.slice(i, i + SQL_VAR_CHUNK);
    const r = await db
      .prepare(
        `SELECT ${idCol} AS id, text_hash FROM ${table}
          WHERE ${idCol} IN (${chunk.map(() => '?').join(',')})`
      )
      .bind(...chunk)
      .all();
    for (const row of (r.results ?? []) as any[]) out.set(Number(row.id), String(row.text_hash));
  }
  return out;
}

/** db.batch も 1 回に詰め込みすぎるとバインド数上限に触れるため分割する */
async function runBatched(db: D1Database, stmts: D1PreparedStatement[], size = 50) {
  for (let i = 0; i < stmts.length; i += size) {
    await db.batch(stmts.slice(i, i + size));
  }
}

/**
 * 記憶構築系は D1 の制約（SQL変数上限など）や埋め込みAPIの失敗で例外が出る。
 * 素の例外を漏らすと HTTP 500 + 原因不明になるため、必ず理由付きで返す。
 */
mem.use('*', async (c, next) => {
  try {
    await next();
  } catch (e: any) {
    console.error('[MEMORY_ERROR]', e?.constructor?.name, '|', String(e?.message ?? '').slice(0, 300));
    return c.json(
      { error: 'memory_failed', detail: String(e?.message ?? e).slice(0, 300) },
      (e?.status && Number(e.status) >= 400 ? Number(e.status) : 502) as any
    );
  }
});

/** 書き込み権限の確認 */
function authorized(c: any): boolean {
  const want = c.env.ADMIN_TOKEN;
  const got = c.req.header('x-admin-token') || '';
  if (want) return got === want;
  // ADMIN_TOKEN 未設定時はローカル開発を想定し、localhost からのみ許可
  const host = c.req.header('host') || '';
  return /^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?$/.test(host);
}

// ============================ 状況確認 ============================

mem.get('/stats', async (c) => {
  const db = c.env.DB;
  const v = await vectorsReady(db);
  const q = async (sql: string) => {
    try {
      const r = await db.prepare(sql).first<{ n: number }>();
      return Number(r?.n ?? 0);
    } catch {
      return 0;
    }
  };
  return c.json({
    ai_configured: aiConfigured(c.env),
    embed: { model: EMBED_MODEL, dims: EMBED_DIMS },
    cards: { total: await q('SELECT COUNT(*) AS n FROM cards'), vectorized: v.cards },
    rules: {
      total: await q(`SELECT COUNT(*) AS n FROM rules_sections`),
      vectorized: v.rules,
    },
    ability_knowledge: await q('SELECT COUNT(*) AS n FROM ability_knowledge'),
    synergy_memory: await q('SELECT COUNT(*) AS n FROM synergy_memory'),
  });
});

// ============================ カードのベクトル化 ============================

mem.post('/build/cards', async (c) => {
  if (!authorized(c)) return c.json({ error: 'forbidden' }, 403);
  const db = c.env.DB;
  const body = await c.req.json().catch(() => ({}) as any);
  const batch = Math.min(Math.max(Number(body.batch) || 200, 1), 400);
  const offset = Math.max(Number(body.offset) || 0, 0);
  const force = Boolean(body.force);

  const rows = await db
    .prepare(
      `SELECT c.id, c.card_name, c.version, c.card_type, c.ink_color, c.ink_color2,
              c.ink_cost, c.strength, c.willpower, c.lore_value, c.rules_text_plain,
              (SELECT GROUP_CONCAT(cl.classification, '|') FROM classifications cl WHERE cl.card_id = c.id) AS classifications,
              (SELECT GROUP_CONCAT(ab.ability, '|')        FROM abilities ab       WHERE ab.card_id = c.id) AS abilities
         FROM cards c ORDER BY c.id LIMIT ? OFFSET ?`
    )
    .bind(batch, offset)
    .all();

  const list = (rows.results ?? []) as any[];
  if (!list.length) {
    return c.json({ done: true, offset, processed: 0, skipped: 0, next_offset: null });
  }

  // 既存ハッシュを引いて、テキストが変わっていない行は再計算しない（コスト削減）
  const ids = list.map((r) => Number(r.id));
  const existing = force
    ? new Map<number, string>()
    : await fetchHashes(db, 'card_vectors', 'card_id', ids);

  const targets: Array<{ id: number; text: string; hash: string }> = [];
  for (const r of list) {
    const text = cardEmbedText(r);
    const hash = await sha256(`${EMBED_MODEL}:${EMBED_DIMS}:${text}`);
    if (existing.get(Number(r.id)) === hash) continue;
    targets.push({ id: Number(r.id), text, hash });
  }

  let written = 0;
  if (targets.length) {
    const vecs = await embed(c.env, targets.map((t) => t.text), { dims: EMBED_DIMS });
    const stmts = targets.map((t, i) =>
      db
        .prepare(
          `INSERT INTO card_vectors (card_id, source_text, text_hash, dims, model, vec, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
           ON CONFLICT(card_id) DO UPDATE SET
             source_text = excluded.source_text, text_hash = excluded.text_hash,
             dims = excluded.dims, model = excluded.model, vec = excluded.vec,
             updated_at = CURRENT_TIMESTAMP`
        )
        // 検索時に内積だけで済むよう、保存前に正規化しておく
        .bind(t.id, t.text, t.hash, EMBED_DIMS, EMBED_MODEL, toBlob(normalize(vecs[i])))
    );
    await runBatched(db, stmts);
    written = targets.length;
  }

  const nextOffset = offset + list.length;
  return c.json({
    done: list.length < batch,
    offset,
    processed: written,
    skipped: list.length - written,
    next_offset: list.length < batch ? null : nextOffset,
  });
});

// ============================ ルール条文のベクトル化 ============================

mem.post('/build/rules', async (c) => {
  if (!authorized(c)) return c.json({ error: 'forbidden' }, 403);
  const db = c.env.DB;
  const body = await c.req.json().catch(() => ({}) as any);
  const batch = Math.min(Math.max(Number(body.batch) || 150, 1), 400);
  const offset = Math.max(Number(body.offset) || 0, 0);
  const force = Boolean(body.force);

  const rows = await db
    .prepare(
      `SELECT id, section, heading, body FROM rules_sections
        ORDER BY id LIMIT ? OFFSET ?`
    )
    .bind(batch, offset)
    .all();
  const list = (rows.results ?? []) as any[];
  if (!list.length) {
    return c.json({ done: true, offset, processed: 0, skipped: 0, next_offset: null });
  }

  const ids = list.map((r) => Number(r.id));
  const existing = force
    ? new Map<number, string>()
    : await fetchHashes(db, 'rule_vectors', 'section_id', ids);

  const targets: Array<{ id: number; text: string; hash: string }> = [];
  for (const r of list) {
    const text = ruleEmbedText(r);
    const hash = await sha256(`${EMBED_MODEL}:${EMBED_DIMS}:${text}`);
    if (existing.get(Number(r.id)) === hash) continue;
    targets.push({ id: Number(r.id), text, hash });
  }

  let written = 0;
  if (targets.length) {
    const vecs = await embed(c.env, targets.map((t) => t.text), { dims: EMBED_DIMS });
    const stmts = targets.map((t, i) =>
      db
        .prepare(
          `INSERT INTO rule_vectors (section_id, source_text, text_hash, dims, model, vec, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
           ON CONFLICT(section_id) DO UPDATE SET
             source_text = excluded.source_text, text_hash = excluded.text_hash,
             dims = excluded.dims, model = excluded.model, vec = excluded.vec,
             updated_at = CURRENT_TIMESTAMP`
        )
        .bind(t.id, t.text, t.hash, EMBED_DIMS, EMBED_MODEL, toBlob(normalize(vecs[i])))
    );
    await runBatched(db, stmts);
    written = targets.length;
  }

  const nextOffset = offset + list.length;
  return c.json({
    done: list.length < batch,
    offset,
    processed: written,
    skipped: list.length - written,
    next_offset: list.length < batch ? null : nextOffset,
  });
});

// ============================ キーワード能力知識の生成 ============================

const KNOWLEDGE_SYSTEM = `あなたはディズニー ロルカナの公式総合ルールに精通したルールアドバイザーです。
与えられた「総合ルールの抜粋」だけを根拠に、指定されたキーワード能力について
デッキ構築のシナジー判断に必要な知識を日本語でまとめてください。

厳守事項:
- 抜粋に書かれていないことを推測で書かない。書かれていない場合は触れない。
- summary は1〜2文で、その能力が何をするかを正確に述べる。
- synergy_notes は「どういうカードと組み合わせると強いか」を判断するために
  必要な事実を3〜5個。効果の持続範囲（そのターンのみ等）や適用条件を明示する。
- caveats は誤解されやすい点・制限を2〜4個。

次のJSONのみを出力:
{"summary":"...","synergy_notes":["..."],"caveats":["..."]}`;

mem.post('/build/abilities', async (c) => {
  if (!authorized(c)) return c.json({ error: 'forbidden' }, 403);
  const db = c.env.DB;
  const body = await c.req.json().catch(() => ({}) as any);
  const only: string[] = Array.isArray(body.only) ? body.only.map(String) : [];
  const force = Boolean(body.force);

  const targets = (only.length ? only : KEYWORDS).filter((k) => KEYWORDS.includes(k));
  const out: Array<{ ability: string; ok: boolean; note?: string }> = [];

  for (const ability of targets) {
    if (!force) {
      const ex = await db
        .prepare('SELECT ability FROM ability_knowledge WHERE ability = ?')
        .bind(ability)
        .first();
      if (ex) {
        out.push({ ability, ok: true, note: 'skipped (exists)' });
        continue;
      }
    }

    // その能力に言及している条文を集める（ここは1回だけ払うコスト）
    const rows = await db
      .prepare(
        `SELECT section, heading, body FROM rules_sections
          WHERE source = 'comprehensive' AND (heading LIKE ? OR body LIKE ?)
          ORDER BY CAST(section AS REAL) LIMIT 12`
      )
      .bind(`%${ability}%`, `%${ability}%`)
      .all();
    let secs = (rows.results ?? []) as any[];

    // キーワード能力の定義は 8.x に階層化されており（例: 突進=8.8.1 / 8.8.2 ...）、
    // 語が現れない下位条文に肝心の制限が書かれていることがある。
    // 該当した 8.x 系の節を見つけたら、その兄弟節をまとめて取り込む。
    const prefixes = [
      ...new Set(
        secs
          .map((r) => String(r.section ?? ''))
          .filter((s) => /^8\.\d+\./.test(s))
          .map((s) => s.split('.').slice(0, 2).join('.') + '.')
      ),
    ];
    if (prefixes.length) {
      const sib = await db
        .prepare(
          `SELECT section, heading, body FROM rules_sections
            WHERE source = 'comprehensive'
              AND (${prefixes.map(() => 'section LIKE ?').join(' OR ')})
            ORDER BY CAST(section AS REAL) LIMIT 20`
        )
        .bind(...prefixes.map((p) => `${p}%`))
        .all();
      const seen = new Set(secs.map((r) => String(r.section)));
      for (const r of (sib.results ?? []) as any[]) {
        if (!seen.has(String(r.section))) {
          seen.add(String(r.section));
          secs.push(r);
        }
      }
      secs.sort((a, b) => String(a.section).localeCompare(String(b.section), undefined, { numeric: true }));
    }
    if (!secs.length) {
      out.push({ ability, ok: false, note: 'no rule sections found' });
      continue;
    }

    const context = secs
      // heading は本文前半、body は後半なので区切りなしで連結して渡す
      .map((r) => `[${r.section}] ${ruleFullText(r).slice(0, 1500)}`)
      .join('\n\n');

    try {
      const r = await chatJson<{ summary?: string; synergy_notes?: unknown; caveats?: unknown }>(
        c.env,
        [
          { role: 'system', content: KNOWLEDGE_SYSTEM },
          { role: 'user', content: `キーワード能力: ${ability}\n\n総合ルールの抜粋:\n${context}` },
        ],
        { reasoningEffort: 'low', maxTokens: 4000, timeoutMs: 90_000 }
      );
      const arr = (v: unknown) =>
        JSON.stringify(
          (Array.isArray(v) ? v : v == null ? [] : [v]).map((x) => String(x)).slice(0, 6)
        );
      await db
        .prepare(
          `INSERT INTO ability_knowledge (ability, summary, synergy_notes, caveats, sections, model, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
           ON CONFLICT(ability) DO UPDATE SET
             summary = excluded.summary, synergy_notes = excluded.synergy_notes,
             caveats = excluded.caveats, sections = excluded.sections,
             model = excluded.model, updated_at = CURRENT_TIMESTAMP`
        )
        .bind(
          ability,
          String(r.data?.summary ?? '').slice(0, 600),
          arr(r.data?.synergy_notes),
          arr(r.data?.caveats),
          JSON.stringify(secs.map((s) => String(s.section))),
          r.model
        )
        .run();
      out.push({ ability, ok: true });
    } catch (e: any) {
      out.push({ ability, ok: false, note: String(e?.message ?? e).slice(0, 120) });
    }
  }

  return c.json({ results: out });
});

export default mem;
