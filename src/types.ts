/** AI（OpenAI互換）用の環境変数。フロントには絶対に露出させない */
export type AiEnv = {
  OPENAI_API_KEY?: string;
  OPENAI_BASE_URL?: string;
  /** シナジー順位付け・理由生成に使うモデル */
  AI_MODEL?: string;
  /** 自由記述→検索語の変換に使う軽量モデル */
  AI_MODEL_FAST?: string;
  /** 記憶層の構築（ベクトル化等）を許可する管理トークン。本番では必須 */
  ADMIN_TOKEN?: string;
};

export type Bindings = AiEnv & {
  DB: D1Database;
};

/** AIプロンプト／レスポンスで使うカードの要約表現 */
export type CardBrief = {
  id: number;
  card_file: string;
  card_name: string;
  version: string | null;
  card_type: string;
  ink_color: string;
  ink_color2: string | null;
  rarity: string;
  inkwell: string;
  ink_cost: number | null;
  strength: number | null;
  willpower: number | null;
  lore_value: number | null;
  move_cost: number | null;
  rules_text: string | null;
  rules_text_plain: string | null;
  sets_name: string | null;
  image_url: string;
  /** GROUP_CONCAT の '|' 区切り生値 */
  classifications?: string | null;
  abilities?: string | null;
};

export type CardRow = {
  id: number;
  card_file: string;
  collector_number: number | null;
  card_name: string;
  version: string | null;
  card_group: string | null;
  card_type: string;
  ink_color: string;
  ink_color2: string | null;
  primary_ink_color: string | null;
  ink_type: string | null;
  rarity: string;
  inkwell: string;
  ink_cost: number | null;
  strength: number | null;
  willpower: number | null;
  move_cost: number | null;
  lore_value: number | null;
  rules_text: string | null;
  rules_text_plain: string | null;
  ability_names: string | null;
  flavor_text: string | null;
  sets_name: string | null;
  sets_order: number | null;
  release_date: number | null;
  artist_credit1: string | null;
  artist_credit2: string | null;
  limit_card: number | null;
  image_url: string;
  classifications?: string[];
  abilities?: string[];
};

export type SearchParams = {
  freeword?: string;
  freeword_field?: string[];
  ink_type?: string;
  ink_color?: string[];
  card_type?: string[];
  classification?: string[];
  classification_mode?: 'and' | 'or';
  rarity?: string[];
  ability?: string[];
  sets?: string[];
  inkwell?: string[];
  ink_cost_min?: number;
  ink_cost_max?: number;
  strength_min?: number;
  strength_max?: number;
  willpower_min?: number;
  willpower_max?: number;
  lore_value_min?: number;
  lore_value_max?: number;
  move_cost_min?: number;
  move_cost_max?: number;
  /** 効果テキスト内で指定種族を参照するカードのみ（シナジー逆引き） */
  refs_classification?: string[];
  search_sort?: string;
  posts_per_page?: number;
  page?: number;
};

export const ALL = 'すべて';

export const SORT_MAP: Record<string, string> = {
  'リリース順': 'c.sets_order DESC, c.collector_number ASC',
  'カードナンバー（昇順）': 'c.collector_number ASC, c.sets_order DESC',
  'カードナンバー（降順）': 'c.collector_number DESC, c.sets_order DESC',
  'インクコスト順（昇順）': 'c.ink_cost ASC, c.sets_order DESC, c.collector_number ASC',
  'インクコスト順（降順）': 'c.ink_cost DESC, c.sets_order DESC, c.collector_number ASC',
  '攻撃力順（昇順）': 'c.strength ASC, c.sets_order DESC, c.collector_number ASC',
  '攻撃力順（降順）': 'c.strength DESC, c.sets_order DESC, c.collector_number ASC',
  '意志力順（昇順）': 'c.willpower ASC, c.sets_order DESC, c.collector_number ASC',
  '意志力順（降順）': 'c.willpower DESC, c.sets_order DESC, c.collector_number ASC',
};

/** freeword_field 名 → 検索対象カラム */
export const FREEWORD_COLUMNS: Record<string, string[]> = {
  'カード名': ['c.card_name', 'c.search_card_name'],
  'バージョン名': ['c.version'],
  '読み': ['c.rubi'],
  'クラス': ['cls_blob.classes'],
  'テキスト': ['c.rules_text_plain', 'c.ability_names'],
  'フレーバー': ['c.flavor_text'],
  'イラストレーター': ['c.artist_credit1', 'c.artist_credit2'],
};
