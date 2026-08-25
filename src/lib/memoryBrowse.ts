/**
 * 記憶層ブラウザ（管理画面用の読み取り専用API）
 *
 * ■ なぜ必要か
 * このサイトのAIは、毎回カード全文やルール本文を読み直すのではなく、
 * 事前計算した「記憶」を D1 から引いて答えている。つまり **AIの回答品質は
 * 記憶層の中身で決まる**。ところが記憶層はベクトル(BLOB)と要約テキストの塊で、
 * 外から見えない。「AIが古い環境情報を今のことのように話す」「シナジー提案が
 * 的外れ」といった不具合が起きたとき、原因が記憶層にあるのか判断できなかった。
 *
 * そこで管理画面から記憶層を直接覗けるようにする。
 *
 * ■ 設計方針
 * - **読み取り専用**。ここから記憶を書き換えられるようにはしない
 *   （記憶の更新は必ず既存のパイプライン経由。手で触れると再現性が失われる）。
 * - **ベクトルの生値(BLOB)は返さない**。1KB×2500件を管理画面に流す意味はない。
 *   代わりに「ベクトルが健全か」を数値（ノルム・次元）で示す。
 * - **6系統をひとつのAPIで扱う**。系統ごとに別エンドポイントを作ると
 *   画面側が系統の数だけ分岐して壊れやすい。kind パラメータで切り替える。
 * - **想起の再現（recall）も同じ画面から試せる**ようにする。一覧を見るだけでは
 *   「この質問でこの記憶が引かれるのか」が分からず、原因究明に届かない。
 */

import type { AiEnv } from '../types';
import {
  EMBED_DIMS,
  embed,
  fromBlob,
  dot,
  normalize,
  searchCardVectors,
  searchRuleVectors,
  searchFaqVectors,
} from './memory';
import { recallMeta } from './metaReport';

/** 記憶層の系統。画面のタブと1対1に対応する */
export const MEMORY_KINDS = [
  'meta_knowledge',
  'ability_knowledge',
  'synergy_memory',
  'card_vectors',
  'rule_vectors',
  'faq_vectors',
] as const;

export type MemoryKind = (typeof MEMORY_KINDS)[number];

export type MemoryOverview = {
  kinds: {
    kind: MemoryKind;
    label: string;
    /** この系統が何を覚えているかの1行説明（画面にそのまま出す） */
    description: string;
    rows: number;
    /** 親テーブルの件数（ベクトル系のみ。未ベクトル化の検出に使う） */
    source_rows: number | null;
    /** 未ベクトル化＝AIから引けない件数。0以外なら異常 */
    missing: number | null;
    /** 親が消えたのに残っているベクトル。0以外なら異常 */
    orphans: number | null;
    updated_at: string | null;
  }[];
  health: { ok: boolean; issues: string[] };
};

const n = async (db: D1Database, sql: string): Promise<number> => {
  try {
    const r = await db.prepare(sql).first<{ n: number }>();
    return Number(r?.n ?? 0);
  } catch {
    return 0;
  }
};

const maxAt = async (db: D1Database, table: string, col = 'updated_at'): Promise<string | null> => {
  try {
    const r = await db.prepare(`SELECT MAX(${col}) AS v FROM ${table}`).first<{ v: string }>();
    return r?.v ? String(r.v) : null;
  } catch {
    return null;
  }
};

/**
 * 記憶層全体のサマリと健全性。
 * 「未ベクトル化」「孤児ベクトル」は実際に起こりうる不具合なので必ず数える
 * （未ベクトル化はAIから引けない＝覚えていないのと同じ。黙って劣化する）。
 */
export async function memoryOverview(db: D1Database): Promise<MemoryOverview> {
  const [
    metaK,
    metaV,
    ability,
    synergy,
    cards,
    cardV,
    rules,
    ruleV,
    faqs,
    faqV,
    metaMissing,
    cardMissing,
    ruleMissing,
    faqMissing,
    metaOrphan,
    cardOrphan,
    ruleOrphan,
    faqOrphan,
  ] = await Promise.all([
    n(db, 'SELECT COUNT(*) AS n FROM meta_knowledge'),
    n(db, 'SELECT COUNT(*) AS n FROM meta_vectors'),
    n(db, 'SELECT COUNT(*) AS n FROM ability_knowledge'),
    n(db, 'SELECT COUNT(*) AS n FROM synergy_memory'),
    n(db, 'SELECT COUNT(*) AS n FROM cards'),
    n(db, 'SELECT COUNT(*) AS n FROM card_vectors'),
    n(db, 'SELECT COUNT(*) AS n FROM rules_sections'),
    n(db, 'SELECT COUNT(*) AS n FROM rule_vectors'),
    n(db, 'SELECT COUNT(*) AS n FROM rule_faqs'),
    n(db, 'SELECT COUNT(*) AS n FROM faq_vectors'),
    // text_hash 不一致も「未同期」として数える（本文が変わったのにベクトルが古い状態）
    n(
      db,
      `SELECT COUNT(*) AS n FROM meta_knowledge k
         LEFT JOIN meta_vectors v ON v.knowledge_id = k.id
        WHERE v.knowledge_id IS NULL OR v.text_hash <> k.text_hash`
    ),
    n(
      db,
      `SELECT COUNT(*) AS n FROM cards c
         LEFT JOIN card_vectors v ON v.card_id = c.id WHERE v.card_id IS NULL`
    ),
    n(
      db,
      `SELECT COUNT(*) AS n FROM rules_sections s
         LEFT JOIN rule_vectors v ON v.section_id = s.id WHERE v.section_id IS NULL`
    ),
    n(
      db,
      `SELECT COUNT(*) AS n FROM rule_faqs f
         LEFT JOIN faq_vectors v ON v.faq_id = f.id WHERE v.faq_id IS NULL`
    ),
    n(
      db,
      `SELECT COUNT(*) AS n FROM meta_vectors v
         LEFT JOIN meta_knowledge k ON k.id = v.knowledge_id WHERE k.id IS NULL`
    ),
    n(
      db,
      `SELECT COUNT(*) AS n FROM card_vectors v
         LEFT JOIN cards c ON c.id = v.card_id WHERE c.id IS NULL`
    ),
    n(
      db,
      `SELECT COUNT(*) AS n FROM rule_vectors v
         LEFT JOIN rules_sections s ON s.id = v.section_id WHERE s.id IS NULL`
    ),
    n(
      db,
      `SELECT COUNT(*) AS n FROM faq_vectors v
         LEFT JOIN rule_faqs f ON f.id = v.faq_id WHERE f.id IS NULL`
    ),
  ]);

  const [metaAt, abilityAt, synergyAt, cardAt, ruleAt, faqAt] = await Promise.all([
    maxAt(db, 'meta_knowledge'),
    maxAt(db, 'ability_knowledge'),
    maxAt(db, 'synergy_memory'),
    maxAt(db, 'card_vectors'),
    maxAt(db, 'rule_vectors'),
    maxAt(db, 'faq_vectors'),
  ]);

  const kinds: MemoryOverview['kinds'] = [
    {
      kind: 'meta_knowledge',
      label: '環境知識',
      description:
        '日次レポートから作られる「今の環境」の記憶。AIが「今の環境では〜」と答える根拠。',
      rows: metaK,
      source_rows: metaV,
      missing: metaMissing,
      orphans: metaOrphan,
      updated_at: metaAt,
    },
    {
      kind: 'ability_knowledge',
      label: 'キーワード能力の裁定知識',
      description:
        '13種のキーワード能力を事前要約したもの。毎回ルール条文を読み直さずに済ませるための記憶。',
      rows: ability,
      source_rows: null,
      missing: null,
      orphans: null,
      updated_at: abilityAt,
    },
    {
      kind: 'synergy_memory',
      label: '検証済みシナジー事例',
      description:
        '過去に生成し実在カードと突合できたペア。同じ質問で毎回違う答えになるのを抑える経験の蓄積。',
      rows: synergy,
      source_rows: null,
      missing: null,
      orphans: null,
      updated_at: synergyAt,
    },
    {
      kind: 'card_vectors',
      label: 'カードの意味ベクトル',
      description: 'カード効果テキストの意味表現。自由記述からカードを意味で引くために使う。',
      rows: cardV,
      source_rows: cards,
      missing: cardMissing,
      orphans: cardOrphan,
      updated_at: cardAt,
    },
    {
      kind: 'rule_vectors',
      label: '総合ルール条文のベクトル',
      description: '総合ルール各節の意味表現。質問に関連する条文を意味で引くために使う。',
      rows: ruleV,
      source_rows: rules,
      missing: ruleMissing,
      orphans: ruleOrphan,
      updated_at: ruleAt,
    },
    {
      kind: 'faq_vectors',
      label: '公式Q&Aのベクトル',
      description: '公式Q&A（79件）の意味表現。裁定の根拠として引くために使う。',
      rows: faqV,
      source_rows: faqs,
      missing: faqMissing,
      orphans: faqOrphan,
      updated_at: faqAt,
    },
  ];

  const issues: string[] = [];
  for (const k of kinds) {
    if (k.missing) issues.push(`${k.label}: 未ベクトル化 ${k.missing}件（AIから引けない）`);
    if (k.orphans) issues.push(`${k.label}: 孤児ベクトル ${k.orphans}件（親データが存在しない）`);
    if (k.rows === 0) issues.push(`${k.label}: 記憶が0件`);
  }

  return { kinds, health: { ok: issues.length === 0, issues } };
}

// ============================ 一覧 ============================

export type MemoryListResult = {
  kind: MemoryKind;
  total: number;
  offset: number;
  limit: number;
  items: Record<string, unknown>[];
};

const clampLimit = (v: unknown, def = 20, max = 100) =>
  Math.min(Math.max(Number(v) || def, 1), max);

/**
 * 系統ごとの記憶を一覧する。
 *
 * ベクトル系は BLOB を返す代わりに、その場でノルムを計算して健全性だけ示す
 * （ノルムが 1 から大きく外れていれば埋め込みが壊れている）。
 */
export async function memoryList(
  db: D1Database,
  kind: MemoryKind,
  opts: { q?: string; offset?: number; limit?: number; scope?: string } = {}
): Promise<MemoryListResult> {
  const limit = clampLimit(opts.limit);
  const offset = Math.max(Number(opts.offset) || 0, 0);
  const q = (opts.q || '').trim();
  const like = `%${q}%`;

  if (kind === 'meta_knowledge') {
    const scope = (opts.scope || '').trim();
    const where: string[] = [];
    const binds: unknown[] = [];
    if (q) {
      where.push('(k.title LIKE ? OR k.body LIKE ?)');
      binds.push(like, like);
    }
    if (scope) {
      where.push('k.scope = ?');
      binds.push(scope);
    }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = Number(
      (
        await db
          .prepare(`SELECT COUNT(*) AS n FROM meta_knowledge k ${w}`)
          .bind(...binds)
          .first<{ n: number }>()
      )?.n ?? 0
    );
    const rows = await db
      .prepare(
        `SELECT k.id, k.scope, k.title, k.body, k.observed_at, k.region, k.trust,
                k.official_url, k.created_at, k.updated_at,
                (v.knowledge_id IS NOT NULL AND v.text_hash = k.text_hash) AS vector_ok
           FROM meta_knowledge k
           LEFT JOIN meta_vectors v ON v.knowledge_id = k.id
           ${w}
          ORDER BY COALESCE(k.observed_at, k.created_at) DESC, k.id DESC
          LIMIT ? OFFSET ?`
      )
      .bind(...binds, limit, offset)
      .all();
    return {
      kind,
      total,
      offset,
      limit,
      items: (rows.results ?? []).map((r: any) => ({
        id: Number(r.id),
        scope: String(r.scope ?? ''),
        title: String(r.title ?? ''),
        body: String(r.body ?? ''),
        observed_at: r.observed_at ?? null,
        region: String(r.region ?? 'jp'),
        trust: Number(r.trust ?? 3),
        official_url: r.official_url ?? null,
        vector_ok: !!Number(r.vector_ok),
        updated_at: r.updated_at ?? null,
      })),
    };
  }

  if (kind === 'ability_knowledge') {
    const w = q ? 'WHERE ability LIKE ? OR summary LIKE ?' : '';
    const binds = q ? [like, like] : [];
    const total = Number(
      (
        await db
          .prepare(`SELECT COUNT(*) AS n FROM ability_knowledge ${w}`)
          .bind(...binds)
          .first<{ n: number }>()
      )?.n ?? 0
    );
    const rows = await db
      .prepare(
        `SELECT ability, summary, synergy_notes, caveats, sections, model, updated_at
           FROM ability_knowledge ${w} ORDER BY ability LIMIT ? OFFSET ?`
      )
      .bind(...binds, limit, offset)
      .all();
    const parse = (s: unknown): string[] => {
      try {
        const v = JSON.parse(String(s ?? '[]'));
        return Array.isArray(v) ? v.map(String) : [];
      } catch {
        return [];
      }
    };
    return {
      kind,
      total,
      offset,
      limit,
      items: (rows.results ?? []).map((r: any) => ({
        ability: String(r.ability ?? ''),
        summary: String(r.summary ?? ''),
        synergy_notes: parse(r.synergy_notes),
        caveats: parse(r.caveats),
        sections: parse(r.sections),
        model: r.model ?? null,
        updated_at: r.updated_at ?? null,
      })),
    };
  }

  if (kind === 'synergy_memory') {
    // カード名を突合して返す（ID だけ見せても人間には判断できない）
    const w = q ? 'WHERE (bc.card_name LIKE ? OR pc.card_name LIKE ? OR m.reason LIKE ?)' : '';
    const binds = q ? [like, like, like] : [];
    const total = Number(
      (
        await db
          .prepare(
            `SELECT COUNT(*) AS n FROM synergy_memory m
               LEFT JOIN cards bc ON bc.id = m.base_id
               LEFT JOIN cards pc ON pc.id = m.partner_id ${w}`
          )
          .bind(...binds)
          .first<{ n: number }>()
      )?.n ?? 0
    );
    const rows = await db
      .prepare(
        `SELECT m.id, m.base_id, m.partner_id, m.score, m.reason, m.hits, m.model,
                m.created_at, m.updated_at,
                bc.card_name AS base_name, bc.card_group AS base_group,
                pc.card_name AS partner_name, pc.card_group AS partner_group
           FROM synergy_memory m
           LEFT JOIN cards bc ON bc.id = m.base_id
           LEFT JOIN cards pc ON pc.id = m.partner_id
           ${w}
          ORDER BY m.hits DESC, m.score DESC, m.id DESC LIMIT ? OFFSET ?`
      )
      .bind(...binds, limit, offset)
      .all();
    return {
      kind,
      total,
      offset,
      limit,
      items: (rows.results ?? []).map((r: any) => ({
        id: Number(r.id),
        base_id: r.base_id ?? null,
        base_name: r.base_group || r.base_name || null,
        partner_id: Number(r.partner_id),
        partner_name: r.partner_group || r.partner_name || null,
        score: Number(r.score ?? 0),
        reason: String(r.reason ?? ''),
        hits: Number(r.hits ?? 1),
        model: r.model ?? null,
        updated_at: r.updated_at ?? null,
      })),
    };
  }

  // ---- ベクトル系（card / rule / faq）----
  const spec = {
    card_vectors: {
      table: 'card_vectors',
      key: 'card_id',
      join: 'cards p ON p.id = v.card_id',
      labelSql: "COALESCE(p.card_group, p.card_name)",
      searchSql: 'p.card_name LIKE ? OR p.card_group LIKE ?',
      searchCount: 2,
    },
    rule_vectors: {
      table: 'rule_vectors',
      key: 'section_id',
      join: 'rules_sections p ON p.id = v.section_id',
      labelSql: "COALESCE(p.section || ' ' || p.heading, p.heading)",
      searchSql: 'p.heading LIKE ? OR p.section LIKE ?',
      searchCount: 2,
    },
    faq_vectors: {
      table: 'faq_vectors',
      key: 'faq_id',
      join: 'rule_faqs p ON p.id = v.faq_id',
      labelSql: 'p.question',
      searchSql: 'p.question LIKE ?',
      searchCount: 1,
    },
  }[kind as 'card_vectors' | 'rule_vectors' | 'faq_vectors'];

  const w = q ? `WHERE ${spec.searchSql}` : '';
  const binds = q ? Array(spec.searchCount).fill(like) : [];
  const total = Number(
    (
      await db
        .prepare(
          `SELECT COUNT(*) AS n FROM ${spec.table} v LEFT JOIN ${spec.join} ${w}`
        )
        .bind(...binds)
        .first<{ n: number }>()
    )?.n ?? 0
  );
  const rows = await db
    .prepare(
      `SELECT v.${spec.key} AS ref_id, v.dims, v.model, v.updated_at, v.vec,
              ${spec.labelSql} AS label, v.source_text
         FROM ${spec.table} v LEFT JOIN ${spec.join} ${w}
        ORDER BY v.${spec.key} LIMIT ? OFFSET ?`
    )
    .bind(...binds, limit, offset)
    .all();

  return {
    kind,
    total,
    offset,
    limit,
    items: (rows.results ?? []).map((r: any) => {
      // BLOB は返さない。健全性の指標だけ返す（1KB×件数を画面に流さない）
      const v = fromBlob(r.vec);
      let norm = 0;
      if (v) {
        let s = 0;
        for (let i = 0; i < v.length; i++) s += v[i] * v[i];
        norm = Math.sqrt(s);
      }
      return {
        ref_id: Number(r.ref_id),
        label: r.label ? String(r.label) : `(id=${r.ref_id})`,
        dims: Number(r.dims ?? 0),
        dims_ok: Number(r.dims ?? 0) === EMBED_DIMS,
        norm: Math.round(norm * 10000) / 10000,
        // 正規化済みベクトルはノルム1。0.5〜1.5 を外れたら埋め込みが壊れている
        norm_ok: norm > 0.5 && norm < 1.5,
        model: r.model ?? null,
        source_text: String(r.source_text ?? '').slice(0, 300),
        updated_at: r.updated_at ?? null,
      };
    }),
  };
}

/** meta_knowledge の scope 一覧（画面の絞り込みプルダウン用） */
export async function memoryScopes(db: D1Database): Promise<{ scope: string; rows: number }[]> {
  try {
    const rows = await db
      .prepare('SELECT scope, COUNT(*) AS n FROM meta_knowledge GROUP BY scope ORDER BY n DESC')
      .all();
    return (rows.results ?? []).map((r: any) => ({
      scope: String(r.scope ?? ''),
      rows: Number(r.n ?? 0),
    }));
  } catch {
    return [];
  }
}

// ============================ 想起の再現 ============================

export type RecallProbe = {
  query: string;
  model: string;
  meta: { id: number; scope: string; title: string; body: string; observed_at: string | null; sim: number }[];
  cards: { id: number; name: string; sim: number }[];
  rules: { id: number; label: string; sim: number }[];
  faqs: { id: number; question: string; sim: number }[];
};

/**
 * 任意の質問文で「実際にどの記憶が引かれるか」を再現する。
 *
 * 一覧を眺めるだけでは「AIが変な答えを返す」原因に届かない。
 * 本番と同じ埋め込み・同じ類似度計算・同じ閾値で引き直して、
 * 記憶側の問題（古い記憶が上位に来る／関係ない記憶が引かれる）を切り分ける。
 */
export async function recallProbe(
  env: AiEnv,
  db: D1Database,
  query: string,
  opts: { topK?: number; minSim?: number } = {}
): Promise<RecallProbe> {
  const topK = Math.min(Math.max(Number(opts.topK) || 5, 1), 20);
  const minSim = typeof opts.minSim === 'number' ? opts.minSim : 0.25;

  const [qv] = await embed(env, [query]);
  const q = normalize(qv);

  const metaHits = await recallMeta(db, q, { topK, minSim });

  // カード / ルール / Q&A は既存の検索関数を使う（本番と同じ経路で引く）
  const [cardHits, ruleHits, faqHits] = await Promise.all([
    searchCardVectors(db, q, { topK }).catch(() => [] as { id: number; sim: number }[]),
    searchRuleVectors(db, q, { topK }).catch(() => [] as { id: number; sim: number }[]),
    searchFaqVectors(db, q, { topK }).catch(() => [] as { id: number; sim: number }[]),
  ]);

  const nameOf = async (sql: string, ids: number[]): Promise<Map<number, string>> => {
    const m = new Map<number, string>();
    if (!ids.length) return m;
    const rows = await db
      .prepare(sql.replace('?ids', ids.map(() => '?').join(',')))
      .bind(...ids)
      .all();
    for (const r of (rows.results ?? []) as any[]) m.set(Number(r.id), String(r.label ?? ''));
    return m;
  };

  const [cardNames, ruleNames, faqNames] = await Promise.all([
    nameOf(
      `SELECT id, COALESCE(card_group, card_name) AS label FROM cards WHERE id IN (?ids)`,
      cardHits.map((h) => h.id)
    ),
    nameOf(
      `SELECT id, COALESCE(section || ' ' || heading, heading) AS label FROM rules_sections WHERE id IN (?ids)`,
      ruleHits.map((h) => h.id)
    ),
    nameOf(
      `SELECT id, question AS label FROM rule_faqs WHERE id IN (?ids)`,
      faqHits.map((h) => h.id)
    ),
  ]);

  const round = (v: number) => Math.round(v * 1000) / 1000;

  return {
    query,
    model: 'text-embedding-3-small',
    meta: metaHits.map((h) => ({
      id: h.id,
      scope: h.scope,
      title: h.title,
      body: h.body.slice(0, 200),
      observed_at: h.observed_at,
      sim: round(h.sim),
    })),
    cards: cardHits.map((h) => ({
      id: h.id,
      name: cardNames.get(h.id) || `(id=${h.id})`,
      sim: round(h.sim),
    })),
    rules: ruleHits.map((h) => ({
      id: h.id,
      label: ruleNames.get(h.id) || `(id=${h.id})`,
      sim: round(h.sim),
    })),
    faqs: faqHits.map((h) => ({
      id: h.id,
      question: faqNames.get(h.id) || `(id=${h.id})`,
      sim: round(h.sim),
    })),
  };
}
