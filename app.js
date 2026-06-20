/* ============================================================
   Cattle Tracker — single-page app (vanilla JS + Supabase)
   ============================================================ */
"use strict";

const CFG = window.CATTLE_CONFIG;
let sb = null;                 // supabase client
let ANIMALS = [];              // in-memory cache of all animals
let CURRENT_TAB = "dashboard";
let OUTBOX = [];               // queued writes waiting to sync
let SYNCING = false;
const LOCAL_PHOTOS = new Map();// storage path -> local objectURL (pending upload)
let PENDING_LINK = null;       // deep link from a scanned QR tag (?a=<unique_id>)
let LAST_HERD_LIST = [];       // most recently rendered herd list (for bulk tag printing)

/* ---------- tiny helpers ---------- */
const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => (s == null ? "" : String(s).replace(/[&<>"']/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])));
const view = () => $("#view");
const todayISO = () => new Date().toISOString().slice(0, 10);
const fmtDate = (d) => d ? new Date(d + "T00:00:00").toLocaleDateString(undefined,
  { year: "numeric", month: "short", day: "numeric" }) : "—";
const money = (n) => (n == null || n === "" || isNaN(n)) ? "—"
  : "$" + Number(n).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 });

function genUniqueId() {            // 17-char random A-Z 0-9
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no easily-confused chars
  const a = new Uint32Array(17);
  crypto.getRandomValues(a);
  return [...a].map(n => chars[n % chars.length]).join("");
}

function toast(msg) {
  let t = $("#toast");
  if (!t) { t = document.createElement("div"); t.id = "toast"; t.className = "toast"; document.body.appendChild(t); }
  t.textContent = msg; t.classList.add("show");
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove("show"), 2200);
}

/* derived label: Heifer / Bull / Steer */
function sexLabel(a) {
  if (a.gender === "Heifer") return "Heifer";
  if (a.gender === "Bull") return a.neutered ? "Steer" : "Bull";
  return "—";
}
function sexBadgeClass(a) {
  if (a.gender === "Heifer") return "heifer";
  return a.neutered ? "steer" : "bull";
}
function photoUrl(a) {
  if (!a.photo_path) return null;
  if (LOCAL_PHOTOS.has(a.photo_path)) return LOCAL_PHOTOS.get(a.photo_path); // pending upload
  return sb.storage.from("animal-photos").getPublicUrl(a.photo_path).data.publicUrl;
}
function offspringOf(id) { return ANIMALS.filter(a => a.dam_id === id); }
function lastVaxDate(a) {
  const v = a.vaccinations || [];
  return v.length ? v[v.length - 1].date : null;
}

/* ============================================================
   BOOT
   ============================================================ */
window.addEventListener("DOMContentLoaded", init);

async function init() {
  if (!CFG.SUPABASE_URL || CFG.SUPABASE_URL.includes("PASTE")) {
    $("#splash").innerHTML =
      '<div style="padding:24px;text-align:center;max-width:340px">' +
      '<h2>Almost there</h2><p class="muted">Open <b>config.js</b> and paste in your ' +
      'Supabase URL and anon key, then reload.</p></div>';
    return;
  }
  sb = supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);
  PENDING_LINK = new URLSearchParams(location.search).get("a");  // QR deep link

  // offline: cache the app shell so it opens with no signal
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

  // wire up persistent UI
  $("#login-form").addEventListener("submit", onLogin);
  $("#signout-btn").addEventListener("click", async () => { if (OFF.isOnline()) await syncOutbox(); sb.auth.signOut(); });
  $$(".tab").forEach(b => b.addEventListener("click", () => switchTab(b.dataset.tab)));
  sb.auth.onAuthStateChange((_e, session) => renderAuth(session));

  // sync when the connection returns; tap the pill to force a sync
  window.addEventListener("online", async () => { updateSyncUI(); await loadAnimals(); refreshAfterSync(); toast("Back online — syncing"); });
  window.addEventListener("offline", () => { updateSyncUI(); toast("Offline — changes will be saved on this device"); });
  document.addEventListener("click", (e) => {
    if (e.target && e.target.id === "sync-pill" && OFF.isOnline()) loadAnimals().then(refreshAfterSync);
  });

  const { data } = await sb.auth.getSession();
  await renderAuth(data.session);
}

async function renderAuth(session) {
  $("#splash").classList.add("hidden");
  if (session) {
    $("#login-screen").classList.add("hidden");
    $("#app").classList.remove("hidden");
    await loadAnimals();
    switchTab(CURRENT_TAB);
    if (PENDING_LINK) {                                   // opened from a scanned QR tag
      const a = ANIMALS.find(x => x.unique_id === PENDING_LINK);
      PENDING_LINK = null;
      if (a) openProfile(a.id); else toast("Tag not found in herd");
    }
  } else {
    $("#app").classList.add("hidden");
    $("#login-screen").classList.remove("hidden");
  }
}

async function onLogin(e) {
  e.preventDefault();
  const err = $("#login-error"); err.classList.add("hidden");
  const email = $("#login-email").value.trim();
  const password = $("#login-password").value;
  const { error } = await sb.auth.signInWithPassword({ email, password });
  if (error) { err.textContent = error.message; err.classList.remove("hidden"); }
}

/* ============================================================
   DATA LAYER  (offline-first)
   Every write is applied to the local cache immediately and queued
   in the outbox. When online, the outbox is flushed to Supabase.
   ============================================================ */

/* --- local helpers --- */
const derive = (a) => { a.is_sold = !!a.sale_date; return a; };
function persist() { OFF.saveCache(ANIMALS); }
function upsertLocal(rec) {
  const r = derive({ ...rec });
  const i = ANIMALS.findIndex(x => x.id === r.id);
  if (i >= 0) ANIMALS[i] = r; else ANIMALS.unshift(r);
  persist();
}
function patchLocal(id, patch) {
  const a = ANIMALS.find(x => x.id === id); if (!a) return;
  Object.assign(a, patch); derive(a); persist();
}
function removeLocalRec(id) { ANIMALS = ANIMALS.filter(x => x.id !== id); persist(); }
function enqueue(op) { OUTBOX.push(op); OFF.saveOutbox(OUTBOX); updateSyncUI(); }

async function rebuildLocalPhotos() {
  try {
    const keys = await OFF.allPhotoKeys();
    for (const k of keys) {
      if (!LOCAL_PHOTOS.has(k)) { const b = await OFF.getPhoto(k); if (b) LOCAL_PHOTOS.set(k, URL.createObjectURL(b)); }
    }
  } catch (_) {}
}

/* --- load: cache first, then refresh from server when online --- */
async function loadAnimals() {
  OUTBOX = OFF.loadOutbox();
  if (!ANIMALS.length) ANIMALS = OFF.loadCache();
  await rebuildLocalPhotos();
  if (OFF.isOnline()) {
    try {
      await syncOutbox();                               // push pending first
      if (OUTBOX.length === 0) {                          // only trust server once fully synced
        const { data, error } = await sb.from("animals").select("*").order("created_at", { ascending: false });
        if (!error && data) { ANIMALS = data.map(derive); persist(); }
      }
    } catch (_) { /* stay on cache */ }
  }
  updateSyncUI();
}

/* --- writes (optimistic) --- */
async function saveNew(record) {
  if (!record.id) record.id = crypto.randomUUID();
  record.created_at = record.created_at || new Date().toISOString();
  upsertLocal(record);
  enqueue({ op: "insert", id: record.id, payload: record });
  if (OFF.isOnline()) await syncOutbox();
  return ANIMALS.find(x => x.id === record.id);
}
async function saveUpdate(id, patch) {
  patchLocal(id, patch);
  enqueue({ op: "update", id, payload: patch });
  if (OFF.isOnline()) await syncOutbox();
  return ANIMALS.find(x => x.id === id);
}
async function deleteAnimal(id) {
  removeLocalRec(id);
  enqueue({ op: "delete", id });
  if (OFF.isOnline()) await syncOutbox();
}
async function uploadPhoto(file, unique_id) {
  const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
  const path = `animals/${unique_id}-${Date.now()}.${ext}`;
  if (OFF.isOnline()) {
    try {
      const { error } = await sb.storage.from("animal-photos").upload(path, file, { upsert: true });
      if (!error) return path;                            // uploaded now
    } catch (_) {}
  }
  // offline (or failed): stash the blob, show it locally, upload on sync
  try { await OFF.putPhoto(path, file); LOCAL_PHOTOS.set(path, URL.createObjectURL(file)); } catch (_) {}
  return path;
}

/* --- sync the outbox to Supabase --- */
async function syncOutbox() {
  if (SYNCING || !OFF.isOnline() || !sb) return;
  const queue = OFF.loadOutbox();
  const photoKeys = await OFF.allPhotoKeys();
  if (!queue.length && !photoKeys.length) { OUTBOX = queue; return; }
  SYNCING = true; updateSyncUI("syncing");
  try {
    // 1) upload any pending photo blobs to their stored paths
    for (const path of photoKeys) {
      try {
        const blob = await OFF.getPhoto(path);
        if (blob) {
          const { error } = await sb.storage.from("animal-photos").upload(path, blob, { upsert: true });
          if (error) throw error;
        }
        await OFF.delPhoto(path);
      } catch (_) { /* keep for next attempt */ }
    }
    // 2) process row writes in order (upsert makes retries idempotent)
    const remaining = [];
    for (const item of queue) {
      try {
        if (item.op === "insert") {
          const { error } = await sb.from("animals").upsert(item.payload, { onConflict: "id" });
          if (error) throw error;
        } else if (item.op === "update") {
          const { error } = await sb.from("animals").update(item.payload).eq("id", item.id);
          if (error) throw error;
        } else if (item.op === "delete") {
          const { error } = await sb.from("animals").delete().eq("id", item.id);
          if (error) throw error;
        }
      } catch (_) { remaining.push(item); }
    }
    OUTBOX = remaining; OFF.saveOutbox(OUTBOX);
  } finally { SYNCING = false; updateSyncUI(); }
}

/* --- sync status pill --- */
function updateSyncUI(state) {
  const pill = document.getElementById("sync-pill"); if (!pill) return;
  const n = (OFF.loadOutbox() || []).length;
  if (state === "syncing") { pill.textContent = "Syncing…"; pill.className = "pill syncing"; return; }
  if (!OFF.isOnline()) { pill.textContent = n ? `Offline · ${n}` : "Offline"; pill.className = "pill offline"; return; }
  if (n) { pill.textContent = `${n} to sync`; pill.className = "pill pending"; return; }
  pill.textContent = "Synced"; pill.className = "pill synced";
  clearTimeout(updateSyncUI._t);
  updateSyncUI._t = setTimeout(() => { if (pill.textContent === "Synced") { pill.textContent = ""; pill.className = "pill"; } }, 1800);
}
function refreshAfterSync() {
  if (CURRENT_TAB === "dashboard") renderDashboard();
  else if (CURRENT_TAB === "market") renderMarket();
}

/* ============================================================
   NAV
   ============================================================ */
function switchTab(tab) {
  CURRENT_TAB = tab;
  $$(".tab").forEach(b => b.classList.toggle("active", b.dataset.tab === tab));
  const titles = { dashboard: "Dashboard", add: "Add Calf", herd: "The Herd", market: "Market & News" };
  $("#topbar-title").textContent = titles[tab] || "";
  view().scrollTop = 0; window.scrollTo(0, 0);
  if (tab === "dashboard") renderDashboard();
  else if (tab === "add") renderAddForm();
  else if (tab === "herd") renderHerd();
  else if (tab === "market") renderMarket();
}

/* ============================================================
   DASHBOARD
   ============================================================ */
function renderDashboard() {
  const yr = new Date().getFullYear();
  const live = ANIMALS.filter(a => !a.is_sold);
  const calvesThisYr = live.filter(a => a.birth_date && new Date(a.birth_date).getFullYear() === yr);
  const bulls = live.filter(a => a.gender === "Bull");
  const heifers = live.filter(a => a.gender === "Heifer");
  const unneutered = bulls.filter(a => !a.neutered);
  const pctUnneut = bulls.length ? Math.round(unneutered.length / bulls.length * 100) : 0;
  const vaxThisYr = live.filter(a => (a.vaccinations || []).some(v => v.date && new Date(v.date).getFullYear() === yr));

  // finances — trailing 90 days & trailing 12 months
  const now = Date.now(), DAY = 86400000;
  const sold = ANIMALS.filter(a => a.sale_date);
  const inWindow = (a, days) => (now - new Date(a.sale_date).getTime()) <= days * DAY;
  const q = sold.filter(a => inWindow(a, 90));
  const y = sold.filter(a => inWindow(a, 365));
  const avg = arr => { const p = arr.map(a => Number(a.sale_price)).filter(n => !isNaN(n) && n > 0); return p.length ? p.reduce((s, n) => s + n, 0) / p.length : null; };
  const sum = arr => arr.map(a => Number(a.sale_price)).filter(n => !isNaN(n)).reduce((s, n) => s + n, 0);

  // alerts
  const noVax = live.filter(a => !(a.vaccinations || []).some(v => v.date && new Date(v.date).getFullYear() === yr));
  const noTag = live.filter(a => !a.tag_number);

  const tile = (n, l, cls = "") => `<div class="stat ${cls}"><div class="n">${n}</div><div class="l">${l}</div></div>`;

  view().innerHTML = `
    <div class="section-title">Herd Overview</div>
    <div class="grid3">
      ${tile(live.length, "Head in herd")}
      ${tile(calvesThisYr.length, "New calves " + yr, "good")}
      ${tile(vaxThisYr.length, "Vaccinated " + yr)}
      ${tile(bulls.length, "Bulls", "")}
      ${tile(heifers.length, "Heifers", "")}
      ${tile(pctUnneut + "%", "Bulls intact", pctUnneut > 0 ? "warn" : "good")}
    </div>

    <div class="card" id="hv-card" style="display:flex;justify-content:space-between;align-items:center">
      <div><div class="muted" style="font-size:12px;font-weight:700;text-transform:uppercase">Est. herd value</div>
        <div class="fab-note" id="hv-note">live market price × weights</div></div>
      <div id="hv-total" style="font-size:24px;font-weight:700;color:var(--green)">…</div>
    </div>

    <div class="section-title">Finances</div>
    <div class="grid2">
      <div class="card" style="margin:0">
        <div class="muted" style="font-size:12px;font-weight:700;text-transform:uppercase">Last 90 days</div>
        <div class="kv"><span class="k">Head sold</span><span class="v">${q.length}</span></div>
        <div class="kv"><span class="k">Avg price</span><span class="v">${money(avg(q))}</span></div>
        <div class="kv"><span class="k">Total</span><span class="v">${money(sum(q))}</span></div>
      </div>
      <div class="card" style="margin:0">
        <div class="muted" style="font-size:12px;font-weight:700;text-transform:uppercase">Last 12 months</div>
        <div class="kv"><span class="k">Head sold</span><span class="v">${y.length}</span></div>
        <div class="kv"><span class="k">Avg price</span><span class="v">${money(avg(y))}</span></div>
        <div class="kv"><span class="k">Total</span><span class="v">${money(sum(y))}</span></div>
      </div>
    </div>

    <div class="section-title">Alert Center</div>
    <div id="alerts"></div>
  `;

  const alerts = [];
  if (noVax.length) alerts.push({ cls: "", ico: "💉", t: `${noVax.length} not vaccinated in ${yr}`, list: noVax });
  if (unneutered.length) alerts.push({ cls: "", ico: "🐂", t: `${unneutered.length} intact bull(s)`, list: unneutered });
  if (noTag.length) alerts.push({ cls: "bad", ico: "🏷️", t: `${noTag.length} missing a tag number`, list: noTag });

  const ac = $("#alerts");
  if (!alerts.length) { ac.innerHTML = `<div class="card" style="text-align:center;color:var(--green);font-weight:600">✅ All clear — nothing needs attention.</div>`; return; }
  ac.innerHTML = alerts.map((al, i) => `
    <div class="alert ${al.cls}" data-ai="${i}" style="cursor:pointer">
      <div class="a-ico">${al.ico}</div>
      <div class="a-body"><b>${esc(al.t)}</b><span class="muted">Tap to view list</span></div>
    </div>`).join("");
  $$("#alerts .alert").forEach(el =>
    el.addEventListener("click", () => showList(alerts[+el.dataset.ai].t, alerts[+el.dataset.ai].list)));

  // herd value (async — needs market data)
  getMarket().then(m => {
    const t = $("#hv-total"), note = $("#hv-note"); if (!t) return;
    if (!m) { t.textContent = "—"; note.textContent = "market data not loaded yet"; return; }
    const hv = computeHerdValue(m);
    t.textContent = hv.withW ? money(hv.total) : "—";
    note.textContent = hv.withW
      ? `${hv.withW} weighed${hv.missing ? ` · ${hv.missing} need a weight` : ""}`
      : "add weights to animals to estimate";
  });
}

function showList(title, list) {
  switchTabShell("herd", title);
  view().innerHTML = `<button class="back-btn" id="back">‹ Dashboard</button>
    <h2 style="margin:0 0 10px">${esc(title)}</h2>` + renderAnimalRows(list);
  $("#back").addEventListener("click", () => switchTab("dashboard"));
  wireRows();
}
function switchTabShell(tab, title) {
  $$(".tab").forEach(b => b.classList.toggle("active", b.dataset.tab === tab));
  $("#topbar-title").textContent = title;
}

/* ============================================================
   ADD CALF FORM
   ============================================================ */
let formState = {};   // holds choice selections + dam link + photo file

function chipGroup(name, options, selected) {
  return `<div class="choices" data-group="${name}">` + options.map(o =>
    `<label class="choice ${selected === o ? "selected" : ""}" data-val="${esc(o)}">${esc(o)}</label>`
  ).join("") + `</div>`;
}
function wireChips(scope = document) {
  $$(".choices", scope).forEach(grp => {
    grp.addEventListener("click", e => {
      const c = e.target.closest(".choice"); if (!c) return;
      const name = grp.dataset.group;
      const val = c.dataset.val;
      if (formState[name] === val) { formState[name] = null; }   // tap again to clear
      else formState[name] = val;
      $$(".choice", grp).forEach(x => x.classList.toggle("selected", x.dataset.val === formState[name]));
      if (name === "gender") $("#neuter-wrap").classList.toggle("hidden", formState.gender !== "Bull");
    });
  });
}

function renderAddForm() {
  formState = { gender: null, neutered: false, breed: null, mom_breed: null, color: null, dam_id: null, photoFile: null };
  view().innerHTML = `
    <form id="calf-form">
      <div class="field">
        <label>Name <span class="hint">(optional)</span></label>
        <input type="text" id="f-name" placeholder="e.g. Daisy" />
      </div>

      <div class="field">
        <label>Birth date</label>
        <input type="date" id="f-birth" value="${todayISO()}" />
      </div>

      <div class="field">
        <label>Calf breed</label>
        ${chipGroup("breed", CFG.CALF_BREEDS, null)}
      </div>

      <div class="field">
        <label>Gender</label>
        ${chipGroup("gender", ["Heifer", "Bull"], null)}
        <div id="neuter-wrap" class="hidden" style="margin-top:10px">
          <label>Neutered? <span class="hint">(steer)</span></label>
          ${chipGroup("neutered", ["No", "Yes"], "No")}
        </div>
      </div>

      <div class="field">
        <label>Color</label>
        ${chipGroup("color", CFG.COLORS, null)}
      </div>

      <div class="field">
        <label>Calf tag number</label>
        <input type="text" id="f-tag" placeholder="e.g. 412" />
      </div>

      <div class="section-title" style="margin-left:0">Mother</div>
      <div class="field">
        <label>Link to mom already in the herd <span class="hint">(search by tag or name)</span></label>
        <input type="text" id="dam-search" placeholder="Type mom's tag…" autocomplete="off" />
        <div id="dam-results"></div>
        <div id="dam-linked"></div>
      </div>
      <div class="field">
        <label>Mom's breed</label>
        ${chipGroup("mom_breed", CFG.MOM_BREEDS, null)}
      </div>
      <div class="grid2">
        <div class="field"><label>Mom's tag #</label><input type="text" id="f-mom-tag" /></div>
        <div class="field"><label>Mom's birth year</label><input type="number" id="f-mom-year" placeholder="e.g. 2019" /></div>
      </div>

      <div class="section-title" style="margin-left:0">Other</div>
      <div class="field">
        <label>Weight (lbs) <span class="hint">(optional — powers value estimate)</span></label>
        <input type="number" id="f-weight" placeholder="e.g. 520" />
      </div>
      <div class="field">
        <label>Vaccination date <span class="hint">(leave blank if none yet)</span></label>
        <input type="date" id="f-vax" />
      </div>
      <div class="field">
        <label>Photo</label>
        <input type="file" id="f-photo" accept="image/*" capture="environment" />
        <div class="fab-note">Tap to take a photo or choose one from the library.</div>
      </div>
      <div class="field">
        <label>Notes</label>
        <textarea id="f-notes" placeholder="Anything worth remembering…"></textarea>
      </div>

      <button type="submit" class="btn btn-primary btn-block">Save calf</button>
      <p class="fab-note" style="text-align:center">A permanent 17-character ID is generated automatically.</p>
    </form>`;
  wireChips();
  wireDamSearch();
  $("#calf-form").addEventListener("submit", submitCalf);
}

function wireDamSearch() {
  const input = $("#dam-search"), results = $("#dam-results");
  input.addEventListener("input", () => {
    const q = input.value.trim().toLowerCase();
    if (!q) { results.innerHTML = ""; return; }
    const matches = ANIMALS.filter(a =>
      (a.tag_number && a.tag_number.toLowerCase().includes(q)) ||
      (a.name && a.name.toLowerCase().includes(q))).slice(0, 6);
    results.innerHTML = matches.length
      ? matches.map(a => `<div class="list-item" data-id="${a.id}" style="margin:6px 0">
          <div class="thumb">🐄</div><div class="li-main">
          <div class="li-title">${esc(a.tag_number || "No tag")} ${a.name ? "· " + esc(a.name) : ""}</div>
          <div class="li-sub">${esc(a.breed || "")} ${a.birth_date ? "· b." + new Date(a.birth_date).getFullYear() : ""}</div>
          </div></div>`).join("")
      : `<div class="fab-note">No match. The mom fields below will create her record automatically when you save.</div>`;
    $$("#dam-results .list-item").forEach(el => el.addEventListener("click", () => linkDam(el.dataset.id)));
  });
}
function linkDam(id) {
  const m = ANIMALS.find(a => a.id === id); if (!m) return;
  formState.dam_id = id;
  $("#dam-search").value = ""; $("#dam-results").innerHTML = "";
  $("#dam-linked").innerHTML = `<div class="chip-list" style="margin-top:8px">
    <span class="chip">Linked to mom: ${esc(m.tag_number || m.name || "cow")} ✕</span></div>`;
  $("#dam-linked .chip").addEventListener("click", () => { formState.dam_id = null; $("#dam-linked").innerHTML = ""; });
  // prefill snapshot
  if (m.tag_number) $("#f-mom-tag").value = m.tag_number;
  if (m.birth_date) $("#f-mom-year").value = new Date(m.birth_date).getFullYear();
  if (m.breed && CFG.MOM_BREEDS.includes(m.breed)) {
    formState.mom_breed = m.breed;
    $$('[data-group="mom_breed"] .choice').forEach(x => x.classList.toggle("selected", x.dataset.val === m.breed));
  }
}

async function submitCalf(e) {
  e.preventDefault();
  const btn = e.target.querySelector('button[type=submit]');
  btn.disabled = true; btn.textContent = "Saving…";
  try {
    const unique_id = genUniqueId();
    let photo_path = null;
    const file = $("#f-photo").files[0];
    if (file) photo_path = await uploadPhoto(file, unique_id);

    // resolve mother: linked -> use it; else if tag entered, find or create
    let dam_id = formState.dam_id;
    const momTag = $("#f-mom-tag").value.trim();
    if (!dam_id && momTag) {
      const found = ANIMALS.find(a => a.tag_number && a.tag_number.toLowerCase() === momTag.toLowerCase());
      if (found) dam_id = found.id;
      else {
        const dam = await saveNew({
          unique_id: genUniqueId(), tag_number: momTag,
          breed: formState.mom_breed || null,
          birth_date: $("#f-mom-year").value ? `${$("#f-mom-year").value}-01-01` : null,
          gender: "Heifer",
          notes: "Auto-created as a mother record.",
        });
        dam_id = dam.id;
      }
    }

    const vax = $("#f-vax").value ? [{ date: $("#f-vax").value, note: "" }] : [];
    const wt = $("#f-weight").value ? Number($("#f-weight").value) : null;
    const rec = {
      unique_id,
      name: $("#f-name").value.trim() || null,
      tag_number: $("#f-tag").value.trim() || null,
      tag_history: [],
      dam_id,
      mom_tag: momTag || null,
      mom_breed: formState.mom_breed || null,
      mom_birth_year: $("#f-mom-year").value ? Number($("#f-mom-year").value) : null,
      birth_date: $("#f-birth").value || todayISO(),
      breed: formState.breed || null,
      gender: formState.gender || null,
      neutered: formState.gender === "Bull" && formState.neutered === "Yes",
      color: formState.color || null,
      weight_lbs: wt,
      weight_history: wt ? [{ date: todayISO(), lbs: wt }] : [],
      vaccinations: vax,
      photo_path,
      notes: $("#f-notes").value.trim() || null,
    };
    const saved = await saveNew(rec);
    toast("Calf saved ✓");
    openProfile(saved.id);
  } catch (err) {
    toast("Error: " + err.message);
    btn.disabled = false; btn.textContent = "Save calf";
  }
}

/* ============================================================
   HERD LIST
   ============================================================ */
let herdFilter = "";
function renderHerd() {
  view().innerHTML = `
    <div class="search-bar">
      <input type="text" id="herd-search" placeholder="Search tag, name, breed, ID…" value="${esc(herdFilter)}" />
    </div>
    <div class="btn-row" style="margin-bottom:10px">
      <button class="btn btn-sm" data-f="all">All</button>
      <button class="btn btn-sm" data-f="herd">In herd</button>
      <button class="btn btn-sm" data-f="cows">Mothers</button>
      <button class="btn btn-sm" data-f="sold">Sold</button>
    </div>
    <div id="herd-list"></div>

    <div class="section-title">Tools</div>
    <div class="card">
      <button class="btn btn-block" id="t-tags">🏷️ Print QR tags (current list)</button>
      <div class="btn-row" style="margin-top:10px">
        <button class="btn btn-sm" id="t-sales" style="flex:1">Export sales (CSV)</button>
        <button class="btn btn-sm" id="t-herd" style="flex:1">Export herd (CSV)</button>
      </div>
      <div class="btn-row" style="margin-top:10px">
        <button class="btn btn-sm" id="t-backup" style="flex:1">Download backup</button>
        <button class="btn btn-sm" id="t-restore" style="flex:1">Restore backup</button>
        <input type="file" id="t-restore-file" accept="application/json" class="hidden">
      </div>
    </div>`;
  $("#herd-search").addEventListener("input", e => { herdFilter = e.target.value; drawHerd("active"); });
  $("#t-tags").addEventListener("click", () => printTags(LAST_HERD_LIST));
  $("#t-sales").addEventListener("click", exportSalesCSV);
  $("#t-herd").addEventListener("click", exportHerdCSV);
  $("#t-backup").addEventListener("click", downloadBackup);
  $("#t-restore").addEventListener("click", () => $("#t-restore-file").click());
  $("#t-restore-file").addEventListener("change", e => { if (e.target.files[0]) restoreBackup(e.target.files[0]); });
  $$(".btn-row [data-f]").forEach(b => b.addEventListener("click", () => {
    $$(".btn-row [data-f]").forEach(x => x.classList.remove("btn-primary"));
    b.classList.add("btn-primary"); drawHerd(b.dataset.f);
  }));
  $('[data-f="all"]').classList.add("btn-primary");
  drawHerd("all");
}

function drawHerd(filter) {
  if (filter === "active") filter = $(".btn-row .btn-primary")?.dataset.f || "all";
  let list = ANIMALS.slice();
  if (filter === "herd") list = list.filter(a => !a.is_sold);
  else if (filter === "sold") list = list.filter(a => a.is_sold);
  else if (filter === "cows") list = list.filter(a => offspringOf(a.id).length > 0);
  const q = herdFilter.trim().toLowerCase();
  if (q) list = list.filter(a =>
    [a.tag_number, a.name, a.breed, a.unique_id, a.color].some(v => v && v.toLowerCase().includes(q)));
  LAST_HERD_LIST = list;
  $("#herd-list").innerHTML = list.length ? renderAnimalRows(list)
    : `<div class="empty">No animals found.<br><span class="muted">Add one from the “Add Calf” tab.</span></div>`;
  wireRows();
}

function renderAnimalRows(list) {
  return list.map(a => {
    const url = photoUrl(a);
    const kids = offspringOf(a.id).length;
    return `<div class="list-item" data-id="${a.id}">
      <div class="thumb">${url ? `<img src="${url}" style="width:100%;height:100%;object-fit:cover;border-radius:8px">` : "🐄"}</div>
      <div class="li-main">
        <div class="li-title">${esc(a.tag_number || "No tag")}${a.name ? " · " + esc(a.name) : ""}
          <span class="badge ${sexBadgeClass(a)}">${sexLabel(a)}</span>
          ${a.is_sold ? '<span class="badge sold">Sold</span>' : ""}
        </div>
        <div class="li-sub">${esc(a.breed || "—")}${a.birth_date ? " · b." + new Date(a.birth_date).getFullYear() : ""}${kids ? " · " + kids + " calf" + (kids > 1 ? "s" : "") : ""}</div>
      </div>
      <div class="muted">›</div>
    </div>`;
  }).join("");
}
function wireRows() {
  $$(".list-item[data-id]").forEach(el => el.addEventListener("click", () => openProfile(el.dataset.id)));
}

/* ============================================================
   PROFILE
   ============================================================ */
function openProfile(id) {
  const a = ANIMALS.find(x => x.id === id);
  if (!a) { toast("Not found"); return; }
  switchTabShell("herd", a.tag_number || a.name || "Animal");
  window.scrollTo(0, 0);
  const url = photoUrl(a);
  const dam = a.dam_id ? ANIMALS.find(x => x.id === a.dam_id) : null;
  const kids = offspringOf(a.id);
  const vax = a.vaccinations || [];

  const kv = (k, v) => `<div class="kv"><span class="k">${k}</span><span class="v">${v}</span></div>`;

  view().innerHTML = `
    <button class="back-btn" id="back">‹ Back to herd</button>
    ${url ? `<img class="profile-photo" src="${url}" alt="">` : ""}
    <div class="card">
      <div class="row-between">
        <h2 style="margin:0">${esc(a.tag_number || "No tag")}${a.name ? " · " + esc(a.name) : ""}</h2>
        <span class="badge ${sexBadgeClass(a)}">${sexLabel(a)}</span>
      </div>
      ${kv("Breed", esc(a.breed || "—"))}
      ${kv("Color", esc(a.color || "—"))}
      ${kv("Birth date", fmtDate(a.birth_date))}
      ${kv("Unique ID", `<span style="font-family:monospace;font-size:13px">${esc(a.unique_id)}</span>`)}
      ${a.is_sold ? kv("Sold", `${fmtDate(a.sale_date)} · ${money(a.sale_price)}`) : ""}
    </div>

    <div class="card">
      <div class="row-between"><h2 style="margin:0">Weight &amp; value</h2>
        <button class="btn btn-sm" id="upd-weight">Update weight</button></div>
      ${kv("Current weight", a.weight_lbs ? a.weight_lbs + " lb" : "—")}
      ${kv("Est. market value", `<span id="est-val" class="muted">…</span>`)}
      ${(a.weight_history || []).length ? `<div class="chip-list" style="margin-top:10px">${a.weight_history.map(w => `<span class="chip">${w.lbs} lb · ${fmtDate(w.date)}</span>`).join("")}</div>` : ""}
    </div>

    <div class="card">
      <h2>Mother</h2>
      ${dam
        ? `<div class="list-item" data-id="${dam.id}"><div class="thumb">🐄</div>
            <div class="li-main"><div class="li-title">${esc(dam.tag_number || dam.name || "Cow")}</div>
            <div class="li-sub">${esc(dam.breed || "")}</div></div><div class="muted">›</div></div>`
        : (a.mom_tag || a.mom_breed
            ? `${kv("Mom's tag", esc(a.mom_tag || "—"))}${kv("Mom's breed", esc(a.mom_breed || "—"))}${kv("Mom's birth yr", a.mom_birth_year || "—")}`
            : `<p class="muted" style="margin:0">No mother recorded.</p>`)}
    </div>

    ${kids.length ? `<div class="card"><h2>Calves (${kids.length})</h2>${renderAnimalRows(kids)}</div>` : ""}

    <div class="card">
      <div class="row-between"><h2 style="margin:0">Vaccinations</h2>
        <button class="btn btn-sm" id="add-vax">+ Add date</button></div>
      ${vax.length
        ? `<div class="chip-list" style="margin-top:10px">${vax.map(v => `<span class="chip">${fmtDate(v.date)}${v.note ? " · " + esc(v.note) : ""}</span>`).join("")}</div>`
        : `<p class="muted" style="margin:8px 0 0">None recorded.</p>`}
    </div>

    <div class="card">
      <div class="row-between"><h2 style="margin:0">Tag history</h2>
        <button class="btn btn-sm" id="change-tag">Change tag</button></div>
      ${(a.tag_history || []).length
        ? `<div class="chip-list" style="margin-top:10px">${a.tag_history.map(t => `<span class="chip">${esc(t.tag)} → ${fmtDate(t.changed_on)}</span>`).join("")}</div>`
        : `<p class="muted" style="margin:8px 0 0">No previous tags.</p>`}
    </div>

    ${a.notes ? `<div class="card"><h2>Notes</h2><p style="margin:0;white-space:pre-wrap">${esc(a.notes)}</p></div>` : ""}

    <div class="btn-row" style="margin-top:4px">
      <button class="btn btn-d" id="edit" style="flex:1">Edit details</button>
      ${a.is_sold ? "" : `<button class="btn" id="sell" style="flex:1">Record sale</button>`}
    </div>
    <button class="btn btn-block" id="qr-tag" style="margin-top:10px">🏷️ Print QR ear-tag</button>
    <button class="btn btn-danger btn-block" id="del" style="margin-top:10px">Delete record</button>
  `;
  $("#back").addEventListener("click", () => switchTab("herd"));
  $("#edit").addEventListener("click", () => renderEditForm(id));
  $("#upd-weight").addEventListener("click", () => updateWeightPrompt(id));
  $("#qr-tag").addEventListener("click", () => printTags([a]));
  getMarket().then(m => {
    const el = $("#est-val"); if (!el) return;
    const v = estimateValue(a, m), cwt = cwtFor(a, m);
    el.className = v ? "" : "muted";
    el.innerHTML = v ? `<b>${money(v)}</b> <span class="muted">(~$${cwt.toFixed(0)}/cwt)</span>`
      : (a.weight_lbs ? "market data pending" : "add a weight");
  });
  $("#add-vax").addEventListener("click", () => addVaxPrompt(id));
  $("#change-tag").addEventListener("click", () => changeTagPrompt(id));
  if ($("#sell")) $("#sell").addEventListener("click", () => sellPrompt(id));
  $("#del").addEventListener("click", () => delPrompt(id));
  const damItem = $(".card .list-item[data-id]");
  if (damItem && dam) damItem.addEventListener("click", () => openProfile(dam.id));
  $$("#view .card")[3] && wireRows(); // calves rows
  wireRows();
}

async function addVaxPrompt(id) {
  const a = ANIMALS.find(x => x.id === id);
  const date = prompt("Vaccination date (YYYY-MM-DD):", todayISO());
  if (!date) return;
  const note = prompt("Note (optional, e.g. 7-way):", "") || "";
  const vax = [...(a.vaccinations || []), { date, note }].sort((x, y) => x.date.localeCompare(y.date));
  try { await saveUpdate(id, { vaccinations: vax }); toast("Vaccination added ✓"); openProfile(id); }
  catch (e) { toast("Error: " + e.message); }
}
async function updateWeightPrompt(id) {
  const a = ANIMALS.find(x => x.id === id);
  const lbs = prompt("Current weight (lbs):", a.weight_lbs || "");
  if (lbs === null) return;
  const n = Number(lbs); if (!n) { toast("Enter a number"); return; }
  const hist = [...(a.weight_history || []), { date: todayISO(), lbs: n }];
  try { await saveUpdate(id, { weight_lbs: n, weight_history: hist }); toast("Weight updated ✓"); openProfile(id); }
  catch (e) { toast("Error: " + e.message); }
}
async function changeTagPrompt(id) {
  const a = ANIMALS.find(x => x.id === id);
  const newTag = prompt("New tag number:", "");
  if (newTag === null) return;
  const hist = [...(a.tag_history || [])];
  if (a.tag_number) hist.push({ tag: a.tag_number, changed_on: todayISO() });
  try { await saveUpdate(id, { tag_number: newTag.trim() || null, tag_history: hist }); toast("Tag updated ✓"); openProfile(id); }
  catch (e) { toast("Error: " + e.message); }
}
async function sellPrompt(id) {
  const price = prompt("Sale price ($):", "");
  if (price === null) return;
  const date = prompt("Sale date (YYYY-MM-DD):", todayISO());
  if (!date) return;
  try { await saveUpdate(id, { sale_price: Number(price) || null, sale_date: date }); toast("Sale recorded ✓"); openProfile(id); }
  catch (e) { toast("Error: " + e.message); }
}
async function delPrompt(id) {
  if (!confirm("Delete this record permanently? This cannot be undone.")) return;
  try { await deleteAnimal(id); toast("Deleted"); switchTab("herd"); }
  catch (e) { toast("Error: " + e.message); }
}

/* ============================================================
   EDIT FORM
   ============================================================ */
function renderEditForm(id) {
  const a = ANIMALS.find(x => x.id === id);
  formState = {
    gender: a.gender, neutered: a.neutered ? "Yes" : "No",
    breed: a.breed, mom_breed: a.mom_breed, color: a.color, dam_id: a.dam_id, photoFile: null,
  };
  switchTabShell("herd", "Edit");
  view().innerHTML = `
    <button class="back-btn" id="back">‹ Cancel</button>
    <form id="edit-form">
      <div class="field"><label>Name</label><input type="text" id="f-name" value="${esc(a.name || "")}"></div>
      <div class="field"><label>Tag number</label><input type="text" id="f-tag" value="${esc(a.tag_number || "")}">
        <div class="fab-note">To keep tag history, use “Change tag” on the profile instead.</div></div>
      <div class="field"><label>Birth date</label><input type="date" id="f-birth" value="${esc(a.birth_date || "")}"></div>
      <div class="field"><label>Calf breed</label>${chipGroup("breed", CFG.CALF_BREEDS, a.breed)}</div>
      <div class="field"><label>Gender</label>${chipGroup("gender", ["Heifer", "Bull"], a.gender)}
        <div id="neuter-wrap" class="${a.gender === "Bull" ? "" : "hidden"}" style="margin-top:10px">
          <label>Neutered? <span class="hint">(steer)</span></label>${chipGroup("neutered", ["No", "Yes"], a.neutered ? "Yes" : "No")}
        </div></div>
      <div class="field"><label>Color</label>${chipGroup("color", CFG.COLORS, a.color)}</div>
      <div class="field"><label>Current weight (lbs)</label><input type="number" id="f-weight" value="${esc(a.weight_lbs ?? "")}">
        <div class="fab-note">Use “Update weight” on the profile to keep weight history.</div></div>
      <div class="field"><label>Mom's breed</label>${chipGroup("mom_breed", CFG.MOM_BREEDS, a.mom_breed)}</div>
      <div class="grid2">
        <div class="field"><label>Mom's tag #</label><input type="text" id="f-mom-tag" value="${esc(a.mom_tag || "")}"></div>
        <div class="field"><label>Mom's birth year</label><input type="number" id="f-mom-year" value="${esc(a.mom_birth_year || "")}"></div>
      </div>
      <div class="field"><label>Replace photo</label><input type="file" id="f-photo" accept="image/*" capture="environment"></div>
      <div class="field"><label>Sale price</label><input type="number" id="f-price" value="${esc(a.sale_price ?? "")}"></div>
      <div class="field"><label>Sale date</label><input type="date" id="f-sale" value="${esc(a.sale_date || "")}"></div>
      <div class="field"><label>Notes</label><textarea id="f-notes">${esc(a.notes || "")}</textarea></div>
      <button type="submit" class="btn btn-primary btn-block">Save changes</button>
    </form>`;
  wireChips();
  $("#back").addEventListener("click", () => openProfile(id));
  $("#edit-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector("button"); btn.disabled = true; btn.textContent = "Saving…";
    try {
      const patch = {
        name: $("#f-name").value.trim() || null,
        tag_number: $("#f-tag").value.trim() || null,
        birth_date: $("#f-birth").value || null,
        breed: formState.breed || null,
        gender: formState.gender || null,
        neutered: formState.gender === "Bull" && formState.neutered === "Yes",
        color: formState.color || null,
        mom_breed: formState.mom_breed || null,
        mom_tag: $("#f-mom-tag").value.trim() || null,
        mom_birth_year: $("#f-mom-year").value ? Number($("#f-mom-year").value) : null,
        weight_lbs: $("#f-weight").value ? Number($("#f-weight").value) : null,
        sale_price: $("#f-price").value ? Number($("#f-price").value) : null,
        sale_date: $("#f-sale").value || null,
        notes: $("#f-notes").value.trim() || null,
      };
      const file = $("#f-photo").files[0];
      if (file) patch.photo_path = await uploadPhoto(file, a.unique_id);
      await saveUpdate(id, patch);
      toast("Saved ✓"); openProfile(id);
    } catch (err) { toast("Error: " + err.message); btn.disabled = false; btn.textContent = "Save changes"; }
  });
}

/* ============================================================
   MARKET & NEWS
   ============================================================ */
let marketChart = null;
let MARKET_CACHE = null;
async function getMarket(force) {
  if (MARKET_CACHE && !force) return MARKET_CACHE;
  try { const r = await fetch(CFG.MARKET_DATA_URL + "?t=" + Date.now()); if (r.ok) MARKET_CACHE = await r.json(); } catch (_) {}
  return MARKET_CACHE;
}

/* ---- value estimator: live $/cwt × weight ---- */
function classOf(a) { if (a.gender === "Heifer") return "Heifers"; return a.neutered ? "Steers" : "Bulls"; }
function cwtFor(a, market) {
  const w = Number(a.weight_lbs); if (!w || !market) return null;
  const cls = classOf(a), band = Math.floor(w / 100) * 100;
  const label = `${cls} ${band}-${band + 100} lb`;
  const prices = [];
  (market.auctions || []).forEach(au => (au.categories || []).forEach(c => {
    if (c.label === label) prices.push((Number(c.low) + Number(c.high)) / 2);
  }));
  if (prices.length) return prices.reduce((s, n) => s + n, 0) / prices.length;
  const s = market.series || []; return s.length ? s[s.length - 1].price : null;  // fallback
}
function estimateValue(a, market) {
  const w = Number(a.weight_lbs), cwt = cwtFor(a, market);
  return (w && cwt) ? (w / 100) * cwt : null;
}
function computeHerdValue(market) {
  const live = ANIMALS.filter(a => !a.is_sold);
  let total = 0, withW = 0;
  live.forEach(a => { const v = estimateValue(a, market); if (v) { total += v; withW++; } });
  return { total, withW, missing: live.length - withW };
}

async function renderMarket() {
  view().innerHTML = `<div class="empty"><div class="spinner" style="margin:0 auto"></div><p>Loading market data…</p></div>`;
  const data = await getMarket(true);

  if (!data) {
    view().innerHTML = `<div class="card"><h2>Market data not loaded yet</h2>
      <p class="muted">The daily updater hasn't published <code>market-data.json</code> yet. Once the GitHub Action runs (or you run it manually once), Virginia &amp; mid-Atlantic auction prices and cattle news will appear here automatically.</p></div>`;
    return;
  }

  const series = data.series || [];
  const last = series[series.length - 1], prev = series[series.length - 2];
  const delta = (last && prev) ? last.price - prev.price : 0;
  const deltaTxt = prev ? `<span class="${delta >= 0 ? "price-up" : "price-down"}">${delta >= 0 ? "▲" : "▼"} ${Math.abs(delta).toFixed(2)}</span>` : "";

  view().innerHTML = `
    <p class="muted" style="margin-top:0;font-size:13px">Updated ${data.updated ? new Date(data.updated).toLocaleString() : "—"} · Source: USDA / VDACS Market News</p>

    <div class="card">
      <h2>Feeder Steers 500–600 lb · VA avg ($/cwt)</h2>
      ${last ? `<div style="font-size:30px;font-weight:700">$${last.price.toFixed(2)} ${deltaTxt}</div>
        <div class="muted" style="font-size:12px">as of ${fmtDate(last.date)}</div>` : ""}
      <div style="position:relative;height:200px;margin-top:10px"><canvas id="mkt-chart"></canvas></div>
    </div>

    <div class="section-title">Recent Auctions</div>
    <div id="auctions"></div>

    <div class="section-title">Cattle News — VA & Mid-Atlantic</div>
    <div class="card" id="news"></div>
  `;

  // chart
  if (series.length && window.Chart) {
    const ctx = $("#mkt-chart");
    if (marketChart) marketChart.destroy();
    marketChart = new Chart(ctx, {
      type: "line",
      data: {
        labels: series.map(p => p.date.slice(5)),
        datasets: [{ data: series.map(p => p.price), borderColor: "#4a6b3a", backgroundColor: "rgba(74,107,58,.12)",
          fill: true, tension: .3, pointRadius: 2 }],
      },
      options: { plugins: { legend: { display: false } },
        scales: { y: { ticks: { callback: v => "$" + v } } }, maintainAspectRatio: false },
    });
  }

  // auctions
  const au = data.auctions || [];
  $("#auctions").innerHTML = au.length ? au.map(a => `
    <div class="card" style="margin-bottom:10px">
      <div class="row-between"><b>${esc(a.name || "Auction")}</b><span class="muted" style="font-size:12px">${esc(a.report_date || "")}</span></div>
      <div class="muted" style="font-size:13px;margin-bottom:6px">${esc(a.location || "")}${a.head ? " · " + a.head + " head" : ""}</div>
      ${(a.categories || []).slice(0, 6).map(c =>
        `<div class="kv"><span class="k">${esc(c.label)}</span><span class="v">$${c.low}–${c.high}</span></div>`).join("")}
    </div>`).join("") : `<div class="card muted">No recent auction reports.</div>`;

  // news
  const news = data.news || [];
  $("#news").innerHTML = news.length ? news.map(n => `
    <a class="news-item" href="${esc(n.url)}" target="_blank" rel="noopener">
      <div class="n-title">${esc(n.title)}</div>
      <div class="n-meta">${esc(n.source || "")}${n.date ? " · " + esc(n.date) : ""}</div>
    </a>`).join("") : `<p class="muted" style="margin:0">No recent headlines.</p>`;
}

/* ============================================================
   QR EAR-TAG LABELS  (printable; scanning opens the profile)
   ============================================================ */
async function printTags(list) {
  if (!list || !list.length) { toast("No animals to print"); return; }
  if (!window.QRCode) { toast("QR library still loading — try again in a moment"); return; }
  toast("Building tags…");
  const base = location.origin + location.pathname;
  const cells = await Promise.all(list.map(async a => {
    const url = base + "?a=" + encodeURIComponent(a.unique_id);
    let img = "";
    try { img = await QRCode.toDataURL(url, { margin: 1, width: 260 }); } catch (_) {}
    return `<div class="tag">
      ${img ? `<img src="${img}" alt="">` : ""}
      <div class="tag-tag">${esc(a.tag_number || "—")}</div>
      <div class="tag-sub">${esc(a.name || "")}${a.name && a.breed ? " · " : ""}${esc(a.breed || "")}</div>
      <div class="tag-id">${esc(a.unique_id)}</div>
    </div>`;
  }));
  let pa = document.getElementById("print-area");
  if (!pa) { pa = document.createElement("div"); pa.id = "print-area"; document.body.appendChild(pa); }
  pa.innerHTML = `<div class="tag-sheet">${cells.join("")}</div>`;
  document.body.classList.add("printing");
  window.print();
  setTimeout(() => document.body.classList.remove("printing"), 600);
}

/* ============================================================
   CSV EXPORT + BACKUP / RESTORE
   ============================================================ */
function downloadFile(name, text, type) {
  const blob = new Blob([text], { type: type || "text/plain" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1500);
}
const csvCell = (v) => { if (v == null) return ""; v = String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
const toCSV = (rows) => rows.map(r => r.map(csvCell).join(",")).join("\n");

function exportSalesCSV() {
  const sold = ANIMALS.filter(a => a.sale_date).sort((a, b) => b.sale_date.localeCompare(a.sale_date));
  const rows = [["Tag", "Name", "Breed", "Sex", "Birth date", "Sale date", "Sale price", "Unique ID"]];
  sold.forEach(a => rows.push([a.tag_number, a.name, a.breed, sexLabel(a), a.birth_date, a.sale_date, a.sale_price, a.unique_id]));
  downloadFile(`cattle-sales-${todayISO()}.csv`, toCSV(rows), "text/csv");
  toast(`Exported ${sold.length} sales`);
}
function exportHerdCSV() {
  const rows = [["Tag", "Name", "Breed", "Sex", "Color", "Birth date", "Weight lbs", "Mom tag", "Last vaccination", "Sold", "Unique ID"]];
  ANIMALS.forEach(a => {
    const momTag = a.mom_tag || (a.dam_id ? (ANIMALS.find(x => x.id === a.dam_id) || {}).tag_number : "") || "";
    rows.push([a.tag_number, a.name, a.breed, sexLabel(a), a.color, a.birth_date, a.weight_lbs, momTag, lastVaxDate(a), a.is_sold ? "yes" : "", a.unique_id]);
  });
  downloadFile(`herd-inventory-${todayISO()}.csv`, toCSV(rows), "text/csv");
  toast(`Exported ${ANIMALS.length} animals`);
}
function downloadBackup() {
  downloadFile(`cattle-backup-${todayISO()}.json`, JSON.stringify(ANIMALS, null, 2), "application/json");
  toast("Backup downloaded");
}
async function restoreBackup(file) {
  try {
    const arr = JSON.parse(await file.text());
    if (!Array.isArray(arr)) throw new Error("not a backup file");
    if (!confirm(`Restore ${arr.length} records? Records with the same ID will be overwritten; nothing is deleted.`)) return;
    for (const rec of arr) { const { is_sold, ...clean } = rec; await saveNew(clean); }  // saveNew upserts by id
    toast(`Restored ${arr.length} records`); renderHerd();
  } catch (e) { toast("Restore failed: " + e.message); }
}
