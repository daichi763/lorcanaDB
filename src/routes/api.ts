/**
 * api.ts — カードDB / ルール 検索API
 */
import { Hono } from 'hono';
import type { Bindings, SearchParams } from '../types';
import { buildSearchQuery, splitConcat } from '../lib/search';

const api = new Hono<{ Bindings: Bindings }>();

const num = (v: unknown): number | undefined => {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

const arr = (v: unknown): string[] | undefined => {
  if (v === undefined || v === null) return undefined;
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === 'string') return v.split(',').map((s) => s.trim()).filter(Boolean);
  return undefined;
};

function shapeCard(row: Record<string, unknown>) {
  return {
    ...row,
    classifications: splitConcat(row.classifications),
    abilities: splitConcat(row.abilities),
  };
}

// ---- カード検索 -----------------------------------------------------------
api.post('/cards/search', async (c) => {
  let body: Record<string, unknown> = {};
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  const p: SearchParams = {
    freeword: typeof body.freeword === 'string' ? body.freeword : '',
    freeword_field: arr(body.freeword_field),
    ink_type: typeof body.ink_type === 'string' ? body.ink_type : undefined,
    ink_color: arr(body.ink_color),
    card_type: arr(body.card_type),
    classification: arr(body.classification),
    classification_mode: body.classification_mode === 'and' ? 'and' : 'or',
    rarity: arr(body.rarity),
    ability: arr(body.ability),
    sets: arr(body.sets),
    inkwell: arr(body.inkwell),
    refs_classification: arr(body.refs_classification),
    ink_cost_min: num(body.ink_cost_min),
    ink_cost_max: num(body.ink_cost_max),
    strength_min: num(body.strength_min),
    strength_max: num(body.strength_max),
    willpower_min: num(body.willpower_min),
    willpower_max: num(body.willpower_max),
    lore_value_min: num(body.lore_value_min),
    lore_value_max: num(body.lore_value_max),
    move_cost_min: num(body.move_cost_min),
    move_cost_max: num(body.move_cost_max),
    search_sort: typeof body.search_sort === 'string' ? body.search_sort : undefined,
    posts_per_page: num(body.posts_per_page),
    page: num(body.page),
  };

  const q = buildSearchQuery(p);
  const [rowsRes, countRes] = await Promise.all([
    c.env.DB.prepare(q.sql).bind(...q.binds).all(),
    c.env.DB.prepare(q.countSql).bind(...q.countBinds).first<{ n: number }>(),
  ]);

  const count = countRes?.n ?? 0;
  return c.json({
    cards: (rowsRes.results ?? []).map((r) => shapeCard(r as Record<string, unknown>)),
    count,
    page: q.page,
    per_page: q.perPage,
    total_pages: Math.max(Math.ceil(count / q.perPage), 1),
  });
});

// ---- カード詳細（id または card_file）------------------------------------
api.get('/cards/:key', async (c) => {
  const key = c.req.param('key');
  const isId = /^\d+$/.test(key);
  const row = await c.env.DB.prepare(
    `SELECT c.*,
            (SELECT GROUP_CONCAT(cl.classification, '|') FROM classifications cl WHERE cl.card_id = c.id) AS classifications,
            (SELECT GROUP_CONCAT(ab.ability, '|') FROM abilities ab WHERE ab.card_id = c.id) AS abilities,
            (SELECT GROUP_CONCAT(cr.classification, '|') FROM card_refs cr WHERE cr.card_id = c.id) AS referenced_classifications
       FROM cards c WHERE ${isId ? 'c.id = ?' : 'c.card_file = ?'}`
  )
    .bind(isId ? Number(key) : key)
    .first<Record<string, unknown>>();

  if (!row) return c.json({ error: 'not_found' }, 404);

  // 同名カード（別バージョン）
  const related = await c.env.DB.prepare(
    `SELECT id, card_file, card_name, version, rarity, sets_name, image_url, ink_cost
       FROM cards WHERE card_name = ? AND id != ? ORDER BY sets_order DESC LIMIT 12`
  )
    .bind(row.card_name, row.id)
    .all();

  return c.json({
    card: {
      ...shapeCard(row),
      referenced_classifications: splitConcat(row.referenced_classifications),
    },
    related: related.results ?? [],
  });
});

// ---- 複数カード一括取得（card_file 配列）---------------------------------
api.post('/cards/by-files', async (c) => {
  let body: { files?: unknown } = {};
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }
  const files = Array.isArray(body.files) ? body.files.map(String).slice(0, 200) : [];
  if (!files.length) return c.json({ cards: [] });

  const res = await c.env.DB.prepare(
    `SELECT c.id, c.card_file, c.card_name, c.version, c.card_type, c.ink_color, c.ink_color2,
            c.rarity, c.inkwell, c.ink_cost, c.strength, c.willpower, c.move_cost, c.lore_value,
            c.rules_text, c.sets_name, c.limit_card, c.image_url,
            (SELECT GROUP_CONCAT(cl.classification, '|') FROM classifications cl WHERE cl.card_id = c.id) AS classifications,
            (SELECT GROUP_CONCAT(ab.ability, '|') FROM abilities ab WHERE ab.card_id = c.id) AS abilities
       FROM cards c WHERE c.card_file IN (${files.map(() => '?').join(',')})`
  )
    .bind(...files)
    .all();

  return c.json({ cards: (res.results ?? []).map((r) => shapeCard(r as Record<string, unknown>)) });
});

// ---- マスタ（UI 選択肢）---------------------------------------------------
api.get('/masters', async (c) => {
  const [sets, rarities, types, inks, classes, abilities, refs, meta] = await Promise.all([
    c.env.DB.prepare('SELECT sets_name AS v, MAX(sets_order) AS o, COUNT(*) AS n FROM cards WHERE sets_name IS NOT NULL GROUP BY sets_name ORDER BY o DESC').all(),
    c.env.DB.prepare('SELECT rarity AS v, COUNT(*) AS n FROM cards GROUP BY rarity ORDER BY n DESC').all(),
    c.env.DB.prepare('SELECT card_type AS v, COUNT(*) AS n FROM cards GROUP BY card_type ORDER BY n DESC').all(),
    c.env.DB.prepare('SELECT ink_color AS v, COUNT(*) AS n FROM cards GROUP BY ink_color ORDER BY n DESC').all(),
    c.env.DB.prepare('SELECT classification AS v, COUNT(*) AS n FROM classifications GROUP BY classification ORDER BY n DESC').all(),
    c.env.DB.prepare('SELECT ability AS v, COUNT(*) AS n FROM abilities GROUP BY ability ORDER BY n DESC').all(),
    c.env.DB.prepare('SELECT classification AS v, COUNT(*) AS n FROM card_refs GROUP BY classification ORDER BY n DESC').all(),
    c.env.DB.prepare('SELECT key, value FROM meta').all(),
  ]);

  return c.json({
    sets: sets.results ?? [],
    rarities: rarities.results ?? [],
    card_types: types.results ?? [],
    ink_colors: inks.results ?? [],
    classifications: classes.results ?? [],
    abilities: abilities.results ?? [],
    referenced_classifications: refs.results ?? [],
    meta: Object.fromEntries((meta.results ?? []).map((r: any) => [r.key, r.value])),
  });
});

// ---- シナジー: 指定種族を参照するカード ⇄ その種族を持つカード ----------
api.get('/synergy/:classification', async (c) => {
  const cl = c.req.param('classification');
  const sel =
    `SELECT id, card_file, card_name, version, card_type, ink_color, ink_cost, strength, willpower,
            lore_value, rarity, sets_name, image_url, rules_text`;

  const [referrers, holders] = await Promise.all([
    c.env.DB.prepare(
      `${sel} FROM cards WHERE id IN (SELECT card_id FROM card_refs WHERE classification = ?)
        ORDER BY sets_order DESC, collector_number ASC LIMIT 60`
    ).bind(cl).all(),
    c.env.DB.prepare(
      `${sel} FROM cards WHERE id IN (SELECT card_id FROM classifications WHERE classification = ?)
        ORDER BY sets_order DESC, collector_number ASC LIMIT 120`
    ).bind(cl).all(),
  ]);

  return c.json({
    classification: cl,
    referrers: referrers.results ?? [], // 効果テキストでこの種族を参照するカード
    holders: holders.results ?? [],     // この種族を持つカード
  });
});

// ---- ルール検索（§8: ヒット周辺 ±200 文字のみ返す）----------------------
api.get('/rules/search', async (c) => {
  const q = (c.req.query('q') ?? '').trim();
  const source = c.req.query('source') ?? '';
  if (!q) return c.json({ results: [], count: 0 });

  const conds = ['(heading LIKE ? OR body LIKE ?)'];
  const binds: unknown[] = [`%${q}%`, `%${q}%`];
  if (source) {
    conds.push('source = ?');
    binds.push(source);
  }

  const res = await c.env.DB.prepare(
    `SELECT id, source, source_label, section, heading, body, pdf_url, page_no
       FROM rules_sections WHERE ${conds.join(' AND ')}
      ORDER BY source, section LIMIT 60`
  )
    .bind(...binds)
    .all();

  // 全文は返さない（§2.7 / §8 の安全ライン）: ヒット位置 ±200 文字の抜粋のみ
  const results = (res.results ?? []).map((r: any) => {
    const body = String(r.body ?? '');
    const i = body.indexOf(q);
    let snippet: string;
    let truncated = false;
    if (i >= 0) {
      const s = Math.max(0, i - 200);
      const e = Math.min(body.length, i + q.length + 200);
      snippet = (s > 0 ? '…' : '') + body.slice(s, e) + (e < body.length ? '…' : '');
      truncated = s > 0 || e < body.length;
    } else {
      snippet = body.slice(0, 400) + (body.length > 400 ? '…' : '');
      truncated = body.length > 400;
    }
    return {
      id: r.id,
      source: r.source,
      source_label: r.source_label,
      section: r.section,
      heading: r.heading,
      snippet,
      truncated,
      pdf_url: r.pdf_url,
      page_no: r.page_no,
    };
  });

  return c.json({ results, count: results.length, query: q });
});

// ---- ルール目次 ----------------------------------------------------------
api.get('/rules/toc', async (c) => {
  const res = await c.env.DB.prepare(
    `SELECT id, source, source_label, section, heading, page_no, LENGTH(body) AS body_len
       FROM rules_sections ORDER BY source, CAST(section AS REAL), section`
  ).all();
  return c.json({ sections: res.results ?? [] });
});

// ---- ルール本文（1 セクション / 冒頭 ±200 文字相当の抜粋）---------------
api.get('/rules/section/:id', async (c) => {
  const id = Number(c.req.param('id'));
  const r = await c.env.DB.prepare(
    'SELECT id, source, source_label, section, heading, body, pdf_url, page_no FROM rules_sections WHERE id = ?'
  )
    .bind(id)
    .first<any>();
  if (!r) return c.json({ error: 'not_found' }, 404);

  const body = String(r.body ?? '');
  const LIMIT = 400; // §8: 常時全公開は避け、続きは公式PDFへ誘導
  return c.json({
    ...r,
    body: body.slice(0, LIMIT) + (body.length > LIMIT ? '…' : ''),
    truncated: body.length > LIMIT,
  });
});

export default api;
