/* Сетлист гурту — зв'язок сторінки з Supabase.
   Дає сторінці той самий набір викликів, що й claude.ai (db, user, assets),
   але дані живуть у Supabase, а вхід — через Google для пошт зі списку учасників. */
(function () {
  "use strict";
  const CFG = window.SETLIST_CONFIG || {};
  const BASE = String(CFG.supabaseUrl || "").replace(/\/+$/, "");
  const ANON = String(CFG.supabaseAnonKey || "");
  const POLL_MS = 12000;
  const sb = (BASE && ANON && window.supabase)
    ? window.supabase.createClient(BASE, ANON, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: "pkce" } })
    : null;

  let ME = { email: "", name: "", member: false };

  async function rpc(name, args) {
    const { data, error } = await sb.rpc(name, args || {});
    if (error) {
      const e = new Error(error.message || "server");
      e.code = /not a band member|permission denied|JWT/i.test(error.message || "") ? "no_access" : "server";
      if (e.code === "no_access") checkAccess();
      throw e;
    }
    return data;
  }

  // ---------- documents with polling "live" updates ----------
  const cache = {}, subs = {}, docSubs = {};
  let lastStamp = "";
  const clone = v => JSON.parse(JSON.stringify(v));
  function snapFor(c) {
    const m = cache[c] || new Map();
    return { metadata: { fromCache: false }, docs: [...m.entries()].map(([id, d]) => ({ id, data: () => clone(d) })) };
  }
  function notify(c) {
    (subs[c] || []).forEach(cb => { try { cb(snapFor(c)); } catch (e) { console.error(e); } });
    const m = cache[c] || new Map();
    Object.keys(docSubs).forEach(k => {
      const i = k.indexOf("/"), cc = k.slice(0, i), id = k.slice(i + 1);
      if (cc !== c) return;
      docSubs[k].forEach(cb => { try { cb({ exists: m.has(id), data: () => (m.has(id) ? clone(m.get(id)) : undefined) }); } catch (e) { console.error(e); } });
    });
  }
  async function load(c) {
    const rows = await rpc("api_list", { p_collection: c });
    cache[c] = new Map((rows || []).map(r => [r.id, r.data]));
    notify(c);
  }
  const watched = () => new Set([...Object.keys(subs), ...Object.keys(docSubs).map(k => k.slice(0, k.indexOf("/")))]);
  async function poll(force) {
    if (!ME.member) return;
    try {
      const st = await rpc("api_stamp", {});
      const sig = JSON.stringify((st || []).sort((a, b) => a.collection.localeCompare(b.collection)));
      if (!force && sig === lastStamp) return;
      lastStamp = sig;
      for (const c of watched()) await load(c);
    } catch (e) { if (e.code !== "no_access") console.warn("Оновлення не вдалося", e); }
  }
  setInterval(() => { if (document.visibilityState === "visible") poll(false); }, POLL_MS);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") poll(false); });

  const newId = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2)).replace(/-/g, "").slice(0, 20);
  function local(c, id, data, merge) {
    cache[c] = cache[c] || new Map();
    if (data === null) cache[c].delete(id);
    else cache[c].set(id, merge && cache[c].has(id) ? Object.assign({}, cache[c].get(id), data) : data);
    lastStamp = ""; notify(c);
  }
  const db = {
    collection(c) {
      return {
        onSnapshot(cb, err) {
          (subs[c] = subs[c] || new Set()).add(cb);
          if (cache[c]) setTimeout(() => cb(snapFor(c))); else load(c).catch(e => err && err(e));
          return () => subs[c].delete(cb);
        },
        async add(data) { const id = newId(), v = clone(data); await rpc("api_set", { p_collection: c, p_id: id, p_data: v }); local(c, id, v, false); return { id }; }
      };
    },
    doc(path) {
      const i = path.indexOf("/"), c = path.slice(0, i), id = path.slice(i + 1);
      return {
        async set(data) { const v = clone(data); await rpc("api_set", { p_collection: c, p_id: id, p_data: v }); local(c, id, v, false); },
        async update(patch) { const v = clone(patch); await rpc("api_update", { p_collection: c, p_id: id, p_patch: v }); local(c, id, v, true); },
        async delete() { await rpc("api_delete", { p_collection: c, p_id: id }); local(c, id, null); },
        onSnapshot(cb, err) {
          const k = c + "/" + id; (docSubs[k] = docSubs[k] || new Set()).add(cb);
          if (cache[c]) { const m = cache[c]; setTimeout(() => cb({ exists: m.has(id), data: () => clone(m.get(id)) })); }
          else load(c).catch(e => err && err(e));
          return () => docSubs[k].delete(cb);
        }
      };
    }
  };

  // ---------- who is using the page ----------
  const myName = () => ME.name || ME.googleName || ME.email || "Учасник";
  const user = {
    async can() { return true; }, canEdit() { return true; }, isOwner() { return true; },
    async id() { return myName(); },
    async me() { return { id: myName(), name: myName(), email: ME.email }; },
    async search() { return []; },
    async profiles(ids) { const o = {}; (ids || []).forEach(i => { o[i] = { id: i, name: i }; }); return o; }
  };

  // ---------- files (PDF) ----------
  function blobUrl(id) {
    id = String(id || "");
    if (id.startsWith("static/")) return id.slice(7);
    return `${BASE}/storage/v1/object/public/files/${id.split("/").map(encodeURIComponent).join("/")}`;
  }
  const assets = {
    async upload(file, opts) {
      if (file.size > 20 * 1024 * 1024) { const e = new Error("too large"); e.code = "too_large"; throw e; }
      const ext = (/\.[a-z0-9]{1,5}$/i.exec(file.name || "") || [".pdf"])[0].toLowerCase();
      const path = `${newId()}${ext}`;
      const { error } = await sb.storage.from("files").upload(path, file, { contentType: (opts && opts.type) || file.type || "application/octet-stream", upsert: false });
      if (error) { const e = new Error(error.message); e.code = /size|large/i.test(error.message || "") ? "too_large" : "server"; throw e; }
      return { id: path, url: blobUrl(path), sizeBytes: file.size, contentType: file.type };
    },
    async delete(id) { if (!id || String(id).startsWith("static/")) return; await sb.storage.from("files").remove([id]); },
    async list() { return { assets: [], usage: {} }; }
  };
  window.blobUrl = blobUrl;

  // ---------- sign-in gate ----------
  let readyResolve; const ready = new Promise(r => { readyResolve = r; });
  const $ = id => document.getElementById(id);
  function showPanel(which, msg) {
    const g = $("band-gate"); if (!g) return;
    g.hidden = false; document.body.style.overflow = "hidden";
    ["gate-login", "gate-denied", "gate-wait"].forEach(p => { const el = $(p); if (el) el.hidden = p !== which; });
    const m = $("gate-msg"); if (m) { m.textContent = msg || ""; m.hidden = !msg; }
  }
  function hideGate() { const g = $("band-gate"); if (g) g.hidden = true; document.body.style.overflow = ""; }

  async function checkAccess() {
    const { data } = await sb.auth.getSession();
    const s = data && data.session;
    if (!s) { ME = { email: "", name: "", member: false }; showPanel("gate-login"); return false; }
    const meta = s.user && s.user.user_metadata || {};
    let me = null; try { me = await sb.rpc("api_me").then(r => r.data); } catch (_) {}
    ME = { email: (me && me.email) || (s.user && s.user.email) || "", name: (me && me.name) || "", googleName: meta.full_name || meta.name || "", member: !!(me && me.member) };
    if (!ME.member) {
      const em = $("gate-email"); if (em) em.textContent = ME.email || "цей акаунт";
      showPanel("gate-denied"); return false;
    }
    hideGate(); readyResolve(); return true;
  }

  function wireGate() {
    const login = $("gate-google");
    if (login) login.onclick = async () => {
      login.disabled = true;
      const redirectTo = location.origin + location.pathname;
      const { error } = await sb.auth.signInWithOAuth({ provider: "google", options: { redirectTo, queryParams: { prompt: "select_account" } } });
      if (error) { login.disabled = false; showPanel("gate-login", "Не вдалося відкрити вхід Google. Спробуй ще раз."); }
    };
    const out = async () => { try { await sb.auth.signOut(); } catch (_) {} location.reload(); };
    const other = $("gate-other-account"); if (other) other.onclick = out;
    const lo = $("band-logout"); if (lo) lo.onclick = out;
  }

  async function boot() {
    wireGate();
    if (!sb) { showPanel("gate-wait", "Сайт ще не підключено до бази. Власнику: заповни config.js."); return; }
    showPanel("gate-wait");
    sb.auth.onAuthStateChange((ev) => { if (ev === "SIGNED_IN" || ev === "SIGNED_OUT") checkAccess(); });
    await checkAccess();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();

  // ---------- the same entry point the page already uses ----------
  window.claude = {
    async use(name) {
      await ready;
      if (name === "db") return db;
      if (name === "user") return user;
      if (name === "assets") return assets;
      return null;
    }
  };
  window.bandBackend = { rpc, reload: () => poll(true), blobUrl, me: () => (ME.member ? myName() : ""), email: () => ME.email };
})();
