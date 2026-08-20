/**
 * page-card.js — カード詳細ページ
 */
window.initCardDetailPage = function () {
  const A = window.LorApp;
  const { $, esc, apiGet, favorites } = A;
  const mount = $('#card-detail');
  const key = mount.dataset.key;

  const row = (label, value) =>
    value == null || value === ''
      ? ''
      : `<div class="flex justify-between gap-3 py-1.5 border-b border-slate-800">
           <dt class="text-slate-500 shrink-0">${esc(label)}</dt>
           <dd class="text-right">${value}</dd>
         </div>`;

  (async function () {
    mount.innerHTML =
      `<div class="grid md:grid-cols-[300px_1fr] gap-6">
         <div class="card-thumb skeleton rounded-xl"></div>
         <div class="space-y-3"><div class="h-7 w-1/2 skeleton rounded"></div>
         <div class="h-4 w-1/3 skeleton rounded"></div><div class="h-24 skeleton rounded"></div></div>
       </div>`;

    let data;
    try {
      data = await apiGet('/api/cards/' + encodeURIComponent(key));
    } catch (e) {
      mount.innerHTML =
        `<div class="p-8 text-center text-rose-300 bg-rose-950/30 border border-rose-800 rounded-lg">
           カードが見つかりませんでした。</div>`;
      return;
    }

    const c = data.card;
    document.title = `${c.card_name}${c.version ? ' / ' + c.version : ''} | 非公式カードデータベース`;
    const fav = favorites.has(c.card_file);

    const officialUrl =
      'https://www.takaratomy.co.jp/products/disneylorcana/cardlist/?card=' +
      encodeURIComponent(c.card_file);

    mount.innerHTML =
      `<div class="grid md:grid-cols-[320px_1fr] gap-6" data-file="${esc(c.card_file)}">
         <div class="space-y-3">
           <button class="js-zoom block w-full text-left" data-img="${esc(c.image_url)}" data-name="${esc(c.card_name)}"
                   aria-label="カード画像を拡大">
             ${A.cardImage(c)}
           </button>
           <p class="text-[10px] text-slate-500 text-center">
             <i class="fas fa-circle-info mr-1"></i>画像は公式サイトのものを参照しています
           </p>
           <div class="flex gap-2">
             <button class="js-fav flex-1 py-2 rounded text-xs font-semibold ${fav ? 'bg-amber-600 text-slate-900' : 'bg-slate-800 hover:bg-slate-700'}"
                     aria-pressed="${fav}">
               <i class="fa-star ${fav ? 'fas' : 'far'} mr-1"></i>お気に入り
             </button>
             <a href="/deck?add=${encodeURIComponent(c.card_file)}"
                class="flex-1 py-2 bg-sky-700 hover:bg-sky-600 rounded text-xs font-semibold text-center">
               <i class="fas fa-plus mr-1"></i>デッキに追加
             </a>
           </div>
           <a href="${esc(officialUrl)}" target="_blank" rel="noopener noreferrer"
              class="block py-2 bg-slate-800 hover:bg-slate-700 rounded text-xs text-center text-sky-300">
             <i class="fas fa-external-link-alt mr-1"></i>公式カードリストで見る
           </a>
         </div>

         <div class="space-y-4">
           <header>
             <div class="flex items-center gap-2 flex-wrap mb-1">
               <span class="flex gap-1">${A.inkChips(c)}</span>
               <span class="text-[11px] px-2 py-0.5 bg-slate-800 rounded">${esc(c.rarity)}</span>
               <span class="text-[11px] px-2 py-0.5 bg-slate-800 rounded">${esc(c.card_type)}</span>
               ${c.inkwell === 'y'
                 ? '<span class="text-[11px] px-2 py-0.5 bg-sky-900/60 text-sky-300 rounded"><i class="fas fa-droplet mr-1"></i>インク可能</span>'
                 : '<span class="text-[11px] px-2 py-0.5 bg-slate-800 text-slate-500 rounded">インク不可</span>'}
             </div>
             <h1 class="text-2xl font-bold">${esc(c.card_name)}</h1>
             ${c.version ? `<p class="text-slate-300">${esc(c.version)}</p>` : ''}
             <p class="text-xs text-slate-500 mt-1">${esc(c.sets_name || '')} · No.${c.collector_number ?? '-'}</p>
           </header>

           <div class="grid grid-cols-2 sm:grid-cols-5 gap-2">
             ${[
               ['インクコスト', c.ink_cost, 'text-sky-300'],
               ['攻撃力', c.strength, 'text-rose-300'],
               ['意志力', c.willpower, 'text-emerald-300'],
               ['ロア', c.lore_value, 'text-violet-300'],
               ['移動コスト', c.move_cost, 'text-teal-300'],
             ]
               .filter((x) => x[1] != null)
               .map(
                 ([label, v, cls]) =>
                   `<div class="bg-slate-900 border border-slate-700 rounded-lg p-2.5 text-center">
                      <div class="text-[10px] text-slate-500">${label}</div>
                      <div class="text-xl font-bold ${cls}">${v}</div>
                    </div>`
               )
               .join('')}
           </div>

           ${(c.classifications || []).length
             ? `<div class="flex flex-wrap gap-1.5 items-center">
                  <span class="text-xs text-slate-500">クラス</span>
                  ${c.classifications.map((cl) =>
                    `<a href="/?classification=${encodeURIComponent(cl)}"
                        class="text-[11px] px-2 py-0.5 bg-slate-800 hover:bg-slate-700 rounded-full">${esc(cl)}</a>`
                  ).join('')}
                </div>`
             : ''}

           ${(c.abilities || []).length
             ? `<div class="flex flex-wrap gap-1.5 items-center">
                  <span class="text-xs text-slate-500">キーワード能力</span>
                  ${c.abilities.map((ab) =>
                    `<a href="/?ability=${encodeURIComponent(ab)}"
                        class="text-[11px] px-2 py-0.5 bg-sky-900/50 text-sky-200 hover:bg-sky-800/60 rounded-full">${esc(ab)}</a>`
                  ).join('')}
                </div>`
             : ''}

           ${c.rules_text
             ? `<section class="bg-slate-900 border border-slate-700 rounded-lg p-4">
                  <h2 class="text-xs font-bold text-slate-400 mb-2">効果テキスト</h2>
                  <div class="rules-text text-sm">${A.renderRulesText(c.rules_text)}</div>
                </section>`
             : ''}

           ${c.flavor_text
             ? `<section class="bg-slate-900/60 border-l-2 border-slate-600 pl-4 py-2">
                  <div class="text-xs italic text-slate-400">${A.renderFlavorText(c.flavor_text)}</div>
                </section>`
             : ''}

           ${(c.referenced_classifications || []).length
             ? `<section class="bg-indigo-950/30 border border-indigo-800/60 rounded-lg p-3">
                  <h2 class="text-xs font-bold text-indigo-300 mb-1.5">
                    <i class="fas fa-diagram-project mr-1"></i>このカードが参照する種族
                  </h2>
                  <div class="flex flex-wrap gap-1.5">
                    ${c.referenced_classifications.map((cl) =>
                      `<a href="/synergy?c=${encodeURIComponent(cl)}"
                          class="text-[11px] px-2 py-0.5 bg-indigo-900/60 text-indigo-200 hover:bg-indigo-800 rounded-full">
                         ${esc(cl)} のカードを見る <i class="fas fa-arrow-right ml-0.5"></i></a>`
                    ).join('')}
                  </div>
                </section>`
             : ''}

           <section class="text-xs">
             <h2 class="text-xs font-bold text-slate-400 mb-1.5">詳細情報</h2>
             <dl class="bg-slate-900 border border-slate-700 rounded-lg px-3 py-1">
               ${row('カード番号', esc(c.card_file))}
               ${row('収録セット', esc(c.sets_name))}
               ${row('発売', c.release_date ? String(c.release_date).replace(/^(\d{4})(\d{2})$/, '$1年$2月') : '')}
               ${row('インク色', esc(c.ink_color) + (c.ink_color2 ? ' / ' + esc(c.ink_color2) : '') + (c.ink_type ? `<span class="text-slate-500 ml-1">(${esc(c.ink_type)})</span>` : ''))}
               ${row('イラスト', [c.artist_credit1, c.artist_credit2].filter(Boolean).map(esc).join(' / '))}
               ${row('デッキ内枚数制限', c.limit_card != null ? `${c.limit_card} 枚` : '4 枚（通常）')}
             </dl>
           </section>
         </div>
       </div>

       ${(data.related || []).length
         ? `<section class="mt-8">
              <h2 class="text-sm font-bold mb-3">
                <i class="fas fa-clone text-slate-500 mr-1.5"></i>同名の別バージョン
              </h2>
              <div class="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-3">
                ${data.related.map((r) => A.cardTile(r, {})).join('')}
              </div>
            </section>`
         : ''}`;
  })();
};
