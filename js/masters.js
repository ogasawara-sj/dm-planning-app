// masters.js v2 — 選択肢マスタと業務ルール
// 出典：案件共有シート「プルダウン」「素材コード管理表」、リスト定義書8本の精読、企画サマリー実データ

window.MASTERS = {
  // 担当の初期候補（公開版は空。アプリ内で手入力すると各端末に保存され、以後は候補に出る）
  owners: [],
  kinds: ["RO", "テスト"],
  listMethods: ["AI", "既ロ"],
  deliveryTypes: ["メール便のみ", "郵便のみ", "郵便+メール便"],
  genders: ["不問", "男性", "女性"],
  fValues: ["F1", "F2以上"],
  ages: ["40代", "50代", "60代", "70代", "80代", "不明"],

  // 掲載商品コード（自由追加可）
  products: ["RAH", "RASA", "RAHK", "RATV", "RAHK2", "SOY", "ORS", "TRR3", "TRAF", "TRAFS", "TRSP",
    "MQT", "CCH8", "CCHT3", "CCHF", "INV1", "INV2", "INV3", "INVA", "ACTM", "TRPRB"],

  // 施策カテゴリ → 素材コード接頭辞（素材コード管理表ヘッダ由来）
  categories: [
    { key: "DMA", label: "TRSシリーズDM", prefix: "DMA" },
    { key: "DMB", label: "お誕生日DM", prefix: "DMB" },
    { key: "DMC", label: "TRS下取り／買替DM", prefix: "DMC" },
    { key: "DMD", label: "発送カタログ", prefix: "DMD" },
    { key: "DME", label: "複数掲載・キャンペーンDM", prefix: "DME" },
    { key: "DMF", label: "その他DM", prefix: "DMF" },
    { key: "CTA", label: "同梱カタログ", prefix: "CTA" },
    { key: "CTB", label: "TRS同梱チラシ", prefix: "CTB" },
    { key: "CTC", label: "その他チラシ", prefix: "CTC" },
  ],

  mediaTypes: ["発送DM", "同梱チラシ", "同梱カタログ", "同梱レター", "発送カタログ", "発送チラシ", "同梱その他", "ダミー"],

  // リスト条件：商品グループのプリセット（グループ名→グループコード群）
  productGroups: [
    { name: "RAH", codes: ["RAH"] },
    { name: "TRSマットレス", codes: ["TRCS","TRCF","TRSP","TRCE","TRCP","TRCM","TRNE","TRWE","TRSE","TRSL","TRPR","TRSC","TRPM","TRAF","TRR2","TRAFS","TRPA","TR2A","TRR3"] },
    { name: "SOY", codes: ["SOY"] },
    { name: "ORS", codes: ["ORS"] },
    { name: "CCH", codes: ["CCH8","CCHT3","CCHF"] },
  ],

  // D 配達完了経過：D番号→経過日数(from)。精読サンプル由来（D4〜D6は推定・後で調整可）
  dDays: { 1: 365, 2: 550, 3: 730, 4: 1095, 5: 1460, 6: 1825, 7: 2554, 8: 2919 },

  // 除外条件（共通・ほぼ常時ON）
  exclCommon: [
    { key: "koteiFutsu", label: "固定電話不通除外", auto: false },
    { key: "aiyousha", label: "愛用者架電PIN除外", auto: false },
    { key: "hbw", label: "HBW購入者除外", auto: false },
    { key: "nonstore", label: "ノンストア(tv mp)除外", auto: false },
    { key: "namae", label: "名前不備除外", auto: false },
    { key: "tougetsuPin", label: "当月発送PIN除外", auto: true },   // 素材コードから自動生成
    { key: "zengetsuPin", label: "前月発送PIN除外", auto: true },   // モードは別途（全て/お誕生日除く）
  ],

  // 前月発送PINの除外モード
  zengetsuModes: ["全て", "お誕生日DM以外"],

  // 除外条件（施策別）
  exclPerMeasure: [
    { key: "yahoo", label: "yahoo注文経路除外" },
    { key: "yokugetsuBirth", label: "翌月お誕生月除外" },
    { key: "yokuyokuBirth", label: "翌々月お誕生月除外(WOW用)" },
    { key: "henpin", label: "商品シリーズ返品除外" },
    { key: "cancel", label: "商品シリーズ キャンセル除外" },
    { key: "wow", label: "WOWセール購入PIN除外" },
    { key: "mailArea", label: "メール便可能地域(一都三県)除外" },
    { key: "outbp60", label: "OUT-BP60(お試し購入)除外" },
  ],

  sections: [
    { key: "active", label: "今月実施（施策）" },
    { key: "carryNext", label: "次月持越し" },
    { key: "carryFuture", label: "今後へ持越し" },
    { key: "ideas", label: "アイデア候補" },
  ],
};

window.prefixOfCategory = function (key) {
  const c = window.MASTERS.categories.find(x => x.key === key);
  return c ? c.prefix : "";
};
window.buildMaterialCode = function (prefix, num) {
  if (!prefix || num === "" || num == null) return "";
  return prefix + String(parseInt(num, 10)).padStart(7, "0");
};
window.buildMaterialShort = function (prefix, num) {
  if (!prefix || num === "" || num == null) return "";
  return prefix + String(parseInt(num, 10));
};
// 正式名。confirmed=false のときはコード部分を「未確定」に。
window.buildFullName = function ({ month, baseName, media, variant, prefix, num, confirmed }) {
  const yymm = (month || "").slice(2);
  const parts = [yymm, baseName, media, variant].filter(Boolean);
  const code = confirmed ? window.buildMaterialShort(prefix, num) : "未確定";
  parts.push(code);
  return parts.join("_");
};
window.isValidMonth = m => /^\d{6}$/.test(m || "");
window.monthLabel = m => window.isValidMonth(m) ? `${m.slice(0,4)}年${parseInt(m.slice(4),10)}月` : (m || "");
