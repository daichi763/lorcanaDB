/**
 * page-rules.js — 公式ルールブラウザ（BUILD_SPEC §8）
 *
 * - 目次を左サイドバー、検索結果を右に表示
 * - 検索は全文書横断
 * - 本文の常時全公開は避け、ヒット周辺の抜粋のみ表示 → 続きは公式PDFへ誘導
 * - 各セクションに「公式PDFで開く（該当ページ）」ボタン（#page=N フラグメント付き）
 */
window.initRulesPage = function () {
  const A = window.LorApp;
  const { $, $$, esc, apiGet } = A;

  const SOURCE_LABEL = {
    comprehensive: '総合ルール',
    guidelines: 'プレイ修正ガイドライン',
    tournament: '大会ルール',
    set_notes_s1: 'セットノート S1',
    playsheet: 'プレイシート',
  };

  function highlight(text, q) {
    if (!q) return esc(text);
    const parts = String(text).split(q);
    return parts.map(esc).join(`<mark class="bg-amber-400/30 text-amber-100 px-0.5 rounded">${esc(q)}</mark>`);
  }

  function pdfLink(url, page) {
    const href = page ? `${url}#page=${page}` : url;
    return (
      `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer"
          class="inline-flex items-center gap-1 text-[11px] px-2 py-1 bg-slate-800 hover:bg-slate-700 text-sky-300 rounded">
         <i class="fas fa-file-pdf"></i>公式PDFで開く${page ? `（P.${page}）` : ''}
       </a>`
    );
  }

  async function search() {
    const q = $('#rules-query').value.trim();
    const source = $('#rules-source').value;
    if (!q) {
      $('#rules-results').innerHTML =
        `<p class="text-center text-slate-500 py-10 text-sm">
           <i class="fas fa-keyboard block text-2xl mb-2 opacity-40"></i>
           検索したいルール用語を入力してください。
         </p>`;
      return;
    }

    $('#rules-results').innerHTML = '<div class="space-y-3">' + '<div class="h-24 skeleton rounded-lg"></div>'.repeat(4) + '</div>';

    const p = new URLSearchParams();
    p.set('q', q);
    if (source) p.set('source', source);
    history.replaceState(null, '', location.pathname + '?' + p.toString());

    let data;
    try {
      data = await apiGet('/api/rules/search?' + p.toString());
    } catch {
      $('#rules-results').innerHTML = '<p class="text-rose-300 py-6 text-center">検索に失敗しました。</p>';
      return;
    }

    if (!data.results.length) {
      $('#rules-results').innerHTML =
        `<div class="text-center py-10 text-slate-400 text-sm">
           <i class="fas fa-inbox block text-2xl mb-2 opacity-40"></i>
           「${esc(q)}」に一致するルールが見つかりませんでした。
         </div>`;
      return;
    }

    $('#rules-results').innerHTML =
      `<p class="text-xs text-slate-400 mb-3">${data.results.length} 件のセクションがヒットしました。</p>
       <div class="space-y-3">
         ${data.results
           .map(
             (r) =>
               `<article class="bg-slate-900 border border-slate-700 rounded-lg p-3.5">
                  <div class="flex items-start justify-between gap-3 mb-1.5">
                    <div class="min-w-0">
                      <span class="text-[10px] px-1.5 py-0.5 bg-slate-800 text-slate-400 rounded">
                        ${esc(SOURCE_LABEL[r.source] || r.source_label || r.source)}
                      </span>
                      <span class="text-[11px] font-mono text-amber-300 ml-1.5">${esc(r.section)}</span>
                    </div>
                    ${pdfLink(r.pdf_url, r.page_no)}
                  </div>
                  ${r.heading ? `<h3 class="text-sm font-semibold mb-1.5 leading-snug">${highlight(r.heading, q)}</h3>` : ''}
                  <p class="text-xs text-slate-300 leading-relaxed whitespace-pre-wrap">${highlight(r.snippet, q)}</p>
                  ${r.truncated
                    ? `<p class="mt-2 text-[10px] text-slate-500">
                         <i class="fas fa-circle-info mr-1"></i>
                         この抜粋は検索語の周辺のみです。続きは公式PDFをご確認ください。
                       </p>`
                    : ''}
                </article>`
           )
           .join('')}
       </div>`;
  }

  async function loadToc() {
    let data;
    try {
      data = await apiGet('/api/rules/toc');
    } catch {
      $('#rules-toc').innerHTML = '<p class="text-slate-500 p-2">目次を取得できませんでした。</p>';
      return;
    }

    const bySource = {};
    for (const s of data.sections) {
      (bySource[s.source] = bySource[s.source] || []).push(s);
    }

    $('#rules-toc').innerHTML = Object.entries(bySource)
      .map(
        ([src, list]) =>
          `<details class="mb-1" ${src === 'comprehensive' ? 'open' : ''}>
             <summary class="cursor-pointer font-bold text-slate-300 py-1 px-1 hover:bg-slate-800 rounded">
               ${esc(SOURCE_LABEL[src] || src)}
               <span class="font-normal text-slate-500">(${list.length})</span>
             </summary>
             <ul class="pl-1 space-y-0.5 mt-1">
               ${list
                 .slice(0, 400)
                 .map(
                   (s) =>
                     `<li>
                        <button data-section-id="${s.id}"
                                class="js-toc w-full text-left px-1.5 py-1 rounded hover:bg-slate-800 flex gap-1.5">
                          <span class="font-mono text-amber-300/80 shrink-0">${esc(s.section)}</span>
                          <span class="truncate text-slate-400">${esc(s.heading || '')}</span>
                        </button>
                      </li>`
                 )
                 .join('')}
             </ul>
           </details>`
      )
      .join('');

    $('#rules-toc').addEventListener('click', async (e) => {
      const btn = e.target.closest('.js-toc');
      if (!btn) return;
      const r = await apiGet('/api/rules/section/' + btn.dataset.sectionId);
      $('#rules-results').innerHTML =
        `<article class="bg-slate-900 border border-slate-700 rounded-lg p-4">
           <div class="flex items-start justify-between gap-3 mb-2">
             <div>
               <span class="text-[10px] px-1.5 py-0.5 bg-slate-800 text-slate-400 rounded">
                 ${esc(SOURCE_LABEL[r.source] || r.source_label)}
               </span>
               <span class="text-xs font-mono text-amber-300 ml-1.5">${esc(r.section)}</span>
             </div>
             ${pdfLink(r.pdf_url, r.page_no)}
           </div>
           ${r.heading ? `<h3 class="text-base font-semibold mb-2 leading-snug">${esc(r.heading)}</h3>` : ''}
           <p class="text-sm text-slate-300 leading-relaxed whitespace-pre-wrap">${esc(r.body)}</p>
           ${r.truncated
             ? `<div class="mt-3 p-2.5 bg-amber-950/30 border border-amber-800/50 rounded text-[11px] text-amber-200">
                  <i class="fas fa-circle-info mr-1"></i>
                  当サイトではルール本文の全文を掲載していません。この続きは公式PDFでご確認ください。
                </div>`
             : ''}
         </article>`;
    });
  }

  $('#rules-search-btn').addEventListener('click', search);
  $('#rules-query').addEventListener('keydown', (e) => { if (e.key === 'Enter') search(); });
  $('#rules-source').addEventListener('change', () => { if ($('#rules-query').value.trim()) search(); });

  (function boot() {
    loadToc();
    const q = new URLSearchParams(location.search).get('q');
    const src = new URLSearchParams(location.search).get('source');
    if (src) $('#rules-source').value = src;
    if (q) { $('#rules-query').value = q; search(); }
    else search();
  })();
};
