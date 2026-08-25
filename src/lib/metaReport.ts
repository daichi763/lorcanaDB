/**
 * metaReport.ts — 日次「最新環境情報」レポートの生成
 *
 * 仕様 §1.3「引用方針」をコードで担保する層。
 *
 * 設計の要点:
 *   1. 引用方針は「プロンプトで頼む」だけでは守られない。
 *      LLM に禁止事項を書いた上で、出力を必ず sanitizeDraft() に通し
 *      公式ドメイン以外のURL・@ハンドル・非公式サイト名・個人名を機械的に除去する。
 *      → プロンプトは「意図」、サニタイザは「保証」。
 *
 *   2. 注目カードは LLM に選ばせない。
 *      meta_snapshots(kind='card') の採用率から決定的に選び、
 *      LLM には「そのカードについてのコメント」だけを書かせる。
 *      → 存在しないカードが表示されることが原理的に起きない。
 *
 *   3. 数字（メタシェア％・参加者数・日付）は LLM に計算させない。
 *      すべて D1 の集計値をプロンプトに与え、そのまま使わせる。
 *      単一ソースの主張は evidence 側に単複を明示し、断定を避けさせる。
 *
 *   4. 失敗時は前日のレポートを維持する（仕様§6）。
 *      generateReport は既存行を壊さず、成功時のみ upsert する。
 */
import type { AiEnv } from '../types';
import { chatJson, aiConfigured, LlmError } from './ai';
import { embed, EMBED_DIMS, EMBED_MODEL, toBlob, normalize, fromBlob, dot } from './memory';
import { sha256Hex, jstToday, jstNow, dateOnly } from './meta';

// ============================ 公式ドメインの許可リスト ============================
/**
 * 表示リンクにできるホスト。ここに無いURLは本文から機械的に削除される。
 * 仕様§2の【公式1次情報】に挙がっているものだけ。
 */
export const OFFICIAL_HOSTS = [
  'takaratomy.co.jp',
  'www.takaratomy.co.jp',
  'disneylorcana.com',
  'www.disneylorcana.com',
  'tcg.ravensburgerplay.com',
  'ravensburgerplay.com',
  'disney.co.jp',
  'www.disney.co.jp',
] as const;

/**
 * 本文中に出てはいけない非公式ソース名。
 * 「〜によると」の形で残ると仕様§1.3違反になるため、名前ごと削除する。
 *
 * 【例外について】
 * 利用規約で可視クレジットが必須のソース（meta_sources.requires_credit=1、
 * 現時点では TopDeck.gg）は、このリストに **意図的に載せていない**。
 * ただし本文へ混ぜるのではなく、フロントの専用の帰属表示欄
 * （GET /api/meta/credits → 「Data provided by TopDeck.gg」）で規約を満たす。
 * 本文の文体は§1.3のまま（集約表現）を保つ、という分離方針。
 * なお topdeck.gg の URL は非公式ドメイン扱いなので本文からは従来どおり除去される。
 */
const UNOFFICIAL_TOKENS = [
  'disneylorcana.jp',
  'lorcanalab.com',
  'lorcanalab',
  'lorcana-club33.com',
  'lorcana-club33',
  'nyuka-now.com',
  'nyuka-now',
  'note.com',
  'note記事',
  'noteの記事',
  'inkdecks.com',
  'inkdecks',
  'inkDecks',
  'lorcanahunter.com',
  'lorcanahunter',
  'tcgcontender.com',
  'tcgcontender',
  'mushureport.com',
  'mushureport',
  'lorcana.gg',
  'shonentcg.com',
  'shonentcg',
  'rarehunters.team',
  'rarehunters',
  'dreamborn.ink',
  'dreamborn',
  'elorcana.com',
  'elorcana',
  'reddit.com',
  'r/Lorcana',
  'lorcania.com',
  'lorcania',
  'shop-disneylorcana.jp',
  'x.com',
  'twitter.com',
  'Twitter',
];

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** 公式ドメインか（表示リンクにできるか） */
export function isOfficialUrl(url: string): boolean {
  const h = hostOf(url);
  if (!h) return false;
  return OFFICIAL_HOSTS.some((o) => h === o || h.endsWith(`.${o}`));
}

// ============================ 出力サニタイズ ============================

export type ScrubResult = { text: string; removed: string[] };

/** 集約表現（仕様§1.3の ✅ 例）。帰属節はこれらに置き換える */
const AGG_PLAYER = '複数のプレイヤーの発信によると';
const AGG_STATS = '複数の集計情報によると';

/**
 * 帰属節（「〜によると」）を集約表現へ書き換える前処理。
 *
 * 単に固有名を削除すると「のポストによると」「あるプレイヤーのより」といった
 * 壊れた日本語が残る。文として自然な集約表現に丸ごと置換する。
 */
function rewriteAttribution(text: string, removed: string[]): string {
  let out = text;

  // ① 個人（@ハンドル / 英数字ID + 敬称 / 「〜氏のnote」）の帰属節
  const media = '(?:ポスト|投稿|ツイート|ツイート|note|note記事|記事|ブログ|動画|配信|発信|X)';
  const verb = '(?:によると|によれば|による|より|では|の情報では|の発信では)';
  const person = '(?:[@＠][A-Za-z0-9_]{2,20}|[A-Za-z][A-Za-z0-9_]{2,20}\\s*(?:氏|さん|選手))';
  const rePerson = new RegExp(`${person}\\s*(?:の\\s*${media})?\\s*${verb}`, 'g');
  out = out.replace(rePerson, (m) => {
    removed.push(`attrib_person:${m.trim()}`);
    return AGG_PLAYER;
  });

  // ② 非公式サイト名の帰属節
  const site = UNOFFICIAL_TOKENS.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .sort((a, b) => b.length - a.length)
    .join('|');
  const reSite = new RegExp(`(?:${site})\\s*(?:の\\s*[^\\s、。]{0,12})?\\s*${verb}`, 'g');
  out = out.replace(reSite, (m) => {
    removed.push(`attrib_site:${m.trim()}`);
    return AGG_STATS;
  });

  return out;
}

/** 除去で生じた壊れた日本語の後片付け */
function tidyJapanese(text: string): string {
  return (
    text
      // 空になったリンク・括弧
      .replace(/\[\s*\]\(\s*\)/g, '')
      .replace(/[（(]\s*[)）]/g, '')
      .replace(/「\s*」/g, '')
      // 「詳細は を参照。」のように参照先が消えた文
      .replace(/(?:詳細|出典|ソース|情報源)は\s*(?:を)?\s*(?:参照|確認)(?:のこと)?[。．]?/g, '')
      .replace(/\[([^\]\n]{1,40})\]\s*(?![(（])/g, '$1')
      // 主語や目的語が消えて助詞が浮いたもの
      .replace(/(?:^|[。、])\s*[のはがをにでとも]\s*(?=[。、])/g, '')
      .replace(/^[\s、。のはがをにでとも]+/, '')
      // 空白・読点の重複
      .replace(/[ \t\u3000]{2,}/g, ' ')
      .replace(/、\s*、+/g, '、')
      .replace(/。\s*。+/g, '。')
      .replace(/\s+([、。])/g, '$1')
      .replace(/([、。])\s+/g, '$1')
      .trim()
  );
}

/**
 * 要約本文から「出してはいけないもの」を除去する。
 *
 *  ⓪ 帰属節（「@xxxによると」等） → 集約表現へ書き換え
 *  ① 公式以外のURL               → 丸ごと削除
 *  ② @ハンドル                   → 削除（X本人への誘導になる）
 *  ③ 非公式サイト名               → 削除
 *  ④ 「〜氏」「〜選手」の直前が英数字ID → 「あるプレイヤー」に置換
 *
 * 削除した痕跡は removed[] に残し、監視ログに出す（黙って消さない）。
 */
export function scrubText(input: string): ScrubResult {
  const removed: string[] = [];
  let text = String(input ?? '');

  // ⓪ 帰属節の書き換え（固有名の削除より先に行う）
  text = rewriteAttribution(text, removed);

  // ① URL: 公式だけ残す
  text = text.replace(/https?:\/\/[^\s()\[\]<>「」、。]+/g, (m) => {
    // 文末の句読点を巻き込まないよう調整
    const url = m.replace(/[.,、。」）)]+$/, '');
    if (isOfficialUrl(url)) return m;
    removed.push(`url:${url}`);
    return '';
  });

  // ② Markdown リンクの中身が非公式なら、リンクを解いてラベルだけ残す
  text = text.replace(/\[([^\]]*)\]\(([^)]+)\)/g, (m, label: string, url: string) => {
    if (isOfficialUrl(url)) return m;
    removed.push(`mdlink:${url}`);
    return label;
  });

  // ③ @ハンドル（半角/全角）
  text = text.replace(/[@＠][A-Za-z0-9_]{2,20}/g, (m) => {
    removed.push(`handle:${m}`);
    return '';
  });

  // ④ 非公式サイト名（長い順に消す。部分一致で短い語が先に消えるのを防ぐ）
  for (const tok of [...UNOFFICIAL_TOKENS].sort((a, b) => b.length - a.length)) {
    if (!text.includes(tok)) continue;
    // 「〜（サイト名）によると」ごと落とすのではなく、名前だけ落として文を残す
    text = text.split(tok).join('');
    removed.push(`token:${tok}`);
  }

  // ⑤ 「pika0765氏」のような英数字ID＋敬称 → 匿名化
  text = text.replace(/[A-Za-z][A-Za-z0-9_]{2,20}\s*(氏|さん|選手)/g, (m, honor: string) => {
    removed.push(`alias:${m}`);
    return honor === '選手' ? 'あるプレイヤー' : 'あるプレイヤー';
  });

  // 後片付け: 除去で生じた壊れた日本語を整える
  text = tidyJapanese(text);

  return { text, removed };
}

// ============================ 証拠の収集（プロンプト材料） ============================

export type EvidenceItem = {
  title: string;
  excerpt: string;
  observed_at: string;
  citable: 0 | 1;
  url: string;
  source: string;
  trust: number;
};

export type SnapshotLine = {
  label: string;
  share: number;
  deck_count: number;
  share_delta: number | null;
  rank: number | null;
};

export type EventLine = {
  name: string;
  held_on: string;
  scale: string;
  region: string;
  players: number | null;
  is_official: number;
  source_url: string | null;
  days_until: number | null;
};

export type SpotlightCard = {
  card_id: number | null;
  card_name: string;
  card_group: string | null;
  card_file: string | null;
  image_url: string | null;
  adoption: number;
  deck_count: number;
  note?: string;
};

export type DeckLine = {
  id: number;
  name: string;
  ink1: string | null;
  ink2: string | null;
  placement: string | null;
  event_name: string | null;
  region: string;
  observed_at: string | null;
  source_url: string | null;
  source_label: string | null;
  playable_jp: number;
};

export type Evidence = {
  report_date: string;
  /** 公式（引用リンク可） */
  official_jp: EvidenceItem[];
  official_en: EvidenceItem[];
  /** 非公式（材料としてのみ。ソース名は出さない） */
  material_jp: EvidenceItem[];
  material_en: EvidenceItem[];
  /**
   * 画像内テキストのOCR結果（仕様§9-3）。
   * 公式画像のOCRは公式1次情報の一部として扱う（citable=1）。
   * 非公式画像のOCRは非公式本文と同じ扱い（材料のみ、citable=0）。
   */
  ocr_jp: EvidenceItem[];
  jp_snapshot: SnapshotLine[];
  en_snapshot: SnapshotLine[];
  jp_window: { from: string; to: string } | null;
  en_window: { from: string; to: string } | null;
  upcoming: EventLine[];
  recent_events: EventLine[];
  jp_decks: DeckLine[];
  en_decks: DeckLine[];
  spotlight: SpotlightCard[];
  knowledge: { title: string; body: string; observed_at: string | null }[];
  freshest_at: string | null;
  sources_ok: number;
  sources_fail: number;
  failed_sources: string[];
};

const clip = (s: unknown, n: number) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

function daysUntil(dateStr: string | null, today: string): number | null {
  if (!dateStr) return null;
  const a = Date.parse(`${today}T00:00:00Z`);
  const b = Date.parse(`${dateStr}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

/**
 * D1 から要約の材料を集める。
 *
 * 鮮度基準（仕様§5.1）:
 *   公式 = 直近 officialDays 日 / 非公式 = 直近 materialDays 日
 * 材料が空だと要約が「情報なし」になるため、空の場合だけ窓を広げる。
 */
export async function gatherEvidence(
  db: D1Database,
  opts: { reportDate?: string; officialDays?: number; materialDays?: number } = {}
): Promise<Evidence> {
  const today = opts.reportDate || jstToday();
  const officialDays = opts.officialDays ?? 14;
  const materialDays = opts.materialDays ?? 7;

  const pickItems = async (
    citable: 0 | 1,
    region: 'jp' | 'en',
    days: number,
    limit: number
  ): Promise<EvidenceItem[]> => {
    const sql = `SELECT r.title, r.excerpt, r.observed_at, r.citable, r.url, r.trust,
                        COALESCE(s.label, r.source_key) AS source
                   FROM meta_raw_items r
                   LEFT JOIN meta_sources s ON s.key = r.source_key
                  WHERE r.citable = ? AND r.region = ?
                    AND (r.observed_at IS NULL OR r.observed_at >= date(?, ?))
                  ORDER BY COALESCE(r.observed_at, r.fetched_at) DESC
                  LIMIT ?`;
    try {
      const rows = await db.prepare(sql).bind(citable, region, today, `-${days} days`, limit).all();
      return ((rows.results ?? []) as any[]).map((r) => ({
        title: clip(r.title, 160),
        excerpt: clip(r.excerpt, 420),
        observed_at: String(r.observed_at ?? ''),
        citable: (Number(r.citable) ? 1 : 0) as 0 | 1,
        url: String(r.url ?? ''),
        source: String(r.source ?? ''),
        trust: Number(r.trust ?? 3),
      }));
    } catch {
      return [];
    }
  };

  // 公式は窓が狭いと空になりやすいので段階的に広げる
  let official_jp = await pickItems(1, 'jp', officialDays, 12);
  if (!official_jp.length) official_jp = await pickItems(1, 'jp', 60, 12);
  let official_en = await pickItems(1, 'en', officialDays, 10);
  if (!official_en.length) official_en = await pickItems(1, 'en', 60, 10);

  let material_jp = await pickItems(0, 'jp', materialDays, 24);
  if (!material_jp.length) material_jp = await pickItems(0, 'jp', 30, 24);
  let material_en = await pickItems(0, 'en', materialDays, 12);
  if (!material_en.length) material_en = await pickItems(0, 'en', 30, 12);

  // ---- 画像内テキストのOCR結果（仕様§9-3）----
  // 日本の公式Xは開催日時・応募締切・対象レベルを画像に載せるため、
  // ポスト本文だけでは「明日以降の予定」を書けない。OCR結果を材料に加える。
  // citable は元ソースの is_official を継承する（公式画像＝公式1次情報）。
  const pickOcr = async (days: number, limit: number): Promise<EvidenceItem[]> => {
    const sql = `SELECT o.ocr_text, o.observed_at, o.page_url,
                        COALESCE(s.label, o.source_key) AS source,
                        s.is_official, s.trust
                   FROM meta_ocr o
                   LEFT JOIN meta_sources s ON s.key = o.source_key
                  WHERE o.status = 'ok' AND o.char_count > 0
                    AND (s.region IS NULL OR s.region = 'jp')
                    AND (o.observed_at IS NULL OR o.observed_at >= date(?, ?))
                  ORDER BY COALESCE(o.observed_at, o.created_at) DESC
                  LIMIT ?`;
    try {
      const rows = await db.prepare(sql).bind(today, `-${days} days`, limit).all();
      return ((rows.results ?? []) as any[]).map((r) => ({
        title: '画像内テキスト',
        excerpt: clip(r.ocr_text, 700),
        observed_at: String(r.observed_at ?? ''),
        citable: (Number(r.is_official) ? 1 : 0) as 0 | 1,
        // 公式画像なら元ポストURLを引用リンクに使える。非公式はURLを渡さない
        url: Number(r.is_official) ? String(r.page_url ?? '') : '',
        source: Number(r.is_official) ? String(r.source ?? '') : '',
        trust: Number(r.trust ?? 3),
      }));
    } catch {
      return [];
    }
  };
  let ocr_jp = await pickOcr(officialDays, 14);
  if (!ocr_jp.length) ocr_jp = await pickOcr(45, 14);

  // ---- メタ集計スナップショット（最新の window_to のもの）----
  const snapshot = async (region: 'jp' | 'en') => {
    try {
      const head = await db
        .prepare(
          `SELECT window_from, window_to FROM meta_snapshots
            WHERE region = ? AND kind = 'ink_pair'
            ORDER BY window_to DESC, id DESC LIMIT 1`
        )
        .bind(region)
        .first<{ window_from: string; window_to: string }>();
      if (!head) return { window: null, rows: [] as SnapshotLine[] };
      const rows = await db
        .prepare(
          `SELECT label, share, deck_count, share_delta, rank FROM meta_snapshots
            WHERE region = ? AND kind = 'ink_pair' AND window_to = ?
            ORDER BY rank ASC LIMIT 8`
        )
        .bind(region, head.window_to)
        .all();
      return {
        window: { from: head.window_from, to: head.window_to },
        rows: ((rows.results ?? []) as any[]).map((r) => ({
          label: String(r.label ?? ''),
          share: Number(r.share ?? 0),
          deck_count: Number(r.deck_count ?? 0),
          share_delta: r.share_delta == null ? null : Number(r.share_delta),
          rank: r.rank == null ? null : Number(r.rank),
        })),
      };
    } catch {
      return { window: null, rows: [] as SnapshotLine[] };
    }
  };
  const jpSnap = await snapshot('jp');
  const enSnap = await snapshot('en');

  // ---- イベント ----
  const evLines = (rows: any[]): EventLine[] =>
    rows.map((r) => ({
      name: String(r.name ?? ''),
      held_on: String(r.held_on ?? ''),
      scale: String(r.scale ?? ''),
      region: String(r.region ?? 'jp'),
      players: r.players == null ? null : Number(r.players),
      is_official: Number(r.is_official ?? 0),
      source_url: r.source_url ? String(r.source_url) : null,
      days_until: daysUntil(r.held_on ? String(r.held_on) : null, today),
    }));

  let upcoming: EventLine[] = [];
  let recent_events: EventLine[] = [];
  try {
    const up = await db
      .prepare(
        `SELECT name, held_on, scale, region, players, is_official, source_url
           FROM meta_events WHERE held_on >= ? ORDER BY held_on ASC LIMIT 10`
      )
      .bind(today)
      .all();
    upcoming = evLines((up.results ?? []) as any[]);
    const rc = await db
      .prepare(
        `SELECT name, held_on, scale, region, players, is_official, source_url
           FROM meta_events WHERE held_on < ? ORDER BY held_on DESC LIMIT 8`
      )
      .bind(today)
      .all();
    recent_events = evLines((rc.results ?? []) as any[]);
  } catch {
    /* テーブル未作成でも止めない */
  }

  // ---- デッキ（出典URLはデッキだけ明記が許される：仕様§1.3の例外）----
  const deckLines = async (region: 'jp' | 'en', limit: number): Promise<DeckLine[]> => {
    try {
      const rows = await db
        .prepare(
          `SELECT id, name, ink1, ink2, placement, event_name, region,
                  observed_at, source_url, source_label, playable_jp
             FROM meta_decks
            WHERE region = ?
            ORDER BY COALESCE(observed_at, fetched_at) DESC, weight DESC
            LIMIT ?`
        )
        .bind(region, limit)
        .all();
      return ((rows.results ?? []) as any[]).map((r) => ({
        id: Number(r.id),
        name: String(r.name ?? ''),
        ink1: r.ink1 ? String(r.ink1) : null,
        ink2: r.ink2 ? String(r.ink2) : null,
        placement: r.placement ? String(r.placement) : null,
        event_name: r.event_name ? String(r.event_name) : null,
        region: String(r.region ?? region),
        observed_at: r.observed_at ? String(r.observed_at) : null,
        source_url: r.source_url ? String(r.source_url) : null,
        source_label: r.source_label ? String(r.source_label) : null,
        playable_jp: Number(r.playable_jp ?? 0),
      }));
    } catch {
      return [];
    }
  };
  const jp_decks = await deckLines('jp', 12);
  const en_decks = await deckLines('en', 12);

  // ---- 注目カード：LLM に選ばせず、採用率から決定的に選ぶ ----
  const spotlight = await pickSpotlight(db, today);

  // ---- 既存の記憶層（前回までに蓄積した環境知識）----
  let knowledge: Evidence['knowledge'] = [];
  try {
    const rows = await db
      .prepare(
        `SELECT title, body, observed_at FROM meta_knowledge
          ORDER BY COALESCE(observed_at, created_at) DESC LIMIT 8`
      )
      .all();
    knowledge = ((rows.results ?? []) as any[]).map((r) => ({
      title: clip(r.title, 120),
      body: clip(r.body, 300),
      observed_at: r.observed_at ? String(r.observed_at) : null,
    }));
  } catch {
    /* noop */
  }

  // ---- 鮮度と障害状況 ----
  let freshest_at: string | null = null;
  try {
    const f = await db
      .prepare(`SELECT MAX(observed_at) AS d FROM meta_raw_items`)
      .first<{ d: string | null }>();
    freshest_at = f?.d ?? null;
  } catch {
    /* noop */
  }

  let sources_ok = 0;
  let sources_fail = 0;
  const failed_sources: string[] = [];
  try {
    const rows = await db
      .prepare(`SELECT key, label, enabled, fail_streak, last_status FROM meta_sources WHERE enabled = 1`)
      .all();
    for (const r of (rows.results ?? []) as any[]) {
      if (Number(r.fail_streak ?? 0) > 0) {
        sources_fail++;
        failed_sources.push(String(r.label ?? r.key));
      } else {
        sources_ok++;
      }
    }
  } catch {
    /* noop */
  }

  return {
    report_date: today,
    official_jp,
    official_en,
    material_jp,
    material_en,
    ocr_jp,
    jp_snapshot: jpSnap.rows,
    en_snapshot: enSnap.rows,
    jp_window: jpSnap.window,
    en_window: enSnap.window,
    upcoming,
    recent_events,
    jp_decks,
    en_decks,
    spotlight,
    knowledge,
    freshest_at,
    sources_ok,
    sources_fail,
    failed_sources,
  };
}

/**
 * 注目カードの決定的な選出。
 * meta_snapshots(kind='card') の採用率上位を cards テーブルに突合し、
 * 画像URLと日本語名（card_group）を確定させてから返す。
 */
export async function pickSpotlight(
  db: D1Database,
  today: string,
  limit = 5
): Promise<SpotlightCard[]> {
  try {
    const head = await db
      .prepare(
        `SELECT window_to FROM meta_snapshots WHERE kind = 'card'
          ORDER BY window_to DESC, id DESC LIMIT 1`
      )
      .first<{ window_to: string }>();
    if (!head) return [];
    const rows = await db
      .prepare(
        `SELECT label, share, deck_count, detail FROM meta_snapshots
          WHERE kind = 'card' AND window_to = ?
          ORDER BY rank ASC LIMIT ?`
      )
      .bind(head.window_to, limit * 3)
      .all();
    const list = (rows.results ?? []) as any[];
    if (!list.length) return [];

    const out: SpotlightCard[] = [];
    for (const r of list) {
      if (out.length >= limit) break;
      const name = String(r.label ?? '');
      if (!name) continue;
      // card_group（「アリエル／麗しい歌姫」）優先、無ければ card_name で突合
      const card = await db
        .prepare(
          `SELECT id, card_name, card_group, card_file, image_url FROM cards
            WHERE card_group = ? OR card_name = ? LIMIT 1`
        )
        .bind(name, name)
        .first<any>();
      out.push({
        card_id: card ? Number(card.id) : null,
        card_name: card ? String(card.card_group || card.card_name) : name,
        card_group: card ? String(card.card_group ?? '') : null,
        card_file: card ? String(card.card_file ?? '') : null,
        image_url: card ? String(card.image_url ?? '') : null,
        adoption: Number(r.share ?? 0),
        deck_count: Number(r.deck_count ?? 0),
      });
    }
    return out;
  } catch {
    return [];
  }
}

// ============================ プロンプト ============================

export const REPORT_SYSTEM_PROMPT = `あなたはディズニー ロルカナ（Disney Lorcana）日本語ファンサイトの環境レポート編集者です。
読者は中〜上級のロルカナプレイヤーです。与えられた「材料」だけを根拠に、日本語の環境レポートを書きます。

# 絶対に守る出力規則

## 1. 引用方針（最重要 / 違反は不可）
- 公式情報（タカラトミー公式 / Ravensburger公式）のみ、出典URLをリンクとして本文に含めてよい。
- 非公式ソース（X、note、個人ブログ、コミュニティサイト、海外集計サイト）については:
  - URLを書かない。
  - サイト名・アカウント名・ハンドル（@から始まる文字列）・個人名を書かない。
  - 本文をそのまま引用しない（言い換えて要約する）。
  - 必ず集約表現にする。良い例:「複数のプレイヤーの発信によると」「大会上位の構築を集計すると」「海外のメタ集計では」
- 悪い例（絶対に書かない）:「@xxxのポストによると」「xxx氏のnote記事より」「inkdecksのデータでは」

## 2. 事実の扱い
- 数字（メタシェア％、参加者数、日付、枚数）は材料に書かれている値のみを使う。自分で計算・推定しない。
- 材料に無いことは書かない。知識で補完しない。
- 材料に「単一ソース」と注記されている情報は断定しない。「〜傾向がある」「〜という声が広がっている」等の表現にする。
- 未確定情報（噂・リーク）は文中に「未確認」と明記する。
- 材料が乏しいブロックは、無理に埋めず「現時点で確度の高い情報は限られる」旨を書いてよい。

## 3. 文体・表記
- 「である調」で統一する。丁寧語（です・ます）は使わない。
- インク色は日本語カラー名のみ: アンバー / アメジスト / エメラルド / ルビー / サファイア / スティール
- 用語は日本語版準拠: インク、ロア、クエスト、チャレンジ、シフト、ボディガード、ラッシュ、エヴァシブ
- カード名は与えられた日本語表記をそのまま使う。英語名に戻さない。
- 各要約ブロックは 160〜300 文字（日本語）。この字数を厳守する。

# 出力フォーマット
必ず次のJSONオブジェクトのみを返す。前置き・後書き・コードフェンスは書かない。

{
  "jp_summary": "日本環境ハイライトの要約（160〜300字）",
  "en_summary": "海外環境ハイライトの要約（160〜300字）",
  "diff_summary": "日本と海外の共通点・分岐点（1〜2行、60〜160字）",
  "upcoming_summary": "明日以降の予定の要約（160〜300字）",
  "jp_topics": [{"title": "話題の見出し（20字以内）", "body": "本文（60〜140字）", "tag": "カード|デッキ|大会|ルール|未確認"}],
  "en_topics": [{"title": "...", "body": "...", "tag": "..."}],
  "spotlight_notes": [{"card_name": "与えられたカード名をそのまま", "note": "採用理由の解説（40〜100字）"}]
}

jp_topics は 3〜5 件、en_topics は 2〜4 件。spotlight_notes は与えられた注目カードの件数に一致させる。`;

const fmtItems = (items: EvidenceItem[], citable: boolean): string => {
  if (!items.length) return '（該当なし）';
  return items
    .map((it, i) => {
      const head = `${i + 1}. [${it.observed_at || '日付不明'}] ${it.title}`;
      const body = it.excerpt ? `\n   要点: ${it.excerpt}` : '';
      // 公式のみURLを渡す。非公式にはURLを一切渡さない（漏洩の物理的防止）
      const link = citable && isOfficialUrl(it.url) ? `\n   公式URL: ${it.url}` : '';
      return head + body + link;
    })
    .join('\n');
};

const fmtSnap = (rows: SnapshotLine[], w: { from: string; to: string } | null): string => {
  if (!rows.length) return '（集計データなし）';
  const head = w ? `集計期間: ${w.from} 〜 ${w.to}\n` : '';
  return (
    head +
    rows
      .map((r) => {
        const d =
          r.share_delta == null
            ? ''
            : ` (前回比 ${r.share_delta > 0 ? '+' : ''}${r.share_delta.toFixed(1)}pt)`;
        const single = r.deck_count <= 1 ? ' ※単一ソース・母数1' : '';
        return `- ${r.label}: ${r.share.toFixed(1)}% / ${r.deck_count}件${d}${single}`;
      })
      .join('\n')
  );
};

const fmtEvents = (rows: EventLine[], label: string): string => {
  if (!rows.length) return '（該当なし）';
  return rows
    .map((e) => {
      const d = e.days_until == null ? '' : e.days_until >= 0 ? ` / あと${e.days_until}日` : '';
      const p = e.players ? ` / 参加${e.players}人` : '';
      const u = e.is_official && e.source_url && isOfficialUrl(e.source_url)
        ? ` / 公式URL: ${e.source_url}`
        : '';
      return `- [${e.held_on}] ${e.name}（${e.region === 'jp' ? '日本' : '海外'}）${d}${p}${u}`;
    })
    .join('\n');
};

const fmtDecks = (rows: DeckLine[]): string => {
  if (!rows.length) return '（該当なし）';
  return rows
    .map((d) => {
      const ink = [d.ink1, d.ink2].filter(Boolean).join('/') || 'インク不明';
      const pl = d.placement ? ` ${d.placement}` : '';
      const ev = d.event_name ? ` @${d.event_name}` : '';
      const jp = d.playable_jp ? '' : ' ※日本未収録カードを含む';
      return `- [${d.observed_at || '日付不明'}] ${d.name || ink}（${ink}）${pl}${ev}${jp}`;
    })
    .join('\n');
};

/** LLM に渡すユーザープロンプト。材料は全てここに閉じ込める（外部知識を使わせない） */
export function buildReportPrompt(ev: Evidence): string {
  const parts: string[] = [];

  parts.push(
    `# レポート日付\n${ev.report_date}（JST）\n` +
      `材料の最新日付: ${ev.freshest_at || '不明'}\n` +
      `情報源の稼働状況: 正常 ${ev.sources_ok} / 失敗 ${ev.sources_fail}` +
      (ev.failed_sources.length ? `（失敗: ${ev.failed_sources.length}系統）` : '')
  );

  parts.push(
    `# 材料A: 日本の公式情報【URLをリンクとして本文に書いてよい】\n` +
      fmtItems(ev.official_jp, true)
  );
  parts.push(
    `# 材料B: 海外の公式情報【URLをリンクとして本文に書いてよい】\n` +
      fmtItems(ev.official_en, true)
  );
  parts.push(
    `# 材料C: 日本の非公式情報【要約の材料としてのみ使う。ソース名・URL・アカウント名は書かない。集約表現にする】\n` +
      fmtItems(ev.material_jp, false)
  );
  parts.push(
    `# 材料D: 海外の非公式情報【要約の材料としてのみ使う。ソース名・URL・アカウント名は書かない。集約表現にする】\n` +
      fmtItems(ev.material_en, false)
  );

  // 画像内テキスト（仕様§9-3）。
  // 公式の告知画像には本文にない開催時刻・対象レベル・応募締切が入っている。
  // ただしOCRは誤認識し得るので、公式本文と知している情報が衍突する場合は本文を優先するよう指示する。
  if (ev.ocr_jp.length) {
    const citable = ev.ocr_jp.filter((o) => o.citable === 1);
    const nonCitable = ev.ocr_jp.filter((o) => o.citable === 0);
    if (citable.length) {
      parts.push(
        `# 材料D2: 公式画像の画像内テキスト（OCR）` +
          `【公式1次情報なのでURLをリンクとして使ってよい。` +
          `ただしOCRは誤認識し得るので、材料Aの本文と食い違う場合は材料Aを優先。` +
          `読み取れていない数値を推測で補わない】\n` +
          fmtItems(citable, true)
      );
    }
    if (nonCitable.length) {
      parts.push(
        `# 材料D3: 非公式画像の画像内テキスト（OCR）` +
          `【材料としてのみ。ソース名・URL・アカウント名は書かない。集約表現にする】\n` +
          fmtItems(nonCitable, false)
      );
    }
  }

  parts.push(`# 材料E: 日本のメタ集計（この数値をそのまま使う）\n${fmtSnap(ev.jp_snapshot, ev.jp_window)}`);
  parts.push(`# 材料F: 海外のメタ集計（この数値をそのまま使う）\n${fmtSnap(ev.en_snapshot, ev.en_window)}`);

  parts.push(`# 材料G: 直近の大会\n${fmtEvents(ev.recent_events, '直近')}`);
  parts.push(`# 材料H: 今後の予定\n${fmtEvents(ev.upcoming, '予定')}`);

  parts.push(`# 材料I: 収集した日本のデッキ\n${fmtDecks(ev.jp_decks)}`);
  parts.push(`# 材料J: 収集した海外のデッキ\n${fmtDecks(ev.en_decks)}`);

  if (ev.spotlight.length) {
    parts.push(
      `# 材料K: 注目カード（この名前をそのまま使う。他のカードを追加しない）\n` +
        ev.spotlight
          .map(
            (s) =>
              `- ${s.card_name}: 採用率 ${s.adoption.toFixed(1)}% / ${s.deck_count}件のデッキで採用`
          )
          .join('\n')
    );
  }

  if (ev.knowledge.length) {
    parts.push(
      `# 材料L: これまでに蓄積した環境知識（背景として参照。古い可能性があるため断定に使わない）\n` +
        ev.knowledge
          .map((k) => `- [${k.observed_at || '日付不明'}] ${k.title}: ${k.body}`)
          .join('\n')
    );
  }

  parts.push(
    `# 指示\n上記の材料のみを根拠に、システム指示のJSONフォーマットでレポートを出力せよ。\n` +
      `材料Cと材料Dの内容は、ソースを特定できない集約表現に必ず言い換えること。`
  );

  return parts.join('\n\n');
}

// ============================ ドラフトの検証・整形 ============================

export type Topic = { title: string; body: string; tag: string };
export type ReportDraft = {
  jp_summary: string;
  en_summary: string;
  diff_summary: string;
  upcoming_summary: string;
  jp_topics: Topic[];
  en_topics: Topic[];
  spotlight_notes: { card_name: string; note: string }[];
};

export type SanitizeReport = {
  draft: ReportDraft;
  violations: string[];
  lengthWarnings: string[];
};

const ALLOWED_TAGS = new Set(['カード', 'デッキ', '大会', 'ルール', '未確認']);

/** 日本語の実効文字数（URL・記号を除いた本文量で字数を測る） */
export function jaLength(s: string): number {
  return String(s ?? '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s/g, '').length;
}

/**
 * LLM 出力を仕様どおりに整形する。
 * ここを通っていない文字列は絶対に DB / フロントへ出さない。
 */
export function sanitizeDraft(raw: any, spotlight: SpotlightCard[]): SanitizeReport {
  const violations: string[] = [];
  const lengthWarnings: string[] = [];

  const clean = (v: unknown, field: string): string => {
    const { text, removed } = scrubText(String(v ?? ''));
    for (const r of removed) violations.push(`${field}: ${r}`);
    return text;
  };

  const checkLen = (s: string, field: string, min: number, max: number) => {
    const n = jaLength(s);
    if (n && (n < min || n > max)) lengthWarnings.push(`${field}: ${n}字 (規定 ${min}〜${max})`);
  };

  const jp_summary = clean(raw?.jp_summary, 'jp_summary');
  const en_summary = clean(raw?.en_summary, 'en_summary');
  const diff_summary = clean(raw?.diff_summary, 'diff_summary');
  const upcoming_summary = clean(raw?.upcoming_summary, 'upcoming_summary');

  checkLen(jp_summary, 'jp_summary', 160, 300);
  checkLen(en_summary, 'en_summary', 160, 300);
  checkLen(diff_summary, 'diff_summary', 40, 200);
  checkLen(upcoming_summary, 'upcoming_summary', 160, 300);

  const topics = (arr: unknown, field: string, max: number): Topic[] => {
    if (!Array.isArray(arr)) return [];
    return arr
      .slice(0, max)
      .map((t: any, i) => {
        const title = clean(t?.title, `${field}[${i}].title`).slice(0, 40);
        const body = clean(t?.body, `${field}[${i}].body`).slice(0, 400);
        let tag = String(t?.tag ?? '').trim();
        if (!ALLOWED_TAGS.has(tag)) tag = 'デッキ';
        return { title, body, tag };
      })
      .filter((t) => t.title && t.body);
  };

  const jp_topics = topics(raw?.jp_topics, 'jp_topics', 5);
  const en_topics = topics(raw?.en_topics, 'en_topics', 4);

  // 注目カードのコメント：与えたカード名にしか付けられない（未知の名前は破棄）
  const allowed = new Map(spotlight.map((s) => [s.card_name, s]));
  const spotlight_notes: { card_name: string; note: string }[] = [];
  if (Array.isArray(raw?.spotlight_notes)) {
    for (let i = 0; i < raw.spotlight_notes.length; i++) {
      const n: any = raw.spotlight_notes[i];
      const name = String(n?.card_name ?? '').trim();
      if (!allowed.has(name)) {
        if (name) violations.push(`spotlight_notes[${i}]: unknown_card:${name}`);
        continue;
      }
      const note = clean(n?.note, `spotlight_notes[${i}].note`).slice(0, 200);
      if (note) spotlight_notes.push({ card_name: name, note });
    }
  }

  return {
    draft: {
      jp_summary,
      en_summary,
      diff_summary,
      upcoming_summary,
      jp_topics,
      en_topics,
      spotlight_notes,
    },
    violations,
    lengthWarnings,
  };
}

/** 公式リンクだけを抽出して表示用に整える（本文とは別枠で出す） */
export function buildOfficialLinks(ev: Evidence): { label: string; url: string; date: string; region: string }[] {
  const out: { label: string; url: string; date: string; region: string }[] = [];
  const seen = new Set<string>();
  const push = (label: string, url: string, date: string, region: string) => {
    if (!url || !isOfficialUrl(url) || seen.has(url)) return;
    seen.add(url);
    out.push({ label: label.slice(0, 120), url, date, region });
  };
  for (const it of ev.official_jp) push(it.title, it.url, it.observed_at, 'jp');
  for (const it of ev.official_en) push(it.title, it.url, it.observed_at, 'en');
  for (const e of ev.upcoming) if (e.source_url) push(e.name, e.source_url, e.held_on, e.region);
  return out.slice(0, 12);
}

// ============================ レポート生成 ============================

export type GenerateResult = {
  report_date: string;
  status: 'published' | 'failed';
  model: string;
  violations: string[];
  lengthWarnings: string[];
  evidence_counts: Record<string, number>;
  reused_previous?: boolean;
  error?: string;
};

/**
 * 日次レポートを生成して保存する。
 *
 * 仕様§6: 失敗時は前日データを維持する。
 *   → 例外時に既存行を触らず、meta_jobs にのみ失敗を記録して返す。
 */
export async function generateReport(
  env: AiEnv,
  db: D1Database,
  opts: { reportDate?: string; model?: string; dryRun?: boolean } = {}
): Promise<GenerateResult> {
  const reportDate = opts.reportDate || jstToday();
  const ev = await gatherEvidence(db, { reportDate });

  const counts: Record<string, number> = {
    official_jp: ev.official_jp.length,
    official_en: ev.official_en.length,
    material_jp: ev.material_jp.length,
    material_en: ev.material_en.length,
    jp_snapshot: ev.jp_snapshot.length,
    en_snapshot: ev.en_snapshot.length,
    upcoming: ev.upcoming.length,
    jp_decks: ev.jp_decks.length,
    en_decks: ev.en_decks.length,
    spotlight: ev.spotlight.length,
    ocr_jp: ev.ocr_jp.length,
  };

  const totalMaterial =
    ev.official_jp.length + ev.official_en.length + ev.material_jp.length + ev.material_en.length;
  if (!totalMaterial && !ev.jp_snapshot.length && !ev.upcoming.length) {
    return {
      report_date: reportDate,
      status: 'failed',
      model: '',
      violations: [],
      lengthWarnings: [],
      evidence_counts: counts,
      reused_previous: true,
      error: 'no_material',
    };
  }

  if (!aiConfigured(env)) throw new LlmError('ai_not_configured', 503);

  const model = opts.model || env.AI_MODEL || 'gpt-5-mini';
  const { data, model: usedModel } = await chatJson<any>(
    env,
    [
      { role: 'system', content: REPORT_SYSTEM_PROMPT },
      { role: 'user', content: buildReportPrompt(ev) },
    ],
    { model, maxTokens: 6000, timeoutMs: 90_000, reasoningEffort: 'low' }
  );

  const { draft, violations, lengthWarnings } = sanitizeDraft(data, ev.spotlight);

  // 注目カードにコメントを合流（コメントが無くてもカード自体は出す）
  const noteBy = new Map(draft.spotlight_notes.map((n) => [n.card_name, n.note]));
  const spotlight_cards: SpotlightCard[] = ev.spotlight.map((s) => ({
    ...s,
    note: noteBy.get(s.card_name) || '',
  }));

  const official_links = buildOfficialLinks(ev);

  if (opts.dryRun) {
    return {
      report_date: reportDate,
      status: 'published',
      model: usedModel,
      violations,
      lengthWarnings,
      evidence_counts: counts,
    };
  }

  await saveReport(db, {
    report_date: reportDate,
    status: 'published',
    jp_summary: draft.jp_summary,
    en_summary: draft.en_summary,
    diff_summary: draft.diff_summary,
    upcoming_summary: draft.upcoming_summary,
    jp_topics: draft.jp_topics,
    en_topics: draft.en_topics,
    official_links,
    spotlight_cards,
    stats: {
      evidence: counts,
      violations,
      length_warnings: lengthWarnings,
      failed_sources: ev.failed_sources,
      jp_window: ev.jp_window,
      en_window: ev.en_window,
      generated_at_jst: jstNow(),
    },
    freshest_at: ev.freshest_at,
    sources_ok: ev.sources_ok,
    sources_fail: ev.sources_fail,
    model: usedModel,
  });

  return {
    report_date: reportDate,
    status: 'published',
    model: usedModel,
    violations,
    lengthWarnings,
    evidence_counts: counts,
  };
}

export type SavePayload = {
  report_date: string;
  status: string;
  jp_summary: string;
  en_summary: string;
  diff_summary: string;
  upcoming_summary: string;
  jp_topics: unknown;
  en_topics: unknown;
  official_links: unknown;
  spotlight_cards: unknown;
  stats: unknown;
  freshest_at: string | null;
  sources_ok: number;
  sources_fail: number;
  model: string;
};

export async function saveReport(db: D1Database, p: SavePayload): Promise<void> {
  await db
    .prepare(
      `INSERT INTO meta_reports
         (report_date, status, jp_summary, en_summary, diff_summary, upcoming_summary,
          jp_topics, en_topics, official_links, spotlight_cards, stats,
          freshest_at, sources_ok, sources_fail, model, generated_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))
       ON CONFLICT(report_date) DO UPDATE SET
         status=excluded.status, jp_summary=excluded.jp_summary, en_summary=excluded.en_summary,
         diff_summary=excluded.diff_summary, upcoming_summary=excluded.upcoming_summary,
         jp_topics=excluded.jp_topics, en_topics=excluded.en_topics,
         official_links=excluded.official_links, spotlight_cards=excluded.spotlight_cards,
         stats=excluded.stats, freshest_at=excluded.freshest_at,
         sources_ok=excluded.sources_ok, sources_fail=excluded.sources_fail,
         model=excluded.model, generated_at=datetime('now'), updated_at=datetime('now')`
    )
    .bind(
      p.report_date,
      p.status,
      p.jp_summary,
      p.en_summary,
      p.diff_summary,
      p.upcoming_summary,
      JSON.stringify(p.jp_topics ?? []),
      JSON.stringify(p.en_topics ?? []),
      JSON.stringify(p.official_links ?? []),
      JSON.stringify(p.spotlight_cards ?? []),
      JSON.stringify(p.stats ?? {}),
      p.freshest_at,
      p.sources_ok,
      p.sources_fail,
      p.model
    )
    .run();
}

const parseJson = <T>(v: unknown, fallback: T): T => {
  if (typeof v !== 'string' || !v) return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
};

export type PublicReport = {
  report_date: string;
  status: string;
  jp_summary: string;
  en_summary: string;
  diff_summary: string;
  upcoming_summary: string;
  jp_topics: Topic[];
  en_topics: Topic[];
  official_links: { label: string; url: string; date: string; region: string }[];
  spotlight_cards: SpotlightCard[];
  freshest_at: string | null;
  sources_ok: number;
  sources_fail: number;
  generated_at: string | null;
  /** 当日分が無く過去分を返した場合 true（仕様§6のフォールバック） */
  stale: boolean;
};

/**
 * 表示用レポートの取得。
 * 当日分が無ければ直近の published を返す（前日データ維持＝仕様§6）。
 */
export async function loadReport(
  db: D1Database,
  reportDate?: string
): Promise<PublicReport | null> {
  const today = reportDate || jstToday();
  const pick = async (sql: string, binds: unknown[]) => {
    try {
      return await db.prepare(sql).bind(...(binds as any[])).first<any>();
    } catch {
      return null;
    }
  };
  let row = await pick(
    `SELECT * FROM meta_reports WHERE report_date = ? AND status = 'published'`,
    [today]
  );
  let stale = false;
  if (!row) {
    row = await pick(
      `SELECT * FROM meta_reports WHERE status = 'published' AND report_date <= ?
        ORDER BY report_date DESC LIMIT 1`,
      [today]
    );
    stale = Boolean(row);
  }
  if (!row) return null;

  return {
    report_date: String(row.report_date),
    status: String(row.status),
    jp_summary: String(row.jp_summary ?? ''),
    en_summary: String(row.en_summary ?? ''),
    diff_summary: String(row.diff_summary ?? ''),
    upcoming_summary: String(row.upcoming_summary ?? ''),
    jp_topics: parseJson<Topic[]>(row.jp_topics, []),
    en_topics: parseJson<Topic[]>(row.en_topics, []),
    official_links: parseJson<PublicReport['official_links']>(row.official_links, []),
    spotlight_cards: parseJson<SpotlightCard[]>(row.spotlight_cards, []),
    freshest_at: row.freshest_at ? String(row.freshest_at) : null,
    sources_ok: Number(row.sources_ok ?? 0),
    sources_fail: Number(row.sources_fail ?? 0),
    generated_at: row.generated_at ? String(row.generated_at) : null,
    stale,
  };
}

// ============================ 記憶層への書き込み ============================
/**
 * 「最新環境情報として記憶層を更新（どんどんロルカナに詳しくする）」
 *
 * レポート本文・メタ集計・大会結果を meta_knowledge に正規化して積む。
 * text_hash が同じものは積まない（同じ内容を毎日重複させない）。
 * 記憶層に入れる本文からも scrubText を通す（AI経由での漏洩防止）。
 */
export type KnowledgeRow = {
  scope: string;
  title: string;
  body: string;
  observed_at: string | null;
  season: string | null;
  region: string;
  trust: number;
  official_url: string | null;
};

export function metaEmbedText(k: { scope?: string; title?: string; body?: string; observed_at?: string | null }): string {
  const d = k.observed_at ? `（${k.observed_at}時点）` : '';
  return `[環境情報 ${k.scope ?? ''}]${d} ${k.title ?? ''}: ${String(k.body ?? '').replace(/\s+/g, ' ')}`.slice(
    0,
    1200
  );
}

/** レポートと集計から記憶層の行を組み立てる（DB書き込みはしない：テスト容易性のため分離） */
export function buildKnowledgeRows(
  report: PublicReport,
  ev: Evidence,
  season?: string | null
): KnowledgeRow[] {
  const rows: KnowledgeRow[] = [];
  const s = season ?? null;
  const add = (r: KnowledgeRow) => {
    const body = scrubText(r.body).text;
    if (!body || body.length < 20) return;
    rows.push({ ...r, body });
  };

  if (report.jp_summary)
    add({
      scope: 'jp_meta',
      title: `${report.report_date} 日本環境サマリ`,
      body: report.jp_summary,
      observed_at: report.report_date,
      season: s,
      region: 'jp',
      trust: 4,
      official_url: null,
    });
  if (report.en_summary)
    add({
      scope: 'en_meta',
      title: `${report.report_date} 海外環境サマリ`,
      body: report.en_summary,
      observed_at: report.report_date,
      season: s,
      region: 'en',
      trust: 4,
      official_url: null,
    });
  if (report.diff_summary)
    add({
      scope: 'jp_meta',
      title: `${report.report_date} 日本と海外の差分`,
      body: report.diff_summary,
      observed_at: report.report_date,
      season: s,
      region: 'jp',
      trust: 3,
      official_url: null,
    });

  // メタ集計は数値なので、そのまま文章化して記憶させる
  const snapBody = (list: SnapshotLine[], w: Evidence['jp_window']) =>
    list.length
      ? `${w ? `${w.from}〜${w.to}の集計。` : ''}` +
        list.map((r) => `${r.label} ${r.share.toFixed(1)}%（${r.deck_count}件）`).join('、')
      : '';
  const jpSnapBody = snapBody(ev.jp_snapshot, ev.jp_window);
  if (jpSnapBody)
    add({
      scope: 'jp_meta',
      title: `${report.report_date} 日本メタシェア（インク組合せ）`,
      body: jpSnapBody,
      observed_at: ev.jp_window?.to ?? report.report_date,
      season: s,
      region: 'jp',
      trust: 4,
      official_url: null,
    });
  const enSnapBody = snapBody(ev.en_snapshot, ev.en_window);
  if (enSnapBody)
    add({
      scope: 'en_meta',
      title: `${report.report_date} 海外メタシェア（インク組合せ）`,
      body: enSnapBody,
      observed_at: ev.en_window?.to ?? report.report_date,
      season: s,
      region: 'en',
      trust: 4,
      official_url: null,
    });

  // 注目カードは「どのカードが今強いか」の記憶として重要
  for (const c of report.spotlight_cards) {
    if (!c.note) continue;
    add({
      scope: 'jp_meta',
      title: `注目カード: ${c.card_name}`,
      body: `採用率 ${c.adoption.toFixed(1)}%（${c.deck_count}件）。${c.note}`,
      observed_at: report.report_date,
      season: s,
      region: 'jp',
      trust: 3,
      official_url: null,
    });
  }

  // トピック
  for (const t of [...report.jp_topics, ...report.en_topics]) {
    add({
      scope: 'news',
      title: t.title,
      body: `${t.body}${t.tag === '未確認' ? '（未確認情報）' : ''}`,
      observed_at: report.report_date,
      season: s,
      region: 'jp',
      trust: t.tag === '未確認' ? 1 : 3,
      official_url: null,
    });
  }

  // 大会予定は公式URLを持てる
  for (const e of ev.upcoming.slice(0, 6)) {
    add({
      scope: 'event',
      title: `予定: ${e.name}`,
      body: `${e.held_on} 開催予定（${e.region === 'jp' ? '日本' : '海外'}）。${
        e.days_until != null && e.days_until >= 0 ? `${report.report_date}時点であと${e.days_until}日。` : ''
      }`,
      observed_at: report.report_date,
      season: s,
      region: e.region,
      trust: e.is_official ? 5 : 3,
      official_url: e.source_url && isOfficialUrl(e.source_url) ? e.source_url : null,
    });
  }

  return rows;
}

/** 記憶層 upsert（text_hash で重複排除）。挿入/更新件数を返す */
export async function upsertKnowledge(
  db: D1Database,
  rows: KnowledgeRow[]
): Promise<{ inserted: number; skipped: number }> {
  let inserted = 0;
  let skipped = 0;
  for (const r of rows) {
    const hash = await sha256Hex(`${r.scope}\n${r.title}\n${r.body}`);
    const exists = await db
      .prepare(`SELECT id FROM meta_knowledge WHERE text_hash = ?`)
      .bind(hash)
      .first<{ id: number }>();
    if (exists) {
      skipped++;
      continue;
    }
    await db
      .prepare(
        `INSERT INTO meta_knowledge
           (scope,title,body,observed_at,season,region,trust,official_url,text_hash)
         VALUES (?,?,?,?,?,?,?,?,?)`
      )
      .bind(
        r.scope,
        r.title,
        r.body,
        r.observed_at,
        r.season,
        r.region,
        r.trust,
        r.official_url,
        hash
      )
      .run();
    inserted++;
  }
  return { inserted, skipped };
}

/** 記憶層のベクトル化（未ベクトル・内容変更分のみ） */
export async function embedKnowledge(
  env: AiEnv,
  db: D1Database,
  opts: { limit?: number } = {}
): Promise<{ embedded: number; remaining: number }> {
  const limit = opts.limit ?? 64;
  const rows = await db
    .prepare(
      `SELECT k.id, k.scope, k.title, k.body, k.observed_at, k.text_hash
         FROM meta_knowledge k
         LEFT JOIN meta_vectors v ON v.knowledge_id = k.id
        WHERE v.knowledge_id IS NULL OR v.text_hash <> k.text_hash
        ORDER BY k.id DESC LIMIT ?`
    )
    .bind(limit)
    .all();
  const list = (rows.results ?? []) as any[];
  if (!list.length) return { embedded: 0, remaining: 0 };

  const vecs = await embed(
    env,
    list.map((r) => metaEmbedText(r))
  );
  const stmts = list.map((r, i) =>
    db
      .prepare(
        `INSERT INTO meta_vectors (knowledge_id, vec, dims, model, text_hash, updated_at)
         VALUES (?,?,?,?,?,datetime('now'))
         ON CONFLICT(knowledge_id) DO UPDATE SET
           vec=excluded.vec, dims=excluded.dims, model=excluded.model,
           text_hash=excluded.text_hash, updated_at=datetime('now')`
      )
      .bind(Number(r.id), toBlob(vecs[i]), EMBED_DIMS, EMBED_MODEL, String(r.text_hash))
  );
  for (let i = 0; i < stmts.length; i += 40) await db.batch(stmts.slice(i, i + 40));

  const rest = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM meta_knowledge k
         LEFT JOIN meta_vectors v ON v.knowledge_id = k.id
        WHERE v.knowledge_id IS NULL OR v.text_hash <> k.text_hash`
    )
    .first<{ n: number }>();
  return { embedded: list.length, remaining: Number(rest?.n ?? 0) };
}

// ============================ 記憶層の想起（AI回答用） ============================

export type MetaHit = {
  id: number;
  scope: string;
  title: string;
  body: string;
  observed_at: string | null;
  region: string;
  trust: number;
  official_url: string | null;
  sim: number;
};

/**
 * 環境知識をクエリベクトルで想起する。
 * AI が「今の環境では〜」と答える際の根拠。
 * 必ず observed_at を伴って返し、プロンプト側で日付を明示させる
 * （古い環境情報を「今」として語らせないため）。
 */
export async function recallMeta(
  db: D1Database,
  query: Float32Array,
  opts: { topK?: number; minSim?: number } = {}
): Promise<MetaHit[]> {
  const topK = opts.topK ?? 5;
  const minSim = opts.minSim ?? 0.3;
  try {
    const rows = await db
      .prepare(
        `SELECT v.knowledge_id AS id, v.vec, k.scope, k.title, k.body,
                k.observed_at, k.region, k.trust, k.official_url
           FROM meta_vectors v JOIN meta_knowledge k ON k.id = v.knowledge_id`
      )
      .all();
    const list = (rows.results ?? []) as any[];
    if (!list.length) return [];
    const q = normalize(query);
    const hits: MetaHit[] = [];
    for (const r of list) {
      const v = fromBlob(r.vec);
      if (!v) continue;
      const sim = dot(q, v);
      if (sim < minSim) continue;
      hits.push({
        id: Number(r.id),
        scope: String(r.scope ?? ''),
        title: String(r.title ?? ''),
        body: String(r.body ?? ''),
        observed_at: r.observed_at ? String(r.observed_at) : null,
        region: String(r.region ?? 'jp'),
        trust: Number(r.trust ?? 3),
        official_url: r.official_url ? String(r.official_url) : null,
        sim,
      });
    }
    hits.sort((a, b) => b.sim - a.sim);
    return hits.slice(0, topK);
  } catch {
    return [];
  }
}

/** メタ記憶の投入状況 */
export async function metaVectorsReady(
  db: D1Database
): Promise<{ knowledge: number; vectors: number; reports: number; decks: number; decks_jp: number }> {
  const n = async (sql: string) => {
    try {
      const r = await db.prepare(sql).first<{ n: number }>();
      return Number(r?.n ?? 0);
    } catch {
      return 0;
    }
  };
  return {
    knowledge: await n('SELECT COUNT(*) AS n FROM meta_knowledge'),
    vectors: await n('SELECT COUNT(*) AS n FROM meta_vectors'),
    reports: await n("SELECT COUNT(*) AS n FROM meta_reports WHERE status='published'"),
    decks: await n('SELECT COUNT(*) AS n FROM meta_decks'),
    decks_jp: await n('SELECT COUNT(*) AS n FROM meta_decks WHERE playable_jp=1'),
  };
}
