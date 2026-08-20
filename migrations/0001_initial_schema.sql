-- ============================================================
-- ディズニー・ロルカナ 非公式ファンDB / D1 スキーマ
-- BUILD_SPEC §4 準拠（SQLite → Cloudflare D1）
-- 注: D1 は FTS5 の trigram tokenizer 非対応のため、
--     検索用に正規化した search_blob カラム + LIKE + インデックスで代替。
--     2,500 件規模では実測十分高速。
-- ============================================================

DROP TABLE IF EXISTS faqs;
DROP TABLE IF EXISTS abilities;
DROP TABLE IF EXISTS classifications;
DROP TABLE IF EXISTS card_refs;
DROP TABLE IF EXISTS cards;
DROP TABLE IF EXISTS rules_sections;
DROP TABLE IF EXISTS meta;

-- カード本体
CREATE TABLE cards (
  id                INTEGER PRIMARY KEY,           -- APIの id
  card_file         TEXT UNIQUE NOT NULL,          -- 画像ファイル名かつ検索キー
  collector_number  INTEGER,
  card_name         TEXT NOT NULL,
  search_card_name  TEXT,
  rubi              TEXT,
  version           TEXT,                          -- 「俺が助けるぜ！」等の副題
  card_group        TEXT,                          -- 「ウッディ／俺が助けるぜ！」
  card_type         TEXT NOT NULL,                 -- キャラクター/アクション/アイテム/ロケーション
  ink_color         TEXT NOT NULL,
  ink_color2        TEXT,
  primary_ink_color TEXT,
  ink_type          TEXT,                          -- シングル / デュアル（導出）
  rarity            TEXT NOT NULL,
  inkwell           TEXT NOT NULL,                 -- 'y' or 'n'
  ink_cost          INTEGER,
  strength          INTEGER,
  willpower         INTEGER,
  move_cost         INTEGER,
  lore_value        INTEGER,
  rules_text        TEXT,                          -- プレースホルダ生のまま保持
  rules_text_plain  TEXT,                          -- 検索用（記号除去済み）
  ability_names     TEXT,                          -- \...\ 抽出した能力名を | 区切りで
  flavor_text       TEXT,
  sets_name         TEXT,
  sets_order        INTEGER,
  release_date      INTEGER,                       -- YYYYMM
  artist_credit1    TEXT,
  artist_credit2    TEXT,
  color_order       INTEGER,
  type_order        INTEGER,
  limit_card        INTEGER,                       -- デッキ内枚数制限（null=通常4）
  image_url         TEXT NOT NULL,                 -- 公式PNG URL（直リンク／§5 モードA）
  search_blob       TEXT,                          -- 全文検索代替（名前+版+テキスト+作家+種族+能力）
  created_at        TEXT,
  modified_at       TEXT
);

CREATE INDEX idx_cards_type        ON cards(card_type);
CREATE INDEX idx_cards_ink         ON cards(ink_color);
CREATE INDEX idx_cards_rarity      ON cards(rarity);
CREATE INDEX idx_cards_sets        ON cards(sets_name);
CREATE INDEX idx_cards_cost        ON cards(ink_cost);
CREATE INDEX idx_cards_strength    ON cards(strength);
CREATE INDEX idx_cards_willpower   ON cards(willpower);
CREATE INDEX idx_cards_lore        ON cards(lore_value);
CREATE INDEX idx_cards_move        ON cards(move_cost);
CREATE INDEX idx_cards_inkwell     ON cards(inkwell);
CREATE INDEX idx_cards_release     ON cards(release_date);
CREATE INDEX idx_cards_setsorder   ON cards(sets_order, collector_number);
CREATE INDEX idx_cards_group       ON cards(card_group);

-- 種族／クラス（分類）
CREATE TABLE classifications (
  card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  classification TEXT NOT NULL,
  PRIMARY KEY (card_id, classification)
);
CREATE INDEX idx_classifications_name ON classifications(classification);

-- キーワード能力
CREATE TABLE abilities (
  card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  ability TEXT NOT NULL,
  PRIMARY KEY (card_id, ability)
);
CREATE INDEX idx_abilities_name ON abilities(ability);

-- カードQ&A
CREATE TABLE faqs (
  id       INTEGER PRIMARY KEY,
  card_id  INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  question TEXT,
  answer   TEXT
);
CREATE INDEX idx_faqs_card ON faqs(card_id);

-- 効果テキスト内の種族参照（前計算タグ / §4 逆引き・シナジー探索用）
CREATE TABLE card_refs (
  card_id        INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  classification TEXT NOT NULL,   -- rules_text 内で言及される種族名
  PRIMARY KEY (card_id, classification)
);
CREATE INDEX idx_card_refs_class ON card_refs(classification);

-- 公式ルール本文（PDF→テキスト化 / 表示は ±200 文字のみ）
CREATE TABLE rules_sections (
  id           INTEGER PRIMARY KEY,
  source       TEXT NOT NULL,      -- 'comprehensive'|'guidelines'|'tournament'|'set_notes_s1'|'playsheet'
  source_label TEXT NOT NULL,
  section      TEXT NOT NULL,      -- '1.2.3' 等
  heading      TEXT,
  body         TEXT NOT NULL,
  pdf_url      TEXT NOT NULL,      -- 公式PDFの該当 URL
  page_no      INTEGER
);
CREATE INDEX idx_rules_source  ON rules_sections(source);
CREATE INDEX idx_rules_section ON rules_sections(source, section);

-- メタ情報（取得日時・件数等）
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
