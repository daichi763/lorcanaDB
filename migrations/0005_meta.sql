-- 0005_meta.sql — 最新環境情報（メタゲーム）レイヤ
--
-- 設計意図
--  ロルカナの環境は日々変わるため、「いつ時点の情報か」を最重要の属性として扱う。
--  そのためこのレイヤの全テーブルは次の3つの時刻を分けて持つ。
--    observed_at : 情報そのものの日付（記事の公開日・大会の開催日）＝ユーザーに見せる日付
--    fetched_at  : こちらが取得した時刻（鮮度の監視用）
--    updated_at  : 行を書き換えた時刻（差分検知用）
--  「取得日＝情報の日付」と混ぜると、古い記事を今日拾っただけで
--  「最新情報」に見えてしまうので必ず分離する。
--
-- 引用方針（ユーザー仕様 §1.3）をDBレベルで担保する
--  sources.is_official = 1 の情報源だけが表示用リンクとして使える。
--  非公式ソースは要約の材料に使うが、URL・媒体名をフロントに出さない。
--  そのため raw_items.citable を持ち、要約プロンプトへ渡す時点で出し分ける。
--  ただしデッキレシピは出典明記が必要（ユーザー仕様の例外）なので
--  meta_decks.source_url は非公式でも保持・表示する。

-- ============================ 情報源マスタ ============================
CREATE TABLE IF NOT EXISTS meta_sources (
  key          TEXT PRIMARY KEY,          -- 'takaratomy_news' など内部キー
  label        TEXT NOT NULL,             -- 表示名
  url          TEXT NOT NULL,             -- 起点URL
  region       TEXT NOT NULL,             -- 'jp' | 'en'
  kind         TEXT NOT NULL,             -- 'news' | 'event' | 'deck' | 'meta' | 'article' | 'rules'
  method       TEXT NOT NULL,             -- 'wp_rest' | 'sitemap' | 'rss' | 'html' | 'api'
  -- 引用可否。1 = 公式1次情報（リンク明示可）/ 0 = 非公式（集約表現のみ）
  is_official  INTEGER NOT NULL DEFAULT 0,
  -- 信頼度 1〜5。数値・断定の裏取り基準に使う（公式=5, 大手集計=4, 個人発信=2）
  trust        INTEGER NOT NULL DEFAULT 3,
  enabled      INTEGER NOT NULL DEFAULT 1,
  -- 取得状況の監視
  last_status  INTEGER,                   -- 直近のHTTPステータス（0=接続失敗）
  last_ok_at   TEXT,                      -- 最後に成功した時刻
  last_error   TEXT,
  fail_streak  INTEGER NOT NULL DEFAULT 0,
  checked_at   TEXT,
  created_at   TEXT DEFAULT (datetime('now')),
  updated_at   TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_meta_sources_region ON meta_sources(region, kind);

-- ============================ 生データ（収集した記事・投稿） ============================
-- 収集レイヤ（L1 RSS / L2 検索 / L3 HTML / L4 API）の結果をここに正規化して溜める。
-- 本文は「抜粋」までに留める（非公式ソースの全文保持は避ける）。
CREATE TABLE IF NOT EXISTS meta_raw_items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  source_key   TEXT NOT NULL,
  url          TEXT NOT NULL,
  url_hash     TEXT NOT NULL UNIQUE,      -- URL正規化後のSHA-256（重複排除の主キー）
  title        TEXT,
  -- 本文抜粋。非公式は要約材料としてのみ使い、フロントには出さない
  excerpt      TEXT,
  -- 内容ハッシュ。同じURLでも中身が変わったら再要約の対象にする
  body_hash    TEXT,
  lang         TEXT NOT NULL DEFAULT 'ja',
  region       TEXT NOT NULL DEFAULT 'jp',
  kind         TEXT NOT NULL DEFAULT 'news',
  -- 情報そのものの日付（記事公開日）。null なら fetched_at で代替表示する
  observed_at  TEXT,
  fetched_at   TEXT DEFAULT (datetime('now')),
  -- 表示用リンクとして使えるか（= 公式1次情報か）
  citable      INTEGER NOT NULL DEFAULT 0,
  trust        INTEGER NOT NULL DEFAULT 3,
  image_url    TEXT,
  -- 要約に採用済みか（採用済みは次回の「新着」から外す）
  summarized_at TEXT,
  meta_json    TEXT,                      -- ソース固有の付随情報（カテゴリID等）
  created_at   TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_meta_raw_obs    ON meta_raw_items(observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_meta_raw_source ON meta_raw_items(source_key, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_meta_raw_region ON meta_raw_items(region, kind, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_meta_raw_new    ON meta_raw_items(summarized_at, observed_at DESC);

-- ============================ 大会 ============================
CREATE TABLE IF NOT EXISTS meta_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  event_key    TEXT NOT NULL UNIQUE,      -- 'jp:japan-national-championship:2026-08-15' 等
  name         TEXT NOT NULL,
  region       TEXT NOT NULL DEFAULT 'jp',
  -- 大会規模の目安。メタ集計の重み付けに使う
  scale        TEXT,                      -- 'national' | 'challenge' | 'gp' | 'set_championship' | 'store' | 'other'
  held_on      TEXT,                      -- 開催日（YYYY-MM-DD）
  players      INTEGER,                   -- 参加者数
  season       TEXT,                      -- 'attack-of-the-vine' 等（環境シーズン）
  format       TEXT,                      -- 'core' | 'infinity' など
  source_url   TEXT,
  is_official  INTEGER NOT NULL DEFAULT 0,
  -- 予定の大会（未開催）も入れる。カウントダウン表示に使う
  is_upcoming  INTEGER NOT NULL DEFAULT 0,
  note         TEXT,
  observed_at  TEXT,                      -- この情報の日付
  fetched_at   TEXT DEFAULT (datetime('now')),
  updated_at   TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_meta_events_date ON meta_events(held_on DESC);
CREATE INDEX IF NOT EXISTS idx_meta_events_up   ON meta_events(is_upcoming, held_on ASC);

-- ============================ デッキレシピ ============================
-- 「日本で組めるもののみ」を保存する制約（ユーザー仕様）。
-- playable_jp = 1 のみフロントのデッキタブに出す。
-- 未収録カードを含む海外デッキは playable_jp = 0 で保持し、
-- 「海外環境の参考」としてだけ使う（デッキタブには出さない）。
CREATE TABLE IF NOT EXISTS meta_decks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  deck_key     TEXT NOT NULL UNIQUE,      -- ソース側の一意キー（URL由来）
  name         TEXT,                      -- デッキ名（アーキタイプ名）
  archetype    TEXT,                      -- 'ミッドレンジ' 等
  region       TEXT NOT NULL DEFAULT 'jp',
  ink1         TEXT,                      -- 日本語インク名
  ink2         TEXT,
  player       TEXT,                      -- プレイヤー名（公開されている場合のみ）
  placement    TEXT,                      -- '優勝' | '準優勝' | 'TOP4' | 'TOP8' | 'TOP32' | null
  -- メタ集計の重み。優勝=5, 準優勝=4, TOP4=3, TOP8=2, その他=1
  weight       INTEGER NOT NULL DEFAULT 1,
  event_id     INTEGER,
  event_name   TEXT,
  season       TEXT,
  -- 60枚揃っているか。揃っていないものはデッキタブに出さない
  total_cards  INTEGER NOT NULL DEFAULT 0,
  -- 全カードが日本語DBに存在するか（1=日本で組める）
  playable_jp  INTEGER NOT NULL DEFAULT 0,
  missing_cards TEXT,                     -- JSON配列。日本未収録カード名
  -- デッキレシピは出典明記が必要（仕様§1.3の例外）
  source_key   TEXT,
  source_url   TEXT,
  source_label TEXT,                      -- 表示用の出典名
  observed_at  TEXT,                      -- デッキが記録された日付
  fetched_at   TEXT DEFAULT (datetime('now')),
  updated_at   TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_meta_decks_obs   ON meta_decks(observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_meta_decks_play  ON meta_decks(playable_jp, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_meta_decks_ink   ON meta_decks(region, ink1, ink2);
CREATE INDEX IF NOT EXISTS idx_meta_decks_event ON meta_decks(event_id);

CREATE TABLE IF NOT EXISTS meta_deck_cards (
  deck_id      INTEGER NOT NULL,
  -- 突合できた場合は cards.id。できなければ null（未収録カード）
  card_id      INTEGER,
  card_name    TEXT NOT NULL,             -- 表示名（日本語優先。突合できたら日本語版名で上書き）
  raw_name     TEXT,                      -- ソース上の元表記（英語名など）
  qty          INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (deck_id, card_name)
);
CREATE INDEX IF NOT EXISTS idx_meta_deck_cards_card ON meta_deck_cards(card_id);

-- ============================ メタゲーム集計（自前計算） ============================
-- 期間・地域ごとに meta_decks から集計したスナップショット。
-- 「いつ時点の集計か」を window_from / window_to で明示する。
CREATE TABLE IF NOT EXISTS meta_snapshots (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  region       TEXT NOT NULL,
  window_from  TEXT NOT NULL,             -- 集計対象期間の開始日
  window_to    TEXT NOT NULL,
  -- 集計の粒度
  kind         TEXT NOT NULL DEFAULT 'ink_pair',  -- 'ink_pair' | 'archetype' | 'card'
  label        TEXT NOT NULL,             -- 'アンバー/エメラルド' 等
  deck_count   INTEGER NOT NULL DEFAULT 0,
  weighted     REAL NOT NULL DEFAULT 0,   -- 順位重み付き合計
  share        REAL NOT NULL DEFAULT 0,   -- 構成比（0〜100）
  rank         INTEGER,
  -- 前回スナップショットとの差分（メタ推移の矢印表示に使う）
  share_delta  REAL,
  detail       TEXT,                      -- JSON（代表デッキ・代表カード等）
  computed_at  TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_meta_snap ON meta_snapshots(region, kind, window_to DESC, rank ASC);

-- ============================ 日次レポート（フロント表示の本体） ============================
-- 1日1セット。ブロック単位で 160〜300字の日本語要約を持つ。
CREATE TABLE IF NOT EXISTS meta_reports (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  report_date  TEXT NOT NULL UNIQUE,      -- YYYY-MM-DD（JST基準）
  status       TEXT NOT NULL DEFAULT 'draft',  -- draft | published | failed
  -- 各ブロックの要約本文
  jp_summary   TEXT,
  en_summary   TEXT,
  diff_summary TEXT,                      -- 日本と海外の違い（1〜2行）
  upcoming_summary TEXT,
  -- 話題のトピック（JSON配列 [{title, body, tag}]）
  jp_topics    TEXT,
  en_topics    TEXT,
  -- 公式リンク（JSON配列 [{label, url, date}]）。公式のみ入れる
  official_links TEXT,
  -- 注目カード（JSON配列 [{card_id, card_file, note}]）
  spotlight_cards TEXT,
  -- 収集の内訳（監視用 JSON）
  stats        TEXT,
  -- 情報の鮮度。要約に使った最も新しい情報の日付
  freshest_at  TEXT,
  -- 使用した情報源の数と失敗数
  sources_ok   INTEGER DEFAULT 0,
  sources_fail INTEGER DEFAULT 0,
  model        TEXT,
  generated_at TEXT DEFAULT (datetime('now')),
  updated_at   TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_meta_reports_date ON meta_reports(report_date DESC);

-- ============================ 記憶層（環境情報のベクトル） ============================
-- カード／ルール／Q&A と同じ方式。AIがシナジー相談に答える際の根拠に使う。
CREATE TABLE IF NOT EXISTS meta_knowledge (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  scope        TEXT NOT NULL,             -- 'jp_meta' | 'en_meta' | 'event' | 'news' | 'deck'
  title        TEXT NOT NULL,
  body         TEXT NOT NULL,             -- AIに読ませる本文（日本語）
  -- 情報の日付。AIは必ずこれを添えて回答する
  observed_at  TEXT,
  season       TEXT,
  region       TEXT NOT NULL DEFAULT 'jp',
  trust        INTEGER NOT NULL DEFAULT 3,
  -- 公式リンク（あれば）。非公式は入れない
  official_url TEXT,
  text_hash    TEXT NOT NULL UNIQUE,      -- 差分再ベクトル化の判定用
  created_at   TEXT DEFAULT (datetime('now')),
  updated_at   TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_meta_knowledge_scope ON meta_knowledge(scope, observed_at DESC);

CREATE TABLE IF NOT EXISTS meta_vectors (
  knowledge_id INTEGER PRIMARY KEY,
  vec          BLOB NOT NULL,
  dims         INTEGER NOT NULL,
  model        TEXT NOT NULL,
  text_hash    TEXT NOT NULL,
  updated_at   TEXT DEFAULT (datetime('now'))
);

-- ============================ 収集ジョブのログ ============================
-- 障害監視（仕様§6「失敗ソースを内部ログに記録」）。
CREATE TABLE IF NOT EXISTS meta_jobs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  kind         TEXT NOT NULL,             -- 'collect' | 'aggregate' | 'summarize' | 'memory'
  status       TEXT NOT NULL DEFAULT 'running',
  step         TEXT,                      -- 現在処理中のソースキー
  ok_count     INTEGER DEFAULT 0,
  fail_count   INTEGER DEFAULT 0,
  new_items    INTEGER DEFAULT 0,
  message      TEXT,
  detail       TEXT,                      -- JSON
  started_at   TEXT DEFAULT (datetime('now')),
  finished_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_meta_jobs ON meta_jobs(kind, id DESC);

-- ============================ 初期データ：情報源マスタ ============================
-- 実際にHTTPで到達性を確認済みのソースのみ登録する。
-- robots.txt で拒否されているサイト（inkdecks / duels.ink / dreamborn 等）は
-- 意図的に含めない。X も User-agent:* / Disallow: / のため含めない。
INSERT OR IGNORE INTO meta_sources (key,label,url,region,kind,method,is_official,trust) VALUES
  -- 日本・公式1次情報（リンク明示可）
  ('takaratomy_news','タカラトミー公式ニュース','https://www.takaratomy.co.jp/products/disneylorcana/news/','jp','news','wp_rest',1,5),
  ('takaratomy_column','タカラトミー公式コラム・戦略記事','https://www.takaratomy.co.jp/products/disneylorcana/news/column/','jp','article','wp_rest',1,5),
  ('takaratomy_event','タカラトミー公式イベント情報','https://www.takaratomy.co.jp/products/disneylorcana/event/','jp','event','wp_rest',1,5),
  -- 海外・公式1次情報
  ('lorcana_en_news','Ravensburger 公式ニュース（EN）','https://www.disneylorcana.com/en-US/news','en','news','html',1,5),
  ('lorcana_en_recap','Ravensburger 公式 大会レポート（EN）','https://www.disneylorcana.com/en-US/news','en','meta','html',1,5),
  -- 日本・非公式（要約材料。表示リンクにはしない。デッキは出典明記の例外）
  ('jp_community_deck','コミュニティ デッキレシピ','https://disneylorcana.jp/deck/','jp','deck','sitemap',0,3),
  ('jp_community_post','コミュニティ 記事','https://disneylorcana.jp/','jp','article','sitemap',0,3),
  ('note_lorcana','note タグ（ロルカナ）','https://note.com/hashtag/ロルカナ/rss','jp','article','rss',0,2),
  ('note_lorcana_deck','note タグ（ロルカナデッキ）','https://note.com/hashtag/ロルカナデッキ/rss','jp','article','rss',0,2),
  ('note_disney_lorcana','note タグ（ディズニーロルカナ）','https://note.com/hashtag/ディズニーロルカナ/rss','jp','article','rss',0,2),
  -- 参照データ（カード情報の補完。表示リンクにはしない）
  ('lorcast_api','Lorcast API（カードデータ）','https://api.lorcast.com/v0/','en','rules','api',0,4);
