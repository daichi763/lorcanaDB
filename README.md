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
| **AIシナジー探索** | **起点カードを選んだり、やりたいことを自由記述すると、AI が噂み合うカードをスコア＋理由付きで提案**（下記「AIシナジー探索の仕組み」参照） |
| シナジー探索（種族逆引き） | 「種族Xを参照する効果を持つカード」⇄「種族Xを持つカード」を横並び表示 |
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
| **POST** | **`/api/ai/synergy`** | **AIシナジー探索**。body: `{card_file?, text?, restrict_ink?[], want?}` |
| GET | `/api/ai/status` | AI利用可否と利用上限（鍵は返さない） |
| GET | `/api/ai/card-suggest?q=` | 起点カードのオートコンプリート（最大20件） |
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

**`/api/ai/synergy` のレート制限**: IP毎に 60秒 3回 / 24時間 60回。
同一入力は D1 に 24 時間キャッシュされ、キャッシュヒットはレート制限を消費しない（実測 55ms）。

---

## AIシナジー探索の仕組み

`/synergy` の「AIシナジー探索」タブ。起点カードと自由記述は**どちらか一方でも、両方でも**指定可能。

### 処理フロー（4段構成）

| 段 | 内容 | 実装 |
|---|---|---|
| 1. 意図抽出 | 自由記述を検索語（keywords / 種族 / 能力 / インク色 / 種別）に分解 | `gpt-5-nano` (reasoning: minimal) |
| 2. 候補抽出 | **D1 上の決定的な SQL** で最大 120 枚に絞る（名前指名・種族参照・同系メカニクス等を加点し、不足分は指定条件で段階的に補充） | `src/lib/ai.ts` |
| 3. 順位付け | 候補＋**総合ルールの該当条文（最大24節×900字）**を渡してスコアと理由を生成 | `gpt-5-mini` (reasoning: low) |
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
  キーワード能力（13種）の解釈は常に `rules_sections` から RAG で供給する
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
  - `rules_sections` (406) — 公式ルール本文（表示は抜粋のみ）
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
| 公式ルール本文 | `rules_sections.body` | 406 節 / 約 105,000 文字（総合ルール 382・プレイ修正ガイドライン 23・セットノートS1 1） |
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
EOF

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

## 未実装 / 既知の制約

1. **大会ルールPDF** — 仕様書記載の URL が現在 404。総合ルール・プレイ修正
   ガイドライン・セットノートS1 の 3 文書（406節）のみ取り込み済み
2. **プレイシートPDF** — 図版中心でテキスト抽出が0節。実質的に検索対象外
3. **カードQ&A本文** — 検索APIの `faqs` はスラッグ（例 `set1-no14-1`）のみで本文を含まず。
   `card_qa.php` を叩いて本文を補完する処理は未実装（445件のIDのみ保持）
4. **デッキ→デッキコード発行** — 仕様書 §6.1 の判断通り未実装（公式の1日30回制限のため）。
   公式デッキビルダーへのリンクで代替
5. **Lighthouse 90+** — 未計測（サンドボックス環境のため実測は未実施）
6. **Cloudflare Pages への本番デプロイ** — 未実行（本番では `wrangler pages secret put OPENAI_API_KEY` が別途必要）
7. **AI 探索の候補抽出** — ベクトル検索（embedding）でなく LIKE ＋ルールベースのスコアリング。
   語彙が一致しない言い回しには弱い（例: 「ビートダウン」のようなスラング）。
   現在は補充段で 120 枚まで埋めて「0件」は回避しているが、補充分の関連度は LLM 側の判断に任せている
8. **AI の応答は 20～60 秒** — ストリーミング未対応。スケルトン表示で待機させている
   （候補120枚化後の実測: 23.9〜38.2s、タイムアウトは 90s）

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
