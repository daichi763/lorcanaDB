-- 0007: 海外ソースの実測調査結果を反映（robots.txt / Content-Signal / 利用規約を実測）
--
-- 【調査方針】
--   robots.txt の Allow/Disallow だけでなく、Cloudflare が普及させた
--   「Content-Signal」（search / ai-input / ai-train / use）も判定材料にする。
--   ai-train=no のサイトは、本文を記憶層（ベクトルDB）へ恒久保存すると
--   「学習用途」と解釈される余地があるため、当日の要約材料としてのみ使い、
--   記憶層には入れない（allow_memory=0）という保守的な運用にする。
--
-- 【実測結果サマリ】
--   ✅ lorcanahunter.com   robots: Disallow は /admin /blog-admin /_profiler /_wdt /api/ /lc/ のみ。
--                          → HTML ページは収集可（ただし /api/ は明示禁止なので使わない）
--                          sitemap-tournaments.xml に 13,940 大会。/en/meta に実測メタシェア
--                          （Core Meta % + Top8 % + デッキ数、15/30/60日窓）
--   ✅ tcgcontender.com    robots: Allow: / ＋ Content-Signal: search=yes,ai-train=no,use=reference
--                          → 参照利用は可・学習は不可 → allow_memory=0
--   ✅ elorcana.com        robots: Allow: /（Disallow は /404 のみ）。sitemap.xml に /tournaments 等
--   ⚠️ api-lorcana.com     robots.txt 404（規約表明なし）。/decks/trending は HTTP 200 / JSON 28件
--                          だが updated_at が 2024 年で停止 → 参考値。既定 disabled
--   ⚠️ lorcana.gg          robots: Allow: / だが Content-Signal ai-train=no。
--                          さらに RSS の中身がカジノ/ベッティング系アフィリエイト記事に変質しており
--                          ロルカナ情報として使えない → 既定 disabled
--   ⚠️ topdeck.gg          API は無料だが「Attribution Required（TopDeck.gg への可視クレジットと
--                          リンクを必ず表示すること）」。本仕様 §1.3「非公式ソースは表示上明記しない」
--                          と正面衝突する。APIキーも必要 → 既定 disabled（採用可否はユーザー判断）
--   ❌ reddit.com          robots.txt が「User-agent: * / Disallow: /」→ 収集不可
--   ❌ mushureport.com     RSS も wiki の api.php も Cloudflare のボット判定で HTTP 403 → 収集不可
--   ❌ x.com               robots.txt が全面 Disallow。公式 API（有料）経由のみ許容 → 下記 method='x_api'

-- 1) 規約情報を機械可読で保持する列を追加
ALTER TABLE meta_sources ADD COLUMN content_signal TEXT;
ALTER TABLE meta_sources ADD COLUMN allow_memory INTEGER DEFAULT 1;
ALTER TABLE meta_sources ADD COLUMN requires_secret TEXT;
ALTER TABLE meta_sources ADD COLUMN note TEXT;

-- 既存11ソースは記憶層利用可（公式 or robots 制限なし）
UPDATE meta_sources SET allow_memory = 1 WHERE allow_memory IS NULL;

-- 2) 採用ソース（enabled=1）
INSERT OR REPLACE INTO meta_sources
  (key, label, url, region, kind, method, is_official, trust, enabled,
   content_signal, allow_memory, requires_secret, note, created_at, updated_at)
VALUES
  -- 実測メタシェア。1,600デッキ超の登録大会集計。数値の裏取り用として価値が高い
  ('lh_meta', 'Lorcana Hunter メタ集計（EN）', 'https://lorcanahunter.com/en/meta',
   'en', 'meta', 'html', 0, 4, 1,
   NULL, 1, NULL,
   'robots で /api/ は明示禁止のため HTML ページのみ収集。Core Meta%/Top8%/デッキ数を取得',
   datetime('now'), datetime('now')),

  -- 直近の大会一覧（lastmod が日次更新）。海外の「直近1週間の大会結果」の母集団
  ('lh_tournaments', 'Lorcana Hunter 大会一覧（EN）', 'https://lorcanahunter.com/sitemap-tournaments.xml',
   'en', 'event', 'sitemap', 0, 4, 1,
   NULL, 1, NULL,
   'sitemap-tournaments.xml（13,940件）。lastmod 降順で直近分のみ辿る',
   datetime('now'), datetime('now')),

  -- 記事系。Content-Signal ai-train=no のため記憶層には入れない
  ('tcgcontender', 'TCG Contender 記事（EN）', 'https://tcgcontender.com/sitemap.xml',
   'en', 'article', 'sitemap', 0, 3, 1,
   'search=yes,ai-train=no,use=reference', 0, NULL,
   'Content-Signal ai-train=no。当日要約の材料にのみ使用し記憶層へは保存しない',
   datetime('now'), datetime('now')),

  ('elorcana', 'eLorcana 大会・ランキング（EN）', 'https://elorcana.com/sitemap.xml',
   'en', 'event', 'sitemap', 0, 3, 1,
   NULL, 1, NULL,
   'robots Allow: /（Disallow は /404 のみ）',
   datetime('now'), datetime('now')),

  -- 3) X 公式API（課金前提）。X_BEARER_TOKEN が未設定なら収集はスキップされる
  ('x_official_jp', 'ディズニー ロルカナ 日本公式X', 'https://api.x.com/2/users/by/username/DisneyLOR_JP',
   'jp', 'social', 'x_api', 1, 5, 1,
   NULL, 1, 'X_BEARER_TOKEN',
   'x.com の robots は全面 Disallow のため公式API経由のみ。公式アカウントなので出典リンク可',
   datetime('now'), datetime('now')),

  ('x_official_en', 'Disney Lorcana 公式X（EN）', 'https://api.x.com/2/users/by/username/DisneyLorcana',
   'en', 'social', 'x_api', 1, 5, 1,
   NULL, 1, 'X_BEARER_TOKEN',
   '公式アカウント。出典リンク可',
   datetime('now'), datetime('now')),

  ('x_community_jp', '日本コミュニティX（複数アカウント）', 'https://api.x.com/2/tweets/search/recent',
   'jp', 'social', 'x_api', 0, 2, 1,
   NULL, 0, 'X_BEARER_TOKEN',
   '非公式。§1.3により表示上は出典を明記せず「複数のプレイヤーの発信によると」へ集約。本文は逐語引用せず記憶層にも保存しない',
   datetime('now'), datetime('now')),

  -- 4) 保留ソース（enabled=0）。理由を note に残し、後から判断できるようにする
  ('api_lorcana', 'api-lorcana.com トレンドデッキ', 'https://api-lorcana.com/decks/trending',
   'en', 'deck', 'api', 0, 2, 0,
   NULL, 1, NULL,
   'HTTP 200 / JSON 28件だが updated_at が 2024年で更新停止。復活したら enabled=1 に',
   datetime('now'), datetime('now')),

  ('topdeck_gg', 'TopDeck.gg 大会API', 'https://topdeck.gg/api/v2/tournaments',
   'en', 'event', 'api', 0, 4, 0,
   NULL, 1, 'TOPDECK_API_KEY',
   '無料だが Attribution Required（可視クレジット必須）。仕様§1.3「非公式は表示上明記しない」と衝突するため保留',
   datetime('now'), datetime('now')),

  ('lorcana_gg', 'Lorcana.gg 記事', 'https://lorcana.gg/feed/',
   'en', 'article', 'rss', 0, 1, 0,
   'search=yes,ai-train=no,use=reference', 0, NULL,
   'RSS の内容がカジノ/ベッティング系アフィリエイト記事に変質しロルカナ情報として使えないため無効化',
   datetime('now'), datetime('now')),

  ('reddit_lorcana', 'r/Lorcana', 'https://www.reddit.com/r/Lorcana/',
   'en', 'social', 'blocked', 0, 1, 0,
   NULL, 0, NULL,
   'robots.txt が User-agent: * / Disallow: / のため収集不可。記録のみ',
   datetime('now'), datetime('now')),

  ('mushureport', 'Mushu Report', 'https://mushureport.com/feed/',
   'en', 'article', 'blocked', 0, 1, 0,
   'search=yes,ai-train=no,use=reference', 0, NULL,
   'RSS・wiki api.php ともに Cloudflare のボット判定で HTTP 403。収集不可として記録',
   datetime('now'), datetime('now'));
