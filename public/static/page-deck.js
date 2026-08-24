/**
 * page-deck.js — デッキビルダー（BUILD_SPEC §6）
 *
 *  - ドラッグ&ドロップでデッキ構築（1枚あたり最大4枚、limit_card があればそれに従う）
 *  - インクカラー2色ルール検証（ink_color + ink_color2 を許容、デッキ全体で2色以内）
 *  - 合計 60 枚のバリデーション
 *  - コスト曲線・種族分布・インク配分の可視化
 *  - 公式デッキコードの取り込み（サーバ側プロキシ経由）
 *  - 逆方向（自デッキ→コード）は公式の 1日30回制限があるため実装せず、
 *    公式デッキビルダーへのリンクに留める（§6.1）
 */
window.initDeckPage = function () {
  const A = window.LorApp;
  const { $, $$, esc, debounce, apiGet, apiPost, store, cardTile } = A;
  const DECK_KEY = 'lorfan.deck';

  /** deck: { [card_file]: { card, count } } */
  let deck = store.get(DECK_KEY, {});
  let masters = null;
  let poolCards = [];

  const deckEntries = () => Object.values(deck).filter((e) => e && e.card);
  const totalCards = () => deckEntries().reduce((s, e) => s + e.count, 0);
  const maxCopies = (card) => (card.limit_card != null ? card.limit_card : A.DEFAULT_MAX_COPIES);

  function save() {
    store.set(DECK_KEY, deck);
    renderDeck();
  }

  // ---------- デッキ操作 ----------
  function addCard(card, n) {
    n = n || 1;
    const cur = deck[card.card_file];
    const limit = maxCopies(card);
    if (cur) {
      cur.card = card;
      cur.count = Math.min(cur.count + n, limit);
    } else {
      deck[card.card_file] = { card, count: Math.min(n, limit) };
    }
    save();
  }
  function removeCard(file, n) {
    n = n || 1;
    const e = deck[file];
    if (!e) return;
    e.count -= n;
    if (e.count <= 0) delete deck[file];
    save();
  }

  // ---------- インク色ルール検証 ----------
  /**
   * デッキ全体で 2 色以内。デュアルインク（ink_color2 あり）は
   * 「2色のうち片方を選ぶ」のではなく両色に属するため、両方を集合に加える。
   */
  function deckInkColors() {
    const set = new Set();
    for (const e of deckEntries()) {
      if (e.card.ink_color) set.add(e.card.ink_color);
      if (e.card.ink_color2) set.add(e.card.ink_color2);
    }
    return [...set];
  }

  function validate() {
    const issues = [];
    const total = totalCards();
    const inks = deckInkColors();

    if (total !== A.DECK_SIZE) {
      issues.push({
        level: total > A.DECK_SIZE ? 'error' : 'warn',
        msg: `デッキは ${A.DECK_SIZE} 枚必要です（現在 ${total} 枚 / ${total > A.DECK_SIZE ? `${total - A.DECK_SIZE} 枚超過` : `あと ${A.DECK_SIZE - total} 枚`}）`,
      });
    }
    if (inks.length > A.MAX_INK_COLORS) {
      issues.push({
        level: 'error',
        msg: `インク色は ${A.MAX_INK_COLORS} 色以内です（現在 ${inks.length} 色: ${inks.join('・')}）`,
      });
    }
    for (const e of deckEntries()) {
      const limit = maxCopies(e.card);
      if (e.count > limit) {
        issues.push({
          level: 'error',
          msg: `「${e.card.card_name}」は ${limit} 枚まで（現在 ${e.count} 枚）`,
        });
      }
    }
    return { issues, total, inks, valid: issues.filter((i) => i.level === 'error').length === 0 && total === A.DECK_SIZE };
  }

  // ---------- 描画: サマリ・検証 ----------
  function renderDeck() {
    const v = validate();
    const entries = deckEntries().sort((a, b) => {
      const ca = a.card.ink_cost ?? 99, cb = b.card.ink_cost ?? 99;
      if (ca !== cb) return ca - cb;
      return String(a.card.card_name).localeCompare(String(b.card.card_name), 'ja');
    });

    $('#deck-summary').innerHTML =
      `<div class="flex items-center justify-between mb-1.5">
         <span class="text-sm font-bold">
           <i class="fas fa-layer-group text-amber-300 mr-1"></i>デッキ
         </span>
         <span class="text-lg font-bold ${v.total === A.DECK_SIZE ? 'text-emerald-400' : v.total > A.DECK_SIZE ? 'text-rose-400' : 'text-slate-300'}">
           ${v.total}<span class="text-xs text-slate-500">/${A.DECK_SIZE}</span>
         </span>
       </div>
       <div class="h-1.5 bg-slate-800 rounded-full overflow-hidden">
         <div class="h-full ${v.total > A.DECK_SIZE ? 'bg-rose-500' : v.total === A.DECK_SIZE ? 'bg-emerald-500' : 'bg-sky-500'} transition-all"
              style="width:${Math.min((v.total / A.DECK_SIZE) * 100, 100)}%"></div>
       </div>
       ${v.inks.length
         ? `<div class="flex items-center gap-1.5 mt-2 text-[11px]">
              <span class="text-slate-500">インク</span>
              ${v.inks.map((i) => `<span class="flex items-center gap-1"><span class="ink-chip ink-${esc(i)}"></span>${esc(i)}</span>`).join('')}
              ${v.inks.length > A.MAX_INK_COLORS ? '<span class="text-rose-400 font-bold">超過</span>' : ''}
            </div>`
         : ''}`;

    $('#deck-validation').innerHTML = v.issues.length
      ? v.issues
          .map(
            (i) =>
              `<div class="text-[11px] px-2 py-1.5 rounded ${i.level === 'error' ? 'bg-rose-950/50 text-rose-200 border border-rose-800/60' : 'bg-amber-950/40 text-amber-200 border border-amber-800/50'}">
                 <i class="fas ${i.level === 'error' ? 'fa-circle-exclamation' : 'fa-triangle-exclamation'} mr-1"></i>${esc(i.msg)}
               </div>`
          )
          .join('')
      : `<div class="text-[11px] px-2 py-1.5 rounded bg-emerald-950/40 text-emerald-200 border border-emerald-800/60">
           <i class="fas fa-circle-check mr-1"></i>デッキ構築ルールを満たしています
         </div>`;

    $('#deck-list').innerHTML = entries.length
      ? entries
          .map(
            (e) =>
              `<div class="deck-stack-item flex items-center gap-2 p-1.5 bg-slate-800/70 rounded group" data-file="${esc(e.card.card_file)}">
                 <button class="js-zoom w-8 shrink-0" data-img="${esc(e.card.image_url)}" data-name="${esc(e.card.card_name)}" aria-label="拡大">
                   <img src="${esc(e.card.image_url)}" alt="${esc(e.card.card_name)}" loading="lazy"
                        class="w-full rounded border border-slate-600">
                 </button>
                 <div class="min-w-0 flex-1">
                   <div class="flex items-center gap-1">
                     <span class="ink-chip ink-${esc(e.card.ink_color)} shrink-0"></span>
                     <span class="text-[11px] font-semibold truncate">${esc(e.card.card_name)}</span>
                   </div>
                   <div class="text-[9px] text-slate-400 truncate">
                     ${e.card.version ? esc(e.card.version) + ' · ' : ''}
                     <i class="fas fa-droplet"></i>${e.card.ink_cost ?? '-'}
                     ${e.card.card_type === 'キャラクター' ? ` · ${e.card.strength ?? '-'}/${e.card.willpower ?? '-'}` : ` · ${esc(e.card.card_type)}`}
                   </div>
                 </div>
                 <div class="flex items-center gap-0.5 shrink-0">
                   <button class="js-dec w-6 h-6 rounded bg-slate-700 hover:bg-rose-800 text-xs" aria-label="1枚減らす">−</button>
                   <span class="w-5 text-center text-xs font-bold ${e.count > maxCopies(e.card) ? 'text-rose-400' : ''}">${e.count}</span>
                   <button class="js-inc w-6 h-6 rounded bg-slate-700 hover:bg-sky-700 text-xs" aria-label="1枚増やす">+</button>
                 </div>
               </div>`
          )
          .join('')
      : `<p class="text-center text-xs text-slate-500 py-8">
           <i class="fas fa-hand-pointer block text-2xl mb-2 opacity-40"></i>
           左のカードをクリックまたはドラッグしてデッキに追加
         </p>`;

    renderStats(entries);
  }

  // ---------- 描画: 統計（コスト曲線・種族分布・インク配分）----------
  function renderStats(entries) {
    if (!entries.length) { $('#deck-stats').innerHTML = ''; return; }

    // コスト曲線
    const curve = {};
    for (let i = 0; i <= 10; i++) curve[i] = 0;
    let inkable = 0, typeCount = {}, classCount = {}, inkCount = {};
    let totalLore = 0, totalStrength = 0, totalWillpower = 0, charCount = 0;

    for (const e of entries) {
      const cost = Math.min(e.card.ink_cost ?? 0, 10);
      curve[cost] += e.count;
      if (e.card.inkwell === 'y') inkable += e.count;
      typeCount[e.card.card_type] = (typeCount[e.card.card_type] || 0) + e.count;
      for (const cl of e.card.classifications || []) classCount[cl] = (classCount[cl] || 0) + e.count;
      for (const ink of [e.card.ink_color, e.card.ink_color2].filter(Boolean)) {
        inkCount[ink] = (inkCount[ink] || 0) + e.count;
      }
      if (e.card.card_type === 'キャラクター') {
        charCount += e.count;
        totalStrength += (e.card.strength || 0) * e.count;
        totalWillpower += (e.card.willpower || 0) * e.count;
      }
      totalLore += (e.card.lore_value || 0) * e.count;
    }

    const maxCurve = Math.max(...Object.values(curve), 1);
    const total = entries.reduce((s, e) => s + e.count, 0);
    const avgCost = (Object.entries(curve).reduce((s, [c, n]) => s + Number(c) * n, 0) / total).toFixed(2);

    const barChart =
      `<div class="flex items-end gap-1 h-24">
         ${Object.entries(curve)
           .map(([cost, n]) =>
             `<div class="flex-1 flex flex-col items-center gap-1">
                <span class="text-[9px] ${n ? 'text-slate-300' : 'text-slate-700'}">${n || ''}</span>
                <div class="w-full curve-bar rounded-t ${n ? 'bg-gradient-to-t from-sky-700 to-sky-400' : 'bg-slate-800'}"
                     style="height:${n ? (n / maxCurve) * 72 : 2}px" title="コスト${cost}: ${n}枚"></div>
                <span class="text-[9px] text-slate-500">${cost}</span>
              </div>`
           )
           .join('')}
       </div>`;

    const distBar = (obj, colorFn) => {
      const items = Object.entries(obj).sort((a, b) => b[1] - a[1]);
      const sum = items.reduce((s, [, n]) => s + n, 0) || 1;
      return (
        `<div class="h-2.5 flex rounded-full overflow-hidden bg-slate-800 mb-1.5">
           ${items.map(([k, n]) => `<div style="width:${(n / sum) * 100}%;background:${colorFn(k)}" title="${esc(k)}: ${n}枚"></div>`).join('')}
         </div>
         <div class="flex flex-wrap gap-x-2.5 gap-y-1 text-[10px]">
           ${items.slice(0, 8).map(([k, n]) =>
             `<span class="flex items-center gap-1">
                <span class="w-2 h-2 rounded-sm shrink-0" style="background:${colorFn(k)}"></span>
                ${esc(k)} <strong>${n}</strong>
              </span>`
           ).join('')}
         </div>`
      );
    };

    const INK_HEX = {
      'アンバー': '#f0b429', 'アメジスト': '#a855f7', 'エメラルド': '#10b981',
      'ルビー': '#ef4444', 'サファイア': '#3b82f6', 'スティール': '#94a3b8',
    };
    const TYPE_HEX = { 'キャラクター': '#38bdf8', 'アクション': '#f472b6', 'アイテム': '#fbbf24', 'ロケーション': '#34d399' };
    const palette = ['#38bdf8', '#a78bfa', '#fb7185', '#fbbf24', '#34d399', '#60a5fa', '#f472b6', '#facc15'];
    let pi = 0;
    const classColors = {};
    const classColor = (k) => (classColors[k] = classColors[k] || palette[pi++ % palette.length]);

    const panel = (title, inner) =>
      `<section class="bg-slate-900 border border-slate-700 rounded-lg p-3">
         <h3 class="text-[11px] font-bold text-slate-400 mb-2">${title}</h3>${inner}
       </section>`;

    $('#deck-stats').innerHTML =
      panel(`コスト曲線 <span class="font-normal text-slate-500">（平均 ${avgCost}）</span>`, barChart) +
      panel('インク配分', distBar(inkCount, (k) => INK_HEX[k] || '#64748b')) +
      panel('カード種別', distBar(typeCount, (k) => TYPE_HEX[k] || '#64748b')) +
      (Object.keys(classCount).length ? panel('種族分布（上位）', distBar(classCount, classColor)) : '') +
      panel(
        '概要',
        `<dl class="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
           <div class="flex justify-between"><dt class="text-slate-500">インク可能</dt><dd><strong>${inkable}</strong> 枚 (${Math.round((inkable / total) * 100)}%)</dd></div>
           <div class="flex justify-between"><dt class="text-slate-500">キャラクター</dt><dd><strong>${charCount}</strong> 枚</dd></div>
           <div class="flex justify-between"><dt class="text-slate-500">合計ロア</dt><dd><strong>${totalLore}</strong></dd></div>
           <div class="flex justify-between"><dt class="text-slate-500">合計攻撃力</dt><dd><strong>${totalStrength}</strong></dd></div>
           <div class="flex justify-between"><dt class="text-slate-500">合計意志力</dt><dd><strong>${totalWillpower}</strong></dd></div>
           <div class="flex justify-between"><dt class="text-slate-500">ユニーク</dt><dd><strong>${entries.length}</strong> 種</dd></div>
         </dl>`
      );
  }

  // ---------- カードプール ----------
  async function loadPool() {
    const q = $('#pool-search').value.trim();
    const ink = $('#pool-ink').value;
    const type = $('#pool-type').value;

    $('#pool-results').innerHTML =
      '<div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2.5">' +
      '<div class="card-thumb skeleton rounded-lg"></div>'.repeat(8) +
      '</div>';

    const data = await apiPost('/api/cards/search', {
      freeword: q,
      freeword_field: ['カード名', 'バージョン名', 'テキスト'],
      ink_color: ink ? [ink] : [],
      card_type: type ? [type] : [],
      search_sort: 'インクコスト順（昇順）',
      posts_per_page: 24,
      page: 1,
    });
    poolCards = data.cards;

    $('#pool-results').innerHTML =
      `<div class="text-[11px] text-slate-500 mb-2">${data.count.toLocaleString()} 件中 ${data.cards.length} 件を表示</div>
       <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2.5">
         ${data.cards.map((c) => cardTile(c, { addButton: true, draggable: true })).join('')}
       </div>`;
  }

  // ---------- ドラッグ&ドロップ ----------
  function initDnD() {
    let draggingFile = null;

    $('#pool-results').addEventListener('dragstart', (e) => {
      const tile = e.target.closest('[data-file]');
      if (!tile) return;
      draggingFile = tile.dataset.file;
      tile.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'copy';
      e.dataTransfer.setData('text/plain', draggingFile);
    });
    $('#pool-results').addEventListener('dragend', (e) => {
      const tile = e.target.closest('[data-file]');
      if (tile) tile.classList.remove('dragging');
      draggingFile = null;
    });

    const zone = $('#deck-drop-zone');
    zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('drag-over'); });
    zone.addEventListener('dragleave', (e) => {
      if (!zone.contains(e.relatedTarget)) zone.classList.remove('drag-over');
    });
    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      zone.classList.remove('drag-over');
      const file = e.dataTransfer.getData('text/plain') || draggingFile;
      if (!file) return;
      const card = poolCards.find((c) => c.card_file === file);
      if (card) addCard(card, 1);
    });
  }

  // ---------- デッキコード取り込み（§6.2 / §6.3）----------
  async function importDeckCode() {
    const input = $('#deck-code-input');
    const msg = $('#deck-import-msg');
    const code = input.value.trim().toUpperCase();
    if (!code) { msg.innerHTML = '<span class="text-amber-300">デッキコードを入力してください。</span>'; return; }

    msg.innerHTML = '<span class="text-slate-400"><i class="fas fa-spinner fa-spin mr-1"></i>公式サーバに問い合わせています…</span>';
    let data;
    try {
      data = await apiPost('/api/deck/import', { code });
    } catch (e) {
      const p = e.payload || {};
      let hint = '';
      if (e.status === 429) hint = `（${p.retry_after ? p.retry_after + '秒' : 'しばらく'}後に再試行してください）`;
      msg.innerHTML = `<span class="text-rose-300"><i class="fas fa-circle-exclamation mr-1"></i>${esc(e.message)}${hint}</span>`;
      return;
    }

    // ローカルデッキ状態にマージ（既存はいったんクリアせず、取り込み分を上書き）
    let added = 0;
    for (const item of data.cards) {
      if (!item.card) continue;
      deck[item.card.card_file] = { card: item.card, count: item.card_num };
      added += item.card_num;
    }
    save();

    let html = `<span class="text-emerald-300"><i class="fas fa-circle-check mr-1"></i>${added} 枚を読み込みました`;
    if (data.ink_colors && data.ink_colors.length) html += `（${data.ink_colors.map(esc).join('・')}）`;
    html += '</span>';
    if (data.warning) {
      html += `<div class="mt-1.5 text-amber-300"><i class="fas fa-triangle-exclamation mr-1"></i>${esc(data.warning)}
               ${data.unknown_card_files && data.unknown_card_files.length
                 ? `<span class="text-slate-400">未取込: ${data.unknown_card_files.map(esc).join(', ')}</span>`
                 : ''}</div>`;
    }
    msg.innerHTML = html;

    // URL パラメータにも保存（LocalStorage + URL 共有 / §6.3）
    const p = new URLSearchParams(location.search);
    p.set('deck', code);
    history.replaceState(null, '', location.pathname + '?' + p.toString());
  }

  function shareUrl() {
    // デッキ内容を URL に載せる（card_file:枚数 をカンマ区切り）
    const compact = deckEntries().map((e) => `${e.card.card_file}:${e.count}`).join(',');
    const url = location.origin + location.pathname + '?d=' + encodeURIComponent(compact);
    navigator.clipboard
      ?.writeText(url)
      .then(() => alert('デッキのURLをコピーしました。'))
      .catch(() => prompt('このURLをコピーしてください:', url));
  }

  async function loadFromUrl() {
    const p = new URLSearchParams(location.search);
    // 単体追加（カード詳細の「デッキに追加」から）
    const addFile = p.get('add');
    const d = p.get('d');
    const codeParam = p.get('deck');

    if (d) {
      const pairs = d.split(',').map((s) => s.split(':')).filter((x) => x[0]);
      const files = pairs.map((x) => x[0]);
      const res = await apiPost('/api/cards/by-files', { files });
      const byFile = {};
      for (const c of res.cards) byFile[c.card_file] = c;
      deck = {};
      for (const [f, n] of pairs) if (byFile[f]) deck[f] = { card: byFile[f], count: Number(n) || 1 };
      save();
    }
    if (addFile) {
      const res = await apiPost('/api/cards/by-files', { files: [addFile] });
      if (res.cards[0]) addCard(res.cards[0], 1);
      const np = new URLSearchParams(location.search);
      np.delete('add');
      history.replaceState(null, '', location.pathname + (np.toString() ? '?' + np : ''));
    }
    if (codeParam) {
      $('#deck-import-panel').classList.remove('hidden');
      $('#deck-code-input').value = codeParam;
    }
  }

  // ---------- イベント ----------
  $('#pool-results').addEventListener('click', (e) => {
    const add = e.target.closest('.js-add');
    if (add) {
      const tile = add.closest('[data-file]');
      const card = poolCards.find((c) => c.card_file === tile.dataset.file);
      if (card) addCard(card, 1);
      return;
    }
    // 画像・リンク以外の余白クリックでも追加
    const tile = e.target.closest('.card-tile');
    if (tile && !e.target.closest('a') && !e.target.closest('button')) {
      const card = poolCards.find((c) => c.card_file === tile.dataset.file);
      if (card) addCard(card, 1);
    }
  });

  $('#deck-list').addEventListener('click', (e) => {
    const row = e.target.closest('[data-file]');
    if (!row) return;
    if (e.target.closest('.js-inc')) {
      const entry = deck[row.dataset.file];
      if (entry) addCard(entry.card, 1);
    } else if (e.target.closest('.js-dec')) {
      removeCard(row.dataset.file, 1);
    }
  });

  $('#deck-import-btn').addEventListener('click', () => $('#deck-import-panel').classList.toggle('hidden'));
  $('#deck-code-submit').addEventListener('click', importDeckCode);
  $('#deck-code-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') importDeckCode(); });
  $('#deck-share-btn').addEventListener('click', shareUrl);
  $('#deck-clear-btn').addEventListener('click', () => {
    if (confirm('デッキを空にしますか？')) { deck = {}; save(); }
  });

  $('#pool-search').addEventListener('input', debounce(loadPool, 350));
  $('#pool-ink').addEventListener('change', loadPool);
  $('#pool-type').addEventListener('change', loadPool);

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
      // 突合できたカードのみをビルダーへ。未突合分は枚数が合わなくなるので警告する
      const ok = cards.filter((c) => c.matched && c.card_file);
      deck = {};
      for (const c of ok) {
        deck[c.card_file] = {
          card: {
            card_file: c.card_file, card_name: c.card_name, card_group: c.name,
            image_url: c.image_url, ink_cost: c.ink_cost, ink_color: c.ink_color,
            card_type: c.card_type, rarity: c.rarity, lore_value: c.lore_value,
          },
          count: c.qty,
        };
      }
      save();
      renderDeck();
      const skipped = cards.length - ok.length;
      window.scrollTo({ top: 0, behavior: 'smooth' });
      if (skipped > 0) alert(`${ok.length}種類を読み込みました。${skipped}種類はカードDBと突合できず除外しました。`);
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

    // 一覧のカード見出しは /deck?meta=<id> へのリンク。ページ遷移させずその場で開く
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

    // /deck?meta=<id> で直接開かれた場合
    const want = new URLSearchParams(location.search).get('meta');
    if (want) {
      showRecipeDetail(want);
      document.getElementById('meta-recipes')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  // ---------- 起動 ----------
  (async function boot() {
    try {
      masters = await apiGet('/api/masters');
      $('#pool-ink').innerHTML =
        '<option value="">全インク色</option>' +
        (masters.ink_colors || []).map((x) => `<option value="${esc(x.v)}">${esc(x.v)}</option>`).join('');
      $('#pool-type').innerHTML =
        '<option value="">全種別</option>' +
        (masters.card_types || []).map((x) => `<option value="${esc(x.v)}">${esc(x.v)}</option>`).join('');
    } catch { /* masters なしでも動作継続 */ }

    renderDeck();
    initDnD();
    await loadPool();
    await loadFromUrl();
    // 収集レシピは本体の描画を妨げないよう最後に（失敗してもビルダーは動く）
    try { initRecipes(); } catch (e) { console.warn('meta recipes init failed', e); }
  })();
};
