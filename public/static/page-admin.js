/**
 * page-admin.js — 隠し管理画面（データ更新）のフロント
 *
 * 設計意図
 *  - カード更新は「数ページずつ」進む分割方式なので、完了まで自動で叩き続ける。
 *    途中でタブを閉じても、ジョブは D1 に残るので再開できる。
 *  - 進捗は必ず画面に出す。公式サーバへ礼儀スリープを入れている分だけ遅いので、
 *    無反応に見えると利用者が連打してしまう。
 */
(() => {
  if (window.__adminInited) return;
  window.__adminInited = true;

  const API = window.__ADMIN_API || '/api/_ops';
  const $ = (id) => document.getElementById(id);
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));

  let running = false;
  let cancelRequested = false;

  // ------------------------------------------------------------ 通信
  async function call(path, body) {
    const res = await fetch(API + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body || {}),
      credentials: 'same-origin',
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(json.detail || json.error || `HTTP ${res.status}`);
      err.status = res.status;
      err.payload = json;
      throw err;
    }
    return json;
  }

  // ------------------------------------------------------------ ログ表示
  function pushLog(msg, level = 'info') {
    const box = $('op-log');
    if (!box) return;
    const color =
      level === 'error' ? 'text-rose-300' : level === 'warn' ? 'text-amber-300' : level === 'ok' ? 'text-emerald-300' : 'text-slate-300';
    const time = new Date().toLocaleTimeString('ja-JP', { hour12: false });
    box.insertAdjacentHTML('afterbegin', `<div class="${color}"><span class="text-slate-500">${time}</span> ${esc(msg)}</div>`);
  }

  // ------------------------------------------------------------ ログイン
  async function login(ev) {
    ev.preventDefault();
    const pw = $('op-password').value;
    const msg = $('op-login-msg');
    msg.textContent = '確認中...';
    try {
      await call('/login', { password: pw });
      $('op-password').value = '';
      msg.textContent = '';
      showPanel();
    } catch (e) {
      if (e.status === 429) {
        msg.textContent = `試行回数が多すぎます。${e.payload?.retry_after ?? 600}秒後に再試行してください。`;
      } else if (e.status === 503) {
        msg.textContent = 'サーバにパスワードが設定されていません（ADMIN_PASSWORD）。';
      } else {
        msg.textContent = 'パスワードが違います。';
      }
      msg.className = 'text-sm text-rose-400 mt-2';
    }
  }

  async function logout() {
    await call('/logout', {}).catch(() => {});
    location.reload();
  }

  function showPanel() {
    $('op-login').classList.add('hidden');
    $('op-panel').classList.remove('hidden');
    refreshStatus();
    refreshMetaStatus();
  }

  // ------------------------------------------------------------ 状態表示
  function renderStatus(s) {
    const c = s.counts || {};
    const v = s.vectors || {};
    const meta = s.meta || {};
    const set = s.latest_set;

    $('op-counts').innerHTML = [
      ['カード', c.cards, ''],
      ['ルール条文', c.rules, ''],
      ['公式Q&A', c.rule_faqs, ''],
      ['カードQ&A(ID)', c.faqs, ''],
      ['種族タグ', c.classifications, ''],
      ['能力タグ', c.abilities, ''],
    ]
      .map(
        ([label, n]) => `
        <div class="bg-slate-800/60 rounded-lg px-3 py-2">
          <div class="text-[11px] text-slate-400">${esc(label)}</div>
          <div class="text-lg font-semibold text-slate-100">${Number(n ?? 0).toLocaleString()}</div>
        </div>`
      )
      .join('');

    const vecCards = Number(v.cards ?? 0);
    const vecRules = Number(v.rules ?? 0);
    const vecFaqs = Number(v.faqs ?? 0);
    const needCards = Number(c.cards ?? 0) - vecCards;
    const needRules = Number(c.rules ?? 0) - vecRules;
    const needFaqs = Number(c.rule_faqs ?? 0) - vecFaqs;
    const needAll = Math.max(0, needCards) + Math.max(0, needRules) + Math.max(0, needFaqs);
    $('op-vectors').innerHTML = `
      <div>意味ベクトル: カード <b class="${needCards > 0 ? 'text-amber-300' : 'text-emerald-300'}">${vecCards.toLocaleString()}</b> / ${Number(c.cards ?? 0).toLocaleString()}
      ・ルール <b class="${needRules > 0 ? 'text-amber-300' : 'text-emerald-300'}">${vecRules.toLocaleString()}</b> / ${Number(c.rules ?? 0).toLocaleString()}
      ・公式Q&A <b class="${needFaqs > 0 ? 'text-amber-300' : 'text-emerald-300'}">${vecFaqs.toLocaleString()}</b> / ${Number(c.rule_faqs ?? 0).toLocaleString()}</div>
      ${needAll > 0
        ? `<div class="text-amber-300 mt-1"><i class="fas fa-triangle-exclamation mr-1"></i>未ベクトル化 ${needAll} 件。AI分析の精度を保つため「記憶層を更新」を実行してください。</div>`
        : '<div class="text-emerald-300 mt-1"><i class="fas fa-check mr-1"></i>記憶層は最新です</div>'}
      <div class="text-slate-400 mt-1">最新セット: ${set ? esc(set.sets_name) + ` (${set.n}枚)` : '—'}
        ／ 最終取込: ${esc(meta.updated_at || meta.imported_at || '—')}</div>`;

    // ルールPDFの版情報
    const rows = (s.sources || []).map((x) => {
      const changed = x.last_modified && x.last_modified !== x.imported_last_modified;
      return `<tr class="border-t border-slate-800">
        <td class="py-1.5 pr-3">${esc(x.label || x.source)}</td>
        <td class="py-1.5 pr-3 text-slate-400">${esc(x.last_modified || '—')}</td>
        <td class="py-1.5 pr-3 text-slate-400">${esc(x.imported_last_modified || '未取込')}</td>
        <td class="py-1.5">${changed ? '<span class="text-amber-300">要更新</span>' : '<span class="text-emerald-300">最新</span>'}</td>
      </tr>`;
    });
    $('op-sources').innerHTML = rows.length
      ? `<table class="w-full text-xs"><thead class="text-slate-400"><tr>
           <th class="text-left pb-1">文書</th><th class="text-left pb-1">公式の更新日</th>
           <th class="text-left pb-1">取込済みの版</th><th class="text-left pb-1">状態</th></tr></thead>
         <tbody>${rows.join('')}</tbody></table>`
      : '<div class="text-slate-500 text-xs">まだ確認していません。「ルール改定を確認」を押してください。</div>';

    // ジョブ履歴
    $('op-jobs').innerHTML = (s.jobs || [])
      .map((j) => {
        const badge =
          j.status === 'done' ? 'bg-emerald-500/15 text-emerald-300'
          : j.status === 'running' ? 'bg-sky-500/15 text-sky-300'
          : j.status === 'failed' ? 'bg-rose-500/15 text-rose-300'
          : 'bg-slate-600/20 text-slate-300';
        return `<div class="flex items-center gap-2 text-xs py-1 border-b border-slate-800/70">
          <span class="px-1.5 py-0.5 rounded ${badge}">${esc(j.status)}</span>
          <span class="text-slate-400">#${j.id} ${esc(j.kind)}</span>
          <span class="text-slate-300 flex-1 truncate">${esc(j.message || '')}</span>
          <span class="text-slate-500">${esc(String(j.updated_at || '').replace('T', ' '))}</span>
        </div>`;
      })
      .join('') || '<div class="text-slate-500 text-xs">履歴なし</div>';

    // 直近ログ
    $('op-history').innerHTML = (s.logs || [])
      .map((l) => {
        const color = l.level === 'error' ? 'text-rose-300' : l.level === 'warn' ? 'text-amber-300' : 'text-slate-300';
        return `<div class="text-[11px] ${color}"><span class="text-slate-500">${esc(String(l.created_at || '').replace('T', ' '))}</span> [${esc(l.kind)}] ${esc(l.message)}</div>`;
      })
      .join('') || '<div class="text-slate-500 text-xs">ログなし</div>';

    // running ジョブがあれば再開ボタンを出す
    const stuck = (s.jobs || []).find((j) => j.status === 'running' && j.kind === 'cards');
    $('op-resume').classList.toggle('hidden', !stuck || running);
    if (stuck) $('op-resume').dataset.jobId = stuck.id;
  }

  async function refreshStatus() {
    try {
      renderStatus(await call('/status'));
    } catch (e) {
      if (e.status === 401) {
        $('op-panel').classList.add('hidden');
        $('op-login').classList.remove('hidden');
      } else {
        pushLog(`状態取得に失敗: ${e.message}`, 'error');
      }
    }
  }

  // ------------------------------------------------------------ カード更新
  function setProgress(pct, text) {
    $('op-progress-wrap').classList.remove('hidden');
    $('op-progress-bar').style.width = `${Math.max(0, Math.min(100, pct))}%`;
    $('op-progress-text').textContent = text;
  }

  async function updateCards(jobId) {
    if (running) return;
    running = true;
    cancelRequested = false;
    $('op-btn-cards').disabled = true;
    $('op-btn-cancel').classList.remove('hidden');
    $('op-resume').classList.add('hidden');
    pushLog(jobId ? `ジョブ #${jobId} を再開します` : '公式カードデータの更新を開始します', 'info');
    setProgress(0, '公式APIに接続中...');

    let job = jobId || 0;
    let guard = 0;
    try {
      while (guard++ < 60) {
        if (cancelRequested) {
          await call('/update/cancel', { job_id: job });
          pushLog('キャンセルしました', 'warn');
          break;
        }
        const r = await call('/update/cards', job ? { job_id: job } : {});
        job = r.job_id;
        setProgress(
          r.progress,
          `${r.page - 1}/${r.total_pages} ページ ・ 取得 ${r.seen}/${r.api_count} 枚 ・ 新規 ${r.inserted} / 更新 ${r.updated}`
        );
        for (const nc of r.new_cards || []) {
          pushLog(`新規: ${nc.card_name}${nc.version ? '・' + nc.version : ''}（${nc.sets || ''}）`, 'ok');
        }
        if (r.done) {
          setProgress(100, `完了: 新規 ${r.inserted} / 更新 ${r.updated} / 変更なし ${r.unchanged}`);
          pushLog(`カード更新が完了しました（新規 ${r.inserted} / 更新 ${r.updated}）`, 'ok');
          if (r.inserted > 0 || r.updated > 0) {
            pushLog('新しいカードはまだAIが記憶していません。「記憶層を更新」を実行してください。', 'warn');
          }
          break;
        }
      }
    } catch (e) {
      pushLog(`更新に失敗: ${e.message}`, 'error');
      setProgress(0, `失敗: ${e.message}`);
    } finally {
      running = false;
      $('op-btn-cards').disabled = false;
      $('op-btn-cancel').classList.add('hidden');
      refreshStatus();
    }
  }

  // ------------------------------------------------------------ ルール確認
  async function checkRules() {
    const btn = $('op-btn-rules');
    btn.disabled = true;
    pushLog('公式ルールPDFの更新日を確認します（本体はダウンロードしません）', 'info');
    try {
      const r = await call('/update/rules-check', {});
      for (const x of r.checks || []) {
        // Range で 1 バイトだけ要求しているため成功は 206（200 を返すサーバもある）
        if (x.status !== 200 && x.status !== 206) pushLog(`${x.label}: 取得できません (HTTP ${x.status})`, 'error');
        else if (x.changed) pushLog(`${x.label}: 改定あり（公式 ${x.last_modified} / 取込 ${x.imported_last_modified || '未'}）`, 'warn');
        else pushLog(`${x.label}: 変更なし`, 'ok');
      }
      if (!(r.changed || []).length) pushLog('すべて最新です', 'ok');
      else pushLog('改定分のテキスト化は開発機で scraper/fetch_rules.mjs を実行してください', 'warn');
    } catch (e) {
      pushLog(`ルール確認に失敗: ${e.message}`, 'error');
    } finally {
      btn.disabled = false;
      refreshStatus();
    }
  }

  // ------------------------------------------------------------ Q&A更新
  async function updateFaqs() {
    const btn = $('op-btn-faqs');
    btn.disabled = true;
    pushLog('公式ルールQ&Aを取得します', 'info');
    try {
      const r = await call('/update/faqs', {});
      pushLog(`Q&A ${r.fetched} 件を確認（新規 ${r.inserted} / 更新 ${r.updated}）`, 'ok');
    } catch (e) {
      pushLog(`Q&A取得に失敗: ${e.message}`, 'error');
    } finally {
      btn.disabled = false;
      refreshStatus();
    }
  }

  // ------------------------------------------------------------ 記憶層更新
  async function rebuildMemory() {
    const btn = $('op-btn-memory');
    btn.disabled = true;
    pushLog('記憶層（意味ベクトル）の差分更新を開始します', 'info');
    setProgress(0, '記憶層を更新中...');
    try {
      // カード
      let offset = 0;
      let processed = 0;
      let guard = 0;
      while (guard++ < 40) {
        const r = await fetch('/api/memory/build/cards', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ batch: 200, offset }),
        }).then((x) => x.json());
        if (r.error) throw new Error(r.detail || r.error);
        processed += r.processed || 0;
        setProgress(Math.min(90, (offset / 2600) * 100), `カードを記憶中... ${offset + 200} 件走査 / 更新 ${processed}`);
        if (r.done || r.next_offset == null) break;
        offset = r.next_offset;
      }
      pushLog(`カードの記憶を更新: ${processed} 件`, 'ok');

      // ルール条文も件数が batch を超える（大会ルール取込で463節）ため、
      // カードと同様に next_offset を辿って最後まで回す。
      let rOffset = 0;
      let rProcessed = 0;
      let rGuard = 0;
      while (rGuard++ < 20) {
        const rr = await fetch('/api/memory/build/rules', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ batch: 400, offset: rOffset }),
        }).then((x) => x.json());
        if (rr.error) throw new Error(rr.detail || rr.error);
        rProcessed += rr.processed || 0;
        setProgress(95, `ルール条文を記憶中... 更新 ${rProcessed}`);
        if (rr.done || rr.next_offset == null) break;
        rOffset = rr.next_offset;
      }
      pushLog(`ルール条文の記憶を更新: ${rProcessed} 件`, 'ok');

      // 公式Q&A（rule_faqs）も意味ベクトル化する。AI分析で「公式の見解」として
      // 最優先の根拠に使うため、Q&Aを更新したらここも回す必要がある。
      let fOffset = 0;
      let fProcessed = 0;
      let fGuard = 0;
      while (fGuard++ < 20) {
        const fr = await fetch('/api/memory/build/faqs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ batch: 200, offset: fOffset }),
        }).then((x) => x.json());
        if (fr.error) throw new Error(fr.detail || fr.error);
        fProcessed += fr.processed || 0;
        setProgress(98, `公式Q&Aを記憶中... 更新 ${fProcessed}`);
        if (fr.done || fr.next_offset == null) break;
        fOffset = fr.next_offset;
      }
      pushLog(`公式Q&Aの記憶を更新: ${fProcessed} 件`, 'ok');
      setProgress(100, '記憶層の更新が完了しました');
    } catch (e) {
      pushLog(`記憶層の更新に失敗: ${e.message}`, 'error');
      setProgress(0, `失敗: ${e.message}`);
    } finally {
      btn.disabled = false;
      refreshStatus();
    }
  }

  // ============================================================ 最新環境情報
  /**
   * 日次更新の4段（collect → aggregate → summarize → memory）の手動実行。
   *
   * 通常は GitHub Actions（毎日22:00 JST）が同じ順で叩く。ここは検証・復旧用。
   * collect は Workers のCPU制限を避けるため1回1ソースで返る仕様なので、
   * done=true / remaining=0 になるまでこちら側でループする。
   */
  const META_BTNS = [
    'op-btn-meta-collect',
    'op-btn-meta-aggregate',
    'op-btn-meta-summarize',
    'op-btn-meta-memory',
    'op-btn-meta-all',
  ];

  function metaBtnsDisabled(v) {
    META_BTNS.forEach((id) => {
      const b = $(id);
      if (b) b.disabled = v;
    });
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** ① 収集。全ソースを走り切るまで繰り返す */
  async function metaCollect() {
    pushLog('環境情報の収集を開始します', 'info');
    setProgress(0, '情報を収集中...');
    let total = 0;
    let ok = 0;
    let ng = 0;
    // ソース数は20前後。取りこぼしを防ぐため上限は余裕を持たせる
    for (let i = 0; i < 40; i++) {
      const r = await call('/meta/collect', {});
      if (r.message && r.remaining === 0 && !r.source) {
        pushLog(r.message, 'ok');
        break;
      }
      total++;
      if (r.ok) ok++;
      else ng++;
      const skipped = r.detail && r.detail.skipped;
      const note = skipped
        ? `スキップ（${skipped}）`
        : `新規${r.inserted || 0} / 更新${r.updated || 0}`;
      pushLog(`収集 ${r.label || r.source}: ${note}`, r.ok ? (skipped ? 'warn' : 'ok') : 'error');
      const done = r.remaining || 0;
      setProgress(
        Math.min(95, (total / (total + done || 1)) * 100),
        `収集中... 完了${total}件 / 残り${done}件`
      );
      if (r.done && !r.remaining) break;
      // 公式サーバへの礼儀。連続で叩かない
      await sleep(1200);
    }
    setProgress(100, `収集完了（成功${ok} / 失敗${ng}）`);
    pushLog(`収集を終了しました（成功${ok} / 失敗${ng}）`, ng ? 'warn' : 'ok');
  }

  /** ② 集計（LLM不使用・決定的） */
  async function metaAggregate() {
    pushLog('イベント抽出とメタシェア集計を実行します', 'info');
    const r = await call('/meta/aggregate', {});
    pushLog(
      `集計完了: イベント${r.events}件 / 日本${(r.jp && r.jp.rows) || 0}行 / 海外${(r.en && r.en.rows) || 0}行`,
      'ok'
    );
  }

  /** ③ 要約生成。失敗しても既存レポートは維持される */
  async function metaSummarize() {
    pushLog('LLMで要約を生成します（1分程度かかることがあります）', 'info');
    setProgress(50, '要約を生成中...');
    const r = await call('/meta/summarize', {});
    if (r.status === 'published') {
      pushLog(`${r.report_date} のレポートを生成しました（model=${r.model || '-'}）`, 'ok');
      if (r.violations && r.violations.length) {
        pushLog(`引用方針の自動修正 ${r.violations.length}件（本文から非公式の固有名を除去）`, 'warn');
      }
      if (r.lengthWarnings && r.lengthWarnings.length) {
        pushLog(`字数規定外のブロック: ${r.lengthWarnings.join(' / ')}`, 'warn');
      }
    } else {
      pushLog(`要約は生成されませんでした（${r.error || 'unknown'}）。前日分の表示を維持します`, 'warn');
    }
    setProgress(100, '要約の処理が完了しました');
  }

  /** ④ 記憶層へ反映（AIのシナジー提案が環境情報を参照できるようになる） */
  async function metaMemory() {
    pushLog('環境情報を記憶層（意味ベクトル）へ反映します', 'info');
    setProgress(60, '記憶層へ反映中...');
    let guard = 0;
    let embedded = 0;
    let inserted = 0;
    // 残りベクトルが無くなるまで回す（1回あたり64件）
    while (guard++ < 20) {
      const r = await call('/meta/memory', { limit: 64 });
      inserted += r.inserted || 0;
      embedded += r.embedded || 0;
      setProgress(80, `記憶層を更新中... 新規${inserted} / ベクトル化${embedded}`);
      if (!r.remaining) break;
      await sleep(400);
    }
    setProgress(100, '記憶層への反映が完了しました');
    pushLog(`記憶層を更新: 新規${inserted}件 / ベクトル化${embedded}件`, 'ok');
  }

  /** ボタン用ラッパ。多重実行を防ぎ、失敗をログに残す */
  function metaRunner(fn, label) {
    return async () => {
      metaBtnsDisabled(true);
      try {
        await fn();
      } catch (e) {
        pushLog(`${label}に失敗: ${e.message}`, 'error');
        setProgress(0, `失敗: ${e.message}`);
      } finally {
        metaBtnsDisabled(false);
        refreshMetaStatus();
        refreshStatus();
      }
    };
  }

  /** ①〜④の連続実行。②以降は前段が失敗しても、可能な範囲で続行する */
  async function metaRunAll() {
    await metaCollect();
    await metaAggregate();
    try {
      await metaSummarize();
    } catch (e) {
      pushLog(`要約に失敗（前日分を維持）: ${e.message}`, 'warn');
    }
    await metaMemory();
    pushLog('日次更新の一連の処理が完了しました', 'ok');
  }

  /** 収集状況の表示 */
  async function refreshMetaStatus() {
    const host = $('op-meta-status');
    if (!host) return;
    let s;
    try {
      s = await call('/meta/status');
    } catch (_) {
      host.innerHTML = '';
      return;
    }
    const rep = (s.reports || [])[0];
    const failing = (s.sources || []).filter((x) => Number(x.fail_streak || 0) > 0);
    const c = s.counts || {};
    host.innerHTML =
      `<div class="flex flex-wrap gap-x-4 gap-y-1">` +
      `<span>本日の収集: <b class="text-slate-100">${s.collected_today || 0}</b> / ${s.source_total || 0} ソース</span>` +
      `<span>最新レポート: <b class="text-slate-100">${rep ? esc(rep.report_date) : '未生成'}</b>` +
      (rep && rep.status !== 'published' ? `<span class="text-amber-300 ml-1">(${esc(rep.status)})</span>` : '') +
      `</span>` +
      `<span>環境情報の記憶: <b class="text-slate-100">${c.knowledge ?? 0}</b> 件（ベクトル ${c.vectors ?? 0}）</span>` +
      `</div>` +
      (failing.length
        ? `<div class="mt-1 text-amber-300">連続失敗中: ` +
          failing
            .map((x) => `${esc(x.label || x.key)}(${x.fail_streak}回)`)
            .join('、') +
          `</div>`
        : '');
  }

  // ------------------------------------------------------------ 初期化
  document.addEventListener('DOMContentLoaded', async () => {
    $('op-login-form')?.addEventListener('submit', login);
    $('op-btn-logout')?.addEventListener('click', logout);
    $('op-btn-cards')?.addEventListener('click', () => updateCards(0));
    $('op-resume')?.addEventListener('click', (e) => updateCards(Number(e.currentTarget.dataset.jobId) || 0));
    $('op-btn-cancel')?.addEventListener('click', () => {
      cancelRequested = true;
      pushLog('キャンセルを要求しました（現在のページ処理後に停止します）', 'warn');
    });
    $('op-btn-rules')?.addEventListener('click', checkRules);
    $('op-btn-faqs')?.addEventListener('click', updateFaqs);
    $('op-btn-memory')?.addEventListener('click', rebuildMemory);
    $('op-btn-refresh')?.addEventListener('click', () => {
      refreshStatus();
      refreshMetaStatus();
    });

    // 最新環境情報（日次更新）の4段
    $('op-btn-meta-collect')?.addEventListener('click', metaRunner(metaCollect, '収集'));
    $('op-btn-meta-aggregate')?.addEventListener('click', metaRunner(metaAggregate, '集計'));
    $('op-btn-meta-summarize')?.addEventListener('click', metaRunner(metaSummarize, '要約生成'));
    $('op-btn-meta-memory')?.addEventListener('click', metaRunner(metaMemory, '記憶層への反映'));
    $('op-btn-meta-all')?.addEventListener('click', metaRunner(metaRunAll, '日次更新'));

    // 既にセッションがあればパネルを出す
    try {
      const s = await call('/session');
      if (s.authenticated) showPanel();
      else if (!s.configured) {
        $('op-login-msg').textContent = 'サーバ側で ADMIN_PASSWORD が未設定です。';
        $('op-login-msg').className = 'text-sm text-amber-400 mt-2';
      }
    } catch { /* 未認証のままログイン画面 */ }
  });
})();
