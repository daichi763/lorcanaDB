/**
 * icons.js — 効果テキスト用アイコン（すべて自作 SVG）
 *
 * BUILD_SPEC §2.5: 公式サイトの ico_card0X.svg は著作権リスク回避のため使用しない。
 * ここで定義する SVG はすべて基本図形のみで新規に描いたオリジナル。
 */
(function () {
  'use strict';

  const SVG = (inner, extra) =>
    `<svg viewBox="0 0 20 20" class="lor-ico ${extra || ''}" aria-hidden="true" focusable="false">${inner}</svg>`;

  // エグザート（横向き = カードを90度倒す）: 傾いた角丸長方形＋回転矢印
  const EXERT = SVG(
    `<g transform="rotate(-38 10 10)">
       <rect x="6.4" y="3.4" width="7.2" height="13.2" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.7"/>
     </g>
     <path d="M3.6 5.4a7.4 7.4 0 0 1 2.1-2.0" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
     <path d="M6.6 2.2 4.4 3.0l.6 2.2z" fill="currentColor"/>`,
    'lor-ico-exert'
  );

  // インク・ドロップ（インクウェルにあるカード）: 水滴形
  const INK = SVG(
    `<path d="M10 2.2c2.9 3.3 5.1 6.0 5.1 8.5a5.1 5.1 0 0 1-10.2 0c0-2.5 2.2-5.2 5.1-8.5z"
           fill="currentColor"/>
     <path d="M8.0 11.6a2.4 2.4 0 0 0 2.0 2.3" fill="none" stroke="#0f172a" stroke-width="1.1" stroke-linecap="round" opacity=".45"/>`,
    'lor-ico-ink'
  );

  // ロア値: 六角形の宝石＋中央のきらめき
  const LORE = SVG(
    `<path d="M10 1.8 17.2 6v8L10 18.2 2.8 14V6z" fill="currentColor"/>
     <path d="M10 5.4 12.1 9h-4.2z" fill="#0f172a" opacity=".5"/>
     <path d="M7.9 11h4.2L10 14.6z" fill="#0f172a" opacity=".3"/>`,
    'lor-ico-lore'
  );

  // 攻撃力: 交差した2本の剣を単純化した尖った菱形＋鍔
  const STRENGTH = SVG(
    `<path d="M10 1.6l2.6 6.1-2.6 2.0-2.6-2.0z" fill="currentColor"/>
     <rect x="5.4" y="8.6" width="9.2" height="1.9" rx=".9" fill="currentColor"/>
     <rect x="9.1" y="10.6" width="1.8" height="7.4" rx=".9" fill="currentColor"/>`,
    'lor-ico-strength'
  );

  // 意志力: 盾形
  const WILLPOWER = SVG(
    `<path d="M10 1.8 3.4 4.2v5.1c0 4.2 2.8 7.2 6.6 8.9 3.8-1.7 6.6-4.7 6.6-8.9V4.2z"
           fill="currentColor"/>
     <path d="M10 4.6v11.0" stroke="#0f172a" stroke-width="1.0" opacity=".35"/>`,
    'lor-ico-willpower'
  );

  // 移動コスト（ロケーション）: 足跡を単純化した二重の楕円＋矢印
  const MOVE = SVG(
    `<circle cx="6.6" cy="12.4" r="3.0" fill="currentColor"/>
     <circle cx="13.0" cy="7.4" r="2.4" fill="currentColor" opacity=".65"/>
     <path d="M9.6 10.4l4.2-3.6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" opacity=".55"/>`,
    'lor-ico-move'
  );

  // ラベル: 赤丸 / 青バツ
  const CIRCLE = SVG(
    `<circle cx="10" cy="10" r="7.0" fill="none" stroke="currentColor" stroke-width="2.4"/>`,
    'lor-ico-circle'
  );
  const CROSS = SVG(
    `<path d="M4.6 4.6l10.8 10.8M15.4 4.6L4.6 15.4" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>`,
    'lor-ico-cross'
  );

  const ICONS = {
    E: { svg: EXERT, label: 'エグザート', cls: 'text-amber-300' },
    I: { svg: INK, label: 'インク', cls: 'text-sky-300' },
    L: { svg: LORE, label: 'ロア', cls: 'text-violet-300' },
    S: { svg: STRENGTH, label: '攻撃力', cls: 'text-rose-300' },
    W: { svg: WILLPOWER, label: '意志力', cls: 'text-emerald-300' },
    M: { svg: MOVE, label: '移動コスト', cls: 'text-teal-300' },
    '〇': { svg: CIRCLE, label: '該当', cls: 'text-rose-400' },
    '×': { svg: CROSS, label: '非該当', cls: 'text-sky-400' },
  };

  function iconHtml(key) {
    const ico = ICONS[key];
    if (!ico) return '';
    return `<span class="lor-ico-wrap ${ico.cls}" role="img" aria-label="${ico.label}" title="${ico.label}">${ico.svg}</span>`;
  }

  const escapeHtml = (s) =>
    String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

  /**
   * 効果テキストのプレースホルダを描画用 HTML に変換（BUILD_SPEC §2.5）
   *
   *  {E}{I}{L}{S}{W}{M}   → 自作アイコン
   *  %                    → <br>
   *  \...\                → 能力名（太字）
   *  <...> / &lt;...&gt;  → 太字（キーワード能力）
   *  《c-red》…《/c-red》 → 赤太字
   *  《c-indigo》…        → 藍太字
   *  {〇} {×}             → 丸／バツ
   */
  function renderRulesText(raw) {
    if (!raw) return '';
    // 先に全部エスケープしてから、独自記法をタグに戻す
    let s = escapeHtml(raw);

    // 《c-xxx》 … 《/c-xxx》（エスケープ済みなので《》はそのまま）
    s = s.replace(/《c-red》([\s\S]*?)《\/c-red》/g, '<strong class="text-rose-400">$1</strong>');
    s = s.replace(/《c-indigo》([\s\S]*?)《\/c-indigo》/g, '<strong class="text-indigo-300">$1</strong>');
    // 閉じタグが欠けているケースの保険
    s = s.replace(/《\/?c-[a-z]+》/g, '');

    // アイコン（{〇}{×} を先に処理）
    s = s.replace(/\{([〇×])\}/g, (_, k) => iconHtml(k));
    s = s.replace(/\{([EILSWM])\}/g, (_, k) => iconHtml(k));

    // 能力名 \...\ （太字・色付き）
    s = s.replace(
      /\\([^\\]{1,60})\\/g,
      '<span class="ability-name font-bold text-amber-200">$1</span>'
    );

    // キーワード能力 &lt;...&gt;（元の <...>）を太字に
    s = s.replace(
      /&lt;([^&]{1,40}?)&gt;/g,
      '<strong class="keyword-ability text-sky-200">$1</strong>'
    );

    // 改行
    s = s.replace(/%/g, '<br>');

    return s;
  }

  /** フレーバーテキスト（同じ記法だが装飾は控えめ） */
  function renderFlavorText(raw) {
    if (!raw) return '';
    let s = escapeHtml(raw);
    s = s.replace(/《\/?c-[a-z]+》/g, '');
    s = s.replace(/\{([EILSWM〇×])\}/g, (_, k) => iconHtml(k));
    s = s.replace(/\\([^\\]{1,60})\\/g, '<em>$1</em>');
    s = s.replace(/&lt;([^&]{1,40}?)&gt;/g, '<em>$1</em>');
    s = s.replace(/%/g, '<br>');
    return s;
  }

  /** テキストのみ（検索スニペット等） */
  function toPlainText(raw) {
    if (!raw) return '';
    return String(raw)
      .replace(/\{[EILSWM〇×]\}/g, ' ')
      .replace(/《\/?c-[a-z]+》/g, '')
      .replace(/\\/g, '')
      .replace(/%/g, ' ')
      .replace(/&lt;|&gt;|[<>]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  window.LorIcons = { iconHtml, renderRulesText, renderFlavorText, toPlainText, ICONS };
})();
