// storage.js — データの保存先を抽象化
// 優先: File System Access API（社内共有フォルダのJSONを直接読み書き）
// 代替: localStorage（フォルダ未接続時のお試し・下書き用）
//
// 月ごとに 1 ファイル:  <発送年月>.json   例 202609.json
// ロック情報も同フォルダ:  <発送年月>.lock.json

window.Storage = (function () {
  const LS_PREFIX = "dmplan:";           // localStorage キー接頭辞
  const IDB_KEY = "dirHandle";           // フォルダハンドル保存キー
  let dirHandle = null;                  // 接続中の共有フォルダ
  const IDB_KEY_EST = "estDirHandle";    // 見積もり依頼の出力先フォルダ（DMの年度フォルダ想定）
  let estDirHandle = null;
  let estPendingHandle = null;

  // ---- IndexedDB (フォルダハンドルの永続化) ----
  function idb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open("dmplan-db", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("handles");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function idbSet(key, val) {
    const db = await idb();
    return new Promise((res, rej) => {
      const tx = db.transaction("handles", "readwrite");
      tx.objectStore("handles").put(val, key);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  }
  async function idbGet(key) {
    const db = await idb();
    return new Promise((res, rej) => {
      const tx = db.transaction("handles", "readonly");
      const r = tx.objectStore("handles").get(key);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }

  const supported = "showDirectoryPicker" in window;

  let pendingHandle = null;   // 前回フォルダ（要・許可）

  // 権限の状態確認（要求はしない）
  async function hasPermission(handle, mode = "readwrite") {
    if (!handle) return false;
    try { return (await handle.queryPermission({ mode })) === "granted"; } catch (e) { return false; }
  }
  async function requestPermission(handle, mode = "readwrite") {
    if (!handle) return false;
    try { if ((await handle.queryPermission({ mode })) === "granted") return true; return (await handle.requestPermission({ mode })) === "granted"; } catch (e) { return false; }
  }

  // 前回接続フォルダの復帰：許可が残っている時だけ自動接続。無ければ pendingHandle に退避（接続クリックで許可のみ復帰）。
  async function tryRestore() {
    if (!supported) return false;
    const h = await idbGet(IDB_KEY);
    if (!h) return false;
    if (await hasPermission(h)) { dirHandle = h; return true; }
    pendingHandle = h; return false;   // isConnected() は false のまま
  }

  // フォルダ選択（前回フォルダがあれば再選択せず許可のみで復帰）
  async function connectFolder() {
    if (!supported) throw new Error("このブラウザはフォルダ直結に未対応です（Edge/Chromeをご利用ください）。");
    if (pendingHandle) {
      if (await requestPermission(pendingHandle)) { dirHandle = pendingHandle; pendingHandle = null; await idbSet(IDB_KEY, dirHandle); return dirHandle.name; }
    }
    const h = await window.showDirectoryPicker({ id: "dmplan", mode: "readwrite" });
    if (!(await requestPermission(h))) throw new Error("フォルダへの書き込み許可が必要です。");
    dirHandle = h; pendingHandle = null;
    await idbSet(IDB_KEY, h);
    return h.name;
  }

  function folderName() { return dirHandle ? dirHandle.name : null; }
  function isConnected() { return !!dirHandle; }

  // ---- 見積もり依頼の出力先フォルダ（例：01.DM の年度フォルダ）----
  async function estTryRestore() {
    if (!supported) return false;
    const h = await idbGet(IDB_KEY_EST);
    if (!h) return false;
    if (await hasPermission(h)) { estDirHandle = h; return true; }
    estPendingHandle = h; return false;
  }
  async function estConnectFolder() {
    if (!supported) throw new Error("このブラウザはフォルダ直結に未対応です（Edge/Chromeをご利用ください）。");
    if (estPendingHandle) {
      if (await requestPermission(estPendingHandle)) { estDirHandle = estPendingHandle; estPendingHandle = null; await idbSet(IDB_KEY_EST, estDirHandle); return estDirHandle.name; }
    }
    const h = await window.showDirectoryPicker({ id: "dmplan-estimate", mode: "readwrite" });
    if (!(await requestPermission(h))) throw new Error("フォルダへの書き込み許可が必要です。");
    estDirHandle = h; estPendingHandle = null;
    await idbSet(IDB_KEY_EST, h);
    return h.name;
  }
  function estFolderName() { return estDirHandle ? estDirHandle.name : null; }
  function estIsConnected() { return !!estDirHandle; }
  // 接続済みでも別のフォルダに変更したい場合（前回選択を再利用せず必ずピッカーを開く）
  async function estChangeFolder() {
    if (!supported) throw new Error("このブラウザはフォルダ直結に未対応です（Edge/Chromeをご利用ください）。");
    const h = await window.showDirectoryPicker({ id: "dmplan-estimate", mode: "readwrite" });
    if (!(await requestPermission(h))) throw new Error("フォルダへの書き込み許可が必要です。");
    estDirHandle = h; estPendingHandle = null;
    await idbSet(IDB_KEY_EST, h);
    return h.name;
  }
  // 指定名のサブフォルダを取得（無ければ作成）。複数階層は配列で渡す
  async function estGetSubfolder(names) {
    if (!estDirHandle) throw new Error("見積もり依頼の出力先フォルダが未接続です。");
    let dir = estDirHandle;
    for (const name of names) dir = await dir.getDirectoryHandle(name, { create: true });
    return dir;
  }
  async function estWriteFile(dirH, filename, arrayBuffer) {
    const fh = await dirH.getFileHandle(filename, { create: true });
    const w = await fh.createWritable();
    await w.write(arrayBuffer);
    await w.close();
  }

  // ---- 月データ ----
  async function listMonths() {
    if (dirHandle) {
      const months = [];
      for await (const [name, entry] of dirHandle.entries()) {
        if (entry.kind === "file" && /^\d{6}\.json$/.test(name)) months.push(name.slice(0, 6));
      }
      return months.sort().reverse();
    }
    // localStorage
    return Object.keys(localStorage)
      .filter(k => k.startsWith(LS_PREFIX) && /:\d{6}$/.test(k))
      .map(k => k.split(":").pop())
      .sort().reverse();
  }

  async function readMonth(month) {
    if (dirHandle) {
      try {
        const fh = await dirHandle.getFileHandle(`${month}.json`);
        const file = await fh.getFile();
        return JSON.parse(await file.text());
      } catch (e) { return null; }
    }
    const raw = localStorage.getItem(LS_PREFIX + month);
    return raw ? JSON.parse(raw) : null;
  }

  async function writeMonth(month, data) {
    const json = JSON.stringify(data, null, 2);
    if (dirHandle) {
      const fh = await dirHandle.getFileHandle(`${month}.json`, { create: true });
      const w = await fh.createWritable();
      await w.write(json);
      await w.close();
      return;
    }
    localStorage.setItem(LS_PREFIX + month, json);
  }

  // ファイル最終更新時刻（他者更新の検知用）
  async function monthMtime(month) {
    if (dirHandle) {
      try {
        const fh = await dirHandle.getFileHandle(`${month}.json`);
        const file = await fh.getFile();
        return file.lastModified;
      } catch (e) { return 0; }
    }
    const raw = localStorage.getItem(LS_PREFIX + month + ":mtime");
    return raw ? Number(raw) : 0;
  }

  // ---- 簡易ロック（○○さんが編集中） ----
  async function readLock(month) {
    if (dirHandle) {
      try {
        const fh = await dirHandle.getFileHandle(`${month}.lock.json`);
        const file = await fh.getFile();
        return JSON.parse(await file.text());
      } catch (e) { return null; }
    }
    const raw = localStorage.getItem(LS_PREFIX + month + ":lock");
    return raw ? JSON.parse(raw) : null;
  }
  async function writeLock(month, lock) {
    const json = JSON.stringify(lock);
    if (dirHandle) {
      const fh = await dirHandle.getFileHandle(`${month}.lock.json`, { create: true });
      const w = await fh.createWritable();
      await w.write(json);
      await w.close();
      return;
    }
    localStorage.setItem(LS_PREFIX + month + ":lock", json);
  }
  async function clearLock(month) {
    if (dirHandle) {
      try { await dirHandle.removeEntry(`${month}.lock.json`); } catch (e) {}
      return;
    }
    localStorage.removeItem(LS_PREFIX + month + ":lock");
  }

  return {
    supported, tryRestore, connectFolder, folderName, isConnected,
    listMonths, readMonth, writeMonth, monthMtime,
    readLock, writeLock, clearLock,
    estTryRestore, estConnectFolder, estChangeFolder, estFolderName, estIsConnected, estGetSubfolder, estWriteFile,
  };
})();
