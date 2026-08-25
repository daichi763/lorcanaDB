-- 0009: 画像内テキストのOCR結果を保存する
--
-- 背景（仕様§9-3）
--   日本の公式Xは重要情報（開催日時・レベル区分・応募締切・注意事項）を
--   画像に載せて投稿する。ポスト本文は「【イベント情報】開催決定✨」程度しか
--   書かれていないことが多く、本文だけでは日次まとめの材料にならない。
--   alt_text も実測では全件空だった。
--   そこで画像を Vision モデルに渡して文字を書き起こし、要約の材料にする。
--
-- 設計上の注意
--   * 1画像1行。同じ画像URLは再OCRしない（LLM費用の無駄を避ける）。
--   * raw_item_id で元のポストに紐づけ、ソースの公式/非公式の扱いを継承する。
--     → §1.3 の「非公式は本文を引用しない/出典を出さない」判定は
--        既存の meta_sources 側の is_official をそのまま使えばよい。
--   * status で成否を持つ。失敗した画像を無限に再試行しないため。
--   * ocr_text は「画像に書かれている文字」であって我々の創作ではない。
--     公式画像のOCRは公式1次情報の一部として扱う。

CREATE TABLE IF NOT EXISTS meta_ocr (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  -- 元になった収集アイテム（meta_raw_items.id）。削除時は行を残さない
  raw_item_id  INTEGER,
  source_key   TEXT NOT NULL,
  -- 画像URL。同一画像を二重にOCRしないための一意キー
  image_url    TEXT NOT NULL UNIQUE,
  -- 画像が載っていたポスト/記事のURL（表示可否は source 側の is_official で判断）
  page_url     TEXT,
  -- 書き起こしたテキスト
  ocr_text     TEXT,
  -- 抽出した文字数（0 なら文字なし画像＝写真のみ等）
  char_count   INTEGER NOT NULL DEFAULT 0,
  -- ok / empty / failed
  status       TEXT NOT NULL DEFAULT 'ok',
  error        TEXT,
  model        TEXT,
  -- 情報そのものの日付（元ポストの投稿日）
  observed_at  TEXT,
  -- 要約に採用済みか
  summarized_at TEXT,
  created_at   TEXT DEFAULT (datetime('now')),
  updated_at   TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_meta_ocr_obs    ON meta_ocr(observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_meta_ocr_src    ON meta_ocr(source_key);
CREATE INDEX IF NOT EXISTS idx_meta_ocr_status ON meta_ocr(status);
CREATE INDEX IF NOT EXISTS idx_meta_ocr_raw    ON meta_ocr(raw_item_id);

-- 収集時に見つけた画像を「OCR待ち」として貯めるための列。
-- meta_raw_items.image_url は1枚しか持てないが、Xのポストは最大4枚付く。
-- 複数枚を保持するため JSON 配列で持つ（例: ["https://...jpg","https://...jpg"]）。
ALTER TABLE meta_raw_items ADD COLUMN image_urls TEXT;
