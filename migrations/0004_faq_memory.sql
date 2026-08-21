-- 0004: 公式ルールQ&A（rule_faqs）の意味ベクトル
--
-- rule_faqs は「公式が実際に聞かれた疑問とその回答」であり、総合ルールの条文よりも
-- 具体的な状況判断（インクに置ける／置けない、能力の適用範囲など）が書かれている。
-- 条文ベクトル（rule_vectors）とは別テーブルに持ち、AI分析時に
-- 「クエリに近いQ&Aだけ」を数件プロンプトへ載せるために使う。
--
-- 設計は card_vectors / rule_vectors と同一（Float32Array を BLOB、text_hash で差分再構築）。

CREATE TABLE IF NOT EXISTS faq_vectors (
  faq_id      INTEGER PRIMARY KEY,
  source_text TEXT    NOT NULL,
  text_hash   TEXT    NOT NULL,
  dims        INTEGER NOT NULL,
  model       TEXT    NOT NULL,
  vec         BLOB    NOT NULL,
  updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (faq_id) REFERENCES rule_faqs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_faq_vectors_hash ON faq_vectors(text_hash);
