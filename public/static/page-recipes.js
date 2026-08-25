/**
 * page-recipes.js — 収集したデッキレシピ（/recipes）
 *
 * もとは page-deck.js の後半（デッキビルダーと同一ページ）に同居していた。
 * ビルダーは「自分で組む」ための編集画面、レシピは「他人の構築を読む」ための
 * 閲覧画面で、利用目的も滞在の仕方も違う。同じ画面に縦積みすると
 * ビルダーを使いたい人が長いレシピ一覧をスクロールで跨ぐことになり、
 * レシピを見たい人はビルダーの読み込みを待たされる。そのため画面を分離した。
 *
 *  - API 側で jp_only=1 が既定なので、日本で組めないレシピはそもそも返らない
 *  - まとめ本文と違い、ここでは出典URLを必ず表示する（仕様§1.3の明示的な例外）
 *  - カード名は自前DBの日本語名（card_group 優先）で表示する
 */
window.initRecipesPage = function () {
  const A = window.LorApp;
  const { $, $$, esc, apiGet, store } = A;
  // ビルダーと共有する localStorage キー。「ビルダーに読み込む」で書き込む先。
  // page-deck.js 側の DECK_KEY と必ず一致させること（片方だけ変えると引き継ぎが壊れる）
  const DECK_KEY = 'lorfan.deck';

  // ---------- 収集したデッキレシピ（#meta-recipes / 仕様§1.3 の出典明記例外） ----------

  /**
   * 環境情報収集で取り込んだレシピの一覧。
   *
   * ・API 側で jp_only=1 が既定なので、日本で組めないレシピはそもそも返らない
   * ・まとめ本文と違い、ここでは出典URLを必ず表示する（仕様§1.3の明示的な例外）
   * ・カード名は自前DBの日本語名（card_group 優先）で表示される
   */
  const RECIPE_PAGE = 6;
  let recipeState = { offset: 0, total: 0, ink: '', loading: false };

  function recipeCardRow(c) {
    // マッチしなかったカードは画像もリンクも出さず、原文名のみを控えめに表示する
    if (!c.matched) {
      return (
        `<li class="flex items-center gap-2 py-1 text-xs text-slate-500">` +
        `<span class="w-6 text-right font-mono">${c.qty}</span>` +
        `<span class="italic">${esc(c.raw_name || c.card_name || '不明なカード')}</span>` +
        `<span class="text-[9px] px-1 rounded bg-slate-800 border border-slate-700">未突合</span></li>`
      );
    }
    const img = c.image_url
      ? `<img src="${esc(c.image_url)}" alt="" loading="lazy" decoding="async"` +
        ` referrerpolicy="no-referrer-when-downgrade"` +
        ` class="w-8 h-11 object-cover rounded shrink-0 bg-slate-800">`
      : '<span class="w-8 h-11 rounded shrink-0 bg-slate-800"></span>';
    const cost = c.ink_cost != null
      ? `<span class="text-[10px] text-slate-500 shrink-0">${c.ink_cost}コスト</span>` : '';
    return (
      `<li class="flex items-center gap-2 py-1">` +
      `<span class="w-6 text-right font-mono text-xs text-amber-300 shrink-0">${c.qty}</span>` +
      img +
      `<a href="/card/${encodeURIComponent(c.card_file || '')}"` +
      ` class="text-xs text-slate-200 hover:text-amber-300 leading-tight flex-1 min-w-0 truncate">` +
      `${esc(c.name || c.card_name)}</a>` + cost +
      `</li>`
    );
  }

  async function showRecipeDetail(id) {
    const box = $('#meta-recipe-detail');
    if (!box) return;
    box.innerHTML =
      '<p class="text-sm text-slate-400 py-4"><i class="fas fa-spinner fa-spin mr-2"></i>レシピを読み込んでいます…</p>';
    let d;
    try {
      d = await apiGet(`/api/meta/decks/${encodeURIComponent(id)}`);
    } catch (e) {
      box.innerHTML = `<p class="text-sm text-rose-300 py-3">レシピを読み込めませんでした（${esc(e.message || 'error')}）</p>`;
      return;
    }
    const dk = d.deck || {};
    const M = window.LorMeta;
    const inks = M ? [dk.ink1, dk.ink2].filter(Boolean).map(M.inkChip).join(' ') : '';
    const cards = d.cards || [];
    const half = Math.ceil(cards.length / 2);

    // 出典は必ず明記する（§1.3 例外）。nofollow を付けて SEO 上の関係を持たせない
    const src = dk.source_url
      ? `<a href="${esc(dk.source_url)}" target="_blank" rel="noopener noreferrer nofollow"` +
        ` class="text-xs text-sky-400 hover:text-sky-300 underline break-all">` +
        `出典: ${esc(dk.source_label || dk.source_url)}<i class="fas fa-external-link-alt ml-1 text-[9px]"></i></a>`
      : '<span class="text-xs text-slate-500">出典情報なし</span>';

    const missing = (dk.missing_cards || []).length
      ? `<p class="mt-2 text-[11px] text-amber-300"><i class="fas fa-triangle-exclamation mr-1"></i>` +
        `日本未収録の可能性があるカード: ${dk.missing_cards.map(esc).join('、')}</p>`
      : '';

    box.innerHTML =
      `<article class="bg-slate-900 border border-sky-800/60 rounded-lg p-4">` +
      `<div class="flex items-start justify-between gap-3 mb-2">` +
      `<div><h3 class="text-base font-bold text-slate-100">${esc(dk.name || 'デッキ')}</h3>` +
      `<p class="text-xs text-slate-400 mt-0.5">` +
      (dk.player ? `${esc(dk.player)} ・ ` : '') +
      (dk.event_name ? `${esc(dk.event_name)} ・ ` : '') +
      (dk.placement ? `${esc(dk.placement)} ・ ` : '') +
      `${esc(dk.observed_at || '')} ・ 合計${d.total_qty}枚</p>` +
      `<p class="mt-1">${inks}</p></div>` +
      `<button type="button" id="meta-recipe-close"` +
      ` class="text-slate-400 hover:text-slate-200 shrink-0" aria-label="閉じる">` +
      `<i class="fas fa-times"></i></button></div>` +
      `<div class="grid gap-x-6 sm:grid-cols-2 mt-3 border-t border-slate-800 pt-2">` +
      `<ul class="divide-y divide-slate-800/60">${cards.slice(0, half).map(recipeCardRow).join('')}</ul>` +
      `<ul class="divide-y divide-slate-800/60">${cards.slice(half).map(recipeCardRow).join('')}</ul>` +
      `</div>${missing}` +
      `<div class="mt-3 pt-2 border-t border-slate-800 flex flex-wrap items-center gap-3">` +
      src +
      `<button type="button" id="meta-recipe-load"` +
      ` class="ml-auto px-3 py-1.5 rounded bg-sky-700 hover:bg-sky-600 text-white text-xs font-semibold">` +
      `<i class="fas fa-download mr-1"></i>ビルダーに読み込む</button></div>` +
      `</article>`;

    $('#meta-recipe-close').addEventListener('click', () => { box.innerHTML = ''; });
    $('#meta-recipe-load').addEventListener('click', () => {
      /*
       * ビルダーが別ページになったので、その場の変数を書き換えるのではなく
       * localStorage（ビルダーと同じ 'lorfan.deck' キー）へ保存してから遷移する。
       * ビルダーは起動時にこのキーを読むので、これだけで内容が引き継がれる。
       *
       * 現在の編集内容を上書きするため、空でないときは必ず確認を取る。
       * レシピを見に来ただけで作業中のデッキが消えるのは事故になる。
       */
      const ok = cards.filter((c) => c.matched && c.card_file);
      if (!ok.length) {
        alert('このレシピはカードDBと突合できたカードがないため読み込めません。');
        return;
      }
      const current = store.get(DECK_KEY, {});
      if (Object.keys(current).length) {
        const total = Object.values(current).reduce((s, e) => s + (e.count || 0), 0);
        if (!confirm(`ビルダーで編集中のデッキ（${total}枚）を破棄して、このレシピを読み込みます。よろしいですか？`)) return;
      }

      const next = {};
      for (const c of ok) {
        next[c.card_file] = {
          card: {
            card_file: c.card_file, card_name: c.card_name, card_group: c.name,
            image_url: c.image_url, ink_cost: c.ink_cost, ink_color: c.ink_color,
            card_type: c.card_type, rarity: c.rarity, lore_value: c.lore_value,
          },
          count: c.qty,
        };
      }
      store.set(DECK_KEY, next);

      const skipped = cards.length - ok.length;
      if (skipped > 0) {
        alert(`${ok.length}種類を読み込みました。${skipped}種類はカードDBと突合できず除外しました。\nデッキビルドタブへ移動します。`);
      }
      location.href = '/deck';
    });
    box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  async function loadRecipes(append) {
    const list = $('#meta-recipes-list');
    const more = $('#meta-recipes-more');
    if (!list || recipeState.loading) return;
    recipeState.loading = true;
    if (!append) {
      recipeState.offset = 0;
      list.innerHTML = '<p class="text-sm text-slate-500 col-span-full py-3"><i class="fas fa-spinner fa-spin mr-2"></i>読み込み中…</p>';
    }

    let d;
    try {
      const q = new URLSearchParams({
        jp_only: '1', limit: String(RECIPE_PAGE), offset: String(recipeState.offset),
      });
      if (recipeState.ink) q.set('ink', recipeState.ink);
      d = await apiGet('/api/meta/decks?' + q.toString());
    } catch {
      list.innerHTML = '<p class="text-sm text-slate-500 col-span-full py-3">レシピを読み込めませんでした。</p>';
      recipeState.loading = false;
      return;
    }

    recipeState.total = d.total || 0;
    const M = window.LorMeta;
    const html = (d.decks || [])
      .map((dk) => (M ? M.deckCardHtml(dk) : `<div class="text-xs text-slate-300">${esc(dk.name || '')}</div>`))
      .join('');

    if (append) list.insertAdjacentHTML('beforeend', html);
    else list.innerHTML = html || (
      '<p class="text-sm text-slate-500 col-span-full py-4">' +
      '<i class="fas fa-inbox mr-2"></i>まだレシピがありません。環境情報の収集後（毎日22:00 JST）に表示されます。</p>'
    );

    recipeState.offset += (d.decks || []).length;
    if (more) {
      more.innerHTML =
        recipeState.offset < recipeState.total
          ? `<button type="button" id="meta-recipes-more-btn"` +
            ` class="px-3 py-1.5 rounded border border-slate-700 text-slate-300 hover:bg-slate-800 text-xs">` +
            `さらに表示（残り${recipeState.total - recipeState.offset}件）</button>`
          : recipeState.total > 0
            ? `<p class="text-[11px] text-slate-500">全${recipeState.total}件を表示しました</p>`
            : '';
      const btn = $('#meta-recipes-more-btn');
      if (btn) btn.addEventListener('click', () => loadRecipes(true));
    }
    recipeState.loading = false;
  }

  function initRecipes() {
    const fl = $('#meta-recipes-filters');
    if (!fl) return;
    const inks = A.INK_COLORS || ['アンバー', 'アメジスト', 'エメラルド', 'ルビー', 'サファイア', 'スティール'];
    fl.innerHTML =
      `<button type="button" data-ink="" class="meta-ink-btn px-2.5 py-1 rounded-full text-xs border border-sky-600 bg-sky-900/50 text-sky-200">すべて</button>` +
      inks
        .map(
          (i) =>
            `<button type="button" data-ink="${esc(i)}" class="meta-ink-btn px-2.5 py-1 rounded-full text-xs border border-slate-700 text-slate-300 hover:bg-slate-800">${esc(i)}</button>`
        )
        .join('');
    fl.addEventListener('click', (ev) => {
      const b = ev.target.closest('.meta-ink-btn');
      if (!b) return;
      recipeState.ink = b.dataset.ink || '';
      $$('.meta-ink-btn', fl).forEach((x) => {
        const on = x === b;
        x.className =
          'meta-ink-btn px-2.5 py-1 rounded-full text-xs border ' +
          (on ? 'border-sky-600 bg-sky-900/50 text-sky-200' : 'border-slate-700 text-slate-300 hover:bg-slate-800');
      });
      loadRecipes(false);
    });

    // 一覧の見出しは ?meta=<id> へのリンク。ページ遷移させずその場で開く
    const list = $('#meta-recipes-list');
    if (list) {
      list.addEventListener('click', (ev) => {
        const a = ev.target.closest('a[href*="meta="]');
        if (!a) return;
        const id = new URL(a.href, location.origin).searchParams.get('meta');
        if (!id) return;
        ev.preventDefault();
        showRecipeDetail(id);
      });
    }

    loadRecipes(false);

    // 帰属表示（利用規約で可視クレジットが必須のデータ提供元）。
    // page-meta.js が先に読み込まれていれば window.LorMeta.renderCredits が使える。
    try {
      window.LorMeta?.renderCredits?.('meta-credits');
    } catch (_) { /* クレジット欄は表示できなくても本体は動かす */ }

    // /recipes?meta=<id> で直接開かれた場合（最新環境ページからの遷移など）
    const want = new URLSearchParams(location.search).get('meta');
    if (want) {
      showRecipeDetail(want);
      document.getElementById('meta-recipes')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  // ---------- 起動 ----------
  initRecipes();
};
