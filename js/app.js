// app.js v2 — DM企画サマリー（企画サマリー基盤＋履歴＋リスト条件ビルダー）
(function () {
  "use strict";
  const M = window.MASTERS;
  const S = window.Storage;
  const DEFAULT_ROWS = 15;

  const state = {
    user: localStorage.getItem("dmplan:user") || "",
    month: null, model: null, mtime: 0, editing: false, pollTimer: null,
    drawerId: null, sort: { field: "", dir: "asc" }, filters: {}, dragId: null, dragKey: null,
    expanded: {}, showCode: false, showP3: false,
    draggingMeasure: false, dragMeasure: null,
    selected: new Set(), dragBatch: null, dragCanceled: false, dragFromSel: false, dragMoved: false,
  };
  const cf = { data: [], cards: [], dots: [], sel: 0, dragMode: false, opening: false };
  const uid = () => "m" + Math.random().toString(36).slice(2, 9);

  // 担当候補（この端末に保存。手入力で追加、×で削除）
  const OWNERS_KEY = "dmplan:owners";
  function getOwners() { try { const s = localStorage.getItem(OWNERS_KEY); if (s) return JSON.parse(s); } catch (e) {} return M.owners.slice(); }
  function saveOwners(list) { localStorage.setItem(OWNERS_KEY, JSON.stringify(list)); rebuildOwnerDatalist(); }
  function addOwner(v) { v = (v || "").trim(); if (!v) return; const l = getOwners(); if (!l.includes(v)) { l.push(v); saveOwners(l); } }
  function removeOwner(v) { saveOwners(getOwners().filter(x => x !== v)); }
  function rebuildOwnerDatalist() { const d = document.getElementById("dl-own"); if (!d) return; d.innerHTML = ""; getOwners().forEach(v => d.append(el("option", { value: v }))); }

  // 数値を3桁カンマ整形（decimal=trueなら小数許容）。空は空。
  function fmtNum(v, decimal) {
    if (v === "" || v == null) return "";
    let s = String(v).replace(/,/g, "");
    if (s === "" || s === ".") return s;
    if (decimal) {
      const parts = s.split(".");
      const intp = parts[0] === "" ? "" : Number(parts[0]).toLocaleString();
      return parts.length > 1 ? intp + "." + parts.slice(1).join("") : intp;
    }
    const n = parseInt(s, 10); return isNaN(n) ? "" : n.toLocaleString();
  }

  // 保存日時の表示
  function formatDT(iso) { if (!iso) return ""; const d = new Date(iso); const p = n => String(n).padStart(2, "0"); return `${d.getFullYear()}/${p(d.getMonth()+1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; }
  function updateSavedAt() { const e = $("#savedAt"); if (!e) return; e.textContent = state.model && state.model.updatedAt ? `最終保存 ${formatDT(state.model.updatedAt)}${state.model.updatedBy ? "（" + state.model.updatedBy + "）" : ""}` : "未保存"; }

  function emptyCond() {
    return { products: [], ages: ["50代","60代","70代","80代","不明"], dUse: true, dFrom: 3, dTo: 8,
      rUse: false, rFrom: 1, rTo: 8, f: ["F1","F2以上"], gender: "不問", mailArea: false, birthMonth: false, note: "" };
  }
  function emptyExcl() {
    const common = {}; M.exclCommon.forEach(e => common[e.key] = true);
    const per = {}; M.exclPerMeasure.forEach(e => per[e.key] = false);
    return { common, zengetsuMode: "全て", per };
  }
  function emptyMeasure() {
    return { id: uid(), baseName: "", owner: "", category: "DMB", runStatus: "未確定", codeStatus: "未確定", num: "",
      kind: "RO", variant: "", media: "発送DM", listMethod: "AI", delivery: "郵便のみ", p3: "", priority: "",
      estimatedCount: "", products: "", benefit: "", note: "", roFixDate: "", officialName: "",
      compareBaseId: "", compareScope: "", testValidated: false, cond: emptyCond(), excl: emptyExcl() };
  }
  function emptyModel(month) {
    const active = []; for (let i = 0; i < DEFAULT_ROWS; i++) active.push(emptyMeasure());
    return { month, title: window.monthLabel(month) + "DM施策", updatedAt: "", updatedBy: "",
      active, carryNext: [], carryFuture: [], ideas: [] };
  }
  // 旧データ互換：欠けフィールドを補完
  function normalize(m) {
    ["active","carryNext","carryFuture"].forEach(k => (m[k]||[]).forEach(x => {
      if (!x.cond) x.cond = emptyCond();
      if (!x.excl) x.excl = emptyExcl();
      if (!x.codeStatus) x.codeStatus = x.num ? "確定" : "未確定";
      if (!x.runStatus) x.runStatus = "未確定";
      if (x.p3 == null) x.p3 = "";
      if (x.compareBaseId == null) x.compareBaseId = "";
      if (x.compareScope == null) x.compareScope = "";
      if (x.officialName == null) x.officialName = "";
      if (x.testValidated == null) x.testValidated = false;
      if (!x.delivery) x.delivery = "郵便のみ";
    }));
    if (!m.ideas) m.ideas = [];
    return m;
  }

  // RO/テストの版ラベルを自動採番：同一施策名(baseName)・同一種別が1本なら「RO」、2本以上なら「RO①②」。テストも同様。
  const CIRCLED = n => (n >= 1 && n <= 20) ? String.fromCharCode(0x2460 + n - 1) : ("#" + n);
  function kindLabel(m) {
    if (!m.baseName) return m.kind;
    const key = sectionOf(m);
    const grp = state.model[key].filter(x => x.baseName === m.baseName && x.kind === m.kind);
    if (grp.length <= 1) return m.kind;
    const i = grp.indexOf(m);
    return m.kind + CIRCLED(i + 1);
  }
  function derive(m, month) {
    const prefix = window.prefixOfCategory(m.category);
    const hasNum = m.num !== "" && m.num != null;              // 番号が入っていればコードを候補として表示
    const confirmed = m.codeStatus === "確定" && hasNum;
    const label = kindLabel(m);                                 // RO / RO① / テスト …（自動採番）
    // 正式名（＝案件共有シートに貼れる施策名候補）。officialName（持ち帰り）があれば最優先。
    const working = window.buildFullName({ month, baseName: m.baseName, media: m.media, variant: label, prefix, num: m.num, confirmed: hasNum });
    return {
      confirmed,
      materialCode: hasNum ? window.buildMaterialCode(prefix, m.num) : "未確定",
      fullName: (m.officialName && m.officialName.trim()) ? m.officialName.trim() : working,
    };
  }
  function segments(m) {
    const c = m.cond; const rows = [];
    const grp = (m.cond.products[0] && m.cond.products[0].group) || m.baseName || "対象";
    // 経過軸は D か R のどちらか
    let basis = [null], bl = "";
    if (c.dUse) { basis = range(Math.min(c.dFrom,c.dTo), Math.max(c.dFrom,c.dTo)); bl = "D"; }
    else if (c.rUse) { basis = range(Math.min(c.rFrom,c.rTo), Math.max(c.rFrom,c.rTo)); bl = "R"; }
    let n = 0;
    (c.ages.length?c.ages:["-"]).forEach(a => basis.forEach(v => (c.f.length?c.f:["-"]).forEach(f => {
      const bcol = v!=null ? (bl+v) : "-";
      n++; rows.push({ i: n, name: `${grp}購入_${a}_${bcol}_${f}`.replace(/_-/g,""), age: a, d: bcol, f });
    })));
    return rows;
  }
  const range = (a,b) => { const r=[]; for(let i=a;i<=b;i++) r.push(i); return r; };

  // リスト条件の同一性判定（リンゴ×リンゴ）。差分ラベルの配列を返す（空＝完全一致）
  function condDiffs(a, b) {
    if (!a || !b) return ["条件なし"];
    const d = [];
    const setEq = (x, y) => x.length === y.length && x.every(v => y.includes(v));
    const prodKey = p => (p.products||[]).map(x => `${x.group}:${x.mode}:${x.unit}`).sort().join("|");
    if (prodKey(a) !== prodKey(b)) d.push("購入商品");
    if (!setEq(a.ages, b.ages)) d.push("年代");
    if (a.dUse !== b.dUse || (a.dUse && (a.dFrom !== b.dFrom || a.dTo !== b.dTo))) d.push("D");
    if (a.rUse !== b.rUse || (a.rUse && (a.rFrom !== b.rFrom || a.rTo !== b.rTo))) d.push("R");
    if (!setEq(a.f, b.f)) d.push("F");
    if (a.gender !== b.gender) d.push("性別");
    if (a.mailArea !== b.mailArea) d.push("メール便地域");
    if (a.birthMonth !== b.birthMonth) d.push("お誕生月");
    return d;
  }
  function compareInfo(m) {
    if (!m.compareBaseId) return null;
    const base = findMeasure(m.compareBaseId);
    if (!base) return { missing: true };
    const diffs = condDiffs(m.cond, base.cond);
    return { base, diffs, ok: diffs.length === 0 };
  }

  // ============ DOM helpers ============
  const $ = s => document.querySelector(s);
  const el = (t, a = {}, ...k) => {
    const e = document.createElement(t);
    for (const [key, v] of Object.entries(a)) {
      if (key === "class") e.className = v;
      else if (key === "html") e.innerHTML = v;
      else if (key.startsWith("on") && typeof v === "function") e.addEventListener(key.slice(2), v);
      else if (v != null) e.setAttribute(key, v);
    }
    for (const c of k) if (c != null) e.append(c.nodeType ? c : document.createTextNode(c));
    return e;
  };
  function icon(name){ return el("i", { class: "ti ti-" + name, "aria-hidden": "true" }); }
  function dl(id, items){ if(document.getElementById(id))return; const d=el("datalist",{id}); items.forEach(v=>d.append(el("option",{value:v}))); document.body.append(d); }

  // ============ Header / month ============
  function renderHeader() {
    $("#folderStatus").textContent = S.isConnected() ? S.folderName()
      : (S.supported ? "未接続（共有フォルダに接続してください）" : "フォルダ直結 非対応ブラウザ（Edge/Chrome推奨）");
    $("#folderStatus").className = "folder-status " + (S.isConnected() ? "on" : "off");
    $("#userName").value = state.user;
  }
  async function renderMonthSelect() {
    const sel = $("#monthSelect"); sel.innerHTML = "";
    if (!S.isConnected()) { sel.append(el("option", { value: "" }, "（未接続）")); return; }
    const months = await S.listMonths();
    if (!months.length) sel.append(el("option", { value: "" }, "（データなし）"));
    months.forEach(m => sel.append(el("option", { value: m }, window.monthLabel(m))));
    if (state.month && months.includes(state.month)) sel.value = state.month;
  }
  async function renderLockBar() {
    const bar = $("#lockBar"); const btn = $("#editBtn"), save = $("#saveBtn");
    // 本番運用：共有フォルダ未接続なら編集不可
    if (!S.isConnected()) {
      bar.className = "lockbar locked"; bar.innerHTML = ""; bar.append(icon("folder"), " 右上「共有フォルダに接続」で共有フォルダを選ぶと、閲覧・編集できます");
      btn.textContent = "編集を開始"; btn.disabled = true; save.disabled = true;
      document.body.classList.add("readonly"); return;
    }
    const lock = state.month ? await S.readLock(state.month) : null;
    const mine = lock && lock.user === state.user;
    btn.disabled = false;
    if (state.editing) { bar.className = "lockbar editing"; bar.innerHTML = ""; bar.append(icon("pencil"), " あなたが編集中（保存すると全員へ反映）"); btn.textContent = "編集を終了"; save.disabled = false; }
    else if (lock && !mine) { bar.className = "lockbar locked"; bar.innerHTML = ""; bar.append(icon("lock"), ` ${lock.user} さんが編集中（閲覧のみ・自動更新）`); btn.textContent = "編集を開始"; btn.disabled = true; save.disabled = true; }
    else { bar.className = "lockbar idle"; bar.textContent = state.model ? "閲覧モード" : "月を選ぶか新規作成してください"; btn.textContent = "編集を開始"; btn.disabled = !state.model; save.disabled = true; }
    document.body.classList.toggle("readonly", !state.editing);
  }
  function renderSummary() {
    const box = $("#summary"); if (!state.model) { box.innerHTML = ""; return; }
    // 左「実施」が確定した施策だけを集計対象にする
    const a = state.model.active.filter(m => m.runStatus === "確定");
    const ro = a.filter(m => m.kind === "RO").length, test = a.filter(m => m.kind === "テスト").length;
    const cnt = a.reduce((s, m) => s + (parseInt(m.estimatedCount, 10) || 0), 0);
    const unvalidated = a.filter(m => m.kind === "テスト" && !m.testValidated).length;
    box.innerHTML = "";
    const chip = (l, v, cls) => el("div", { class: "chip " + (cls||"") }, el("span", { class: "chip-v" }, String(v)), el("span", { class: "chip-l" }, l));
    box.append(chip("施策数（実施確定）", a.length), chip("RO本数", ro), chip("テスト本数", test),
      chip("想定件数 合計", cnt.toLocaleString()),
      chip("テスト検証 未設定", unvalidated, unvalidated ? "ng" : ""));
  }

  // ============ 施策テーブル ============
  // 列定義（f=フィールド, type=ソート/フィルタの型, cat=カテゴリ絞り込み対象）
  const COLS = [
    { t: "" }, { t: "実施" },
    { t: "施策名", f: "baseName", type: "text" },
    { t: "担当", f: "owner", type: "cat" },
    { t: "種別", f: "kind", type: "cat" },
    { t: "取得", f: "listMethod", type: "cat" },
    { t: "送付", f: "delivery", type: "cat" },
    { t: "P3/List", title: "P3/List", f: "p3", type: "num", hideGroup: "p3" },
    { t: "優先", f: "priority", type: "num", hideGroup: "p3" },
    { t: "件数", title: "想定件数", f: "estimatedCount", type: "num" },
    { t: "素材コード", key: "code", hideGroup: "code", title: "素材コード（正式名の候補）" }, { t: "テスト検証" }, { t: "→ 正式名候補（編集可）" },
    { t: "リスト条件" }, { t: "" },
  ];
  function passFilters(m) {
    for (const f of ["owner", "kind", "listMethod", "delivery"]) {
      const allow = state.filters[f];
      if (allow && allow.length && !allow.includes(m[f] || "")) return false;
    }
    return true;
  }
  function sortView(rows) {
    const { field, dir } = state.sort; if (!field) return rows;
    const num = ["p3", "priority", "estimatedCount"].includes(field);
    const val = m => num ? (parseFloat(m[field]) || 0) : String(m[field] || "");
    const r = rows.slice().sort((a, b) => { const x = val(a), y = val(b); return (x < y ? -1 : x > y ? 1 : 0) * (dir === "desc" ? -1 : 1); });
    return r;
  }
  // 一部の列は既定で非表示（トグルで表示）
  function colVisible(c) {
    if (c.hideGroup === "code") return state.showCode;
    if (c.hideGroup === "p3") return state.showP3;
    return true;
  }
  function activeCols() { return COLS.filter(colVisible); }
  function renderMeasureSection(key, label, icn) {
    const list = state.model[key];
    const wrap = el("section", { class: "sec" });
    const head = el("div", { class: "sec-head" }, el("h2", {}, icon(icn), " " + label, el("span", { class: "sec-count" }, `${list.length}`)));
    const anyFilter = ["owner","kind","listMethod","delivery"].some(f => state.filters[f] && state.filters[f].length);
    if (state.sort.field || anyFilter) head.append(el("button", { class: "btn small ghost", title: "並び替え・絞り込みを解除", onclick: () => { state.sort = { field: "", dir: "asc" }; state.filters = {}; rerender(); } }, icon("filter-off"), " 解除"));
    if (key === "active") {
      head.append(el("button", { class: "btn small toggle" + (state.showP3 ? " on" : ""), title: state.showP3 ? "P3/List・優先 を非表示にする" : "P3/List・優先 を表示する", onclick: () => { state.showP3 = !state.showP3; rerender(); } }, icon(state.showP3 ? "eye" : "eye-off"), " P3/List・優先"));
      head.append(el("button", { class: "btn small toggle" + (state.showCode ? " on" : ""), title: state.showCode ? "素材コード を非表示にする" : "素材コード を表示する", onclick: () => { state.showCode = !state.showCode; rerender(); } }, icon(state.showCode ? "eye" : "eye-off"), " 素材コード"));
      head.append(el("button", { class: "btn small", onclick: sortByPriority, title: "AI施策を先に、P3/Listが高い順に優先度1から振る" }, "P3/Listで優先度を設定"));
    }
    wrap.append(head);
    const table = el("table", { class: "grid" });
    const thr = el("tr", {});
    activeCols().forEach(c => thr.append(headerCell(c)));
    table.append(el("thead", {}, thr));
    const tb = el("tbody", {});
    const rows = sortView(list.filter(passFilters));
    rows.forEach(m => { tb.append(row(key, m)); if (state.expanded[m.id]) tb.append(detailRow(key, m)); });
    if (rows.length === 0) tb.append(el("tr", {}, el("td", { colspan: String(activeCols().length), class: "muted", style: "padding:10px" }, "該当する施策がありません")));
    table.append(tb);
    wrap.append(el("div", { class: "grid-scroll" }, table));
    wrap.append(el("div", { class: "add-bottom" }, el("button", { class: "btn small ghost", onclick: () => { list.push(emptyMeasure()); rerender(); } }, icon("plus"), " 施策を追加")));
    // セクションの空きスペースへドロップ＝この末尾へ移動（別セクションからでも可）
    wrap.addEventListener("dragover", e => { if (state.draggingMeasure) { e.preventDefault(); wrap.classList.add("drop-target"); } });
    wrap.addEventListener("dragleave", e => { if (!wrap.contains(e.relatedTarget)) wrap.classList.remove("drop-target"); });
    wrap.addEventListener("drop", e => { e.preventDefault(); wrap.classList.remove("drop-target"); handleRowDrop(key, null); });
    return wrap;
  }
  // 見出しセル（ソート/フィルタ対応列はクリックでメニュー）
  function headerCell(c) {
    if (!c.f) return el("th", c.title ? { title: c.title } : {}, c.t);
    const active = state.sort.field === c.f;
    const filtered = state.filters[c.f] && state.filters[c.f].length;
    const th = el("th", { class: "th-menu" + (active || filtered ? " on" : "") });
    const btn = el("button", { class: "th-btn", title: c.title || c.t }, c.t);
    if (active) btn.append(el("span", { class: "th-ind" }, state.sort.dir === "desc" ? " ▼" : " ▲"));
    if (filtered) btn.append(el("span", { class: "th-ind" }, " ⛃"));
    btn.addEventListener("click", e => { e.stopPropagation(); openColMenu(c, th); });
    th.append(btn);
    return th;
  }
  function closeColMenu() { const m = document.getElementById("colMenu"); if (m) m.remove(); document.removeEventListener("click", closeColMenu); }
  function openColMenu(c, th) {
    closeColMenu();
    const menu = el("div", { id: "colMenu", class: "col-menu" });
    const setSort = dir => { state.sort = { field: c.f, dir }; closeColMenu(); rerender(); };
    menu.append(el("button", { class: "cm-item", onclick: () => setSort("asc") }, c.type === "num" ? "▲ 小さい順（昇順）" : "▲ 昇順"));
    menu.append(el("button", { class: "cm-item", onclick: () => setSort("desc") }, c.type === "num" ? "▼ 大きい順（降順）" : "▼ 降順"));
    if (c.type === "cat") {
      menu.append(el("div", { class: "cm-sep" }, "表示する値"));
      const vals = [...new Set(state.model.active.concat(state.model.carryNext, state.model.carryFuture).map(m => m[c.f] || "").filter(v => v !== ""))];
      const cur = state.filters[c.f] || vals.slice();
      vals.forEach(v => {
        const on = cur.includes(v);
        const b = el("button", { class: "cm-check" + (on ? " on" : ""), onclick: (e) => {
          e.stopPropagation();
          let arr = (state.filters[c.f] || vals.slice()).slice();
          if (arr.includes(v)) arr = arr.filter(x => x !== v); else arr.push(v);
          state.filters[c.f] = (arr.length === vals.length) ? null : arr;
          rerender(); // メニューは閉じて再描画
        } }, (on ? "☑ " : "☐ ") + v);
        menu.append(b);
      });
      menu.append(el("button", { class: "cm-item", onclick: () => { state.filters[c.f] = null; closeColMenu(); rerender(); } }, "すべて表示"));
    }
    // 担当列：候補（サジェスト）の管理
    if (c.f === "owner") {
      menu.append(el("div", { class: "cm-sep" }, "担当の候補を編集（×で削除）"));
      getOwners().forEach(v => {
        const rowb = el("div", { class: "cm-owner" }, el("span", {}, v),
          el("button", { class: "cm-x", title: "候補から削除", onclick: (e) => { e.stopPropagation(); removeOwner(v); openColMenu(c, th); } }, "×"));
        menu.append(rowb);
      });
    }
    // 位置
    const r = th.getBoundingClientRect();
    menu.style.left = Math.min(r.left, window.innerWidth - 220) + "px";
    menu.style.top = (r.bottom + 2) + "px";
    document.body.append(menu);
    setTimeout(() => document.addEventListener("click", closeColMenu), 0);
  }
  function field(m, f, attrs = {}) { return el("input", Object.assign({ value: m[f] ?? "", "data-id": m.id, "data-field": f }, attrs)); }
  // 数値入力：半角のみ・3桁カンマ表示（フォーカス中は生値、離すと整形）。#board の汎用リスナは通さず直接保存。
  function numField(m, f, decimal, cls) {
    const inp = el("input", { class: cls, inputmode: decimal ? "decimal" : "numeric", value: fmtNum(m[f], decimal), placeholder: decimal ? "—" : "0" });
    inp.addEventListener("focus", () => { inp.value = (m[f] ?? "") === "" ? "" : String(m[f]).replace(/,/g, ""); });
    inp.addEventListener("input", () => {
      let raw = inp.value.replace(decimal ? /[^0-9.]/g : /[^0-9]/g, "");
      if (decimal) { const p = raw.split("."); raw = p.shift() + (p.length ? "." + p.join("") : ""); }
      m[f] = raw;
      if (f === "estimatedCount") renderSummary();
    });
    inp.addEventListener("blur", () => { inp.value = fmtNum(m[f], decimal); });
    // Excelから複数行を貼り付け＝この列を上から一気に埋める（先頭セルにペースト）
    inp.addEventListener("paste", e => {
      const txt = ((e.clipboardData || window.clipboardData) || {}).getData ? (e.clipboardData || window.clipboardData).getData("text") : "";
      if (!txt) return;
      const lines = txt.replace(/\r\n?/g, "\n").split("\n");
      while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
      if (lines.length <= 1) return;   // 単一値は通常の貼り付けに任せる
      e.preventDefault();
      if (!state.editing) return;
      const key = sectionOf(m);
      const rows = sortView(state.model[key].filter(passFilters));
      let start = rows.findIndex(x => x.id === m.id); if (start < 0) start = 0;
      const clean = s => { let v = String(s).split("\t")[0].replace(decimal ? /[^0-9.]/g : /[^0-9]/g, ""); if (decimal) { const p = v.split("."); v = p.shift() + (p.length ? "." + p.join("") : ""); } return v; };
      let n = 0, filled = 0;
      for (let i = 0; i < lines.length && start + i < rows.length; i++) { rows[start + i][f] = clean(lines[i]); n++; }
      filled = n;
      rerender();
      const over = lines.length - filled;
      flash(`${filled}件を貼り付けました` + (over > 0 ? `（行が${over}件不足：先に行を追加してください）` : ""));
    });
    return inp;
  }
  function pick(m, f, opts, attrs = {}) {
    const s = el("select", Object.assign({ "data-id": m.id, "data-field": f }, attrs));
    opts.forEach(o => { const v = o.value ?? o, l = o.label ?? o; const op = el("option", { value: v }, l); if ((m[f] ?? "") === v) op.selected = true; s.append(op); });
    return s;
  }
  // 施策名の候補（定番＋入力済みの実データ）
  function baseSuggestions() {
    const base = ["お誕生日", "TRS下取", "TRS下取りお誕生日", "TRS下取WOW", "RAH買い替え", "RAH買い替えお誕生日", "複数掲載", "お誕生日ベースTRS下取り"];
    const used = [];
    ["active", "carryNext", "carryFuture"].forEach(k => (state.model[k] || []).forEach(x => { if (x.baseName && !base.includes(x.baseName) && !used.includes(x.baseName)) used.push(x.baseName); }));
    return base.concat(used);
  }
  // 入力文字に関係なく「常に全候補」を出すコンボ（datalistの前方一致フィルタを回避）
  function comboField(m, f, getOptions, attrs) {
    const wrap = el("div", { class: "combo" });
    const inp = el("input", { class: attrs.class, value: m[f] ?? "", placeholder: attrs.placeholder, "data-id": m.id, "data-field": f, autocomplete: "off" });
    const menu = el("div", { class: "combo-menu" });
    const open = () => {
      menu.innerHTML = "";
      const opts = getOptions(); if (!opts.length) return;
      opts.forEach(o => {
        const it = el("div", { class: "combo-opt" + (m[f] === o ? " sel" : "") }, o);
        it.addEventListener("mousedown", e => { e.preventDefault(); inp.value = o; m[f] = o; inp.dispatchEvent(new Event("change", { bubbles: true })); menu.classList.remove("open"); if (f === "baseName") { refreshAllNames(); applyFamilyColors(); } });
        menu.append(it);
      });
      const r = inp.getBoundingClientRect();
      menu.style.left = r.left + "px"; menu.style.top = (r.bottom + 2) + "px"; menu.style.minWidth = r.width + "px";
      menu.classList.add("open");
    };
    inp.addEventListener("focus", open);
    inp.addEventListener("click", open);
    inp.addEventListener("blur", () => setTimeout(() => menu.classList.remove("open"), 150));
    wrap.append(inp, menu);
    return wrap;
  }
  function row(key, m) {
    const tr = el("tr", { "data-row": m.id });
    if (state.drawerId === m.id) tr.classList.add("active-row");
    if (state.expanded[m.id]) tr.classList.add("expanded-row");
    if (state.selected.has(m.id)) tr.classList.add("selected");
    const fc = familyColorOf(m);
    if (fc) { tr.classList.add("fam-row"); tr.style.background = fc.bg; tr.style.setProperty("--band", fc.band); }
    const td = (c, cls) => { const x = el("td", cls ? { class: cls } : {}); x.append(c); return x; };
    // ドラッグは左端ハンドルのみ（セル内のテキスト選択・コピーを妨げない）
    const sortActive = !!state.sort.field;
    const handle = el("span", { class: "drag" + (sortActive ? " off" : ""), draggable: sortActive ? "false" : "true", title: sortActive ? "並び替え適用中は手動移動できません（『解除』後に可）" : "ドラッグで並べ替え（複数選択中はまとめて移動）" }, "⋮⋮");
    handle.addEventListener("dragstart", e => {
      if (!state.editing || sortActive) { e.preventDefault(); return; }
      const fromSel = state.selected.has(m.id) && state.selected.size > 0;
      const batch = fromSel ? [...state.selected] : [m.id];
      state.dragBatch = batch; state.dragCanceled = false; state.dragFromSel = fromSel; state.dragMoved = false;
      state.dragId = batch.length === 1 ? m.id : null;   // 単体のみ同一セクション内で並べ替え
      state.dragKey = key; state.dragMeasure = { id: m.id, key }; state.draggingMeasure = true;
      tr.classList.add("dragging"); $("#cfHot").classList.add("active");
      e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", m.id);
      try { e.dataTransfer.setDragImage(tr, 40, 16); } catch (_) {}
    });
    handle.addEventListener("dragend", () => {
      tr.classList.remove("dragging");
      const fromSel = state.dragFromSel; const openCF = cf.dragMode;
      cleanupDrag(); if (openCF) closeCoverflow();
      // 選択から始めたドラッグは、移動でもキャンセル（枠外／Escape）でも終了時に必ず選択を解除
      if (fromSel) { state.selected.clear(); rerender(); }
    });
    // 展開トグル（裏側の施策概要/特典/RO版FIX）
    const hasNote = !!((m.note && m.note.trim()) || (m.benefit && m.benefit.trim()) || (m.roFixDate && m.roFixDate.trim()) || (m.products && m.products.trim()));
    const exp = el("button", { class: "expander" + (hasNote ? " hasnote" : "") + (state.expanded[m.id] ? " open" : ""), title: hasNote ? "詳細・メモあり（クリックで開閉）" : "詳細・メモを開く" });
    exp.append(icon(state.expanded[m.id] ? "chevron-down" : "chevron-right"));
    if (hasNote) exp.append(el("i", { class: "ti ti-note note-dot", "aria-hidden": "true" }));
    exp.addEventListener("click", () => { state.expanded[m.id] = !state.expanded[m.id]; rerender(); });
    const dragCell = el("td", { class: "c-drag" });
    if (state.editing) {
      const chk = el("input", { type: "checkbox", class: "rowsel", title: "選択（まとめて移動）" });
      chk.checked = state.selected.has(m.id);
      chk.addEventListener("change", () => { if (chk.checked) state.selected.add(m.id); else state.selected.delete(m.id); tr.classList.toggle("selected", chk.checked); updateSelBar(); });
      dragCell.append(chk);
    }
    dragCell.append(handle, exp);
    tr.append(dragCell);
    tr.append(td(statusChip(m, "runStatus", key, "施策実施"), "c-status"));
    tr.append(td(comboField(m, "baseName", baseSuggestions, { class: "w-name", placeholder: "施策名" })));
    tr.append(td(comboField(m, "owner", getOwners, { class: "w-own", placeholder: "担当" })));
    tr.append(td(pick(m, "kind", M.kinds, { class: "w-kind" })));
    tr.append(td(pick(m, "listMethod", M.listMethods, { class: "w-lm" })));
    tr.append(td(pick(m, "delivery", M.deliveryTypes, { class: "w-souf" })));
    if (state.showP3) {
      tr.append(td(numField(m, "p3", true, "w-p3")));
      tr.append(td(field(m, "priority", { class: "w-pri", type: "number", min: "1", placeholder: "—" })));
    }
    tr.append(td(numField(m, "estimatedCount", false, "w-cnt")));
    if (state.showCode) { const codeCell = el("td", { class: "c-code", "data-code": m.id }); renderCodeCell(codeCell, m); tr.append(codeCell); }
    const cmpCell = el("td", { class: "c-cmp", "data-cmp": m.id }); renderCmpCell(cmpCell, m); tr.append(cmpCell);
    // 正式名候補：編集可＋コピー
    const der = el("td", { class: "c-derived", "data-derived": m.id });
    const nin = el("input", { class: "namein", value: derive(m, state.month).fullName, title: "編集可。案件共有シートで確定後の正式名を貼り戻す用" });
    nin.addEventListener("input", () => { m.officialName = nin.value; });
    const cp = el("button", { class: "iconbtn copyname", title: "施策名（正式名）だけをコピー" }); cp.append(icon("clipboard-text"));
    cp.addEventListener("click", () => { if (navigator.clipboard) navigator.clipboard.writeText(nin.value).then(() => flash("施策名をコピーしました")).catch(() => {}); });
    der.append(nin, cp); tr.append(der);
    tr.append(td(el("button", { class: "btn tiny icononly", title: "リスト条件を開く", onclick: () => openDrawer(m.id) }, icon("adjustments-horizontal")), "c-cond"));
    const moveBtn = el("button", { class: "iconbtn", title: "別のセクションへ移動" }); moveBtn.append(icon("arrows-move"));
    moveBtn.addEventListener("click", e => { e.stopPropagation(); openMoveMenu(key, m.id, moveBtn); });
    tr.append(td(el("div", { class: "ops" }, moveBtn,
      el("button", { class: "iconbtn", title: "この施策を1行まるごと複製", onclick: () => copyMeasure(key, m.id) }, icon("row-insert-bottom")),
      el("button", { class: "iconbtn danger", title: "この施策を削除", onclick: () => del(key, m.id) }, icon("trash"))), "c-ops"));
    tr.addEventListener("dragover", e => { if (state.draggingMeasure) e.preventDefault(); });
    tr.addEventListener("drop", e => { e.preventDefault(); e.stopPropagation(); handleRowDrop(key, m.id); });
    return tr;
  }
  function renderCodeCell(cell, m) {
    cell.innerHTML = "";
    const confirmed = m.codeStatus === "確定";
    const prefix = window.prefixOfCategory(m.category);
    const has = m.num !== "" && m.num != null;
    cell.className = "c-code " + (confirmed ? "code-ok" : "code-pend");
    cell.append(pick(m, "category", M.categories.map(c => ({ value: c.key, label: c.key })), { class: "w-cat" }));
    cell.append(field(m, "num", { class: "w-num", type: "number", min: "1", placeholder: "180" }));
    cell.append(el("span", { class: "codeval " + (confirmed ? "ok" : "pend") }, has ? window.buildMaterialCode(prefix, m.num) : "—"));
    const on = confirmed;
    const tog = el("button", { class: "ministat " + (on ? "ok" : "pend"), title: "素材コード：" + (on ? "確定" : "未確定") + "（クリックで切替）" });
    tog.append(icon(on ? "circle-check" : "circle-dashed"));
    tog.addEventListener("click", () => { if (!state.editing) return; m.codeStatus = on ? "未確定" : "確定"; rerenderRow(sectionOf(m), m); renderSummary(); });
    cell.append(tog);
  }
  // テスト検証：RO等は「—」、テストは必ず OK / NG
  function renderCmpCell(cell, m) {
    cell.innerHTML = "";
    if (m.kind !== "テスト") { cell.append(el("span", { class: "muted-dash" }, "—")); return; }
    const on = !!m.testValidated;
    const b = el("button", { class: "valid-btn " + (on ? "ok" : "ng"), title: on ? "テスト検証OK（クリックで解除）" : "未検証（チーム確認後クリックでOKに）" });
    b.textContent = on ? "OK" : "NG";
    b.addEventListener("click", () => { if (!state.editing) return; m.testValidated = !m.testValidated; rerenderRow(sectionOf(m), m); renderSummary(); });
    cell.append(b);
  }
  function statusChip(m, f, key, label) {
    const on = m[f] === "確定";
    const b = el("button", { class: "status " + (on ? "ok" : "pend"), title: label + "：" + (on ? "確定" : "未確定") + "（クリックで切替）" });
    b.append(icon(on ? "circle-check" : "circle-dashed"));
    b.addEventListener("click", () => { if (!state.editing) return; m[f] = on ? "未確定" : "確定"; rerenderRow(key, m); renderSummary(); });
    return b;
  }
  // 全行の正式名(候補)を再計算（RO①②の採番は兄弟行に依存）。手動編集(officialName)済みは触らない
  function refreshAllNames() {
    document.querySelectorAll("[data-derived]").forEach(cell => {
      const id = cell.getAttribute("data-derived"); const m = findMeasure(id); if (!m) return;
      const nin = cell.querySelector(".namein");
      if (nin && !(m.officialName && m.officialName.trim())) nin.value = derive(m, state.month).fullName;
    });
  }
  function rerenderRow(key, m) {
    const tr = document.querySelector(`tr[data-row="${m.id}"]`); if (tr) tr.replaceWith(row(key, m));
    // この施策を比較元にしている行も更新
    ["active","carryNext","carryFuture"].forEach(k => state.model[k].forEach(mm => {
      if (mm.compareBaseId === m.id) { const t = document.querySelector(`tr[data-row="${mm.id}"]`); if (t) t.replaceWith(row(k, mm)); }
    }));
  }
  function copyMeasure(key, id) {
    if (!state.editing) return;
    const l = state.model[key]; const i = l.findIndex(x => x.id === id); if (i < 0) return;
    const c = JSON.parse(JSON.stringify(l[i]));
    c.id = uid(); c.num = ""; c.codeStatus = "未確定"; c.officialName = ""; c.compareBaseId = id; // 複製は元施策を比較元に
    l.splice(i + 1, 0, c); rerender(); flash("直下に複製しました（比較元＝元の施策）");
  }
  function reorder(key, dragId, targetId) {
    const l = state.model[key]; const from = l.findIndex(x => x.id === dragId); if (from < 0) return;
    const [it] = l.splice(from, 1); let to = l.findIndex(x => x.id === targetId);
    if (to < 0) l.push(it); else l.splice(to, 0, it);
    rerender();
  }
  // ドラッグ状態のクリア
  function cleanupDrag() { state.dragBatch = null; state.dragId = null; state.dragKey = null; state.dragMeasure = null; state.draggingMeasure = false; state.dragCanceled = false; state.dragFromSel = false; state.dragMoved = false; $("#cfHot").classList.remove("active"); }
  function clearSel() { state.selected.clear(); updateSelBar(); rerender(); }
  // 行/セクションへのドロップ処理（単体＝並べ替え、複数＝まとめて移動。別セクションへも可）
  function handleRowDrop(toKey, targetId) {
    if (!state.editing || state.dragCanceled) return; // 後片付けは dragend で行う
    const batch = state.dragBatch; if (!batch || !batch.length) return;
    if (batch.length === 1 && batch[0] === targetId) return; // 自分自身へは何もしない
    moveBatch(batch, toKey, targetId); state.dragMoved = true;
    if (batch.length > 1) flash(`${batch.length}件を「${SEC_LABEL[toKey]}」へ移動しました`);
    rerender();
  }
  // 複数施策を toKey セクションへ（beforeId の前に）移動。別セクションをまたいでも順序を保つ
  function moveBatch(ids, toKey, beforeId) {
    const idset = new Set(ids);
    const picked = [];
    ["active", "carryNext", "carryFuture"].forEach(k => {
      state.model[k] = state.model[k].filter(m => { if (idset.has(m.id)) { picked.push(m); return false; } return true; });
    });
    if (!picked.length) return;
    const target = state.model[toKey];
    let idx = target.length;
    if (beforeId && !idset.has(beforeId)) { const bi = target.findIndex(m => m.id === beforeId); if (bi >= 0) idx = bi; }
    target.splice(idx, 0, ...picked);
  }
  // 選択操作バー（複数選択時に下部に表示）
  function updateSelBar() {
    let bar = $("#selBar");
    if (!bar) { bar = el("div", { id: "selBar", class: "sel-bar" }); document.body.append(bar); }
    const n = state.selected.size;
    if (!state.editing || n === 0) { bar.classList.remove("show"); bar.innerHTML = ""; return; }
    bar.innerHTML = "";
    bar.append(el("span", { class: "sel-n" }, `${n}件を選択中`));
    const mk = (k, lab) => el("button", { class: "btn small", onclick: () => { const ids = [...state.selected]; state.selected.clear(); moveBatch(ids, k, null); rerender(); flash(`${ids.length}件を「${lab}」へ移動しました`); } }, "→ " + lab);
    bar.append(mk("active", "今月実施"), mk("carryNext", "次月持越し"), mk("carryFuture", "今後へ持越し"));
    bar.append(el("button", { class: "btn small ghost onwhite", onclick: clearSel }, "選択解除"));
    bar.classList.add("show");
  }
  // 複数施策を別の月へ移動（コピー元＝現在の月）
  async function moveBatchToMonth(ids, targetMonth) {
    if (!state.editing || !targetMonth) return;
    if (targetMonth === state.month) { flash("同じ月です"); return; }
    const idset = new Set(ids);
    const picked = [];
    ["active", "carryNext", "carryFuture"].forEach(k => state.model[k].forEach(m => { if (idset.has(m.id)) picked.push(m); }));
    if (!picked.length) return;
    const clones = picked.map(src => { const c = JSON.parse(JSON.stringify(src)); c.id = uid(); c.codeStatus = "未確定"; c.num = ""; c.officialName = ""; c.testValidated = false; c.compareBaseId = ""; return c; });
    const raw = await S.readMonth(targetMonth);
    const tgt = normalize(raw ? JSON.parse(JSON.stringify(raw)) : emptyModel(targetMonth));
    tgt.active.push(...clones); tgt.updatedAt = new Date().toISOString(); tgt.updatedBy = state.user;
    await S.writeMonth(targetMonth, tgt);
    ["active", "carryNext", "carryFuture"].forEach(k => state.model[k] = state.model[k].filter(m => !idset.has(m.id)));
    ids.forEach(id => state.selected.delete(id));
    state.model.updatedAt = new Date().toISOString(); state.model.updatedBy = state.user;
    await S.writeMonth(state.month, state.model); state.mtime = await S.monthMtime(state.month);
    rerender();
    flash(`${window.monthLabel(targetMonth)} へ ${picked.length}件 移動しました`);
  }
  const SEC_LABEL = { active: "今月実施", carryNext: "次月持越し", carryFuture: "今後へ持越し" };
  function moveMeasure(fromKey, id, toKey) {
    if (!state.editing) return;
    const l = state.model[fromKey]; const i = l.findIndex(x => x.id === id); if (i < 0) return;
    const [it] = l.splice(i, 1); state.model[toKey].push(it); rerender(); flash(`「${SEC_LABEL[toKey]}」へ移動しました`);
  }
  function openMoveMenu(key, id, anchor) {
    closeColMenu();
    const menu = el("div", { id: "colMenu", class: "col-menu" });
    menu.addEventListener("click", e => e.stopPropagation());   // メニュー内クリックで閉じない
    menu.append(el("div", { class: "cm-sep" }, "このシート内で移動"));
    [["active","今月実施"],["carryNext","次月持越し"],["carryFuture","今後へ持越し"]].filter(([k]) => k !== key)
      .forEach(([k, lab]) => menu.append(el("button", { class: "cm-item", onclick: () => { moveMeasure(key, id, k); closeColMenu(); } }, "→ " + lab)));
    // 別の月へ（既存の月のみ）
    S.listMonths().then(months => {
      const others = months.filter(mo => mo !== state.month);
      if (!others.length) return;
      menu.append(el("div", { class: "cm-sep" }, "別の月へ（素材コードは未確定に）"));
      const sel = el("select", { class: "cm-monthsel" });
      others.forEach(mo => sel.append(el("option", { value: mo }, window.monthLabel(mo))));
      menu.append(sel);
      menu.append(el("div", { class: "cm-btnrow" },
        el("button", { class: "cm-mini", onclick: () => { copyMoveToMonth(key, id, sel.value, "copy"); closeColMenu(); } }, icon("copy"), " コピー"),
        el("button", { class: "cm-mini", onclick: () => { copyMoveToMonth(key, id, sel.value, "move"); closeColMenu(); } }, icon("arrow-right"), " 移動")));
    });
    const r = anchor.getBoundingClientRect();
    menu.style.left = Math.min(r.left, window.innerWidth - 220) + "px"; menu.style.top = (r.bottom + 2) + "px";
    document.body.append(menu); setTimeout(() => document.addEventListener("click", closeColMenu), 0);
  }
  async function copyMoveToMonth(fromKey, id, targetMonth, mode) {
    if (!state.editing || !targetMonth) return;
    const l = state.model[fromKey]; const i = l.findIndex(x => x.id === id); if (i < 0) return;
    const c = JSON.parse(JSON.stringify(l[i]));
    c.id = uid(); c.codeStatus = "未確定"; c.num = ""; c.officialName = ""; c.testValidated = false; c.compareBaseId = "";
    const raw = await S.readMonth(targetMonth);
    const tgt = normalize(raw ? JSON.parse(JSON.stringify(raw)) : emptyModel(targetMonth));
    tgt.active.push(c); tgt.updatedAt = new Date().toISOString(); tgt.updatedBy = state.user;
    await S.writeMonth(targetMonth, tgt);
    if (mode === "move") {
      l.splice(i, 1);
      state.model.updatedAt = new Date().toISOString(); state.model.updatedBy = state.user;
      await S.writeMonth(state.month, state.model); state.mtime = await S.monthMtime(state.month);
      rerender();
    }
    flash(`${window.monthLabel(targetMonth)} へ${mode === "move" ? "移動" : "コピー"}しました`);
  }

  // ============ Cover Flow（月めくり＋別月へドロップ） ============
  async function cfLoad() {
    const months = (await S.listMonths()).slice().reverse();   // 古い→新しい（左→右）
    const data = [];
    for (const mo of months) { const m = await S.readMonth(mo); const cnt = m ? (m.active || []).filter(x => x.baseName).length : 0; data.push({ month: mo, count: cnt }); }
    cf.data = data;
  }
  async function openCoverflow(dragMode) {
    const ov = $("#coverflow");
    if (cf.opening || ov.classList.contains("open")) return;   // 二重オープン防止（ドラッグ中のカクつき対策）
    cf.opening = true;
    await cfLoad();
    if (!cf.data.length) { cf.opening = false; flash("保存済みの月がありません。まず保存してください。"); return; }
    cf.dragMode = !!dragMode;
    const idx = cf.data.findIndex(d => d.month === state.month);
    cf.sel = idx >= 0 ? idx : cf.data.length - 1;
    renderCF();
    ov.classList.add("open"); ov.classList.toggle("dragmode", !!dragMode); ov.setAttribute("aria-hidden", "false");
    const hint = $("#cfDropHint");
    if (hint) { hint.style.display = dragMode ? "block" : "none"; hint.textContent = "月のカードにドロップで、その月へ移動します（枠の外に出すと、やめます）"; }
    cf.opening = false;
    if (!dragMode) setTimeout(() => $("#cfStage").focus(), 0);
  }
  function closeCoverflow() { const ov = $("#coverflow"); if (ov) { ov.classList.remove("open", "dragmode"); ov.setAttribute("aria-hidden", "true"); } cf.opening = false; }
  function renderCF() {
    const stage = $("#cfStage"), dotsEl = $("#cfDots"); stage.innerHTML = ""; dotsEl.innerHTML = "";
    cf.cards = cf.data.map((d, i) => {
      const c = el("div", { class: "cf-card" + (d.month === state.month ? " here" : ""), "data-month": d.month });
      c.append(el("div", { class: "cf-top" }));
      c.append(el("div", { class: "cf-yr" }, d.month.slice(0, 4) + "年"));
      c.append(el("div", { class: "cf-mo" }, parseInt(d.month.slice(4), 10) + "月"));
      c.append(el("div", { class: "cf-st" }, "施策数 ", el("b", {}, String(d.count))));
      const open = el("button", { class: "cf-open", onclick: e => { e.stopPropagation(); selectMonthFromCF(d.month); } }, d.month === state.month ? "表示中" : "この月を開く ↗");
      c.append(open);
      c.addEventListener("click", () => { if (i !== cf.sel) { cf.sel = i; positionCF(); } });
      c.addEventListener("dragover", e => { if (state.draggingMeasure) { e.preventDefault(); if (cf.sel !== i) { cf.sel = i; positionCF(); } } });
      c.addEventListener("drop", e => { e.preventDefault(); if (state.dragBatch) dropMeasureToMonth(d.month); });
      stage.append(c); return c;
    });
    cf.dots = cf.data.map((d, i) => { const dot = el("div", { class: "cf-dot", onclick: () => { cf.sel = i; positionCF(); } }); dotsEl.append(dot); return dot; });
    positionCF();
  }
  function positionCF() {
    cf.data.forEach((d, i) => {
      const off = i - cf.sel, abs = Math.abs(off);
      const x = off * 100, ry = Math.max(-55, Math.min(55, off * -42)), tz = -abs * 150, sc = off === 0 ? 1 : .85;
      const c = cf.cards[i];
      c.style.transform = `translateX(${x}px) translateZ(${tz}px) rotateY(${ry}deg) scale(${sc})`;
      c.style.zIndex = String(100 - abs); c.style.opacity = abs > 3 ? "0" : "1";
      c.classList.toggle("sel", off === 0);
      if (cf.dots[i]) cf.dots[i].classList.toggle("on", off === 0);
    });
    const d = cf.data[cf.sel];
    $("#cfCur").textContent = d ? `${d.month.slice(0,4)}年 ${parseInt(d.month.slice(4),10)}月 ${cf.dragMode ? "（ここにドロップで移動）" : (d.month===state.month?"（表示中）":"")}` : "";
  }
  async function selectMonthFromCF(month) { closeCoverflow(); if (month === state.month) return; await renderMonthSelect(); $("#monthSelect").value = month; await loadMonth(month); }
  async function dropMeasureToMonth(targetMonth) {
    const canceled = state.dragCanceled;
    const batch = state.dragBatch ? [...state.dragBatch] : [];
    closeCoverflow();                                   // 後片付けは dragend、ここでは移動のみ実行
    if (!canceled && batch.length) { state.dragMoved = true; await moveBatchToMonth(batch, targetMonth); }
  }
  // 行の下に開く詳細（施策の裏側データ：施策概要・特典・RO版FIX）
  function detailRow(key, m) {
    const tr = el("tr", { class: "detail-row" });
    if (state.drawerId === m.id) tr.classList.add("active-detail");
    const cell = el("td", { colspan: String(activeCols().length) });
    // 親と同系の淡色（さらに薄く）で内訳を表示
    const fc = familyColorOf(m);
    if (fc) { cell.style.background = lightenHex(fc.bg, 0.45); cell.style.boxShadow = "inset 4px 0 0 " + fc.band; cell.style.borderBottom = "2px solid " + fc.band; }
    const box = el("div", { class: "detail" });
    const grid = el("div", { class: "detail-grid" });
    // 施策概要（メモ）：普段1行、入力に応じて自動で伸びる
    const wNote = el("div", { class: "dw-field col-note" });
    wNote.append(el("div", { class: "dw-lab" }, "施策概要・メモ"));
    const ta = el("textarea", { class: "d-note", rows: "1", placeholder: "" }); ta.value = m.note || "";
    const grow = () => { ta.style.height = "auto"; ta.style.height = Math.max(30, ta.scrollHeight) + "px"; };
    ta.addEventListener("input", () => { m.note = ta.value; grow(); });
    ta.addEventListener("blur", () => rerenderRow(key, m));
    wNote.append(ta); setTimeout(grow, 0);
    const mk = (label, f, cls, type) => { const w = el("div", { class: "dw-field " + cls }); w.append(el("div", { class: "dw-lab" }, label)); const i = el("input", type ? { value: m[f] || "", type } : { value: m[f] || "", placeholder: "" }); i.addEventListener("input", () => { m[f] = i.value; }); i.addEventListener("blur", () => rerenderRow(key, m)); w.append(i); return w; };
    // 並び：施策概要メモ → 掲載商品 → 特典 → FIX時期
    grid.append(wNote, mk("掲載商品", "products", "col-prod"), mk("特典", "benefit", "col-benefit"), mk("FIX時期", "roFixDate", "col-fix", "date"));
    box.append(grid); cell.append(box); tr.append(cell); return tr;
  }

  function renderIdeas() {
    const wrap = el("section", { class: "sec" });
    wrap.append(el("div", { class: "sec-head" }, el("h2", {}, icon("bulb"), " アイデア候補", el("span",{class:"sec-count"},`${state.model.ideas.length}`)),
      el("button", { class: "btn small ghost", onclick: () => { state.model.ideas.push({ id: uid(), text: "" }); rerender(); } }, "＋ 追加")));
    const box = el("div", { class: "ideas" });
    state.model.ideas.forEach(it => box.append(el("div", { class: "idea" },
      field(it, "text", { class: "w-idea", placeholder: "思いついた企画メモ" }),
      el("button", { class: "iconbtn danger", onclick: () => del("ideas", it.id) }, icon("x")))));
    wrap.append(box);
    return wrap;
  }

  // ===== 施策名ごとの色分け（赤=お誕生日系 / 青=TRS系 / 緑=RAH系。主要は固定・派生は少しずらす） =====
  let familyColors = {};
  const FAMPAL = {
    red:   [{bg:"#fdecec",band:"#e5484d"},{bg:"#fbe7ee",band:"#df3d7a"},{bg:"#fdeee7",band:"#e0682f"},{bg:"#fae9eb",band:"#c53a54"},{bg:"#fdf0ea",band:"#e07a4a"}],
    blue:  [{bg:"#e9f1fe",band:"#2f7ee0"},{bg:"#e6f3fb",band:"#1499c9"},{bg:"#edeffd",band:"#4f63e0"},{bg:"#e6f0f8",band:"#3b74b8"},{bg:"#eaf5ff",band:"#2a8ad0"}],
    green: [{bg:"#eaf6ea",band:"#2fa14a"},{bg:"#eff6e3",band:"#63991f"},{bg:"#e8f5ef",band:"#12a07a"},{bg:"#edf7e7",band:"#4d9a2a"},{bg:"#e9f6ec",band:"#39a15a"}],
    other: [{bg:"#f1f0fb",band:"#6d5ef0"},{bg:"#fdf3e2",band:"#c98a1e"},{bg:"#eef1f5",band:"#7b8794"},{bg:"#f3eefb",band:"#8b5ee0"}],
  };
  const FIXED = { "お誕生日":["red",0], "TRS下取":["blue",0], "TRS下取り":["blue",0], "RAH買い替え":["green",0], "RAH買替":["green",0] };
  // キーワード優先：TRS→青、RAH→緑、（TRS/RAHが無く）お誕生日/誕生→赤、それ以外→other
  function familyOf(name) {
    if (name.indexOf("TRS") >= 0) return "blue";
    if (name.indexOf("RAH") >= 0) return "green";
    if (name.indexOf("お誕生日") >= 0 || name.indexOf("誕生") >= 0) return "red";
    return "other";
  }
  function lightenHex(hex, amt) {
    const h = hex.replace("#", ""); const r = parseInt(h.slice(0,2),16), g = parseInt(h.slice(2,4),16), b = parseInt(h.slice(4,6),16);
    const mix = v => Math.round(v + (255 - v) * amt);
    return `rgb(${mix(r)},${mix(g)},${mix(b)})`;
  }
  function computeFamilyColors() {
    familyColors = {};
    const used = { red: 1, blue: 1, green: 1, other: 0 };   // idx0 は主要施策に予約
    const seen = new Set();
    ["active", "carryNext", "carryFuture"].forEach(k => (state.model[k] || []).forEach(m => {
      const bn = (m.baseName || "").trim(); if (!bn || seen.has(bn)) return; seen.add(bn);
      let fam, idx;
      if (FIXED[bn]) { fam = FIXED[bn][0]; idx = FIXED[bn][1]; }
      else { fam = familyOf(bn); idx = used[fam]++; }
      const pal = FAMPAL[fam]; familyColors[bn] = pal[idx % pal.length];
    }));
  }
  function familyColorOf(m) { const bn = (m.baseName || "").trim(); return bn ? familyColors[bn] : null; }
  // 施策名変更時：全行の色を即時に付け替え（再描画せずフォーカス維持）
  function applyFamilyColors() {
    computeFamilyColors();
    ["active", "carryNext", "carryFuture"].forEach(k => (state.model[k] || []).forEach(m => {
      const tr = document.querySelector(`tr[data-row="${m.id}"]`); if (!tr) return;
      const fc = familyColorOf(m);
      if (fc) { tr.classList.add("fam-row"); tr.style.background = fc.bg; tr.style.setProperty("--band", fc.band); }
      else { tr.classList.remove("fam-row"); tr.style.background = ""; tr.style.removeProperty("--band"); }
      if (state.expanded[m.id]) {
        const det = tr.nextElementSibling;
        if (det && det.classList.contains("detail-row")) {
          const cell = det.querySelector("td");
          if (cell) {
            if (fc) { cell.style.background = lightenHex(fc.bg, 0.45); cell.style.boxShadow = "inset 4px 0 0 " + fc.band; cell.style.borderBottom = "2px solid " + fc.band; }
            else { cell.style.background = ""; cell.style.boxShadow = ""; cell.style.borderBottom = ""; }
          }
        }
      }
    }));
  }

  function renderBody() {
    const root = $("#board"); root.innerHTML = "";
    if (!S.isConnected()) { root.append(el("div", { class: "placeholder" }, "右上「📁 共有フォルダに接続」で、チームの共有フォルダを選んでください。保存データ（各月のJSON）がそこに読み書きされます。")); return; }
    if (!state.model) { root.append(el("div", { class: "placeholder" }, "「対象月」で月を選ぶか、「＋ 新規月」で作成してください。")); return; }
    if (!state.editing && state.selected.size) state.selected.clear();   // 閲覧モードでは選択を解除
    computeFamilyColors();
    root.append(renderMeasureSection("active", "今月実施（施策）", "calendar-check"));
    root.append(renderMeasureSection("carryNext", "次月持越し", "arrow-forward-up"));
    root.append(renderMeasureSection("carryFuture", "今後へ持越し", "clock"));
    root.append(renderIdeas());
  }
  function rerender() { renderSummary(); renderBody(); renderLockBar(); updateSavedAt(); updateTitle(); updateSelBar(); }
  function updateTitle() { const e = $("#planTitle"); if (!e) return; e.textContent = state.model ? (state.model.title || "") : ""; }

  // ============ 行操作 ============
  function move(key, id, d) { if (!state.editing) return; const l = state.model[key]; const i = l.findIndex(x=>x.id===id), j=i+d; if(i<0||j<0||j>=l.length)return; [l[i],l[j]]=[l[j],l[i]]; rerender(); }
  function del(key, id) { if (!state.editing) return; const l = state.model[key]; const i = l.findIndex(x=>x.id===id); if(i>=0){l.splice(i,1);state.selected.delete(id);rerender();} }
  function sortByPriority() {
    if (!state.editing) return;
    const scored = state.model.active.filter(m => m.baseName || m.num);
    // AIを先（既ロは後）／その中で P3/List の高い順 → 高いものが優先度1
    scored.sort((x, y) => {
      const ax = x.listMethod === "AI" ? 0 : 1, ay = y.listMethod === "AI" ? 0 : 1;
      if (ax !== ay) return ax - ay;
      return (parseFloat(y.p3) || 0) - (parseFloat(x.p3) || 0);
    });
    scored.forEach((m, i) => m.priority = i + 1);
    rerender(); flash("AI優先→P3/List高い順で優先度1から振りました");
  }

  // ============ フィールド入力（再描画せず） ============
  function onInput(e) {
    const t = e.target, id = t.getAttribute("data-id"), f = t.getAttribute("data-field");
    if (!id || !f || !state.model) return;
    let item = null;
    for (const k of ["active","carryNext","carryFuture","ideas"]) { item = state.model[k].find(x=>x.id===id); if(item)break; }
    if (!item) return;
    item[f] = t.value;
    if (f === "kind") { rerenderRow(sectionOf(item), item); refreshAllNames(); renderSummary(); return; }
    if (f === "category") { const cc = document.querySelector(`[data-code="${id}"]`); if (cc) renderCodeCell(cc, item); }
    if (f === "num") { const cv = document.querySelector(`[data-code="${id}"] .codeval`); if (cv) cv.textContent = window.buildMaterialCode(window.prefixOfCategory(item.category), item.num) || "—"; }
    if (f === "baseName") { refreshAllNames(); applyFamilyColors(); }   // 採番＋色を即時更新
    else if (["category", "num", "media", "codeStatus"].includes(f)) { const nin = document.querySelector(`[data-derived="${id}"] .namein`); if (nin && !(item.officialName && item.officialName.trim())) nin.value = derive(item, state.month).fullName; }
    if (f === "estimatedCount") renderSummary();
  }

  // ============ ドロワー（リスト条件） ============
  function findMeasure(id){ for(const k of ["active","carryNext","carryFuture"]){const m=state.model[k].find(x=>x.id===id);if(m)return m;} return null; }
  function openDrawer(id) {
    const m = findMeasure(id); if (!m) return;
    state.drawerId = id;
    document.querySelectorAll("tr.active-row, tr.active-detail").forEach(t => t.classList.remove("active-row", "active-detail"));
    const tr = document.querySelector(`tr[data-row="${id}"]`);
    if (tr) { tr.classList.add("active-row"); const det = tr.nextElementSibling; if (det && det.classList.contains("detail-row")) det.classList.add("active-detail"); }
    $("#drawer").classList.add("open"); $("#drawerScrim").classList.add("open");
    renderDrawer(m);
  }
  function closeDrawer(){ state.drawerId=null; document.querySelectorAll("tr.active-row, tr.active-detail").forEach(t => t.classList.remove("active-row", "active-detail")); $("#drawer").classList.remove("open"); $("#drawerScrim").classList.remove("open"); }
  // 自己トグル式チップ：クリックで自分の on クラスを切替え、cb(新状態) を呼ぶ（editing時のみ）
  function chip(label, on, cb, cls){
    const b = el("button", { class: "pill " + (on?"on ":"") + (cls||"") }); b.textContent = label;
    b.addEventListener("click", () => { if (!state.editing) return; const next = !b.classList.contains("on"); b.classList.toggle("on", next); cb(next); });
    return b;
  }
  function setIn(arr, v, on){ const i = arr.indexOf(v); if (on && i<0) arr.push(v); else if (!on && i>=0) arr.splice(i,1); }

  function renderDrawer(m) {
    const d = $("#drawerBody"); d.innerHTML = "";
    const c = m.cond;
    // ドロワー内は直接バインド（#board のリスナ対象外のため）
    const dfield = (obj, f, attrs, cb) => { const e = el("input", Object.assign({ value: obj[f] ?? "" }, attrs)); e.addEventListener("input", () => { obj[f] = e.value; if (cb) cb(); }); return e; };
    const dpick = (obj, f, opts, cb) => { const s = el("select", {}); opts.forEach(o => { const op = el("option", { value: o }, o); if ((obj[f] ?? "") === o) op.selected = true; s.append(op); }); s.addEventListener("change", () => { obj[f] = s.value; if (cb) cb(); }); return s; };
    const refreshName = () => { setDrawerHead(m); rerenderRow(sectionOf(m), m); };
    const onChange = () => { renderSeg(); updateCmpBanner(m); rerenderRow(sectionOf(m), m); renderSummary(); };

    setDrawerHead(m);

    // ---- 絞込み条件（先頭）----
    const cond = el("div", {});
    const prodBox = el("div", { class: "dw-prod" });
    function renderProd() {
      prodBox.innerHTML = "";
      c.products.forEach((p, i) => {
        prodBox.append(el("div", { class: "prod-row" },
          pick2(p, "group", M.productGroups.map(g=>g.name), () => { renderProd(); onChange(); }),
          seg2(p, "mode", ["買った","買ってない"], () => onChange()),
          seg2(p, "unit", ["グループ","シリーズ"], () => onChange()),
          el("button", { class: "iconbtn danger", title: "この商品条件を削除", onclick: () => { if (!state.editing) return; c.products.splice(i,1); renderProd(); onChange(); } }, icon("trash"))));
      });
      prodBox.append(el("button", { class: "btn tiny ghost", onclick: () => { if (!state.editing) return; c.products.push({ group: M.productGroups[0].name, mode: "買った", unit: "グループ" }); renderProd(); onChange(); } }, "＋ 商品条件"));
    }
    renderProd();
    cond.append(labeled("購入商品／グループ", prodBox));

    const ageBox = el("div", { class: "pills" });
    M.ages.forEach(a => ageBox.append(chip(a, c.ages.includes(a), on => { setIn(c.ages, a, on); onChange(); })));
    cond.append(labeled("年代", ageBox));

    // 経過基準（D と R は排他）
    const basisBox = el("div", { class: "dw-inline" });
    const cur = c.dUse ? "D" : (c.rUse ? "R" : "なし");
    [["D","D 配達完了経過"],["R","R 商品購入経過"],["なし","使わない"]].forEach(([k,lab]) => {
      const b = el("button", { class: "pill " + (cur===k?"on":"") }); b.textContent = lab;
      b.addEventListener("click", () => { if (!state.editing) return; c.dUse = (k==="D"); c.rUse = (k==="R"); renderDrawer(m); onChange(); });
      basisBox.append(b);
    });
    if (c.dUse) basisBox.append(el("span",{class:"tilde"},"："), numSel(c,"dFrom",1,8,"D",onChange), el("span",{class:"tilde"},"〜"), numSel(c,"dTo",1,8,"D",onChange));
    if (c.rUse) basisBox.append(el("span",{class:"tilde"},"："), numSel(c,"rFrom",1,8,"R",onChange), el("span",{class:"tilde"},"〜"), numSel(c,"rTo",1,8,"R",onChange));
    cond.append(labeled("経過基準（D=配達完了経過 / R=商品購入経過。どちらか一方）", basisBox));

    const fBox = el("div", { class: "pills" });
    M.fValues.forEach(f => fBox.append(chip(f, c.f.includes(f), on => { setIn(c.f, f, on); onChange(); })));
    cond.append(labeled("F（購入回数）", fBox));

    const etc = el("div", { class: "dw-inline" });
    etc.append(dpick(c, "gender", M.genders, onChange));
    etc.append(chip("メール便地域のみ(一都三県)", c.mailArea, on => { c.mailArea = on; onChange(); }));
    etc.append(chip("当月お誕生月", c.birthMonth, on => { c.birthMonth = on; onChange(); }));
    cond.append(labeled("その他（性別・メール便・お誕生月）", etc));
    d.append(section("絞込み条件", cond));

    // ---- 比較・テスト検証（テストのみ）----
    if (m.kind === "テスト") d.append(section("比較・テスト検証（比較元と同じ条件か）", renderCompare(m)));

    // ---- 除外条件（折りたたみ）----
    const ex = el("div", {});
    const exC = el("div", { class: "pills" });
    M.exclCommon.forEach(e => exC.append(chip(e.label + (e.auto ? " 🪄" : ""), m.excl.common[e.key], on => { m.excl.common[e.key] = on; }, "ex")));
    ex.append(labeled("共通（🪄=素材コードから自動生成）", exC));
    ex.append(labeled("前月発送PIN 除外モード", dpick(m.excl, "zengetsuMode", M.zengetsuModes)));
    const exP = el("div", { class: "pills" });
    M.exclPerMeasure.forEach(e => exP.append(chip(e.label, m.excl.per[e.key], on => { m.excl.per[e.key] = on; }, "ex")));
    ex.append(labeled("施策別", exP));
    const onCount = M.exclCommon.filter(e=>m.excl.common[e.key]).length + M.exclPerMeasure.filter(e=>m.excl.per[e.key]).length;
    d.append(collapsible(`除外条件（${onCount}件ON・普段は固定。開いて調整）`, ex, false));

    // ---- セグメント自動展開 ----
    const segWrap = el("div", { class: "seg-wrap" });
    segWrap.append(el("div", { class: "seg-top" }, el("span", {}, "年代 × D/R × F を自動展開"), el("span", { class: "seg-cnt", id: "segCnt" }, "")));
    segWrap.append(el("div", { class: "seg-scroll" }, el("table", { class: "seg", id: "segTbl" })));
    d.append(section("自動生成された母数セグメント", segWrap));

    function renderSeg() {
      const rows = segments(m);
      const cntEl = document.getElementById("segCnt"); if (cntEl) cntEl.textContent = `${rows.length} 件`;
      const tbl = document.getElementById("segTbl"); if (!tbl) return;
      tbl.innerHTML = "";
      const hr = el("tr", {}); ["優先","セグメント名","年代","D/R","F"].forEach(h => hr.append(el("th", {}, h)));
      tbl.append(el("thead", {}, hr));
      const tb = el("tbody", {});
      rows.slice(0, 80).forEach(r => tb.append(el("tr", {}, el("td",{class:"muted"},String(r.i)), el("td",{},r.name), el("td",{},r.age), el("td",{},r.d), el("td",{},r.f))));
      if (rows.length > 80) tb.append(el("tr", {}, el("td", { colspan: "5", class: "muted" }, `…他 ${rows.length-80} 件`)));
      tbl.append(tb);
    }
    renderSeg(); updateCmpBanner(m);
  }

  // 比較（🍎×🍎）UI：セレクト＋バナー枠（バナー中身は updateCmpBanner でライブ更新）
  function renderCompare(m) {
    const box = el("div", {});
    box.append(el("div", { class: "cmp-help" }, "先に条件を決めたRO等を「比較元」に選ぶと、この施策の条件と自動照合します。内容をチームで確認し、下の「テスト検証OK」を押すと表のOK/NGに反映されます。"));
    // 比較元は「対象月に入力済み（名前あり）の施策」だけを、正式名候補（RO①②等）で出す（空の初期行は除外）
    const list = state.model.active.concat(state.model.carryNext, state.model.carryFuture).filter(x => x.id !== m.id && x.baseName && x.baseName.trim());
    const sel = el("select", {});
    sel.append(el("option", { value: "" }, "（比較しない・新規はこのままでOK）"));
    list.forEach(x => sel.append(el("option", { value: x.id }, derive(x, state.month).fullName)));
    sel.value = m.compareBaseId || "";
    sel.addEventListener("change", () => { if (!state.editing) return; m.compareBaseId = sel.value; updateCmpBanner(m); rerenderRow(sectionOf(m), m); });
    box.append(labeled("比較元（RO/テスト どれでも可）", sel));
    box.append(el("div", { id: "cmpBanner" }));
    const scope = el("input", { value: m.compareScope ?? "", placeholder: "例：AI一軍のみで比較", style: "width:100%" });
    scope.addEventListener("input", () => { m.compareScope = scope.value; });
    box.append(labeled("備考（任意メモ）", scope));
    // テストのみ：チーム確認後に押す「テスト検証OK」（表のOK/NGと連動）
    if (m.kind === "テスト") {
      const btn = el("button", { class: "valid-big " + (m.testValidated ? "ok" : "pend") });
      btn.textContent = m.testValidated ? "✓ テスト検証OK（クリックで NG に戻す）" : "テスト検証OK にする（チーム確認後）";
      btn.addEventListener("click", () => { if (!state.editing) return; m.testValidated = !m.testValidated; renderDrawer(m); rerenderRow(sectionOf(m), m); renderSummary(); flash(m.testValidated ? "検証OKにしました" : "NG（未検証）に戻しました"); });
      box.append(labeled("テスト検証（表のOK/NGと連動）", btn));
    }
    return box;
  }
  function setDrawerHead(m) {
    const h = document.querySelector("#drawer .drawer-h-title"); if (!h) return;
    h.innerHTML = ""; const dv = derive(m, state.month);
    h.append(el("div", { class: "dh-name" }, dv.fullName), el("div", { class: "dh-sub" }, `${m.baseName||"(名称未設定)"}・${m.kind}・${m.listMethod}`));
  }
  function updateCmpBanner(m) {
    const box = document.getElementById("cmpBanner"); if (!box) return; box.innerHTML = "";
    const info = compareInfo(m); if (!info) { box.append(el("div", { class: "cmp cmp-idle" }, "比較元は未設定です。")); return; }
    if (info.missing) { box.append(el("div", { class: "cmp cmp-warn" }, "⚠ 比較元が見つかりません")); return; }
    if (info.ok) { box.append(el("div", { class: "cmp cmp-ok" }, "✔ 自動照合：比較元と条件が一致しています")); return; }
    const w = el("div", { class: "cmp cmp-ng" }, `⚠ 自動照合：比較元と条件が違います → ${info.diffs.join("・")}`);
    const btn = el("button", { class: "btn tiny", onclick: () => { if (!state.editing) return; m.cond = JSON.parse(JSON.stringify(info.base.cond)); renderDrawer(m); rerenderRow(sectionOf(m), m); flash("比較元に条件を合わせました"); } }, "比較元に条件を合わせる");
    box.append(w, btn);
  }
  function sectionOf(m){ for(const k of ["active","carryNext","carryFuture"]) if(state.model[k].includes(m)) return k; return "active"; }

  // ドロワー用の小物
  function labeled(label, node){ return el("div", { class: "dw-field" }, el("div", { class: "dw-lab" }, label), node); }
  function section(title, node){ return el("div", { class: "dw-sec" }, el("div", { class: "dw-sec-h" }, title), node); }
  function collapsible(title, node, open){ const dt = el("details", { class: "dw-collapse" }); if (open) dt.setAttribute("open",""); dt.append(el("summary", {}, title), node); return dt; }
  function toggle(arr, v){ const i = arr.indexOf(v); if (i>=0) arr.splice(i,1); else arr.push(v); }
  function numSel(obj, f, a, b, prefix, cb){ const s = el("select", {}); for(let i=a;i<=b;i++){const o=el("option",{value:i},prefix+i); if(obj[f]==i)o.selected=true; s.append(o);} s.addEventListener("change", ()=>{obj[f]=parseInt(s.value,10); if(cb)cb();}); return s; }
  function pick2(obj, f, opts, cb){ const s=el("select",{}); opts.forEach(o=>{const op=el("option",{value:o},o); if(obj[f]===o)op.selected=true; s.append(op);}); s.addEventListener("change",()=>{obj[f]=s.value; if(cb)cb();}); return s; }
  function seg2(obj, f, opts, cb){ const box=el("div",{class:"seg2"}); opts.forEach(o=>{ const b=el("button",{class:"pill small "+(obj[f]===o?"on":""),onclick:()=>{obj[f]=o; box.querySelectorAll(".pill").forEach(x=>x.classList.remove("on")); b.classList.add("on"); if(cb)cb();}},o); box.append(b);}); return box; }

  // ============ 月の読み書き ============
  async function loadMonth(month) {
    if (!month) return;
    state.month = month; state.selected.clear();
    state.model = normalize((await S.readMonth(month)) || emptyModel(month));
    state.model.title = window.monthLabel(month) + " DM施策";   // タイトルは対象月から自動
    state.mtime = await S.monthMtime(month); state.editing = false; closeDrawer();
    rerender(); startPolling();
  }
  async function startEditing() {
    if (state.editing) { await S.clearLock(state.month); state.editing = false; rerender(); return; }
    if (!S.isConnected()) { alert("共有フォルダに未接続です。右上「共有フォルダに接続」で共有フォルダを選んでから編集してください。"); return; }
    if (!state.model) { alert("先に「対象月」で月を選ぶか、「＋新規月」で作成してください。"); return; }
    if (!state.user) { alert("先に右上のお名前を入力してください。"); return; }
    const lock = await S.readLock(state.month);
    if (lock && lock.user !== state.user) { alert(`${lock.user} さんが編集中です。`); return; }
    await S.writeLock(state.month, { user: state.user, ts: Date.now() });
    state.editing = true; rerender();
  }
  async function save() {
    if (!state.editing || !state.model) return;
    if (!S.isConnected()) { alert("共有フォルダに未接続のため保存できません。右上「共有フォルダに接続」で共有フォルダを選んでください。"); return; }
    state.model.updatedAt = new Date().toISOString(); state.model.updatedBy = state.user;
    await S.writeMonth(state.month, state.model);
    state.mtime = await S.monthMtime(state.month); updateSavedAt(); flash("保存しました");
  }
  // ---- モーダル ----
  function closeModal() { const s = document.getElementById("modalScrim"); if (s) s.remove(); }
  function openModal(title, bodyNode) {
    closeModal();
    const scrim = el("div", { class: "modal-scrim", id: "modalScrim" });
    const box = el("div", { class: "modal" });
    box.append(el("div", { class: "modal-head" }, el("div", { class: "modal-title" }, title), el("button", { class: "iconbtn", onclick: closeModal }, "✕")));
    box.append(el("div", { class: "modal-body" }, bodyNode));
    scrim.append(box);
    scrim.addEventListener("click", e => { if (e.target === scrim) closeModal(); });
    document.body.append(scrim);
  }
  async function newMonth() {
    if (!S.isConnected()) { alert("共有フォルダに未接続です。右上「共有フォルダに接続」で共有フォルダを選んでから作成してください。"); return; }
    const months = await S.listMonths();
    const body = el("div", {});
    const monthInp = el("input", { class: "modal-in", placeholder: "例：202611", maxlength: "6", inputmode: "numeric" });
    body.append(labeled("発送年月（6桁）", monthInp));
    const srcSel = el("select", { class: "modal-in" });
    srcSel.append(el("option", { value: "" }, "空で作成（コピーしない）"));
    months.forEach(mo => srcSel.append(el("option", { value: mo }, `${window.monthLabel(mo)} をコピー`)));
    if (months.length) srcSel.value = months[0];   // 既定＝最新月
    body.append(labeled("コピー元の月（素材コードは未確定に戻ります）", srcSel));
    const err = el("div", { class: "modal-err" });
    const create = async () => {
      const m = monthInp.value.trim(); err.textContent = "";
      if (!window.isValidMonth(m)) { err.textContent = "6桁の数字で入力してください（例：202611）"; return; }
      if (await S.readMonth(m)) { err.textContent = "その月は既にあります。上部の「対象月」から開いてください。"; return; }
      let model = emptyModel(m);
      const src = srcSel.value;
      if (src) {
        const s = await S.readMonth(src);
        if (s) {
          model = normalize(JSON.parse(JSON.stringify(s)));
          model.month = m; model.title = window.monthLabel(m) + " DM施策"; model.updatedAt = ""; model.updatedBy = "";
          ["active","carryNext","carryFuture"].forEach(k => (model[k]||[]).forEach(it => { it.id = uid(); it.codeStatus = "未確定"; it.num = ""; it.officialName = ""; }));
          (model.ideas||[]).forEach(it => it.id = uid());
        }
      }
      await S.writeMonth(m, model); closeModal(); await renderMonthSelect(); $("#monthSelect").value = m; await loadMonth(m); flash("新規月を作成しました");
    };
    monthInp.addEventListener("keydown", e => { if (e.key === "Enter") create(); });
    body.append(err, el("div", { class: "modal-actions" }, el("button", { class: "btn primary", onclick: create }, "作成")));
    openModal("新規月を作成", body);
    setTimeout(() => monthInp.focus(), 0);
  }

  function startPolling() {
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = setInterval(async () => {
      if (!state.month) return; await renderLockBar();
      if (state.editing) return;
      const mt = await S.monthMtime(state.month);
      if (mt && mt !== state.mtime) { state.model = normalize((await S.readMonth(state.month)) || state.model); state.mtime = mt; rerender(); flash("最新の内容に更新しました"); }
    }, 5000);
  }
  let ft; function flash(msg){ const t=$("#toast"); t.textContent=msg; t.classList.add("show"); clearTimeout(ft); ft=setTimeout(()=>t.classList.remove("show"),2000); }

  async function init() {
    dl("dl-own", getOwners());
    dl("dl-base", ["お誕生日","TRS下取","TRS下取りお誕生日","TRS下取WOW","RAH買い替え","RAH買い替えお誕生日","複数掲載","お誕生日ベースTRS下取り"]);
    dl("dl-prod", M.products);
    renderHeader();
    // 担当を手入力で確定したら候補に自動追加
    $("#board").addEventListener("change", e => { const t = e.target; if (t && t.getAttribute && t.getAttribute("data-field") === "owner") addOwner(t.value); });
    $("#userName").addEventListener("change", e => { state.user = e.target.value.trim(); localStorage.setItem("dmplan:user", state.user); });
    $("#connectBtn").addEventListener("click", async () => {
      try {
        await S.connectFolder(); renderHeader(); await renderMonthSelect(); flash("共有フォルダに接続しました");
        const ms = await S.listMonths();
        if (ms.length) { $("#monthSelect").value = ms[0]; await loadMonth(ms[0]); } else { renderBody(); renderLockBar(); }
      } catch (e) { alert(e.message); }
    });
    $("#monthSelect").addEventListener("change", e => e.target.value && loadMonth(e.target.value));
    $("#newMonthBtn").addEventListener("click", newMonth);
    // Cover Flow（月めくり）
    $("#cfBtn").addEventListener("click", () => openCoverflow(false));
    $("#cfClose").addEventListener("click", closeCoverflow);
    $("#coverflow").addEventListener("click", e => { if (e.target.id === "coverflow") closeCoverflow(); });
    // 「月をめくる」の枠の外側をクリックしたら閉じる（ドラッグ移動中は除く）
    document.addEventListener("mousedown", e => {
      const ov = $("#coverflow");
      if (!ov || !ov.classList.contains("open")) return;
      if (state.draggingMeasure || cf.dragMode) return;
      if (ov.contains(e.target)) return;
      if (e.target.closest && e.target.closest("#cfBtn")) return;
      closeCoverflow();
    });
    // ドラッグ中に上部ホットゾーンへ入ると Cover Flow を開く（別月へドロップ）。再入場でキャンセルを解除
    $("#cfHot").addEventListener("dragover", e => { if (state.draggingMeasure) { e.preventDefault(); state.dragCanceled = false; openCoverflow(true); } });
    $("#cfHot").addEventListener("dragenter", e => { if (state.draggingMeasure) e.preventDefault(); });
    // Cover Flow を開いてドラッグ中に、その枠の外へ出たら「移動をやめる」（枠外ドロップ＝キャンセル）
    document.addEventListener("dragover", e => {
      if (!cf.dragMode) return;
      const ov = $("#coverflow"); if (!ov || !ov.classList.contains("open")) return;
      const r = ov.getBoundingClientRect(); const pad = 24;
      const inside = e.clientX >= r.left - pad && e.clientX <= r.right + pad && e.clientY >= r.top - pad && e.clientY <= r.bottom + pad;
      if (!inside) { if (!state.dragCanceled) { state.dragCanceled = true; flash("枠の外に出たので、移動をやめました（元の場所のまま）"); } closeCoverflow(); cf.dragMode = false; }
    });
    // ステージのドラッグscrub / キー操作（施策ドラッグ中はscrubしない）
    (() => {
      const st = $("#cfStage"); let down = false, sx = 0, ss = 0;
      st.addEventListener("pointerdown", e => { if (state.draggingMeasure) return; down = true; sx = e.clientX; ss = cf.sel; st.setPointerCapture(e.pointerId); });
      st.addEventListener("pointermove", e => { if (!down) return; const d = Math.round((sx - e.clientX) / 58); const ns = Math.max(0, Math.min(cf.data.length - 1, ss + d)); if (ns !== cf.sel) { cf.sel = ns; positionCF(); } });
      st.addEventListener("pointerup", () => { down = false; });
      st.addEventListener("keydown", e => { if (e.key === "ArrowLeft" && cf.sel > 0) { cf.sel--; positionCF(); } if (e.key === "ArrowRight" && cf.sel < cf.data.length - 1) { cf.sel++; positionCF(); } if (e.key === "Enter" && cf.data[cf.sel]) selectMonthFromCF(cf.data[cf.sel].month); if (e.key === "Escape") closeCoverflow(); });
      st.addEventListener("wheel", e => { e.preventDefault(); if (e.deltaY > 0 && cf.sel < cf.data.length - 1) { cf.sel++; positionCF(); } else if (e.deltaY < 0 && cf.sel > 0) { cf.sel--; positionCF(); } }, { passive: false });
    })();
    $("#editBtn").addEventListener("click", startEditing);
    $("#saveBtn").addEventListener("click", save);
    $("#board").addEventListener("input", onInput);
    // Enterで真下の同じ列へ移動（表計算風）
    $("#board").addEventListener("keydown", e => {
      if (e.key !== "Enter" || e.isComposing) return;
      const t = e.target;
      if (!t.matches || !t.matches("input") || t.type === "date") return;
      const td = t.closest("td"), tr = t.closest("tr[data-row]"); if (!td || !tr) return;
      const idx = [...tr.children].indexOf(td);
      let next = tr.nextElementSibling;
      while (next && !next.matches("tr[data-row]")) next = next.nextElementSibling;
      if (!next || !next.children[idx]) return;
      const inp = next.children[idx].querySelector("input, select");
      if (inp) { e.preventDefault(); inp.focus(); try { inp.select && inp.select(); } catch (_) {} }
    });
    $("#drawerClose").addEventListener("click", closeDrawer);
    $("#drawerScrim").addEventListener("click", closeDrawer);
    window.addEventListener("beforeunload", () => { if (state.editing) S.clearLock(state.month); });
    if (S.supported) { try { await S.tryRestore(); renderHeader(); } catch (e) {} }
    await renderMonthSelect();
    if (S.isConnected()) {
      const months = await S.listMonths();
      if (months.length) await loadMonth(months[0]); else { renderBody(); renderLockBar(); }
    } else { renderBody(); renderLockBar(); }
  }
  document.addEventListener("DOMContentLoaded", init);
})();
