/**
 * page-synergy.js — シナジー探索（BUILD_SPEC §7-1）
 *
 * 「効果テキストが種族 X を参照するカード」⇄「種族 X を持つカード」を
 * 横並びで表示し、デッキの軸を発見しやすくする。
 */
window.initSynergyPage = function () {
  const A = window.LorApp;
  const { $, esc, apiGet, cardTile } = A;

  async function load(cl) {
    if (!cl) { $('#synergy-result').innerHTML = ''; return; }
    $('#synergy-result').innerHTML =
      '<div class="grid sm:grid-cols-2 gap-4">' +
      '<div class="h-40 skeleton rounded-lg"></div><div class="h-40 skeleton rounded-lg"></div></div>';

    const p = new URLSearchParams(location.search);
    p.set('c', cl);
    history.replaceState(null, '', location.pathname + '?' + p.toString());

    let data;
    try {
      data = await apiGet('/api/synergy/' + encodeURIComponent(cl));
    } catch (e) {
      $('#synergy-result').innerHTML =
        `<div class="p-6 text-center text-rose-300">読み込みに失敗しました。</div>`;
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
           <p class="text-[11px] text-slate-500 mb-2.5">
             上記カードの効果対象になり得るカード群。
           </p>
           ${grid(data.holders)}
         </section>
       </div>`;
  }

  (async function boot() {
    let masters;
    try {
      masters = await apiGet('/api/masters');
    } catch {
      return;
    }
    // 参照が存在する種族を優先して上に出す
    const refSet = new Map((masters.referenced_classifications || []).map((x) => [x.v, x.n]));
    const opts = (masters.classifications || [])
      .map((x) => ({ v: x.v, holders: x.n, refs: refSet.get(x.v) || 0 }))
      .sort((a, b) => b.refs - a.refs || b.holders - a.holders);

    $('#synergy-select').innerHTML =
      '<option value="">選択してください</option>' +
      opts
        .map(
          (o) =>
            `<option value="${esc(o.v)}">${esc(o.v)}（参照 ${o.refs} / 保有 ${o.holders}）</option>`
        )
        .join('');

    $('#synergy-select').addEventListener('change', (e) => load(e.target.value));

    const initial = new URLSearchParams(location.search).get('c');
    if (initial) {
      $('#synergy-select').value = initial;
      load(initial);
    }
  })();
};
