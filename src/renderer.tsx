import { jsxRenderer } from 'hono/jsx-renderer';

export const renderer = jsxRenderer(({ children, title, nav }) => {
  const pageTitle = title ? `${title} | 非公式カードデータベース` : 'ディズニー・ロルカナ 非公式カードデータベース';
  return (
    <html lang="ja">
      <head>
        <meta charSet="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>{pageTitle}</title>
        <meta
          name="description"
          content="ディズニー・ロルカナTCG（日本語版）のカードを検索・比較し、デッキを組めるファン制作の非公式データベース。カード画像は公式サイトを参照します。"
        />
        <link rel="preconnect" href="https://cdn.jsdelivr.net" />
        <script src="https://cdn.tailwindcss.com"></script>
        <link
          href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css"
          rel="stylesheet"
        />
        <link href="/static/style.css" rel="stylesheet" />
      </head>
      <body class="bg-slate-950 text-slate-100 min-h-screen flex flex-col antialiased">
        <header class="sticky top-0 z-40 bg-slate-900/95 backdrop-blur border-b border-slate-700/70">
          <div class="max-w-7xl mx-auto px-4">
            <div class="flex items-center justify-between h-14">
              <a href="/" class="flex items-center gap-2 group" id="site-logo">
                <span class="w-8 h-8 rounded-lg bg-gradient-to-br from-amber-400 via-fuchsia-500 to-sky-500 grid place-items-center shrink-0">
                  <i class="fas fa-book-open text-slate-900 text-sm"></i>
                </span>
                <span class="leading-tight">
                  <span class="block text-sm font-bold group-hover:text-amber-300 transition">
                    非公式カードデータベース
                  </span>
                  <span class="block text-[10px] text-slate-400">
                    ディズニー・ロルカナTCG 日本語版 ファンサイト
                  </span>
                </span>
              </a>
              <nav class="flex items-center gap-1 text-sm" id="main-nav">
                <a
                  href="/"
                  class={`px-3 py-1.5 rounded-md transition ${nav === 'search' ? 'bg-slate-700 text-white' : 'text-slate-300 hover:bg-slate-800'}`}
                >
                  <i class="fas fa-magnifying-glass mr-1"></i>
                  <span class="hidden sm:inline">カード検索</span>
                </a>
                <a
                  href="/deck"
                  class={`px-3 py-1.5 rounded-md transition ${nav === 'deck' ? 'bg-slate-700 text-white' : 'text-slate-300 hover:bg-slate-800'}`}
                >
                  <i class="fas fa-layer-group mr-1"></i>
                  <span class="hidden sm:inline">デッキ</span>
                </a>
                <a
                  href="/synergy"
                  class={`px-3 py-1.5 rounded-md transition ${nav === 'synergy' ? 'bg-slate-700 text-white' : 'text-slate-300 hover:bg-slate-800'}`}
                >
                  <i class="fas fa-diagram-project mr-1"></i>
                  <span class="hidden sm:inline">シナジー</span>
                </a>
                <a
                  href="/rules"
                  class={`px-3 py-1.5 rounded-md transition ${nav === 'rules' ? 'bg-slate-700 text-white' : 'text-slate-300 hover:bg-slate-800'}`}
                >
                  <i class="fas fa-scale-balanced mr-1"></i>
                  <span class="hidden sm:inline">ルール</span>
                </a>
                <a
                  href="/favorites"
                  class={`px-3 py-1.5 rounded-md transition ${nav === 'favorites' ? 'bg-slate-700 text-white' : 'text-slate-300 hover:bg-slate-800'}`}
                >
                  <i class="fas fa-star mr-1"></i>
                  <span class="hidden sm:inline">お気に入り</span>
                </a>
              </nav>
            </div>
          </div>
        </header>

        <main class="flex-1">{children}</main>

        {/* BUILD_SPEC §0-5: 免責・権利表記は必須 */}
        <footer class="mt-12 border-t border-slate-800 bg-slate-900/60" id="site-footer">
          <div class="max-w-7xl mx-auto px-4 py-8 text-xs text-slate-400 space-y-3">
            <p class="font-semibold text-slate-300">
              <i class="fas fa-circle-info mr-1"></i>
              このサイトはファンが制作した<strong class="text-amber-300">非公式ファンサイト</strong>です。
              権利者による公式サイトではありません。
            </p>
            <p>
              © Disney / Operated by Ravensburger。
              ディズニー・ロルカナTCG に関する著作権・商標はディズニー社および
              Ravensburger 社に帰属します。日本語版は株式会社タカラトミーが取り扱っています。
            </p>
            <p>
              カード画像・イラスト・カード名などの権利者著作物は当サイトでは配布しておらず、
              画像はすべて<strong class="text-slate-300">公式サーバ上の画像を直接参照</strong>して表示しています。
              効果テキストは事実データとして参照目的で掲載しています。
              公式ルール文書の本文は全文掲載せず、該当箇所の抜粋と公式PDFへのリンクのみを提供します。
            </p>
            <p class="flex flex-wrap gap-x-4 gap-y-1 pt-2 border-t border-slate-800">
              <a
                href="https://www.takaratomy.co.jp/products/disneylorcana/"
                target="_blank"
                rel="noopener noreferrer"
                class="text-sky-400 hover:text-sky-300 underline"
              >
                <i class="fas fa-external-link-alt mr-1"></i>
                タカラトミー公式サイトはこちら
              </a>
              <a
                href="https://www.takaratomy.co.jp/products/disneylorcana/cardlist/"
                target="_blank"
                rel="noopener noreferrer"
                class="text-sky-400 hover:text-sky-300 underline"
              >
                公式カードリスト
              </a>
              <a
                href="https://www.takaratomy.co.jp/products/disneylorcana/rule-faq/"
                target="_blank"
                rel="noopener noreferrer"
                class="text-sky-400 hover:text-sky-300 underline"
              >
                公式ルール・FAQ
              </a>
              <a href="/about" class="text-slate-400 hover:text-slate-200 underline">
                このサイトについて
              </a>
            </p>
          </div>
        </footer>

        <script src="/static/icons.js"></script>
        <script src="/static/app.js"></script>
        <script src="/static/page-search.js"></script>
        <script src="/static/page-card.js"></script>
        <script src="/static/page-deck.js"></script>
        <script src="/static/page-synergy.js"></script>
        <script src="/static/page-rules.js"></script>
        <script src="/static/page-misc.js"></script>
      </body>
    </html>
  );
});
