# ディズニー・ロルカナ 非公式カードデータベース（ファンサイト）

## プロジェクト概要

- **名称**: 非公式カードデータベース（ディズニー・ロルカナTCG 日本語版 ファンサイト）
  - ※ BUILD_SPEC §0-2 に従い、商標を商品名・サイト名の冠として使わず、指示的表示に留めています
- **目的**: 全カードデータ・公式ルールを取り込み、公式サイト同等の検索UIと
  デッキコード互換のデッキビルダーを提供する
- **収録**: **2,500 枚**（公式 API の `count` と完全一致）、26 セット、42 種族、
  1,255 件のキーワード能力タグ、406 節の公式ルール
- **ステータス**: サンドボックスで稼働確認済み / Cloudflare Pages 未デプロイ

## 主な機能

| 機能 | 内容 |
|---|---|
| カード検索 | 公式フォーム項目を全再現（フリーワード7フィールド・インク色・種別・レアリティ・クラス・能力・セット・インクウェル・5種の数値レンジ・9種のソート） |
| 追加検索 | **効果テキストが参照する種族の逆引き**、種族 AND/OR 切替、能力タグ絞込 |
| カード詳細 | 全項目表示、プレースホルダ描画、同名別バージョン、参照種族へのリンク |
| シナジー探索 | 「種族Xを参照する効果を持つカード」⇄「種族Xを持つカード」を横並び表示 |
| デッキビルダー | ドラッグ&ドロップ、4枚制限（`limit_card`準拠）、2色ルール検証、60枚判定、コスト曲線・インク配分・種族分布・概要の可視化 |
| デッキコード取込 | 公式 `get-deck-cards` をサーバ側プロキシ経由で復号（レート制限付き） |
| ルール検索 | 公式PDF 3種を横断検索。**ヒット周辺±200文字のみ表示**し公式PDF（#page=N）へ誘導 |
| 比較モード | 最大4枚を並列表示 |
| 鑑賞モード | 公式画像を lightbox 拡大 |
| お気に入り | LocalStorage のみ（ログイン不要・サーバ送信なし） |

## URL / エンドポイント

### 画面

| パス | 内容 |
|---|---|
| `/` | カード検索（URLクエリで条件を共有可: `?q=&ink_color=&classification=&ink_cost_min=` 等） |
| `/cards/:card_file` または `/cards/:id` | カード詳細 |
| `/deck` | デッキビルダー（`?d=<file:枚数,…>` で共有、`?add=<card_file>` で単体追加、`?deck=<code>` でコード指定） |
| `/synergy` | シナジー探索（`?c=<種族名>`） |
| `/rules` | 公式ルール検索（`?q=&source=`） |
| `/favorites` | お気に入り |
| `/about` | このサイトについて（免責・権利・データ取得方針） |
| `/robots.txt` | クロール方針 |

### API

| メソッド | パス | 内容 |
|---|---|---|
| POST | `/api/cards/search` | カード検索。body に検索条件（下記パラメータ） |
| GET | `/api/cards/:key` | カード詳細（`key` は `id` または `card_file`）+ 同名別バージョン |
| POST | `/api/cards/by-files` | `{files:[card_file,…]}` で一括取得（最大200件） |
| GET | `/api/masters` | UI選択肢（セット・レアリティ・種別・インク色・種族・能力・参照種族・メタ） |
| GET | `/api/synergy/:classification` | 参照カード（referrers）と保有カード（holders） |
| GET | `/api/rules/search?q=&source=` | ルール横断検索（抜粋±200文字のみ返却） |
| GET | `/api/rules/toc` | ルール目次 |
| GET | `/api/rules/section/:id` | 単一セクション（冒頭400文字まで） |
| POST | `/api/deck/import` | `{code:"…"}` → 公式APIプロキシでデッキ復号 |
| GET | `/api/health` | ヘルスチェック |

**`/api/cards/search` の body パラメータ**:
`freeword`, `freeword_field[]`, `ink_type`, `ink_color[]`, `card_type[]`,
`classification[]`, `classification_mode`(`and`/`or`), `rarity[]`, `ability[]`,
`sets[]`, `inkwell[]`, `refs_classification[]`,
`ink_cost_min/max`, `strength_min/max`, `willpower_min/max`,
`lore_value_min/max`, `move_cost_min/max`,
`search_sort`, `posts_per_page`(最大100), `page`

**`/api/deck/import` のレート制限**: IP毎に 60秒 10回 / 24時間 200回。超過時 `429` + `Retry-After`。

## データアーキテクチャ

- **ストレージ**: **Cloudflare D1**（SQLite 互換）
  - BUILD_SPEC は better-sqlite3 を推奨していますが、Cloudflare Workers はファイルシステムに
    アクセスできないため、仕様書 §9 が示す D1 置換を採用しました
- **全文検索**: D1 は FTS5 の `trigram` tokenizer 非対応のため、正規化済み
  `search_blob` / `rules_text_plain` カラム + `LIKE` + インデックスで代替（2,500件規模で実測 10ms 未満）
- **テーブル**:
  - `cards` (2,500) — カード本体。`rules_text` はプレースホルダ生のまま保持し、
    検索用に `rules_text_plain`（記号除去）と `ability_names`（`\…\` 抽出）を併設
  - `classifications` (5,075) — 種族／クラス
  - `abilities` (1,255) — キーワード能力（下記参照）
  - `card_refs` (227) — **効果テキストが参照する種族の前計算タグ**（自身の種族は除外）
  - `faqs` (445) — カードQ&A の参照ID
  - `rules_sections` (406) — 公式ルール本文（表示は抜粋のみ）
  - `meta` / `rate_limit`

### キーワード能力の構築方法（仕様書との差分・重要）

検索APIの `abilities` フィールドは**全カードで常に空配列**でした（実測）。公式サイトの
`ability[]` 選択肢も Vue が動的生成しており HTML から取得できません。そこで
**公式総合ルール第8章のキーワード能力定義**（警戒・護衛・果敢・回避・暴勇・耐久・突進・
変身・歌声・合唱・支援・霧消・魔除 + 変身亜種）を辞書化し（`scraper/keywords.mjs`）、
カードの `rules_text` 内の太字マーカー `<…>` と突合して構築しています。
`\…\` はカード固有の能力名なので区別しています。誤検出ゼロを目視検証済み。

## データ取得（scraper）

```bash
node scraper/fetch_cards.mjs                # 全カード取得 → data/cards.jsonl
node scraper/fetch_cards.mjs --incremental  # 差分取得（新規なしのページで停止）
node scraper/fetch_cards.mjs --pages 3      # 動作確認用
node scraper/fetch_rules.mjs                # 公式ルールPDF → セクション分割JSONL
node scraper/build_sql.mjs                  # JSONL → D1 投入用 SQL + masters.json
node scraper/verify_images.mjs              # 画像URL到達性を5%サンプリング検証
```

**遵守事項（BUILD_SPEC §0）**: リクエスト間 1,200ms + random(0,400) のスリープ、
並列なし（直列1本）、User-Agent 明示、403時はトークン再取得して最大5回リトライ。
PDF は一時ディレクトリで処理し**保存しません**。

## セットアップ

```bash
npm install
npx wrangler d1 execute webapp-production --local --file=./migrations/0001_initial_schema.sql
npx wrangler d1 execute webapp-production --local --file=./scraper/data/seed_cards.sql
npx wrangler d1 execute webapp-production --local --file=./scraper/data/seed_rules.sql
npm run build
pm2 start ecosystem.config.cjs
curl http://localhost:3000/api/health
```

## デプロイ（Cloudflare Pages）

```bash
npx wrangler d1 create webapp-production          # 発行された database_id を wrangler.jsonc に記入
npx wrangler d1 execute webapp-production --file=./migrations/0001_initial_schema.sql
npx wrangler d1 execute webapp-production --file=./scraper/data/seed_cards.sql
npx wrangler d1 execute webapp-production --file=./scraper/data/seed_rules.sql
npm run build && npx wrangler pages deploy dist --project-name webapp
```

差分更新の Cron 例（GitHub Actions、夜間バッチ）:

```yaml
on:
  schedule: [{ cron: '0 18 * * *' }]   # 03:00 JST
jobs:
  update:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm ci
      - run: node scraper/fetch_cards.mjs --incremental
      - run: node scraper/build_sql.mjs
      - run: npx wrangler d1 execute webapp-production --file=./scraper/data/seed_cards.sql
        env: { CLOUDFLARE_API_TOKEN: '${{ secrets.CLOUDFLARE_API_TOKEN }}' }
```

## 法的配慮（BUILD_SPEC §0 / §5 の実装状況）

- カード画像は **モードA（公式サーバ直リンク）** のみ。自サーバへの保存・配信は一切なし。
  `loading="lazy"` を全画像に付与。画像の DL スクリプトも同梱していません
- 商標を冠に使わず「非公式ファンサイト」として指示的表示に限定
- 全ページのフッターに免責・権利表記（© Disney / Operated by Ravensburger /
  タカラトミー公式サイトへのリンク）を常時表示。`/about` に詳細な方針ページ
- 効果テキストは事実データとして無改変で掲載
- ルール本文は全文公開せず、抜粋 + 公式PDF誘導
- アイコンは全て自作SVG（公式 `ico_card0X.svg` は不使用）
- `/api/deck/import` にレート制限、`robots.txt` に `Disallow: /api/` と `Crawl-delay: 2`

## 受入テスト結果（BUILD_SPEC §10）

| 項目 | 結果 |
|---|---|
| `cards.jsonl` 行数が `count` と一致 | ✅ 2,500 = 2,500 |
| `card_file` に重複なし | ✅ 重複0 |
| 画像URLが HTTP 200（5%サンプリング） | ✅ `verify_images.mjs` で検証（レポート: `scraper/data/image_verify_report.json`） |
| プレースホルダ描画（`{E}{I}{L}{S}{W}` `%` `\…\` `<…>` `《c-*》`） | ✅ `icons.js` で全ケース実装 |
| 種族「トイ」で20件以上ヒット | ✅ 33 件 |
| 能力「歌える」でヒット | ✅ 120 件 |
| インクコスト5-7の件数が公式と一致 | ✅ 616 = **公式616** |
| 無効コードで 400 | ✅ 400 / 存在しないコードは 404 |
| 期限切れトークンで自動再取得 | ✅ 403検知→キャッシュ破棄→1回リトライ |
| レート制限が動作 | ✅ 10回目で 429 + `Retry-After: 60` |
| robots.txt 尊重・1req/1.2s以下・UA明示 | ✅ scraper 全スクリプトで実装 |
| フッターに免責と権利表記 | ✅ 全ページ |
| 全ページ・静的ファイルが 200 | ✅ 17/17 |

**補足検証**: 全件2,500・種族トイ33件も公式APIと突合し一致を確認済み。

## 未実装 / 既知の制約

1. **大会ルールPDF** — 仕様書記載の URL が現在 404。総合ルール・プレイ修正
   ガイドライン・セットノートS1 の 3 文書（406節）のみ取り込み済み
2. **プレイシートPDF** — 図版中心でテキスト抽出が0節。実質的に検索対象外
3. **カードQ&A本文** — 検索APIの `faqs` はスラッグ（例 `set1-no14-1`）のみで本文を含まず。
   `card_qa.php` を叩いて本文を補完する処理は未実装（445件のIDのみ保持）
4. **デッキ→デッキコード発行** — 仕様書 §6.1 の判断通り未実装（公式の1日30回制限のため）。
   公式デッキビルダーへのリンクで代替
5. **Lighthouse 90+** — 未計測（サンドボックス環境のため実測は未実施）
6. **Cloudflare Pages への本番デプロイ** — 未実行

## 推奨される次のステップ

1. `card_qa.php` を叩いて FAQ 本文を取得し、カード詳細に Q&A セクションを追加
2. Cloudflare Pages へデプロイ（D1 の本番作成 → seed 投入 → deploy）
3. GitHub Actions で差分更新 Cron を有効化
4. Lighthouse 計測と最適化
5. 「未発見シナジー」スコアリング（仕様書 §11 の拡張タスク）

## 技術スタック

- **バックエンド**: Hono 4 + TypeScript（Cloudflare Workers/Pages）
- **DB**: Cloudflare D1（SQLite）
- **フロントエンド**: バニラJS + Tailwind CSS (CDN) + Font Awesome (CDN)
- **スクレイパー**: Node.js 22（`fetch` / `pdftotext`）
- **ビルド**: Vite 8 + `@hono/vite-build/cloudflare-pages`
- **最終更新**: 2026-08-20
