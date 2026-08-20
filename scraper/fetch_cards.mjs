#!/usr/bin/env node
/**
 * fetch_cards.mjs — 公式カード検索API から全カードを取得して cards.jsonl に保存
 *
 * 遵守事項（BUILD_SPEC §0-3）:
 *  - リクエスト間に 1,200ms + random(0,400) のスリープ
 *  - 並列なし（直列 1 本のみ）
 *  - User-Agent を正直に名乗る
 *  - 403 → トークン再取得 + 1.5s 待機 → 同ページ再試行。5回失敗で abort
 *
 * 使い方:
 *   node scraper/fetch_cards.mjs                 # フル取得
 *   node scraper/fetch_cards.mjs --incremental   # 差分取得（既知IDのみのページで停止）
 *   node scraper/fetch_cards.mjs --pages 3       # 動作確認用に先頭3ページのみ
 */
import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const BASE = "https://www.takaratomy.co.jp/products/disneylorcana";
const UA = "LorcanaFanDB/0.1 (unofficial fan database; research use)";
const DATA_DIR = path.join(import.meta.dirname, "data");
const OUT = path.join(DATA_DIR, "cards.jsonl");
const PER_PAGE = 50;
const SLEEP_BASE = 1200;

const argv = process.argv.slice(2);
const INCREMENTAL = argv.includes("--incremental");
const MAX_PAGES = argv.includes("--pages")
  ? Number(argv[argv.indexOf("--pages") + 1])
  : Infinity;

// ---- cookie jar -----------------------------------------------------------
const jar = new Map();
const cookieHeader = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
function absorbSetCookie(res) {
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const [kv] = c.split(";");
    const i = kv.indexOf("=");
    if (i > 0) jar.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
  }
}

const politeSleep = () => sleep(SLEEP_BASE + Math.floor(Math.random() * 400));

// ---- API ------------------------------------------------------------------
async function getToken() {
  const res = await fetch(`${BASE}/api1.0/card-search/token.json`, {
    method: "POST",
    headers: { "User-Agent": UA, Referer: `${BASE}/cardlist/`, Cookie: cookieHeader() },
  });
  absorbSetCookie(res);
  if (res.status !== 200) throw new Error(`token status=${res.status}`);
  const json = await res.json();
  // 注意: data.csrf ではなく直下 csrf
  if (!json.csrf) throw new Error("csrf missing in token response");
  return json.csrf;
}

const FREEWORD_FIELDS = [
  "カード名", "バージョン名", "読み", "クラス", "テキスト", "フレーバー", "イラストレーター",
];

function searchBody(page, sort = "リリース順") {
  const body = new URLSearchParams();
  body.set("freeword", "");
  for (const f of FREEWORD_FIELDS) body.append("freeword_field[]", f);
  body.set("ink_type", "すべて");
  for (const k of ["ink_color[]", "card_type[]", "classification[]", "rarity[]", "ability[]", "sets[]", "inkwell[]"]) {
    body.append(k, "すべて");
  }
  // *_min / *_max は送らない（送ると絞込扱いになる）
  body.set("search_sort", sort);
  body.set("posts_per_page", String(PER_PAGE));
  body.set("page", String(page));
  return body;
}

async function searchPage(token, page, sort) {
  const res = await fetch(`${BASE}/api1.0/card-search/result`, {
    method: "POST",
    headers: {
      "User-Agent": UA,
      "Content-Type": "application/x-www-form-urlencoded",
      "X-CSRF-Token": token,
      Referer: `${BASE}/cardlist/`,
      Cookie: cookieHeader(),
    },
    body: searchBody(page, sort),
  });
  absorbSetCookie(res);
  if (res.status !== 200) {
    const err = new Error(`search status=${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/** 403/失敗時にトークン再取得しつつ最大5回リトライ */
async function searchPageResilient(state, page, sort) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      return await searchPage(state.token, page, sort);
    } catch (e) {
      console.warn(`  ! page ${page} attempt ${attempt} failed: ${e.message}`);
      if (attempt === 5) throw e;
      await sleep(1500);
      state.token = await getToken();
      await politeSleep();
    }
  }
}

// ---- main -----------------------------------------------------------------
async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  // 既存データ読み込み（差分モード用）
  const known = new Map();
  if (fs.existsSync(OUT)) {
    for (const line of fs.readFileSync(OUT, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const c = JSON.parse(line);
        known.set(c.id, c);
      } catch { /* skip broken line */ }
    }
    console.log(`既存 cards.jsonl: ${known.size} 件`);
  }

  const state = { token: await getToken() };
  console.log("CSRF token 取得 OK");

  const collected = new Map(INCREMENTAL ? known : []);
  const first = await searchPageResilient(state, 1, "リリース順");
  const total = first.count;
  const pages = Math.min(Math.ceil(total / PER_PAGE), MAX_PAGES);
  console.log(`総件数 count=${total} / ${pages} ページを取得`);

  let newCount = 0;
  for (const c of first.cards) {
    if (!collected.has(c.id)) newCount++;
    collected.set(c.id, c);
  }
  console.log(`page 1/${pages} ok (${first.cards.length} 件, 新規 ${newCount})`);

  for (let p = 2; p <= pages; p++) {
    await politeSleep();
    const data = await searchPageResilient(state, p, "リリース順");
    let pageNew = 0;
    for (const c of data.cards) {
      if (!collected.has(c.id)) pageNew++;
      collected.set(c.id, c);
    }
    console.log(`page ${p}/${pages} ok (${data.cards.length} 件, 新規 ${pageNew})`);

    // 差分モード: 既知IDのみが揃ったページが出たら停止
    if (INCREMENTAL && pageNew === 0 && data.cards.length > 0) {
      console.log("差分取得: 新規カードなしのページに到達 → 停止");
      break;
    }
  }

  // 書き出し（id 昇順で安定化）
  const rows = [...collected.values()].sort((a, b) => a.id - b.id);
  fs.writeFileSync(OUT, rows.map((c) => JSON.stringify(c)).join("\n") + "\n", "utf8");

  // 検証: card_file 重複チェック
  const files = new Set();
  const dup = [];
  for (const c of rows) {
    if (files.has(c.card_file)) dup.push(c.card_file);
    files.add(c.card_file);
  }

  console.log(`\n=== 完了 ===`);
  console.log(`cards.jsonl 行数: ${rows.length}`);
  console.log(`API count      : ${total}`);
  console.log(`一致           : ${rows.length === total ? "✅ OK" : "⚠️ 不一致"}`);
  console.log(`card_file 重複 : ${dup.length === 0 ? "✅ なし" : `⚠️ ${dup.length} 件 ${dup.slice(0, 5)}`}`);

  fs.writeFileSync(
    path.join(DATA_DIR, "fetch_report.json"),
    JSON.stringify({ fetched_at: new Date().toISOString(), rows: rows.length, api_count: total, duplicates: dup }, null, 2)
  );
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
