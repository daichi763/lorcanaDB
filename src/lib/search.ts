/**
 * search.ts — 検索クエリ DSL
 *
 * 公式サイトの検索フォーム項目（BUILD_SPEC §2.3）を漏れなくSQLに落とす。
 * D1 は FTS5 trigram 非対応のため、日本語部分一致は LIKE '%…%' で行う。
 * 2,500 件規模では実測 10ms 未満。
 */
import type { SearchParams } from '../types';
import { ALL, SORT_MAP, FREEWORD_COLUMNS } from '../types';

export type BuiltQuery = {
  sql: string;
  countSql: string;
  binds: unknown[];
  countBinds: unknown[];
  page: number;
  perPage: number;
};

const clean = (arr?: string[]) =>
  (arr ?? []).map((s) => s.trim()).filter((s) => s.length > 0 && s !== ALL);

/** LIKE のワイルドカードをエスケープ（ESCAPE '\' 前提） */
const likeEscape = (s: string) => s.replace(/([\\%_])/g, '\\$1');

export function buildSearchQuery(p: SearchParams): BuiltQuery {
  const where: string[] = [];
  const binds: unknown[] = [];

  // ---- フリーワード（対象フィールドを OR 連結）------------------------------
  const fw = (p.freeword ?? '').trim();
  if (fw) {
    const fields = clean(p.freeword_field);
    const targets = fields.length > 0 ? fields : Object.keys(FREEWORD_COLUMNS);
    const cols = new Set<string>();
    for (const f of targets) for (const col of FREEWORD_COLUMNS[f] ?? []) cols.add(col);
    if (cols.size === 0) for (const col of FREEWORD_COLUMNS['カード名']) cols.add(col);

    // スペース区切りの複数語は AND（各語がいずれかのカラムに含まれる）
    const terms = fw.split(/[\s　]+/).filter(Boolean).slice(0, 6);
    for (const term of terms) {
      const ors = [...cols].map((col) => `${col} LIKE ? ESCAPE '\\'`);
      where.push(`(${ors.join(' OR ')})`);
      for (let i = 0; i < cols.size; i++) binds.push(`%${likeEscape(term)}%`);
    }
  }

  // ---- インク種別（シングル / デュアル）------------------------------------
  if (p.ink_type && p.ink_type !== ALL) {
    where.push('c.ink_type = ?');
    binds.push(p.ink_type);
  }

  // ---- インク色（ink_color / ink_color2 のいずれか）------------------------
  const inks = clean(p.ink_color);
  if (inks.length) {
    const ors = inks.map(() => '(c.ink_color = ? OR c.ink_color2 = ?)');
    where.push(`(${ors.join(' OR ')})`);
    for (const v of inks) binds.push(v, v);
  }

  // ---- 単純 IN 条件 ---------------------------------------------------------
  const inCond = (col: string, vals: string[]) => {
    if (!vals.length) return;
    where.push(`${col} IN (${vals.map(() => '?').join(',')})`);
    binds.push(...vals);
  };
  inCond('c.card_type', clean(p.card_type));
  inCond('c.rarity', clean(p.rarity));
  inCond('c.sets_name', clean(p.sets));

  // ---- インクウェル -------------------------------------------------------
  const iw = clean(p.inkwell);
  if (iw.length === 1) {
    where.push('c.inkwell = ?');
    binds.push(iw[0] === 'インク可能' ? 'y' : 'n');
  }

  // ---- クラス（種族）AND / OR 切替 -----------------------------------------
  const classes = clean(p.classification);
  if (classes.length) {
    if (p.classification_mode === 'and') {
      // 指定した全種族を持つカード
      where.push(
        `(SELECT COUNT(DISTINCT cl.classification) FROM classifications cl
           WHERE cl.card_id = c.id AND cl.classification IN (${classes.map(() => '?').join(',')})) = ?`
      );
      binds.push(...classes, classes.length);
    } else {
      where.push(
        `EXISTS (SELECT 1 FROM classifications cl
                  WHERE cl.card_id = c.id AND cl.classification IN (${classes.map(() => '?').join(',')}))`
      );
      binds.push(...classes);
    }
  }

  // ---- キーワード能力 -----------------------------------------------------
  const abilities = clean(p.ability);
  if (abilities.length) {
    where.push(
      `EXISTS (SELECT 1 FROM abilities ab
                WHERE ab.card_id = c.id AND ab.ability IN (${abilities.map(() => '?').join(',')}))`
    );
    binds.push(...abilities);
  }

  // ---- 効果テキスト内の種族参照（シナジー逆引き / §7-1）-------------------
  const refs = clean(p.refs_classification);
  if (refs.length) {
    where.push(
      `EXISTS (SELECT 1 FROM card_refs cr
                WHERE cr.card_id = c.id AND cr.classification IN (${refs.map(() => '?').join(',')}))`
    );
    binds.push(...refs);
  }

  // ---- 数値レンジ（未指定なら条件を出さない）-------------------------------
  const range = (col: string, min?: number, max?: number) => {
    if (min !== undefined && min !== null && Number.isFinite(min)) {
      where.push(`${col} >= ?`);
      binds.push(min);
    }
    if (max !== undefined && max !== null && Number.isFinite(max)) {
      where.push(`${col} <= ?`);
      binds.push(max);
    }
  };
  range('c.ink_cost', p.ink_cost_min, p.ink_cost_max);
  range('c.strength', p.strength_min, p.strength_max);
  range('c.willpower', p.willpower_min, p.willpower_max);
  range('c.lore_value', p.lore_value_min, p.lore_value_max);
  range('c.move_cost', p.move_cost_min, p.move_cost_max);

  // ---- 組み立て -----------------------------------------------------------
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const orderBy = SORT_MAP[p.search_sort ?? ''] ?? SORT_MAP['リリース順'];

  const perPage = Math.min(Math.max(Number(p.posts_per_page) || 50, 1), 100);
  const page = Math.max(Number(p.page) || 1, 1);
  const offset = (page - 1) * perPage;

  // クラスをフリーワード検索対象にするための派生テーブル
  const needsClassBlob = whereSql.includes('cls_blob.classes');
  const joinClassBlob = needsClassBlob
    ? `LEFT JOIN (SELECT card_id, GROUP_CONCAT(classification, ' ') AS classes
                    FROM classifications GROUP BY card_id) cls_blob ON cls_blob.card_id = c.id`
    : '';

  const sql = `
    SELECT c.id, c.card_file, c.collector_number, c.card_name, c.version, c.card_group,
           c.card_type, c.ink_color, c.ink_color2, c.ink_type, c.rarity, c.inkwell,
           c.ink_cost, c.strength, c.willpower, c.move_cost, c.lore_value,
           c.rules_text, c.flavor_text, c.sets_name, c.sets_order, c.release_date,
           c.artist_credit1, c.artist_credit2, c.limit_card, c.image_url,
           (SELECT GROUP_CONCAT(cl.classification, '|') FROM classifications cl WHERE cl.card_id = c.id) AS classifications,
           (SELECT GROUP_CONCAT(ab.ability, '|') FROM abilities ab WHERE ab.card_id = c.id) AS abilities
      FROM cards c
      ${joinClassBlob}
      ${whereSql}
     ORDER BY ${orderBy}
     LIMIT ? OFFSET ?`;

  const countSql = `SELECT COUNT(*) AS n FROM cards c ${joinClassBlob} ${whereSql}`;

  return {
    sql,
    countSql,
    binds: [...binds, perPage, offset],
    countBinds: [...binds],
    page,
    perPage,
  };
}

/** GROUP_CONCAT された文字列を配列に */
export function splitConcat(v: unknown): string[] {
  if (typeof v !== 'string' || !v) return [];
  return v.split('|').filter(Boolean);
}
