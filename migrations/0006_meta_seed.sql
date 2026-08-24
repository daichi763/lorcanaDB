-- 0006_meta_seed.sql — 仕様§7「現在（2026年8月24日時点）の環境コンテキスト」の初期投入
--
-- 収集が1回も走っていない状態でもフロントが成立するように、
-- ユーザー指定の既知情報を初期データとして入れる。
-- observed_at は「その情報の日付」であり、収集日時（fetched_at）とは別物。

-- ============================ 大会・イベント ============================
INSERT OR IGNORE INTO meta_events
  (event_key,name,region,scale,held_on,season,is_official,is_upcoming,note,observed_at) VALUES
  ('jp:japan-championship:2026-08-15','日本一決定戦2026','jp','national','2026-08-15',
   'attack-of-the-vine',1,0,'優勝はルビー/サファイア アイテムズ','2026-08-16'),
  ('jp:challenge-autumn-kobe:2026-09-06','チャレンジ2026 Autumn 神戸','jp','challenge','2026-09-06',
   'attack-of-the-vine',1,1,NULL,'2026-08-24'),
  ('jp:trio-quest:2026-10-03','トリオクエスト','jp','other','2026-10-03',
   'attack-of-the-vine',1,1,NULL,'2026-08-24'),
  ('jp:set-release-hyperion:2026-10-16','ハイペリアシティ 発売','jp','other','2026-10-16',
   'hyperion-city',1,1,'新能力「ブースト」導入','2026-08-24'),
  ('jp:ccq-osaka-w1:2026-10-31','CCQ大阪 WAVE-1','jp','set_championship','2026-10-31',
   'hyperion-city',1,1,NULL,'2026-08-24'),
  ('jp:ccq-osaka-w2:2026-11-01','CCQ大阪 WAVE-2','jp','set_championship','2026-11-01',
   'hyperion-city',1,1,NULL,'2026-08-24');

-- ============================ メタシェア（初期値） ============================
-- 自前集計（meta_decks 由来）が溜まるまでの初期表示用。
-- deck_count=0 は「母数を自前で持っていない外部由来の値」であることを示す。
INSERT INTO meta_snapshots
  (region,window_from,window_to,kind,label,deck_count,weighted,share,rank,detail) VALUES
  ('jp','2026-07-17','2026-08-24','ink_pair','アンバー/エメラルド',0,0,28.0,1,'{"source":"initial_seed"}'),
  ('jp','2026-07-17','2026-08-24','ink_pair','アンバー/スティール',0,0,21.0,2,'{"source":"initial_seed"}'),
  ('jp','2026-07-17','2026-08-24','ink_pair','エメラルド/スティール',0,0,19.0,3,'{"source":"initial_seed"}'),
  ('en','2026-07-17','2026-08-24','ink_pair','アンバー/アメジスト',0,0,17.0,1,'{"source":"initial_seed","archetype":"Midrange"}'),
  ('en','2026-07-17','2026-08-24','ink_pair','アンバー/エメラルド',0,0,16.0,2,'{"source":"initial_seed","archetype":"Elinor"}'),
  ('en','2026-07-17','2026-08-24','ink_pair','アンバー/ルビー',0,0,9.0,3,'{"source":"initial_seed","archetype":"Boost"}');

-- ============================ 記憶層（AIが参照する環境知識） ============================
-- text_hash は差分判定用。初期データは固定文字列で一意にする。
INSERT OR IGNORE INTO meta_knowledge
  (scope,title,body,observed_at,season,region,trust,official_url,text_hash) VALUES
  ('news','現行セット: Attack of the Vine!／ヴァインズ・アタック！',
   '2026年7月17日発売のSet 13。2026年8月時点の日本・海外ともにこのセットが現行環境である。',
   '2026-07-17','attack-of-the-vine','jp',5,NULL,'seed:set13'),
  ('news','次期セット: ハイペリアシティ',
   '2026年10月16日発売予定。新能力「ブースト」が導入される。発売以降は環境が大きく変わる見込みである。',
   '2026-08-24','hyperion-city','jp',5,NULL,'seed:set14'),
  ('event','日本一決定戦2026の結果',
   '2026年8月15日から16日に開催。優勝はルビー/サファイアのアイテムズ軸であった。',
   '2026-08-16','attack-of-the-vine','jp',5,NULL,'seed:jp-champ-2026'),
  ('jp_meta','日本のメタシェア（2026年8月時点）',
   'アンバー/エメラルドが約28%で最多。次にアンバー/スティールが約21%、エメラルド/スティールが約19%。アンバーを含む構築が上位を占める傾向がある。',
   '2026-08-24','attack-of-the-vine','jp',4,NULL,'seed:jp-meta-2026-08'),
  ('en_meta','海外のメタシェア（2026年8月時点）',
   'アンバー/アメジストのミッドレンジが約17%、アンバー/エメラルドのエリノール軸が約16%、アンバー/ルビーのブースト軸が8〜10%。日本と同様にアンバーが中心だが、アメジストの採用率は日本より高い。',
   '2026-08-24','attack-of-the-vine','en',4,NULL,'seed:en-meta-2026-08'),
  ('event','2026年秋の主要イベント日程',
   'チャレンジ2026 Autumn 神戸が9月6日、トリオクエストが10月3日、ハイペリアシティ発売が10月16日、CCQ大阪WAVE-1が10月31日、WAVE-2が11月1日である。',
   '2026-08-24','attack-of-the-vine','jp',5,NULL,'seed:jp-events-2026-autumn');
