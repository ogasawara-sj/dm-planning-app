// estimate.js — 見積もり依頼Excel（.xlsm）の生成
// テンプレート（estimate-template-b64.js に埋め込み）は書式・数式・マクロ・参考価格表を保持したまま、
// xl/worksheets/sheet1.xml の該当セルだけを文字列置換で書き換える（他は完全に元のまま）。
// 依存: window.JSZip（CDN）

window.Estimate = (function () {
  const MAX_ROWS = 24;               // テンプレートが対応する行数（row6〜row29）
  const FIRST_ROW = 6;
  // 各列のセル style（テンプレートの既存スタイルをそのまま使う。row21以降はD/Fのstyleが変わる）
  const styleOf = (col, row) => {
    if (col === "B") return row === 29 ? 55 : 50;
    if (col === "D") return row <= 20 ? 58 : 51;
    if (col === "E") return 51;
    if (col === "F") return row <= 20 ? 52 : 51;
    if (col === "H") return 60;
    return 2;
  };
  function escXml(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function replaceCell(xml, coord, newCellXml) {
    const re = new RegExp('<c r="' + coord + '"[^>]*?(?:/>|>[\\s\\S]*?</c>)');
    if (!re.test(xml)) throw new Error("テンプレートにセルが見つかりません: " + coord);
    return xml.replace(re, newCellXml);
  }
  function blankCell(coord, style) { return `<c r="${coord}" s="${style}"/>`; }
  function textCell(coord, style, text) {
    if (text == null || text === "") return blankCell(coord, style);
    return `<c r="${coord}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${escXml(text)}</t></is></c>`;
  }
  function numCell(coord, style, num) {
    if (num == null || num === "" || isNaN(num)) return blankCell(coord, style);
    return `<c r="${coord}" s="${style}"><v>${num}</v></c>`;
  }
  // 11月発送分以降：郵便料金（税込）を税抜+1.7円ベースに更新（税込=(税抜+1.7)*1.1）
  const PRICE_BUMP_FROM = "202611";
  const BUMPED_POSTAGE = { R5: 57.97, R6: 56.27, R7: 54.57 };

  // テンプレート本体はバイナリを直接コミットせず、js/estimate-template-b64.js に
  // Base64文字列（window.ESTIMATE_TEMPLATE_B64）として埋め込んでいる（.gitignoreのxlsm除外・改行変換の影響を避けるため）
  function templateArrayBuffer() {
    const b64 = window.ESTIMATE_TEMPLATE_B64;
    if (!b64) throw new Error("見積もり依頼テンプレートが読み込まれていません（estimate-template-b64.js）。");
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  }

  // rows: [{ name, count, spec, pctPostal(0-1), note }, ...]  最大24件
  // mailDate: "YYYY-MM-DD"
  async function build({ mailDate, rows }) {
    if (!window.JSZip) throw new Error("JSZipが読み込まれていません。");
    if (rows.length > MAX_ROWS) throw new Error(`テンプレートは最大${MAX_ROWS}件までです（現在${rows.length}件）。行数を減らしてください。`);
    const zip = await window.JSZip.loadAsync(templateArrayBuffer());
    let sheet1 = await zip.file("xl/worksheets/sheet1.xml").async("string");

    const d = new Date(mailDate + "T00:00:00");
    const mailText = `${d.getMonth() + 1}/${d.getDate()}投函`;
    sheet1 = replaceCell(sheet1, "B2", textCell("B2", 3, mailText));

    for (let i = 0; i < MAX_ROWS; i++) {
      const row = FIRST_ROW + i;
      const r = rows[i] || null;
      sheet1 = replaceCell(sheet1, `B${row}`, textCell(`B${row}`, styleOf("B", row), r ? r.name : ""));
      sheet1 = replaceCell(sheet1, `D${row}`, numCell(`D${row}`, styleOf("D", row), r ? r.count : ""));
      sheet1 = replaceCell(sheet1, `E${row}`, textCell(`E${row}`, styleOf("E", row), r ? r.spec : ""));
      sheet1 = replaceCell(sheet1, `F${row}`, numCell(`F${row}`, styleOf("F", row), r ? r.pctPostal : ""));
      sheet1 = replaceCell(sheet1, `H${row}`, textCell(`H${row}`, styleOf("H", row), r ? r.note : ""));
    }

    const ym = mailDate.replace(/-/g, "").slice(0, 6);
    if (ym >= PRICE_BUMP_FROM) {
      Object.keys(BUMPED_POSTAGE).forEach(coord => {
        sheet1 = replaceCell(sheet1, coord, `<c r="${coord}" s="10"><v>${BUMPED_POSTAGE[coord]}</v></c>`);
      });
    }

    zip.file("xl/worksheets/sheet1.xml", sheet1);
    return await zip.generateAsync({ type: "arraybuffer", compression: "DEFLATE" });
  }

  function filename(mailDate) {
    const d = new Date(mailDate + "T00:00:00");
    const y = d.getFullYear(), m = d.getMonth() + 1, day = d.getDate();
    return `■${y}年${m}月${day}日発送分_投函DMお見積依頼件数_件数確定.xlsm`;
  }
  function subfolderName(mailDate) {
    const d = new Date(mailDate + "T00:00:00");
    return [`${d.getFullYear()}年度`, `${d.getMonth() + 1}月見積`];
  }

  return { build, filename, subfolderName, MAX_ROWS };
})();
