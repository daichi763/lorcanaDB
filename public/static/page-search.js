/**
 * page-search.js — カード検索ページ（BUILD_SPEC §7）
 *
 * 公式サイトのフォーム項目を漏れなく再現し、以下を追加:
 *  1. 効果テキスト内の他カード参照検索（シナジー発見）
 *  2. 能力タグクラウド
 *  3. カード比較モード（最大4枚）
 *  4. 鑑賞モード（lightbox / app.js 側）
 *  5. お気に入り（LocalStorage / app.js 側）
 */
window.initSearchPage = function () {
  const A = window.LorApp;
  const { $, $$, esc, debounce, apiGet, apiPost, cardTile, cardRow, store } = A;

  let masters = null;
  let viewMode = store.get('lorfan.viewMode', 'grid');
  let compare = [];
  const state = {
    freeword: '',
    freeword_field: ['カード名', 'バージョン名', '読み', 'クラス', 'テキスト'],
    ink_type: 'すべて',
    ink_color: [],
    card_type: [],
    classification: [],
    classification_mode: 'or',
    rarity: [],
    ability: [],
    sets: [],
    inkwell: [],
    refs_classification: [],
    ink_cost_min: undefined, ink_cost_max: undefined,
    strength_min: undefined, strength_max: undefined,
    willpower_min: undefined, willpower_max: undefined,
    lore_value_min: undefined, lore_value_max: undefined,
    move_cost_min: undefined, move_cost_max: undefined,
    search_sort: 'リリース順',
    posts_per_page: 50,
    page: 1,
  };

  // ---------- URL 同期 ----------
  function stateToUrl() {
    const p = new URLSearchParams();
    if (state.freeword) p.set('q', state.freeword);
    const arrKeys = ['ink_color', 'card_type', 'classification', 'rarity', 'ability', 'sets', 'inkwell', 'refs_classification'];
    for (const k of arrKeys) if (state[k].length) p.set(k, state[k].join(','));
    if (state.ink_type !== 'すべて') p.set('ink_type', state.ink_type);
    if (state.classification_mode === 'and') p.set('cmode', 'and');
    for (const k of ['ink_cost', 'strength', 'willpower', 'lore_value', 'move_cost']) {
      if (state[k + '_min'] !== undefined) p.set(k + '_min', state[k + '_min']);
      if (state[k + '_max'] !== undefined) p.set(k + '_max', state[k + '_max']);
    }
    if (state.search_sort !== 'リリース順') p.set('sort', state.search_sort);
    if (state.posts_per_page !== 50) p.set('per', state.posts_per_page);
    if (state.page > 1) p.set('page', state.page);
    const qs = p.toString();
    history.replaceState(null, '', qs ? '?' + qs : location.pathname);
  }

  function urlToState() {
    const p = new URLSearchParams(location.search);
    if (p.get('q')) state.freeword = p.get('q');
    const arrKeys = ['ink_color', 'card_type', 'classification', 'rarity', 'ability', 'sets', 'inkwell', 'refs_classification'];
    for (const k of arrKeys) {
      const v = p.get(k);
      if (v) state[k] = v.split(',').filter(Boolean);
    }
    if (p.get('ink_type')) state.ink_type = p.get('ink_type');
    if (p.get('cmode') === 'and') state.classification_mode = 'and';
    for (const k of ['ink_cost', 'strength', 'willpower', 'lore_value', 'move_cost']) {
      const mn = p.get(k + '_min'), mx = p.get(k + '_max');
      if (mn !== null && mn !== '') state[k + '_min'] = Number(mn);
      if (mx !== null && mx !== '') state[k + '_max'] = Number(mx);
    }
    if (p.get('sort')) state.search_sort = p.get('sort');
    if (p.get('per')) state.posts_per_page = Number(p.get('per'));
    if (p.get('page')) state.page = Number(p.get('page'));
  }

  // ---------- フィルタUI ----------
  function chipGroup(name, values, selected, opts) {
    opts = opts || {};
    return values
      .map((v) => {
        const val = typeof v === 'object' ? v.v : v;
        const cnt = typeof v === 'object' ? v.n : null;
        const on = selected.indexOf(val) >= 0;
        return (
          `<label class="chip-check">
             <input type="checkbox" data-group="${name}" value="${esc(val)}" ${on ? 'checked' : ''}>
             <span>${esc(val)}${cnt != null && opts.showCount ? ` <em class="not-italic opacity-60">${cnt}</em>` : ''}</span>
           </label>`
        );
      })
      .join('');
  }

  function rangeRow(label, key, max, unit) {
    const mn = state[key + '_min'], mx = state[key + '_max'];
    return (
      `<div class="flex items-center gap-1.5 text-[11px]">
         <span class="w-14 shrink-0 text-slate-400">${esc(label)}</span>
         <input type="number" min="0" max="${max}" placeholder="下限" value="${mn ?? ''}"
                data-range="${key}_min" class="w-14 bg-slate-800 border border-slate-600 rounded px-1.5 py-1 text-center">
         <span class="text-slate-500">〜</span>
         <input type="number" min="0" max="${max}" placeholder="上限" value="${mx ?? ''}"
                data-range="${key}_max" class="w-14 bg-slate-800 border border-slate-600 rounded px-1.5 py-1 text-center">
         <span class="text-slate-600">${unit || ''}</span>
       </div>`
    );
  }

  function section(title, inner, opts) {
    opts = opts || {};
    return (
      `<details class="bg-slate-900 rounded-lg border border-slate-700" ${opts.open ? 'open' : ''}>
         <summary class="px-3 py-2 cursor-pointer text-xs font-bold text-slate-300 select-none">${esc(title)}</summary>
         <div class="px-3 pb-3 pt-1">${inner}</div>
       </details>`
    );
  }

  function renderFilters() {
    const setsOpts = (masters.sets || []).map((s) => ({ v: s.v, n: s.n }));
    const classOpts = (masters.classifications || []).map((s) => ({ v: s.v, n: s.n }));
    const abilityOpts = (masters.abilities || []).map((s) => ({ v: s.v, n: s.n }));
    const refOpts = (masters.referenced_classifications || []).map((s) => ({ v: s.v, n: s.n }));

    const html =
      `<div class="bg-slate-900 rounded-lg border border-slate-700 p-3 space-y-2">
         <label for="freeword" class="block text-xs font-bold text-slate-300">フリーワード</label>
         <input id="freeword" type="search" value="${esc(state.freeword)}"
                placeholder="カード名・効果テキスト…"
                class="w-full bg-slate-800 border border-slate-600 rounded px-2.5 py-2 text-sm">
         <div class="flex flex-wrap gap-1 pt-1">
           ${chipGroup('freeword_field', A.FREEWORD_FIELDS, state.freeword_field)}
         </div>
       </div>` +

      section('インク色 / 種別',
        `<div class="space-y-2">
           <div class="flex flex-wrap gap-1">${chipGroup('ink_color', A.INK_COLORS, state.ink_color)}</div>
           <div class="flex items-center gap-1.5 text-[11px]">
             <span class="text-slate-400">インク</span>
             ${['すべて', 'シングル', 'デュアル'].map((v) =>
               `<label class="chip-check"><input type="radio" name="ink_type" data-radio="ink_type" value="${v}" ${state.ink_type === v ? 'checked' : ''}><span>${v}</span></label>`
             ).join('')}
           </div>
         </div>`, { open: true }) +

      section('カード種類',
        `<div class="flex flex-wrap gap-1">${chipGroup('card_type', A.CARD_TYPES, state.card_type)}</div>`, { open: true }) +

      section('レアリティ',
        `<div class="flex flex-wrap gap-1">${chipGroup('rarity', A.RARITIES, state.rarity)}</div>`) +

      section('クラス（種族）',
        `<div class="flex items-center gap-2 mb-2 text-[11px]">
           <span class="text-slate-400">複数指定</span>
           <label class="chip-check"><input type="radio" name="cmode" data-radio="classification_mode" value="or" ${state.classification_mode === 'or' ? 'checked' : ''}><span>OR（いずれか）</span></label>
           <label class="chip-check"><input type="radio" name="cmode" data-radio="classification_mode" value="and" ${state.classification_mode === 'and' ? 'checked' : ''}><span>AND（すべて）</span></label>
         </div>
         <div class="flex flex-wrap gap-1 max-h-40 overflow-y-auto thin-scroll">
           ${chipGroup('classification', classOpts, state.classification, { showCount: true })}
         </div>`) +

      section('キーワード能力',
        `<p class="text-[10px] text-slate-500 mb-1.5">公式ルール第8章のキーワード能力で絞り込みます。</p>
         <div class="flex flex-wrap gap-1">${chipGroup('ability', abilityOpts, state.ability, { showCount: true })}</div>`) +

      section('効果テキストが参照する種族 ★',
        `<p class="text-[10px] text-slate-500 mb-1.5">
           「〇〇（種族）を参照する効果を持つカード」を逆引きします。デッキの軸探しに。
           <a href="/synergy" class="text-sky-400 underline">シナジー探索へ</a>
         </p>
         <div class="flex flex-wrap gap-1 max-h-32 overflow-y-auto thin-scroll">
           ${chipGroup('refs_classification', refOpts, state.refs_classification, { showCount: true })}
         </div>`) +

      section('数値',
        `<div class="space-y-1.5">
           ${rangeRow('インク', 'ink_cost', 10)}
           ${rangeRow('攻撃力', 'strength', 10)}
           ${rangeRow('意志力', 'willpower', 10)}
           ${rangeRow('ロア', 'lore_value', 5)}
           ${rangeRow('移動', 'move_cost', 3)}
           <div class="flex flex-wrap gap-1 pt-1">
             ${chipGroup('inkwell', ['インク可能', 'インク不可能'], state.inkwell)}
           </div>
         </div>`) +

      section('収録セット',
        `<div class="flex flex-wrap gap-1 max-h-48 overflow-y-auto thin-scroll">
           ${chipGroup('sets', setsOpts, state.sets, { showCount: true })}
         </div>`) +

      `<div class="flex gap-2">
         <button id="btn-search" class="flex-1 py-2 bg-sky-600 hover:bg-sky-500 rounded text-sm font-bold">
           <i class="fas fa-magnifying-glass mr-1"></i>検索
         </button>
         <button id="btn-reset" class="px-3 py-2 bg-slate-700 hover:bg-slate-600 rounded text-sm">
           <i class="fas fa-rotate-left"></i>
         </button>
       </div>`;

    const desktop = $('#filter-panel');
    if (desktop) desktop.innerHTML = html;
    const mobile = $('#filter-mount-mobile');
    if (mobile) mobile.innerHTML = `<div class="p-3 space-y-2">${html}</div>`;
    bindFilters();
  }

  function bindFilters() {
    $$('input[data-group]').forEach((el) => {
      el.addEventListener('change', () => {
        const g = el.dataset.group;
        const v = el.value;
        const i = state[g].indexOf(v);
        if (el.checked) { if (i < 0) state[g].push(v); }
        else if (i >= 0) state[g].splice(i, 1);
        // 同じグループの別インスタンス（PC/モバイル）を同期
        $$(`input[data-group="${g}"][value="${CSS.escape(v)}"]`).forEach((o) => (o.checked = el.checked));
      });
    });
    $$('input[data-radio]').forEach((el) => {
      el.addEventListener('change', () => {
        if (el.checked) state[el.dataset.radio] = el.value;
      });
    });
    $$('input[data-range]').forEach((el) => {
      el.addEventListener('change', () => {
        const k = el.dataset.range;
        state[k] = el.value === '' ? undefined : Number(el.value);
        $$(`input[data-range="${k}"]`).forEach((o) => (o.value = el.value));
      });
    });
    $$('#freeword').forEach((el) => {
      el.addEventListener('input', () => { state.freeword = el.value; });
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { state.page = 1; runSearch(); }
      });
    });
    $$('#btn-search').forEach((b) => b.addEventListener('click', () => { state.page = 1; runSearch(); }));
    $$('#btn-reset').forEach((b) =>
      b.addEventListener('click', () => {
        location.href = location.pathname;
      })
    );
  }

  // ---------- 検索実行 ----------
  function skeleton() {
    const cell = '<div class="bg-slate-900 rounded-lg border border-slate-700 overflow-hidden"><div class="card-thumb skeleton"></div><div class="p-2 space-y-1.5"><div class="h-3 skeleton rounded"></div><div class="h-2 w-2/3 skeleton rounded"></div></div></div>';
    $('#results').innerHTML =
      `<div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">${cell.repeat(10)}</div>`;
  }

  async function runSearch() {
    skeleton();
    stateToUrl();
    let data;
    try {
      data = await apiPost('/api/cards/search', state);
    } catch (e) {
      $('#results').innerHTML =
        `<div class="p-6 text-center text-rose-300 bg-rose-950/30 border border-rose-800 rounded-lg">
           検索に失敗しました: ${esc(e.message)}</div>`;
      return;
    }

    $('#result-count').textContent = `${data.count.toLocaleString()} 件`;

    if (!data.cards.length) {
      $('#results').innerHTML =
        `<div class="p-10 text-center text-slate-400">
           <i class="fas fa-inbox text-3xl mb-3 block opacity-40"></i>
           条件に一致するカードがありません。
         </div>`;
      $('#pager').innerHTML = '';
      return;
    }

    if (viewMode === 'grid') {
      $('#results').innerHTML =
        `<div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
           ${data.cards.map((c) => cardTile(c, { compareButton: true })).join('')}
         </div>`;
    } else {
      $('#results').innerHTML = `<div class="space-y-2">${data.cards.map(cardRow).join('')}</div>`;
    }

    renderPager(data);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function renderPager(data) {
    const total = data.total_pages;
    const cur = data.page;
    if (total <= 1) { $('#pager').innerHTML = ''; return; }
    const btn = (p, label, active) =>
      `<button data-page="${p}" class="px-3 py-1.5 rounded text-xs ${active ? 'bg-sky-600 font-bold' : 'bg-slate-800 hover:bg-slate-700'}">${label}</button>`;

    const parts = [];
    if (cur > 1) parts.push(btn(cur - 1, '<i class="fas fa-chevron-left"></i>'));
    const win = 2;
    const from = Math.max(1, cur - win);
    const to = Math.min(total, cur + win);
    if (from > 1) { parts.push(btn(1, '1')); if (from > 2) parts.push('<span class="px-1 text-slate-600">…</span>'); }
    for (let p = from; p <= to; p++) parts.push(btn(p, String(p), p === cur));
    if (to < total) { if (to < total - 1) parts.push('<span class="px-1 text-slate-600">…</span>'); parts.push(btn(total, String(total))); }
    if (cur < total) parts.push(btn(cur + 1, '<i class="fas fa-chevron-right"></i>'));

    $('#pager').innerHTML = `<div class="flex flex-wrap items-center gap-1.5">${parts.join('')}</div>`;
    $$('#pager button').forEach((b) =>
      b.addEventListener('click', () => { state.page = Number(b.dataset.page); runSearch(); })
    );
  }

  // ---------- カード比較モード（最大4枚 / §7-3）----------
  function renderCompare() {
    const tray = $('#compare-tray');
    if (!compare.length) { tray.classList.add('hidden'); tray.innerHTML = ''; return; }
    tray.classList.remove('hidden');
    tray.innerHTML =
      `<div class="flex items-center justify-between mb-2">
         <span class="text-xs font-bold text-sky-300">
           <i class="fas fa-code-compare mr-1"></i>比較 ${compare.length}/4
         </span>
         <div class="flex gap-1.5">
           <button id="compare-open" class="px-2.5 py-1 bg-sky-600 hover:bg-sky-500 rounded text-[11px] font-semibold">並べて見る</button>
           <button id="compare-clear" class="px-2.5 py-1 bg-slate-700 hover:bg-slate-600 rounded text-[11px]">クリア</button>
         </div>
       </div>
       <div class="flex gap-2 overflow-x-auto thin-scroll">
         ${compare.map((c, i) =>
           `<div class="w-16 shrink-0 relative">
              <img src="${esc(c.image_url)}" alt="${esc(c.card_name)}" loading="lazy" class="w-full rounded border border-slate-600">
              <button data-ci="${i}" class="compare-del absolute -top-1 -right-1 w-5 h-5 rounded-full bg-rose-700 text-white text-[10px] grid place-items-center" aria-label="削除">×</button>
            </div>`
         ).join('')}
       </div>`;

    $('#compare-clear').addEventListener('click', () => { compare = []; renderCompare(); });
    $('#compare-open').addEventListener('click', openCompareModal);
    $$('.compare-del').forEach((b) =>
      b.addEventListener('click', () => { compare.splice(Number(b.dataset.ci), 1); renderCompare(); })
    );
  }

  function openCompareModal() {
    const cols = compare.map((c) =>
      `<div class="flex-1 min-w-[180px] bg-slate-900 rounded-lg border border-slate-700 p-2.5 space-y-2">
         <img src="${esc(c.image_url)}" alt="${esc(c.card_name)}" loading="lazy" class="w-full rounded">
         <div>
           <div class="font-bold text-sm">${esc(c.card_name)}</div>
           ${c.version ? `<div class="text-[11px] text-slate-400">${esc(c.version)}</div>` : ''}
         </div>
         <div class="text-[11px] space-y-0.5">
           <div class="flex justify-between"><span class="text-slate-500">インク</span><span>${esc(c.ink_color)}${c.ink_color2 ? '/' + esc(c.ink_color2) : ''}</span></div>
           <div class="flex justify-between"><span class="text-slate-500">コスト</span><span>${c.ink_cost ?? '-'}</span></div>
           <div class="flex justify-between"><span class="text-slate-500">攻/意</span><span>${c.strength ?? '-'} / ${c.willpower ?? '-'}</span></div>
           <div class="flex justify-between"><span class="text-slate-500">ロア</span><span>${c.lore_value ?? '-'}</span></div>
           <div class="flex justify-between"><span class="text-slate-500">種別</span><span>${esc(c.card_type)}</span></div>
           <div class="flex justify-between"><span class="text-slate-500">インク化</span><span>${c.inkwell === 'y' ? '可' : '不可'}</span></div>
           <div class="flex justify-between gap-2"><span class="text-slate-500 shrink-0">種族</span><span class="text-right">${(c.classifications || []).map(esc).join('・') || '-'}</span></div>
         </div>
         <div class="rules-text text-[11px] text-slate-300 pt-1.5 border-t border-slate-700">${A.renderRulesText(c.rules_text) || '<span class="text-slate-600">（効果なし）</span>'}</div>
       </div>`
    ).join('');

    const modal = document.createElement('div');
    modal.className = 'fixed inset-0 z-[90] bg-slate-950/95 overflow-y-auto p-4';
    modal.innerHTML =
      `<div class="max-w-6xl mx-auto">
         <div class="flex items-center justify-between mb-3 sticky top-0 bg-slate-950/95 py-2">
           <h2 class="font-bold"><i class="fas fa-code-compare mr-1.5 text-sky-300"></i>カード比較</h2>
           <button class="js-close px-3 py-1.5 bg-slate-700 hover:bg-slate-600 rounded text-sm">閉じる</button>
         </div>
         <div class="flex flex-wrap gap-3">${cols}</div>
       </div>`;
    document.body.appendChild(modal);
    modal.addEventListener('click', (e) => {
      if (e.target.closest('.js-close') || e.target === modal) modal.remove();
    });
  }

  // ---------- 初期化 ----------
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('.js-compare');
    if (!btn) return;
    e.preventDefault();
    const tile = btn.closest('[data-file]');
    if (!tile) return;
    if (compare.length >= 4) { alert('比較は最大4枚までです。'); return; }
    if (compare.some((c) => c.card_file === tile.dataset.file)) return;
    const data = await apiGet('/api/cards/' + encodeURIComponent(tile.dataset.file));
    compare.push(data.card);
    renderCompare();
  });

  $('#sort-select').addEventListener('change', (e) => {
    state.search_sort = e.target.value;
    state.page = 1;
    runSearch();
  });
  $('#perpage-select').addEventListener('change', (e) => {
    state.posts_per_page = Number(e.target.value);
    state.page = 1;
    runSearch();
  });
  const setView = (m) => {
    viewMode = m;
    store.set('lorfan.viewMode', m);
    $('#view-grid').className = 'px-2 py-1.5 ' + (m === 'grid' ? 'bg-slate-700' : 'bg-slate-800');
    $('#view-list').className = 'px-2 py-1.5 ' + (m === 'list' ? 'bg-slate-700' : 'bg-slate-800');
    runSearch();
  };
  $('#view-grid').addEventListener('click', () => setView('grid'));
  $('#view-list').addEventListener('click', () => setView('list'));

  (async function boot() {
    urlToState();
    $('#sort-select').value = state.search_sort;
    $('#perpage-select').value = String(state.posts_per_page);
    $('#view-grid').className = 'px-2 py-1.5 ' + (viewMode === 'grid' ? 'bg-slate-700' : 'bg-slate-800');
    $('#view-list').className = 'px-2 py-1.5 ' + (viewMode === 'list' ? 'bg-slate-700' : 'bg-slate-800');
    try {
      masters = await apiGet('/api/masters');
    } catch {
      masters = { sets: [], classifications: [], abilities: [], referenced_classifications: [] };
    }
    renderFilters();
    runSearch();
  })();
};
