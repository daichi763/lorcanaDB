-- 0003_data_update.sql — データ更新機能（新弾追加・ルール改定への追従）
--
-- 設計意図
--  - 更新は「1リクエストで全部」ではなく、ジョブとして状態を D1 に持たせて
--    分割実行する。公式APIは 1 ページ 100 件・礼儀スリープ 1.2s が必要で、
--    2500 枚なら 25 ページ = 30 秒以上かかり Workers の実行時間に収まらない。
--  - 何を取得し、何が増減したかを必ず記録する（update_log）。
--    非公式ファンDBとして「いつ時点の公式データか」を説明できる状態を保つ。
--  - ルールPDFは Last-Modified / Content-Length を保存して差分判定に使う。
--    毎回 4MB の PDF を落とさないための軽量チェック（HEAD 相当）に使う。

-- 更新ジョブ（同時実行を防ぐロックも兼ねる）
CREATE TABLE IF NOT EXISTS update_jobs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  kind         TEXT NOT NULL,                 -- 'cards' | 'faqs' | 'rules_check'
  status       TEXT NOT NULL DEFAULT 'running', -- running | done | failed | canceled
  -- 進捗
  page         INTEGER DEFAULT 0,             -- 次に取得するページ（cards）
  total_pages  INTEGER DEFAULT 0,
  api_count    INTEGER DEFAULT 0,             -- 公式が申告した総件数
  seen         INTEGER DEFAULT 0,             -- 取得済み件数
  inserted     INTEGER DEFAULT 0,             -- 新規カード
  updated      INTEGER DEFAULT 0,             -- 内容が変わったカード
  unchanged    INTEGER DEFAULT 0,
  -- 結果
  message      TEXT,
  detail       TEXT,                          -- JSON（新規カード名の一覧など）
  started_at   TEXT DEFAULT (datetime('now')),
  updated_at   TEXT DEFAULT (datetime('now')),
  finished_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_update_jobs_status ON update_jobs(status, id DESC);
CREATE INDEX IF NOT EXISTS idx_update_jobs_kind   ON update_jobs(kind, id DESC);

-- 更新履歴（監査用。ジョブが消えても何が起きたかを残す）
CREATE TABLE IF NOT EXISTS update_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id     INTEGER,
  kind       TEXT NOT NULL,
  level      TEXT NOT NULL DEFAULT 'info',    -- info | warn | error
  message    TEXT NOT NULL,
  detail     TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_update_log_job ON update_log(job_id, id);
CREATE INDEX IF NOT EXISTS idx_update_log_at  ON update_log(id DESC);

-- 外部リソースの版情報（PDFの更新検知用）
-- 公式PDFは 4MB あるため、毎回落とさず Last-Modified の変化だけを見る。
CREATE TABLE IF NOT EXISTS source_versions (
  source        TEXT PRIMARY KEY,             -- 'comprehensive' | 'tournament' | ...
  label         TEXT,
  url           TEXT NOT NULL,
  last_modified TEXT,
  content_length INTEGER,
  etag          TEXT,
  -- 取り込み済みの版（last_modified と一致していれば取り込み済み）
  imported_last_modified TEXT,
  checked_at    TEXT,
  updated_at    TEXT DEFAULT (datetime('now'))
);

-- 公式ルールQ&A（rule-faq/faq/ の本文。カード個別FAQの faqs とは別物）
CREATE TABLE IF NOT EXISTS rule_faqs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  category   TEXT,                            -- 見出し（h3）
  question   TEXT NOT NULL,
  answer     TEXT NOT NULL,
  note       TEXT,                            -- 「（2025.12.26更新）」など
  q_hash     TEXT NOT NULL UNIQUE,            -- 質問文のハッシュ（重複防止）
  source_url TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_rule_faqs_cat ON rule_faqs(category);
