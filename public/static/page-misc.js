/**
 * page-misc.js — お気に入りページ / このサイトについて（統計）
 */
window.initFavoritesPage = function () {
  const A = window.LorApp;
  const { $, esc, apiPost, favorites, cardTile } = A;

  async function render() {
    const files = favorites.all();
    if (!files.length) {
      $('#favorites-result').innerHTML =
        `<div class="text-center py-14 text-slate-400">
           <i class="fas fa-star block text-3xl mb-3 opacity-30"></i>
           <p class="text-sm">お気に入りはまだありません。</p>
           <a href="/" class="inline-block mt-3 px-4 py-2 bg-sky-600 hover:bg-sky-500 rounded text-sm font-semibold">
             カードを探す
           </a>
         </div>`;
      return;
    }

    $('#favorites-result').innerHTML =
      '<div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">' +
      '<div class="card-thumb skeleton rounded-lg"></div>'.repeat(Math.min(files.length, 10)) +
      '</div>';

    const data = await apiPost('/api/cards/by-files', { files });
    // お気に入り登録順を維持
    const byFile = {};
    for (const c of data.cards) byFile[c.card_file] = c;
    const ordered = files.map((f) => byFile[f]).filter(Boolean);

    $('#favorites-result').innerHTML =
      `<div class="flex items-center justify-between mb-3">
         <p class="text-xs text-slate-400">${ordered.length} 枚</p>
         <button id="fav-clear" class="text-xs px-3 py-1.5 bg-slate-800 hover:bg-rose-900 rounded">
           <i class="fas fa-trash mr-1"></i>すべて解除
         </button>
       </div>
       <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
         ${ordered.map((c) => cardTile(c, { compareButton: false })).join('')}
       </div>`;

    $('#fav-clear').addEventListener('click', () => {
      if (confirm('お気に入りをすべて解除しますか？')) {
        localStorage.removeItem('lorfan.favorites');
        render();
      }
    });
  }

  // お気に入り解除時にリストからも消す
  document.addEventListener('click', (e) => {
    if (e.target.closest('.js-fav')) setTimeout(render, 60);
  });

  render();
};

window.initAboutPage = function () {
  const A = window.LorApp;
  const { $, esc, apiGet } = A;
  (async function () {
    try {
      const m = await apiGet('/api/masters');
      const total = (m.card_types || []).reduce((s, x) => s + x.n, 0);
      $('#about-stats').innerHTML =
        `<p><strong class="text-slate-200">${total.toLocaleString()}</strong> 枚のカードを収録
          （${(m.sets || []).length} セット / ${(m.classifications || []).length} 種族 /
          ${(m.abilities || []).length} キーワード能力）</p>
         ${m.meta && m.meta.imported_at
           ? `<p class="mt-1">データ取得日時: ${esc(String(m.meta.imported_at).replace('T', ' ').slice(0, 16))} UTC</p>`
           : ''}`;
    } catch { /* 統計なしでも問題なし */ }
  })();
};
