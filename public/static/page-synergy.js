/**
 * page-synergy.js — シナジー探索（AI探索 + 種族逆引き）
 *
 *  タブ1: AIシナジー探索
 *    起点カード（オートコンプリート）と/または自由記述を投げ、
 *    サーバ側でD1候補抽出 → LLM順位付けした結果を表示する。
 *  タブ2: 種族逆引き（BUILD_SPEC §7-1 の既存機能）
 *    「効果テキストが種族Xを参照するカード」⇄「種族Xを持つカード」
 */
window.initSynergyPage = function () {
  // 二重初期化ガード（イベントリスナと内部状態が二重化するのを防ぐ）
  if (window.__synergyInited) return;
  window.__synergyInited = true;

  const A = window.LorApp;
  const { $, $$, esc, debounce, apiGet, apiPost, cardTile, cardImage, inkChips, statBadges, INK_COLORS } = A;
  const { renderRulesText } = window.LorIcons;

  // ==================== タブ切替 ====================
  function initTabs() {
    $$('.synergy-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        $$('.synergy-tab').forEach((t) => {
          const on = t === tab;
          t.setAttribute('aria-selected', String(on));
          t.classList.toggle('border-amber-400', on);
          t.classList.toggle('text-amber-300', on);
          t.classList.toggle('border-transparent', !on);
          t.classList.toggle('text-slate-400', !on);
          const panel = document.getElementById(t.dataset.panel);
          if (panel) panel.classList.toggle('hidden', !on);
        });
        const p = new URLSearchParams(location.search);
        p.set('tab', tab.id === 'tab-ai' ? 'ai' : 'class');
        history.replaceState(null, '', location.pathname + '?' + p.toString());
      });
    });
  }

  function activateTab(id) {
    const tab = document.getElementById(id);
    if (tab) tab.click();
  }

  // ==================== AI探索 ====================
  const aiState = { card: null, inks: [] };

  function renderInkFilter() {
    const box = $('#ai-ink-filter');
    if (!box) return;
    box.innerHTML = INK_COLORS.map(
      (i) =>
        `<button class="js-ai-ink text-[11px] px-2 py-1 rounded-full border transition ` +
        `border-slate-600 bg-slate-800 text-slate-300 hover:bg-slate-700" data-ink="${esc(i)}" aria-pressed="false">` +
        `<span class="ink-chip ink-${esc(i)} mr-1"></span>${esc(i)}</button>`
    ).join('');

    box.addEventListener('click', (e) => {
      const btn = e.target.closest('.js-ai-ink');
      if (!btn) return;
      const ink = btn.dataset.ink;
      const i = aiState.inks.indexOf(ink);
      if (i >= 0) aiState.inks.splice(i, 1);
      else {
        if (aiState.inks.length >= 2) {
          // ロルカナは1デッキ2色まで。古い方を外す
          aiState.inks.shift();
        }
        aiState.inks.push(ink);
      }
      $$('.js-ai-ink', box).forEach((b) => {
        const on = aiState.inks.indexOf(b.dataset.ink) >= 0;
        b.setAttribute('aria-pressed', String(on));
        b.classList.toggle('bg-sky-700', on);
        b.classList.toggle('border-sky-500', on);
        b.classList.toggle('text-white', on);
        b.classList.toggle('bg-slate-800', !on);
        b.classList.toggle('border-slate-600', !on);
        b.classList.toggle('text-slate-300', !on);
      });
    });
  }

  function renderPickedCard() {
    const box = $('#ai-card-picked');
    if (!box) return;
    if (!aiState.card) {
      box.innerHTML = '<p class="text-[11px] text-slate-500">未選択（自由記述だけでも探索できます）</p>';
      return;
    }
    const c = aiState.card;
    box.innerHTML =
      `<div class="flex gap-2.5 items-start p-2 bg-slate-800/70 border border-sky-700/60 rounded-lg">` +
      `<div class="w-14 shrink-0">${cardImage(c)}</div>` +
      `<div class="min-w-0 flex-1">` +
      `<div class="flex items-center gap-1.5 flex-wrap">${inkChips(c)}` +
      `<span class="font-bold text-sm truncate">${esc(c.card_name)}</span>` +
      (c.version ? `<span class="text-[11px] text-slate-400 truncate">/ ${esc(c.version)}</span>` : '') +
      `</div>` +
      `<div class="text-[11px] text-slate-400 mt-0.5">${esc(c.card_type || '')} · ${esc(c.sets_name || '')}</div>` +
      `</div>` +
      `<button id="ai-card-clear" class="w-7 h-7 rounded bg-slate-700 hover:bg-slate-600 grid place-items-center shrink-0" aria-label="起点カードを解除">` +
      `<i class="fas fa-times text-xs"></i></button></div>`;

    $('#ai-card-clear').addEventListener('click', () => {
      aiState.card = null;
      $('#ai-card-input').value = '';
      renderPickedCard();
    });
  }

  function initCardPicker() {
    const input = $('#ai-card-input');
    const list = $('#ai-card-suggest');
    if (!input || !list) return;

    const hide = () => list.classList.add('hidden');

    const search = debounce(async () => {
      const q = input.value.trim();
      if (q.length < 1) return hide();
      let data;
      try {
        data = await apiGet('/api/ai/card-suggest?q=' + encodeURIComponent(q));
      } catch {
        return hide();
      }
      if (!data.cards.length) {
        list.innerHTML = '<p class="p-3 text-xs text-slate-500">該当するカードがありません。</p>';
        list.classList.remove('hidden');
        return;
      }
      list.innerHTML = data.cards
        .map(
          (c) =>
            `<button class="js-suggest w-full flex items-center gap-2 px-2.5 py-2 hover:bg-slate-700 text-left" ` +
            `role="option" data-card='${esc(JSON.stringify(c))}'>` +
            `<span class="flex gap-0.5 shrink-0">${inkChips(c)}</span>` +
            `<span class="min-w-0 flex-1"><span class="block text-[13px] font-semibold truncate">${esc(c.card_name)}</span>` +
            (c.version ? `<span class="block text-[10px] text-slate-400 truncate">${esc(c.version)}</span>` : '') +
            `</span>` +
            `<span class="text-[10px] text-slate-500 shrink-0">${esc(c.card_type || '')}${c.ink_cost != null ? ' ' + c.ink_cost : ''}</span>` +
            `</button>`
        )
        .join('');
      list.classList.remove('hidden');
    }, 250);

    input.addEventListener('input', search);
    input.addEventListener('focus', () => {
      if (input.value.trim()) search();
    });

    list.addEventListener('click', (e) => {
      const btn = e.target.closest('.js-suggest');
      if (!btn) return;
      try {
        aiState.card = JSON.parse(btn.dataset.card);
      } catch {
        return;
      }
      input.value = aiState.card.card_name;
      hide();
      renderPickedCard();
    });

    document.addEventListener('click', (e) => {
      if (!e.target.closest('#ai-card-input') && !e.target.closest('#ai-card-suggest')) hide();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') hide();
      if (e.key === 'Enter') {
        e.preventDefault();
        const first = $('.js-suggest', list);
        if (first && !list.classList.contains('hidden')) first.click();
      }
    });
  }

  const scoreColor = (s) =>
    s >= 85 ? 'text-amber-300 border-amber-500/60 bg-amber-950/40'
      : s >= 70 ? 'text-emerald-300 border-emerald-600/60 bg-emerald-950/40'
      : s >= 50 ? 'text-sky-300 border-sky-600/60 bg-sky-950/40'
      : 'text-slate-400 border-slate-600 bg-slate-800/60';

  function aiResultCard(item, rank) {
    const c = item.card;
    const cls = (c.classifications || []).map(esc).join('・');
    const ab = (c.abilities || []).map(esc).join('・');
    return (
      `<article class="card-tile flex gap-3 p-2.5 bg-slate-900 rounded-lg border border-slate-700 hover:border-slate-500 transition"
                data-file="${esc(c.card_file)}" data-id="${c.id}">
         <div class="shrink-0 w-1 flex flex-col items-center">
           <span class="text-[10px] font-bold text-slate-500">${rank}</span>
         </div>
         <a href="/cards/${encodeURIComponent(c.card_file)}" class="w-20 shrink-0">${cardImage(c)}</a>
         <div class="min-w-0 flex-1">
           <div class="flex items-start gap-2">
             <div class="min-w-0 flex-1">
               <div class="flex items-center gap-1.5 flex-wrap">
                 <span class="flex gap-0.5">${inkChips(c)}</span>
                 <a href="/cards/${encodeURIComponent(c.card_file)}" class="font-bold text-sm hover:text-amber-300">${esc(c.card_name)}</a>
                 ${c.version ? `<span class="text-[11px] text-slate-400">/ ${esc(c.version)}</span>` : ''}
                 <span class="text-[10px] px-1.5 py-0.5 bg-slate-800 rounded">${esc(c.rarity || '')}</span>
               </div>
               <div class="flex items-center gap-1.5 text-[11px] font-semibold mt-0.5">${statBadges(c)}
                 <span class="text-slate-500 font-normal">· ${esc(c.card_type)}</span>
                 ${cls ? `<span class="text-slate-500 font-normal">· ${cls}</span>` : ''}
               </div>
             </div>
             <div class="shrink-0 flex flex-col items-end gap-1">
               <span class="px-2 py-0.5 rounded-full border text-[11px] font-bold ${scoreColor(item.score)}" title="シナジー度">
                 ${item.score}
               </span>
               ${item.role ? `<span class="text-[10px] px-1.5 py-0.5 bg-slate-800 border border-slate-600 rounded text-slate-300">${esc(item.role)}</span>` : ''}
             </div>
           </div>

           ${item.reason
             ? `<p class="mt-1.5 text-[12px] text-slate-200 leading-relaxed bg-slate-800/50 border-l-2 border-amber-500/70 pl-2 py-1 rounded-r">
                  <i class="fas fa-wand-magic-sparkles text-amber-400/80 text-[10px] mr-1"></i>${esc(item.reason)}
                </p>`
             : ''}

           ${c.rules_text
             ? `<details class="mt-1.5 group">
                  <summary class="text-[10px] text-slate-500 cursor-pointer hover:text-slate-300 select-none">効果テキストを見る</summary>
                  <p class="rules-text text-[11px] text-slate-300 mt-1">${renderRulesText(c.rules_text)}</p>
                </details>`
             : ''}

           <div class="flex flex-wrap gap-1 mt-1.5 items-center">
             ${ab ? `<span class="text-[9px] px-1.5 py-0.5 bg-indigo-950/70 border border-indigo-800 rounded text-indigo-200">KW ${ab}</span>` : ''}
             ${(item.mechanics || []).map((m) => `<span class="text-[9px] px-1.5 py-0.5 bg-slate-800 border border-slate-700 rounded text-slate-400">${esc(m)}</span>`).join('')}
             ${(item.db_signals || []).map((s) => `<span class="text-[9px] px-1.5 py-0.5 bg-emerald-950/50 border border-emerald-900 rounded text-emerald-300/90" title="DB上の根拠"><i class="fas fa-database mr-0.5"></i>${esc(s)}</span>`).join('')}
           </div>
         </div>
         <div class="flex flex-col gap-1 shrink-0">
           <button class="js-zoom w-7 h-7 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 grid place-items-center"
                   data-img="${esc(c.image_url)}" data-name="${esc(c.card_name)}" title="拡大表示" aria-label="拡大表示">
             <i class="fas fa-expand text-xs"></i></button>
           <button class="js-fav w-7 h-7 rounded bg-slate-800 hover:bg-slate-700 ${A.favorites.has(c.card_file) ? 'text-amber-300' : 'text-slate-400'} grid place-items-center"
                   title="お気に入り" aria-label="お気に入り" aria-pressed="${A.favorites.has(c.card_file)}">
             <i class="fa-star ${A.favorites.has(c.card_file) ? 'fas' : 'far'} text-xs"></i></button>
           <button class="js-ai-rebase w-7 h-7 rounded bg-slate-800 hover:bg-sky-700 text-slate-300 grid place-items-center"
                   data-file="${esc(c.card_file)}" data-name="${esc(c.card_name)}" title="このカードを起点に再探索" aria-label="このカードを起点に再探索">
             <i class="fas fa-rotate text-xs"></i></button>
         </div>
       </article>`
    );
  }

  function renderAiResult(d) {
    const box = $('#ai-result');
    if (!d.results.length) {
      box.innerHTML =
        `<div class="p-6 text-center bg-slate-900/60 border border-slate-700 rounded-lg">
           <i class="fas fa-magnifying-glass text-2xl text-slate-600 mb-2"></i>
           <p class="text-sm text-slate-300">${esc(d.summary || '該当する組み合わせが見つかりませんでした。')}</p>
           <p class="text-[11px] text-slate-500 mt-1">語を変える、起点カードを指定する、インク色の絞りを外すなどをお試しください。</p>
         </div>`;
      return;
    }

    const head =
      `<div class="mb-4 p-3.5 bg-gradient-to-br from-slate-900 to-slate-900/40 border border-amber-800/40 rounded-lg">
         <h2 class="text-sm font-bold mb-1.5 text-amber-200">
           <i class="fas fa-lightbulb mr-1.5"></i>AIの見立て
           ${d.cached ? '<span class="ml-1.5 text-[10px] font-normal px-1.5 py-0.5 bg-slate-800 border border-slate-600 rounded text-slate-400">キャッシュ</span>' : ''}
         </h2>
         <p class="text-[13px] text-slate-200 leading-relaxed whitespace-pre-wrap">${esc(d.summary || '')}</p>
         ${(d.axes || []).length
           ? `<div class="flex flex-wrap gap-1.5 mt-2.5">
                ${d.axes.map((a) => `<span class="text-[11px] px-2 py-0.5 bg-fuchsia-950/60 border border-fuchsia-800 rounded-full text-fuchsia-200">${esc(a)}</span>`).join('')}
              </div>`
           : ''}
         ${(d.caveats || []).length
           ? `<ul class="mt-2.5 pt-2 border-t border-slate-700/70 space-y-1">
                ${d.caveats.map((x) => `<li class="text-[11px] text-amber-100/80"><i class="fas fa-triangle-exclamation text-amber-500/80 mr-1"></i>${esc(x)}</li>`).join('')}
              </ul>`
           : ''}
         ${(() => {
           // 事前に構築した「記憶」のどれを使ったかを明示する（速度と精度の根拠を見せる）
           const m = d.memory || {};
           const tags = [];
           if (m.vector_search) tags.push('<i class="fas fa-vector-square mr-1"></i>意味ベクトル検索');
           if (m.ability_knowledge) tags.push(`<i class="fas fa-book-open mr-1"></i>能力裁定 ${m.ability_knowledge} 件（事前学習済み）`);
           if (m.recalled) {
             // カード指定時は「同じカードでの過去の検討」、自由記述だけのときは
             // 「別の相談で高評価だった事例」。同じ文言にすると後者を実績と誤解させる
             tags.push(
               d.base
                 ? `<i class="fas fa-brain mr-1"></i>過去の検討 ${m.recalled} 件を参照`
                 : `<i class="fas fa-brain mr-1"></i>他の相談での高評価 ${m.recalled} 件を参考`
             );
           }
           if (m.official_faqs) tags.push(`<i class="fas fa-circle-question mr-1"></i>公式Q&amp;A ${m.official_faqs} 件を根拠に`);
           // 環境情報は「賞味期限のある知識」なので、参照したことと基準日を必ず見せる
           if (m.meta_context) {
             const asOf = d.meta && d.meta.as_of ? `（${esc(d.meta.as_of)}時点）` : '';
             tags.push(`<i class="fas fa-chart-line mr-1"></i>最新環境情報 ${m.meta_context} 件${asOf}`);
           }
           return tags.length
             ? `<div class="flex flex-wrap gap-1.5 mt-2.5 pt-2 border-t border-slate-700/70">
                  ${tags.map((t) => `<span class="text-[10px] px-2 py-0.5 bg-emerald-950/50 border border-emerald-800/60 rounded-full text-emerald-200">${t}</span>`).join('')}
                </div>`
             : '';
         })()}
         <p class="mt-2 text-[10px] text-slate-500">
           DB候補 ${d.candidate_count} 枚から選定${d.rule_context_count ? ` / 総合ルール ${d.rule_context_count} 項目を参照` : ''}${d.model ? ` / ${esc(d.model)}` : ''}
           ${d.intent_detail && (d.intent_detail.keywords || []).length
             ? ` / 抽出語: ${d.intent_detail.keywords.map(esc).join('、')}`
             : ''}
         </p>
       </div>`;

    // 推論の根拠に使った公式Q&Aを開閉で提示する。
    // 「なぜこの判断なのか」をユーザーが公式情報で検証できるようにする。
    const faqBlock = (d.official_faqs || []).length
      ? `<details class="mt-3 bg-slate-900/60 border border-slate-700/70 rounded-lg">
           <summary class="cursor-pointer px-3 py-2 text-[12px] text-slate-300 hover:text-slate-100">
             <i class="fas fa-circle-question text-sky-300 mr-1.5"></i>参照した公式Q&amp;A
             <span class="text-slate-500">${d.official_faqs.length} 件</span>
           </summary>
           <div class="px-3 pb-3 space-y-2">
             ${d.official_faqs
               .map(
                 (f) => `<div class="text-[11px] leading-relaxed border-l-2 border-sky-800/70 pl-2">
                   <div class="text-slate-200"><span class="text-[10px] px-1.5 py-0.5 bg-slate-800 rounded text-slate-400 mr-1">${esc(f.category || '')}</span>Q. ${esc(f.question || '')}</div>
                   <div class="text-slate-400 mt-0.5">A. ${esc(f.answer || '')}</div>
                 </div>`
               )
               .join('')}
           </div>
           <p class="px-3 pb-2 text-[10px] text-slate-500">出典: タカラトミー公式サイトのルールQ&amp;A</p>
         </details>`
      : '';

    box.innerHTML =
      head +
      `<h3 class="text-sm font-bold mb-2">
         <i class="fas fa-list-ol text-sky-300 mr-1.5"></i>シナジー候補
         <span class="text-xs font-normal text-slate-500">${d.results.length} 枚</span>
       </h3>
       <div class="space-y-2">${d.results.map((r, i) => aiResultCard(r, i + 1)).join('')}</div>` +
      faqBlock;
  }

  async function runAi() {
    const btn = $('#ai-run');
    const box = $('#ai-result');
    const text = $('#ai-text').value.trim();

    if (!aiState.card && !text) {
      box.innerHTML =
        '<div class="p-4 text-center text-xs text-amber-200 bg-amber-950/40 border border-amber-800/60 rounded-lg">' +
        'カードを選ぶか、やりたいことを入力してください。</div>';
      return;
    }

    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1.5"></i>探索中…';
    box.innerHTML =
      `<div class="p-4 bg-slate-900/60 border border-slate-700 rounded-lg">
         <p class="text-xs text-slate-400 mb-3"><i class="fas fa-brain mr-1"></i>記憶済みの意味ベクトルで候補120枚を選び、AIが噛み合いを検討しています（20〜40秒程度）…</p>
         <div class="space-y-2">${'<div class="h-24 skeleton rounded-lg"></div>'.repeat(4)}</div>
       </div>`;

    try {
      const d = await apiPost('/api/ai/synergy', {
        card_file: aiState.card ? aiState.card.card_file : '',
        text,
        restrict_ink: aiState.inks,
        want: Number($('#ai-want').value) || 12,
      });
      renderAiResult(d);
      // 共有可能なURLにする
      const p = new URLSearchParams();
      p.set('tab', 'ai');
      if (aiState.card) p.set('card', aiState.card.card_file);
      if (text) p.set('q', text);
      if (aiState.inks.length) p.set('ink', aiState.inks.join(','));
      history.replaceState(null, '', location.pathname + '?' + p.toString());
    } catch (e) {
      const msg = (e.payload && e.payload.message) || 'AI検索に失敗しました。';
      // 429（回数制限）以外はほぼ一時的な失敗なので、その場で再試行できるようにする
      const retryable = e.status !== 429;
      box.innerHTML =
        `<div class="p-4 bg-rose-950/40 border border-rose-800/60 rounded-lg text-sm text-rose-100">
           <i class="fas fa-circle-exclamation mr-1.5"></i>${esc(msg)}
           ${e.status === 429
             ? '<p class="text-[11px] text-rose-200/70 mt-1">AI検索は負荷が高いため回数を制限しています。</p>'
             : `<p class="text-[11px] text-rose-200/70 mt-1">一時的な失敗の可能性があります。条件はそのままで再試行できます。</p>
                <button class="js-ai-retry mt-2 px-3 py-1.5 rounded bg-rose-800/60 hover:bg-rose-700/60 text-xs font-bold">
                  <i class="fas fa-rotate-right mr-1"></i>再試行する
                </button>`}
         </div>`;
      if (retryable) {
        const rb = box.querySelector('.js-ai-retry');
        if (rb) rb.addEventListener('click', () => runAi());
      }
    } finally {
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-wand-magic-sparkles mr-1.5"></i>AIでシナジーを探す';
    }
  }

  function initAi() {
    if (!$('#ai-run')) return;
    renderInkFilter();
    renderPickedCard();
    initCardPicker();

    $('#ai-run').addEventListener('click', runAi);
    $('#ai-reset').addEventListener('click', () => {
      aiState.card = null;
      aiState.inks = [];
      $('#ai-card-input').value = '';
      $('#ai-text').value = '';
      renderInkFilter();
      renderPickedCard();
      $('#ai-result').innerHTML = '';
      history.replaceState(null, '', location.pathname + '?tab=ai');
    });

    $('#ai-examples').addEventListener('click', (e) => {
      const b = e.target.closest('.js-ai-example');
      if (!b) return;
      $('#ai-text').value = b.textContent.trim();
      $('#ai-text').focus();
    });

    // 提案カードを起点に再探索
    $('#ai-result').addEventListener('click', async (e) => {
      const b = e.target.closest('.js-ai-rebase');
      if (!b) return;
      try {
        const d = await apiGet('/api/ai/card-suggest?q=' + encodeURIComponent(b.dataset.name));
        const found = (d.cards || []).find((x) => x.card_file === b.dataset.file) || d.cards[0];
        if (found) {
          aiState.card = found;
          $('#ai-card-input').value = found.card_name;
          renderPickedCard();
        }
      } catch { /* noop */ }
      window.scrollTo({ top: 0, behavior: 'smooth' });
      runAi();
    });

    // AI利用可否の確認
    apiGet('/api/ai/status')
      .then((s) => {
        if (!s.available) {
          $('#ai-unavailable').classList.remove('hidden');
          $('#ai-run').disabled = true;
        }
      })
      .catch(() => {});
  }

  // ==================== 種族逆引き（既存機能）====================
  async function loadClassSynergy(cl) {
    if (!cl) {
      $('#synergy-result').innerHTML = '';
      return;
    }
    $('#synergy-result').innerHTML =
      '<div class="grid sm:grid-cols-2 gap-4">' +
      '<div class="h-40 skeleton rounded-lg"></div><div class="h-40 skeleton rounded-lg"></div></div>';

    const p = new URLSearchParams(location.search);
    p.set('tab', 'class');
    p.set('c', cl);
    history.replaceState(null, '', location.pathname + '?' + p.toString());

    let data;
    try {
      data = await apiGet('/api/synergy/' + encodeURIComponent(cl));
    } catch (e) {
      $('#synergy-result').innerHTML = '<div class="p-6 text-center text-rose-300">読み込みに失敗しました。</div>';
      return;
    }

    const grid = (cards) =>
      cards.length
        ? `<div class="grid grid-cols-2 md:grid-cols-3 gap-2.5">${cards.map((c) => cardTile(c, {})).join('')}</div>`
        : '<p class="text-center text-xs text-slate-500 py-8">該当するカードがありません。</p>';

    $('#synergy-result').innerHTML =
      `<div class="grid lg:grid-cols-2 gap-5">
         <section>
           <h2 class="text-sm font-bold mb-1">
             <i class="fas fa-arrow-right-to-bracket text-indigo-300 mr-1.5"></i>
             「${esc(cl)}」を参照する効果を持つカード
             <span class="text-xs font-normal text-slate-500">${data.referrers.length} 枚</span>
           </h2>
           <p class="text-[11px] text-slate-500 mb-2.5">
             効果テキスト中に「${esc(cl)}」が登場するカード。これらが軸になります。
           </p>
           ${grid(data.referrers)}
         </section>
         <section>
           <h2 class="text-sm font-bold mb-1">
             <i class="fas fa-users text-emerald-300 mr-1.5"></i>
             「${esc(cl)}」を持つカード
             <span class="text-xs font-normal text-slate-500">${data.holders.length} 枚</span>
           </h2>
           <p class="text-[11px] text-slate-500 mb-2.5">上記カードの効果対象になり得るカード群。</p>
           ${grid(data.holders)}
         </section>
       </div>`;
  }

  // ==================== 起動 ====================
  (async function boot() {
    initTabs();
    initAi();

    const params = new URLSearchParams(location.search);

    // --- 種族セレクトの構築 ---
    try {
      const masters = await apiGet('/api/masters');
      const refSet = new Map((masters.referenced_classifications || []).map((x) => [x.v, x.n]));
      const opts = (masters.classifications || [])
        .map((x) => ({ v: x.v, holders: x.n, refs: refSet.get(x.v) || 0 }))
        .sort((a, b) => b.refs - a.refs || b.holders - a.holders);

      $('#synergy-select').innerHTML =
        '<option value="">選択してください</option>' +
        opts
          .map((o) => `<option value="${esc(o.v)}">${esc(o.v)}（参照 ${o.refs} / 保有 ${o.holders}）</option>`)
          .join('');
      $('#synergy-select').addEventListener('change', (e) => loadClassSynergy(e.target.value));
    } catch { /* noop */ }

    // --- URLパラメータからの復元 ---
    const cl = params.get('c');
    const wantTab = params.get('tab');

    if (cl && wantTab !== 'ai') {
      activateTab('tab-class');
      $('#synergy-select').value = cl;
      loadClassSynergy(cl);
      return;
    }
    if (wantTab === 'class') {
      activateTab('tab-class');
      if (cl) {
        $('#synergy-select').value = cl;
        loadClassSynergy(cl);
      }
      return;
    }

    // AIタブ: card / q / ink を復元して自動実行
    const inkParam = params.get('ink');
    if (inkParam) {
      aiState.inks = inkParam.split(',').filter(Boolean).slice(0, 2);
      $$('.js-ai-ink').forEach((b) => {
        const on = aiState.inks.indexOf(b.dataset.ink) >= 0;
        b.setAttribute('aria-pressed', String(on));
        b.classList.toggle('bg-sky-700', on);
        b.classList.toggle('border-sky-500', on);
        b.classList.toggle('text-white', on);
        b.classList.toggle('bg-slate-800', !on);
        b.classList.toggle('text-slate-300', !on);
      });
    }

    const q = params.get('q');
    if (q) $('#ai-text').value = q;

    const cardParam = params.get('card');
    if (cardParam) {
      try {
        const d = await apiGet('/api/cards/' + encodeURIComponent(cardParam));
        aiState.card = d.card;
        $('#ai-card-input').value = d.card.card_name;
        renderPickedCard();
      } catch { /* noop */ }
    }

    if (cardParam || q) runAi();
  })();
};
