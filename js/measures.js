// デザインチーム共有用「DM施策サマリー」Excel出力（見積もり依頼と違い、テンプレートは使わずExcelJSで新規生成）
window.MeasuresExport = (function () {
  const HEADERS = ["施策名", "担当", "RO", "テスト", "テスト制作\nボリューム", "リスト条件", "掲載商品", "RO版\nFIX時期", "特典\n決定時期", "補足1", "補足2"];
  const WIDTHS = [16, 10, 6, 6, 22, 38, 20, 11, 11, 32, 32];
  const BLUE = "FFDCE6F1", YELLOW = "FFFFFFCC", GREEN = "FFD9EAD3", HILITE = "FFFFFF00";
  const thin = { style: "thin", color: { argb: "FF808080" } };
  const BORDER = { top: thin, left: thin, bottom: thin, right: thin };
  const headerFill = (col) => (col <= 2 ? BLUE : col <= 7 ? YELLOW : col <= 9 ? null : GREEN);
  const FONT = "Meiryo UI";
  const normalizeDate = (v) => (v || "").replace(/(\d{4})-(\d{1,2})-(\d{1,2})/g, "$1/$2/$3");

  function groups(rows) {
    const map = new Map(), order = [];
    rows.forEach(m => {
      const name = (m.baseName || "").trim(); if (!name) return;
      if (!map.has(name)) { const g = { name, children: [] }; map.set(name, g); order.push(g); }
      map.get(name).children.push(m);
    });
    return order;
  }

  async function build({ rows }) {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("施策サマリー");
    ws.columns = WIDTHS.map(w => ({ width: w }));

    const headerRow = ws.addRow(HEADERS);
    headerRow.height = 28;
    headerRow.eachCell((cell, col) => {
      cell.font = { name: FONT, bold: true };
      cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
      cell.border = BORDER;
      const fill = headerFill(col);
      if (fill) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: fill } };
    });

    let totalRO = 0, totalTest = 0, totalCount = 0;
    groups(rows).forEach(g => {
      const startRow = ws.rowCount + 1;
      g.children.forEach(m => {
        if (m.kind === "RO") totalRO++; else if (m.kind === "テスト") totalTest++;
        totalCount++;
        const r = ws.addRow([
          g.name,
          m.owner || "",
          m.kind === "RO" ? 1 : "",
          m.kind === "テスト" ? 1 : "",
          m.supplement || "",
          m.note || "",
          m.products || "",
          normalizeDate(m.roFixDate),
          m.benefit || "",
          m.printerNote || "",
          m.printerNote || "",
        ]);
        r.eachCell((cell, col) => {
          cell.border = BORDER;
          cell.font = { name: FONT };
          cell.alignment = { vertical: "middle", horizontal: (col === 3 || col === 4) ? "center" : "left", wrapText: true };
        });
        if (m.highlight) r.getCell(5).fill = { type: "pattern", pattern: "solid", fgColor: { argb: HILITE } };
      });
      const endRow = ws.rowCount;
      if (endRow > startRow) {
        ws.mergeCells(startRow, 1, endRow, 1);
        ws.mergeCells(startRow, 2, endRow, 2);
      }
      ws.getCell(startRow, 1).alignment = { vertical: "middle", horizontal: "left", wrapText: true };
      ws.getCell(startRow, 2).alignment = { vertical: "middle", horizontal: "center", wrapText: true };
    });

    const totalRow = ws.addRow(["合計施策数", totalCount, totalRO, totalTest]);
    totalRow.eachCell((cell) => { cell.border = BORDER; cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: YELLOW } }; cell.font = { name: FONT, bold: true }; cell.alignment = { vertical: "middle", horizontal: "center" }; });
    totalRow.getCell(1).alignment = { vertical: "middle", horizontal: "left" };
    for (let c = 5; c <= HEADERS.length; c++) {
      const cell = totalRow.getCell(c);
      cell.border = BORDER;
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: YELLOW } };
    }

    return wb.xlsx.writeBuffer();
  }

  function filename(month) {
    const mo = parseInt((month || "").slice(4, 6), 10);
    return `【企画】${mo}月DM施策 サマリー.xlsx`;
  }

  return { build, filename };
})();
