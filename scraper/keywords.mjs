/**
 * keywords.mjs — 公式キーワード能力の辞書
 *
 * 出典: 総合ルール（日本語版）第8章「キーワード能力」の見出し・本文から抽出。
 * 検索APIの `ability[]` 選択肢は動的生成でHTMLから取得できなかったため、
 * 公式ルール文書に定義されたキーワード能力名を正規リストとして採用し、
 * カードの rules_text と突合して abilities テーブルを構築する。
 *
 * `numeric: true` のものは「果敢+2」「歌声 5」のように数値を伴う。
 */
export const KEYWORD_ABILITIES = [
  { name: "警戒",   numeric: false, section: "8.2",  desc: "チャレンジする際に回避の制限を無視する" },
  { name: "護衛",   numeric: false, section: "8.3",  desc: "エグザートで場に出る／対戦相手のチャレンジを制限する" },
  { name: "果敢",   numeric: true,  section: "8.4",  desc: "チャレンジしている間、攻撃力が上がる" },
  { name: "回避",   numeric: false, section: "8.5",  desc: "回避を持たないキャラクターからチャレンジされない" },
  { name: "暴勇",   numeric: false, section: "8.6",  desc: "エグザートで場に出る／可能ならチャレンジしなければならない" },
  { name: "耐久",   numeric: true,  section: "8.7",  desc: "与えられるダメージを軽減する" },
  { name: "突進",   numeric: false, section: "8.8",  desc: "場に出たターンからチャレンジできる" },
  { name: "変身",   numeric: false, section: "8.9",  desc: "インク・コストの代わりに代替コストで場に出す" },
  { name: "歌声",   numeric: true,  section: "8.10", desc: "歌・カードを歌う際のコストとして扱う" },
  { name: "合唱",   numeric: false, section: "8.11", desc: "複数キャラクターの合計コストで歌を歌える" },
  { name: "支援",   numeric: false, section: "8.12", desc: "エグザートしたとき、他のキャラクターの攻撃力を上げる" },
  { name: "霧消",   numeric: false, section: "8.13", desc: "アクションでバニッシュされたとき誘発する" },
  { name: "魔除",   numeric: false, section: "8.14", desc: "対戦相手は効果の対象に選べない" },
];

/** 変身の亜種（8.9.8） */
export const SHIFT_VARIANTS = [
  "だれでも変身", "おふたり変身", "まとめて変身", "かりそめ変身", "ポテト変身",
];

/**
 * rules_text からキーワード能力を検出する。
 *
 * @param rulesText  カードの rules_text（プレースホルダ生のまま可）
 * @param classSet   クラス（種族）名の集合。「[クラス]変身」判定に使う。
 *
 * 実データ観察: キーワード能力は太字マーカー `<...>` / `&lt;...&gt;` で囲まれて出現する。
 *   例) "<子犬変身>３（…）%<護衛>（…）"、"<果敢>+２"、"<歌声>５"
 * 一方 `\...\` は「性能をアップ」のようなカード固有の能力名なので、混同しない。
 * これにより「〜を変身させる」等の一般動詞を能力として誤検出しない。
 */
export function detectKeywords(rulesText, classSet = null) {
  if (!rulesText) return [];
  const found = new Set();
  const text = String(rulesText).replace(/&lt;/g, "<").replace(/&gt;/g, ">");

  // 太字マーカー <...> 内のテキスト = キーワード能力の出現位置
  const markers = [...text.matchAll(/<([^<>]{1,40})>/g)].map((m) => m[1].trim());

  for (const marker of markers) {
    // 基本キーワード（完全一致 or 数値を伴う形）
    for (const kw of KEYWORD_ABILITIES) {
      if (marker === kw.name || new RegExp(`^${kw.name}\\s*[+＋]?\\s*[0-9０-９]*$`).test(marker)) {
        found.add(kw.name);
      }
    }
    // 変身の亜種（8.9.8）: だれでも変身 / おふたり変身 / まとめて変身 / かりそめ変身 / ポテト変身
    for (const v of SHIFT_VARIANTS) {
      if (marker === v || marker.startsWith(v)) {
        found.add(v);
        found.add("変身");
      }
    }
    // 「[クラス]変身」（例: 子犬変身、マドリガル家変身）— クラスマスタと突合
    if (classSet && marker.endsWith("変身")) {
      const prefix = marker.slice(0, -2);
      if (classSet.has(prefix)) {
        found.add(marker);
        found.add("変身");
      }
    }
  }

  // 歌・カードの「歌える」表記（キーワードではないが公式検索の絞込対象）
  if (/歌える/.test(text)) found.add("歌える");

  return [...found];
}
