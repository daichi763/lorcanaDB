/**
 * updater.ts — 公式データの取り込み（新弾追加・ルール改定への追従）
 *
 * ここは「scraper/*.mjs（Node用）」の処理を Workers 上で動く形に移植したもの。
 * Node 版は開発機での一括取得用、こちらは運用中の差分更新用という役割分担。
 *
 * ■ 遵守事項（scraper 側と同じ方針を維持）
 *   - User-Agent を正直に名乗る
 *   - 直列 1 本のみ（並列取得しない）
 *   - リクエスト間 1.2s + ランダム 0〜400ms のスリープ
 *   - 403 はトークン失効なので取り直して再試行
 *
 * ■ Workers の制約に対する設計
 *   公式APIは posts_per_page の上限が 100（実測）。2500 枚 = 25 ページ。
 *   礼儀スリープを入れると 1 回のリクエストで全ページは回せないため、
 *   「1 リクエストで数ページ」を処理してジョブに進捗を書き、
 *   クライアント（管理画面）が続きを叩く方式にしている。
 */

const BASE = 'https://www.takaratomy.co.jp/products/disneylorcana';
const UA = 'LorcanaFanDB/0.1 (unofficial fan database; research use)';
const IMG_BASE = `${BASE}/cardlist/img/card`;

/** 公式APIの posts_per_page 上限（実測値。101 以上を送っても 100 しか返らない） */
export const PER_PAGE = 100;
/** リクエスト間の待機（ミリ秒）。公式サーバへの負荷配慮 */
const SLEEP_BASE = 1200;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const politeSleep = () => sleep(SLEEP_BASE + Math.floor(Math.random() * 400));

// ============================ キーワード能力の辞書 ============================
// scraper/keywords.mjs と同一の定義（総合ルール第8章）。
// 両方を手で直すと必ずズレるので、変更時はここと keywords.mjs の両方を直す。

export const KEYWORD_ABILITIES = [
  '警戒', '護衛', '果敢', '回避', '暴勇', '耐久',
  '突進', '変身', '歌声', '合唱', '支援', '霧消', '魔除',
] as const;

/** 変身の亜種（総合ルール 8.9.8） */
const SHIFT_VARIANTS = ['だれでも変身', 'おふたり変身', 'まとめて変身', 'かりそめ変身', 'ポテト変身'];

/**
 * rules_text からキーワード能力を検出する。
 * 太字マーカー <...> の中身だけを見るのが要点。
 * 「〜を変身させる」のような一般動詞を能力として誤検出しないため。
 */
export function detectKeywords(rulesText: string | null | undefined, classSet?: Set<string>): string[] {
  if (!rulesText) return [];
  const found = new Set<string>();
  const text = String(rulesText).replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  const markers = [...text.matchAll(/<([^<>]{1,40})>/g)].map((m) => m[1].trim());

  for (const marker of markers) {
    for (const kw of KEYWORD_ABILITIES) {
      if (marker === kw || new RegExp(`^${kw}\\s*[+＋]?\\s*[0-9０-９]*$`).test(marker)) {
        found.add(kw);
      }
    }
    for (const v of SHIFT_VARIANTS) {
      if (marker === v || marker.startsWith(v)) {
        found.add(v);
        found.add('変身');
      }
    }
    // 「[クラス]変身」（例: 子犬変身）— 種族マスタと突合して初めて能力と認める
    if (classSet && marker.endsWith('変身')) {
      const prefix = marker.slice(0, -2);
      if (classSet.has(prefix)) {
        found.add(marker);
        found.add('変身');
      }
    }
  }
  if (/歌える/.test(text)) found.add('歌える');
  return [...found];
}

/** 表示用プレースホルダを除去して検索用プレーンテキスト化（build_sql.mjs の toPlain と同一） */
export function toPlain(text: string | null | undefined): string {
  if (!text) return '';
  return String(text)
    .replace(/\{[EILSW〇×]\}/g, ' ')
    .replace(/\{[^}]{0,12}\}/g, ' ')
    .replace(/《\/?c-[a-z]+》/g, '')
    .replace(/\\/g, '')
    .replace(/%/g, ' ')
    .replace(/&lt;|&gt;|[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** \能力名\ を抽出 */
function extractAbilityNames(text: string | null | undefined): string[] {
  if (!text) return [];
  const out: string[] = [];
  const re = /\\([^\\]{1,40})\\/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(String(text)))) {
    const s = m[1].trim();
    if (s) out.push(s);
  }
  return [...new Set(out)];
}

// ============================ 公式カード検索API ============================

/** Cookie を保持しないと CSRF トークンが通らないため簡易 jar を持つ */
class Session {
  private jar = new Map<string, string>();
  token = '';

  private cookieHeader(): string {
    return [...this.jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  private absorb(res: Response) {
    // Workers の Headers は getSetCookie を持つ。無い環境では単一ヘッダで代替。
    const raw: string[] =
      (res.headers as any).getSetCookie?.() ??
      (res.headers.get('set-cookie') ? [res.headers.get('set-cookie') as string] : []);
    for (const c of raw) {
      const kv = c.split(';')[0];
      const i = kv.indexOf('=');
      if (i > 0) this.jar.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
    }
  }

  async fetchToken(): Promise<string> {
    const res = await fetch(`${BASE}/api1.0/card-search/token.json`, {
      method: 'POST',
      headers: { 'User-Agent': UA, Referer: `${BASE}/cardlist/`, Cookie: this.cookieHeader() },
    });
    this.absorb(res);
    if (res.status !== 200) throw new Error(`token status=${res.status}`);
    const json = (await res.json()) as any;
    // 注意: data.csrf ではなく直下 csrf
    if (!json?.csrf) throw new Error('csrf missing in token response');
    this.token = String(json.csrf);
    return this.token;
  }

  async searchPage(page: number): Promise<{ count: number; cards: any[] }> {
    const body = new URLSearchParams();
    body.set('freeword', '');
    for (const f of ['カード名', 'バージョン名', '読み', 'クラス', 'テキスト', 'フレーバー', 'イラストレーター']) {
      body.append('freeword_field[]', f);
    }
    body.set('ink_type', 'すべて');
    for (const k of ['ink_color[]', 'card_type[]', 'classification[]', 'rarity[]', 'ability[]', 'sets[]', 'inkwell[]']) {
      body.append(k, 'すべて');
    }
    // *_min / *_max は送らない（送ると絞込扱いになり件数が減る）
    body.set('search_sort', 'リリース順');
    body.set('posts_per_page', String(PER_PAGE));
    body.set('page', String(page));

    const res = await fetch(`${BASE}/api1.0/card-search/result`, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-CSRF-Token': this.token,
        Referer: `${BASE}/cardlist/`,
        Cookie: this.cookieHeader(),
      },
      body,
    });
    this.absorb(res);
    if (res.status !== 200) {
      const err: any = new Error(`search status=${res.status}`);
      err.status = res.status;
      throw err;
    }
    const json = (await res.json()) as any;
    return { count: Number(json?.count ?? 0), cards: Array.isArray(json?.cards) ? json.cards : [] };
  }

  /** 403（トークン失効）や一時的な失敗に対して、取り直して最大3回まで再試行 */
  async searchPageResilient(page: number): Promise<{ count: number; cards: any[] }> {
    let lastErr: any;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return await this.searchPage(page);
      } catch (e) {
        lastErr = e;
        if (attempt === 3) break;
        await sleep(1500);
        await this.fetchToken();
        await politeSleep();
      }
    }
    throw lastErr;
  }
}

export async function openSession(): Promise<Session> {
  const s = new Session();
  await s.fetchToken();
  return s;
}

// ============================ カードの差分適用 ============================

export type CardApplyResult = {
  inserted: number;
  updated: number;
  unchanged: number;
  newCards: Array<{ id: number; card_name: string; version: string | null; sets: string | null }>;
};

/**
 * 公式APIのカード配列を D1 に反映する。
 *
 * 差分判定は「公式の modified」ではなく実データのハッシュ相当（rules_text + 主要数値）で行う。
 * 公式の modified は表記修正でも動くことがあり、逆に信用しすぎると
 * 「変わっていないのに毎回全件書き換え」になって D1 の書き込みが無駄に増える。
 */
export async function applyCards(
  db: D1Database,
  cards: any[],
  classSet: Set<string>
): Promise<CardApplyResult> {
  const res: CardApplyResult = { inserted: 0, updated: 0, unchanged: 0, newCards: [] };
  if (!cards.length) return res;

  // 既存行の照合用データを一括取得（D1 の変数上限 ~100 に配慮して 80 件ずつ）
  const ids = cards.map((c) => Number(c.id)).filter((n) => Number.isFinite(n));
  const existing = new Map<number, { rules_text: string | null; sig: string }>();
  for (let i = 0; i < ids.length; i += 80) {
    const chunk = ids.slice(i, i + 80);
    const r = await db
      .prepare(
        `SELECT id, rules_text,
                (COALESCE(card_name,'')||'/'||COALESCE(version,'')||'/'||COALESCE(ink_cost,-1)||'/'||
                 COALESCE(strength,-1)||'/'||COALESCE(willpower,-1)||'/'||COALESCE(lore_value,-1)||'/'||
                 COALESCE(rarity,'')||'/'||COALESCE(sets_name,'')||'/'||COALESCE(inkwell,'')) AS sig
           FROM cards WHERE id IN (${chunk.map(() => '?').join(',')})`
      )
      .bind(...chunk)
      .all();
    for (const row of (r.results ?? []) as any[]) {
      existing.set(Number(row.id), { rules_text: row.rules_text ?? null, sig: String(row.sig ?? '') });
    }
  }

  const stmts: D1PreparedStatement[] = [];

  for (const c of cards) {
    const id = Number(c.id);
    if (!Number.isFinite(id)) continue;

    const classes = [
      ...new Set(((c.classifications ?? []) as any[]).map((x) => x?.classification).filter(Boolean)),
    ] as string[];
    const abilities = detectKeywords(c.rules_text, classSet);
    const abilityNames = extractAbilityNames(c.rules_text);
    const rulesPlain = toPlain(c.rules_text);
    const flavorPlain = toPlain(c.flavor_text);
    const inkType = c.ink_color2 ? 'デュアル' : 'シングル';

    const searchBlob = [
      c.card_name, c.search_card_name, c.rubi, c.search_rubi, c.version,
      rulesPlain, flavorPlain, c.artist_credit1, c.artist_credit2,
      classes.join(' '), abilities.join(' '), abilityNames.join(' '),
      c.card_file, c.sets,
    ].filter(Boolean).join(' ');

    const sig = [
      c.card_name ?? '', c.version ?? '',
      c.ink_cost ?? -1, c.strength ?? -1, c.willpower ?? -1, c.lore_value ?? -1,
      c.rarity ?? '', c.sets ?? '', c.inkwell ?? '',
    ].join('/');

    const prev = existing.get(id);
    if (!prev) {
      res.inserted++;
      res.newCards.push({ id, card_name: String(c.card_name ?? ''), version: c.version ?? null, sets: c.sets ?? null });
    } else if (prev.sig !== sig || (prev.rules_text ?? '') !== (c.rules_text ?? '')) {
      res.updated++;
    } else {
      res.unchanged++;
      continue; // 変化なし → 書き込みを省略（D1 の書き込み回数を節約）
    }

    stmts.push(
      db
        .prepare(
          `INSERT OR REPLACE INTO cards
             (id,card_file,collector_number,card_name,search_card_name,rubi,version,card_group,card_type,
              ink_color,ink_color2,primary_ink_color,ink_type,rarity,inkwell,ink_cost,strength,willpower,
              move_cost,lore_value,rules_text,rules_text_plain,ability_names,flavor_text,sets_name,sets_order,
              release_date,artist_credit1,artist_credit2,color_order,type_order,limit_card,image_url,search_blob,
              created_at,modified_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        )
        .bind(
          id, c.card_file ?? null, num(c.collector_number), c.card_name ?? null, c.search_card_name ?? null,
          c.rubi ?? null, c.version ?? null, c.card_group ?? null, c.card_type ?? null,
          c.ink_color ?? null, c.ink_color2 ?? null, c.primary_ink_color ?? null, inkType,
          c.rarity ?? null, c.inkwell ?? 'n', num(c.ink_cost), num(c.strength), num(c.willpower),
          num(c.move_cost), num(c.lore_value), c.rules_text ?? null, rulesPlain,
          abilityNames.join('|'), c.flavor_text ?? null, c.sets ?? null, num(c.sets_order),
          num(c.release_date), c.artist_credit1 ?? null, c.artist_credit2 ?? null,
          num(c.color_order), num(c.type_order), num(c.limit_card),
          `${IMG_BASE}/${c.card_file}.png`, searchBlob, c.created ?? null, c.modified ?? null
        )
    );

    // 付随テーブルは作り直す（種族や能力が減った場合に古い行が残らないように）
    stmts.push(db.prepare('DELETE FROM classifications WHERE card_id = ?').bind(id));
    for (const cl of classes) {
      stmts.push(db.prepare('INSERT OR IGNORE INTO classifications (card_id, classification) VALUES (?, ?)').bind(id, cl));
    }
    stmts.push(db.prepare('DELETE FROM abilities WHERE card_id = ?').bind(id));
    for (const ab of abilities) {
      stmts.push(db.prepare('INSERT OR IGNORE INTO abilities (card_id, ability) VALUES (?, ?)').bind(id, ab));
    }

    // 効果テキストが言及する種族（シナジー逆引き用）を再計算
    stmts.push(db.prepare('DELETE FROM card_refs WHERE card_id = ?').bind(id));
    if (rulesPlain) {
      for (const cl of classSet) {
        if (cl.length < 2) continue;
        if (classes.includes(cl)) continue; // 自身の種族は「参照」ではない
        if (rulesPlain.includes(cl)) {
          stmts.push(db.prepare('INSERT OR IGNORE INTO card_refs (card_id, classification) VALUES (?, ?)').bind(id, cl));
        }
      }
    }

    // カード個別FAQのスラッグ（本文は別ソース）
    for (const f of (c.faqs ?? []) as any[]) {
      if (f?.id == null) continue;
      stmts.push(
        db
          .prepare('INSERT OR IGNORE INTO faqs (id, card_id, question, answer) VALUES (?, ?, ?, ?)')
          .bind(Number(f.id), id, f.question ?? f.faq ?? f.q ?? null, f.answer ?? f.ans ?? f.a ?? null)
      );
    }
  }

  await runBatched(db, stmts);
  return res;
}

const num = (v: any) => (v === null || v === undefined || v === '' ? null : Number(v));

/** db.batch はバインド数上限があるため分割して実行する */
export async function runBatched(db: D1Database, stmts: D1PreparedStatement[], size = 40) {
  for (let i = 0; i < stmts.length; i += size) {
    await db.batch(stmts.slice(i, i + size));
  }
}

/** 種族マスタ（card_refs / [クラス]変身 の突合に使う）を DB から読む */
export async function loadClassSet(db: D1Database): Promise<Set<string>> {
  const r = await db.prepare('SELECT DISTINCT classification FROM classifications').all();
  return new Set(((r.results ?? []) as any[]).map((x) => String(x.classification)).filter(Boolean));
}

// ============================ ルールPDFの版チェック ============================

export const RULE_SOURCES = [
  { source: 'comprehensive', label: '総合ルール', file: 'Disney-Lorcana-Comprehensive-Rules_JP.pdf' },
  { source: 'guidelines', label: 'プレイ修正ガイドライン', file: 'Disney_Lorcana_Play_Correction_Guidelines_JP.pdf' },
  // 旧実装は Disney_Tournament_Rules_JP.pdf を見ていて 404 だった。正しくは Disney_Lorcana_ 接頭辞。
  { source: 'tournament', label: '大会ルール', file: 'Disney_Lorcana_Tournament_Rules_JP.pdf' },
  { source: 'set_notes_s1', label: 'セットノート S1', file: 's1_set_notes.pdf' },
] as const;

export type RuleCheck = {
  source: string;
  label: string;
  url: string;
  status: number;
  last_modified: string | null;
  content_length: number | null;
  imported_last_modified: string | null;
  changed: boolean;
};

/**
 * PDF本体は落とさず、ヘッダだけで更新の有無を判定する。
 * 総合ルールは 4.3MB あり、Workers で毎回取得＋パースするのは非現実的。
 * 「改定を検知して管理者に知らせる」ところまでを Worker が担当し、
 * 実際のテキスト化は pdftotext を持つ開発機（scraper/fetch_rules.mjs）で行う。
 */
export async function checkRuleSources(db: D1Database): Promise<RuleCheck[]> {
  const out: RuleCheck[] = [];
  for (const src of RULE_SOURCES) {
    const url = `${BASE}/common/pdf/${src.file}`;
    let status = 0;
    let lastModified: string | null = null;
    let contentLength: number | null = null;
    let etag: string | null = null;
    try {
      // HEAD が通らないサイトもあるので Range で 1 バイトだけ要求して代替する
      const res = await fetch(url, {
        method: 'GET',
        headers: { 'User-Agent': UA, Referer: `${BASE}/rule-faq/`, Range: 'bytes=0-0' },
      });
      status = res.status;
      lastModified = res.headers.get('last-modified');
      etag = res.headers.get('etag');
      const cr = res.headers.get('content-range'); // "bytes 0-0/4347763"
      const total = cr?.split('/')?.[1];
      contentLength = total ? Number(total) : Number(res.headers.get('content-length') ?? 0) || null;
      // 本文は使わないので読み捨てる（接続を残さない）
      await res.arrayBuffer().catch(() => undefined);
    } catch (e: any) {
      status = 0;
    }

    const prev = await db
      .prepare('SELECT imported_last_modified FROM source_versions WHERE source = ?')
      .bind(src.source)
      .first<{ imported_last_modified: string | null }>();
    let importedLm = prev?.imported_last_modified ?? null;

    /**
     * 初回チェック時の扱い。
     * 初期構築（scraper/fetch_rules.mjs）で既に取り込んだ文書は source_versions に
     * 記録が無いため、そのままだと全部「要更新」と出て本当の改定を見落とす。
     * rules_sections に条文が入っている文書は「今の版を取り込み済み」とみなして初期化する。
     * 初期構築は各PDFの最終更新日より後なので、この推定は安全側に働く。
     */
    if (!prev && lastModified) {
      const has = await db
        .prepare('SELECT COUNT(*) AS n FROM rules_sections WHERE source = ?')
        .bind(src.source)
        .first<{ n: number }>();
      if (Number(has?.n ?? 0) > 0) importedLm = lastModified;
    }

    await db
      .prepare(
        `INSERT INTO source_versions (source,label,url,last_modified,content_length,etag,checked_at,updated_at)
           VALUES (?,?,?,?,?,?,datetime('now'),datetime('now'))
         ON CONFLICT(source) DO UPDATE SET
           label=excluded.label, url=excluded.url, last_modified=excluded.last_modified,
           content_length=excluded.content_length, etag=excluded.etag,
           checked_at=datetime('now'), updated_at=datetime('now')`
      )
      .bind(src.source, src.label, url, lastModified, contentLength, etag)
      .run();

    // 初期化した推定値は DB にも書いて、次回以降の判定基準にする
    if (!prev && importedLm) {
      await db
        .prepare('UPDATE source_versions SET imported_last_modified = ? WHERE source = ?')
        .bind(importedLm, src.source)
        .run();
    }

    out.push({
      source: src.source,
      label: src.label,
      url,
      status,
      last_modified: lastModified,
      content_length: contentLength,
      imported_last_modified: importedLm,
      // Range リクエストの成功は 206 Partial Content。200 だけ見ていると常に false になる
      changed: (status === 200 || status === 206) && !!lastModified && lastModified !== importedLm,
    });
    await politeSleep();
  }
  return out;
}

/** 取り込み済みの版として記録（開発機でテキスト化を反映したあとに押す） */
export async function markRuleImported(db: D1Database, source: string): Promise<void> {
  await db
    .prepare(
      `UPDATE source_versions
          SET imported_last_modified = last_modified, updated_at = datetime('now')
        WHERE source = ?`
    )
    .bind(source)
    .run();
}

// ============================ 公式ルールQ&A ============================

const decodeEntities = (s: string) =>
  s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

const stripTags = (s: string) => decodeEntities(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

/**
 * 公式「ルール・Q&A」ページから Q&A 本文を取得する。
 *
 * これまで faqs テーブルはスラッグ（set1-no14-1）しか持てておらず、
 * AI に渡せる裁定情報になっていなかった。このページには本文があるので、
 * ルール一般のQ&Aとして rule_faqs に取り込む。
 */
export async function fetchRuleFaqs(db: D1Database): Promise<{ fetched: number; inserted: number; updated: number }> {
  const url = `${BASE}/rule-faq/faq/`;
  const res = await fetch(url, { headers: { 'User-Agent': UA, Referer: `${BASE}/rule-faq/` } });
  if (res.status !== 200) throw new Error(`faq page status=${res.status}`);
  const html = await res.text();

  // 見出し（h3）を位置つきで拾い、各Q&Aの直前の見出しをカテゴリとして割り当てる
  const headings: Array<{ pos: number; text: string }> = [];
  for (const m of html.matchAll(/<h3[^>]*class="p-rulefaq-faq__heading-3"[^>]*>([\s\S]*?)<\/h3>/g)) {
    headings.push({ pos: m.index ?? 0, text: stripTags(m[1]) });
  }

  const items = [...html.matchAll(/<li[^>]*class="p-rulefaq-faq__list-qa-item"[^>]*>([\s\S]*?)<\/li>/g)];
  let inserted = 0;
  let updated = 0;
  const stmts: D1PreparedStatement[] = [];

  for (const m of items) {
    const block = m[1];
    const pos = m.index ?? 0;
    const q = block.match(/class="p-rulefaq-faq__list-qa-item-question"[^>]*>([\s\S]*?)<\//);
    const a = block.match(/class="p-rulefaq-faq__list-qa-item-answer-text"[^>]*>([\s\S]*?)<\/(?:div|p)>/);
    const t = block.match(/class="p-rulefaq-faq__list-qa-item-time"[^>]*>([\s\S]*?)<\//);
    const question = q ? stripTags(q[1]) : '';
    const answer = a ? stripTags(a[1]) : '';
    if (!question || !answer) continue;

    let category = '';
    for (const h of headings) if (h.pos < pos) category = h.text;

    const qHash = await sha1(question);
    const prev = await db.prepare('SELECT id, answer FROM rule_faqs WHERE q_hash = ?').bind(qHash).first<any>();
    if (!prev) inserted++;
    else if (String(prev.answer) !== answer) updated++;
    else continue;

    stmts.push(
      db
        .prepare(
          `INSERT INTO rule_faqs (category, question, answer, note, q_hash, source_url, updated_at)
             VALUES (?,?,?,?,?,?,datetime('now'))
           ON CONFLICT(q_hash) DO UPDATE SET
             category=excluded.category, answer=excluded.answer, note=excluded.note,
             source_url=excluded.source_url, updated_at=datetime('now')`
        )
        .bind(category || null, question, answer, t ? stripTags(t[1]) : null, qHash, url)
    );
  }

  await runBatched(db, stmts);
  return { fetched: items.length, inserted, updated };
}

async function sha1(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export { politeSleep };
