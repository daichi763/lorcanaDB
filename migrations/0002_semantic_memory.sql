-- ============================================================================
-- 0002: セマンティック記憶層（事前計算した「AIの記憶」を D1 に永続化する）
--
-- 目的:
--   毎回のリクエストで LLM にカード全文やルール本文を読ませ直すのをやめ、
--   (1) 意味ベクトル (2) 事前要約したルール知識 (3) 検証済みシナジー事例
--   を D1 に置いて再利用する。これにより速度と精度を同時に上げる。
--
-- 設計方針:
--   - Cloudflare D1 (SQLite) にはベクトル型が無いため、Float32Array を
--     BLOB として格納し、Worker 側でコサイン類似度を計算する。
--   - 次元は 256 に切り詰める（text-embedding-3-small の Matryoshka 特性）。
--     256次元 × 4byte = 1KB/枚。2,500枚で約 2.5MB に収まり、
--     D1 の 1 クエリで全件読み出しても Worker のメモリに載る。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- カードの意味ベクトル
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS card_vectors (
  card_id     INTEGER PRIMARY KEY,
  -- 埋め込み対象の正規化テキスト（何を食わせたかの監査用。再現性のため保持）
  source_text TEXT    NOT NULL,
  -- source_text の SHA-256。テキストが変わっていない行は再計算をスキップする
  text_hash   TEXT    NOT NULL,
  dims        INTEGER NOT NULL,
  model       TEXT    NOT NULL,
  -- Float32Array のバイト列
  vec         BLOB    NOT NULL,
  updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (card_id) REFERENCES cards(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_card_vectors_hash ON card_vectors(text_hash);

-- ---------------------------------------------------------------------------
-- 総合ルール条文の意味ベクトル（自由記述から関連条文を意味で引くため）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rule_vectors (
  section_id  INTEGER PRIMARY KEY,
  source_text TEXT    NOT NULL,
  text_hash   TEXT    NOT NULL,
  dims        INTEGER NOT NULL,
  model       TEXT    NOT NULL,
  vec         BLOB    NOT NULL,
  updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (section_id) REFERENCES rules_sections(id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------------------
-- キーワード能力の「事前要約された裁定知識」
--
-- 従来は毎回 rules_sections から条文を丸ごと 24 節 × 900 字 RAG していたが、
-- キーワード能力は 13 種で固定なので、一度 LLM に噛み砕かせて保存すれば
-- 毎回読み直す必要がない。プロンプト長を大幅に削れる。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ability_knowledge (
  ability      TEXT PRIMARY KEY,
  -- 1〜2文の定義（プロンプトに常に入れる短文）
  summary      TEXT NOT NULL,
  -- シナジー判断で効く要点（JSON 配列の文字列）
  synergy_notes TEXT,
  -- よくある誤解・注意点（JSON 配列の文字列）
  caveats      TEXT,
  -- 根拠にした条文番号（JSON 配列の文字列。監査用）
  sections     TEXT,
  model        TEXT,
  updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ---------------------------------------------------------------------------
-- 検証済みシナジー事例（AIの「経験の蓄積」）
--
-- 過去に生成し、かつ実在カードとして突合できた高スコアのペアを保存する。
-- 次回以降、同じ起点カードなら「前回こう判断した」を候補加点＋文脈として
-- 再利用でき、回答が安定する（同じ質問で毎回違う答えになるのを抑える）。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS synergy_memory (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  -- 起点カード（自由記述のみの探索では NULL）
  base_id     INTEGER,
  partner_id  INTEGER NOT NULL,
  score       INTEGER NOT NULL,
  reason      TEXT,
  -- 同じペアが何回選ばれたか（多いほど確度が高いと見なす）
  hits        INTEGER NOT NULL DEFAULT 1,
  model       TEXT,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 同一ペアは 1 行に集約する（base_id が NULL の行も一意に扱えるよう COALESCE）
CREATE UNIQUE INDEX IF NOT EXISTS idx_synergy_pair
  ON synergy_memory(COALESCE(base_id, -1), partner_id);
CREATE INDEX IF NOT EXISTS idx_synergy_base  ON synergy_memory(base_id);
CREATE INDEX IF NOT EXISTS idx_synergy_score ON synergy_memory(score DESC);
