/**
 * memory.ts — AIの「記憶」層
 *
 * 課題:
 *   毎リクエストで LLM にカード全文（120枚×320字）と総合ルール（24節×900字）を
 *   読み直させていた。これは入力トークンの大半が「毎回同じ内容」であり、
 *   速度・精度の両面で無駄が大きい。
 *
 * 解決:
 *   事前に計算できるものを D1 に永続化して再利用する。
 *
 *   ① 意味ベクトル（card_vectors / rule_vectors）
 *      カード効果テキストとルール条文を埋め込みベクトル化して保存。
 *      検索時は「クエリのベクトル 1 本」だけを都度計算し、あとは D1 から
 *      読んだベクトルとのコサイン類似度で並べる。LLM を経由しない。
 *      → LIKE 一致に依存しないため「ビートダウン」等の言い回しにも当たる。
 *
 *   ② キーワード能力の事前要約知識（ability_knowledge）
 *      13種で固定なので、条文を毎回 RAG せず、一度噛み砕いた要約を再利用する。
 *
 *   ③ 検証済みシナジー事例（synergy_memory）
 *      過去に実在カードとして突合できた高スコアのペアを蓄積し、
 *      次回の候補抽出で加点＋LLMへの参考情報として渡す。
 *      → 同じ質問で毎回答えが揺れるのを抑え、回答が経験で改善していく。
 *
 * D1(SQLite) にベクトル型は無いので Float32Array を BLOB で持ち、
 * コサイン類似度は Worker 側で計算する（256次元×2,500枚なら数ミリ秒）。
 */
import type { AiEnv } from '../types';
import { LlmError, aiConfigured, ruleFullText } from './ai';

/** 埋め込み次元。256 に切り詰めても検索品質はほぼ落ちない（Matryoshka 表現） */
export const EMBED_DIMS = 256;
export const EMBED_MODEL = 'text-embedding-3-small';

// ============================ 埋め込み API ============================

/**
 * テキスト群をベクトル化する。
 * 1リクエストに複数 input を渡せるため、実測で 256件/2.3秒。
 */
export async function embed(
  env: AiEnv,
  inputs: string[],
  opts: { model?: string; dims?: number; timeoutMs?: number } = {}
): Promise<Float32Array[]> {
  if (!aiConfigured(env)) throw new LlmError('ai_not_configured', 503);
  if (!inputs.length) return [];

  const base = String(env.OPENAI_BASE_URL).replace(/\/+$/, '');
  const model = opts.model || EMBED_MODEL;
  const dims = opts.dims || EMBED_DIMS;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 30_000);

  let res: Response;
  try {
    res = await fetch(`${base}/embeddings`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      // 空文字は 400 になるためプレースホルダに置換する
      body: JSON.stringify({ model, input: inputs.map((s) => s || '-'), dimensions: dims }),
      signal: ctrl.signal,
    });
  } catch (e: any) {
    clearTimeout(timer);
    throw new LlmError(e?.name === 'AbortError' ? 'embed_timeout' : 'embed_network_error', 504);
  }
  clearTimeout(timer);

  if (!res.ok) {
    throw new LlmError(`embed_http_${res.status}`, res.status === 429 ? 429 : 502);
  }

  const j: any = await res.json().catch(() => null);
  const arr = j?.data;
  if (!Array.isArray(arr) || arr.length !== inputs.length) {
    throw new LlmError('embed_bad_response');
  }
  // index 順が保証されない実装もあるため明示的に並べ替える
  const out: Float32Array[] = new Array(inputs.length);
  for (const row of arr) {
    const i = Number(row?.index ?? 0);
    const v = row?.embedding;
    if (!Array.isArray(v)) throw new LlmError('embed_bad_vector');
    out[i] = new Float32Array(v);
  }
  for (let i = 0; i < out.length; i++) if (!out[i]) throw new LlmError('embed_missing_index');
  return out;
}

// ============================ ベクトル演算 ============================

/** 単位ベクトルへ正規化（保存時に正規化しておけば検索時は内積だけで済む） */
export function normalize(v: Float32Array): Float32Array {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}

/** 正規化済みベクトル同士のコサイン類似度（＝内積） */
export function dot(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

export function toBlob(v: Float32Array): ArrayBuffer {
  // buffer をそのまま渡すと byteOffset が絡む場合に壊れるためコピーする
  return v.slice().buffer as ArrayBuffer;
}

export function fromBlob(b: unknown): Float32Array | null {
  if (!b) return null;
  if (b instanceof ArrayBuffer) return new Float32Array(b);
  if (b instanceof Uint8Array) {
    // D1 は Array<number> で返すことがあるため両方受ける
    return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  }
  if (Array.isArray(b)) return new Float32Array(new Uint8Array(b).buffer);
  return null;
}

/** SHA-256 の16進文字列（Web Crypto。Workers で利用可） */
export async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ============================ 埋め込み対象テキストの構築 ============================

/**
 * カード1枚を「意味検索に効く1本のテキスト」へ正規化する。
 * ここを変えると text_hash が変わり、再ベクトル化の対象になる。
 */
export function cardEmbedText(c: Record<string, any>): string {
  const parts = [
    `${c.card_name ?? ''}${c.version ? ` / ${c.version}` : ''}`,
    `${c.card_type ?? ''} ${c.ink_color ?? ''}${c.ink_color2 ? `・${c.ink_color2}` : ''}`,
    `コスト${c.ink_cost ?? '-'}`,
    c.strength != null ? `パワー${c.strength}` : '',
    c.willpower != null ? `willpower${c.willpower}` : '',
    c.lore_value != null ? `ロア${c.lore_value}` : '',
    c.classifications ? `種族: ${String(c.classifications).split('|').join('・')}` : '',
    c.abilities ? `キーワード能力: ${String(c.abilities).split('|').join('・')}` : '',
    String(c.rules_text_plain ?? '').replace(/\s+/g, ' '),
  ];
  return parts.filter(Boolean).join(' / ').slice(0, 1200);
}

export function ruleEmbedText(r: Record<string, any>): string {
  // heading+body は分断された1本の文なので ruleFullText で復元してから埋め込む
  return `[総合ルール ${r.section ?? ''}] ${ruleFullText(r)}`.slice(0, 1200);
}

/**
 * 公式Q&A 1件を検索用テキストへ。
 * 質問文だけだと「〜できますか？」ばかりで似通ってしまうため、
 * カテゴリ・質問・回答を1本にまとめて埋め込む。
 */
export function faqEmbedText(f: Record<string, any>): string {
  const q = String(f.question ?? '').replace(/\s+/g, ' ');
  const a = String(f.answer ?? '').replace(/\s+/g, ' ');
  const note = String(f.note ?? '').replace(/\s+/g, ' ');
  return `[公式Q&A ${f.category ?? ''}] Q: ${q} A: ${a}${note ? ` (${note})` : ''}`.slice(0, 1200);
}

// ============================ ベクトル検索 ============================

export type VecHit = { id: number; sim: number };

/**
 * card_vectors 全件とクエリベクトルの類似度上位を返す。
 *
 * 2,500枚 × 256次元 = 約2.5MB。D1 の 1 クエリで読み切り、
 * Worker 側で総当たり内積を取る（数ミリ秒）。
 * 近似最近傍インデックスを持たない D1 でも十分実用的な規模。
 */
export async function searchCardVectors(
  db: D1Database,
  query: Float32Array,
  opts: { topK?: number; excludeId?: number } = {}
): Promise<VecHit[]> {
  const topK = opts.topK ?? 60;
  const rows = await db.prepare('SELECT card_id, vec FROM card_vectors').all();
  const list = (rows.results ?? []) as any[];
  if (!list.length) return [];

  const q = normalize(query);
  const hits: VecHit[] = [];
  for (const r of list) {
    const id = Number(r.card_id);
    if (id === opts.excludeId) continue;
    const v = fromBlob(r.vec);
    if (!v) continue;
    hits.push({ id, sim: dot(q, v) });
  }
  hits.sort((a, b) => b.sim - a.sim);
  return hits.slice(0, topK);
}

export async function searchRuleVectors(
  db: D1Database,
  query: Float32Array,
  opts: { topK?: number } = {}
): Promise<VecHit[]> {
  const topK = opts.topK ?? 8;
  const rows = await db.prepare('SELECT section_id, vec FROM rule_vectors').all();
  const list = (rows.results ?? []) as any[];
  if (!list.length) return [];

  const q = normalize(query);
  const hits: VecHit[] = [];
  for (const r of list) {
    const v = fromBlob(r.vec);
    if (!v) continue;
    hits.push({ id: Number(r.section_id), sim: dot(q, v) });
  }
  hits.sort((a, b) => b.sim - a.sim);
  return hits.slice(0, topK);
}

export async function searchFaqVectors(
  db: D1Database,
  query: Float32Array,
  opts: { topK?: number } = {}
): Promise<VecHit[]> {
  const topK = opts.topK ?? 6;
  try {
    const rows = await db.prepare('SELECT faq_id, vec FROM faq_vectors').all();
    const list = (rows.results ?? []) as any[];
    if (!list.length) return [];

    const q = normalize(query);
    const hits: VecHit[] = [];
    for (const r of list) {
      const v = fromBlob(r.vec);
      if (!v) continue;
      hits.push({ id: Number(r.faq_id), sim: dot(q, v) });
    }
    hits.sort((a, b) => b.sim - a.sim);
    return hits.slice(0, topK);
  } catch {
    // マイグレーション未適用でも AI 探索を止めない
    return [];
  }
}

/** ベクトルが投入済みかどうか（未投入なら従来の LIKE 検索のみで動く） */
export async function vectorsReady(
  db: D1Database
): Promise<{ cards: number; rules: number; faqs: number }> {
  const count = async (sql: string) => {
    try {
      const r = await db.prepare(sql).first<{ n: number }>();
      return Number(r?.n ?? 0);
    } catch {
      return 0;
    }
  };
  return {
    cards: await count('SELECT COUNT(*) AS n FROM card_vectors'),
    rules: await count('SELECT COUNT(*) AS n FROM rule_vectors'),
    faqs: await count('SELECT COUNT(*) AS n FROM faq_vectors'),
  };
}

// ============================ 公式Q&A の想起 ============================

export type FaqHit = {
  id: number;
  category: string;
  question: string;
  answer: string;
  note: string;
  sim: number;
};

/**
 * クエリベクトルに意味的に近い公式Q&Aを取り出す。
 *
 * 公式Q&Aは総合ルールの条文より具体的（「インクに置けるのはどのカードか」等）で、
 * 短い（Q42字/A87字）ため、上位数件を丸ごとプロンプトに載せてもトークン負荷が小さい。
 * 類似度が低いものを混ぜると誤誘導になるため minSim で足切りする。
 */
export async function recallFaqs(
  db: D1Database,
  query: Float32Array,
  opts: { topK?: number; minSim?: number } = {}
): Promise<FaqHit[]> {
  const topK = opts.topK ?? 6;
  const minSim = opts.minSim ?? 0.28;
  const hits = (await searchFaqVectors(db, query, { topK: topK * 2 })).filter(
    (h) => h.sim >= minSim
  );
  if (!hits.length) return [];

  const ids = hits.slice(0, topK).map((h) => h.id);
  const simById = new Map(hits.map((h) => [h.id, h.sim]));
  try {
    const rows = await db
      .prepare(
        `SELECT id, category, question, answer, note FROM rule_faqs
          WHERE id IN (${ids.map(() => '?').join(',')})`
      )
      .bind(...ids)
      .all();
    return ((rows.results ?? []) as any[])
      .map((r) => ({
        id: Number(r.id),
        category: String(r.category ?? ''),
        question: String(r.question ?? ''),
        answer: String(r.answer ?? ''),
        note: String(r.note ?? ''),
        sim: simById.get(Number(r.id)) ?? 0,
      }))
      .sort((a, b) => b.sim - a.sim);
  } catch {
    return [];
  }
}

// ============================ キーワード能力の事前知識 ============================

export type AbilityKnowledge = {
  ability: string;
  summary: string;
  synergy_notes: string[];
  caveats: string[];
};

/**
 * 事前要約済みのキーワード能力知識を取り出す。
 * 毎回 rules_sections を丸ごと RAG する代わりに、この短い要約を渡す。
 */
export async function loadAbilityKnowledge(
  db: D1Database,
  abilities: string[]
): Promise<AbilityKnowledge[]> {
  const uniq = [...new Set(abilities.filter(Boolean))];
  if (!uniq.length) return [];
  try {
    const rows = await db
      .prepare(
        `SELECT ability, summary, synergy_notes, caveats FROM ability_knowledge
          WHERE ability IN (${uniq.map(() => '?').join(',')})`
      )
      .bind(...uniq)
      .all();
    const parse = (s: unknown): string[] => {
      try {
        const v = JSON.parse(String(s ?? '[]'));
        return Array.isArray(v) ? v.map((x) => String(x)) : [];
      } catch {
        return [];
      }
    };
    return ((rows.results ?? []) as any[]).map((r) => ({
      ability: String(r.ability),
      summary: String(r.summary ?? ''),
      synergy_notes: parse(r.synergy_notes),
      caveats: parse(r.caveats),
    }));
  } catch {
    return [];
  }
}

// ============================ シナジー事例の記憶 ============================

export type MemoryHit = { partner_id: number; score: number; reason: string; hits: number };

/** この起点カードについて過去に高評価だったパートナーを思い出す */
export async function recallSynergy(
  db: D1Database,
  baseId: number | null,
  limit = 20
): Promise<MemoryHit[]> {
  try {
    const rows = baseId
      ? await db
          .prepare(
            `SELECT partner_id, score, reason, hits FROM synergy_memory
              WHERE base_id = ? ORDER BY hits DESC, score DESC LIMIT ?`
          )
          .bind(baseId, limit)
          .all()
      : { results: [] };
    return ((rows.results ?? []) as any[]).map((r) => ({
      partner_id: Number(r.partner_id),
      score: Number(r.score),
      reason: String(r.reason ?? ''),
      hits: Number(r.hits ?? 1),
    }));
  } catch {
    return [];
  }
}

/**
 * 突合済み（＝実在が確認された）結果を記憶に書き戻す。
 * 同じペアが再登場したら hits を増やし、スコアは移動平均で更新する。
 * 失敗してもユーザー体験に影響させない（記憶は best-effort）。
 */
export async function rememberSynergy(
  db: D1Database,
  baseId: number | null,
  picks: Array<{ id: number; score: number; reason: string }>,
  model: string
): Promise<void> {
  const rows = picks.filter((p) => p.id && p.score >= 60).slice(0, 12);
  if (!rows.length) return;
  try {
    const stmts = rows.map((p) =>
      db
        .prepare(
          `INSERT INTO synergy_memory (base_id, partner_id, score, reason, hits, model)
             VALUES (?, ?, ?, ?, 1, ?)
           ON CONFLICT(COALESCE(base_id, -1), partner_id) DO UPDATE SET
             hits = hits + 1,
             score = CAST((score * hits + excluded.score) / (hits + 1) AS INTEGER),
             reason = COALESCE(NULLIF(excluded.reason, ''), reason),
             updated_at = CURRENT_TIMESTAMP`
        )
        .bind(baseId, p.id, Math.round(p.score), String(p.reason ?? '').slice(0, 400), model)
    );
    await db.batch(stmts);
  } catch {
    // 記憶の書き込み失敗は無視（探索結果は既に返せている）
  }
}
