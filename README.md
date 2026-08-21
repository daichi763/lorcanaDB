# ディズニー・ロルカナ 非公式カードデータベース（ファンサイト）

## プロジェクト概要

- **名称**: 非公式カードデータベース（ディズニー・ロルカナTCG 日本語版 ファンサイト）
  - ※ BUILD_SPEC §0-2 に従い、商標を商品名・サイト名の冠として使わず、指示的表示に留めています
- **目的**: 全カードデータ・公式ルールを取り込み、公式サイト同等の検索UIと
  デッキコード互換のデッキビルダーを提供する
- **収録**: **2,500 枚**（公式 API の `count` と完全一致）、26 セット、42 種族、
  1,255 件のキーワード能力タグ、463 節の公式ルール
- **ステータス**: サンドボックスで稼働確認済み / Cloudflare Pages 未デプロイ

## 主な機能

| 機能 | 内容 |
|---|---|
| カード検索 | 公式フォーム項目を全再現（フリーワード7フィールド・インク色・種別・レアリティ・クラス・能力・セット・インクウェル・5種の数値レンジ・9種のソート） |
| 追加検索 | **効果テキストが参照する種族の逆引き**、種族 AND/OR 切替、能力タグ絞込 |
| カード詳細 | 全項目表示、プレースホルダ描画、同名別バージョン、参照種族へのリンク |
| **AIシナジー探索** | **起点カードを選んだり、やりたいことを自由記述すると、AI が噂み合うカードをスコア＋理由付きで提案**（下記「AIシナジー探索の仕組み」参照） |
| シナジー探索（種族逆引き） | 「種族Xを参照する効果を持つカード」⇄「種族Xを持つカード」を横並び表示 |
| デッキビルダー | ドラッグ&ドロップ、4枚制限（`limit_card`準拠）、2色ルール検証、60枚判定、コスト曲線・インク配分・種族分布・概要の可視化 |
| デッキコード取込 | 公式 `get-deck-cards` をサーバ側プロキシ経由で復号（レート制限付き） |
| ルール検索 | 公式PDF 4種（総合ルール・プレイ修正ガイドライン・大会ルール・セットノート）を横断検索。**ヒット周辺±200文字のみ表示**し公式PDF（#page=N）へ誘導 |
| 比較モード | 最大4枚を並列表示 |
| 鑑賞モード | 公式画像を lightbox 拡大 |
| お気に入り | LocalStorage のみ（ログイン不要・サーバ送信なし） |
| **データ更新（隠し管理画面）** | **公式の新弾追加・ルール改定に追随。パスワード保護された非公開URLから差分更新を実行**（下記「データ更新（隠し管理画面）」参照） |

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
| `/_ops`（および `ADMIN_PATH` で指定した任意パス） | **隠し管理画面（データ更新）**。サイト内リンクなし・パスワード必須・`noindex` / `robots.txt` で拒否。詳細は「データ更新（隠し管理画面）」節 |

### API

| メソッド | パス | 内容 |
|---|---|---|
| POST | `/api/cards/search` | カード検索。body に検索条件（下記パラメータ） |
| GET | `/api/cards/:key` | カード詳細（`key` は `id` または `card_file`）+ 同名別バージョン |
| POST | `/api/cards/by-files` | `{files:[card_file,…]}` で一括取得（最大200件） |
| GET | `/api/masters` | UI選択肢（セット・レアリティ・種別・インク色・種族・能力・参照種族・メタ） |
| GET | `/api/synergy/:classification` | 参照カード（referrers）と保有カード（holders） |
| **POST** | **`/api/ai/synergy`** | **AIシナジー探索**。body: `{card_file?, text?, restrict_ink?[], want?}` |
| GET | `/api/ai/status` | AI利用可否と利用上限（鍵は返さない） |
| GET | `/api/ai/card-suggest?q=` | 起点カードのオートコンプリート（最大20件） |
| GET | `/api/rules/search?q=&source=` | ルール横断検索（抜粋±200文字のみ返却） |
| GET | `/api/rules/toc` | ルール目次 |
| GET | `/api/rules/section/:id` | 単一セクション（冒頭400文字まで） |
| POST | `/api/deck/import` | `{code:"…"}` → 公式APIプロキシでデッキ復号 |
| GET | `/api/health` | ヘルスチェック |

**管理API（`/api/_ops/*`）** — 隠し管理画面専用。CORS を付けない（同一オリジン限定）、`Cache-Control: no-store`、`X-Robots-Tag: noindex`。

| メソッド | パス | 内容 |
|---|---|---|
| POST | `/api/_ops/login` | `{password}` → 署名付きセッション Cookie 発行（2時間） |
| POST | `/api/_ops/logout` | セッション破棄 |
| GET | `/api/_ops/session` | セッション有効判定 |
| GET | `/api/_ops/status` | 件数・ベクトル進捗・公式文書のバージョン・ジョブ履歴 |
| POST | `/api/_ops/update/cards` | カード差分更新（1回の呼び出しで5ページ進める分割ジョブ） |
| POST | `/api/_ops/update/cancel` | 実行中ジョブの中止 |
| POST | `/api/_ops/update/rules-check` | 公式ルールPDFの更新有無チェック（`Last-Modified` 比較） |
| POST | `/api/_ops/update/rules-mark` | 取り込み済みバージョンの記録 |
| POST | `/api/_ops/update/faqs` | 公式ルールQ&A（79件）の取得・更新 |

**`/api/cards/search` の body パラメータ**:
`freeword`, `freeword_field[]`, `ink_type`, `ink_color[]`, `card_type[]`,
`classification[]`, `classification_mode`(`and`/`or`), `rarity[]`, `ability[]`,
`sets[]`, `inkwell[]`, `refs_classification[]`,
`ink_cost_min/max`, `strength_min/max`, `willpower_min/max`,
`lore_value_min/max`, `move_cost_min/max`,
`search_sort`, `posts_per_page`(最大100), `page`

**`/api/deck/import` のレート制限**: IP毎に 60秒 10回 / 24時間 200回。超過時 `429` + `Retry-After`。

**`/api/ai/synergy` のレート制限**: IP毎に 60秒 3回 / 24時間 60回。
同一入力は D1 に 24 時間キャッシュされ、キャッシュヒットはレート制限を消費しない（実測 55ms）。

---

## AIシナジー探索の仕組み

`/synergy` の「AIシナジー探索」タブ。起点カードと自由記述は**どちらか一方でも、両方でも**指定可能。

### 記憶層（セマンティック・メモリ）

「毎回 AI にカードとルールを読ませ直す」のをやめ、**事前計算できるものを D1 に永続化**して
再利用する。これにより速度と精度を同時に改善している。

| 記憶 | テーブル | 中身 | 構築コスト（1回だけ） |
|---|---|---|---|
| カードの意味ベクトル | `card_vectors` | 2,500枚 × 256次元 | **26秒**（バッチ200枚/1.9秒） |
| ルール条文の意味ベクトル | `rule_vectors` | 463節 × 256次元 | 6秒 |
| キーワード能力の裁定知識 | `ability_knowledge` | 13種の要約＋噛み合い＋注意点 | 2分38秒 |
| 検証済みシナジー事例 | `synergy_memory` | 実在突合済みの高評価ペア | 探索するたびに自動蓄積 |

- 埋め込みは `text-embedding-3-small` を **256次元に切り詰め**（Matryoshka 表現）。
  1枚1KB・全体2.5MBなので、D1 から全件読んで Worker 側で内積を取れる（数ミリ秒）。
- 検索時に発生する API 呼び出しは**クエリ1本の埋め込みだけ**（0.3秒未満）。
  2,500枚との突き合わせは LLM を一切経由しない。
- `text_hash`（SHA-256）で差分管理。カードテキストが変わった行だけ再計算する。
- ベクトルが未投入でも**従来の LIKE 検索で動作し続ける**（記憶層は加点として作用）。

#### 効果

| 観点 | 従来 | 記憶層あり |
|---|---|---|
| 言い換えへの追従 | LIKE 一致のみ。「使い回す」「アグロ」等で候補0件になることがあった | 意味ベクトルで拾える。提案の**約8割がベクトル由来** |
| ルール知識の渡し方 | 生条文を毎回 24節 × 900字 RAG（5,694文字） | 事前要約 6件（4,005文字）＝**30%削減**、かつ内容は要点整理済み |
| 回答の安定性 | 同一条件でも毎回ゆれる | 過去の高評価ペアを参照。2回目は上位が安定し提案数も 6→9 枚に増加 |
| 所要時間 | 24〜40秒 | 24〜31秒（ルール部分の短縮分だけ改善） |

#### 記憶の構築・点検 API

いずれも書き込み系は `ADMIN_TOKEN`（`x-admin-token` ヘッダ）必須。未設定時は localhost のみ許可。

| メソッド | パス | 用途 |
|---|---|---|
| GET | `/api/memory/stats` | 記憶の充填状況（ベクトル化件数など） |
| POST | `/api/memory/build/cards` | カードのベクトル化（`{batch, offset, force}` で分割実行） |
| POST | `/api/memory/build/rules` | ルール条文のベクトル化 |
| POST | `/api/memory/build/abilities` | キーワード能力の裁定知識を生成 |

### 処理フロー（4段構成）

| 段 | 内容 | 実装 |
|---|---|---|
| 1. 意図抽出 | 自由記述を検索語（keywords / 種族 / 能力 / インク色 / 種別）に分解 | `gpt-5-nano` (reasoning: minimal) |
| 2. 候補抽出 | **D1 上の決定的な SQL** で最大 120 枚に絞る（名前指名・種族参照・同系メカニクス等を加点し、不足分は指定条件で段階的に補充） | `src/lib/ai.ts` |
| 3. 順位付け | 候補＋**事前要約済みの能力裁定（`ability_knowledge`）**を渡してスコアと理由を生成。要約が無い能力に限り生条文 RAG（最大24節×900字）で補う | `gpt-5-mini` (reasoning: low) |
| 4. 突合 | LLM が返した `id` を D1 の実データに突合し、**存在しないカードを破棄** | `src/routes/ai.ts` |

### 1回あたりの入力量（トークン予算）

| 項目 | 値 | 実測に基づく根拠 |
|---|---|---|
| 候補カード数 | **120枚**（60→120） | 入力トークンが 12,989→25,469 に倍増しても所要時間は 34.0s→32.6s とほぼ不変 |
| 1枚あたりの効果テキスト | **320字**（190→320） | 長文カードの後半（追加の誘発条件等）が切れて誤判定になるのを防ぐ |
| ルール抜粋 | **最大10語 / 24節 / 本文900字**（6語/12節/400字→） | 「そのターンだけ」「チャレンジ中のみ」等の条件の読み落としを防ぐ |
| `maxTokens` | 意図抽出 2,000 / 順位付け 16,000 | 将来のための上限宣言（後述の通り現行プロキシでは無効） |
| タイムアウト | 意図抽出 25s / 順位付け **90s** | 従前の40s設定ですでに 46.6s の実測例があり、潜在的なタイムアウト要因だった |

#### 計測で得られた知見: `max_completion_tokens` は現行プロキシで尊重されない

| 要求した上限 | 実際の completion_tokens |
|---|---|
| 200 | 2,355 |
| 800 | 1,989 |
| 3,000 | 2,124 |

したがって**上限値を上げること自体に効果はない**。実際に出力量を動かすのは `reasoning_effort`
（`low` → 完了約2,500トークン / 32〜47s、`medium` → 5,678トークン / **72.1s**）。
`medium` は待ち時間が倍増するため採用せず、**増やした予算は「入力情報量」に回している**。

### 設計上のポイント

- **2,500枚全体を LLM に渡していない**。候補抽出は SQL、LLM は順位付けと説明のみ担当
- **「候補0件」を潰す補充段を持つ**。意図抽出が弱い語（例:「コントロ」「回す」）しか返さず、
  かつカード種類・インク色のハードフィルタが効くと候補が果てるため、
  「色＋種類＋種族」→「色＋種類」→「色のみ」の順に緩めて 120 枚まで埋める
  （インク2色固定指定時はその制約を破る補充はしない）
- **外部知識を使わせない**。プロンプトには DB の効果テキストと総合ルールの抜粹のみを入れ、
  キーワード能力（13種）の解釈は `ability_knowledge`（同じ `rules_sections` から事前生成）
  または生条文 RAG で供給する。そのためレスポンスの `rule_context_count` は
  **要約が揃っている状態では通常 0**（要約で足りたことを意味し、ルールを無視した訳ではない）
- **`rules_sections.heading` は「見出し」ではない**（重要な落とし穴）。
  実データは `heading` = 本文の先頭約45文字、`body` = その続き、という分割になっている。
  旧実装は `[section heading] body` の形で連結していたため**文が途中で分断**され、
  LLM が「抜粋が途切れている」と判断して推論を放棄していた（精度が低かった直接原因）。
  現在は `ruleFullText()` で区切り文字なしに復元し、`©Disney` 以降を除去してから渡す。
  検索も `heading` / `body` の両カラムを対象にし、`8.x.` の兄弟条文まで拾う
- **幻覚カードは表示されない**。候補集外の `id` は全て破棄される
- **ルール本文はユーザーに返さない**。RAG で参照するのは推論根拠としてのみ（BUILD_SPEC §8 を維持）
- **API キーはサーバ側のみ**。`.dev.vars`（ローカル）/ `wrangler secret`（本番）に保持し、
  HTML・JS・API レスポンスのいずれにも出力しない

### UI

- 起点カードはインクロンサル検索（`/api/ai/card-suggest`）で選択
- 自由記述には例文ボタンを用意
- インク色は最大2色まで絞り込み可能（ロルカナの2色ルールに準拠）
- 結果には **スコア / 役割 / AIの理由 / DB上の根拠タグ（‹database›アイコン）/ メカニクスタグ** を併記
- 提案カードをそのまま新しい起点にして再探索できる（‹rotate›ボタン）
- 検索結果は `?tab=ai&card=…&q=…&ink=…` で共有可能
- カード詳細ページからも「AIでシナジーを探す」で直接遷移できる

### 応答時間（実測）

| モード | 時間 |
|---|---|
| 起点カードのみ | 約 27 秒 |
| 自由記述のみ（LLM 2回） | 約 24 秒 |
| キャッシュヒット | 約 55 ms |

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
  - `rules_sections` (463) — 公式ルール本文（表示は抜粋のみ）
  - `rule_faqs` (79) — **公式ルールQ&A（質問・回答本文つき、14カテゴリ）**
  - `update_jobs` / `update_log` / `source_versions` — **データ更新ジョブの進捗・ログ・公式文書バージョン**
  - `meta` / `rate_limit` / `ai_rate_limit` / `ai_cache`

### テキストとルールの保存状況（実測値）

効果テキストと公式ルールは**すべて D1 上に保存済み**で、検索と AI 探索の両方がこれを直接読んでいます。

| 内容 | 場所 | 実測 |
|---|---|---|
| 効果テキスト（プレースホルダ生） | `cards.rules_text` | 2,231 / 2,500 枚（残りは効果テキストを持たないカード） |
| 効果テキスト（検索用・記号除去） | `cards.rules_text_plain` | 2,231 枚 |
| 能力名（`\…\` 抽出） | `cards.ability_names` | 2,500 枚に対して付与 |
| フレーバーテキスト | `cards.flavor_text` | 1,518 枚 |
| 全文検索用ブロブ | `cards.search_blob` | 2,500 枚（名前+版+テキスト+作家+種族+能力） |
| 公式ルール本文 | `rules_sections.body` | 463 節（総合ルール 382・プレイ修正ガイドライン 23・**大会ルール 56**・セットノートS1 2） |
| 公式ルールQ&A | `rule_faqs.question` / `.answer` | 79 件 / 14 カテゴリ（質問・回答の本文つき） |
| 種族・クラス | `classifications` | 5,075 行 / 42 種 |
| キーワード能力 | `abilities` | 1,255 行 / 13 種 |
| 効果テキストの種族参照タグ | `card_refs` | 227 行 |

**\* ルール本文は DB には全文保持していますが、ユーザーへは常に抜粋のみ返します**
（`/api/rules/search` は ±200 文字、`/api/rules/section/:id` は 400 文字まで）。
AI 探索では推論の根拠として内部的に参照しますが、レスポンスには含めません。BUILD_SPEC §8 準拠。

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

# AIシナジー探索を使う場合は .dev.vars を作成（git 管理外）
cat > .dev.vars <<'EOF'
OPENAI_API_KEY=sk-...
OPENAI_BASE_URL=https://api.openai.com/v1
AI_MODEL=gpt-5-mini
AI_MODEL_FAST=gpt-5-nano
ADMIN_TOKEN=任意の長い文字列        # 記憶層の構築APIを保護（未設定なら localhost のみ許可）
ADMIN_PASSWORD=任意の長いパスワード  # 隠し管理画面のログイン用（未設定なら ADMIN_TOKEN で代替）
ADMIN_PATH=x7f2q9                  # 任意。/_ops 以外の推測されにくいURLも受け付ける
EOF

# 記憶層（セマンティック・メモリ）を構築する場合
npx wrangler d1 execute webapp-production --local --file=./migrations/0002_semantic_memory.sql
# データ更新機能（隠し管理画面）を使う場合
npx wrangler d1 execute webapp-production --local --file=./migrations/0003_data_update.sql
# ※ `wrangler d1 migrations apply --local` はローカルDBを作り直す（＝既存データが消える）ため、
#    ローカルでは上記のように execute で当て、消えた場合は seed_*.sql を再投入する
npm run build && pm2 restart lorcana-fandb
for i in 0 200 400 600 800 1000 1200 1400 1600 1800 2000 2200 2400; do
  curl -s -XPOST localhost:3000/api/memory/build/cards -H 'content-type: application/json' \
    -d "{\"batch\":200,\"offset\":$i}" >/dev/null
done
curl -s -XPOST localhost:3000/api/memory/build/rules -d '{}'
curl -s -XPOST localhost:3000/api/memory/build/abilities -d '{}'   # 約2分40秒
curl -s localhost:3000/api/memory/stats

npm run build
pm2 start ecosystem.config.cjs
curl http://localhost:3000/api/health
curl http://localhost:3000/api/ai/status   # {"available":true,…} なら AI 有効
```

**AI 未設定でもサイト全体は動作します**。`/api/ai/status` が `available:false` を返すと
UI は AI タブに案内を出し、種族逆引きなど他の機能はそのまま使えます。

### UI 自動テスト

```bash
node scraper/test_synergy_ui.mjs   # jsdom で /synergy を実動作検証（35項目）
node scraper/test_admin.mjs        # 隠し管理画面の秘匿性・認証・CORS分離・機能を検証（44項目）
```
※ どちらもプロジェクトディレクトリ内から実行してください（jsdom の解決のため）。

## デプロイ（Cloudflare Pages）

```bash
npx wrangler d1 create webapp-production          # 発行された database_id を wrangler.jsonc に記入
npx wrangler d1 execute webapp-production --file=./migrations/0001_initial_schema.sql
npx wrangler d1 execute webapp-production --file=./scraper/data/seed_cards.sql
npx wrangler d1 execute webapp-production --file=./scraper/data/seed_rules.sql
npx wrangler d1 execute webapp-production --file=./migrations/0002_semantic_memory.sql
npx wrangler d1 execute webapp-production --file=./migrations/0003_data_update.sql
npx wrangler pages secret put OPENAI_API_KEY
npx wrangler pages secret put ADMIN_TOKEN
npx wrangler pages secret put ADMIN_PASSWORD    # 隠し管理画面のパスワード
npx wrangler pages secret put ADMIN_PATH        # 任意（管理画面の別URL）
npm run build && npx wrangler pages deploy dist --project-name webapp
# デプロイ後に記憶層を1回だけ構築（/api/memory/build/* を x-admin-token 付きで叩く）
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

### AIシナジー探索の検証結果

| 項目 | 結果 |
|---|---|
| 起点カードモード（エルサ／心配する姉） | ✅ 候補60枚→8枚提案。「ロケーションのコスト2減」を正しく読み、ロケーション連動カードを上位に |
| 入力量拡大後の再検証（候補120枚） | ✅ カード指定 120候補/24節→8枚 (30.7s)、自由記述 120候補/24節→10枚 (23.9s)、カード+自由記述+2色制約 120候補→12枚 (32.9s・インク違反0件) |
| 候補0件の解消 | ✅ 「アメジストとサファイアでアイテムとロケーションを使い回すコントロール」が 0候補→**103候補/10枚提案**（補充段の追加による） |
| 自由記述モード（「変身を軽くして高コストを早出し」） | ✅ 意図抽出→`変身`能力タグ+5語。変身コスト軽減カードを95点で首位に |
| 提案カードが全て DB 実在 | ✅ 5/5 枚が `cards` に存在（幻覚0件） |
| インク色2色制約の遵守 | ✅ アンバー+スティール指定で違反0件 |
| キャッシュ | ✅ 同一入力2回目は 55ms（LLM再呼び出しなし） |
| レート制限 | ✅ 4回目以降 429 + `Retry-After` |
| 入力バリデーション | ✅ 未入力400 / 不正JSON400 / 存在しないカード404 |
| API キーの漏洩 | ✅ HTML・JS・APIレスポンス全てで検出0件 |
| AI未設定時のフォールバック | ✅ `/api/ai/status` が `available:false` を返すとUIが案内表示し他機能は継続動作 |
| 記憶層の構築 | ✅ カード 2,500/2,500・ルール 463/463 ベクトル化、能力裁定 13/13 生成（`/api/memory/stats`） |
| 記憶層あり4クエリ通し | ✅ 全て200・24.3〜30.6秒・候補120枚・`vector_search:true`。提案の約8割がベクトル由来 |
| 経験の再利用 | ✅ 同条件2回目で `recalled:5`、提案 6→9枚に増加し上位が安定 |
| ルール分断バグの修正効果 | ✅ 「突撃」の裁定が5条文を根拠に完成、「護衛」は2つの効果を両方正しく記述（修正前は片方を不明と回答） |
| UI 自動テスト（jsdom） | ✅ **35/35 パス**（`node scraper/test_synergy_ui.mjs`） |

### 修正済み不具合: AI検索で「サーバー内部エラー」(HTTP 500)

間欠的に発生していた 500 の原因は **LLM応答の型ゆらぎに対する防御不足**（LLM呼び出し自体は成功しており、
その後の後処理で素の `TypeError` / `SyntaxError` が発生していた）。`LlmError` 以外の例外は
すべて 500 に落ちる実装だったため、ユーザーには原因不明の内部エラーとして見えていた。

| # | 原因 | 発生条件 | 対策 |
|---|---|---|---|
| ① | JSON救済処理の `JSON.parse` が try で囲まれておらず、素の `SyntaxError` が漏れる | 応答が途中で切れ、かつ文字列内に `}` を含む（`finish_reason=length` 時に発生） | 救済側も try で包み `LlmError('ai_bad_json_truncated')` に変換（→ 502） |
| ② | `picks` / `axes` / `caveats` を配列前提で `for..of` / `.slice().map()` していた | LLMがこれらを文字列・オブジェクト・null で返したとき | `toArray()` ヘルパーで正規化（文字列→1要素、オブジェクト→値配列、null→空配列） |
| ③ | 意図抽出の結果をそのままSQL段に渡していた | 同上（`keywords` 等が配列以外） | `asStrings()` で文字列配列へ正規化してから `retrieveCandidates` に渡す |
| ④ | 応答が配列やプリミティブでも `data` として通していた | JSONモードでも稀に配列が返る | `chatJson` でオブジェクトを保証し `ai_unexpected_shape` を投げる |
| ⑤ | 想定外例外が一律 500 + 「サーバー内部エラー」 | ①〜④のいずれか | 502 + 「もう一度お試しください」に変更し、UIに**再試行ボタン**を追加 |

**検証**: フォールト注入（応答途中切れ / `axes`文字列化 / `picks`オブジェクト化）を実サーバーに適用して確認。
修正前は3経路すべて 500 → 修正後は 切れ=502（制御されたエラー）、他2経路=**200で正常描画**。
後処理の型ゆらぎ10パターン網羅テストで未制御の500は 0 件。

**副次修正**: UI自動テストのAI待機を固定8秒からポーリング（最大75秒）に変更。実応答が20〜30秒のため
待機不足で6件が誤判定していた。

## データ更新（隠し管理画面）

新弾の追加やルール改定に追随するための管理画面です。**サイト内にリンクは一切なく**、
`robots.txt` で `Disallow: /_ops`、HTML に `noindex,nofollow,noarchive,nosnippet`、
レスポンスに `X-Robots-Tag: noindex` を付与し、ページタイトルは `maintenance` のみ。
ナビゲーション・フッターも描画しません（共有レイアウトを使わない独立ページ）。

### 開き方

| 項目 | 内容 |
|---|---|
| URL | `/_ops`、または環境変数 `ADMIN_PATH` に設定した任意パス（例 `ADMIN_PATH=x7f2q9` → `/x7f2q9`） |
| 認証 | `ADMIN_PASSWORD`（未設定時は `ADMIN_TOKEN` で代替）。パスワード欄のみのフォーム |
| セッション | HMAC-SHA256 署名 Cookie `__ops_sess`（`HttpOnly; SameSite=Strict`、TTL 2時間）。鍵はパスワード自体なので**パスワードを変えると既存セッションは全て無効化**される |
| 保護 | 定数時間比較、5回失敗で10分ロックアウト、管理APIは CORS を付与しない（同一オリジン専用） |

D1 への書き込みを伴わないステートレス認証にしているため、ログイン処理でDBを消費しません。

### 4つのボタン

| ボタン | 動作 | 所要 |
|---|---|---|
| **カードデータを更新** | 公式カード検索APIを全ページ巡回し、`cards` / `classifications` / `abilities` / `card_refs` を差分更新。新規カードは名前・版・収録セットをログに表示 | 約1分（2,500枚 / 25ページ） |
| **ルール改定をチェック** | 公式ルールPDF4文書の `Last-Modified` / `Content-Length` を取得し、取り込み済みバージョンと比較して「要更新 / 最新」を表示 | 数秒 |
| **公式Q&Aを更新** | 公式ルールFAQページから79件のQ&A（本文つき・14カテゴリ）を取得し `rule_faqs` に差分反映 | 約2秒 |
| **記憶層を更新** | `/api/memory/build/*` を `next_offset` に沿って自動ループ。`text_hash` 差分なので変更分のみ再ベクトル化 | 変更なしなら数秒 |

上部のステータス画面に、カード枚数・ルール節数・Q&A件数・ベクトル化率（未ベクトル化があれば警告表示）・
公式文書のバージョン一覧・直近ジョブ履歴を表示します。

### カード更新の仕組み（分割ジョブ）

Cloudflare Workers は1リクエストの実行時間が限られるため、25ページ×1.2秒を1回で回せません。
そこで `update_jobs` テーブルに進捗（ページ番号・件数・状態）を持たせ、
**1回の呼び出しで5ページ（約9秒）進めてクライアントが自動的に次を呼ぶ**方式にしました。

- 途中でタブを閉じても進捗は残り、次回ログイン時に「中断したジョブを再開」ボタンが出る
- 差分判定は公式の `modified` ではなく**主要フィールド＋効果テキストの署名比較**。
  一致すれば書き込みを完全にスキップするため、同期済みなら2,500枚で書き込み0件
- 変更のあったカードだけ `classifications` / `abilities` / `card_refs` を削除→再構築するので、
  タグが減った場合も残留しない
- リクエスト間 1,200ms + random(0,400)、直列1本、User-Agent 明示、403時はトークン再取得（BUILD_SPEC §0 遵守）

### 検証結果

| 項目 | 結果 |
|---|---|
| 全ページ巡回 | ✅ 25ページ / 2,500枚。同期済み状態では 新規0・更新0・変更なし2,500（書き込み0件） |
| 新弾の検知（模擬） | ✅ カードを1枚削除＋1枚改変した状態で実行 → `新規1 / 更新1 / 変更なし2,498` を正しく検出し、種族3件・能力1件も再構築 |
| 差分再ベクトル化 | ✅ 上記の2枚だけを2.5秒で再埋め込み（2,498→2,500） |
| ルール改定検知 | ✅ `Range: bytes=0-0` の応答が **206** であることに対応。既に取り込み済みの3文書は「最新」、未取得だった大会ルールのみ「要更新」と判定 |
| 公式Q&A取得 | ✅ 79件 / 14カテゴリを1.7秒で取得 |
| 秘匿性・認証・CORS分離 | ✅ `node scraper/test_admin.mjs` で **44/44 パス** |
| 既存機能への影響 | ✅ `node scraper/test_synergy_ui.mjs` **35/35 パス**（回帰なし）、存在しないパスは従来通り404 |

### 副産物: 大会ルールPDFの404を解消

仕様書記載の `Disney_Tournament_Rules_JP.pdf` が404だった原因は URL の変更で、
公式ページの実リンクは **`Disney_Lorcana_Tournament_Rules_JP.pdf`** でした。
修正して取り込み、ルール節数は **406 → 463**（大会ルール56節を追加）、ベクトルも463/463に更新済みです。

### 本番で使う場合

```bash
npx wrangler d1 execute webapp-production --file=./migrations/0003_data_update.sql
npx wrangler pages secret put ADMIN_PASSWORD
npx wrangler pages secret put ADMIN_PATH      # 任意（URL自体を隠したい場合）
```

## 未実装 / 既知の制約

1. **プレイシートPDF** — 図版中心でテキスト抽出が0節。実質的に検索対象外
2. **カード個別Q&A本文** — 検索APIの `faqs` はスラッグ（例 `set1-no14-1`）のみで本文を含まない。
   本文取得に使う想定だった `card_qa.php` は**現在 404**（実測）で入手経路がない。
   代替として公式ルールFAQページから 79 件の Q&A 本文を `rule_faqs` に取り込んだ
   （カード単位の紐付けはなし）
3. **`rule_faqs` の AI プロンプトへの組み込み** — 未実装。取り込みは完了しているが、
   シナジー分析の根拠として渡す処理（ベクトル化＋プロンプト注入）は次段階
4. **デッキ→デッキコード発行** — 仕様書 §6.1 の判断通り未実装（公式の1日30回制限のため）。
   公式デッキビルダーへのリンクで代替
5. **Lighthouse 90+** — 未計測（サンドボックス環境のため実測は未実施）
6. **Cloudflare Pages への本番デプロイ** — 未実行（本番では `wrangler pages secret put OPENAI_API_KEY` が別途必要）
7. **データ更新は手動トリガー** — 隠し管理画面のボタンで実行する方式（下記「データ更新」節）。
   自動実行する Cron は未設定。カードを追加したあとは同画面の「記憶層を更新」も押す必要がある
   （再ベクトル化は `text_hash` 差分なので、変更分のみ数秒で完了する）
8. **web上の情報の集積（外部知識の学習）** — 未実装。設計案は「今後の拡張案」節を参照
9. **AI の応答は 20～40 秒** — ストリーミング未対応。スケルトン表示で待機させている
   （記憶層導入後の実測: 24.3〜31.0s、タイムアウトは 90s）
10. **「強いプレイの動き」の記憶化** — 未実装（**次回の実装課題**）。
    現在の記憶層はカード・ルール・能力裁定という「静的な知識」に閉じており、
    「どう動かすと強いか」という**手順の知識**を持たない。設計案は
    「今後の拡張案: 「強いプレイの動き」を記憶させる」節を参照

## 今後の拡張案: 「強いプレイの動き」を記憶させる（未実装・次回実装予定）

### 現状の限界

記憶層が持っているのは以下の3種類で、いずれも**静的**な知識である。

| 現在記憶しているもの | テーブル | 性質 |
|---|---|---|
| カードの意味ベクトル | `card_vectors` | このカードは何か |
| ルール条文の意味ベクトル | `rule_vectors` | 何が合法か |
| 能力の裁定要約 | `ability_knowledge` | この能力はどう処理するか |
| 検証済みシナジー（カードの組） | `synergy_memory` | AとBは噛み合う |

足りていないのは**時間軸を含む知識**、すなわち「1ターン目に何をして、
3ターン目に何を通せば勝ちに近づくか」という**手順（ライン）**である。
そのため現行の提案は「相性の良いカードの列挙」に寄りやすく、
「そのカードを何ターン目にどう使うのか」という実戦的な精度が出ていない。

### 実装案: `play_pattern` テーブル

```sql
CREATE TABLE play_pattern (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,        -- 例「歌でコストを飛ばして4コスト帯を2ターン早める」
  archetype    TEXT,                 -- アグロ・ロア / ミッドレンジ / コントロール など
  ink_pair     TEXT,                 -- 「アンバー/スティール」
  turn_window  TEXT,                 -- 「T2-T4」
  preconditions TEXT,                -- 成立条件（盤面キャラ5体以上、歌える3など）
  sequence     TEXT,                 -- 手順を1行1手で記述（JSON配列）
  payoff       TEXT,                 -- 得られる利益（ロア加速 / 除去回避 / テンポ）
  counterplay  TEXT,                 -- 相手側の返し方（弱点の明示）
  rule_refs    TEXT,                 -- 根拠となる rules_sections.id（JSON配列）
  embedding    BLOB,                 -- 256次元。既存 memory.ts の仕組みを流用
  text_hash    TEXT,                 -- 差分再ベクトル化用
  source       TEXT,                 -- 'curated' / 'llm_derived' / 'user_confirmed'
  confidence   REAL DEFAULT 0.5,
  created_at   TEXT DEFAULT (datetime('now'))
);
```

### 供給ルート（3段階で育てる）

1. **手動キュレーション（最初の20〜40件）** — 「歌でコスト踏み倒し」「エグザート登場を
   支援/護衛で守る」「変身で登場時能力を再利用」など、ルール条文に裏付けのある
   定番の動きを人力で登録する。`rule_refs` を必ず埋めて根拠を辿れるようにする。
2. **既存の分析結果からの自動抽出** — `ai_cache` に溜まっている過去の提案理由を
   LLM に読ませ、「カードの組」ではなく「手順」として言い換えられるものだけを
   `source='llm_derived'`, `confidence=0.3` で登録する。人が承認したら 0.8 に昇格。
3. **ユーザーからのフィードバック** — UI に「この動きは実戦で強かった」ボタンを置き、
   押された `play_pattern` の `confidence` を加算する（現行 `synergy_memory` と同じ思想）。

### 分析パイプラインへの組み込み

現行の4段構成（意図解釈 → 候補抽出 → 順位付け → 整形）に対する変更は小さい。

- **候補抽出**: クエリのベクトルで `play_pattern` を近傍検索し、ヒットしたパターンの
  `preconditions` に含まれるカード群を候補プールに加点（既存のベクトル加点と同じ枠）。
- **順位付け**: プロンプトに「参考になる強い動き」として上位2〜3件の
  `name` / `turn_window` / `sequence` / `counterplay` を渡す。
  → 出力が「Aと相性が良い」から「T2にAを出し、T3にBの歌でCを踏み倒す」へ具体化する。
- **レスポンス**: `memory.play_patterns` を追加し、UI にバッジで根拠を表示。

### 注意点

- **手順は環境依存で腐る**。`confidence` と更新日時を持たせ、古く未確認のものは減衰させる。
- **ルールに反する手順を覚えさせない**。登録時に `rule_refs` を必須にし、
  条文と矛盾する手順は入れない（現行の「外部知識を使わせない」原則の延長）。
- **プロンプト長の管理**。パターンは1件あたり200字程度に圧縮して渡す。
  現在ルール条文の圧縮で稼いだ余裕（約30%削減）の範囲に収まる想定。

**工数の目安**: テーブル追加とベクトル検索の配線に半日、キュレーション20件に半日、
プロンプト統合とUI表示に半日。**web情報の集積（下記）より優先度が高い**
（外部データに依存せず、手元のルールとカードだけで精度が上がるため）。

## 今後の拡張案: web上の情報を集積してシナジー分析に活かす（未実装）

現行の記憶層は「公式データ（カード・総合ルール）＋自前の検討履歴」だけで閉じている。
これを web 上の情報（大会入賞デッキ、環境記事、コミュニティの議論）まで広げる構想は
**技術的には現行アーキテクチャの上に無理なく載る**。想定設計は以下。

### 実現方式

| 層 | 内容 | 実装先 |
|---|---|---|
| 収集 | 公式デッキリスト／大会結果ページを日次クロール。robots.txt と利用規約を尊重し、取得元・取得日時を必ず記録 | GitHub Actions（Cron）。Workers では長時間処理ができないためサンドボックス外で実行 |
| 正規化 | HTML → カード名の配列に還元し、既存 `cards` に**名前突合**。突合できなかった行は捨てる（表記ゆれの混入防止） | scraper 側の Node スクリプト |
| 統計化 | 「同一デッキに同居した回数」「共起リフト値」を集計。テキストは保存せず**数値だけ**を D1 に入れる | 新テーブル `cooccurrence(card_a, card_b, decks, lift, window)` |
| 活用 | 候補抽出の加点（現行の `synergy_memory` ボーナスと同じ枠）＋プロンプトに「実戦での共起上位」として数行渡す | `src/lib/ai.ts` / `src/routes/ai.ts` を数十行修正するだけ |

### なぜ現行設計にそのまま載るか

- 候補抽出は既に「複数シグナルの加点プール」構造（LIKE / 種族参照 / メカニクス / ベクトル / 過去の高評価）。
  共起統計は**6本目のシグナルを足すだけ**で済む。
- 記憶層のテーブル設計（`text_hash` 差分・ベクトルBLOB）を流用できるため、
  記事本文を要約してベクトル化する拡張も同じパターンで足せる。
- 失敗時は無視して従来動作に落ちる「可用性優先」の作りになっているので、収集が止まっても機能は死なない。

### 注意すべき制約（先に決めておくべきこと）

1. **著作権・利用規約**。記事本文やブログの文章をそのまま D1 に溜めて再配布するのは避ける。
   安全なのは「カード名の共起という事実（数値）」までに絞ること。要約を保存する場合は
   出典URLを必ず併記し、UI では引用ではなくリンクで示す。
2. **ノイズの質**。個人ブログの主張は誤りを含む。**統計（共起・勝率）は強いが、文章による主張は弱い**
   という重み付けが必要。文章を根拠にするなら「公式Q&A > 大会データ > 記事」の階層を明示する。
3. **環境の陳腐化**。1年前の共起は現環境では有害。集計に `window`（直近90日など）を持たせ、
   古いデータは減衰させる。
4. **クロール負荷**。日次・低頻度・User-Agent 明示・失敗時は指数バックオフ。
   Cloudflare Workers 側からは叩かず、Actions 側で完結させる。

**工数の目安**: 収集＋正規化に 1〜2日、共起集計と加点統合に半日、UI の出典表示に半日。
最初は「公式が公開している大会入賞デッキのみ」に絞るのが安全かつ効果が大きい。

## 推奨される次のステップ

1. `card_qa.php` を叩いて FAQ 本文を取得し、カード詳細に Q&A セクションを追加
   （取得できれば AI 探索の根拠にも使える）
2. Cloudflare Pages へデプロイ（D1 の本番作成 → seed 投入 → secret 設定 → deploy）
3. GitHub Actions で差分更新 Cron を有効化
4. Lighthouse 計測と最適化
5. **AI 探索をデッキ全体に拡張** — 60枚のデッキを渡して強化カード・不要カードを提案させる
6. **AI 回答のストリーミング表示** — 体感待ち時間の短縮
7. **ベクトル検索の導入** — 語彙不一致な自由記述への耐性向上

## 技術スタック

- **バックエンド**: Hono 4 + TypeScript（Cloudflare Workers/Pages）
- **DB**: Cloudflare D1（SQLite）
- **フロントエンド**: バニラJS + Tailwind CSS (CDN) + Font Awesome (CDN)
- **スクレイパー**: Node.js 22（`fetch` / `pdftotext`）
- **ビルド**: Vite 8 + `@hono/vite-build/cloudflare-pages`
- **AI**: OpenAI 互換 `/chat/completions`（`gpt-5-mini` / `gpt-5-nano`、JSON mode、SDK不使用）
- **UIテスト**: jsdom（`scraper/test_synergy_ui.mjs`）
- **最終更新**: 2026-08-20
