import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { renderer } from './renderer';
import type { Bindings } from './types';
import api from './routes/api';
import deckApi from './routes/deck';

const app = new Hono<{ Bindings: Bindings }>();

app.use('/api/*', cors());
app.use(renderer);

app.route('/api', api);
app.route('/api/deck', deckApi);

// ============================ カード検索（トップ）============================
app.get('/', (c) =>
  c.render(
    <div class="max-w-7xl mx-auto px-4 py-5">
      <div class="lg:grid lg:grid-cols-[280px_1fr] lg:gap-6">
        {/* 検索フォーム */}
        <aside class="lg:sticky lg:top-16 lg:self-start lg:max-h-[calc(100vh-5rem)] lg:overflow-y-auto thin-scroll">
          <details class="lg:hidden mb-3 bg-slate-900 rounded-lg border border-slate-700" open>
            <summary class="px-4 py-2.5 cursor-pointer font-semibold text-sm">
              <i class="fas fa-sliders mr-2"></i>検索条件
            </summary>
            <div id="filter-mount-mobile"></div>
          </details>
          <div id="filter-panel" class="hidden lg:block space-y-3"></div>
        </aside>

        {/* 結果 */}
        <section>
          <div class="flex flex-wrap items-center gap-2 justify-between mb-3">
            <h1 class="text-lg font-bold">
              <i class="fas fa-magnifying-glass text-amber-300 mr-1.5"></i>
              カード検索
              <span id="result-count" class="ml-2 text-sm font-normal text-slate-400"></span>
            </h1>
            <div class="flex items-center gap-2 text-xs">
              <label class="text-slate-400" for="sort-select">並び順</label>
              <select
                id="sort-select"
                class="bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-slate-100"
              >
                <option>リリース順</option>
                <option>カードナンバー（昇順）</option>
                <option>カードナンバー（降順）</option>
                <option>インクコスト順（昇順）</option>
                <option>インクコスト順（降順）</option>
                <option>攻撃力順（昇順）</option>
                <option>攻撃力順（降順）</option>
                <option>意志力順（昇順）</option>
                <option>意志力順（降順）</option>
              </select>
              <select
                id="perpage-select"
                class="bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-slate-100"
                aria-label="表示件数"
              >
                <option value="50">50件</option>
                <option value="100">100件</option>
                <option value="24">24件</option>
              </select>
              <div class="flex rounded overflow-hidden border border-slate-600" role="group" aria-label="表示形式">
                <button id="view-grid" class="px-2 py-1.5 bg-slate-700" title="グリッド表示">
                  <i class="fas fa-th"></i>
                </button>
                <button id="view-list" class="px-2 py-1.5 bg-slate-800" title="リスト表示">
                  <i class="fas fa-list"></i>
                </button>
              </div>
            </div>
          </div>

          {/* 比較トレイ */}
          <div
            id="compare-tray"
            class="hidden mb-3 p-2.5 bg-slate-900 border border-sky-700/60 rounded-lg"
          ></div>

          <div id="results" class="min-h-[300px]"></div>
          <div id="pager" class="mt-5 flex justify-center"></div>
        </section>
      </div>

      {/* 鑑賞モード用ライトボックス */}
      <div id="lightbox" role="dialog" aria-modal="true" aria-label="カード画像拡大">
        <button
          id="lightbox-close"
          class="absolute top-4 right-4 w-10 h-10 rounded-full bg-slate-800/80 text-white grid place-items-center hover:bg-slate-700"
          aria-label="閉じる"
        >
          <i class="fas fa-times"></i>
        </button>
        <img id="lightbox-img" src="" alt="" />
      </div>
    </div>,
    { title: 'カード検索', nav: 'search' }
  )
);

// ============================ カード詳細 ============================
app.get('/cards/:key', (c) =>
  c.render(
    <div class="max-w-6xl mx-auto px-4 py-5">
      <a href="/" class="inline-flex items-center gap-1.5 text-sm text-slate-400 hover:text-slate-200 mb-4">
        <i class="fas fa-arrow-left"></i>カード検索に戻る
      </a>
      <div id="card-detail" data-key={c.req.param('key')}></div>
      <div id="lightbox" role="dialog" aria-modal="true" aria-label="カード画像拡大">
        <button
          id="lightbox-close"
          class="absolute top-4 right-4 w-10 h-10 rounded-full bg-slate-800/80 text-white grid place-items-center hover:bg-slate-700"
          aria-label="閉じる"
        >
          <i class="fas fa-times"></i>
        </button>
        <img id="lightbox-img" src="" alt="" />
      </div>
    </div>,
    { title: 'カード詳細', nav: 'search' }
  )
);

// ============================ デッキビルダー ============================
app.get('/deck', (c) =>
  c.render(
    <div class="max-w-7xl mx-auto px-4 py-5">
      <div class="flex flex-wrap items-center justify-between gap-2 mb-4">
        <h1 class="text-lg font-bold">
          <i class="fas fa-layer-group text-amber-300 mr-1.5"></i>デッキビルダー
        </h1>
        <div class="flex flex-wrap gap-2 text-xs">
          <button id="deck-import-btn" class="px-3 py-1.5 bg-sky-600 hover:bg-sky-500 rounded font-semibold">
            <i class="fas fa-file-import mr-1"></i>デッキコード読込
          </button>
          <button id="deck-share-btn" class="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 rounded">
            <i class="fas fa-link mr-1"></i>URLを共有
          </button>
          <a
            href="https://www.takaratomy.co.jp/products/disneylorcana/deckbuilder/"
            target="_blank"
            rel="noopener noreferrer"
            class="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 rounded"
          >
            <i class="fas fa-external-link-alt mr-1"></i>公式デッキビルダー
          </a>
          <button id="deck-clear-btn" class="px-3 py-1.5 bg-rose-900/70 hover:bg-rose-800 rounded">
            <i class="fas fa-trash mr-1"></i>クリア
          </button>
        </div>
      </div>

      {/* デッキコード入力 */}
      <div id="deck-import-panel" class="hidden mb-4 p-4 bg-slate-900 border border-sky-700/60 rounded-lg">
        <label for="deck-code-input" class="block text-sm font-semibold mb-1.5">
          公式サイトで発行されたデッキコード
        </label>
        <p class="text-xs text-slate-400 mb-2">
          公式のデッキビルダーで発行したコードを貼り付けると、このデッキに反映します。
          復号は公式APIを経由します（当サイトからの問い合わせ回数には制限を設けています）。
        </p>
        <div class="flex flex-wrap gap-2">
          <input
            id="deck-code-input"
            type="text"
            placeholder="例) ABCDEFGH2345…"
            autocomplete="off"
            spellcheck={false}
            class="flex-1 min-w-[220px] bg-slate-800 border border-slate-600 rounded px-3 py-2 font-mono text-sm uppercase"
          />
          <button id="deck-code-submit" class="px-4 py-2 bg-sky-600 hover:bg-sky-500 rounded text-sm font-semibold">
            読み込む
          </button>
        </div>
        <div id="deck-import-msg" class="mt-2 text-xs"></div>
      </div>

      <div class="lg:grid lg:grid-cols-[1fr_400px] lg:gap-5">
        {/* 左: カードプール */}
        <section>
          <div class="flex flex-wrap gap-2 items-center mb-2.5">
            <input
              id="pool-search"
              type="search"
              placeholder="カード名・効果テキストで検索…"
              class="flex-1 min-w-[180px] bg-slate-800 border border-slate-600 rounded px-3 py-2 text-sm"
            />
            <select id="pool-ink" class="bg-slate-800 border border-slate-600 rounded px-2 py-2 text-xs" aria-label="インク色">
              <option value="">全インク色</option>
            </select>
            <select id="pool-type" class="bg-slate-800 border border-slate-600 rounded px-2 py-2 text-xs" aria-label="カード種別">
              <option value="">全種別</option>
            </select>
          </div>
          <p class="text-[11px] text-slate-500 mb-2">
            <i class="fas fa-hand-pointer mr-1"></i>
            カードをクリック、またはデッキ欄へドラッグ&ドロップで追加できます。
          </p>
          <div id="pool-results" class="min-h-[200px]"></div>
        </section>

        {/* 右: デッキ */}
        <aside class="mt-6 lg:mt-0 lg:sticky lg:top-16 lg:self-start">
          <div
            id="deck-drop-zone"
            class="drop-zone bg-slate-900 border-2 border-dashed border-slate-700 rounded-lg p-3"
          >
            <div id="deck-summary" class="mb-3"></div>
            <div id="deck-validation" class="mb-3 space-y-1"></div>
            <div id="deck-list" class="max-h-[45vh] overflow-y-auto thin-scroll space-y-1"></div>
          </div>
          <div id="deck-stats" class="mt-3 space-y-3"></div>
        </aside>
      </div>

      <div id="lightbox" role="dialog" aria-modal="true" aria-label="カード画像拡大">
        <button
          id="lightbox-close"
          class="absolute top-4 right-4 w-10 h-10 rounded-full bg-slate-800/80 text-white grid place-items-center hover:bg-slate-700"
          aria-label="閉じる"
        >
          <i class="fas fa-times"></i>
        </button>
        <img id="lightbox-img" src="" alt="" />
      </div>
    </div>,
    { title: 'デッキビルダー', nav: 'deck' }
  )
);

// ============================ シナジー探索 ============================
app.get('/synergy', (c) =>
  c.render(
    <div class="max-w-7xl mx-auto px-4 py-5">
      <h1 class="text-lg font-bold mb-1">
        <i class="fas fa-diagram-project text-amber-300 mr-1.5"></i>シナジー探索
      </h1>
      <p class="text-xs text-slate-400 mb-4">
        効果テキストが特定の種族（クラス）を参照するカードと、その種族を持つカードを並べて表示します。
        デッキの軸を見つけるための逆引き機能です。
      </p>
      <div class="flex flex-wrap gap-2 items-center mb-4">
        <label for="synergy-select" class="text-sm text-slate-300">
          種族
        </label>
        <select id="synergy-select" class="bg-slate-800 border border-slate-600 rounded px-3 py-2 text-sm min-w-[180px]">
          <option value="">選択してください</option>
        </select>
      </div>
      <div id="synergy-result"></div>
      <div id="lightbox" role="dialog" aria-modal="true" aria-label="カード画像拡大">
        <button
          id="lightbox-close"
          class="absolute top-4 right-4 w-10 h-10 rounded-full bg-slate-800/80 text-white grid place-items-center hover:bg-slate-700"
          aria-label="閉じる"
        >
          <i class="fas fa-times"></i>
        </button>
        <img id="lightbox-img" src="" alt="" />
      </div>
    </div>,
    { title: 'シナジー探索', nav: 'synergy' }
  )
);

// ============================ ルールブラウザ ============================
app.get('/rules', (c) =>
  c.render(
    <div class="max-w-7xl mx-auto px-4 py-5">
      <h1 class="text-lg font-bold mb-1">
        <i class="fas fa-scale-balanced text-amber-300 mr-1.5"></i>公式ルール検索
      </h1>
      <div class="mb-4 p-3 bg-amber-950/40 border border-amber-800/60 rounded-lg text-xs text-amber-100/90">
        <i class="fas fa-triangle-exclamation mr-1.5"></i>
        当サイトはルール文書の全文を掲載していません。検索した語の周辺のみを抜粋表示し、
        続きは<strong>公式PDF</strong>でご確認いただく設計です。正確な裁定は必ず公式文書を参照してください。
      </div>

      <div class="mb-4 flex flex-wrap gap-2">
        <input
          id="rules-query"
          type="search"
          placeholder="例) 護衛、バニッシュ、チャレンジ、インクウェル…"
          class="flex-1 min-w-[220px] bg-slate-800 border border-slate-600 rounded px-3 py-2 text-sm"
        />
        <select id="rules-source" class="bg-slate-800 border border-slate-600 rounded px-2 py-2 text-xs" aria-label="対象文書">
          <option value="">全文書</option>
          <option value="comprehensive">総合ルール</option>
          <option value="guidelines">プレイ修正ガイドライン</option>
          <option value="set_notes_s1">セットノート S1</option>
        </select>
        <button id="rules-search-btn" class="px-4 py-2 bg-sky-600 hover:bg-sky-500 rounded text-sm font-semibold">
          検索
        </button>
      </div>

      <div class="lg:grid lg:grid-cols-[260px_1fr] lg:gap-5">
        <aside class="mb-4 lg:mb-0 lg:sticky lg:top-16 lg:self-start">
          <h2 class="text-xs font-bold text-slate-400 uppercase mb-2">目次</h2>
          <div
            id="rules-toc"
            class="max-h-[65vh] overflow-y-auto thin-scroll bg-slate-900 rounded-lg border border-slate-700 p-2 text-xs"
          ></div>
        </aside>
        <section id="rules-results"></section>
      </div>
    </div>,
    { title: '公式ルール検索', nav: 'rules' }
  )
);

// ============================ お気に入り ============================
app.get('/favorites', (c) =>
  c.render(
    <div class="max-w-7xl mx-auto px-4 py-5">
      <h1 class="text-lg font-bold mb-1">
        <i class="fas fa-star text-amber-300 mr-1.5"></i>お気に入り
      </h1>
      <p class="text-xs text-slate-400 mb-4">
        お気に入りはこのブラウザ内（LocalStorage）にのみ保存されます。ログインは不要で、サーバには送信されません。
      </p>
      <div id="favorites-result"></div>
      <div id="lightbox" role="dialog" aria-modal="true" aria-label="カード画像拡大">
        <button
          id="lightbox-close"
          class="absolute top-4 right-4 w-10 h-10 rounded-full bg-slate-800/80 text-white grid place-items-center hover:bg-slate-700"
          aria-label="閉じる"
        >
          <i class="fas fa-times"></i>
        </button>
        <img id="lightbox-img" src="" alt="" />
      </div>
    </div>,
    { title: 'お気に入り', nav: 'favorites' }
  )
);

// ============================ このサイトについて ============================
app.get('/about', (c) =>
  c.render(
    <div class="max-w-3xl mx-auto px-4 py-6 space-y-5 text-sm leading-relaxed">
      <h1 class="text-xl font-bold">このサイトについて</h1>

      <section class="space-y-2">
        <h2 class="font-bold text-amber-300">非公式ファンサイトです</h2>
        <p class="text-slate-300">
          当サイトはディズニー・ロルカナTCG（日本語版）を遊ぶファンが、カードを探しやすくすることを目的に
          制作した非公式のデータベースです。ディズニー社、Ravensburger 社、株式会社タカラトミーとは
          一切関係がなく、これらの企業から許諾・監修・後援を受けていません。
        </p>
      </section>

      <section class="space-y-2">
        <h2 class="font-bold text-amber-300">権利について</h2>
        <ul class="list-disc pl-5 space-y-1 text-slate-300">
          <li>
            © Disney / Operated by Ravensburger。作品名・キャラクター名・カード名・イラスト等の
            著作権および商標は各権利者に帰属します。
          </li>
          <li>
            <strong>カード画像は当サイトでは保存・配布していません。</strong>
            表示している画像はすべて公式サーバ上のファイルを直接参照（ホットリンク）しています。
          </li>
          <li>
            効果テキストはカードの機能を示す事実データとして掲載しています。要約・翻案は行っていません。
          </li>
          <li>
            公式ルール文書は全文を掲載せず、検索語の周辺抜粋と公式PDFへのリンクのみを提供します。
          </li>
        </ul>
      </section>

      <section class="space-y-2">
        <h2 class="font-bold text-amber-300">データの取得方法</h2>
        <p class="text-slate-300">
          カードデータは公式サイトのカード検索機能を通じて取得しています。取得の際は
          リクエスト間に 1.2 秒以上の間隔を空け、並列アクセスを行わず、User-Agent を明示しています。
          公式サーバに負荷をかけない運用を心がけていますが、問題があればサイト運営者までご連絡ください。
        </p>
        <p class="text-slate-300">
          デッキコードの復号は公式APIを経由します。乱用を防ぐため、
          IP アドレスごとに 60 秒あたり 10 回、24 時間あたり 200 回の上限を設けています。
        </p>
      </section>

      <section class="space-y-2">
        <h2 class="font-bold text-amber-300">免責</h2>
        <p class="text-slate-300">
          掲載情報の正確性には努めていますが、内容を保証するものではありません。
          大会等における正式な裁定は必ず公式のルール文書および公式のアナウンスをご確認ください。
          データの誤りや不具合により生じた損害について、当サイトは責任を負いません。
        </p>
      </section>

      <section class="space-y-2">
        <h2 class="font-bold text-amber-300">削除のご依頼</h2>
        <p class="text-slate-300">
          権利者の方で当サイトの内容に問題があるとお考えの場合、ご連絡いただければ
          速やかに該当箇所を削除または修正いたします。
        </p>
      </section>

      <div id="about-stats" class="pt-4 border-t border-slate-800 text-xs text-slate-400"></div>
    </div>,
    { title: 'このサイトについて', nav: 'about' }
  )
);

// robots.txt（クロール方針を明示）
app.get('/robots.txt', (c) =>
  c.text(
    ['User-agent: *', 'Allow: /', 'Disallow: /api/', 'Crawl-delay: 2', ''].join('\n')
  )
);

app.get('/api/health', (c) => c.json({ ok: true }));

export default app;
