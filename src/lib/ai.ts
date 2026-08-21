/**
 * ai.ts — AIシナジー探索の中核ロジック
 *
 * 設計方針（コストと精度の両立 / BUILD_SPEC §0 の法務要件も維持）
 *  1. 「候補抽出」は D1 上の決定的な SQL で行う（2,500枚全部をLLMに渡さない）
 *  2. 「順位付けと理由生成」だけを LLM に任せる
 *  3. LLM には “DBに保存済みの効果テキスト” と “総合ルールの該当抜粋” のみを与える
 *     （= 外部知識に頼らせない / ルールのハルシネーション防止）
 *  4. 返すカードは必ず D1 の実データ。LLM が出した id 以外は採用しない
 *     （存在しないカードを AI が創作しても表示されない）
 */
import type { AiEnv, CardBrief } from '../types';

// ============================ LLM クライアント ============================

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

export class LlmError extends Error {
  status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.status = status;
  }
}

export function aiConfigured(env: AiEnv): boolean {
  return Boolean(env.OPENAI_API_KEY && env.OPENAI_BASE_URL);
}

/** OpenAI 互換 /chat/completions を叩く（SDK不使用: Workers ランタイムで軽量に動かす） */
export async function chatJson<T>(
  env: AiEnv,
  messages: ChatMessage[],
  opts: {
    model?: string;
    maxTokens?: number;
    timeoutMs?: number;
    /** gpt-5 系の推論量。既定は 'low'（応答が数十秒かかるのを防ぐ） */
    reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high';
  } = {}
): Promise<{ data: T; usage: unknown; model: string }> {
  if (!aiConfigured(env)) throw new LlmError('ai_not_configured', 503);

  const model = opts.model || env.AI_MODEL || 'gpt-5-mini';
  const base = String(env.OPENAI_BASE_URL).replace(/\/+$/, '');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 55_000);

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
        messages,
        response_format: { type: 'json_object' },
        reasoning_effort: opts.reasoningEffort ?? 'low',
        ...(opts.maxTokens ? { max_completion_tokens: opts.maxTokens } : {}),
      }),
      signal: ctrl.signal,
    });
  } catch (e: any) {
    clearTimeout(timer);
    throw new LlmError(e?.name === 'AbortError' ? 'ai_timeout' : 'ai_network_error', 504);
  }
  clearTimeout(timer);

  const raw = await res.text();
  if (!res.ok) {
    throw new LlmError(`ai_upstream_${res.status}: ${raw.slice(0, 200)}`, res.status === 429 ? 429 : 502);
  }

  let env2: any;
  try {
    env2 = JSON.parse(raw);
  } catch {
    throw new LlmError('ai_bad_envelope');
  }
  const finishReason: string | undefined = env2?.choices?.[0]?.finish_reason;
  const content = env2?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    // 推論だけでトークンを使い切ると content が空になる（finish_reason=length）
    throw new LlmError(`ai_empty_response (finish_reason=${finishReason ?? 'unknown'})`);
  }

  let data: T;
  try {
    data = JSON.parse(content) as T;
  } catch {
    // ```json フェンス等が混ざった場合の救済。
    // 応答が途中で切れていると救済側の JSON.parse も失敗するため、
    // 必ず捕捉して LlmError に変換する（素の SyntaxError を漏らすと 500 になる）。
    const m = content.match(/\{[\s\S]*\}/);
    if (!m) throw new LlmError('ai_bad_json');
    try {
      data = JSON.parse(m[0]) as T;
    } catch {
      throw new LlmError(`ai_bad_json_truncated (finish_reason=${finishReason ?? 'unknown'})`);
    }
  }
  // JSON モードでも配列やプリミティブが返ることがあるため、オブジェクトを保証する
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new LlmError('ai_unexpected_shape');
  }
  return { data, usage: env2?.usage ?? null, model: env2?.model ?? model };
}

// ============================ メカニクス辞書 ============================
/**
 * 効果テキストからゲーム上の「動き」を抽出するための辞書。
 * value = そのメカニクスを示す代表的な語（DB内テキストに実在する表現のみ）
 */
export const MECHANIC_LEXICON: Record<string, string[]> = {
  '変身シフト': ['変身'],
  '歌・合唱': ['歌', '合唱', '歌声', 'アクションカード１枚を歌'],
  'インク加速': ['インクウェル', 'インクにできる', 'コストの支払いは'],
  'ドロー': ['カードを１枚引', 'カードを２枚引', 'カードを引'],
  '手札破棄': ['手札を', 'カードを１枚捨て', '捨てる'],
  'デッキ操作': ['デッキの上', 'デッキの一番上', 'デッキに戻'],
  'ロア加速': ['ロアを', 'クエストする', 'クエストするたび'],
  '除去・退場': ['退場させる', 'ダメージを与え'],
  'ダメージ回復': ['ダメージを', '取り除', '回復'],
  'バウンス': ['手札に戻', 'あなたの手札に'],
  'コスト軽減': ['支払いは', '減る'],
  'ステータス強化': ['を得る', '+１', '+２', '+３'],
  'ステータス弱体': ['-１', '-２', '-３'],
  'アイテム利用': ['アイテム'],
  'ロケーション利用': ['ロケーション'],
  'キャラクター参照': ['キャラクター１体を選び'],
  '墓地・捨て札利用': ['捨て札', '捨て札置き場'],
  'チャレンジ強化': ['チャレンジ'],
  '起動型能力': ['：'],
  '登場時能力': ['をプレイしたとき'],
  'ターン終了時': ['ターンの終わり', 'ターンの始め'],
};

/** 13の公式キーワード能力（scraper/keywords.mjs と同じ集合） */
export const KEYWORDS = [
  '警戒', '護衛', '果敢', '回避', '暴勇', '耐久', '突進',
  '変身', '歌声', '合唱', '支援', '霧消', '魔除',
];

/** 効果テキストから該当メカニクスタグを抽出 */
export function detectMechanics(text: string | null | undefined): string[] {
  if (!text) return [];
  const out: string[] = [];
  for (const [tag, terms] of Object.entries(MECHANIC_LEXICON)) {
    if (terms.some((t) => text.includes(t))) out.push(tag);
  }
  return out;
}

/** 効果テキスト中の《...》で括られたカード名参照を抽出（色指定タグは除外） */
export function extractQuotedNames(text: string | null | undefined): string[] {
  if (!text) return [];
  const out = new Set<string>();
  const re = /《([^》]{2,30})》/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const v = m[1].trim();
    if (/^c-/.test(v)) continue; // 《c-red》等のレンダリング指示
    out.add(v);
  }
  return [...out];
}

// ============================ 候補抽出（D1） ============================

const BRIEF_SELECT = `
  SELECT c.id, c.card_file, c.card_name, c.version, c.card_type, c.ink_color, c.ink_color2,
         c.rarity, c.inkwell, c.ink_cost, c.strength, c.willpower, c.lore_value, c.move_cost,
         c.rules_text, c.rules_text_plain, c.sets_name, c.image_url,
         (SELECT GROUP_CONCAT(cl.classification, '|') FROM classifications cl WHERE cl.card_id = c.id) AS classifications,
         (SELECT GROUP_CONCAT(ab.ability, '|')        FROM abilities ab       WHERE ab.card_id = c.id) AS abilities
    FROM cards c`;

export type Candidate = CardBrief & { _score: number; _why: string[] };

type Pool = Map<number, Candidate>;

function addToPool(pool: Pool, rows: any[], score: number, why: string) {
  for (const r of rows) {
    const id = Number(r.id);
    const cur = pool.get(id);
    if (cur) {
      cur._score += score;
      if (!cur._why.includes(why)) cur._why.push(why);
    } else {
      pool.set(id, { ...(r as CardBrief), _score: score, _why: [why] });
    }
  }
}

/** LIKE 用エスケープ（ESCAPE '\' 前提） */
function likeEsc(s: string): string {
  return s.replace(/([%_\\])/g, '\\$1');
}

export type RetrieveOptions = {
  /** 起点カード（あれば） */
  base?: Record<string, any> | null;
  /** 自由記述から抽出したキーワード群 */
  keywords?: string[];
  classifications?: string[];
  abilities?: string[];
  inkColors?: string[];
  cardTypes?: string[];
  /** インク色をこの2色に絞る（デッキ制約） */
  restrictInk?: string[];
  limit?: number;
  /**
   * 事前計算した意味ベクトルによる検索結果（card_id → 類似度）。
   * LIKE 一致は語が完全に一致しないと当たらないため、
   * 「アグロ」「使い回す」のような言い換えはここで拾う。
   */
  vectorHits?: Array<{ id: number; sim: number }>;
  /** 過去に高評価だったパートナー（記憶による加点） */
  memoryHits?: Array<{ partner_id: number; score: number; hits: number }>;
};

/**
 * 候補カードを D1 から抽出する。
 * 「LLMに渡す前に十分絞る」ことが目的なので、精度より網羅を優先し、
 * 最終的なスコア順で limit 件に切る。
 *
 * 各サブクエリの LIMIT は「プールが limit(=120) を下回らない」ように広めに取る。
 * 入力トークンを増やしても実測レイテンシはほぼ変わらないため（候補60枚→120枚で
 * 34.0s→32.6s）、ここを絞るメリットは薄く、逆に見落としの原因になる。
 */
export async function retrieveCandidates(db: D1Database, o: RetrieveOptions): Promise<Candidate[]> {
  const pool: Pool = new Map();
  const limit = o.limit ?? 120;
  const base = o.base ?? null;
  const baseId = base ? Number(base.id) : -1;

  const q = async (sql: string, binds: unknown[]) => {
    const r = await db.prepare(sql).bind(...binds).all();
    return (r.results ?? []) as any[];
  };

  const jobs: Promise<void>[] = [];
  const push = (p: Promise<any[]>, score: number, why: string) =>
    jobs.push(p.then((rows) => addToPool(pool, rows, score, why)));

  // ---------- 起点カードがある場合 ----------
  if (base) {
    const baseCls: string[] = String(base.classifications ?? '').split('|').filter(Boolean);
    const baseAb: string[] = String(base.abilities ?? '').split('|').filter(Boolean);
    const baseText: string = String(base.rules_text_plain ?? '');
    const baseName: string = String(base.card_name ?? '');

    // (1) このカードの名前を効果テキストで直接指名しているカード = 最強シナジー
    if (baseName) {
      push(
        q(`${BRIEF_SELECT} WHERE c.id <> ? AND c.rules_text_plain LIKE ? ESCAPE '\\' LIMIT 40`, [
          baseId, `%${likeEsc(baseName)}%`,
        ]),
        10,
        `効果テキストで「${baseName}」を直接指名`
      );
    }

    // (2) このカードが持つ種族を参照するカード
    if (baseCls.length) {
      push(
        q(
          `${BRIEF_SELECT} WHERE c.id <> ? AND c.id IN
             (SELECT card_id FROM card_refs WHERE classification IN (${baseCls.map(() => '?').join(',')}))
           ORDER BY c.sets_order DESC LIMIT 70`,
          [baseId, ...baseCls]
        ),
        6,
        `このカードの種族（${baseCls.join('・')}）を参照する効果を持つ`
      );
    }

    // (3) このカードが参照している種族を持つカード
    const refCls: string[] = [];
    {
      const r = await db
        .prepare('SELECT classification FROM card_refs WHERE card_id = ?')
        .bind(baseId)
        .all();
      for (const x of (r.results ?? []) as any[]) refCls.push(String(x.classification));
    }
    if (refCls.length) {
      push(
        q(
          `${BRIEF_SELECT} WHERE c.id <> ? AND c.id IN
             (SELECT card_id FROM classifications WHERE classification IN (${refCls.map(() => '?').join(',')}))
           ORDER BY c.sets_order DESC LIMIT 70`,
          [baseId, ...refCls]
        ),
        6,
        `このカードが参照する種族（${refCls.join('・')}）を持つ`
      );
    }

    // (4) 効果テキスト中の《カード名》参照
    for (const nm of extractQuotedNames(String(base.rules_text ?? '')).slice(0, 4)) {
      push(
        q(`${BRIEF_SELECT} WHERE c.id <> ? AND c.card_name LIKE ? ESCAPE '\\' LIMIT 12`, [
          baseId, `%${likeEsc(nm)}%`,
        ]),
        10,
        `このカードが名前で指名している「${nm}」`
      );
    }

    // (5) 同じキーワード能力を持つ / それを付与・参照するカード
    for (const ab of baseAb.slice(0, 6)) {
      push(
        q(
          `${BRIEF_SELECT} WHERE c.id <> ?
             AND (c.id IN (SELECT card_id FROM abilities WHERE ability = ?)
                  OR c.rules_text_plain LIKE ? ESCAPE '\\')
           ORDER BY c.sets_order DESC LIMIT 40`,
          [baseId, ab, `%${likeEsc(ab)}%`]
        ),
        3,
        `キーワード能力「${ab}」に関連`
      );
    }

    // (6) 同系メカニクス
    for (const tag of detectMechanics(baseText).slice(0, 8)) {
      const terms = MECHANIC_LEXICON[tag] ?? [];
      const t = terms.filter((x) => x.length >= 2).slice(0, 3);
      if (!t.length) continue;
      push(
        q(
          `${BRIEF_SELECT} WHERE c.id <> ? AND (${t.map(() => `c.rules_text_plain LIKE ? ESCAPE '\\'`).join(' OR ')})
           ORDER BY c.sets_order DESC LIMIT 30`,
          [baseId, ...t.map((x) => `%${likeEsc(x)}%`)]
        ),
        2,
        `同系メカニクス「${tag}」`
      );
    }
  }

  // ---------- 自由記述由来のキーワード ----------
  for (const kw of (o.keywords ?? []).slice(0, 12)) {
    const k = kw.trim();
    if (k.length < 2) continue;
    push(
      q(
        `${BRIEF_SELECT} WHERE (c.rules_text_plain LIKE ? ESCAPE '\\' OR c.ability_names LIKE ? ESCAPE '\\'
                                OR c.card_name LIKE ? ESCAPE '\\')
         ORDER BY c.sets_order DESC LIMIT 45`,
        [`%${likeEsc(k)}%`, `%${likeEsc(k)}%`, `%${likeEsc(k)}%`]
      ),
      4,
      `キーワード「${k}」に一致`
    );
  }

  for (const cl of (o.classifications ?? []).slice(0, 8)) {
    push(
      q(
        `${BRIEF_SELECT} WHERE c.id IN (SELECT card_id FROM classifications WHERE classification = ?)
         ORDER BY c.sets_order DESC LIMIT 45`,
        [cl]
      ),
      4,
      `種族「${cl}」を持つ`
    );
    push(
      q(
        `${BRIEF_SELECT} WHERE c.id IN (SELECT card_id FROM card_refs WHERE classification = ?)
         ORDER BY c.sets_order DESC LIMIT 35`,
        [cl]
      ),
      5,
      `種族「${cl}」を参照する`
    );
  }

  for (const ab of (o.abilities ?? []).slice(0, 8)) {
    push(
      q(
        `${BRIEF_SELECT} WHERE c.id IN (SELECT card_id FROM abilities WHERE ability = ?)
         ORDER BY c.sets_order DESC LIMIT 45`,
        [ab]
      ),
      4,
      `キーワード能力「${ab}」を持つ`
    );
  }

  // ---------- 意味ベクトルによる候補（事前計算済みの「記憶」を使う） ----------
  // LIKE では拾えない言い換えを補うため、類似度上位のカードをプールへ加える。
  // 類似度 0〜1 をそのままスコアに乗せる（最大 +5 程度になるよう倍率を掛ける）。
  const vh = (o.vectorHits ?? []).filter((h) => h.id !== baseId);
  if (vh.length) {
    const ids = vh.map((h) => h.id);
    const simOf = new Map(vh.map((h) => [h.id, h.sim]));
    // D1 の SQL 変数上限（約100）に触れないよう分割して取得する
    for (let i = 0; i < ids.length; i += 80) {
      const chunk = ids.slice(i, i + 80);
      const rows = await q(
        `${BRIEF_SELECT} WHERE c.id IN (${chunk.map(() => '?').join(',')})`,
        chunk
      );
      for (const r of rows) {
        const id = Number(r.id);
        const sim = simOf.get(id) ?? 0;
        // 類似度が低いものは足しても雑音になるため下限を設ける
        if (sim < 0.25) continue;
        addToPool(pool, [r], Math.min(sim * 6, 5), `意味的に近い（類似度 ${sim.toFixed(2)}）`);
      }
    }
  }

  await Promise.all(jobs);

  // ---------- 過去の検討結果による加点（記憶） ----------
  for (const m of o.memoryHits ?? []) {
    const cur = pool.get(m.partner_id);
    if (!cur) continue;
    // 何度も選ばれているペアほど確度が高いと見なす（最大 +3）
    cur._score += Math.min(1 + m.hits * 0.5, 3);
    const why = `過去に高評価（${m.score}点・${m.hits}回）`;
    if (!cur._why.includes(why)) cur._why.push(why);
  }

  // ---------- フィルタ・整列 ----------
  let list = [...pool.values()].filter((c) => c.id !== baseId);

  const restrict = (o.restrictInk ?? []).filter(Boolean);
  if (restrict.length) {
    list = list.filter(
      (c) => restrict.includes(String(c.ink_color)) || restrict.includes(String(c.ink_color2 ?? ''))
    );
  }
  if (o.cardTypes?.length) {
    list = list.filter((c) => o.cardTypes!.includes(String(c.card_type)));
  }
  if (o.inkColors?.length) {
    // ソフト加点（除外はしない）
    for (const c of list) {
      if (o.inkColors.includes(String(c.ink_color)) || o.inkColors.includes(String(c.ink_color2 ?? ''))) {
        c._score += 1;
      }
    }
  }
  // 起点と同じインク色は同居しやすいので微加点
  if (base) {
    const bi = [base.ink_color, base.ink_color2].filter(Boolean).map(String);
    for (const c of list) {
      if (bi.includes(String(c.ink_color)) || bi.includes(String(c.ink_color2 ?? ''))) c._score += 0.5;
    }
  }

  list.sort((a, b) => b._score - a._score || Number(b.id) - Number(a.id));

  // ---------- 不足分の補充（トークン枠が広がったので「空振り」を潰す） ----------
  // 自由記述の意図抽出が弱い語（例:「コントロ」「回す」）しか返さず、かつ
  // card_types / restrictInk のハードフィルタが効くと候補0件になることがあった。
  // 指定された色・種類・種族に合致するカードで limit まで機械的に埋める。
  if (list.length < limit) {
    const have = new Set(list.map((c) => Number(c.id)));
    const inks = restrict.length ? restrict : (o.inkColors ?? []).filter(Boolean);
    const cls = (o.classifications ?? []).filter(Boolean).slice(0, 8);
    const types = (o.cardTypes ?? []).filter(Boolean);

    // 意図抽出は「キャラクター」を種族として返すなど揺らぐため、
    // 条件を厳しい順に試し、埋まらなければ段階的に緩める。
    const passes: Array<{ cls: string[]; types: string[]; inks: string[]; why: string }> = [
      { cls, types, inks, why: '指定条件（色／種類／種族）に合致' },
      { cls: [], types, inks, why: '指定条件（色／カード種類）に合致' },
      { cls: [], types: [], inks, why: '指定インク色に合致' },
    ];
    // インク色を2色に固定している場合、その制約を破る補充はしない
    if (!restrict.length) passes.push({ cls: [], types: [], inks: [], why: '同カテゴリからの補充' });

    for (const p of passes) {
      if (list.length >= limit) break;
      const where: string[] = ['c.id <> ?', `COALESCE(c.rules_text_plain, '') <> ''`];
      const binds: unknown[] = [baseId];
      if (p.inks.length) {
        where.push(`(${p.inks.map(() => '(c.ink_color = ? OR c.ink_color2 = ?)').join(' OR ')})`);
        for (const i of p.inks) binds.push(i, i);
      }
      if (p.types.length) {
        where.push(`c.card_type IN (${p.types.map(() => '?').join(',')})`);
        binds.push(...p.types);
      }
      if (p.cls.length) {
        where.push(
          `c.id IN (SELECT card_id FROM classifications WHERE classification IN (${p.cls
            .map(() => '?')
            .join(',')}))`
        );
        binds.push(...p.cls);
      }

      const need = limit - list.length;
      const rows = await q(
        `${BRIEF_SELECT} WHERE ${where.join(' AND ')}
         ORDER BY c.sets_order DESC, c.ink_cost ASC LIMIT ?`,
        [...binds, need * 3 + 30]
      );
      for (const r of rows) {
        const id = Number(r.id);
        if (have.has(id)) continue;
        have.add(id);
        list.push({ ...(r as CardBrief), _score: 0.1, _why: [p.why] });
        if (list.length >= limit) break;
      }
    }
  }

  return list.slice(0, limit);
}

// ============================ ルール抜粋（RAG） ============================

/**
 * rules_sections の heading / body を1本の条文テキストへ復元する。
 *
 * ⚠ 重要: このテーブルの heading は「見出し」ではなく **本文の先頭約45文字** で、
 * body はその続きである。例）8.8.1
 *   heading: "突進は常在能力である。突進は「このキャラクターは、これがあなたのターンの始めから場にいたか"
 *   body   : "のようにチャレンジできる。」という能力である。"
 * したがって `heading] body` のように区切って連結すると文が途中で分断され、
 * LLM が「抜粋が途切れている」と判断して推論を放棄する（精度低下の直接原因だった）。
 * 必ず区切りなしで連結する。
 */
export function ruleFullText(r: Record<string, any>): string {
  const head = String(r.heading ?? '');
  const body = String(r.body ?? '');
  return `${head}${body}`.replace(/\s+/g, ' ').replace(/©Disney.*$/, '').trim();
}

/**
 * 候補・起点カードに登場するキーワード能力に対応する総合ルールの本文を取得。
 * これを LLM に与えることでルール解釈のブレを抑える。
 * ※ ユーザーには返さない（§8: 全文公開はしない）。あくまで推論の根拠。
 */
export async function fetchRuleContext(db: D1Database, terms: string[]): Promise<string[]> {
  // 対象キーワードを 6→10 個、取得節を 12→24 節、本文を 400→900 字に拡大。
  // キーワード能力の裁定はロルカナのシナジー判断の中核であり、
  // ここを削ると「そのターンだけ」「チャレンジ中のみ」等の条件を読み落とす。
  const uniq = [...new Set(terms.filter((t) => KEYWORDS.includes(t)))].slice(0, 10);
  if (!uniq.length) return [];

  const rows = await db
    .prepare(
      // heading は本文前半・body は本文後半なので両方を検索対象にする
      // （heading だけ見ると、語が45文字目以降に出てくる条文を取りこぼす）
      `SELECT section, heading, body FROM rules_sections
        WHERE source = 'comprehensive'
          AND (${uniq.map(() => '(heading LIKE ? OR body LIKE ?)').join(' OR ')})
        ORDER BY CAST(section AS REAL) LIMIT 24`
    )
    .bind(...uniq.flatMap((t) => [`%${t}%`, `%${t}%`]))
    .all();

  return ((rows.results ?? []) as any[]).map(
    (r) => `[総合ルール ${r.section}] ${ruleFullText(r).slice(0, 900)}`
  );
}

// ============================ プロンプト構築 ============================

function briefLine(c: Candidate): string {
  const cls = String(c.classifications ?? '').split('|').filter(Boolean).join('・');
  const ab = String(c.abilities ?? '').split('|').filter(Boolean).join('・');
  const ink = [c.ink_color, c.ink_color2].filter(Boolean).join('/');
  const stats = [
    c.ink_cost != null ? `コスト${c.ink_cost}` : '',
    c.strength != null ? `攻${c.strength}` : '',
    c.willpower != null ? `willpower${c.willpower}`.replace('willpower', '意') : '',
    c.lore_value != null ? `ロア${c.lore_value}` : '',
    c.move_cost != null ? `移動${c.move_cost}` : '',
  ]
    .filter(Boolean)
    .join(' ');
  // 効果テキストは190→320字に拡大。長文カードの後半（追加の誘発条件など）が
  // 切り落とされて誤判断につながるのを防ぐ。
  const text = String(c.rules_text_plain ?? '').replace(/\s+/g, ' ').slice(0, 320);
  return [
    `#${c.id}`,
    `${c.card_name}${c.version ? `／${c.version}` : ''}`,
    `[${ink}|${c.card_type}|${stats}]`,
    cls ? `種族:${cls}` : '',
    ab ? `KW:${ab}` : '',
    text ? `効果:${text}` : '効果:なし',
  ]
    .filter(Boolean)
    .join(' ');
}

export const SYSTEM_PROMPT = `あなたはトレーディングカードゲーム「ディズニー・ロルカナ（日本語版）」のデッキ構築アドバイザーです。

## 厳守事項
1. 提示された「候補カード一覧」に含まれる #ID のカードだけを選ぶ。一覧に無いカードを創作してはならない。
2. 判断根拠は、提示された効果テキストと「公式ルール抜粋」のみ。曖昧な場合は断定せず「〜と思われる」等と書く。
3. reason は日本語で、その2枚（または起点条件）が具体的にどう噛み合うかを1〜2文で説明する。
   悪い例:「強いカードです」 良い例:「起点の〈支援〉で攻撃力を渡す先として、耐久を持つこのキャラが場に残りやすい」
4. score は 0〜100 の整数。実際に一緒に使う価値がある度合い。無理のある組み合わせは低く付ける。
5. 種族・キーワード名を書くときは効果テキストに現れる正式表記を使う。
6. 出力は指定した JSON のみ。前後に文章を付けない。

## 出力JSONスキーマ
{
  "summary": "全体の狙い・デッキの方向性を2〜4文で",
  "axes": ["この組み合わせ群を貫くテーマ（例: 変身コスト軽減）", "..."],
  "picks": [
    { "id": 123, "score": 88, "role": "そのカードの役割を10文字前後で（例: 除去、ロア加速、コスト軽減）", "reason": "..." }
  ],
  "caveats": ["注意点やルール上の制約（無ければ空配列）"]
}`;

export function buildUserPrompt(args: {
  base?: Record<string, any> | null;
  freeText?: string;
  candidates: Candidate[];
  ruleContext: string[];
  wanted: number;
  restrictInk?: string[];
  /** 事前要約済みのキーワード能力知識（毎回の条文RAGを置き換える固定知識） */
  abilityKnowledge?: Array<{
    ability: string;
    summary: string;
    synergy_notes: string[];
    caveats: string[];
  }>;
  /** 過去に高評価だったシナジー事例（記憶の再利用） */
  memoryNotes?: string[];
}): string {
  const parts: string[] = [];

  if (args.base) {
    const b = args.base;
    const cls = String(b.classifications ?? '').split('|').filter(Boolean).join('・');
    const ab = String(b.abilities ?? '').split('|').filter(Boolean).join('・');
    parts.push(
      `## 起点カード
名前: ${b.card_name}${b.version ? `／${b.version}` : ''}
種類: ${b.card_type} / インク: ${[b.ink_color, b.ink_color2].filter(Boolean).join('/')} / コスト: ${b.ink_cost ?? '-'}
攻撃力: ${b.strength ?? '-'} / 意志力: ${b.willpower ?? '-'} / ロア: ${b.lore_value ?? '-'}
種族: ${cls || 'なし'} / キーワード能力: ${ab || 'なし'}
効果テキスト: ${String(b.rules_text_plain ?? 'なし').replace(/\s+/g, ' ')}`
    );
  }

  if (args.freeText) {
    parts.push(`## ユーザーの要望（自由記述）\n${args.freeText.slice(0, 600)}`);
  }

  if (args.restrictInk?.length) {
    parts.push(`## インク色の制約\n候補は ${args.restrictInk.join(' / ')} に限定済み（ロルカナは1デッキ2色まで）。`);
  }

  // 事前に噛み砕いた知識を先に置く。条文の生文より短く、かつ要点が整理されているため、
  // 同じトークン量でより多くの「判断に効く情報」を渡せる。
  if (args.abilityKnowledge?.length) {
    const blocks = args.abilityKnowledge.map((k) => {
      const lines = [`【${k.ability}】${k.summary}`];
      if (k.synergy_notes.length) lines.push(`  噛み合い: ${k.synergy_notes.join(' / ')}`);
      if (k.caveats.length) lines.push(`  注意: ${k.caveats.join(' / ')}`);
      return lines.join('\n');
    });
    parts.push(
      `## キーワード能力の裁定（公式総合ルールから事前に整理済み。これを正として扱う）\n${blocks.join('\n')}`
    );
  }

  if (args.ruleContext.length) {
    parts.push(`## 公式ルール抜粋（判断根拠。そのまま引用せず解釈に使う）\n${args.ruleContext.join('\n')}`);
  }

  if (args.memoryNotes?.length) {
    parts.push(
      `## 過去の検討結果（同条件で以前に高評価だった組み合わせ。妥当なら再評価し、誤りと判断すれば採用しなくてよい）\n${args.memoryNotes.join('\n')}`
    );
  }

  parts.push(
    `## 候補カード一覧（この中からのみ選ぶ / 全 ${args.candidates.length} 件）\n` +
      args.candidates.map(briefLine).join('\n')
  );

  parts.push(
    `## 指示
上記の候補から、${args.base ? '起点カードと' : 'ユーザーの要望に対して'}最もシナジーが強い順に最大 ${args.wanted} 枚を選び、JSONで返してください。
スコアが低い（実用性が薄い）ものは無理に埋めず、自信のある枚数だけ返してください。`
  );

  return parts.join('\n\n');
}

/** 自由記述 → 構造化された検索意図（候補抽出のための第1段 LLM 呼び出し） */
export const INTENT_SYSTEM_PROMPT = `あなたは「ディズニー・ロルカナ（日本語版）」のカード検索クエリ変換器です。
ユーザーの日本語の要望を、カードDB検索に使えるキーワードへ分解してください。

## 制約
- keywords は日本語カードテキストに実際に現れそうな短い語（2〜8文字）にする。例: 変身, 護衛, ダメージを与え, カードを引, 手札に戻, 支払いは
- classifications は次のリストに完全一致する語のみ（このDBに実在する種族の全リスト）:
  ストーリーボーン, ヒーロー, 仲間, ドリームボーン, ヴィランズ, フラッドボーン, プリンセス, 魔法使い, 歌, プリンス, 女王, 導き手, 海賊, 発明家, エイリアン, 王様, キャプテン, マドリガル家, スーパー, 探偵, 神格, トイ, チーム, レーサー, 妖精, モンスター, ７人のこびと, ハニー, 騎士, ドラゴン, ヴァインリング, 子犬, ロボット, レッサーパンダ, 銃士, ほうき, イリュージョン, ハイエナ, タイタン, ティガー, 恐竜, 巨人
  リストに無い語は絶対に書かない。該当が無ければ空配列。
- abilities は次の13個からのみ選ぶ: 警戒, 護衛, 果敢, 回避, 暴勇, 耐久, 突進, 変身, 歌声, 合唱, 支援, 霧消, 魔除
- ink_colors は次からのみ: アンバー, アメジスト, エメラルド, ルビー, サファイア, スティール
- card_types は次からのみ: キャラクター, アクション, アイテム, ロケーション
- 該当しない項目は空配列にする。埋めるために無関係な語を入れない。

## 出力JSON
{ "keywords": [], "classifications": [], "abilities": [], "ink_colors": [], "card_types": [], "intent": "要望の要約1文" }`;

export type Intent = {
  keywords?: string[];
  classifications?: string[];
  abilities?: string[];
  ink_colors?: string[];
  card_types?: string[];
  intent?: string;
};

export type RankResult = {
  summary?: string;
  axes?: string[];
  picks?: { id: number; score?: number; role?: string; reason?: string }[];
  caveats?: string[];
};
