-- 0008: TopDeck.gg を「クレジット表示付きの例外ソース」として採用
--
-- 【背景】
--   TopDeck.gg API は無料だが利用条件に "Attribution Required
--   （any project using the API must include a visible credit and link back）" がある。
--   これは仕様§1.3「非公式ソースは表示上ソースを明記しない」と衝突する。
--
-- 【ユーザー判断】
--   デッキレシピ欄と同様に §1.3 の例外として扱い、可視クレジットを表示して採用する。
--
-- 【実装上の扱い】
--   requires_credit=1 のソースは、サニタイザ（scrubText）が名称を削除する対象から外し、
--   フロントの所定位置に「Data provided by TopDeck.gg」のクレジットを常時表示する。
--   ただし要約本文への混入は避け、クレジットは専用の帰属表示欄に出す。
--   → まとめ本文の文体は§1.3のまま保ち、規約は帰属表示欄で満たす、という分離。

ALTER TABLE meta_sources ADD COLUMN requires_credit INTEGER DEFAULT 0;
ALTER TABLE meta_sources ADD COLUMN credit_label TEXT;
ALTER TABLE meta_sources ADD COLUMN credit_url TEXT;

-- 有効化し、クレジット情報を設定する。
-- TOPDECK_API_KEY が未設定なら収集はスキップされる（X と同じ扱い）
UPDATE meta_sources
   SET enabled = 1,
       url = 'https://topdeck.gg/api/v2/tournaments',
       method = 'topdeck_api',
       kind = 'event',
       trust = 4,
       requires_secret = 'TOPDECK_API_KEY',
       requires_credit = 1,
       credit_label = 'TopDeck.gg',
       credit_url = 'https://topdeck.gg',
       note = 'Attribution Required。ユーザー判断により§1.3の例外として可視クレジットを表示して採用。game=Lorcana / format=Core Constructed。APIキー未設定時はスキップ',
       updated_at = datetime('now')
 WHERE key = 'topdeck_gg';
