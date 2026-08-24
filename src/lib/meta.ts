/**
 * meta.ts — 最新環境情報の収集エンジン
 *
 * ■ 何をするか
 *   承認済みの情報源から記事・大会・デッキレシピを取得し、
 *   meta_raw_items / meta_events / meta_decks に正規化して蓄積する。
 *   ここでは要約しない（要約は metaReport.ts）。収集と解釈を分けておくと、
 *   要約プロンプトを直しても再収集が不要になる。
 *
 * ■ 遵守事項（updater.ts と同じ方針を維持）
 *   - User-Agent を正直に名乗る
 *   - 直列1本のみ・リクエスト間スリープ
 *   - robots.txt で拒否されているサイトは実装しない
 *     （inkdecks / duels.ink / dreamborn / melee.gg / shop-disneylorcana / x.com）
 *   - 非公式ソースの本文は「抜粋」までに留め、全文を保存・再配信しない
 *
 * ■ Workers の制約に対する設計
 *   1リクエスト内で全ソースを回すと CPU 時間・実行時間に収まらないため、
 *   ソース単位で処理し、管理画面/Cron が順に叩く方式にする。
 */

const UA = 'LorcanaFanDB/0.1 (unofficial fan database; research use; contact via site footer)';

const TT_BASE = 'https://www.takaratomy.co.jp/products/disneylorcana';
const TT_WP = `${TT_BASE}/wp-json/wp/v2`;
const EN_BASE = 'https://www.disneylorcana.com';
const JP_COMMUNITY = 'https://disneylorcana.jp';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** 礼儀スリープ。収集は急がないので余裕を持たせる */
export const politeSleep = () => sleep(900 + Math.floor(Math.random() * 400));

/** 公式WP RESTのカテゴリID（実測）。35=コラム/戦略記事, 2=イベント, 1=製品, 3=キャンペーン */
export const TT_CATEGORY = { product: 1, event: 2, campaign: 3, other: 4, column: 35 } as const;

// ============================ 共通ユーティリティ ============================

export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * URLを正規化してから重複判定に使う。
 * クエリのトラッキングパラメータやフラグメントで同じ記事が二重登録されるのを防ぐ。
 */
export function canonicalUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = '';
    for (const k of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|ref|source)/i.test(k)) u.searchParams.delete(k);
    }
    // 末尾スラッシュの有無を統一（/news/123 と /news/123/ を同一視）
    u.pathname = u.pathname.replace(/\/+$/, '') || '/';
    return u.toString();
  } catch {
    return raw;
  }
}

const decodeEntities = (s: string) =>
  s
    .replace(/&nbsp;/g, ' ')
    .replace(/&#8217;|&#039;|&#39;/g, "'")
    .replace(/&#8211;|&#8212;/g, '–')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));

export const stripTags = (s: string) =>
  decodeEntities(String(s ?? '').replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();

/** ISO文字列 → 'YYYY-MM-DD'（日付だけ使う場面が多いため） */
export const dateOnly = (iso: string | null | undefined): string | null => {
  if (!iso) return null;
  const m = String(iso).match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (!m) return null;
  return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
};

/** JST の「今日」。Workers の now は UTC なので +9h して切る */
export function jstToday(): string {
  const d = new Date(Date.now() + 9 * 3600_000);
  return d.toISOString().slice(0, 10);
}

export function jstNow(): string {
  return new Date(Date.now() + 9 * 3600_000).toISOString().replace('T', ' ').slice(0, 16);
}

async function politeFetch(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {}
): Promise<{ status: number; text: string; headers: Headers }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), init.timeoutMs ?? 20_000);
  try {
    const res = await fetch(url, {
      ...init,
      headers: { 'User-Agent': UA, Accept: '*/*', ...(init.headers ?? {}) },
      signal: ctrl.signal,
    });
    const text = await res.text();
    return { status: res.status, text, headers: res.headers };
  } finally {
    clearTimeout(timer);
  }
}

// ============================ 情報源の状態管理 ============================

export type SourceRow = {
  key: string;
  label: string;
  url: string;
  region: string;
  kind: string;
  method: string;
  is_official: number;
  trust: number;
  enabled: number;
  // 障害監視用の列（SELECT * で入ってくる。呼び出し側が再収集判定に使う）
  last_status?: number | null;
  last_ok_at?: string | null;
  last_error?: string | null;
  fail_streak?: number;
  checked_at?: string | null;
  // 規約情報（0007で追加）。content_signal に ai-train=no があるサイトは
  // 記憶層への恒久保存を避けるため allow_memory=0 で運用する
  content_signal?: string | null;
  allow_memory?: number;
  requires_secret?: string | null;
  note?: string | null;
};

export async function loadSources(db: D1Database, keys?: string[]): Promise<SourceRow[]> {
  const sql = keys?.length
    ? `SELECT * FROM meta_sources WHERE enabled=1 AND key IN (${keys.map(() => '?').join(',')})`
    : 'SELECT * FROM meta_sources WHERE enabled=1 ORDER BY is_official DESC, trust DESC';
  const r = keys?.length ? await db.prepare(sql).bind(...keys).all() : await db.prepare(sql).all();
  return ((r.results ?? []) as any[]) as SourceRow[];
}

async function markSource(
  db: D1Database,
  key: string,
  status: number,
  error?: string
): Promise<void> {
  const ok = status >= 200 && status < 400;
  await db
    .prepare(
      `UPDATE meta_sources
          SET last_status=?, checked_at=datetime('now'), updated_at=datetime('now'),
              last_ok_at = CASE WHEN ? THEN datetime('now') ELSE last_ok_at END,
              last_error = CASE WHEN ? THEN NULL ELSE ? END,
              fail_streak = CASE WHEN ? THEN 0 ELSE fail_streak + 1 END
        WHERE key = ?`
    )
    .bind(status, ok ? 1 : 0, ok ? 1 : 0, String(error ?? '').slice(0, 300), ok ? 1 : 0, key)
    .run();
}

// ============================ 生データの登録 ============================

export type RawItem = {
  url: string;
  title: string;
  excerpt: string;
  observed_at: string | null;
  image_url?: string | null;
  kind?: string;
  meta?: Record<string, any>;
};

export type UpsertResult = { inserted: number; updated: number; unchanged: number };

/**
 * 生データを差分登録する。
 *
 * 差分判定は body_hash（タイトル+抜粋）で行う。
 * URLが同じでも内容が変わっていれば summarized_at をクリアして
 * 「再要約が必要な新着」に戻す。公式が記事を追記更新することがあるため。
 */
export async function upsertRawItems(
  db: D1Database,
  src: SourceRow,
  items: RawItem[]
): Promise<UpsertResult> {
  const res: UpsertResult = { inserted: 0, updated: 0, unchanged: 0 };
  if (!items.length) return res;

  const prepared: Array<{ item: RawItem; url: string; urlHash: string; bodyHash: string }> = [];
  for (const it of items) {
    if (!it.url || !it.title) continue;
    const url = canonicalUrl(it.url);
    prepared.push({
      item: it,
      url,
      urlHash: await sha256Hex(url),
      bodyHash: await sha256Hex(`${it.title}\n${it.excerpt}\n${it.observed_at ?? ''}`),
    });
  }
  if (!prepared.length) return res;

  // 既存行を一括で引く（D1の変数上限に配慮して80件ずつ）
  const existing = new Map<string, { body_hash: string | null }>();
  const hashes = prepared.map((p) => p.urlHash);
  for (let i = 0; i < hashes.length; i += 80) {
    const chunk = hashes.slice(i, i + 80);
    const r = await db
      .prepare(
        `SELECT url_hash, body_hash FROM meta_raw_items
          WHERE url_hash IN (${chunk.map(() => '?').join(',')})`
      )
      .bind(...chunk)
      .all();
    for (const row of (r.results ?? []) as any[]) {
      existing.set(String(row.url_hash), { body_hash: row.body_hash ?? null });
    }
  }

  const stmts: D1PreparedStatement[] = [];
  for (const p of prepared) {
    const prev = existing.get(p.urlHash);
    if (prev && prev.body_hash === p.bodyHash) {
      res.unchanged++;
      continue;
    }
    prev ? res.updated++ : res.inserted++;

    stmts.push(
      db
        .prepare(
          `INSERT INTO meta_raw_items
             (source_key,url,url_hash,title,excerpt,body_hash,lang,region,kind,
              observed_at,fetched_at,citable,trust,image_url,summarized_at,meta_json)
           VALUES (?,?,?,?,?,?,?,?,?,?,datetime('now'),?,?,?,NULL,?)
           ON CONFLICT(url_hash) DO UPDATE SET
             title=excluded.title, excerpt=excluded.excerpt, body_hash=excluded.body_hash,
             observed_at=excluded.observed_at, fetched_at=datetime('now'),
             image_url=excluded.image_url, meta_json=excluded.meta_json,
             -- 内容が変わったので再要約の対象に戻す
             summarized_at=NULL`
        )
        .bind(
          src.key,
          p.url,
          p.urlHash,
          p.item.title.slice(0, 300),
          p.item.excerpt.slice(0, 1800),
          p.bodyHash,
          src.region === 'en' ? 'en' : 'ja',
          src.region,
          p.item.kind ?? src.kind,
          p.item.observed_at,
          src.is_official,
          src.trust,
          p.item.image_url ?? null,
          p.item.meta ? JSON.stringify(p.item.meta).slice(0, 2000) : null
        )
    );
  }
  await runBatched(db, stmts);
  return res;
}

export async function runBatched(db: D1Database, stmts: D1PreparedStatement[], size = 40) {
  for (let i = 0; i < stmts.length; i += size) {
    await db.batch(stmts.slice(i, i + size));
  }
}

// ============================ 収集: タカラトミー公式（WP REST） ============================

/**
 * 公式ニュース／コラム／イベントを WP REST API から取得する。
 *
 * robots.txt は `Allow: /`。WP REST が公開されているので HTML を
 * スクレイピングする必要がない（サーバ負荷も軽い）。
 * date / modified / link / categories / content.rendered が取れる。
 */
export async function collectTakaratomy(
  db: D1Database,
  src: SourceRow,
  opts: { perPage?: number; categories?: number[] } = {}
): Promise<UpsertResult & { status: number }> {
  const perPage = Math.min(30, opts.perPage ?? 20);
  const cats = opts.categories?.length ? `&categories=${opts.categories.join(',')}` : '';
  const url = `${TT_WP}/posts?per_page=${perPage}&orderby=date&order=desc${cats}&_fields=id,date,modified,link,title,excerpt,content,categories`;

  let status = 0;
  try {
    const r = await politeFetch(url);
    status = r.status;
    if (r.status !== 200) {
      await markSource(db, src.key, r.status, `http ${r.status}`);
      return { inserted: 0, updated: 0, unchanged: 0, status: r.status };
    }
    const posts = JSON.parse(r.text) as any[];
    const items: RawItem[] = posts.map((p) => {
      const body = stripTags(String(p?.content?.rendered ?? p?.excerpt?.rendered ?? ''));
      const cats: number[] = Array.isArray(p?.categories) ? p.categories.map(Number) : [];
      return {
        url: String(p?.link ?? ''),
        title: stripTags(String(p?.title?.rendered ?? '')),
        // 公式は本文を持てるが、要約に必要な範囲（先頭1500字）に留める
        excerpt: body.slice(0, 1500),
        observed_at: dateOnly(p?.date),
        kind: cats.includes(TT_CATEGORY.event) ? 'event' : cats.includes(TT_CATEGORY.column) ? 'article' : 'news',
        meta: { post_id: p?.id, categories: cats, modified: dateOnly(p?.modified) },
      };
    });
    const res = await upsertRawItems(db, src, items);
    await markSource(db, src.key, 200);
    return { ...res, status: 200 };
  } catch (e: any) {
    await markSource(db, src.key, status || 0, String(e?.message ?? e));
    throw e;
  }
}

// ============================ 収集: Ravensburger 公式（EN） ============================

/**
 * 公式ENニュース一覧から記事スラッグを列挙する。
 *
 * このサイトは Nuxt の SSR で、記事リンクが `news_/2026_/06_/slug` という
 * エスケープされた形で埋まっている（href属性としては出てこない）。
 * ページネーションは ?page=N で、10ページで全116記事だった。
 */
export function parseEnNewsSlugs(html: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/news_\/(\d{4})_\/(\d{2})_\/([A-Za-z0-9_-]+)/g)) {
    out.add(`${m[1]}/${m[2]}/${m[3]}`);
  }
  return [...out];
}

/** 大会レポート系のスラッグか（公式EN大会レポートの収集強化） */
export function isTournamentSlug(slug: string): boolean {
  return /recap|championship|challenge|tournament|regional|worlds|results/i.test(slug);
}

export type EnArticle = {
  slug: string;
  url: string;
  title: string;
  published: string | null;
  text: string;
  /** 「N CardName」形式の行（入賞デッキリスト） */
  deckLines: Array<{ qty: number; name: string }>;
  /** 見出し（優勝者名・アーキタイプが入る） */
  headings: string[];
  /** メタ内訳（"Amber/Emerald ... 21.2%" のような記述） */
  metaShares: Array<{ label: string; share: number }>;
};

const EN_INKS = ['Amber', 'Amethyst', 'Emerald', 'Ruby', 'Sapphire', 'Steel'];

/**
 * EN記事HTMLを構造化する。
 *
 * 本文は <p>/<h2>/<li> に入っており、デッキリストは 1行1枚で
 * 「4 Be Prepared」のような <p> になっている（実測: Top8 で 480枚 = 60×8）。
 * 公開日は JSON-LD の datePublished（ミリ秒エポック）から取る。
 * 「いつの情報か」が最重要なので、日付が取れない記事は日付なしとして扱い、
 * 要約では使わない（誤って「最新」に見せない）。
 */
export function parseEnArticle(slug: string, html: string): EnArticle {
  const body = html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  const blocks: Array<{ tag: string; text: string }> = [];
  for (const m of body.matchAll(/<(h[1-3]|p|li)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const text = stripTags(m[2]);
    if (text) blocks.push({ tag: m[1].toLowerCase(), text });
  }

  const deckLines: Array<{ qty: number; name: string }> = [];
  for (const b of blocks) {
    // 「4 Be Prepared」形式。文章（末尾に句読点、長すぎる）は除外する
    const m = b.text.match(/^(\d{1,2})\s+([A-Z][^.!?]{1,45})$/);
    if (m) deckLines.push({ qty: Number(m[1]), name: m[2].trim() });
  }

  const headings = blocks.filter((b) => b.tag.startsWith('h')).map((b) => b.text);

  // メタ内訳: 「Amber/Emerald Dogs ... 21.2%」の形で本文に書かれている
  const metaShares: Array<{ label: string; share: number }> = [];
  const inkPair = new RegExp(`(${EN_INKS.join('|')})\\s*/\\s*(${EN_INKS.join('|')})`, 'g');
  for (const b of blocks) {
    if (!/%/.test(b.text)) continue;
    // 1文ずつ見て「インク組合せ」と「％」が同じ文にあるものを拾う
    for (const sentence of b.text.split(/(?<=[.!?])\s+/)) {
      inkPair.lastIndex = 0;
      const pm = inkPair.exec(sentence);
      if (!pm) continue;
      const sm = sentence.match(/(\d{1,2}(?:\.\d)?)\s*%/);
      if (!sm) continue;
      metaShares.push({ label: `${pm[1]}/${pm[2]}`, share: Number(sm[1]) });
    }
  }

  const ts = html.match(/datePublished\\?":(\d{10,16})/);
  const published = ts
    ? new Date(Number(ts[1]) / (ts[1].length > 13 ? 1000 : 1)).toISOString().slice(0, 10)
    : null;

  const h1 = blocks.find((b) => b.tag === 'h1')?.text ?? slug;
  // 本文テキスト。ナビゲーション由来の長大な <li> は除外する
  const text = blocks
    .filter((b) => b.tag !== 'li' || b.text.length < 200)
    .map((b) => b.text)
    .join('\n')
    .slice(0, 6000);

  return {
    slug,
    url: `${EN_BASE}/en-US/news/${slug}`,
    title: h1,
    published,
    text,
    deckLines,
    headings,
    metaShares,
  };
}

/**
 * 公式ENニュースを収集する。大会レポートを優先して本文まで取る。
 *
 * 全116記事の本文を毎回取ると Workers の実行時間を超えるため、
 * 一覧から新着スラッグを拾い、未取得のものだけを maxArticles 件処理する。
 */
export async function collectEnNews(
  db: D1Database,
  src: SourceRow,
  opts: { pages?: number; maxArticles?: number; tournamentOnly?: boolean } = {}
): Promise<UpsertResult & { status: number; slugs: number; fetched: number }> {
  const pages = Math.max(1, Math.min(10, opts.pages ?? 2));
  const maxArticles = Math.max(1, Math.min(12, opts.maxArticles ?? 6));

  const slugs = new Set<string>();
  let status = 0;
  for (let p = 1; p <= pages; p++) {
    if (p > 1) await politeSleep();
    const r = await politeFetch(`${EN_BASE}/en-US/news${p > 1 ? `?page=${p}` : ''}`);
    status = r.status;
    if (r.status !== 200) break;
    for (const s of parseEnNewsSlugs(r.text)) slugs.add(s);
  }
  if (!slugs.size) {
    await markSource(db, src.key, status || 0, 'no slugs');
    return { inserted: 0, updated: 0, unchanged: 0, status, slugs: 0, fetched: 0 };
  }

  // 大会レポートを優先。スラッグは YYYY/MM/... なので降順で新しい順になる
  const ordered = [...slugs].sort().reverse();
  const targets = opts.tournamentOnly
    ? ordered.filter(isTournamentSlug)
    : [...ordered.filter(isTournamentSlug), ...ordered.filter((s) => !isTournamentSlug(s))];

  // 既に取得済み（内容変化なし）のURLは飛ばす
  const known = new Set<string>();
  {
    const r = await db
      .prepare("SELECT url FROM meta_raw_items WHERE source_key IN ('lorcana_en_news','lorcana_en_recap')")
      .all();
    for (const row of (r.results ?? []) as any[]) known.add(String(row.url));
  }

  const pending = targets.filter((s) => !known.has(canonicalUrl(`${EN_BASE}/en-US/news/${s}`)));
  // 新着が無ければ、大会レポートだけ再チェック（追記更新の検知）
  const pick = (pending.length ? pending : targets.filter(isTournamentSlug)).slice(0, maxArticles);

  const items: RawItem[] = [];
  const articles: EnArticle[] = [];
  let fetched = 0;
  for (const slug of pick) {
    await politeSleep();
    const r = await politeFetch(`${EN_BASE}/en-US/news/${slug}`);
    if (r.status !== 200) continue;
    fetched++;
    const a = parseEnArticle(slug, r.text);
    articles.push(a);
    items.push({
      url: a.url,
      title: a.title,
      excerpt: a.text.slice(0, 1800),
      observed_at: a.published,
      kind: isTournamentSlug(slug) ? 'meta' : 'news',
      meta: {
        slug,
        deck_lines: a.deckLines.length,
        meta_shares: a.metaShares.slice(0, 12),
        headings: a.headings.slice(0, 12),
      },
    });
  }

  const res = await upsertRawItems(db, src, items);
  await markSource(db, src.key, 200);

  // 大会レポートからデッキと大会を抽出する
  for (const a of articles) {
    if (!isTournamentSlug(a.slug)) continue;
    try {
      await importEnRecap(db, a);
    } catch {
      // デッキ抽出の失敗は収集全体を止めない
    }
  }

  return { ...res, status: 200, slugs: slugs.size, fetched };
}

// ============================ EN大会レポート → 大会・デッキ ============================

const EN_INK_JA: Record<string, string> = {
  Amber: 'アンバー',
  Amethyst: 'アメジスト',
  Emerald: 'エメラルド',
  Ruby: 'ルビー',
  Sapphire: 'サファイア',
  Steel: 'スティール',
};

const PLACEMENT_WEIGHT: Record<string, number> = {
  優勝: 5,
  準優勝: 4,
  TOP4: 3,
  TOP8: 2,
  TOP32: 1,
};

/** 見出しから順位を推定する。"X wins with ..." は優勝、"dominate the Top 32" は TOP32 */
export function guessPlacement(heading: string): { placement: string | null; inks: string[] } {
  const inks: string[] = [];
  const m = heading.match(
    new RegExp(`(${EN_INKS.join('|')})\\s*/\\s*(${EN_INKS.join('|')})`, 'i')
  );
  if (m) {
    inks.push(EN_INK_JA[capitalize(m[1])] ?? m[1], EN_INK_JA[capitalize(m[2])] ?? m[2]);
  }
  let placement: string | null = null;
  if (/\bwins?\b|\bchampion\b|takes home|gold trophy/i.test(heading)) placement = '優勝';
  else if (/runner[- ]?up|finalist|second place/i.test(heading)) placement = '準優勝';
  else if (/top\s*4|semifinal/i.test(heading)) placement = 'TOP4';
  else if (/top\s*8|quarterfinal/i.test(heading)) placement = 'TOP8';
  else if (/top\s*(16|32|64)/i.test(heading)) placement = 'TOP32';
  return { placement, inks };
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();

/**
 * カード名の突合キー。
 * 英語名 "Elinor - Renowned Diplomat" と
 * card_file "086_DLCS12_Elinor_RenownedDiplomat_JA" を突き合わせる。
 * 記号を落として小文字化すると elinorrenowneddiplomat で一致する。
 * 実測: Indianapolis recap の 55行中 53行が一致（未一致2件は日本未収録）。
 */
export function joinKey(s: string): string {
  return String(s ?? '')
    .replace(/[^A-Za-z0-9\u3040-\u30ff\u4e00-\u9fff]/g, '')
    .toLowerCase();
}

/** card_file から英語名部分を取り出す（先頭の番号・セットコード・レアリティ・末尾JAを除去） */
export function cardFileNameKey(cardFile: string): string {
  let parts = String(cardFile ?? '').split('_');
  if (parts.length && /^(JA|EN)$/.test(parts[parts.length - 1])) parts = parts.slice(0, -1);
  if (parts.length && /^\d+$/.test(parts[0])) parts = parts.slice(1);
  if (parts.length && /^DLC/i.test(parts[0])) parts = parts.slice(1);
  // レアリティ略号（SAC/UAC/RAC など）が残っている場合だけ落とす
  if (parts.length > 1 && /^[A-Z]{2,4}$/.test(parts[0])) parts = parts.slice(1);
  return joinKey(parts.join(''));
}

export type CardIndex = {
  /** 英語名キー → cards.id */
  byEn: Map<string, { id: number; name: string }>;
  /** 日本語 card_group（「アリエル／麗しい歌姫」）キー → cards.id */
  byJa: Map<string, { id: number; name: string }>;
};

/** カード突合用のインデックスを作る（2,500件で約数十ms） */
export async function buildCardIndex(db: D1Database): Promise<CardIndex> {
  const r = await db.prepare('SELECT id, card_file, card_name, version, card_group FROM cards').all();
  const byEn = new Map<string, { id: number; name: string }>();
  const byJa = new Map<string, { id: number; name: string }>();
  for (const row of (r.results ?? []) as any[]) {
    const id = Number(row.id);
    const jaName = row.version ? `${row.card_name} – ${row.version}` : String(row.card_name);
    const enKey = cardFileNameKey(String(row.card_file));
    // 同名（別レアリティの再録）は最初の1件を使う
    if (enKey && !byEn.has(enKey)) byEn.set(enKey, { id, name: jaName });
    const group = String(row.card_group ?? '');
    if (group) {
      const k = joinKey(group.replace(/／/g, ''));
      if (k && !byJa.has(k)) byJa.set(k, { id, name: jaName });
    }
    const plain = joinKey(`${row.card_name}${row.version ?? ''}`);
    if (plain && !byJa.has(plain)) byJa.set(plain, { id, name: jaName });
  }
  return { byEn, byJa };
}

/**
 * EN大会レポートから大会1件と入賞デッキ群を取り込む。
 *
 * デッキの切り出し方: 見出し(h2)が現れるたびに新しいデッキとみなし、
 * その後に続く「N CardName」行を集める。合計60枚に達したデッキだけを採用する
 * （記事中のカード紹介文が混ざるのを防ぐため）。
 */
export async function importEnRecap(db: D1Database, a: EnArticle): Promise<{ decks: number }> {
  if (!a.deckLines.length) return { decks: 0 };

  const eventName = a.title.replace(/\s*Recap\s*$/i, '').trim() || a.slug;
  const eventKey = `en:${a.slug}`;
  const held = a.published;

  await db
    .prepare(
      `INSERT INTO meta_events (event_key,name,region,scale,held_on,source_url,is_official,is_upcoming,observed_at,fetched_at,updated_at)
         VALUES (?,?,'en',?,?,?,1,0,?,datetime('now'),datetime('now'))
       ON CONFLICT(event_key) DO UPDATE SET
         name=excluded.name, held_on=excluded.held_on, source_url=excluded.source_url,
         observed_at=excluded.observed_at, updated_at=datetime('now')`
    )
    .bind(
      eventKey,
      eventName,
      /championship|worlds/i.test(a.slug) ? 'national' : 'challenge',
      held,
      a.url,
      held
    )
    .run();

  const ev = await db
    .prepare('SELECT id FROM meta_events WHERE event_key = ?')
    .bind(eventKey)
    .first<{ id: number }>();
  const eventId = Number(ev?.id ?? 0) || null;

  // 本文を再走査して「見出し → 続くデッキ行」のまとまりを作る
  const groups: Array<{ heading: string; lines: Array<{ qty: number; name: string }> }> = [];
  let cur: { heading: string; lines: Array<{ qty: number; name: string }> } | null = null;
  for (const line of a.text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const dm = t.match(/^(\d{1,2})\s+([A-Z][^.!?]{1,45})$/);
    if (dm) {
      if (!cur) cur = { heading: eventName, lines: [] };
      cur.lines.push({ qty: Number(dm[1]), name: dm[2].trim() });
      continue;
    }
    // カード行ではない＝区切り。60枚たまっていれば1デッキとして確定
    if (cur && cur.lines.reduce((s, l) => s + l.qty, 0) >= 60) {
      groups.push(cur);
      cur = null;
    }
    if (a.headings.includes(t)) cur = { heading: t, lines: [] };
    else if (cur && cur.lines.length === 0) cur.heading = t.slice(0, 120);
  }
  if (cur && cur.lines.reduce((s, l) => s + l.qty, 0) >= 60) groups.push(cur);

  if (!groups.length) return { decks: 0 };

  const index = await buildCardIndex(db);
  let count = 0;

  for (let gi = 0; gi < groups.length; gi++) {
    const g = groups[gi];
    const total = g.lines.reduce((s, l) => s + l.qty, 0);
    if (total !== 60) continue; // 60枚でないものは信頼できないので捨てる

    const { placement, inks } = guessPlacement(g.heading);
    const deckKey = `en:${a.slug}:${gi}`;

    // カード突合
    const missing: string[] = [];
    const cards: Array<{ card_id: number | null; card_name: string; raw: string; qty: number }> = [];
    for (const l of g.lines) {
      const hit = index.byEn.get(joinKey(l.name));
      if (hit) cards.push({ card_id: hit.id, card_name: hit.name, raw: l.name, qty: l.qty });
      else {
        missing.push(l.name);
        cards.push({ card_id: null, card_name: l.name, raw: l.name, qty: l.qty });
      }
    }
    // 「日本で組める」= 全カードが日本語DBに存在する
    const playable = missing.length === 0 ? 1 : 0;

    await db
      .prepare(
        `INSERT INTO meta_decks
           (deck_key,name,archetype,region,ink1,ink2,player,placement,weight,event_id,event_name,
            total_cards,playable_jp,missing_cards,source_key,source_url,source_label,observed_at,fetched_at,updated_at)
         VALUES (?,?,?,'en',?,?,?,?,?,?,?,?,?,?,'lorcana_en_recap',?,?,?,datetime('now'),datetime('now'))
         ON CONFLICT(deck_key) DO UPDATE SET
           name=excluded.name, placement=excluded.placement, weight=excluded.weight,
           ink1=excluded.ink1, ink2=excluded.ink2, total_cards=excluded.total_cards,
           playable_jp=excluded.playable_jp, missing_cards=excluded.missing_cards,
           observed_at=excluded.observed_at, updated_at=datetime('now')`
      )
      .bind(
        deckKey,
        g.heading.slice(0, 160),
        null,
        inks[0] ?? null,
        inks[1] ?? null,
        extractPlayerName(g.heading),
        placement,
        placement ? (PLACEMENT_WEIGHT[placement] ?? 1) : 1,
        eventId,
        eventName,
        total,
        playable,
        missing.length ? JSON.stringify(missing.slice(0, 40)) : null,
        a.url,
        'Ravensburger 公式大会レポート',
        held
      )
      .run();

    const deck = await db
      .prepare('SELECT id FROM meta_decks WHERE deck_key = ?')
      .bind(deckKey)
      .first<{ id: number }>();
    const deckId = Number(deck?.id ?? 0);
    if (!deckId) continue;

    const stmts: D1PreparedStatement[] = [
      db.prepare('DELETE FROM meta_deck_cards WHERE deck_id = ?').bind(deckId),
    ];
    for (const cd of cards) {
      stmts.push(
        db
          .prepare(
            `INSERT INTO meta_deck_cards (deck_id,card_id,card_name,raw_name,qty)
               VALUES (?,?,?,?,?)
             ON CONFLICT(deck_id,card_name) DO UPDATE SET qty=excluded.qty, card_id=excluded.card_id`
          )
          .bind(deckId, cd.card_id, cd.card_name, cd.raw, cd.qty)
      );
    }
    await runBatched(db, stmts);
    count++;
  }
  return { decks: count };
}

/** 見出しからプレイヤー名を抜く（"Bryan Pereira wins with Ruby/Sapphire Actions!"） */
export function extractPlayerName(heading: string): string | null {
  const m = heading.match(/^([A-Z][A-Za-zÀ-ÿ'’.-]+(?:\s+[A-Z][A-Za-zÀ-ÿ'’.-]+){0,2})\s+(?:wins|takes|is crowned)/);
  return m ? m[1] : null;
}

// ============================ 収集: 日本コミュニティ デッキレシピ ============================

/**
 * disneylorcana.jp の deck-sitemap.xml から新着デッキURLを取る。
 *
 * このサイトは WP REST が 403 だが sitemap は公開されており lastmod もある。
 * 402件あるので毎回全件は取らず、lastmod が新しいものから未取得分だけ処理する。
 *
 * ※ 出典表記について:
 *   デッキレシピは出典明記が必要（ユーザー仕様§1.3の例外）なので
 *   source_url を保持し、フロントでも表示する。
 */
export async function collectJpDecks(
  db: D1Database,
  src: SourceRow,
  opts: { maxDecks?: number } = {}
): Promise<{ status: number; found: number; imported: number; skipped: number }> {
  const maxDecks = Math.max(1, Math.min(12, opts.maxDecks ?? 6));

  const sm = await politeFetch(`${JP_COMMUNITY}/deck-sitemap.xml`);
  if (sm.status !== 200) {
    await markSource(db, src.key, sm.status, `sitemap http ${sm.status}`);
    return { status: sm.status, found: 0, imported: 0, skipped: 0 };
  }

  const entries: Array<{ url: string; lastmod: string | null }> = [];
  for (const m of sm.text.matchAll(/<url>([\s\S]*?)<\/url>/g)) {
    const loc = m[1].match(/<loc>([^<]+)<\/loc>/)?.[1];
    if (!loc || !/\/deck\/\d+/.test(loc)) continue;
    entries.push({ url: loc.trim(), lastmod: dateOnly(m[1].match(/<lastmod>([^<]+)<\/lastmod>/)?.[1]) });
  }
  entries.sort((a, b) => String(b.lastmod ?? '').localeCompare(String(a.lastmod ?? '')));

  // 既知のデッキを除外
  const known = new Set<string>();
  {
    const r = await db.prepare("SELECT deck_key FROM meta_decks WHERE region='jp'").all();
    for (const row of (r.results ?? []) as any[]) known.add(String(row.deck_key));
  }
  const pending = entries.filter((e) => !known.has(`jp:${deckIdFromUrl(e.url)}`)).slice(0, maxDecks);

  const index = await buildCardIndex(db);
  let imported = 0;
  let skipped = 0;

  for (const e of pending) {
    await politeSleep();
    const r = await politeFetch(e.url);
    if (r.status !== 200) {
      skipped++;
      continue;
    }
    const ok = await importJpDeck(db, e.url, r.text, index, e.lastmod);
    ok ? imported++ : skipped++;
  }

  await markSource(db, src.key, 200);
  return { status: 200, found: entries.length, imported, skipped };
}

const deckIdFromUrl = (url: string) => url.match(/\/deck\/(\d+)/)?.[1] ?? url;

/**
 * 日本のデッキ記事HTMLを構造化して取り込む。
 *
 * 記事には季節（環境シーズン）・大会・アーキタイプ・インク色・公開日と
 * 60枚のデッキ表（table.deckrecipelist02）が入っている。
 * カード名は「アリエル – 音響の戦士」形式で、DB の card_group は
 * 「アリエル／音響の戦士」なので記号を落として突合する。
 */
export async function importJpDeck(
  db: D1Database,
  url: string,
  html: string,
  index: CardIndex,
  lastmod: string | null
): Promise<boolean> {
  const pick = (re: RegExp) => html.match(re);
  const season = pick(/href="https:\/\/disneylorcana\.jp\/deck\/season\/([^"/]+)\/">([^<]+)</);
  const event = pick(/href="https:\/\/disneylorcana\.jp\/deck\/event-tournament\/([^"/]+)\/">([^<]+)</);
  const arch = pick(/href="https:\/\/disneylorcana\.jp\/deck\/archetype\/([^"/]+)\/">([^<]+)</);
  const inks = [...html.matchAll(/href="https:\/\/disneylorcana\.jp\/deck\/inkcolors\/([^"/]+)\/">([^<]+)</g)];
  const dateM = stripTags(html).match(/(\d{4})\.(\d{2})\.(\d{2})\s*公開/);
  const observed = dateM ? `${dateM[1]}-${dateM[2]}-${dateM[3]}` : lastmod;

  const tableM = html.match(/<table class="deckrecipelist02[\s\S]*?<\/table>/);
  if (!tableM) return false;

  // 表の各行から「カード名」と「枚数」を取る
  const lines: Array<{ name: string; qty: number }> = [];
  for (const rowM of tableM[0].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const cells = [...rowM[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((m) => stripTags(m[1]));
    if (cells.length < 2) continue;
    // 枚数は数値だけのセル。カード名は日本語を含む最長セル
    const qtyCell = cells.find((c) => /^\d{1,2}$/.test(c));
    const nameCell = cells.find((c) => /[\u3040-\u30ff\u4e00-\u9fff]/.test(c) && c.length >= 2);
    if (!qtyCell || !nameCell) continue;
    lines.push({ name: nameCell, qty: Number(qtyCell) });
  }

  const total = lines.reduce((s, l) => s + l.qty, 0);
  if (total !== 60) return false; // 60枚に満たない/超えるものは取り込まない

  const deckKey = `jp:${deckIdFromUrl(url)}`;
  const missing: string[] = [];
  const cards: Array<{ card_id: number | null; card_name: string; raw: string; qty: number }> = [];
  for (const l of lines) {
    const key = joinKey(l.name.replace(/[–—-]/g, ''));
    const hit = index.byJa.get(key);
    if (hit) cards.push({ card_id: hit.id, card_name: hit.name, raw: l.name, qty: l.qty });
    else {
      missing.push(l.name);
      cards.push({ card_id: null, card_name: l.name, raw: l.name, qty: l.qty });
    }
  }

  const inkNames = inks.map((m) => INK_SLUG_JA[m[1]] ?? stripTags(m[2])).filter(Boolean);
  // 日本のデッキ記事は日本語版カードで構成されているので原則 playable。
  // 突合できないカード名があっても（表記ゆれ等）、未収録とは断定せず
  // missing に残したうえで 90% 以上一致していれば組めると扱う。
  const matched = cards.filter((c) => c.card_id).length;
  const playable = matched / cards.length >= 0.9 ? 1 : 0;

  await db
    .prepare(
      `INSERT INTO meta_decks
         (deck_key,name,archetype,region,ink1,ink2,player,placement,weight,event_name,season,
          total_cards,playable_jp,missing_cards,source_key,source_url,source_label,observed_at,fetched_at,updated_at)
       VALUES (?,?,?,'jp',?,?,NULL,?,?,?,?,?,?,?,'jp_community_deck',?,?,?,datetime('now'),datetime('now'))
       ON CONFLICT(deck_key) DO UPDATE SET
         name=excluded.name, archetype=excluded.archetype, ink1=excluded.ink1, ink2=excluded.ink2,
         placement=excluded.placement, weight=excluded.weight, event_name=excluded.event_name,
         season=excluded.season, total_cards=excluded.total_cards, playable_jp=excluded.playable_jp,
         missing_cards=excluded.missing_cards, observed_at=excluded.observed_at, updated_at=datetime('now')`
    )
    .bind(
      deckKey,
      [arch?.[2] ? stripTags(arch[2]) : null, inkNames.join('/')].filter(Boolean).join(' ') || 'デッキ',
      arch?.[2] ? stripTags(arch[2]) : null,
      inkNames[0] ?? null,
      inkNames[1] ?? null,
      guessJpPlacement(html),
      PLACEMENT_WEIGHT[guessJpPlacement(html) ?? ''] ?? 1,
      event?.[2] ? stripTags(event[2]) : null,
      season?.[2] ? stripTags(season[2]) : null,
      total,
      playable,
      missing.length ? JSON.stringify(missing.slice(0, 40)) : null,
      url,
      'ロルカナ コミュニティ デッキレシピ',
      observed
    )
    .run();

  const deck = await db.prepare('SELECT id FROM meta_decks WHERE deck_key = ?').bind(deckKey).first<{ id: number }>();
  const deckId = Number(deck?.id ?? 0);
  if (!deckId) return false;

  const stmts: D1PreparedStatement[] = [
    db.prepare('DELETE FROM meta_deck_cards WHERE deck_id = ?').bind(deckId),
  ];
  for (const cd of cards) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO meta_deck_cards (deck_id,card_id,card_name,raw_name,qty)
             VALUES (?,?,?,?,?)
           ON CONFLICT(deck_id,card_name) DO UPDATE SET qty=excluded.qty, card_id=excluded.card_id`
        )
        .bind(deckId, cd.card_id, cd.card_name, cd.raw, cd.qty)
    );
  }
  await runBatched(db, stmts);
  return true;
}

const INK_SLUG_JA: Record<string, string> = {
  amber: 'アンバー',
  amethyst: 'アメジスト',
  emerald: 'エメラルド',
  ruby: 'ルビー',
  sapphire: 'サファイア',
  steel: 'スティール',
};

function guessJpPlacement(html: string): string | null {
  const t = stripTags(html).slice(0, 3000);
  if (/優勝/.test(t) && !/準優勝/.test(t.slice(0, 400))) return '優勝';
  if (/準優勝/.test(t)) return '準優勝';
  if (/TOP\s*4|ベスト4|上位4/i.test(t)) return 'TOP4';
  if (/TOP\s*8|ベスト8|上位8/i.test(t)) return 'TOP8';
  return null;
}

// ============================ 収集: note RSS ============================

/**
 * note のハッシュタグRSSから新着記事を取る。
 *
 * 非公式ソースなので:
 *   - 表示リンクにはしない（citable=0）
 *   - 本文は抜粋のみ（RSSのdescriptionまで）
 *   - 要約では「複数プレイヤーの発信によると」という集約表現で扱う
 */
export async function collectRss(
  db: D1Database,
  src: SourceRow
): Promise<UpsertResult & { status: number }> {
  const r = await politeFetch(src.url);
  if (r.status !== 200) {
    await markSource(db, src.key, r.status, `http ${r.status}`);
    return { inserted: 0, updated: 0, unchanged: 0, status: r.status };
  }

  const items: RawItem[] = [];
  for (const m of r.text.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const block = m[1];
    const get = (tag: string) => {
      const mm = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
      if (!mm) return '';
      return stripTags(mm[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1'));
    };
    const link = block.match(/<link[^>]*>([\s\S]*?)<\/link>/)?.[1]?.trim() ?? '';
    const title = get('title');
    if (!link || !title) continue;
    items.push({
      url: link,
      title,
      // 非公式は抜粋を短く保つ（400字）。本文の再配信にならないように
      excerpt: get('description').slice(0, 400),
      observed_at: dateOnly(get('pubDate')) ?? dateOnly(block.match(/<pubDate>([^<]+)<\/pubDate>/)?.[1]),
    });
  }

  const res = await upsertRawItems(db, src, items);
  await markSource(db, src.key, 200);
  return { ...res, status: 200 };
}

// ============================ 収集: 日本コミュニティ記事 ============================

export async function collectJpPosts(
  db: D1Database,
  src: SourceRow,
  opts: { maxPosts?: number } = {}
): Promise<{ status: number; found: number } & UpsertResult> {
  const maxPosts = Math.max(1, Math.min(20, opts.maxPosts ?? 10));
  const sm = await politeFetch(`${JP_COMMUNITY}/post-sitemap.xml`);
  if (sm.status !== 200) {
    await markSource(db, src.key, sm.status, `sitemap http ${sm.status}`);
    return { status: sm.status, found: 0, inserted: 0, updated: 0, unchanged: 0 };
  }

  const entries: Array<{ url: string; lastmod: string | null; title: string }> = [];
  for (const m of sm.text.matchAll(/<url>([\s\S]*?)<\/url>/g)) {
    const loc = m[1].match(/<loc>([^<]+)<\/loc>/)?.[1];
    if (!loc) continue;
    entries.push({
      url: loc.trim(),
      lastmod: dateOnly(m[1].match(/<lastmod>([^<]+)<\/lastmod>/)?.[1]),
      title: '',
    });
  }
  entries.sort((a, b) => String(b.lastmod ?? '').localeCompare(String(a.lastmod ?? '')));

  const known = new Set<string>();
  {
    const r = await db
      .prepare('SELECT url FROM meta_raw_items WHERE source_key = ?')
      .bind(src.key)
      .all();
    for (const row of (r.results ?? []) as any[]) known.add(String(row.url));
  }

  const items: RawItem[] = [];
  let fetched = 0;
  for (const e of entries) {
    if (fetched >= maxPosts) break;
    if (known.has(canonicalUrl(e.url))) continue;
    await politeSleep();
    const r = await politeFetch(e.url);
    if (r.status !== 200) continue;
    fetched++;
    const title = stripTags(r.text.match(/<title[^>]*>([\s\S]*?)<\/title>/)?.[1] ?? '')
      .replace(/\s*\|\s*.*$/, '')
      .slice(0, 200);
    const desc = r.text.match(/<meta name="description" content="([^"]*)"/)?.[1] ?? '';
    const dm = stripTags(r.text).match(/(\d{4})\.(\d{2})\.(\d{2})/);
    if (!title) continue;
    items.push({
      url: e.url,
      title,
      // 非公式なので抜粋のみ
      excerpt: stripTags(desc).slice(0, 400),
      observed_at: dm ? `${dm[1]}-${dm[2]}-${dm[3]}` : e.lastmod,
    });
  }

  const res = await upsertRawItems(db, src, items);
  await markSource(db, src.key, 200);
  return { status: 200, found: entries.length, ...res };
}

// ============================ 日本の大会情報（公式イベント） ============================

/**
 * 公式ニュース記事から大会情報を抽出して meta_events に入れる。
 *
 * 記事タイトルに「チャレンジ 2026 Summer 横浜」「日本一決定戦 2026」などの
 * 大会名が入っており、本文に開催日が書かれている。
 * カウントダウン表示のため、未来日付のものは is_upcoming=1 にする。
 */
export async function extractJpEvents(db: D1Database): Promise<{ events: number }> {
  const rows = await db
    .prepare(
      `SELECT url, title, excerpt, observed_at FROM meta_raw_items
        WHERE region='jp' AND citable=1
        ORDER BY observed_at DESC LIMIT 60`
    )
    .all();

  const today = jstToday();
  let count = 0;
  const stmts: D1PreparedStatement[] = [];

  for (const r of (rows.results ?? []) as any[]) {
    const title = String(r.title ?? '');
    // 大会名パターン: チャレンジ / グランプリ / 日本一決定戦 / セットチャンピオンシップ / トリオクエスト / CCQ
    const em = title.match(
      /(日本一決定戦|チャレンジ|グランプリ|セット\s?チャンピオンシップ|トリオクエスト|CCQ|カジュアル)[^「」]{0,30}/
    );
    if (!em) continue;

    const scale = /日本一決定戦/.test(title)
      ? 'national'
      : /チャレンジ/.test(title)
        ? 'challenge'
        : /グランプリ/.test(title)
          ? 'gp'
          : /チャンピオンシップ/.test(title)
            ? 'set_championship'
            : 'other';

    // 日付: 本文の「9月6日」「2026年9月6日」「9/6」を拾う
    const body = `${title} ${String(r.excerpt ?? '')}`.slice(0, 1200);
    const dm =
      body.match(/(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日/) ??
      body.match(/(\d{1,2})月\s*(\d{1,2})日/);
    let held: string | null = null;
    if (dm) {
      if (dm.length === 4) held = `${dm[1]}-${dm[2].padStart(2, '0')}-${dm[3].padStart(2, '0')}`;
      else {
        // 年が無い場合は記事の年を使う。年末年始の跨ぎは月の大小で補正する
        const y = Number(String(r.observed_at ?? today).slice(0, 4));
        const mo = Number(dm[1]);
        const artMonth = Number(String(r.observed_at ?? today).slice(5, 7));
        const year = mo < artMonth - 6 ? y + 1 : y;
        held = `${year}-${String(mo).padStart(2, '0')}-${dm[2].padStart(2, '0')}`;
      }
    }
    if (!held) continue;

    const name = title.slice(0, 160);
    const key = `jp:${scale}:${held}:${em[1]}`;
    stmts.push(
      db
        .prepare(
          `INSERT INTO meta_events (event_key,name,region,scale,held_on,source_url,is_official,is_upcoming,observed_at,fetched_at,updated_at)
             VALUES (?,?,'jp',?,?,?,1,?,?,datetime('now'),datetime('now'))
           ON CONFLICT(event_key) DO UPDATE SET
             name=excluded.name, held_on=excluded.held_on, source_url=excluded.source_url,
             is_upcoming=excluded.is_upcoming, observed_at=excluded.observed_at, updated_at=datetime('now')`
        )
        .bind(key, name, scale, held, String(r.url), held > today ? 1 : 0, r.observed_at ?? null)
    );
    count++;
  }

  await runBatched(db, stmts);
  // 過去になった予定は is_upcoming を下ろす
  await db
    .prepare("UPDATE meta_events SET is_upcoming=0 WHERE is_upcoming=1 AND held_on < ?")
    .bind(today)
    .run();
  return { events: count };
}

// ============================ メタゲーム集計（自前計算） ============================

export type SnapshotRow = {
  kind: string;
  label: string;
  deck_count: number;
  weighted: number;
  share: number;
  rank: number;
  share_delta: number | null;
  detail: any;
};

/**
 * meta_decks から地域・期間ごとのメタシェアを計算する。
 *
 * 単純な使用数ではなく順位重み（優勝5 / 準優勝4 / TOP4:3 / TOP8:2 / その他1）で
 * 重み付けする。「勝っているデッキ」を上位に出すのが目的で、
 * 参加者数の多い店舗大会が全体を薄めるのを防ぐ。
 *
 * share は weighted の構成比。deck_count も併記して、
 * 「重みのせいで少数のデッキが上位に来ている」ことを読み取れるようにする。
 */
export async function computeSnapshots(
  db: D1Database,
  opts: { region: 'jp' | 'en'; days?: number } = { region: 'jp' }
): Promise<{ from: string; to: string; rows: SnapshotRow[] }> {
  const days = opts.days ?? 60;
  const to = jstToday();
  const from = new Date(Date.now() + 9 * 3600_000 - days * 86400_000).toISOString().slice(0, 10);

  const decks = await db
    .prepare(
      `SELECT id, ink1, ink2, archetype, weight, placement, name, event_name, observed_at
         FROM meta_decks
        WHERE region = ? AND observed_at IS NOT NULL AND observed_at >= ? AND total_cards = 60`
    )
    .bind(opts.region, from)
    .all();
  const list = (decks.results ?? []) as any[];

  // 前回スナップショット（差分表示用）
  const prevRows = await db
    .prepare(
      `SELECT label, share FROM meta_snapshots
        WHERE region=? AND kind='ink_pair'
          AND window_to = (SELECT MAX(window_to) FROM meta_snapshots WHERE region=? AND kind='ink_pair' AND window_to < ?)`
    )
    .bind(opts.region, opts.region, to)
    .all();
  const prev = new Map<string, number>(
    ((prevRows.results ?? []) as any[]).map((r) => [String(r.label), Number(r.share)])
  );

  const agg = new Map<
    string,
    { count: number; weighted: number; decks: Array<{ name: string; placement: string | null; event: string | null }> }
  >();
  for (const d of list) {
    const inks = [d.ink1, d.ink2].filter(Boolean).sort() as string[];
    if (!inks.length) continue;
    const label = inks.join('/');
    const cur = agg.get(label) ?? { count: 0, weighted: 0, decks: [] };
    cur.count++;
    cur.weighted += Number(d.weight ?? 1);
    if (cur.decks.length < 3) {
      cur.decks.push({
        name: String(d.name ?? ''),
        placement: d.placement ?? null,
        event: d.event_name ?? null,
      });
    }
    agg.set(label, cur);
  }

  const totalWeight = [...agg.values()].reduce((s, v) => s + v.weighted, 0) || 1;
  const rows: SnapshotRow[] = [...agg.entries()]
    .map(([label, v]) => ({
      kind: 'ink_pair',
      label,
      deck_count: v.count,
      weighted: v.weighted,
      share: Math.round((v.weighted / totalWeight) * 1000) / 10,
      rank: 0,
      share_delta: null as number | null,
      detail: { decks: v.decks },
    }))
    .sort((a, b) => b.weighted - a.weighted);

  rows.forEach((r, i) => {
    r.rank = i + 1;
    const p = prev.get(r.label);
    r.share_delta = p == null ? null : Math.round((r.share - p) * 10) / 10;
  });

  // カード採用率（上位デッキで何%が採用しているか）
  const cardRows = await db
    .prepare(
      `SELECT dc.card_id, dc.card_name, COUNT(DISTINCT d.id) AS decks, SUM(dc.qty) AS copies,
              SUM(d.weight) AS weighted
         FROM meta_deck_cards dc
         JOIN meta_decks d ON d.id = dc.deck_id
        WHERE d.region = ? AND d.observed_at >= ? AND d.total_cards = 60 AND dc.card_id IS NOT NULL
        GROUP BY dc.card_id
        ORDER BY weighted DESC, decks DESC
        LIMIT 24`
    )
    .bind(opts.region, from)
    .all();
  const deckTotal = list.length || 1;
  const cardSnaps: SnapshotRow[] = ((cardRows.results ?? []) as any[]).map((r, i) => ({
    kind: 'card',
    label: String(r.card_name),
    deck_count: Number(r.decks),
    weighted: Number(r.weighted ?? 0),
    share: Math.round((Number(r.decks) / deckTotal) * 1000) / 10,
    rank: i + 1,
    share_delta: null,
    detail: { card_id: Number(r.card_id), copies: Number(r.copies) },
  }));

  // 同一期間の既存行を消してから入れる（再実行で重複しないように）
  await db
    .prepare('DELETE FROM meta_snapshots WHERE region=? AND window_from=? AND window_to=?')
    .bind(opts.region, from, to)
    .run();

  const stmts = [...rows, ...cardSnaps].map((r) =>
    db
      .prepare(
        `INSERT INTO meta_snapshots
           (region,window_from,window_to,kind,label,deck_count,weighted,share,rank,share_delta,detail,computed_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,datetime('now'))`
      )
      .bind(
        opts.region, from, to, r.kind, r.label, r.deck_count, r.weighted, r.share, r.rank,
        r.share_delta, JSON.stringify(r.detail)
      )
  );
  await runBatched(db, stmts);

  return { from, to, rows };
}

// ============================ ジョブ管理 ============================

export async function openJob(db: D1Database, kind: string): Promise<number> {
  const r = await db
    .prepare("INSERT INTO meta_jobs (kind, status) VALUES (?, 'running')")
    .bind(kind)
    .run();
  return Number(r.meta.last_row_id);
}

export async function closeJob(
  db: D1Database,
  id: number,
  patch: { status?: string; ok?: number; fail?: number; newItems?: number; message?: string; detail?: any }
): Promise<void> {
  await db
    .prepare(
      `UPDATE meta_jobs SET status=?, ok_count=?, fail_count=?, new_items=?, message=?, detail=?,
              finished_at=datetime('now')
        WHERE id = ?`
    )
    .bind(
      patch.status ?? 'done',
      patch.ok ?? 0,
      patch.fail ?? 0,
      patch.newItems ?? 0,
      String(patch.message ?? '').slice(0, 400),
      patch.detail ? JSON.stringify(patch.detail).slice(0, 6000) : null,
      id
    )
    .run();
}

// ============================ ソース別ディスパッチ ============================

export type CollectOutcome = {
  source: string;
  label: string;
  ok: boolean;
  status: number;
  inserted: number;
  updated: number;
  detail?: any;
  error?: string;
};

/** 1ソースを収集する。ソース種別に応じて適切なコレクタへ振り分ける */
// ============================ 収集: 海外メタ集計（Lorcana Hunter） ============================

/** 英語インク名 → 日本語（フランス語表記も来るため両方受ける） */
const INK_I18N: Record<string, string> = {
  amber: 'アンバー', ambre: 'アンバー',
  amethyst: 'アメジスト', amethyste: 'アメジスト', améthyste: 'アメジスト',
  emerald: 'エメラルド', emeraude: 'エメラルド', émeraude: 'エメラルド',
  ruby: 'ルビー', rubis: 'ルビー',
  sapphire: 'サファイア', saphir: 'サファイア',
  steel: 'スティール', acier: 'スティール',
};

export function inkToJa(raw: string): string | null {
  const k = raw.trim().toLowerCase().replace(/[^a-zéè]/g, '');
  return INK_I18N[k] ?? null;
}

/**
 * インク画像のファイル名からインクを判定する。
 * 例: /assets/images/dlc_ink_amber-mSixmFc.webp → アンバー
 * alt 属性はロケール依存（Ambre / Amber）だがファイル名は英語固定なので、
 * ファイル名を第一候補、alt を第二候補にする。
 */
function inkFromImg(tag: string): string | null {
  const src = tag.match(/src="([^"]+)"/)?.[1] ?? '';
  const byFile = src.match(/dlc_ink_([a-z]+)/i)?.[1];
  if (byFile) {
    const ja = inkToJa(byFile);
    if (ja) return ja;
  }
  const alt = tag.match(/alt="([^"]+)"/)?.[1] ?? '';
  return alt ? inkToJa(alt) : null;
}

export type MetaShareRow = { label: string; share: number; top8: number | null; decks: number };

/**
 * Lorcana Hunter の /en/meta をパースして、バイカラー別のメタシェアを取り出す。
 *
 * 1カード = 1バイカラーの `mf-bico-card` ブロック。
 * ブロック内に dlc_ink_*.webp が2つ（インクペア）、Meta% / Top 8 % / N decks がある。
 * 「集計値（数値）」だけを取り、記事本文は一切取らないので再配信にならない。
 */
export function parseLhMeta(html: string): MetaShareRow[] {
  const out: MetaShareRow[] = [];
  const blocks = html.split('mf-bico-card').slice(1);
  for (const b of blocks) {
    const inks: string[] = [];
    for (const m of b.matchAll(/<img[^>]*mf-ink-icon[^>]*>/g)) {
      const ja = inkFromImg(m[0]);
      if (ja && !inks.includes(ja)) inks.push(ja);
    }
    if (inks.length < 1) continue;

    // Meta の直後の値 → share、Top 8 の直後の値 → top8
    const pct = [...b.matchAll(/mf-stat-label">\s*([^<]+?)\s*<\/span>\s*<span class="mf-stat-val">\s*([\d.]+)%/g)];
    let share: number | null = null;
    let top8: number | null = null;
    for (const p of pct) {
      const label = p[1].toLowerCase();
      const v = Number(p[2]);
      if (!Number.isFinite(v)) continue;
      if (share === null && /^meta/.test(label)) share = v;
      else if (top8 === null && /top\s*8/.test(label)) top8 = v;
    }
    if (share === null) continue;

    const decks = Number(b.match(/([\d,]+)\s*decks?/i)?.[1]?.replace(/,/g, '') ?? '0') || 0;
    const label = inks.slice(0, 2).join('/');
    // 同じインクペアが Core/Infinity で複数出るので、最初（=Core）のみ採用
    if (out.some((r) => r.label === label)) continue;
    out.push({ label, share, top8, decks });
  }
  return out;
}

/**
 * 海外メタシェアを meta_snapshots に直接書き込む。
 *
 * computeSnapshots（自前デッキ集計）とは別枠。detail.source で由来を残し、
 * どちらの数値なのかがフロント・LLM双方で判別できるようにする。
 * 仕様§5「数値はクロスチェック」のための第2の観測系。
 */
export async function collectLhMeta(
  db: D1Database,
  src: SourceRow,
  opts: { days?: number } = {}
): Promise<{ status: number; rows: number }> {
  const days = opts.days ?? 30;
  const r = await politeFetch(src.url);
  if (r.status !== 200) {
    await markSource(db, src.key, r.status, `http ${r.status}`);
    return { status: r.status, rows: 0 };
  }
  const rows = parseLhMeta(r.text);
  if (!rows.length) {
    await markSource(db, src.key, 200, 'parse produced 0 rows');
    return { status: 200, rows: 0 };
  }

  const to = jstToday();
  const from = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
  const stmts: D1PreparedStatement[] = [
    // 同一窓・同一由来の前回分を消してから入れ直す（重複行を作らない）
    db.prepare(
      `DELETE FROM meta_snapshots
        WHERE region='en' AND kind='ink_pair' AND window_to=? AND detail LIKE '%"lh_meta"%'`
    ).bind(to),
  ];
  rows.sort((a, b) => b.share - a.share);
  rows.forEach((row, i) => {
    stmts.push(
      db.prepare(
        `INSERT INTO meta_snapshots
           (region, window_from, window_to, kind, label, deck_count, weighted, share, rank, detail, computed_at)
         VALUES ('en',?,?,'ink_pair',?,?,?,?,?,?,datetime('now'))`
      ).bind(
        from, to, row.label, row.decks, row.decks, row.share, i + 1,
        JSON.stringify({ source: 'lh_meta', top8: row.top8, days })
      )
    );
  });
  await runBatched(db, stmts, 40);
  await markSource(db, src.key, 200);
  return { status: 200, rows: rows.length };
}

// ============================ 収集: 汎用 sitemap（直近分のみ） ============================

/**
 * sitemap.xml / sitemapindex から lastmod が新しい URL のみを raw_items に入れる。
 *
 * ・本文は取得しない（URL とタイトル代替のスラッグのみ）。
 *   → ai-train=no のサイトでも「参照」の範囲に収まる
 * ・sitemapindex なら子 sitemap を1つだけ辿る（CPU上限対策）
 */
export async function collectSitemapRecent(
  db: D1Database,
  src: SourceRow,
  opts: { maxItems?: number; days?: number; pathFilter?: RegExp } = {}
): Promise<{ status: number; found: number } & UpsertResult> {
  const maxItems = Math.max(1, Math.min(60, opts.maxItems ?? 20));
  const days = opts.days ?? 14;
  const empty = { inserted: 0, updated: 0, unchanged: 0 };

  let target = src.url;
  let r = await politeFetch(target);
  if (r.status !== 200) {
    await markSource(db, src.key, r.status, `http ${r.status}`);
    return { status: r.status, found: 0, ...empty };
  }

  // sitemapindex の場合、pathFilter に合う子（なければ最後の子）を1つ辿る
  if (/<sitemapindex/i.test(r.text)) {
    const kids = [...r.text.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim());
    const pick = opts.pathFilter ? kids.find((k) => opts.pathFilter!.test(k)) : undefined;
    target = pick ?? kids[kids.length - 1] ?? '';
    if (!target) {
      await markSource(db, src.key, 200, 'sitemapindex had no children');
      return { status: 200, found: 0, ...empty };
    }
    await politeSleep();
    r = await politeFetch(target);
    if (r.status !== 200) {
      await markSource(db, src.key, r.status, `child sitemap http ${r.status}`);
      return { status: r.status, found: 0, ...empty };
    }
  }

  const cutoff = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
  const entries: Array<{ url: string; lastmod: string | null }> = [];
  for (const m of r.text.matchAll(/<url>([\s\S]*?)<\/url>/g)) {
    const block = m[1];
    const loc = block.match(/<loc>([^<]+)<\/loc>/)?.[1]?.trim();
    if (!loc) continue;
    if (opts.pathFilter && !opts.pathFilter.test(loc)) continue;
    entries.push({ url: loc, lastmod: dateOnly(block.match(/<lastmod>([^<]+)<\/lastmod>/)?.[1]) });
  }
  // lastmod 降順。日付なしは後回し
  entries.sort((a, b) => String(b.lastmod ?? '').localeCompare(String(a.lastmod ?? '')));

  const items: RawItem[] = [];
  for (const e of entries) {
    if (items.length >= maxItems) break;
    if (e.lastmod && e.lastmod < cutoff) break;
    // スラッグをタイトル代替にする（本文は取らない）
    const slug = e.url.replace(/\/+$/, '').split('/').pop() ?? '';
    const title = slug.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).slice(0, 160);
    if (!title) continue;
    items.push({ url: e.url, title, excerpt: '', observed_at: e.lastmod });
  }

  const res = await upsertRawItems(db, src, items);
  await markSource(db, src.key, 200);
  return { status: 200, found: entries.length, ...res };
}

// ============================ 収集: TopDeck.gg 大会API ============================

/**
 * TopDeck.gg の大会データを取得する。
 *
 * 【利用条件】無料だが Attribution Required（可視クレジットとリンクが必須）。
 * meta_sources.requires_credit=1 / credit_label / credit_url を持たせ、
 * フロントの帰属表示欄に常時クレジットを出すことで条件を満たす。
 * この扱いは仕様§1.3の明示的な例外（デッキレシピ欄と同様）。
 *
 * 【API仕様（実測）】
 *   POST https://topdeck.gg/api/v2/tournaments
 *   Authorization: <API_KEY>（Bearer ではなく生のキー）
 *   body: { game, format, last, columns, participantMin }
 *   レート制限: 概ね 100 req/min（bulk はより低い）
 */
export async function collectTopdeck(
  db: D1Database,
  src: SourceRow,
  apiKey: string,
  opts: { days?: number; minPlayers?: number; maxEvents?: number } = {}
): Promise<{ status: number; events: number; decks: number } & UpsertResult> {
  const empty = { inserted: 0, updated: 0, unchanged: 0 };
  const days = Math.max(1, Math.min(30, opts.days ?? 10));
  const minPlayers = opts.minPlayers ?? 16;
  const maxEvents = Math.max(1, Math.min(40, opts.maxEvents ?? 15));

  const r = await politeFetch(src.url, {
    method: 'POST',
    headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      // game / format は大文字小文字まで一致が必要（公式ドキュメントの一覧表記に合わせる）。
      // 「Lorcana」ではなく「Disney Lorcana」が正しいゲーム名。
      game: 'Disney Lorcana',
      format: 'Core Constructed',
      last: days,
      participantMin: minPlayers,
      // standings は上位のみで十分。decklist を含めてアーキタイプ判定に使う
      columns: ['name', 'decklist', 'wins', 'losses'],
    }),
    timeoutMs: 25_000,
  });

  if (r.status !== 200) {
    await markSource(db, src.key, r.status, `http ${r.status}`);
    return { status: r.status, events: 0, decks: 0, ...empty };
  }

  let list: any[] = [];
  try {
    const j = JSON.parse(r.text);
    list = Array.isArray(j) ? j : Array.isArray(j?.data) ? j.data : [];
  } catch {
    await markSource(db, src.key, 200, 'invalid json');
    return { status: 200, events: 0, decks: 0, ...empty };
  }

  const items: RawItem[] = [];
  const eventStmts: D1PreparedStatement[] = [];
  let decks = 0;

  for (const t of list.slice(0, maxEvents)) {
    const tid = String(t?.TID ?? t?.id ?? t?.tid ?? '');
    const name = String(t?.tournamentName ?? t?.name ?? '').trim();
    if (!tid || !name) continue;

    // startDate は秒 or ミリ秒の epoch で来ることがあるため両対応
    const rawDate = t?.startDate ?? t?.date ?? null;
    let held: string | null = null;
    if (rawDate != null) {
      const n = Number(rawDate);
      held = Number.isFinite(n)
        ? new Date(n > 1e12 ? n : n * 1000).toISOString().slice(0, 10)
        : dateOnly(String(rawDate));
    }

    const standings: any[] = Array.isArray(t?.standings) ? t.standings : [];
    const players = Number(t?.participantCount ?? t?.players ?? standings.length) || standings.length;
    const url = `https://topdeck.gg/event/${encodeURIComponent(tid)}`;

    // raw_items へ（要約の材料）。本文は持たず、数値と名称のみ
    items.push({
      url,
      title: name.slice(0, 160),
      excerpt: `${held ?? ''} / 参加${players}人`.trim(),
      observed_at: held,
      kind: 'event',
      meta: { platform: 'topdeck', tid, players },
    });

    // meta_events へ（大会結果として表示）
    eventStmts.push(
      db.prepare(
        `INSERT INTO meta_events
           (event_key, name, region, scale, held_on, players, format, source_url,
            is_official, is_upcoming, note, observed_at, fetched_at, updated_at)
         VALUES (?,?,'en',?,?,?,'Core Constructed',?,0,0,?,?,datetime('now'),datetime('now'))
         ON CONFLICT(event_key) DO UPDATE SET
           name=excluded.name, players=excluded.players, held_on=excluded.held_on,
           observed_at=excluded.observed_at, updated_at=datetime('now')`
      ).bind(
        `topdeck:${tid}`,
        name.slice(0, 160),
        players >= 128 ? 'major' : players >= 32 ? 'challenge' : 'local',
        held,
        players,
        url,
        // クレジット必須ソースであることを note に残す
        'TopDeck.gg 提供データ',
        held
      )
    );
    decks += standings.filter((s) => s?.decklist).length;
  }

  if (eventStmts.length) await runBatched(db, eventStmts, 30);
  const res = await upsertRawItems(db, src, items);
  await markSource(db, src.key, 200);
  return { status: 200, events: eventStmts.length, decks, ...res };
}

// ============================ 収集: X 公式API（課金前提） ============================

/**
 * X（旧Twitter）公式API v2 からポストを取得する。
 *
 * 【前提】x.com/robots.txt は `User-agent: * / Disallow: /`（全面禁止）。
 * スクレイピングは不可なので、収集経路は公式API（有料プラン）のみに限定する。
 * X_BEARER_TOKEN が未設定なら収集自体を行わず 'no_token' を返す（課金前は自動スキップ）。
 *
 * 【§1.3への配慮】
 * ・公式アカウント（DisneyLOR_JP / DisneyLorcana）は citable=1 として出典リンク可
 * ・非公式アカウントは citable=0。本文を丸ごと保存すると逐語引用の温床になるため
 *   excerpt を 200字に切り、要約の材料としてのみ使う（記憶層にも入れない）
 */
export const X_COMMUNITY_USERS = [
  'samemau_lorcana', 'jspd_', 'lorhappy_tcg', 'pika0765', 'doomdozer2826sv',
] as const;

type XPost = { id: string; text: string; created_at?: string; author?: string };

async function xApi(
  token: string,
  path: string,
  params: Record<string, string>
): Promise<{ status: number; json: any }> {
  const qs = new URLSearchParams(params).toString();
  const r = await politeFetch(`https://api.x.com/2/${path}${qs ? `?${qs}` : ''}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  let json: any = null;
  try { json = JSON.parse(r.text); } catch { /* HTML エラーページ等 */ }
  return { status: r.status, json };
}

export async function collectXUser(
  db: D1Database,
  src: SourceRow,
  token: string,
  username: string,
  opts: { maxPosts?: number } = {}
): Promise<{ status: number } & UpsertResult> {
  const empty = { inserted: 0, updated: 0, unchanged: 0 };
  const u = await xApi(token, `users/by/username/${encodeURIComponent(username)}`, {});
  if (u.status !== 200 || !u.json?.data?.id) {
    await markSource(db, src.key, u.status, `user lookup ${u.status}`);
    return { status: u.status, ...empty };
  }
  await politeSleep();
  const t = await xApi(token, `users/${u.json.data.id}/tweets`, {
    max_results: String(Math.max(5, Math.min(100, opts.maxPosts ?? 10))),
    'tweet.fields': 'created_at,entities',
    exclude: 'retweets,replies',
  });
  if (t.status !== 200) {
    await markSource(db, src.key, t.status, `timeline ${t.status}`);
    return { status: t.status, ...empty };
  }

  const posts: XPost[] = (t.json?.data ?? []) as XPost[];
  const items: RawItem[] = posts
    .filter((p) => p.id && p.text)
    .map((p) => ({
      url: `https://x.com/${username}/status/${p.id}`,
      // タイトルは1行目。ポスト全文はタイトルにしない
      title: p.text.split('\n')[0].slice(0, 120) || `@${username} のポスト`,
      // 非公式は 200字、公式は 400字。いずれも本文全体は保存しない
      excerpt: p.text.slice(0, src.is_official ? 400 : 200),
      observed_at: dateOnly(p.created_at),
      meta: { platform: 'x', username, post_id: p.id },
    }));

  const res = await upsertRawItems(db, src, items);
  await markSource(db, src.key, 200);
  return { status: 200, ...res };
}

export async function collectXCommunity(
  db: D1Database,
  src: SourceRow,
  token: string,
  opts: { maxPerUser?: number; users?: readonly string[] } = {}
): Promise<{ status: number; users: number } & UpsertResult> {
  const users = opts.users ?? X_COMMUNITY_USERS;
  const acc = { inserted: 0, updated: 0, unchanged: 0 };
  let status = 200;
  let done = 0;
  for (const name of users) {
    const r = await collectXUser(db, src, token, name, { maxPosts: opts.maxPerUser ?? 5 });
    acc.inserted += r.inserted; acc.updated += r.updated; acc.unchanged += r.unchanged;
    if (r.status !== 200) { status = r.status; break; }
    done++;
    await politeSleep();
  }
  return { status, users: done, ...acc };
}

export async function collectOne(
  db: D1Database,
  src: SourceRow,
  opts: { xToken?: string; topdeckKey?: string } = {}
): Promise<CollectOutcome> {
  const base = { source: src.key, label: src.label };
  const xToken = opts.xToken?.trim() || '';
  const topdeckKey = opts.topdeckKey?.trim() || '';
  try {
    switch (src.key) {
      case 'takaratomy_news': {
        const r = await collectTakaratomy(db, src, { perPage: 25 });
        return { ...base, ok: true, status: r.status, inserted: r.inserted, updated: r.updated };
      }
      case 'takaratomy_column': {
        const r = await collectTakaratomy(db, src, { perPage: 20, categories: [TT_CATEGORY.column] });
        return { ...base, ok: true, status: r.status, inserted: r.inserted, updated: r.updated };
      }
      case 'takaratomy_event': {
        const r = await collectTakaratomy(db, src, { perPage: 20, categories: [TT_CATEGORY.event] });
        return { ...base, ok: true, status: r.status, inserted: r.inserted, updated: r.updated };
      }
      case 'lorcana_en_news': {
        const r = await collectEnNews(db, src, { pages: 1, maxArticles: 4 });
        return {
          ...base, ok: true, status: r.status, inserted: r.inserted, updated: r.updated,
          detail: { slugs: r.slugs, fetched: r.fetched },
        };
      }
      case 'lorcana_en_recap': {
        // 大会レポートに限定して深めに掘る（公式EN大会レポートの収集強化）
        const r = await collectEnNews(db, src, { pages: 4, maxArticles: 5, tournamentOnly: true });
        return {
          ...base, ok: true, status: r.status, inserted: r.inserted, updated: r.updated,
          detail: { slugs: r.slugs, fetched: r.fetched },
        };
      }
      case 'jp_community_deck': {
        const r = await collectJpDecks(db, src, { maxDecks: 6 });
        return {
          ...base, ok: true, status: r.status, inserted: r.imported, updated: 0,
          detail: { found: r.found, skipped: r.skipped },
        };
      }
      case 'jp_community_post': {
        const r = await collectJpPosts(db, src, { maxPosts: 6 });
        return { ...base, ok: true, status: r.status, inserted: r.inserted, updated: r.updated };
      }
      case 'lh_meta': {
        // 集計数値のみを取得し meta_snapshots へ直接書く（raw_items は使わない）
        const r = await collectLhMeta(db, src, { days: 30 });
        return {
          ...base, ok: r.rows > 0, status: r.status, inserted: r.rows, updated: 0,
          detail: { snapshot_rows: r.rows },
          error: r.rows > 0 ? undefined : 'no_rows_parsed',
        };
      }
      case 'lh_tournaments': {
        const r = await collectSitemapRecent(db, src, {
          maxItems: 20, days: 10, pathFilter: /\/tournament\//,
        });
        return {
          ...base, ok: true, status: r.status, inserted: r.inserted, updated: r.updated,
          detail: { found: r.found },
        };
      }
      case 'tcgcontender': {
        const r = await collectSitemapRecent(db, src, { maxItems: 12, days: 14 });
        return {
          ...base, ok: true, status: r.status, inserted: r.inserted, updated: r.updated,
          detail: { found: r.found },
        };
      }
      case 'elorcana': {
        const r = await collectSitemapRecent(db, src, {
          maxItems: 12, days: 14, pathFilter: /\/(tournament|tournaments|event)/,
        });
        return {
          ...base, ok: true, status: r.status, inserted: r.inserted, updated: r.updated,
          detail: { found: r.found },
        };
      }
      case 'topdeck_gg': {
        if (!topdeckKey) {
          return {
            ...base, ok: true, status: 0, inserted: 0, updated: 0,
            detail: { skipped: 'no_topdeck_api_key' },
          };
        }
        const r = await collectTopdeck(db, src, topdeckKey, { days: 10, minPlayers: 16 });
        return {
          ...base, ok: r.status === 200, status: r.status,
          inserted: r.inserted, updated: r.updated,
          detail: { events: r.events, decks_with_list: r.decks },
        };
      }
      default: {
        // X 公式API。トークン未設定なら「未課金」としてスキップ（失敗扱いにしない）
        if (src.method === 'x_api') {
          if (!xToken) {
            return {
              ...base, ok: true, status: 0, inserted: 0, updated: 0,
              detail: { skipped: 'no_x_bearer_token' },
            };
          }
          if (src.key === 'x_community_jp') {
            const r = await collectXCommunity(db, src, xToken, { maxPerUser: 5 });
            return {
              ...base, ok: r.status === 200, status: r.status,
              inserted: r.inserted, updated: r.updated, detail: { users: r.users },
            };
          }
          const uname = src.url.match(/by\/username\/([A-Za-z0-9_]+)/)?.[1];
          if (!uname) {
            return { ...base, ok: false, status: 0, inserted: 0, updated: 0, error: 'no_username_in_url' };
          }
          const r = await collectXUser(db, src, xToken, uname, { maxPosts: 10 });
          return {
            ...base, ok: r.status === 200, status: r.status,
            inserted: r.inserted, updated: r.updated, detail: { username: uname },
          };
        }
        if (src.method === 'blocked') {
          // robots で収集不可と判定済みのソース。記録のみで実行しない
          return {
            ...base, ok: true, status: 0, inserted: 0, updated: 0,
            detail: { skipped: 'blocked_by_robots' },
          };
        }
        if (src.method === 'rss') {
          const r = await collectRss(db, src);
          return { ...base, ok: true, status: r.status, inserted: r.inserted, updated: r.updated };
        }
        return { ...base, ok: false, status: 0, inserted: 0, updated: 0, error: 'no_collector' };
      }
    }
  } catch (e: any) {
    return {
      ...base, ok: false, status: 0, inserted: 0, updated: 0,
      error: String(e?.message ?? e).slice(0, 200),
    };
  }
}

/**
 * 収集の実行順。1リクエストで回す本数は呼び出し側が決める。
 * 公式・鮮度の高いものを先に置き、途中で打ち切られても重要な情報が落ちないようにする。
 */
export const COLLECT_ORDER = [
  'takaratomy_news',
  'takaratomy_column',
  'takaratomy_event',
  'x_official_jp',
  'x_official_en',
  'lorcana_en_recap',
  'lorcana_en_news',
  'jp_community_deck',
  'jp_community_post',
  'lh_meta',
  'lh_tournaments',
  'note_lorcana',
  'note_lorcana_deck',
  'note_disney_lorcana',
  'tcgcontender',
  'elorcana',
  'topdeck_gg',
  'x_community_jp',
] as const;
