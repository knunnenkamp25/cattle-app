/* ============================================================
   offline.js — local persistence primitives for offline use.
   Loaded BEFORE app.js. Exposes a global `OFF`.
     * herd cache  -> localStorage
     * write queue -> localStorage   (the "outbox")
     * photo blobs -> IndexedDB      (too big for localStorage)
   ============================================================ */
"use strict";
const OFF = (function () {
  const CACHE_KEY = "cattle_cache_v1";
  const OUTBOX_KEY = "cattle_outbox_v1";

  /* ---- herd cache ---- */
  const loadCache = () => { try { return JSON.parse(localStorage.getItem(CACHE_KEY)) || []; } catch { return []; } };
  const saveCache = (list) => { try { localStorage.setItem(CACHE_KEY, JSON.stringify(list)); } catch (e) { console.warn("cache save failed", e); } };

  /* ---- outbox (queued writes) ---- */
  const loadOutbox = () => { try { return JSON.parse(localStorage.getItem(OUTBOX_KEY)) || []; } catch { return []; } };
  const saveOutbox = (q) => { try { localStorage.setItem(OUTBOX_KEY, JSON.stringify(q)); } catch (e) { console.warn("outbox save failed", e); } };

  /* ---- IndexedDB for pending photo blobs ---- */
  let dbp = null;
  function db() {
    if (dbp) return dbp;
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open("cattle-photos", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("photos");
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return dbp;
  }
  async function putPhoto(key, blob) {
    const d = await db();
    return new Promise((res, rej) => {
      const t = d.transaction("photos", "readwrite");
      t.objectStore("photos").put(blob, key);
      t.oncomplete = res; t.onerror = () => rej(t.error);
    });
  }
  async function getPhoto(key) {
    const d = await db();
    return new Promise((res, rej) => {
      const t = d.transaction("photos", "readonly");
      const rq = t.objectStore("photos").get(key);
      rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error);
    });
  }
  async function delPhoto(key) {
    const d = await db();
    return new Promise((res) => {
      const t = d.transaction("photos", "readwrite");
      t.objectStore("photos").delete(key);
      t.oncomplete = res; t.onerror = res;
    });
  }
  async function allPhotoKeys() {
    const d = await db();
    return new Promise((res) => {
      const t = d.transaction("photos", "readonly");
      const rq = t.objectStore("photos").getAllKeys();
      rq.onsuccess = () => res(rq.result || []); rq.onerror = () => res([]);
    });
  }

  return { loadCache, saveCache, loadOutbox, saveOutbox,
           putPhoto, getPhoto, delPhoto, allPhotoKeys,
           isOnline: () => navigator.onLine };
})();
