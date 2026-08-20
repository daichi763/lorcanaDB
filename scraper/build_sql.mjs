#!/usr/bin/env node
/**
 * build_sql.mjs — cards.jsonl / rules_sections.jsonl から D1 投入用 SQL を生成
 *
 * 生成物:
 *   scraper/data/seed_cards.sql   … cards / classifications / abilities / faqs / card_refs
 *   scraper/data/seed_rules.sql   … rules_sections
 *
 * 正規化処理:
 *  - rules_text_plain: {E}{I}{L}{S}{W} 等の記号・% を除去した検索用テキスト
 *  - ability_names   : \...\ で囲まれた能力名を抽出（| 区切り）
 *  - search_blob     : 名前/版/読み/テキスト/フレーバー/作家/種族/能力を連結
 *  - card_refs       : rules_text 内で言及される種族名を全種族マスタと突合して前計算
 *  - ink_type        : ink_color2 の有無から シングル/デュアル を導出
 */
import fs from "node:fs";
import path from "node:path";
import { detectKeywords, KEYWORD_ABILITIES } from "./keywords.mjs";

const DATA = path.join(import.meta.dirname, "data");
const IMG_BASE = "https://www.takaratomy.co.jp/products/disneylorcana/cardlist/img/card";

const q = (v) => {
  if (v === null || v === undefined || v === "") return "NULL";
  return "'" + String(v).replace(/'/g, "''") + "'";
};
const n = (v) => (v === null || v === undefined || v === "" ? "NULL" : Number(v));

/** 表示用プレースホルダを除去して検索用プレーンテキスト化 */
export function toPlain(text) {
  if (!text) return "";
  return String(text)
    .replace(/\{[EILSW〇×]\}/g, " ")
    .replace(/\{[^}]{0,12}\}/g, " ")
    .replace(/《\/?c-[a-z]+》/g, "")
    .replace(/\\/g, "")
    .replace(/%/g, " ")
    .replace(/&lt;|&gt;|[<>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** \能力名\ を抽出 */
function extractAbilityNames(text) {
  if (!text) return [];
  const out = [];
  const re = /\\([^\\]{1,40})\\/g;
  let m;
  while ((m = re.exec(text))) {
    const s = m[1].trim();
    if (s) out.push(s);
  }
  return [...new Set(out)];
}

function main() {
  const cardsPath = path.join(DATA, "cards.jsonl");
  if (!fs.existsSync(cardsPath)) {
    console.error("cards.jsonl がありません。先に fetch_cards.mjs を実行してください。");
    process.exit(1);
  }

  const cards = fs
    .readFileSync(cardsPath, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));

  console.log(`cards.jsonl 読み込み: ${cards.length} 件`);

  // 全種族マスタ（card_refs / [クラス]変身 突合用）
  const allClassifications = new Set();
  for (const c of cards) for (const cl of c.classifications ?? []) if (cl.classification) allClassifications.add(cl.classification);
  console.log(`種族マスタ: ${allClassifications.size} 種`);

  const stmts = [];
  const classRows = [];
  const abilityRows = [];
  const faqRows = [];
  const refRows = [];
  const seenFaqIds = new Set();

  for (const c of cards) {
    const classes = [...new Set((c.classifications ?? []).map((x) => x.classification).filter(Boolean))];
    // 検索APIの abilities フィールドは常に空配列なので、公式ルール第8章の
    // キーワード辞書と rules_text の太字マーカーを突合して自前で構築する。
    const abilities = detectKeywords(c.rules_text, allClassifications);
    const abilityNames = extractAbilityNames(c.rules_text);
    const rulesPlain = toPlain(c.rules_text);
    const flavorPlain = toPlain(c.flavor_text);
    const inkType = c.ink_color2 ? "デュアル" : "シングル";

    const searchBlob = [
      c.card_name, c.search_card_name, c.rubi, c.search_rubi, c.version,
      rulesPlain, flavorPlain, c.artist_credit1, c.artist_credit2,
      classes.join(" "), abilities.join(" "), abilityNames.join(" "),
      c.card_file, c.sets,
    ].filter(Boolean).join(" ");

    stmts.push(
      `INSERT OR REPLACE INTO cards (id,card_file,collector_number,card_name,search_card_name,rubi,version,card_group,card_type,ink_color,ink_color2,primary_ink_color,ink_type,rarity,inkwell,ink_cost,strength,willpower,move_cost,lore_value,rules_text,rules_text_plain,ability_names,flavor_text,sets_name,sets_order,release_date,artist_credit1,artist_credit2,color_order,type_order,limit_card,image_url,search_blob,created_at,modified_at) VALUES (` +
        [
          n(c.id), q(c.card_file), n(c.collector_number), q(c.card_name), q(c.search_card_name), q(c.rubi),
          q(c.version), q(c.card_group), q(c.card_type), q(c.ink_color), q(c.ink_color2), q(c.primary_ink_color),
          q(inkType), q(c.rarity), q(c.inkwell ?? "n"), n(c.ink_cost), n(c.strength), n(c.willpower),
          n(c.move_cost), n(c.lore_value), q(c.rules_text), q(rulesPlain), q(abilityNames.join("|")),
          q(c.flavor_text), q(c.sets), n(c.sets_order), n(c.release_date), q(c.artist_credit1), q(c.artist_credit2),
          n(c.color_order), n(c.type_order), n(c.limit_card),
          q(`${IMG_BASE}/${c.card_file}.png`), q(searchBlob), q(c.created), q(c.modified),
        ].join(",") + `);`
    );

    for (const cl of classes) classRows.push(`(${n(c.id)},${q(cl)})`);
    // abilities テーブルにはキーワード能力のみを入れる（絞込の選択肢が実用的な粒度になる）
    for (const ab of abilities) abilityRows.push(`(${n(c.id)},${q(ab)})`);

    for (const f of c.faqs ?? []) {
      const fid = f.id;
      if (fid == null || seenFaqIds.has(fid)) continue;
      seenFaqIds.add(fid);
      const question = f.question ?? f.faq ?? f.q ?? null;
      const answer = f.answer ?? f.ans ?? f.a ?? null;
      faqRows.push(`(${n(fid)},${n(c.id)},${q(question)},${q(answer)})`);
    }

    // 効果テキストが言及する種族を前計算（自身の種族は除外して "参照" のみ拾う）
    if (rulesPlain) {
      for (const cl of allClassifications) {
        if (cl.length < 2) continue;
        // 自身が持つ種族は「参照」ではないので除外（シナジー逆引きの精度確保）
        if (classes.includes(cl)) continue;
        if (rulesPlain.includes(cl)) refRows.push(`(${n(c.id)},${q(cl)})`);
      }
    }
  }

  const chunkInsert = (table, cols, rows, size = 200) => {
    const out = [];
    for (let i = 0; i < rows.length; i += size) {
      out.push(`INSERT OR IGNORE INTO ${table} (${cols}) VALUES ${rows.slice(i, i + size).join(",")};`);
    }
    return out;
  };

  const sql = [
    "-- 自動生成: scraper/build_sql.mjs",
    ...stmts,
    ...chunkInsert("classifications", "card_id,classification", [...new Set(classRows)]),
    ...chunkInsert("abilities", "card_id,ability", [...new Set(abilityRows)]),
    ...chunkInsert("faqs", "id,card_id,question,answer", faqRows),
    ...chunkInsert("card_refs", "card_id,classification", [...new Set(refRows)], 300),
    `INSERT OR REPLACE INTO meta (key,value) VALUES ('cards_count','${cards.length}'),('imported_at','${new Date().toISOString()}');`,
  ].join("\n");

  fs.writeFileSync(path.join(DATA, "seed_cards.sql"), sql, "utf8");
  console.log(`seed_cards.sql 生成: cards=${stmts.length} class=${new Set(classRows).size} ability=${new Set(abilityRows).size} faq=${faqRows.length} refs=${new Set(refRows).size}`);

  // ---- rules ----
  const rulesPath = path.join(DATA, "rules", "rules_sections.jsonl");
  if (fs.existsSync(rulesPath)) {
    const rules = fs.readFileSync(rulesPath, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
    const rows = rules.map(
      (r) => `(${n(r.id)},${q(r.source)},${q(r.source_label)},${q(r.section)},${q(r.heading)},${q(r.body.slice(0, 8000))},${q(r.pdf_url)},${n(r.page_no)})`
    );
    // ルール本文は 1 行が長いため 1 statement = 1 行に分割（SQLITE_TOOBIG 回避）
    const rsql = [
      "-- 自動生成: scraper/build_sql.mjs (rules)",
      ...rows.map((r) => `INSERT OR IGNORE INTO rules_sections (id,source,source_label,section,heading,body,pdf_url,page_no) VALUES ${r};`),
    ].join("\n");
    fs.writeFileSync(path.join(DATA, "seed_rules.sql"), rsql, "utf8");
    console.log(`seed_rules.sql 生成: sections=${rows.length}`);
  } else {
    console.warn("rules_sections.jsonl なし → seed_rules.sql はスキップ");
  }

  // マスタ値（UI の選択肢生成用）をJSONで出力
  const uniq = (fn) => [...new Set(cards.map(fn).filter((v) => v !== null && v !== undefined && v !== ""))];
  const setsOrderMap = new Map();
  for (const c of cards) if (c.sets && !setsOrderMap.has(c.sets)) setsOrderMap.set(c.sets, c.sets_order ?? 0);
  const abilityCounts = {};
  for (const c of cards) for (const k of detectKeywords(c.rules_text, allClassifications)) abilityCounts[k] = (abilityCounts[k] ?? 0) + 1;

  const masters = {
    sets: uniq((c) => c.sets).sort((a, b) => (setsOrderMap.get(a) ?? 0) - (setsOrderMap.get(b) ?? 0)),
    rarities: uniq((c) => c.rarity),
    card_types: uniq((c) => c.card_type),
    ink_colors: uniq((c) => c.ink_color),
    classifications: [...allClassifications].sort(),
    abilities: Object.entries(abilityCounts).sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count })),
    keyword_defs: KEYWORD_ABILITIES,
  };
  fs.writeFileSync(path.join(DATA, "masters.json"), JSON.stringify(masters, null, 2), "utf8");
  console.log("masters.json 生成");
}

main();
