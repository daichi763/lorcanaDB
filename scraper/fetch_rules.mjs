#!/usr/bin/env node
/**
 * fetch_rules.mjs — 公式ルールPDFを pdftotext でテキスト化し、セクション分割して JSONL 出力
 *
 * 遵守事項（BUILD_SPEC §2.7 / §8）:
 *  - PDF そのものは成果物に含めない（一時ディレクトリで処理して破棄）
 *  - 本文の全公開はしない → アプリ側は検索ヒット周辺 ±200 文字のみ表示
 *  - リクエスト間 1.2s 以上スリープ
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const BASE = "https://www.takaratomy.co.jp/products/disneylorcana";
const UA = "LorcanaFanDB/0.1 (unofficial fan database; research use)";
const DATA_DIR = path.join(import.meta.dirname, "data", "rules");
const OUT = path.join(DATA_DIR, "rules_sections.jsonl");

const SOURCES = [
  { source: "comprehensive", label: "総合ルール", url: `${BASE}/common/pdf/Disney-Lorcana-Comprehensive-Rules_JP.pdf` },
  { source: "guidelines", label: "プレイ修正ガイドライン", url: `${BASE}/common/pdf/Disney_Lorcana_Play_Correction_Guidelines_JP.pdf` },
  // 旧URL Disney_Tournament_Rules_JP.pdf は 404。公式ページの実リンクは Disney_Lorcana_ 接頭辞付き。
  { source: "tournament", label: "大会ルール", url: `${BASE}/common/pdf/Disney_Lorcana_Tournament_Rules_JP.pdf` },
  { source: "set_notes_s1", label: "セットノート S1", url: `${BASE}/common/pdf/s1_set_notes.pdf` },
  { source: "playsheet", label: "プレイシート", url: `${BASE}/common/pdf/playsheet.pdf` },
];

/** 「1.2.3. 見出し」形式の番号付きセクションを検出 */
const SECTION_RE = /^\s*(\d+(?:\.\d+){0,4})\.?\s+(.{0,80})$/;

function splitSections(text, meta) {
  // ページ区切り (\f) を保持しつつページ番号を追跡
  const pages = text.split("\f");
  const out = [];
  let cur = null;

  const flush = () => {
    if (cur && cur.body.trim().length > 0) {
      cur.body = cur.body.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
      out.push(cur);
    }
  };

  for (let pi = 0; pi < pages.length; pi++) {
    const pageNo = pi + 1;
    for (const raw of pages[pi].split("\n")) {
      const line = raw.replace(/\s+$/, "");
      const m = line.match(SECTION_RE);
      // 見出しっぽい行（番号 + 短いテキスト）でセクションを切る
      if (m && m[2].trim().length > 0 && m[2].trim().length < 60 && !/[。、]$/.test(m[2].trim())) {
        flush();
        cur = {
          source: meta.source,
          source_label: meta.label,
          section: m[1],
          heading: m[2].trim(),
          body: "",
          pdf_url: meta.url,
          page_no: pageNo,
        };
      } else if (cur) {
        cur.body += line + "\n";
      } else {
        // 先頭の番号なし前文
        cur = {
          source: meta.source,
          source_label: meta.label,
          section: "0",
          heading: `${meta.label}（前文）`,
          body: line + "\n",
          pdf_url: meta.url,
          page_no: pageNo,
        };
      }
    }
  }
  flush();
  return out;
}

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lorcana-pdf-"));
  const all = [];
  const report = [];

  for (const src of SOURCES) {
    console.log(`取得: ${src.label} ...`);
    try {
      const res = await fetch(src.url, { headers: { "User-Agent": UA, Referer: `${BASE}/rule-faq/` } });
      if (res.status !== 200) {
        console.warn(`  ! status=${res.status} スキップ`);
        report.push({ ...src, status: res.status, sections: 0 });
        await sleep(1300);
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      const pdfPath = path.join(tmp, `${src.source}.pdf`);
      fs.writeFileSync(pdfPath, buf);

      const txtPath = path.join(tmp, `${src.source}.txt`);
      execFileSync("pdftotext", ["-layout", "-enc", "UTF-8", pdfPath, txtPath]);
      const text = fs.readFileSync(txtPath, "utf8");

      const sections = splitSections(text, src);
      all.push(...sections);
      console.log(`  ✅ ${(buf.length / 1024).toFixed(0)}KB → ${sections.length} セクション`);
      report.push({ ...src, status: 200, bytes: buf.length, sections: sections.length });

      // PDF は保持しない（§2.7: 自サーバに保存・再配布しない）
      fs.unlinkSync(pdfPath);
      fs.unlinkSync(txtPath);
    } catch (e) {
      console.warn(`  ! ${src.label} 失敗: ${e.message}`);
      report.push({ ...src, error: String(e.message) });
    }
    await sleep(1300);
  }

  fs.rmSync(tmp, { recursive: true, force: true });

  let id = 1;
  const rows = all.map((r) => ({ id: id++, ...r }));
  fs.writeFileSync(OUT, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  fs.writeFileSync(path.join(DATA_DIR, "fetch_report.json"), JSON.stringify({ fetched_at: new Date().toISOString(), report }, null, 2));

  console.log(`\n=== 完了 ===\n合計 ${rows.length} セクション → ${OUT}`);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
