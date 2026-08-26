// app.js v2 — DM企画サマリー（企画サマリー基盤＋履歴）
(function () {
  "use strict";
  const M = window.MASTERS;
  const S = window.Storage;
  const DEFAULT_ROWS = 15;

  const state = {
    user: localStorage.getItem("dmplan:user") || "",
    month: null, model: null, mtime: 0, editing: false, pollTimer: null,
    sort: { field: "", dir: "asc" }, filters: {}, dragId: null, dragKey: null,
    expanded: {}, showCode: false, showP3: false, showLP: false, showTest: false,
    draggingMeasure: false, dragMeasure: null,
    selected: new Set(), dragBatch: null, dragCanceled: false, dragFromSel: false, dragMoved: false,
    dropOverId: null, dropAfter: false, dragCheckOn: null,
    saveError: "", dirty: false,
  };
  const cf = { data: [], cards: [], dots: [], sel: 0, dragMode: false, opening: false };
  let saving = false, autoTimer = null;   // 自動保存の状態
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
      if (parts.length > 1) { const num = parseFloat(s); if (!isNaN(num)) return num.toFixed(1); }   // 小数第1位まで表示
      return intp;
    }
    const n = parseInt(s, 10); return isNaN(n) ? "" : n.toLocaleString();
  }

  // 保存日時の表示
  function formatDT(iso) { if (!iso) return ""; const d = new Date(iso); const p = n => String(n).padStart(2, "0"); return `${d.getFullYear()}/${p(d.getMonth()+1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; }
  function updateSavedAt() {
    const e = $("#savedAt"); if (!e) return;
    if (saving) { e.className = "saved-at saving"; e.textContent = "保存中…"; return; }
    if (state.saveError) { e.className = "saved-at err"; e.textContent = "⚠ 保存できません：" + state.saveError; e.title = state.saveError; return; }
    if (state.model && state.model.updatedAt) { e.className = "saved-at ok"; e.textContent = `✓ 自動保存済み ${formatDT(state.model.updatedAt)}${state.model.updatedBy ? "（" + state.model.updatedBy + "）" : ""}`; }
    else { e.className = "saved-at"; e.textContent = state.editing ? "自動保存されます" : ""; }
  }

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
      kind: "RO", variant: "", media: "発送DM", listMethod: "AI", delivery: "郵便のみ", lp: "×", p3: "", priority: "",
      estimatedCount: "", products: "", benefit: "", note: "", roFixDate: "", officialName: "",
      supplement: "", origCode1: "", origCode2: "",
      compareBaseId: "", compareScope: "", testValidated: false, highlight: false, cond: emptyCond(), excl: emptyExcl() };
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
      if (x.highlight == null) x.highlight = false;
      if (!x.delivery) x.delivery = "郵便のみ";
      if (!x.lp) x.lp = "×";
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
    const view = $("#viewBtn"), edit = $("#editBtn"), note = $("#lockNote");
    if (note) { note.textContent = ""; note.className = "lock-note"; }
    const setMode = (editing) => { if (edit) edit.classList.toggle("on", editing); if (view) view.classList.toggle("on", !editing); };
    // 未接続：閲覧のみ・編集不可
    if (!S.isConnected()) {
      setMode(false); if (edit) edit.disabled = true; if (view) view.disabled = true;
      if (note) { note.className = "lock-note"; note.append(icon("folder"), " 共有フォルダに接続してください"); }
      document.body.classList.add("readonly"); return;
    }
    const lock = state.month ? await S.readLock(state.month) : null;
    const mine = lock && lock.user === state.user;
    if (state.editing) {
      setMode(true); if (edit) edit.disabled = false; if (view) view.disabled = false;
    } else {
      setMode(false); if (view) view.disabled = false;
      const otherLocked = lock && !mine;
      if (edit) edit.disabled = !state.model || otherLocked;
      if (otherLocked && note) { note.className = "lock-note locked"; note.append(icon("lock"), ` ${lock.user} さんが使用しています（閲覧のみ）`); }
    }
    document.body.classList.toggle("readonly", !state.editing);
  }
  function renderSummary() {
    const box = $("#summary"); if (!state.model) { box.innerHTML = ""; return; }
    // 名前が入っている施策だけを集計（実施○×には依存しない）
    const a = state.model.active.filter(m => m.baseName && m.baseName.trim());
    const ro = a.filter(m => m.kind === "RO").length, test = a.filter(m => m.kind === "テスト").length;
    const cnt = a.reduce((s, m) => s + (parseInt(m.estimatedCount, 10) || 0), 0);
    box.innerHTML = "";
    const chipEl = (l, v) => el("div", { class: "chip" }, el("span", { class: "chip-v" }, String(v)), el("span", { class: "chip-l" }, l));
    box.append(chipEl("施策数（全体）", a.length), chipEl("RO本数", ro), chipEl("テスト本数", test), chipEl("想定件数 合計", cnt.toLocaleString()));
    box.append(el("div", { class: "sum-spacer" }));
    // 今月実施セクションの操作（見出しを廃止したのでここに集約）
    const tools = el("div", { class: "sum-tools" });
    const anyFilter = ["baseName","owner","kind","listMethod","delivery","lp"].some(f => state.filters[f] != null);
    if (state.sort.field || anyFilter) tools.append(el("button", { class: "btn small ghost", title: "並び替え・絞り込みを解除", onclick: () => { state.sort = { field: "", dir: "asc" }; state.filters = {}; rerender(); } }, icon("filter-off"), " 解除"));
    tools.append(el("button", { class: "btn small toggle" + (state.showP3 ? " on" : ""), title: state.showP3 ? "P3/List・優先 を非表示" : "P3/List・優先 を表示", onclick: () => { state.showP3 = !state.showP3; rerender(); } }, icon(state.showP3 ? "eye" : "eye-off"), " P3/List・優先"));
    tools.append(el("button", { class: "btn small toggle" + (state.showCode ? " on" : ""), title: state.showCode ? "素材コード を非表示" : "素材コード を表示", onclick: () => { state.showCode = !state.showCode; rerender(); } }, icon(state.showCode ? "eye" : "eye-off"), " 素材コード"));
    tools.append(el("button", { class: "btn small toggle" + (state.showLP ? " on" : ""), title: state.showLP ? "LP作成 を非表示" : "LP作成 を表示", onclick: () => { state.showLP = !state.showLP; rerender(); } }, icon(state.showLP ? "eye" : "eye-off"), " LP"));
    tools.append(el("button", { class: "btn small toggle" + (state.showTest ? " on" : ""), title: state.showTest ? "テスト検証 を非表示" : "テスト検証 を表示", onclick: () => { state.showTest = !state.showTest; rerender(); } }, icon(state.showTest ? "eye" : "eye-off"), " テスト検証"));
    tools.append(el("button", { class: "btn small", onclick: sortByPriority, title: "AI施策を先に、P3/Listが高い順に優先度1から振る" }, "P3/Listで優先度を設定"));
    tools.append(el("button", { class: "btn small ghost", title: "表示中の順に、正式名を1行1施策でコピー（案件共有シートへそのまま貼り付け可）", onclick: copyAllOfficialNames }, icon("copy"), " 正式名を一括コピー"));
    tools.append(el("button", { class: "btn small ghost", title: "表示中の順に、想定件数を1行1施策でコピー", onclick: copyAllCounts }, icon("copy"), " 件数を一括コピー"));
    tools.append(el("button", { class: "btn small ghost", title: "表示中の順に、担当を1行1施策でコピー", onclick: copyAllOwners }, icon("copy"), " 担当を一括コピー"));
    box.append(tools, el("span", { id: "savedAt", class: "saved-at" }));
    updateSavedAt();
  }

  // ============ 施策テーブル ============
  // 列定義（f=フィールド, type=ソート/フィルタの型, cat=カテゴリ絞り込み対象）
  const COLS = [
    { t: "No." }, { t: "" },
    { t: "施策名", f: "baseName", type: "cat" },
    { t: "担当", f: "owner", type: "cat" },
    { t: "種別", f: "kind", type: "cat" },
    { t: "取得", f: "listMethod", type: "cat" },
    { t: "送付", f: "delivery", type: "cat" },
    { t: "P3/List", title: "P3/List", f: "p3", type: "num", hideGroup: "p3" },
    { t: "優先", f: "priority", type: "num", hideGroup: "p3" },
    { t: "件数", title: "想定件数", f: "estimatedCount", type: "num" },
    { t: "素材コード", key: "code", hideGroup: "code", title: "素材コード（正式名の候補）" },
    { t: "正式名（編集可）" },
    { t: "LP", title: "LP作成（○＝作る／×＝作らない）", f: "lp", type: "cat", hideGroup: "lp" },
    { t: "テスト検証", hideGroup: "test" },
    { t: "" },
  ];
  function passFilters(m) {
    for (const f of ["baseName", "owner", "kind", "listMethod", "delivery", "lp"]) {
      const allow = state.filters[f];
      if (allow != null && !allow.includes(m[f] || "")) return false;
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
    if (c.hideGroup === "lp") return state.showLP;
    if (c.hideGroup === "test") return state.showTest;
    return true;
  }
  function activeCols() { return COLS.filter(colVisible); }
  function renderMeasureSection(key, label, icn) {
    const list = state.model[key];
    const wrap = el("section", { class: "sec" });
    // 今月実施(active)は見出しを廃止（集計バーに統合）。持越しセクションのみ見出しを表示
    if (key !== "active") {
      const head = el("div", { class: "sec-head" }, el("h2", {}, icon(icn), " " + label, el("span", { class: "sec-count" }, `${list.length}`)));
      const anyFilter = ["baseName","owner","kind","listMethod","delivery","lp"].some(f => state.filters[f] != null);
      if (state.sort.field || anyFilter) head.append(el("button", { class: "btn small ghost", title: "並び替え・絞り込みを解除", onclick: () => { state.sort = { field: "", dir: "asc" }; state.filters = {}; rerender(); } }, icon("filter-off"), " 解除"));
      wrap.append(head);
    }
    const table = el("table", { class: "grid" });
    const thr = el("tr", {});
    activeCols().forEach(c => thr.append(headerCell(c)));
    table.append(el("thead", {}, thr));
    const tb = el("tbody", {});
    const rows = sortView(list.filter(passFilters));
    rows.forEach((m, i) => {
      const bn = (m.baseName || "").trim();
      const next = rows[i + 1];
      // 同じ施策名のかたまりの最後の行に、太めのグレー線で区切りを付ける（展開中の行は行内の色帯を優先し区切り線は付けない）
      const isGroupEnd = bn && (!next || (next.baseName || "").trim() !== bn);
      const tr = row(key, m);
      if (isGroupEnd && !state.expanded[m.id]) tr.classList.add("group-end");
      tb.append(tr);
      if (state.expanded[m.id]) tb.append(detailRow(key, m));
    });
    if (rows.length === 0) tb.append(el("tr", {}, el("td", { colspan: String(activeCols().length), class: "muted", style: "padding:10px" }, "該当する施策がありません")));
    table.append(tb);
    wrap.append(el("div", { class: "grid-scroll" }, table));
    wrap.append(el("div", { class: "add-bottom" }, el("button", { class: "btn small ghost", onclick: () => { list.push(emptyMeasure()); markDirty(); rerender(); } }, icon("plus"), " 施策を追加")));
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
    const filtered = state.filters[c.f] != null;
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
      const checks = [];
      vals.forEach(v => {
        const on = cur.includes(v);
        const b = el("button", { class: "cm-check" + (on ? " on" : ""), onclick: (e) => {
          e.stopPropagation();
          let arr = (state.filters[c.f] || vals.slice()).slice();
          const nowOn = !arr.includes(v);
          if (arr.includes(v)) arr = arr.filter(x => x !== v); else arr.push(v);
          state.filters[c.f] = (arr.length === vals.length) ? null : arr;
          // メニューは document.body 直下にあり rerender() では再描画されないため、このボタン自身の表示を直接更新する
          b.classList.toggle("on", nowOn);
          b.textContent = (nowOn ? "☑ " : "☐ ") + v;
          rerender();
        } }, (on ? "☑ " : "☐ ") + v);
        checks.push({ b, v });
        menu.append(b);
      });
      const setAll = (allOn) => (e) => {
        e.stopPropagation();
        state.filters[c.f] = allOn ? null : [];
        checks.forEach(({ b, v }) => { b.classList.toggle("on", allOn); b.textContent = (allOn ? "☑ " : "☐ ") + v; });
        rerender();
      };
      menu.append(el("div", { class: "cm-btnrow" },
        el("button", { class: "cm-mini", onclick: setAll(true) }, "☑ 全て選択"),
        el("button", { class: "cm-mini", onclick: setAll(false) }, "☐ 全て外す")));
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
  // Excelから複数セル分を貼り付け＝貼り付けたセルから下の行へ一気に反映（先頭セルにペースト）
  // apply(row, その行に貼り付けられた1行分の生テキスト) で、行への反映のしかたを呼び出し側が決める
  function attachFillDownPaste(inp, m, apply) {
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
      let filled = 0;
      for (let i = 0; i < lines.length && start + i < rows.length; i++) { apply(rows[start + i], lines[i]); filled++; }
      markDirty(); rerender();
      const over = lines.length - filled;
      flash(`${filled}件を貼り付けました` + (over > 0 ? `（行が${over}件不足：先に行を追加してください）` : ""));
    });
  }
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
    attachFillDownPaste(inp, m, (row, raw) => {
      let v = String(raw).split("\t")[0].replace(decimal ? /[^0-9.]/g : /[^0-9]/g, "");
      if (decimal) { const p = v.split("."); v = p.shift() + (p.length ? "." + p.join("") : ""); }
      row[f] = v;
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
  // 直前行の施策名（表示中の並び順で）。同名が連続するときは2行目以降を薄く表示するための判定に使う
  function prevBaseIn(key, id) {
    const rows = sortView(state.model[key].filter(passFilters));
    const i = rows.findIndex(x => x.id === id);
    return i > 0 ? (rows[i - 1].baseName || "").trim() : null;
  }
  // 表示中の並び順での通し番号（並べ替え後は上から1,2,3…に自動で振り直し）
  function rowNo(key, m) {
    const rows = sortView(state.model[key].filter(passFilters));
    const i = rows.findIndex(x => x.id === m.id);
    return i >= 0 ? i + 1 : "";
  }
  function row(key, m) {
    const tr = el("tr", { "data-row": m.id });
    if (state.expanded[m.id]) tr.classList.add("expanded-row");
    if (state.selected.has(m.id)) tr.classList.add("selected");
    if (m.highlight) tr.classList.add("highlighted");
    const fc = familyColorOf(m);
    if (fc) { tr.classList.add("fam-row"); tr.style.setProperty("--band", fc); }
    if (prevBaseIn(key, m.id) === (m.baseName || "").trim() && (m.baseName || "").trim()) tr.classList.add("name-repeat");
    const rno = rowNo(key, m);
    if (rno % 2 === 0) tr.classList.add("stripe");   // 薄いシマシマ（施策行のみが対象。展開中の内訳行は数えない）
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
    const hasNote = !!((m.note && m.note.trim()) || (m.benefit && m.benefit.trim()) || (m.roFixDate && m.roFixDate.trim()) || (m.products && m.products.trim())
      || (m.supplement && m.supplement.trim()) || (m.origCode1 && m.origCode1.trim()) || (m.origCode2 && m.origCode2.trim()));
    const exp = el("button", { class: "expander" + (hasNote ? " hasnote" : "") + (state.expanded[m.id] ? " open" : ""), title: hasNote ? "詳細・メモあり（クリックで開閉）" : "詳細・メモを開く" });
    exp.append(icon(state.expanded[m.id] ? "chevron-down" : "chevron-right"));
    if (hasNote) exp.append(el("i", { class: "ti ti-note note-dot", "aria-hidden": "true" }));
    // 複数選択中に1件の内訳を開閉したら、選択中の行すべてを同じ開閉状態にする
    exp.addEventListener("click", () => {
      const next = !state.expanded[m.id];
      if (state.selected.size > 1 && state.selected.has(m.id)) state.selected.forEach(id => { state.expanded[id] = next; });
      else state.expanded[m.id] = next;
      rerender();
    });
    const dragCell = el("td", { class: "c-drag" });
    if (state.editing) {
      const chk = el("input", { type: "checkbox", class: "rowsel", title: "選択（ドラッグでまとめてチェック→件数合計を表示）" });
      chk.checked = state.selected.has(m.id);
      const setChecked = (on) => { chk.checked = on; if (on) state.selected.add(m.id); else state.selected.delete(m.id); tr.classList.toggle("selected", on); updateSelBar(); };
      chk.addEventListener("change", () => setChecked(chk.checked));
      // 上から下へドラッグすると、通った行のチェックを連続でON/OFFできる（Excelのドラッグ選択と同じ操作感）
      chk.addEventListener("mousedown", (e) => { e.preventDefault(); state.dragCheckOn = !chk.checked; setChecked(state.dragCheckOn); document.body.classList.add("no-usersel"); });
      chk.addEventListener("mouseenter", () => { if (state.dragCheckOn != null) setChecked(state.dragCheckOn); });
      dragCell.append(chk);
    }
    dragCell.append(handle, exp);
    tr.append(el("td", { class: "c-no" }, String(rno)));
    tr.append(dragCell);
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
    // 正式名候補：編集可＋コピー
    const der = el("td", { class: "c-derived", "data-derived": m.id });
    const nin = el("input", { class: "namein", value: derive(m, state.month).fullName, title: "編集可。案件共有シートで確定後の正式名を貼り戻す用" });
    nin.addEventListener("input", () => { m.officialName = nin.value; });
    const cp = el("button", { class: "iconbtn copyname", title: "施策名（正式名）だけをコピー" }); cp.append(icon("clipboard-text"));
    cp.addEventListener("click", () => { if (navigator.clipboard) navigator.clipboard.writeText(nin.value).then(() => flash("施策名をコピーしました")).catch(() => {}); });
    der.append(nin, cp); tr.append(der);
    // LP・テスト検証は既定で非表示（トグルで表示）
    if (state.showLP) tr.append(td(lpToggle(m), "c-lp"));
    if (state.showTest) { const cmpCell = el("td", { class: "c-cmp", "data-cmp": m.id }); renderCmpCell(cmpCell, m); tr.append(cmpCell); }
    const hlBtn = el("button", { class: "iconbtn hl-btn" + (m.highlight ? " on" : ""), title: m.highlight ? "重要マークを外す" : "重要な施策としてハイライト" });
    hlBtn.append(icon("highlight"));
    hlBtn.addEventListener("click", () => {
      if (!state.editing) return;
      const next = !m.highlight;
      const n = applyToSelection(m, "highlight", next);
      markDirty(); rerender();
      if (n > 1) flash(`選択中の${n}件をまとめて変更しました`);
    });
    const moveBtn = el("button", { class: "iconbtn", title: "別のセクションへ移動" }); moveBtn.append(icon("arrows-move"));
    moveBtn.addEventListener("click", e => { e.stopPropagation(); openMoveMenu(key, m.id, moveBtn); });
    tr.append(td(el("div", { class: "ops" }, hlBtn, moveBtn,
      el("button", { class: "iconbtn", title: "この施策を1行まるごと複製", onclick: () => copyMeasure(key, m.id) }, icon("row-insert-bottom")),
      el("button", { class: "iconbtn danger", title: "この施策を削除", onclick: () => del(key, m.id) }, icon("trash"))), "c-ops"));
    // ドラッグ中：どちら側に入るかを線で表示（行の上半分＝上に挿入／下半分＝下に挿入）
    tr.addEventListener("dragover", e => {
      if (!state.draggingMeasure) return;
      e.preventDefault();
      const rect = tr.getBoundingClientRect();
      const after = (e.clientY - rect.top) > rect.height / 2;
      if (state.dropOverId !== m.id || state.dropAfter !== after) {
        clearDropMarks();
        state.dropOverId = m.id; state.dropAfter = after;
        tr.classList.add(after ? "drop-below" : "drop-above");
      }
    });
    tr.addEventListener("drop", e => {
      e.preventDefault(); e.stopPropagation();
      const rows = sortView(state.model[key].filter(passFilters));
      const i = rows.findIndex(x => x.id === m.id);
      const targetId = state.dropAfter ? (rows[i + 1] ? rows[i + 1].id : null) : m.id;
      clearDropMarks();
      handleRowDrop(key, targetId);
    });
    return tr;
  }
  function clearDropMarks() {
    document.querySelectorAll("tr.drop-above, tr.drop-below").forEach(x => x.classList.remove("drop-above", "drop-below"));
    state.dropOverId = null; state.dropAfter = false;
  }
  function renderCodeCell(cell, m) {
    cell.innerHTML = "";
    const confirmed = m.codeStatus === "確定";
    const prefix = window.prefixOfCategory(m.category);
    const has = m.num !== "" && m.num != null;
    cell.className = "c-code " + (confirmed ? "code-ok" : "code-pend");
    // カテゴリと番号を分けず、「DME66」のように1本の欄でそのまま入力・貼り付けできるようにする
    const parseCode = (row, raw) => {
      const v = String(raw).split("\t")[0].trim();
      const mm = v.match(/^([A-Za-z]+)\s*0*([0-9]*)\s*$/);
      if (mm && mm[1] && M.categories.some(c => c.key === mm[1].toUpperCase())) {
        row.category = mm[1].toUpperCase();
        if (mm[2] !== "") row.num = mm[2];
      } else {
        row.num = v.replace(/[^0-9]/g, "");
      }
    };
    const codeInp = el("input", { class: "w-code", value: has ? window.buildMaterialShort(m.category, m.num) : (m.category || ""), placeholder: "例：DMB180" , title: "素材コードをそのまま入力・貼り付け（例：DMB180）。カテゴリと番号は自動で分けます" });
    codeInp.addEventListener("change", () => { if (!state.editing) return; parseCode(m, codeInp.value); markDirty(); rerenderRow(sectionOf(m), m); renderSummary(); });
    // Excelで複数セル（例：DME66〜DME70）をコピー→この欄に貼り付けで、下の行へ一気に入れる
    attachFillDownPaste(codeInp, m, parseCode);
    cell.append(codeInp);
    cell.append(el("span", { class: "codeval " + (confirmed ? "ok" : "pend") }, has ? window.buildMaterialCode(prefix, m.num) : "—"));
    const on = confirmed;
    const tog = el("button", { class: "ministat " + (on ? "ok" : "pend"), title: "素材コード：" + (on ? "確定" : "未確定") + "（クリックで切替）" });
    tog.append(icon(on ? "circle-check" : "circle-dashed"));
    tog.addEventListener("click", () => {
      if (!state.editing) return;
      const n = applyToSelection(m, "codeStatus", on ? "未確定" : "確定");
      markDirty(); rerender();
      if (n > 1) flash(`選択中の${n}件をまとめて変更しました`);
    });
    cell.append(tog);
  }
  // テスト検証：RO等は「—」、テストは必ず OK / NG
  function renderCmpCell(cell, m) {
    cell.innerHTML = "";
    if (m.kind !== "テスト") { cell.append(el("span", { class: "muted-dash" }, "—")); return; }
    const on = !!m.testValidated;
    const b = el("button", { class: "valid-btn " + (on ? "ok" : "ng"), title: on ? "テスト検証OK（クリックで解除）" : "未検証（チーム確認後クリックでOKに）" });
    b.textContent = on ? "OK" : "NG";
    b.addEventListener("click", () => {
      if (!state.editing) return;
      const n = applyToSelection(m, "testValidated", !on);
      markDirty(); rerender();
      if (n > 1) flash(`選択中の${n}件をまとめて変更しました`);
    });
    cell.append(b);
  }
  // LP作成の要否：○＝作る／×＝作らない（クリックで切替。素材コードのOKマークと同じ見た目）
  function lpToggle(m) {
    const on = m.lp === "○";
    const b = el("button", { class: "ministat " + (on ? "ok" : "pend"), title: "LP作成：" + (on ? "作る（○）" : "作らない（×）") + "（クリックで切替）" });
    b.append(icon(on ? "circle-check" : "circle-dashed"));
    b.addEventListener("click", () => {
      if (!state.editing) return;
      const n = applyToSelection(m, "lp", on ? "×" : "○");
      markDirty(); rerender();
      if (n > 1) flash(`選択中の${n}件をまとめて変更しました`);
    });
    return b;
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
    markDirty();
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
    l.splice(i + 1, 0, c); markDirty(); rerender(); flash("直下に複製しました（比較元＝元の施策）");
  }
  function reorder(key, dragId, targetId) {
    const l = state.model[key]; const from = l.findIndex(x => x.id === dragId); if (from < 0) return;
    const [it] = l.splice(from, 1); let to = l.findIndex(x => x.id === targetId);
    if (to < 0) l.push(it); else l.splice(to, 0, it);
    rerender();
  }
  // ドラッグ状態のクリア
  function cleanupDrag() { state.dragBatch = null; state.dragId = null; state.dragKey = null; state.dragMeasure = null; state.draggingMeasure = false; state.dragCanceled = false; state.dragFromSel = false; state.dragMoved = false; $("#cfHot").classList.remove("active"); clearDropMarks(); }
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
    markDirty();
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
    let sum = 0;
    ["active", "carryNext", "carryFuture"].forEach(k => state.model[k].forEach(m => { if (state.selected.has(m.id)) sum += parseInt(m.estimatedCount, 10) || 0; }));
    bar.append(el("span", { class: "sel-n" }, `${n}件を選択中`));
    bar.append(el("span", { class: "sel-sum" }, `想定件数合計 ${sum.toLocaleString()}件`));
    if (n > 1) bar.append(el("span", { class: "sel-hint" }, "種別・取得・送付・LP・素材コードOK・テスト検証・重要マークを変えると選択中の行に一括反映"));
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
    const [it] = l.splice(i, 1); state.model[toKey].push(it); markDirty(); rerender(); flash(`「${SEC_LABEL[toKey]}」へ移動しました`);
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
      const open = el("button", { class: "cf-open", onclick: e => { e.stopPropagation(); if (d.month !== state.month) window.open(monthWindowUrl(d.month), "_blank", "noopener,width=1400,height=900"); } }, d.month === state.month ? "表示中" : "この月を開く ↗");
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
  // 別ウィンドウで月を開くときのURL：今かけているフィルター（施策名・担当など）を引き継ぐ
  function monthWindowUrl(month) {
    const params = new URLSearchParams();
    params.set("month", month);
    const activeFilters = {};
    Object.keys(state.filters || {}).forEach(k => { if (state.filters[k] != null) activeFilters[k] = state.filters[k]; });
    if (Object.keys(activeFilters).length) params.set("filters", JSON.stringify(activeFilters));
    if (state.editing) params.set("edit", "1");   // 今が編集モードなら、開く先でも編集モードを引き継ぐ
    return location.pathname + "?" + params.toString();
  }
  async function dropMeasureToMonth(targetMonth) {
    const canceled = state.dragCanceled;
    const batch = state.dragBatch ? [...state.dragBatch] : [];
    closeCoverflow();                                   // 後片付けは dragend、ここでは移動のみ実行
    if (!canceled && batch.length) { state.dragMoved = true; await moveBatchToMonth(batch, targetMonth); }
  }
  // 行の下に開く詳細（施策の裏側データ：施策概要・特典・RO版FIX）
  function detailRow(key, m) {
    const tr = el("tr", { class: "detail-row" });
    const cell = el("td", { colspan: String(activeCols().length) });
    // 親と同系の色（赤/青/緑系）の薄い背景＋色帯を引き継ぐ
    const fc = familyColorOf(m);
    if (fc) { cell.style.boxShadow = "inset 6px 0 0 " + fc; cell.style.borderBottom = "2px solid " + fc; cell.style.background = lightenHex(fc, 0.85); }
    const box = el("div", { class: "detail" });
    const grid = el("div", { class: "detail-grid" });
    // 施策概要（メモ）：普段1行、入力に応じて自動で伸びる
    const wNote = el("div", { class: "dw-field col-note" });
    wNote.append(el("div", { class: "dw-lab" }, "施策概要・リスト条件メモ"));
    const ta = el("textarea", { class: "d-note", rows: "1", placeholder: "" }); ta.value = m.note || "";
    const grow = () => { ta.style.height = "auto"; ta.style.height = Math.max(30, ta.scrollHeight) + "px"; };
    ta.addEventListener("input", () => { m.note = ta.value; grow(); });
    ta.addEventListener("blur", () => rerenderRow(key, m));
    wNote.append(ta); setTimeout(grow, 0);
    const mk = (label, f, cls, opts = {}) => {
      const w = el("div", { class: "dw-field " + cls });
      w.append(el("div", { class: "dw-lab" }, label));
      const i = el("input", { value: m[f] || "", placeholder: opts.placeholder || "" });
      i.addEventListener("input", () => { m[f] = i.value; });
      i.addEventListener("blur", () => rerenderRow(key, m));
      if (opts.paste) attachFillDownPaste(i, m, (row, raw) => { row[f] = String(raw).split("\t")[0].trim(); });
      w.append(i);
      return w;
    };
    // 元素材コード①②：上下2行（DMB190くらいの文字数が入る幅）
    const mkOrigCodes = () => {
      const w = el("div", { class: "dw-field col-origcode" });
      w.append(el("div", { class: "dw-lab" }, "元素材コード"));
      const pair = el("div", { class: "origcode-pair" });
      [["origCode1", "①"], ["origCode2", "②"]].forEach(([f, ph]) => {
        const i = el("input", { class: "origcode-in", value: m[f] || "", placeholder: ph });
        i.addEventListener("input", () => { m[f] = i.value; });
        i.addEventListener("blur", () => rerenderRow(key, m));
        pair.append(i);
      });
      w.append(pair);
      return w;
    };
    // 並び：施策概要メモ → 元素材コード①② → 補足 → 掲載商品 → 特典 → FIX時期
    grid.append(wNote, mkOrigCodes(), mk("補足", "supplement", "col-supp"), mk("掲載商品", "products", "col-prod"), mk("特典", "benefit", "col-benefit"), mk("FIX時期", "roFixDate", "col-fix", { placeholder: "yyyy/mm/dd", paste: true }));
    box.append(grid); cell.append(box); tr.append(cell); return tr;
  }

  function renderIdeas() {
    const wrap = el("section", { class: "sec" });
    wrap.append(el("div", { class: "sec-head" }, el("h2", {}, icon("bulb"), " アイデア候補", el("span",{class:"sec-count"},`${state.model.ideas.length}`)),
      el("button", { class: "btn small ghost", onclick: () => { state.model.ideas.push({ id: uid(), text: "" }); markDirty(); rerender(); } }, "＋ 追加")));
    const box = el("div", { class: "ideas" });
    state.model.ideas.forEach(it => box.append(el("div", { class: "idea" },
      field(it, "text", { class: "w-idea", placeholder: "思いついた企画メモ" }),
      el("button", { class: "iconbtn danger", onclick: () => del("ideas", it.id) }, icon("x")))));
    wrap.append(box);
    return wrap;
  }

  // ===== 施策名ごとの色分け（赤=お誕生日系 / 青=TRS系 / 緑=RAH系。主要は固定・派生は少しずらす） =====
  // No.横の色帯だけに使う（行の背景タイルは廃止＝モノトーン運用）
  let familyColors = {};
  const FAMPAL = {
    red:   ["#d1272d", "#c81f61", "#c94f18", "#a8203a", "#c85a29"],
    blue:  ["#1c5fc2", "#0c7aa8", "#3446c4", "#295d9c", "#196fb0"],
    green: ["#1c8235", "#4c7a12", "#0a8562", "#367c17", "#248442"],
    other: ["#5642d6", "#a86c0c", "#5f6b78", "#7141c4"],
  };
  const FIXED = { "お誕生日":["red",0], "TRS下取":["blue",0], "TRS下取り":["blue",0], "RAH買い替え":["green",0], "RAH買替":["green",0] };
  // キーワード優先：TRS→青、RAH→緑、（TRS/RAHが無く）お誕生日/誕生→赤、それ以外→other
  function familyOf(name) {
    if (name.indexOf("TRS") >= 0) return "blue";
    if (name.indexOf("RAH") >= 0) return "green";
    if (name.indexOf("お誕生日") >= 0 || name.indexOf("誕生") >= 0) return "red";
    return "other";
  }
  // 送付方法違い（_メール便 等）だけの派生は同じ色にまとめる
  function colorKey(name) {
    return (name || "").trim().replace(/[_ ]*(メール便|CF放映地域|北海道)$/, "");
  }
  function computeFamilyColors() {
    familyColors = {};
    const used = { red: 1, blue: 1, green: 1, other: 0 };   // idx0 は主要施策に予約
    const seen = new Set();
    ["active", "carryNext", "carryFuture"].forEach(k => (state.model[k] || []).forEach(m => {
      const key = colorKey(m.baseName); if (!key || seen.has(key)) return; seen.add(key);
      let fam, idx;
      if (FIXED[key]) { fam = FIXED[key][0]; idx = FIXED[key][1]; }
      else { fam = familyOf(key); idx = used[fam]++; }
      const pal = FAMPAL[fam]; familyColors[key] = pal[idx % pal.length];
    }));
  }
  function familyColorOf(m) { const key = colorKey(m.baseName); return key ? familyColors[key] : null; }
  function lightenHex(hex, amt) {
    const h = hex.replace("#", ""); const r = parseInt(h.slice(0,2),16), g = parseInt(h.slice(2,4),16), b = parseInt(h.slice(4,6),16);
    const mix = v => Math.round(v + (255 - v) * amt);
    return `rgb(${mix(r)},${mix(g)},${mix(b)})`;
  }
  // 施策名変更時：全行の色を即時に付け替え（再描画せずフォーカス維持）
  function applyFamilyColors() {
    computeFamilyColors();
    ["active", "carryNext", "carryFuture"].forEach(k => (state.model[k] || []).forEach(m => {
      const tr = document.querySelector(`tr[data-row="${m.id}"]`); if (!tr) return;
      const fc = familyColorOf(m);
      if (fc) { tr.classList.add("fam-row"); tr.style.setProperty("--band", fc); }
      else { tr.classList.remove("fam-row"); tr.style.removeProperty("--band"); }
      if (state.expanded[m.id]) {
        const det = tr.nextElementSibling;
        if (det && det.classList.contains("detail-row")) {
          const cell = det.querySelector("td");
          if (cell) {
            if (fc) { cell.style.boxShadow = "inset 6px 0 0 " + fc; cell.style.borderBottom = "2px solid " + fc; cell.style.background = lightenHex(fc, 0.85); }
            else { cell.style.boxShadow = ""; cell.style.borderBottom = ""; cell.style.background = ""; }
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
  function move(key, id, d) { if (!state.editing) return; const l = state.model[key]; const i = l.findIndex(x=>x.id===id), j=i+d; if(i<0||j<0||j>=l.length)return; [l[i],l[j]]=[l[j],l[i]]; markDirty(); rerender(); }
  function del(key, id) { if (!state.editing) return; const l = state.model[key]; const i = l.findIndex(x=>x.id===id); if(i>=0){l.splice(i,1);state.selected.delete(id);markDirty();rerender();} }
  function sortByPriority() {
    if (!state.editing) return;
    // 施策名グループの先頭行（太字の行）だけを対象にする。2行目以降は優先度を出さない
    let prevBase = null;
    const tops = [];
    state.model.active.forEach(m => {
      const bn = (m.baseName || "").trim();
      const isTop = !(bn && bn === prevBase);
      prevBase = bn;
      if (isTop) tops.push(m); else m.priority = "";
    });
    // 先頭行の中でも、P3/Listが入っている施策だけ優先度を振る（入っていない施策は空のまま）
    const scored = tops.filter(m => (parseFloat(m.p3) || 0) > 0);
    tops.filter(m => !((parseFloat(m.p3) || 0) > 0)).forEach(m => m.priority = "");
    // AIを先（既ロは後）／その中で P3/List の高い順 → 高いものが優先度1
    scored.sort((x, y) => {
      const ax = x.listMethod === "AI" ? 0 : 1, ay = y.listMethod === "AI" ? 0 : 1;
      if (ax !== ay) return ax - ay;
      return (parseFloat(y.p3) || 0) - (parseFloat(x.p3) || 0);
    });
    scored.forEach((m, i) => m.priority = i + 1);
    markDirty(); rerender(); flash("P3/Listがある施策の先頭行に、優先度を振りました");
  }
  // 案件共有シートへの一括貼り付け用：表示中の順で1行1施策のテキストをコピー（Excelへ縦一列で貼り付け可）
  function copyToClipboardLines(values, label) {
    if (!navigator.clipboard) return;
    const text = values.join("\n");
    navigator.clipboard.writeText(text).then(() => flash(`${label}を${values.length}件コピーしました（案件共有シートへ貼り付けできます）`)).catch(() => {});
  }
  function copyAllOfficialNames() {
    const rows = sortView(state.model.active.filter(passFilters));
    copyToClipboardLines(rows.map(m => derive(m, state.month).fullName), "正式名");
  }
  function copyAllCounts() {
    const rows = sortView(state.model.active.filter(passFilters));
    copyToClipboardLines(rows.map(m => m.estimatedCount || ""), "想定件数");
  }
  function copyAllOwners() {
    const rows = sortView(state.model.active.filter(passFilters));
    copyToClipboardLines(rows.map(m => m.owner || ""), "担当");
  }

  // ============ フィールド入力（再描画せず） ============
  function onInput(e) {
    const t = e.target, id = t.getAttribute("data-id"), f = t.getAttribute("data-field");
    if (!id || !f || !state.model) return;
    let item = null;
    for (const k of ["active","carryNext","carryFuture","ideas"]) { item = state.model[k].find(x=>x.id===id); if(item)break; }
    if (!item) return;
    // 複数選択中に「種別・取得・送付」を変えたら、選択中の行すべてに同じ値を一括反映する
    if (["kind", "listMethod", "delivery"].includes(f) && state.selected.size > 1 && state.selected.has(id)) {
      const val = t.value, n = state.selected.size;
      ["active", "carryNext", "carryFuture"].forEach(k => state.model[k].forEach(x => { if (state.selected.has(x.id)) x[f] = val; }));
      rerender(); flash(`選択中の${n}件をまとめて変更しました`);
      return;
    }
    item[f] = t.value;
    if (f === "kind") { rerenderRow(sectionOf(item), item); refreshAllNames(); renderSummary(); return; }
    if (f === "category") { const cc = document.querySelector(`[data-code="${id}"]`); if (cc) renderCodeCell(cc, item); }
    if (f === "num") { const cv = document.querySelector(`[data-code="${id}"] .codeval`); if (cv) cv.textContent = window.buildMaterialCode(window.prefixOfCategory(item.category), item.num) || "—"; }
    if (f === "baseName") { refreshAllNames(); applyFamilyColors(); }   // 採番＋色を即時更新
    else if (["category", "num", "media", "codeStatus"].includes(f)) { const nin = document.querySelector(`[data-derived="${id}"] .namein`); if (nin && !(item.officialName && item.officialName.trim())) nin.value = derive(item, state.month).fullName; }
    if (f === "estimatedCount") renderSummary();
  }

  function findMeasure(id){ for(const k of ["active","carryNext","carryFuture"]){const m=state.model[k].find(x=>x.id===id);if(m)return m;} return null; }
  function sectionOf(m){ for(const k of ["active","carryNext","carryFuture"]) if(state.model[k].includes(m)) return k; return "active"; }
  // 複数選択中にトグル系の操作をしたら、選択中の行すべてへ同じ値を反映する（1件だけならその行だけ）
  function applyToSelection(m, field, value) {
    const ids = (state.selected.size > 1 && state.selected.has(m.id)) ? [...state.selected] : [m.id];
    ids.forEach(id => { const row = findMeasure(id); if (row) row[field] = value; });
    return ids.length;
  }
  function labeled(label, node){ return el("div", { class: "dw-field" }, el("div", { class: "dw-lab" }, label), node); }

  // ============ 月の読み書き ============
  async function loadMonth(month) {
    if (!month) return;
    const sel = $("#monthSelect"); if (sel) sel.disabled = true;   // 読み込み中は触れないように（共有フォルダ読み取り待ち）
    state.month = month; state.selected.clear();
    // 内容と更新日時を同時に読みに行く（順番に読むより速い）
    const [raw, mtime] = await Promise.all([S.readMonth(month), S.monthMtime(month)]);
    state.model = normalize(raw || emptyModel(month));
    state.model.title = window.monthLabel(month) + " DM施策";   // タイトルは対象月から自動
    state.mtime = mtime; state.editing = false;
    rerender(); startPolling();
    if (sel) sel.disabled = false;
  }
  // 編集モードに入る（1人だけ・ロック取得）
  async function enterEdit() {
    if (state.editing) return;
    if (!S.isConnected()) { alert("共有フォルダに未接続です。右上「共有フォルダに接続」で共有フォルダを選んでください。"); return; }
    if (!state.model) { alert("先に「対象月」で月を選ぶか、「＋新規」で作成してください。"); return; }
    if (!state.user) { alert("先に右上のお名前を入力してください。"); return; }
    const editBtnEl = $("#editBtn"); if (editBtnEl) editBtnEl.disabled = true;   // 確認中は連打防止＋反応した見た目に
    const lock = await S.readLock(state.month);
    if (lock && lock.user !== state.user) { alert(`${lock.user} さんが使用しています。編集できません（閲覧のみ）。`); await renderLockBar(); return; }
    await S.writeLock(state.month, { user: state.user, ts: Date.now() });
    state.editing = true; rerender();
  }
  // 閲覧モードに戻る（確定保存＋ロック解除）
  async function exitEdit() {
    if (!state.editing) return;
    await doAutoSave(true);
    await S.clearLock(state.month);
    state.editing = false; rerender();
  }
  // ===== 自動保存（Googleスプレッドシート風：手が止まって少ししたら保存） =====
  function markDirty() { if (!state.editing) return; state.dirty = true; scheduleAutoSave(); }
  function scheduleAutoSave() { clearTimeout(autoTimer); autoTimer = setTimeout(() => doAutoSave(), 1300); updateSavedAt(); }
  async function doAutoSave(force) {
    clearTimeout(autoTimer);
    if (!state.editing || !state.model || !S.isConnected()) return;
    saving = true; updateSavedAt();
    const stamp = new Date().toISOString();
    try {
      state.model.updatedAt = stamp; state.model.updatedBy = state.user;   // 書き込み成功時のみ有効な値
      await S.writeMonth(state.month, state.model);
      state.mtime = await S.monthMtime(state.month);
      saving = false; state.saveError = ""; state.dirty = false; updateSavedAt();
    } catch (e) {
      // 書き込み失敗：保存済み扱いにしない。理由を画面に出す
      saving = false; state.saveError = (e && e.message) ? e.message : String(e); updateSavedAt();
      console.error("[autosave] 保存に失敗:", e);
      if (force) alert("保存に失敗しました：" + state.saveError);
    }
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
      st.addEventListener("pointerdown", e => { if (state.draggingMeasure || e.target.closest(".cf-open")) return; down = true; sx = e.clientX; ss = cf.sel; st.setPointerCapture(e.pointerId); });
      st.addEventListener("pointermove", e => { if (!down) return; const d = Math.round((sx - e.clientX) / 58); const ns = Math.max(0, Math.min(cf.data.length - 1, ss + d)); if (ns !== cf.sel) { cf.sel = ns; positionCF(); } });
      st.addEventListener("pointerup", () => { down = false; });
      st.addEventListener("keydown", e => { if (e.key === "ArrowLeft" && cf.sel > 0) { cf.sel--; positionCF(); } if (e.key === "ArrowRight" && cf.sel < cf.data.length - 1) { cf.sel++; positionCF(); } if (e.key === "Enter" && cf.data[cf.sel]) selectMonthFromCF(cf.data[cf.sel].month); if (e.key === "Escape") closeCoverflow(); });
      st.addEventListener("wheel", e => { e.preventDefault(); if (e.deltaY > 0 && cf.sel < cf.data.length - 1) { cf.sel++; positionCF(); } else if (e.deltaY < 0 && cf.sel > 0) { cf.sel--; positionCF(); } }, { passive: false });
    })();
    $("#editBtn").addEventListener("click", enterEdit);
    $("#viewBtn").addEventListener("click", exitEdit);
    $("#board").addEventListener("input", onInput);
    // 自動保存：フィールド編集を検知して保存予約
    $("#board").addEventListener("input", markDirty);
    $("#board").addEventListener("change", markDirty);
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
    // チェック欄のドラッグ選択：マウスボタンを離したら終了
    document.addEventListener("mouseup", () => { state.dragCheckOn = null; document.body.classList.remove("no-usersel"); });
    // 閉じる直前：未保存があれば保存を発火し、完了保証がないため確認ダイアログで引き止める
    window.addEventListener("beforeunload", (e) => {
      if (!state.editing) return;
      if (state.dirty || saving) { doAutoSave(true); e.preventDefault(); e.returnValue = ""; return ""; }
      S.clearLock(state.month);
    });
    window.addEventListener("blur", () => { if (state.editing) doAutoSave(); });   // 画面を離れたら即保存
    // タブを隠す/最小化した瞬間にも保存（beforeunloadより確実に発火する）
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden" && state.editing && state.dirty) doAutoSave(); });
    if (S.supported) { try { await S.tryRestore(); renderHeader(); } catch (e) {} }
    await renderMonthSelect();
    if (S.isConnected()) {
      const months = await S.listMonths();
      // 「月をめくる」→別ウィンドウで開く、で指定された月があればそれを開く（無ければ最新月）
      const urlParams = new URLSearchParams(location.search);
      const wanted = urlParams.get("month");
      const target = (wanted && months.includes(wanted)) ? wanted : months[0];
      if (target) {
        $("#monthSelect").value = target; await loadMonth(target);
        // 別ウィンドウで開いたときに引き継いだフィルターを反映
        const filtersParam = urlParams.get("filters");
        if (filtersParam) { try { state.filters = JSON.parse(filtersParam); rerender(); } catch (e) {} }
        // 編集モードから開いた場合は、こちらも編集モードを試みる（他の人が使用中ならブロックされる）
        if (urlParams.get("edit") === "1" && state.user) await enterEdit();
      } else { renderBody(); renderLockBar(); }
    } else { renderBody(); renderLockBar(); }
  }
  document.addEventListener("DOMContentLoaded", init);
})();
