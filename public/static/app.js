/**
 * app.js — フロントエンド共通ロジック
 *
 * ページ判定 → 各初期化。カード画像は公式サーバ直リンク（BUILD_SPEC §5 モードA）、
 * loading="lazy" を必須で付与する。
 */
(function () {
  'use strict';

  const { renderRulesText, renderFlavorText, toPlainText } = window.LorIcons;

  // ==================== 定数 ====================
  const INK_COLORS = ['アンバー', 'アメジスト', 'エメラルド', 'ルビー', 'サファイア', 'スティール'];
  const CARD_TYPES = ['キャラクター', 'アクション', 'アイテム', 'ロケーション'];
  const CLASSIFICATION_BASE = ['ストーリーボーン', 'ドリームボーン', 'フラッドボーン'];
  const RARITIES = [
    'コモン', 'アンコモン', 'レア', 'スーパーレア', 'レジェンダリー',
    'エピック', 'エンチャンテッド', 'アイコニック', 'プロモーションカード',
  ];
  const FREEWORD_FIELDS = ['カード名', 'バージョン名', '読み', 'クラス', 'テキスト', 'フレーバー', 'イラストレーター'];
  const DEFAULT_MAX_COPIES = 4;
  const DECK_SIZE = 60;
  const MAX_INK_COLORS = 2;

  // ==================== ユーティリティ ====================
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const esc = (s) =>
    String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const debounce = (fn, ms) => {
    let t;
    return function () {
      clearTimeout(t);
      const args = arguments;
      t = setTimeout(() => fn.apply(this, args), ms);
    };
  };

  async function apiGet(path) {
    const r = await fetch(path, { headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }
  async function apiPost(path, body) {
    const r = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await r.json().catch(() => ({}));
    if (!r.ok) {
      const e = new Error(json.message || json.error || 'HTTP ' + r.status);
      e.payload = json;
      e.status = r.status;
      throw e;
    }
    return json;
  }

  // ==================== LocalStorage ====================
  const store = {
    get(key, fallback) {
      try {
        const v = localStorage.getItem(key);
        return v == null ? fallback : JSON.parse(v);
      } catch { return fallback; }
    },
    set(key, val) {
      try { localStorage.setItem(key, JSON.stringify(val)); } catch { /* quota */ }
    },
  };

  const FAV_KEY = 'lorfan.favorites';
  const favorites = {
    all() { return store.get(FAV_KEY, []); },
    has(file) { return this.all().indexOf(file) >= 0; },
    toggle(file) {
      const list = this.all();
      const i = list.indexOf(file);
      if (i >= 0) list.splice(i, 1);
      else list.push(file);
      store.set(FAV_KEY, list);
      return i < 0;
    },
  };

  // ==================== カードタイル描画 ====================
  function inkChips(card) {
    const inks = [card.ink_color, card.ink_color2].filter(Boolean);
    return inks.map((i) => `<span class="ink-chip ink-${esc(i)}" title="${esc(i)}"></span>`).join('');
  }

  function statBadges(card) {
    const out = [];
    if (card.ink_cost != null) out.push(`<span class="text-sky-300" title="インクコスト"><i class="fas fa-droplet"></i> ${card.ink_cost}</span>`);
    if (card.strength != null) out.push(`<span class="text-rose-300" title="攻撃力">${card.strength}</span>`);
    if (card.willpower != null) out.push(`<span class="text-emerald-300" title="意志力">${card.willpower}</span>`);
    if (card.lore_value != null) out.push(`<span class="text-violet-300" title="ロア">◆${card.lore_value}</span>`);
    if (card.move_cost != null) out.push(`<span class="text-teal-300" title="移動コスト">⇢${card.move_cost}</span>`);
    return out.join('<span class="text-slate-600">/</span>');
  }

  /**
   * カード画像。§5 モードA: 公式サーバ直リンク + loading="lazy" 必須。
   * 自サーバへの保存・再配信は行わない。
   */
  function cardImage(card, sizes) {
    return (
      `<div class="card-thumb">` +
      `<img src="${esc(card.image_url)}" alt="${esc(card.card_name)}${card.version ? ' / ' + esc(card.version) : ''}" ` +
      `loading="lazy" decoding="async" referrerpolicy="no-referrer-when-downgrade" ` +
      `onerror="this.classList.add('is-error');this.closest('.card-thumb').classList.add('has-error')">` +
      `<div class="card-thumb-fallback"><i class="fas fa-image-slash text-lg"></i>` +
      `<span>画像を読み込めません<br>(公式サーバ参照)</span></div>` +
      `</div>`
    );
  }

  function cardTile(card, opts) {
    opts = opts || {};
    const fav = favorites.has(card.card_file);
    const ink = card.ink_color || '';
    return (
      `<article class="card-tile group relative bg-slate-900 rounded-lg border border-slate-700 hover:border-slate-500 overflow-hidden transition"
                data-file="${esc(card.card_file)}" data-id="${card.id}"
                ${opts.draggable ? 'draggable="true"' : ''}>
         <button class="js-zoom absolute top-1.5 right-1.5 z-10 w-7 h-7 rounded-full bg-slate-900/80 text-slate-200 opacity-0 group-hover:opacity-100 focus:opacity-100 transition grid place-items-center hover:bg-slate-700"
                 data-img="${esc(card.image_url)}" data-name="${esc(card.card_name)}" title="拡大表示" aria-label="拡大表示">
           <i class="fas fa-expand text-xs"></i>
         </button>
         <button class="js-fav absolute top-1.5 left-1.5 z-10 w-7 h-7 rounded-full bg-slate-900/80 ${fav ? 'text-amber-300' : 'text-slate-400 opacity-0 group-hover:opacity-100 focus:opacity-100'} transition grid place-items-center hover:bg-slate-700"
                 title="お気に入り" aria-label="お気に入りに追加/解除" aria-pressed="${fav}">
           <i class="fa-star ${fav ? 'fas' : 'far'} text-xs"></i>
         </button>
         <a href="/cards/${encodeURIComponent(card.card_file)}" class="block">
           ${cardImage(card)}
         </a>
         <div class="p-2 space-y-1">
           <div class="flex items-start gap-1.5">
             <span class="flex gap-0.5 pt-1 shrink-0">${inkChips(card)}</span>
             <div class="min-w-0 flex-1">
               <a href="/cards/${encodeURIComponent(card.card_file)}" class="block text-[13px] font-bold leading-tight truncate hover:text-amber-300">${esc(card.card_name)}</a>
               ${card.version ? `<span class="block text-[10px] text-slate-400 truncate">${esc(card.version)}</span>` : ''}
             </div>
           </div>
           <div class="flex items-center gap-1 text-[11px] font-semibold">${statBadges(card)}</div>
           <div class="flex items-center justify-between text-[9px] text-slate-500">
             <span class="truncate">${esc(card.card_type)} · ${esc(card.rarity)}</span>
             ${card.inkwell === 'y' ? '<span class="text-sky-400" title="インク可能"><i class="fas fa-droplet"></i></span>' : ''}
           </div>
           ${opts.addButton
             ? `<button class="js-add w-full mt-1 py-1 bg-sky-700 hover:bg-sky-600 rounded text-[11px] font-semibold">
                  <i class="fas fa-plus mr-1"></i>デッキに追加</button>`
             : ''}
           ${opts.compareButton
             ? `<button class="js-compare w-full mt-1 py-1 bg-slate-700 hover:bg-slate-600 rounded text-[11px]">
                  <i class="fas fa-code-compare mr-1"></i>比較に追加</button>`
             : ''}
         </div>
       </article>`
    );
  }

  function cardRow(card) {
    return (
      `<article class="card-tile flex gap-3 p-2 bg-slate-900 rounded-lg border border-slate-700 hover:border-slate-500 transition"
                data-file="${esc(card.card_file)}" data-id="${card.id}">
         <a href="/cards/${encodeURIComponent(card.card_file)}" class="w-16 shrink-0">${cardImage(card)}</a>
         <div class="min-w-0 flex-1">
           <div class="flex items-center gap-1.5 flex-wrap">
             <span class="flex gap-0.5">${inkChips(card)}</span>
             <a href="/cards/${encodeURIComponent(card.card_file)}" class="font-bold text-sm hover:text-amber-300">${esc(card.card_name)}</a>
             ${card.version ? `<span class="text-xs text-slate-400">/ ${esc(card.version)}</span>` : ''}
             <span class="text-[10px] px-1.5 py-0.5 bg-slate-800 rounded">${esc(card.rarity)}</span>
           </div>
           <div class="flex items-center gap-1.5 text-[11px] font-semibold mt-0.5">${statBadges(card)}
             <span class="text-slate-500 font-normal">· ${esc(card.card_type)}</span>
             ${(card.classifications || []).length ? `<span class="text-slate-500 font-normal">· ${(card.classifications || []).map(esc).join('・')}</span>` : ''}
           </div>
           ${card.rules_text ? `<p class="rules-text text-[11px] text-slate-300 mt-1 line-clamp-3">${renderRulesText(card.rules_text)}</p>` : ''}
           <div class="text-[9px] text-slate-500 mt-1">${esc(card.sets_name || '')}</div>
         </div>
         <div class="flex flex-col gap-1 shrink-0">
           <button class="js-zoom w-7 h-7 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 grid place-items-center"
                   data-img="${esc(card.image_url)}" data-name="${esc(card.card_name)}" title="拡大表示" aria-label="拡大表示">
             <i class="fas fa-expand text-xs"></i></button>
           <button class="js-fav w-7 h-7 rounded bg-slate-800 hover:bg-slate-700 ${favorites.has(card.card_file) ? 'text-amber-300' : 'text-slate-400'} grid place-items-center"
                   title="お気に入り" aria-label="お気に入り" aria-pressed="${favorites.has(card.card_file)}">
             <i class="fa-star ${favorites.has(card.card_file) ? 'fas' : 'far'} text-xs"></i></button>
           <button class="js-compare w-7 h-7 rounded bg-slate-800 hover:bg-slate-700 text-slate-400 grid place-items-center"
                   title="比較に追加" aria-label="比較に追加">
             <i class="fas fa-code-compare text-xs"></i></button>
         </div>
       </article>`
    );
  }

  // ==================== ライトボックス（鑑賞モード）====================
  function initLightbox() {
    const box = $('#lightbox');
    if (!box) return;
    const img = $('#lightbox-img');
    const close = () => { box.classList.remove('open'); img.src = ''; };

    document.addEventListener('click', (e) => {
      const btn = e.target.closest('.js-zoom');
      if (btn) {
        e.preventDefault();
        img.src = btn.dataset.img;
        img.alt = btn.dataset.name || '';
        box.classList.add('open');
        return;
      }
      if (e.target.closest('#lightbox-close') || e.target === box) close();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && box.classList.contains('open')) close();
    });
  }

  // ==================== お気に入りボタン ====================
  function initFavButtons() {
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('.js-fav');
      if (!btn) return;
      e.preventDefault();
      const tile = btn.closest('[data-file]');
      if (!tile) return;
      const on = favorites.toggle(tile.dataset.file);
      const icon = $('i', btn);
      btn.setAttribute('aria-pressed', String(on));
      if (on) {
        btn.classList.add('text-amber-300');
        btn.classList.remove('text-slate-400', 'opacity-0');
        icon.className = 'fas fa-star text-xs';
      } else {
        btn.classList.remove('text-amber-300');
        btn.classList.add('text-slate-400');
        icon.className = 'far fa-star text-xs';
      }
    });
  }

  // 以降のモジュールは別ファイルに分割せず、ページ別 init を下部で定義する
  window.LorApp = {
    $, $$, esc, debounce, apiGet, apiPost, store, favorites,
    cardTile, cardRow, cardImage, inkChips, statBadges,
    INK_COLORS, CARD_TYPES, CLASSIFICATION_BASE, RARITIES, FREEWORD_FIELDS,
    DEFAULT_MAX_COPIES, DECK_SIZE, MAX_INK_COLORS,
    renderRulesText, renderFlavorText, toPlainText,
    initLightbox, initFavButtons,
  };

  document.addEventListener('DOMContentLoaded', () => {
    initLightbox();
    initFavButtons();
    const path = location.pathname;
    if (path === '/') {
      window.initSearchPage && window.initSearchPage();
      // トップページ左カラムの「最新環境情報」ダイジェスト（検索とは独立に描画）
      window.initMetaWidget && window.initMetaWidget();
    }
    else if (path.startsWith('/cards/')) window.initCardDetailPage && window.initCardDetailPage();
    else if (path === '/deck') window.initDeckPage && window.initDeckPage();
    else if (path === '/synergy') window.initSynergyPage && window.initSynergyPage();
    else if (path === '/rules') window.initRulesPage && window.initRulesPage();
    else if (path === '/meta') window.initMetaPage && window.initMetaPage();
    else if (path === '/favorites') window.initFavoritesPage && window.initFavoritesPage();
    else if (path === '/about') window.initAboutPage && window.initAboutPage();
  });
})();
