/**
 * deckOcr.ts — X / note のデッキ「画像」からデッキ表を読み取る工程
 *
 * なぜ必要か:
 *   日本のロルカナ界でデッキが共有される主な場は X と note だが、
 *   実測でどちらも本文テキストにはデッキ表が無い。
 *     ・note のデッキタグ記事10本を調べて、カード行を1件も抽出できなかった。
 *     ・X は本文が短く、投稿本体もサーバ側からはJS実行前のHTMLしか取れない。
 *   デッキは「カード画像を格子状に並べ、右上に x3 / x4 の枚数バッジを載せた
 *   1枚の画像」として貼られている。画像を読まない限り取得は原理的に不可能。
 *
 * 読み取り方の設計（すべて実測に基づく）:
 *
 *   1. 画像は `?width=2000` で渡す。
 *      width=1200 だとカード名の帯が小さすぎて 19枠中0枚しか読めなかった。
 *      原寸（4096px）は取得が遅く、Vision 側のダウンロードがタイムアウトする。
 *
 *   2. 画像全体を1回で読ませない。「上から N 段目の横一列だけ」と指示して
 *      段ごとに呼ぶ。
 *      一括読みは 19枠のうち6枠が判別不能・合計が64枚（正解60枚）になった。
 *      段別にすると 19/19 読め、合計もちょうど60枚で一致した。
 *      理由は単純で、1回の視線に入る領域が狭いほど帯の文字が相対的に大きい。
 *
 *   3. カード名は自由記述させず、DBのカード名一覧から選ばせる。
 *      さらに読み違い（濁点落ち等）は matchOcrCardName の近似一致で救う。
 *
 *   4. 60枚未満のデッキはルール上存在しないので、読み取り結果が60枚に
 *      届かなければ「読めなかった」と判断して捨てる。
 *      枚数を勝手に補完して60枚に見せかけると、存在しないデッキを作ることになる。
 *
 * 引用方針（§1.3）:
 *   X / note は非公式ソースなので、
 *     ・記事本文は一切保存しない（保存するのは画像から読んだカード名と枚数だけ）
 *     ・投稿者名は表示しない
 *     ・出典URLは「デッキレシピの出典表示」に限って表示する（§1.3の例外）
 */
import type { AiEnv } from '../types';
import { LlmError, aiConfigured } from './ai';
import { buildCardIndex, matchOcrCardName, politeFetch, politeSleep, sha256Hex,
         extractArticleImages, dateOnly, type CardIndex } from './meta';

/** 画像1段の読み取り結果 */
export type OcrDeckRow = {
  exists: boolean;
  cards: Array<{ name: string | null; qty: number | null }>;
};

/**
 * デッキ画像の並び（段数と各段の枠数）。
 *
 * なぜ先にこれを取るか（実測による）:
 *   段別読み取りだけだと2つの事故が起きた。
 *     ・2段しかない画像に「3段目」を要求すると、モデルが空と答えず
 *       既に読んだ段を再出力し、枚数が二重に加算された（85枚になった）。
 *     ・ある段の枠を読み落としても気づけず、合計52枚のまま採否判定に回った。
 *   段数と枠数を先に確定させ、読み取り結果の枠数と突き合わせれば
 *   どちらも検出できる。枚数バッジより「枠を数える」方が視覚的に容易なので
 *   この1回は安価かつ確実。
 */
export type OcrDeckLayout = {
  isDeck: boolean;
  rows: number[]; // 各段の枠数（上から順）
};

/** デッキ画像1枚の読み取り結果 */
export type OcrDeckImage = {
  image_url: string;
  kind: 'deck' | 'other';
  rows: number;
  cards: Array<{ raw: string; qty: number }>;
  total: number;
  /** レイアウト把握で数えた枠の総数（採否判定の検証に使う） */
  slots: number;
  /** 実際に読み取れた枠の数。slots と乖離していれば読み落としがある */
  readSlots: number;
};

/**
 * 画像1枚に対する Vision 呼び出しの共通処理。
 * JSONにならない返答は「デッキ表でない」を意味するので null を返す（例外にしない）。
 */
async function visionJson(
  env: AiEnv,
  imageUrl: string,
  instruction: string,
  opts: { model?: string; timeoutMs?: number; maxTokens?: number } = {}
): Promise<any | null> {
  if (!aiConfigured(env)) throw new LlmError('ai_not_configured', 503);
  const base = String(env.OPENAI_BASE_URL).replace(/\/+$/, '');
  const model = opts.model || env.AI_MODEL || 'gpt-5-mini';

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 110_000);
  let res: Response;
  try {
    res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: instruction },
              // detail:'high' でないと帯の文字が潰れる（実測）
              { type: 'image_url', image_url: { url: imageUrl, detail: 'high' } },
            ],
          },
        ],
        response_format: { type: 'json_object' },
        reasoning_effort: 'medium',
        max_completion_tokens: opts.maxTokens ?? 5_000,
      }),
      signal: ctrl.signal,
    });
  } catch (e: any) {
    clearTimeout(timer);
    throw new LlmError(e?.name === 'AbortError' ? 'deck_ocr_timeout' : 'deck_ocr_network_error', 504);
  }
  clearTimeout(timer);

  const raw = await res.text();
  if (!res.ok) throw new LlmError(`deck_ocr_http_${res.status}`, res.status);
  try {
    const outer = JSON.parse(raw);
    return JSON.parse(String(outer?.choices?.[0]?.message?.content ?? '{}'));
  } catch {
    /*
     * デッキ表でない画像（記事のアイキャッチ等）を渡すと、
     * モデルが「読み取れません」という散文を返して JSON にならない。
     * これは異常ではなく「その画像はデッキ表ではない」という結果なので、
     * 例外にせず null を返す（記事ごと失敗扱いにしないため）。
     */
    return null;
  }
}

/**
 * デッキ画像の並び（段数と各段の枠数）を先に確定させる。
 * カード名も枚数も読ませない（枠を数えるだけなら精度が高い）。
 */
async function readDeckLayout(
  env: AiEnv,
  imageUrl: string,
  opts: { model?: string } = {}
): Promise<OcrDeckLayout> {
  const instruction = [
    'ディズニーロルカナのデッキ紹介画像かどうかを判定し、カードの並びを数える作業です。',
    '',
    '【デッキ紹介画像とは】',
    'カード画像が格子状に並び、各カードの右上に丸いバッジ「x1」〜「x4」で枚数が書かれているもの。',
    'カード1〜3枚を大きく解説した画像、買取価格表、メタ円グラフ、写真などは該当しない。',
    '',
    '【やること】',
    '  1. デッキ紹介画像かどうかを判定する。',
    '  2. 該当する場合、上から順に「各段に何枠並んでいるか」を数える。',
    '     最後の段は途中で終わっていることが多いので、実際の枠数を数える。',
    '     カード名や枚数は読まなくてよい。枠の数だけを正確に数える。',
    '',
    '【出力】JSONのみ。{"is_deck":true,"rows":[8,8,2]}',
    'デッキ紹介画像でなければ {"is_deck":false,"rows":[]}',
  ].join('\n');

  const parsed = await visionJson(env, imageUrl, instruction, { model: opts.model, maxTokens: 1_500 });
  if (!parsed) return { isDeck: false, rows: [] };
  const rows = (Array.isArray(parsed?.rows) ? parsed.rows : [])
    .map((n: unknown) => Number(n))
    .filter((n: number) => Number.isInteger(n) && n >= 1 && n <= 14)
    .slice(0, 8);
  return { isDeck: parsed?.is_deck === true && rows.length > 0, rows };
}

/** 段別OCRの1回分を実行する。1段ずつ読ませるのが精度の要（冒頭の設計2）*/
async function readDeckRow(
  env: AiEnv,
  imageUrl: string,
  row: number,
  vocab: string[],
  opts: { model?: string; timeoutMs?: number; expectSlots?: number; totalRows?: number } = {}
): Promise<OcrDeckRow> {
  const instruction = [
    'ディズニーロルカナ（日本語版）のデッキ画像を読み取る作業です。',
    '',
    '【画像の形式】',
    'カード画像が格子状に並び、各カードの右上に丸いバッジ「x1」〜「x4」で枚数が書かれている。',
    'カード名はカードのイラストの下の帯に書かれている。',
    '',
    opts.totalRows
      ? `【画像の並び】この画像は全${opts.totalRows}段。今回読むのは上から${row}段目の横一列だけ。他の段は読まない。`
      : `【今回読む範囲】画像の上から${row}段目の横一列だけ。他の段は読まない。`,
    // 枠数を先に伝えると読み落とし（合計52枚になる事故）を防げる
    opts.expectSlots ? `この段には${opts.expectSlots}枠ある。${opts.expectSlots}件すべて出力する。` : '',
    '',
    '【各カードについて】',
    '  ・枚数: 右上のバッジ「xN」。バッジは文字が大きいので確実に読める。',
    '  ・カード名: 帯の文字。ただし【カード名一覧】に載っている名前の中から選ぶ。',
    '    一覧に無い名前を創作してはいけない。',
    '    読めた文字に最も近い一覧の名前を選ぶ。どれとも判断できない枠は name を null にする。',
    '  ・枠は飛ばさず、左から右へ順に全部出す。',
    '',
    `【出力】JSONのみ。{"row":${row},"exists":true,"cards":[{"name":"カード名またはnull","qty":4}]}`,
    `${row}段目が存在しない（カードが並んでいない）場合は exists:false, cards:[] とする。`,
    '',
    '【カード名一覧】',
    vocab.join(' / '),
  ].filter(Boolean).join('\n');

  const parsed = await visionJson(env, imageUrl, instruction, {
    model: opts.model, timeoutMs: opts.timeoutMs,
  });
  if (!parsed) return { exists: false, cards: [] };
  const cards = Array.isArray(parsed?.cards) ? parsed.cards : [];
  return {
    exists: parsed?.exists !== false && cards.length > 0,
    cards: cards.slice(0, 14).map((c: any) => ({
      name: c?.name ? String(c.name).trim() : null,
      qty: Number.isFinite(Number(c?.qty)) ? Number(c.qty) : null,
    })),
  };
}

/**
 * デッキ画像1枚を段ごとに読んで、カード名と枚数のリストにする。
 *
 * 段数は事前に分からないので、「存在しない」と返るまで進める。
 * ただし maxRows で上限を持つ（Vision 呼び出しは1回十数秒かかるため）。
 */
export async function readDeckImage(
  env: AiEnv,
  imageUrl: string,
  vocab: string[],
  opts: { maxRows?: number; model?: string } = {}
): Promise<OcrDeckImage> {
  const maxRows = Math.max(1, Math.min(6, opts.maxRows ?? 4));
  const out: OcrDeckImage = {
    image_url: imageUrl, kind: 'other', rows: 0, cards: [], total: 0,
    slots: 0, readSlots: 0,
  };

  // 1. まず並び（段数と各段の枠数）を確定させる。ここで非デッキ画像も弾ける
  const layout = await readDeckLayout(env, imageUrl, { model: opts.model });
  if (!layout.isDeck) return out;
  const rows = layout.rows.slice(0, maxRows);
  out.slots = layout.rows.reduce((a, b) => a + b, 0);

  // 2. 段ごとに読む。枠数を伝えて読み落としを防ぎ、返ってきた枠数も検証する
  for (let i = 0; i < rows.length; i++) {
    const row = i + 1;
    const expect = rows[i];
    const r = await readDeckRow(env, imageUrl, row, vocab, {
      model: opts.model, expectSlots: expect, totalRows: rows.length,
    });
    if (!r.exists || !r.cards.length) continue;
    /*
     * レイアウトで数えた枠数より多く返ってきた段は、
     * モデルが他の段まで読んでいる（実測: 2段の画像で85枚になった事故）。
     * 多い分を切り捨てず、その段は丸ごと捨てる。どこが余分か判別できないため。
     */
    if (r.cards.length > expect + 1) continue;
    out.rows = row;
    for (const c of r.cards) {
      out.readSlots++;
      // 枚数が読めない枠は採らない。推測で埋めると枚数が嘘になる
      if (!c.name || !c.qty || c.qty < 1 || c.qty > 4) continue;
      out.cards.push({ raw: c.name, qty: c.qty });
      out.total += c.qty;
    }
  }
  if (out.cards.length >= 8) out.kind = 'deck';
  return out;
}

/**
 * 画像から読んだカード名を DB のカードに解決し、デッキとして採用できるか判定する。
 *
 * 60枚は下限。下回るものは「読み落とした」ので採らない（枚数の捏造をしない）。
 */
export function resolveOcrDeck(
  img: OcrDeckImage,
  index: CardIndex
): {
  ok: boolean;
  reason?: 'not_deck' | 'missed_slots' | 'under_60' | 'low_match';
  total: number;
  fuzzy: number;
  cards: Array<{ card_id: number | null; card_name: string; raw: string; qty: number }>;
  missing: string[];
} {
  const cards: Array<{ card_id: number | null; card_name: string; raw: string; qty: number }> = [];
  const missing: string[] = [];
  let fuzzy = 0;
  // 同じカードが複数枠に出た場合（別レアリティ掲載など）は枚数を足す
  const byId = new Map<string, { card_id: number | null; card_name: string; raw: string; qty: number }>();
  for (const c of img.cards) {
    const hit = matchOcrCardName(c.raw, index);
    const key = hit ? `id:${hit.id}` : `raw:${c.raw}`;
    const cur = byId.get(key);
    if (cur) {
      cur.qty += c.qty;
      continue;
    }
    if (hit) {
      if (hit.fuzzy) fuzzy++;
      byId.set(key, { card_id: hit.id, card_name: hit.name, raw: c.raw, qty: c.qty });
    } else {
      missing.push(c.raw);
      byId.set(key, { card_id: null, card_name: c.raw, raw: c.raw, qty: c.qty });
    }
  }
  for (const v of byId.values()) cards.push(v);
  const total = cards.reduce((a, c) => a + c.qty, 0);

  if (img.kind !== 'deck' || cards.length < 8) return { ok: false, reason: 'not_deck', total, fuzzy, cards, missing };
  /*
   * レイアウトで数えた枠数と、読み取れた枠数が一致しなければ読み落としがある。
   * 実測: 枠を1つ落としたまま合計52枚で判定に回った事故があった。
   * 枠数が合っていない読み取りは、たとえ合計が60枚以上でも信用しない。
   */
  if (img.slots > 0 && img.readSlots < img.slots) {
    return { ok: false, reason: 'missed_slots', total, fuzzy, cards, missing };
  }
  // ロルカナのルールで60枚は下限。下回るのは読み落とし
  if (total < 60) return { ok: false, reason: 'under_60', total, fuzzy, cards, missing };
  const matched = cards.filter((c) => c.card_id).length;
  // 突合率が低い＝OCRを信用できない。中身の怪しいデッキを出さない
  if (matched / cards.length < 0.9) return { ok: false, reason: 'low_match', total, fuzzy, cards, missing };
  return { ok: true, total, fuzzy, cards, missing };
}

/** 解決済みのカード群を1デッキとして書き込む */
async function saveOcrDeck(
  db: D1Database,
  a: {
    deckKey: string;
    url: string;
    imageUrl: string;
    label: string;
    observed: string | null;
    season: string | null;
    total: number;
    cards: Array<{ card_id: number | null; card_name: string; raw: string; qty: number }>;
    missing: string[];
  }
): Promise<number> {
  const matched = a.cards.filter((c) => c.card_id).length;
  const playable = matched / a.cards.length >= 0.9 ? 1 : 0;
  // インク色はカードから推定する（画像から色名を読ませるより確実）
  await db
    .prepare(
      `INSERT INTO meta_decks
         (deck_key,name,archetype,region,ink1,ink2,player,placement,weight,event_name,season,
          total_cards,playable_jp,missing_cards,source_key,source_url,source_label,observed_at,fetched_at,updated_at)
       VALUES (?,?,NULL,'jp',NULL,NULL,NULL,NULL,1,NULL,?,?,?,?,'social_deck_ocr',?,?,?,datetime('now'),datetime('now'))
       ON CONFLICT(deck_key) DO UPDATE SET
         total_cards=excluded.total_cards, playable_jp=excluded.playable_jp,
         missing_cards=excluded.missing_cards, season=excluded.season,
         updated_at=datetime('now')`
    )
    .bind(
      a.deckKey,
      'プレイヤー投稿デッキ',
      a.season,
      a.total,
      playable,
      a.missing.length ? JSON.stringify(a.missing.slice(0, 40)) : null,
      a.url,
      a.label,
      a.observed
    )
    .run();

  const deck = await db.prepare('SELECT id FROM meta_decks WHERE deck_key = ?').bind(a.deckKey).first<{ id: number }>();
  const deckId = Number(deck?.id ?? 0);
  if (!deckId) return 0;

  await db.prepare('DELETE FROM meta_deck_cards WHERE deck_id = ?').bind(deckId).run();
  for (const c of a.cards) {
    await db
      .prepare(
        `INSERT INTO meta_deck_cards (deck_id,card_id,card_name,raw_name,qty)
           VALUES (?,?,?,?,?)
         ON CONFLICT(deck_id,card_name) DO UPDATE SET qty=excluded.qty, card_id=excluded.card_id`
      )
      .bind(deckId, c.card_id, c.card_name, c.raw, c.qty)
      .run();
  }

  // インク色をデッキのカードから決める（多い順に2色）
  const inks = await db
    .prepare(
      `SELECT c.ink_color AS ink, SUM(mc.qty) AS n
         FROM meta_deck_cards mc JOIN cards c ON c.id = mc.card_id
        WHERE mc.deck_id = ? AND c.ink_color IS NOT NULL AND c.ink_color <> ''
        GROUP BY c.ink_color ORDER BY n DESC LIMIT 2`
    )
    .bind(deckId)
    .all();
  const list = ((inks.results ?? []) as any[]).map((r) => String(r.ink));
  if (list.length) {
    await db
      .prepare('UPDATE meta_decks SET ink1=?, ink2=?, name=? WHERE id=?')
      .bind(list[0] ?? null, list[1] ?? null, list.join('/') || 'プレイヤー投稿デッキ', deckId)
      .run();
  }
  return deckId;
}

/**
 * X / note の記事を巡回し、デッキ画像を読んでデッキとして取り込む。
 *
 * 1回の呼び出しで処理する記事は既定1本。
 * 1本の記事に画像が数枚あり、1画像あたり段ごとに Vision を呼ぶため
 * （= 記事1本で最大 画像数×段数 回）、実行時間の上限に収めるには
 * 呼び出し側がループする方式にしないと必ず途中で落ちる。
 */
export async function collectImageDecks(
  env: AiEnv,
  db: D1Database,
  opts: {
    sourceKeys?: string[];
    maxArticles?: number;
    maxImagesPerArticle?: number;
    season?: string;
    model?: string;
    /** 記事URLを直接指定して狙い撃ちする（収集一覧の順で埋もれる記事を試すため） */
    urls?: string[];
  } = {}
): Promise<{
  scanned: number;
  images: number;
  imported: number;
  skipped: number;
  remaining: number;
  results: Array<{ url: string; image: string; status: string; total: number; fuzzy: number }>;
}> {
  const maxArticles = Math.min(4, Math.max(1, opts.maxArticles ?? 1));
  const maxImages = Math.min(6, Math.max(1, opts.maxImagesPerArticle ?? 3));
  const explicit = (opts.urls ?? []).map((u) => String(u).trim()).filter(Boolean);
  let items: Array<{ url: string; observed: string | null }>;
  if (explicit.length) {
    items = explicit.map((u) => ({ url: u, observed: null }));
  } else {
    const keys = opts.sourceKeys ?? ['note_lorcana_deck', 'note_lorcana', 'note_disney_lorcana'];
    const ph = keys.map(() => '?').join(',');
    const q = await db
      .prepare(
        `SELECT url, source_key, observed_at FROM meta_raw_items
          WHERE source_key IN (${ph}) ORDER BY observed_at DESC LIMIT 200`
      )
      .bind(...keys)
      .all();
    items = ((q.results ?? []) as any[]).map((r) => ({
      url: String(r.url),
      observed: r.observed_at ? dateOnly(String(r.observed_at)) : null,
    }));
  }

  // すでに読んだ画像は二度読まない（Vision は遅くて高い）
  const doneImages = new Set<string>();
  {
    const r = await db
      .prepare("SELECT image_url FROM meta_ocr WHERE source_key = 'deck_image'")
      .all()
      .catch(() => ({ results: [] as any[] }));
    for (const row of (r.results ?? []) as any[]) doneImages.add(String(row.image_url));
  }
  // 画像を1枚も読めなかった記事は再訪しない
  const skipArticles = new Set<string>();
  {
    const r = await db
      .prepare("SELECT url FROM meta_deck_skips WHERE attempts >= 2 AND source_key = 'deck_image'")
      .all()
      .catch(() => ({ results: [] as any[] }));
    for (const row of (r.results ?? []) as any[]) skipArticles.add(String(row.url));
  }

  const index = await buildCardIndex(db);
  const vocab = await cardNameVocab(db);
  const pending = explicit.length ? items : items.filter((it) => !skipArticles.has(it.url));
  const batch = pending.slice(0, maxArticles);

  const out = {
    scanned: 0,
    images: 0,
    imported: 0,
    skipped: 0,
    remaining: Math.max(0, pending.length - batch.length),
    results: [] as Array<{ url: string; image: string; status: string; total: number; fuzzy: number }>,
  };

  for (const it of batch) {
    out.scanned++;
    await politeSleep();
    const page = await politeFetch(it.url);
    if (page.status !== 200) {
      out.skipped++;
      await recordImageSkip(db, it.url, 'http_error');
      out.results.push({ url: it.url, image: '', status: `取得できない（HTTP ${page.status}）`, total: 0, fuzzy: 0 });
      continue;
    }
    const imgs = extractArticleImages(page.text, { limit: maxImages * 2 })
      .filter((u) => !doneImages.has(u))
      .slice(0, maxImages);
    if (!imgs.length) {
      out.skipped++;
      await recordImageSkip(db, it.url, 'no_image');
      out.results.push({ url: it.url, image: '', status: '未処理のデッキ画像が無い', total: 0, fuzzy: 0 });
      continue;
    }
    const label = /note\.com/.test(it.url) ? 'note（プレイヤー投稿）' : 'X（プレイヤー投稿）';

    let importedHere = 0;
    for (const imageUrl of imgs) {
      out.images++;
      let img: OcrDeckImage;
      try {
        img = await readDeckImage(env, imageUrl, vocab, { model: opts.model });
      } catch (e: any) {
        const msg = e instanceof LlmError ? e.message : String(e?.message ?? e);
        // 一時的な失敗（レート制限・タイムアウト）は記録しない＝あとで再挑戦できる
        if (!/429|rate|timeout/i.test(msg)) {
          await markImageOcr(db, imageUrl, it.url, 'failed', 0, msg);
        }
        out.results.push({ url: it.url, image: imageUrl, status: `OCR失敗: ${msg}`, total: 0, fuzzy: 0 });
        if (/429|rate|timeout/i.test(msg)) return out; // 打ち切って呼び出し側に返す
        continue;
      }
      const res = resolveOcrDeck(img, index);
      if (!res.ok) {
        /*
         * 「デッキ表でない画像」は読み済みとして記録する（毎回読み直さない）。
         * ただし missed_slots（読み落とし）は画像側の問題ではなく読み取りの失敗なので
         * 記録せず、次回また挑戦できるようにする。
         */
        if (res.reason !== 'missed_slots') {
          await markImageOcr(db, imageUrl, it.url, img.kind === 'deck' ? 'empty' : 'ok', res.total, res.reason ?? null);
        }
        out.skipped++;
        const reason =
          res.reason === 'missed_slots'
            ? `枠${img.slots}に対し${img.readSlots}枠しか読めなかった（読み落としなので採らない）`
            : res.reason === 'under_60'
              ? `読み取り${res.total}枚（60枚未満なので採らない）`
              : res.reason === 'low_match'
                ? 'カードを特定できない枠が多い'
                : 'デッキ表の画像ではない';
        out.results.push({ url: it.url, image: imageUrl, status: reason, total: res.total, fuzzy: res.fuzzy });
        continue;
      }
      const deckKey = `imgdeck:${await sha256Hex(`${it.url}|${imageUrl}`)}`.slice(0, 48);
      const id = await saveOcrDeck(db, {
        deckKey,
        url: it.url,
        imageUrl,
        label,
        observed: it.observed,
        season: opts.season ?? null,
        total: res.total,
        cards: res.cards,
        missing: res.missing,
      });
      await markImageOcr(db, imageUrl, it.url, 'ok', res.total, null);
      if (id) {
        out.imported++;
        importedHere++;
        out.results.push({
          url: it.url,
          image: imageUrl,
          status: `取り込み成功（${res.total}枚）`,
          total: res.total,
          fuzzy: res.fuzzy,
        });
      }
    }
    if (!importedHere) await recordImageSkip(db, it.url, 'no_deck_image');
  }

  return out;
}

/** OCRのカード名候補（DBの全カード名） */
export async function cardNameVocab(db: D1Database): Promise<string[]> {
  const r = await db.prepare('SELECT DISTINCT card_name FROM cards ORDER BY card_name').all();
  return ((r.results ?? []) as any[]).map((x) => String(x.card_name)).filter(Boolean);
}

/** 読んだ画像を meta_ocr に記録する（同じ画像を二度読まないため） */
async function markImageOcr(
  db: D1Database,
  imageUrl: string,
  pageUrl: string,
  status: 'ok' | 'empty' | 'failed',
  total: number,
  note: string | null
): Promise<void> {
  /*
   * ocr_text には本文を入れない（§1.3: 非公式ソースの本文は保存しない）。
   * 保存するのは「何枚と読めたか」という機械的な数値だけ。
   */
  await db
    .prepare(
      `INSERT INTO meta_ocr
         (raw_item_id, source_key, image_url, page_url, ocr_text, char_count,
          status, error, model, observed_at, created_at, updated_at)
       VALUES (NULL,'deck_image',?,?,?,0,?,?,NULL,NULL, datetime('now'), datetime('now'))
       ON CONFLICT(image_url) DO UPDATE SET
         status=excluded.status, ocr_text=excluded.ocr_text,
         error=excluded.error, updated_at=datetime('now')`
    )
    .bind(imageUrl, pageUrl, `deck_total=${total}`, status, note ? String(note).slice(0, 300) : null)
    .run()
    .catch(() => undefined);
}

async function recordImageSkip(db: D1Database, url: string, reason: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO meta_deck_skips (url, source_key, reason, counted, attempts)
         VALUES (?,'deck_image',?,NULL,1)
       ON CONFLICT(url) DO UPDATE SET
         attempts = meta_deck_skips.attempts + 1,
         reason = excluded.reason,
         last_seen = datetime('now')`
    )
    .bind(url, reason)
    .run()
    .catch(() => undefined);
}
