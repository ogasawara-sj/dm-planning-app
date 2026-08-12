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

  // 権限確認/要求
  async function ensurePermission(handle, mode = "readwrite") {
    if (!handle) return false;
    const opts = { mode };
    if ((await handle.queryPermission(opts)) === "granted") return true;
    if ((await handle.requestPermission(opts)) === "granted") return true;
    return false;
  }

  // 前回接続フォルダの復帰（要ユーザー操作の場合あり）
  async function tryRestore() {
    if (!supported) return false;
    const h = await idbGet(IDB_KEY);
    if (!h) return false;
    if (await ensurePermission(h)) { dirHandle = h; return true; }
    // 権限が切れている（クリック後に再取得が必要）
    dirHandle = h;
    return false;
  }

  // フォルダ選択
  async function connectFolder() {
    if (!supported) throw new Error("このブラウザはフォルダ直結に未対応です（Edge/Chromeをご利用ください）。");
    const h = await window.showDirectoryPicker({ id: "dmplan", mode: "readwrite" });
    if (!(await ensurePermission(h))) throw new Error("フォルダへの書き込み許可が必要です。");
    dirHandle = h;
    await idbSet(IDB_KEY, h);
    return h.name;
  }

  function folderName() { return dirHandle ? dirHandle.name : null; }
  function isConnected() { return !!dirHandle; }

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
  };
})();
