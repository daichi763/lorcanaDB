/**
 * page-meta.js — 「最新環境情報」の表示
 *
 * 2つの入口を持つ:
 *   initMetaWidget() … トップページ左カラムのダイジェスト（要点のみ）
 *   initMetaPage()   … /meta の全文ダッシュボード
 *
 * 表示ポリシー（仕様§1.3 / §4.3）:
 *   - リンクにできるのは公式URLのみ。APIは公式以外のURLを返さない設計だが、
 *     フロントでも isOfficial() で二重に検査してからアンカーにする。
 *   - デッキレシピだけは出典URLを明記する（仕様の例外）。
 *   - カード名は自前DBの詳細ページへ内部リンクする。
 */
(function () {
  'use strict';
  const L = window.LorApp;
  const esc = L.esc;
  const apiGet = L.apiGet;

  // ---- 公式ドメイン（サーバ側 OFFICIAL_HOSTS と対応）----
  const OFFICIAL_HOSTS = [
    'takaratomy.co.jp',
    'disneylorcana.com',
    'tcg.ravensburgerplay.com',
    'ravensburgerplay.com',
    'disney.co.jp',
  ];

  function isOfficial(url) {
    try {
      const h = new URL(url, location.origin).hostname.toLowerCase();
      return OFFICIAL_HOSTS.some((o) => h === o || h.endsWith('.' + o));
    } catch (_) {
      return false;
    }
  }

  const INK_STYLE = {
    アンバー: 'bg-amber-500/15 text-amber-200 border-amber-600/40',
    アメジスト: 'bg-fuchsia-500/15 text-fuchsia-200 border-fuchsia-600/40',
    エメラルド: 'bg-emerald-500/15 text-emerald-200 border-emerald-600/40',
    ルビー: 'bg-rose-500/15 text-rose-200 border-rose-600/40',
    サファイア: 'bg-sky-500/15 text-sky-200 border-sky-600/40',
    スティール: 'bg-slate-400/15 text-slate-200 border-slate-400/40',
  };

  const TAG_STYLE = {
    カード: 'bg-sky-900/60 text-sky-200',
    デッキ: 'bg-emerald-900/60 text-emerald-200',
    大会: 'bg-amber-900/60 text-amber-200',
    ルール: 'bg-violet-900/60 text-violet-200',
    未確認: 'bg-slate-700 text-slate-300',
  };

  function inkChip(name) {
    if (!name) return '';
    const cls = INK_STYLE[name] || 'bg-slate-700/40 text-slate-200 border-slate-600';
    return `<span class="inline-block px-1.5 py-0.5 rounded border text-[10px] ${cls}">${esc(name)}</span>`;
  }

  function inkPairChips(label) {
    return String(label || '')
      .split('/')
      .map((s) => inkChip(s.trim()))
      .join('<span class="text-slate-500 mx-0.5">/</span>');
  }

  /**
   * 本文レンダリング。
   * 保存時にサニタイズ済みだが、表示直前にもう一度検査する:
   *   - [ラベル](URL) 形式は公式のみアンカー化、非公式はラベルのみ
   *   - 素のURLも公式のみアンカー化
   */
  function renderBody(text) {
    let html = esc(String(text || ''));
    // Markdown リンク
    html = html.replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, function (m, label, url) {
      const u = url.replace(/&amp;/g, '&');
      if (!isOfficial(u)) return label;
      return (
        `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer"` +
        ` class="text-sky-400 hover:text-sky-300 underline">${label || '公式'}` +
        `<i class="fas fa-external-link-alt ml-1 text-[9px]"></i></a>`
      );
    });
    // 素のURL
    html = html.replace(/(^|[\s（(])(https?:\/\/[^\s<（）()]+)/g, function (m, pre, url) {
      const u = url.replace(/&amp;/g, '&').replace(/[.,、。]+$/, '');
      if (!isOfficial(u)) return pre;
      return (
        pre +
        `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer"` +
        ` class="text-sky-400 hover:text-sky-300 underline">公式情報` +
        `<i class="fas fa-external-link-alt ml-1 text-[9px]"></i></a>`
      );
    });
    return html.replace(/\n/g, '<br>');
  }

  function fmtDate(d) {
    if (!d) return '';
    const m = String(d).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return String(d);
    return `${Number(m[2])}月${Number(m[3])}日`;
  }

  function fmtDateFull(d) {
    if (!d) return '';
    const m = String(d).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return String(d);
    return `${m[1]}年${Number(m[2])}月${Number(m[3])}日`;
  }

  function deltaBadge(v) {
    if (v == null || Math.abs(v) < 0.05) return '';
    const up = v > 0;
    return (
      `<span class="ml-1 text-[10px] ${up ? 'text-rose-300' : 'text-sky-300'}">` +
      `<i class="fas fa-caret-${up ? 'up' : 'down'}"></i>${Math.abs(v).toFixed(1)}</span>`
    );
  }

  /** カード名 → 自前DBの詳細ページへの内部リンク（仕様§4.3） */
  function cardLink(card) {
    const name = esc(card.card_name || card.name || '');
    if (!card.card_file) return `<span>${name}</span>`;
    return `<a href="/cards/${encodeURIComponent(card.card_file)}" class="hover:text-amber-300 underline decoration-slate-600">${name}</a>`;
  }

  function sectionHead(icon, title, sub) {
    return (
      `<h2 class="text-sm font-bold mb-2 flex items-center gap-1.5">` +
      `<i class="fas fa-${icon} text-amber-300"></i>${esc(title)}` +
      (sub ? `<span class="text-[10px] font-normal text-slate-400">${esc(sub)}</span>` : '') +
      `</h2>`
    );
  }

  const card = (inner, extra) =>
    `<div class="bg-slate-900 border border-slate-700 rounded-lg ${extra || 'p-3'}">${inner}</div>`;

  // ============================================================ ウィジェット
  /**
   * トップページ左カラム。
   * 検索の邪魔にならないよう要点のみ（日本環境の要約 + 次の大会 + 注目カード3枚）。
   */
  async function initMetaWidget() {
    const host = document.getElementById('meta-widget');
    if (!host) return;

    host.innerHTML = card(
      `<div class="flex items-center gap-2 text-xs text-slate-400">` +
        `<i class="fas fa-spinner fa-spin"></i>最新環境情報を読み込み中…</div>`
    );

    let data;
    try {
      data = await apiGet('/api/meta/report');
    } catch (_) {
      host.innerHTML = '';
      return;
    }
    const r = data && data.report;
    if (!r) {
      // まだ生成されていない場合はウィジェット自体を出さない（枠だけ残らないように）
      host.innerHTML = '';
      return;
    }

    const next = (r.official_links || []).length;
    const spot = (r.spotlight_cards || []).filter((c) => c.image_url).slice(0, 3);

    const stale = r.stale
      ? `<span class="text-[10px] px-1.5 py-0.5 rounded bg-slate-700 text-slate-300">前回分</span>`
      : '';

    let html = '';
    html +=
      `<div class="flex items-center justify-between mb-2">` +
      `<h2 class="text-xs font-bold flex items-center gap-1.5">` +
      `<i class="fas fa-chart-line text-amber-300"></i>最新環境情報</h2>` +
      stale +
      `</div>`;

    html +=
      `<p class="text-[10px] text-slate-400 mb-2">` +
      `<i class="fas fa-calendar-day mr-1"></i>${esc(fmtDateFull(r.report_date))} 更新</p>`;

    if (r.jp_summary) {
      html +=
        `<div class="text-[11px] leading-relaxed text-slate-200 mb-2.5">` +
        `<span class="mr-1">🇯🇵</span>${renderBody(clamp(r.jp_summary, 150))}</div>`;
    }

    // 注目カード（画像つき・小さく3枚）
    if (spot.length) {
      html +=
        `<div class="mb-2.5">` +
        `<p class="text-[10px] font-bold text-slate-400 mb-1">注目カード</p>` +
        `<div class="grid grid-cols-3 gap-1.5">` +
        spot
          .map(function (c) {
            const img =
              `<img src="${esc(c.image_url)}" alt="${esc(c.card_name)}" loading="lazy" decoding="async"` +
              ` referrerpolicy="no-referrer-when-downgrade" class="w-full rounded shadow"` +
              ` onerror="this.style.display='none'">`;
            const body = c.card_file
              ? `<a href="/cards/${encodeURIComponent(c.card_file)}" title="${esc(c.card_name)}">${img}</a>`
              : img;
            return (
              `<div>${body}` +
              `<p class="text-[9px] text-slate-400 mt-0.5 truncate" title="${esc(c.card_name)}">` +
              `${esc(c.card_name)}</p></div>`
            );
          })
          .join('') +
        `</div></div>`;
    }

    // 次のイベント（カウントダウン）
    try {
      const ev = await apiGet('/api/meta/events?scope=upcoming&limit=2');
      const list = (ev && ev.events) || [];
      if (list.length) {
        html +=
          `<div class="mb-2.5 pt-2 border-t border-slate-700/70">` +
          `<p class="text-[10px] font-bold text-slate-400 mb-1">次の予定</p>` +
          list
            .map(function (e) {
              const d =
                e.days_until === 0
                  ? `<span class="text-amber-300 font-bold">本日</span>`
                  : e.days_until > 0
                    ? `<span class="text-amber-300 font-bold">あと${e.days_until}日</span>`
                    : '';
              return (
                `<div class="flex items-baseline justify-between gap-2 text-[10px] mb-0.5">` +
                `<span class="truncate text-slate-200" title="${esc(e.name)}">${esc(e.name)}</span>` +
                `<span class="shrink-0">${d}</span></div>` +
                `<p class="text-[9px] text-slate-500 mb-1">${esc(fmtDate(e.held_on))}</p>`
              );
            })
            .join('') +
          `</div>`;
      }
    } catch (_) {
      /* イベントが取れなくてもウィジェットは出す */
    }

    html +=
      `<a href="/meta" class="block text-center text-[11px] px-2 py-1.5 rounded bg-slate-800 hover:bg-slate-700 text-sky-300 font-semibold">` +
      `環境レポート全文を読む<i class="fas fa-arrow-right ml-1"></i></a>`;

    host.innerHTML = card(html);
  }

  function clamp(s, n) {
    const t = String(s || '');
    return t.length > n ? t.slice(0, n) + '…' : t;
  }

  // ============================================================ /meta 本体
  async function initMetaPage() {
    const set = (id, html) => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = html;
    };

    set('meta-jp', card(`<div class="text-xs text-slate-400"><i class="fas fa-spinner fa-spin mr-1"></i>読み込み中…</div>`));

    let data;
    try {
      data = await apiGet('/api/meta/report');
    } catch (_) {
      set('meta-jp', card(`<p class="text-xs text-rose-300">レポートを読み込めませんでした。</p>`));
      return;
    }

    const r = data && data.report;
    const updated = document.getElementById('meta-updated');

    if (!r) {
      if (updated) updated.textContent = '';
      set(
        'meta-jp',
        card(
          `<p class="text-xs text-slate-300"><i class="fas fa-circle-info mr-1"></i>` +
            `環境レポートはまだ生成されていません。毎日22:00（JST）に自動更新されます。</p>`
        )
      );
      return;
    }

    if (updated) {
      const staleNote = r.stale
        ? '（本日分は未生成のため、直近のレポートを表示しています）'
        : '';
      updated.innerHTML =
        `<i class="fas fa-calendar-day mr-1"></i>${esc(fmtDateFull(r.report_date))} 版` +
        (r.freshest_at ? ` ／ 収集した情報の最新日付: ${esc(fmtDateFull(r.freshest_at))}` : '') +
        (staleNote ? `<span class="text-amber-300">${esc(staleNote)}</span>` : '');
    }

    // ---- 明日以降の予定（カウントダウン）----
    renderCountdown();

    // ---- 日本 / 海外ハイライト ----
    set(
      'meta-jp',
      card(
        sectionHead('torii-gate', '🇯🇵 日本環境ハイライト') +
          `<div class="text-xs leading-relaxed text-slate-200">${renderBody(r.jp_summary) || '<span class="text-slate-400">情報がありません。</span>'}</div>` +
          topicsHtml(r.jp_topics)
      )
    );
    set(
      'meta-en',
      card(
        sectionHead('globe', '🌎 海外環境ハイライト') +
          `<div class="text-xs leading-relaxed text-slate-200">${renderBody(r.en_summary) || '<span class="text-slate-400">情報がありません。</span>'}</div>` +
          topicsHtml(r.en_topics)
      )
    );

    // ---- 差分 ----
    if (r.diff_summary) {
      set(
        'meta-diff',
        card(
          sectionHead('code-compare', '日本と海外の違い') +
            `<div class="text-xs leading-relaxed text-slate-200">${renderBody(r.diff_summary)}</div>`
        )
      );
    }

    // ---- 注目カード（画像つき）----
    renderSpotlight(r.spotlight_cards || []);

    // ---- 公式リンク（公式のみ）----
    renderLinks(r.official_links || [], r.upcoming_summary);

    // ---- メタシェア表 ----
    renderSnapshot('jp', 'meta-snap-jp', '📊 日本のメタシェア');
    renderSnapshot('en', 'meta-snap-en', '📊 海外のメタシェア');

    // ---- デッキレシピ ----
    renderDecks();
  }

  function topicsHtml(topics) {
    const list = topics || [];
    if (!list.length) return '';
    return (
      `<ul class="mt-3 space-y-2 border-t border-slate-700/70 pt-2.5">` +
      list
        .map(function (t) {
          const tag = TAG_STYLE[t.tag] || 'bg-slate-700 text-slate-300';
          return (
            `<li>` +
            `<p class="text-xs font-semibold text-slate-100 flex items-start gap-1.5">` +
            `<span class="shrink-0 px-1.5 py-0.5 rounded text-[9px] ${tag}">${esc(t.tag || '')}</span>` +
            `<span>${esc(t.title)}</span></p>` +
            `<p class="text-[11px] text-slate-300 leading-relaxed mt-0.5">${renderBody(t.body)}</p>` +
            `</li>`
          );
        })
        .join('') +
      `</ul>`
    );
  }

  async function renderCountdown() {
    const host = document.getElementById('meta-countdown');
    if (!host) return;
    let ev;
    try {
      ev = await apiGet('/api/meta/events?scope=upcoming&limit=6');
    } catch (_) {
      host.innerHTML = '';
      return;
    }
    const list = (ev && ev.events) || [];
    if (!list.length) {
      host.innerHTML = '';
      return;
    }

    host.innerHTML = card(
      sectionHead('calendar-days', '📅 これからの予定') +
        `<div class="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">` +
        list
          .map(function (e) {
            const near = e.days_until != null && e.days_until <= 7;
            const badge =
              e.days_until === 0
                ? `<span class="px-2 py-0.5 rounded bg-amber-500 text-slate-900 text-[10px] font-bold">本日</span>`
                : e.days_until > 0
                  ? `<span class="px-2 py-0.5 rounded ${near ? 'bg-amber-600 text-white' : 'bg-slate-700 text-slate-200'} text-[10px] font-bold">あと${e.days_until}日</span>`
                  : '';
            const link =
              e.url && isOfficial(e.url)
                ? `<a href="${esc(e.url)}" target="_blank" rel="noopener noreferrer" class="text-sky-400 hover:text-sky-300 text-[10px] underline">公式告知<i class="fas fa-external-link-alt ml-1 text-[8px]"></i></a>`
                : '';
            return (
              `<article class="bg-slate-800/60 rounded border border-slate-700 p-2.5">` +
              `<div class="flex items-start justify-between gap-2 mb-1">` +
              `<h3 class="text-xs font-semibold text-slate-100 leading-snug">${esc(e.name)}</h3>${badge}</div>` +
              `<p class="text-[10px] text-slate-400">` +
              `${esc(fmtDateFull(e.held_on))}` +
              (e.region === 'en' ? ' ・海外' : '') +
              (e.players ? ` ・参加${e.players}人` : '') +
              `</p>` +
              (link ? `<p class="mt-1">${link}</p>` : '') +
              `</article>`
            );
          })
          .join('') +
        `</div>`
    );
  }

  function renderSpotlight(cards) {
    const host = document.getElementById('meta-spotlight');
    if (!host) return;
    const list = (cards || []).filter((c) => c.card_name);
    if (!list.length) {
      host.innerHTML = '';
      return;
    }
    host.innerHTML = card(
      sectionHead('star', '🃏 今日の注目カード', '採用率に基づく自動選出') +
        `<div class="grid gap-3 grid-cols-2 sm:grid-cols-3 lg:grid-cols-5">` +
        list
          .map(function (c) {
            const img = c.image_url
              ? `<img src="${esc(c.image_url)}" alt="${esc(c.card_name)}" loading="lazy" decoding="async"` +
                ` referrerpolicy="no-referrer-when-downgrade" class="w-full rounded-md shadow-lg"` +
                ` onerror="this.style.display='none'">`
              : `<div class="aspect-[5/7] rounded-md bg-slate-800 grid place-items-center text-slate-600"><i class="fas fa-image"></i></div>`;
            const wrapped = c.card_file
              ? `<a href="/cards/${encodeURIComponent(c.card_file)}">${img}</a>`
              : img;
            return (
              `<article>` +
              wrapped +
              `<p class="text-[11px] font-semibold mt-1.5 text-slate-100 leading-snug">${cardLink(c)}</p>` +
              (c.adoption
                ? `<p class="text-[10px] text-amber-300">採用率 ${Number(c.adoption).toFixed(1)}%` +
                  (c.deck_count ? `<span class="text-slate-500 ml-1">(${c.deck_count}件)</span>` : '') +
                  `</p>`
                : '') +
              (c.note
                ? `<p class="text-[10px] text-slate-400 leading-relaxed mt-0.5">${esc(c.note)}</p>`
                : '') +
              `</article>`
            );
          })
          .join('') +
        `</div>`
    );
  }

  function renderLinks(links, upcomingSummary) {
    const host = document.getElementById('meta-links');
    if (!host) return;
    const list = (links || []).filter((l) => l.url && isOfficial(l.url));
    let html = '';

    if (upcomingSummary) {
      html +=
        card(
          sectionHead('bullhorn', '今後の見通し') +
            `<div class="text-xs leading-relaxed text-slate-200">${renderBody(upcomingSummary)}</div>`
        ) + '<div class="h-3"></div>';
    }

    if (list.length) {
      html += card(
        sectionHead('link', '公式情報リンク', '出典を明示できるのは公式情報のみ') +
          `<ul class="space-y-1.5">` +
          list
            .map(function (l) {
              return (
                `<li class="text-xs flex items-start gap-2">` +
                `<span class="shrink-0 text-[10px] text-slate-500 mt-0.5">${esc(fmtDate(l.date))}</span>` +
                `<a href="${esc(l.url)}" target="_blank" rel="noopener noreferrer"` +
                ` class="text-sky-400 hover:text-sky-300 underline">${esc(l.label)}` +
                `<i class="fas fa-external-link-alt ml-1 text-[9px]"></i></a>` +
                (l.region === 'en'
                  ? `<span class="shrink-0 text-[9px] px-1 rounded bg-slate-700 text-slate-300">EN</span>`
                  : '') +
                `</li>`
              );
            })
            .join('') +
          `</ul>`
      );
    }
    host.innerHTML = html;
  }

  async function renderSnapshot(region, elId, title) {
    const host = document.getElementById(elId);
    if (!host) return;
    let d;
    try {
      d = await apiGet(`/api/meta/snapshot?region=${region}&kind=ink_pair&limit=8`);
    } catch (_) {
      host.innerHTML = '';
      return;
    }
    const rows = (d && d.rows) || [];
    if (!rows.length) {
      host.innerHTML = '';
      return;
    }
    const w = d.window;
    const sub = w ? `${fmtDate(w.from)}〜${fmtDate(w.to)}の集計` : '';

    host.innerHTML = card(
      sectionHead('chart-simple', title, sub) +
        `<table class="w-full text-xs">` +
        `<thead><tr class="text-[10px] text-slate-400 border-b border-slate-700">` +
        `<th class="text-left font-normal pb-1">インク組合せ</th>` +
        `<th class="text-right font-normal pb-1 w-20">シェア</th>` +
        `<th class="text-right font-normal pb-1 w-12">件数</th></tr></thead><tbody>` +
        rows
          .map(function (r) {
            const bar = Math.max(2, Math.min(100, Number(r.share)));
            return (
              `<tr class="border-b border-slate-800/70">` +
              `<td class="py-1.5">${inkPairChips(r.label)}` +
              `<div class="mt-1 h-1 rounded bg-slate-800 overflow-hidden">` +
              `<div class="h-full bg-gradient-to-r from-amber-500 to-sky-500" style="width:${bar}%"></div></div></td>` +
              `<td class="text-right align-top py-1.5 font-semibold text-slate-100">${Number(r.share).toFixed(1)}%${deltaBadge(r.share_delta)}</td>` +
              `<td class="text-right align-top py-1.5 text-slate-400">${r.deck_count}</td>` +
              `</tr>`
            );
          })
          .join('') +
        `</tbody></table>` +
        `<p class="text-[10px] text-slate-500 mt-2">` +
        `シェアは大会順位で重み付けした自前集計（優勝5・準優勝4・TOP4:3・TOP8:2・その他1）。</p>`
    );
  }

  async function renderDecks() {
    const host = document.getElementById('meta-decks');
    if (!host) return;
    let d;
    try {
      d = await apiGet('/api/meta/decks?jp_only=1&limit=6');
    } catch (_) {
      host.innerHTML = '';
      return;
    }
    const list = (d && d.decks) || [];
    if (!list.length) {
      host.innerHTML = '';
      return;
    }

    host.innerHTML = card(
      sectionHead('layer-group', '🃏 注目デッキレシピ', '日本語版カードで構築できるもののみ') +
        `<div class="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">` +
        list.map(deckCardHtml).join('') +
        `</div>` +
        `<p class="mt-3 text-center"><a href="/deck#meta-recipes" class="text-xs text-sky-300 hover:text-sky-200 underline">` +
        `デッキタブでレシピ一覧を見る（${d.total}件）<i class="fas fa-arrow-right ml-1"></i></a></p>`
    );
  }

  /** デッキカード。出典URLの明記は仕様§1.3の例外として必須 */
  function deckCardHtml(dk) {
    const inks = [dk.ink1, dk.ink2].filter(Boolean).map(inkChip).join(' ');
    const place = dk.placement
      ? `<span class="px-1.5 py-0.5 rounded bg-amber-900/60 text-amber-200 text-[9px] font-bold">${esc(dk.placement)}</span>`
      : '';
    const src = dk.source_url
      ? `<a href="${esc(dk.source_url)}" target="_blank" rel="noopener noreferrer nofollow"` +
        ` class="text-slate-400 hover:text-slate-200 underline text-[9px]">` +
        `出典: ${esc(dk.source_label || '外部サイト')}<i class="fas fa-external-link-alt ml-1 text-[8px]"></i></a>`
      : '';
    return (
      `<article class="bg-slate-800/60 rounded border border-slate-700 p-2.5">` +
      `<div class="flex items-start justify-between gap-2 mb-1">` +
      `<h3 class="text-xs font-semibold text-slate-100 leading-snug">` +
      `<a href="/deck?meta=${dk.id}" class="hover:text-amber-300">${esc(dk.name || 'デッキ')}</a></h3>${place}</div>` +
      `<p class="mb-1">${inks}</p>` +
      `<p class="text-[10px] text-slate-400">` +
      (dk.event_name ? `${esc(dk.event_name)} ・ ` : '') +
      `${esc(fmtDate(dk.observed_at))} ・ ${dk.total_cards}枚</p>` +
      (src ? `<p class="mt-1">${src}</p>` : '') +
      `</article>`
    );
  }

  window.initMetaWidget = initMetaWidget;
  window.initMetaPage = initMetaPage;
  // デッキタブから再利用する
  window.LorMeta = { deckCardHtml, inkChip, isOfficial, fmtDate, fmtDateFull, cardLink };
})();
