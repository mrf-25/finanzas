/* =========================================================
   Nube: inicio de sesión y sincronización con Supabase.

   La app sigue guardando todo en el dispositivo (funciona sin conexión).
   Cuando hay sesión, cada cambio se sube y los cambios de otros
   dispositivos se bajan. La fusión es registro a registro:
     base   = último estado que este dispositivo sincronizó
     local  = lo que hay ahora en este dispositivo
     remoto = lo que hay ahora en la nube
   Un registro cambiado en un solo lado gana ese lado; uno borrado en un
   lado y editado en el otro se conserva; si se editó en los dos, gana
   este dispositivo. Ningún registro se pierde por sincronizar.

   Sin librerías: llamadas directas a la API de Supabase, para que la
   app no dependa de nada externo al cargar.
   ========================================================= */
(function (root) {
  'use strict';

  const URL_BASE = 'https://atfccztimxbbhlitrmyj.supabase.co';
  // Clave pública: está pensada para ir en la app. El acceso a los datos lo
  // limitan las reglas de la base de datos (cada usuario solo ve los suyos).
  const API_KEY = 'sb_publishable_ciIXw_pCjsag_7DIBrYqkw_TyDwErnm';
  const COLLECTIONS = ['movs', 'cats', 'pend', 'invs', 'snaps'];

  /* ---------------- fusión (funciones puras) ---------------- */

  // JSON con las claves ordenadas, para comparar registros sin depender del orden.
  function stable(v) {
    if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
    if (v && typeof v === 'object') {
      return '{' + Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
    }
    return JSON.stringify(v === undefined ? null : v);
  }
  const same = (a, b) => stable(a) === stable(b);
  const clone = v => JSON.parse(JSON.stringify(v));

  // Une una colección (lista de objetos con id) a tres bandas.
  function mergeList(base, local, remote) {
    const B = new Map((base || []).map(x => [x.id, x]));
    const L = new Map((local || []).map(x => [x.id, x]));
    const R = new Map((remote || []).map(x => [x.id, x]));
    const pick = id => {
      const b = B.get(id), l = L.get(id), r = R.get(id);
      if (l && r) {
        if (same(l, r) || same(r, b)) return l;
        if (same(l, b)) return r;
        return l; // editado en los dos: gana este dispositivo
      }
      if (l) return !b || !same(l, b) ? l : null; // borrado en la nube sin editar aquí → fuera
      if (r) return !b || !same(r, b) ? r : null; // borrado aquí sin editar en la nube → fuera
      return null;
    };
    const out = [], seen = new Set();
    for (const x of (local || []).concat(remote || [])) {
      if (seen.has(x.id)) continue;
      seen.add(x.id);
      const v = pick(x.id);
      if (v) out.push(clone(v));
    }
    return out;
  }

  // Un solo valor por inversión y mes: si dos dispositivos apuntaron el mismo mes, queda el más reciente.
  function dedupeSnaps(snaps) {
    const best = new Map();
    for (const s of snaps) {
      const k = s.inv + '|' + s.ym;
      const cur = best.get(k);
      if (!cur || (s.t || 0) > (cur.t || 0)) best.set(k, s);
    }
    const keep = new Set([...best.values()].map(s => s.id));
    return snaps.filter(s => keep.has(s.id));
  }

  function merge3(base, local, remote) {
    base = base || {};
    const out = clone(local);
    for (const c of COLLECTIONS) out[c] = mergeList(base[c], local[c], remote[c]);
    out.snaps = dedupeSnaps(out.snaps);
    // Ajustes: gana el lado que haya cambiado
    const bi = base.cfg && base.cfg.inflation, li = local.cfg && local.cfg.inflation, ri = remote.cfg && remote.cfg.inflation;
    out.cfg = Object.assign({}, remote.cfg, local.cfg, { inflation: li !== bi ? li : ri !== undefined ? ri : li });
    out.lastBackup = Math.max(local.lastBackup || 0, remote.lastBackup || 0) || null;
    out.version = Math.max(local.version || 1, remote.version || 1);
    return out;
  }

  // Primera vez que un dispositivo se une a la nube: suma lo de los dos lados.
  // Las categorías con el mismo nombre y tipo se tratan como la misma.
  function firstMerge(local, remote) {
    local = clone(local);
    const remap = {};
    const key = c => c.type + '|' + String(c.name).trim().toLowerCase();
    const byKey = new Map((remote.cats || []).filter(c => !c.archived).map(c => [key(c), c.id]));
    local.cats = (local.cats || []).filter(c => {
      if (c.system) return true;
      const rid = byKey.get(key(c));
      if (rid && rid !== c.id) { remap[c.id] = rid; return false; }
      return true;
    });
    for (const m of local.movs || []) if (remap[m.cat]) m.cat = remap[m.cat];
    return merge3({}, local, remote);
  }

  const hasData = d => !!d && ((d.movs || []).length + (d.pend || []).length + (d.invs || []).length > 0);

  /* ---------------- cliente ---------------- */

  const K_SESSION = 'finanzas.nube.sesion';
  const K_BASE = 'finanzas.nube.base';
  const K_BEFORE = 'finanzas.data.antes-nube';

  const ls = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (_) { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (_) { return false; } },
    del(k) { try { localStorage.removeItem(k); } catch (_) {} },
  };

  const S = {
    session: null,       // { access_token, refresh_token, expires_at, user: { id, email } }
    state: 'off',        // off | syncing | ok | offline | error | login | outdated
    message: '',
    lastSync: 0,
    busy: false,
    again: false,
    timer: 0,
    wired: false,
    hooks: { get: null, set: null, onState: null, migrate: null, version: 1 },
  };

  class NetError extends Error {}
  class ApiError extends Error { constructor(msg, status, code) { super(msg); this.status = status; this.code = code; } }

  async function call(path, { method = 'GET', body, token, headers = {} } = {}) {
    let res;
    try {
      res = await fetch(URL_BASE + path, {
        method,
        headers: Object.assign({ apikey: API_KEY, 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}, headers),
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      throw new NetError('Sin conexión');
    }
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (_) {}
    if (!res.ok) {
      const code = (json && (json.error_code || json.code || json.error)) || '';
      const msg = (json && (json.msg || json.message || json.error_description)) || ('Error ' + res.status);
      throw new ApiError(msg, res.status, String(code));
    }
    return json;
  }

  // Mensajes de error en castellano para el usuario.
  function humanError(e, mode) {
    if (e instanceof NetError) return 'No hay conexión. Prueba de nuevo cuando tengas internet.';
    const c = e.code || '', m = (e.message || '').toLowerCase();
    if (c === 'invalid_credentials' || m.includes('invalid login')) return 'El email o la contraseña no son correctos.';
    if (c === 'email_not_confirmed') return 'Falta confirmar el email. Abre el enlace que te ha llegado y vuelve a entrar.';
    if (c === 'weak_password' || m.includes('password should')) return 'La contraseña tiene que tener al menos 6 caracteres.';
    if (c === 'user_already_exists' || m.includes('already registered')) return 'Ya existe una cuenta con ese email. Entra con tu contraseña.';
    if (c === 'email_address_invalid' || c === 'validation_failed') return 'Revisa el email: no parece válido.';
    if (c === 'email_address_not_authorized') return 'Supabase no puede enviar el email de confirmación a esa dirección. Desactiva "Confirm email" en Supabase o usa el email de tu cuenta de Supabase.';
    if (c === 'over_email_send_rate_limit' || e.status === 429) return 'Demasiados intentos seguidos. Espera unos minutos.';
    if (mode === 'signup' && (e.status === 500 || m.includes('database error'))) return 'El registro está cerrado: ya existe la cuenta de esta app. Entra con ella.';
    return 'No se ha podido completar: ' + e.message;
  }

  function setState(state, message) {
    S.state = state;
    S.message = message || '';
    if (S.hooks.onState) S.hooks.onState(S);
  }

  function saveSession(j) {
    S.session = {
      access_token: j.access_token,
      refresh_token: j.refresh_token,
      expires_at: j.expires_at || Math.floor(Date.now() / 1000) + (j.expires_in || 3600),
      user: { id: j.user.id, email: j.user.email },
    };
    ls.set(K_SESSION, S.session);
  }

  async function token(force) {
    // Otra pestaña puede haber renovado ya la sesión: se usa esa en vez de renovar otra vez.
    const stored = ls.get(K_SESSION);
    if (S.session && stored && stored.user && stored.user.id === S.session.user.id &&
        stored.access_token !== S.session.access_token && stored.expires_at >= S.session.expires_at) {
      S.session = stored;
      force = false;
    }
    const s = S.session;
    if (!s) throw new ApiError('Sin sesión', 401, 'no_session');
    if (!force && s.expires_at - 60 > Date.now() / 1000) return s.access_token;
    try {
      saveSession(await call('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: s.refresh_token } }));
    } catch (e) {
      if (e instanceof ApiError) { lostSession(); throw new ApiError('Sesión caducada', 401, 'session_expired'); }
      throw e;
    }
    return S.session.access_token;
  }

  function lostSession() {
    S.session = null;
    ls.del(K_SESSION);
    setState('login', 'La sesión ha caducado. Vuelve a entrar para seguir sincronizando.');
  }

  async function rest(path, opts) {
    try {
      return await call(path, Object.assign({}, opts, { token: await token() }));
    } catch (e) {
      if (e instanceof ApiError && e.status === 401 && S.session) {
        return call(path, Object.assign({}, opts, { token: await token(true) })); // renueva y reintenta una vez
      }
      throw e;
    }
  }

  async function signIn(email, password) {
    try {
      saveSession(await call('/auth/v1/token?grant_type=password', { method: 'POST', body: { email, password } }));
      return { ok: true };
    } catch (e) { return { ok: false, error: humanError(e, 'signin') }; }
  }

  async function signUp(email, password) {
    try {
      const j = await call('/auth/v1/signup', { method: 'POST', body: { email, password } });
      if (j && j.access_token) { saveSession(j); return { ok: true }; }
      return { ok: false, confirm: true, error: 'Te ha llegado un email para confirmar la cuenta. Ábrelo y después entra aquí con tu contraseña.' };
    } catch (e) { return { ok: false, error: humanError(e, 'signup') }; }
  }

  async function signOut() {
    const s = S.session;
    S.session = null;
    ls.del(K_SESSION);
    setState('off');
    if (s) { try { await call('/auth/v1/logout', { method: 'POST', token: s.access_token }); } catch (_) {} }
  }

  const baseRec = () => { const b = ls.get(K_BASE); return b && S.session && b.uid === S.session.user.id ? b : null; };
  const loadBase = () => { const b = baseRec(); return b ? b.doc : null; };
  const saveBase = (doc, at) => ls.set(K_BASE, { uid: S.session.user.id, doc, at });
  const needsFirstBackup = () => !!S.session && !loadBase() && hasData(S.hooks.get());

  // Una pasada de sincronización. Si hay cambios mientras tanto, se repite.
  async function sync() {
    if (!S.session) return;
    if (S.busy) { S.again = true; return; }
    if (typeof navigator !== 'undefined' && navigator.onLine === false) { setState('offline', 'Sin conexión: se subirá al volver.'); return; }
    S.busy = true;
    setState('syncing');
    try {
      for (let attempt = 0; attempt < 4; attempt++) {
        const before = clone(S.hooks.get());
        const rows = await rest('/rest/v1/finanzas?select=data,rev');
        const row = rows && rows[0];
        let remote = row ? row.data : null;
        if (remote && (remote.version || 1) > S.hooks.version) {
          setState('outdated', 'La nube tiene datos de una versión más nueva. Cierra y abre la app para actualizarla.');
          return;
        }
        if (remote) remote = S.hooks.migrate(clone(remote));
        const base = loadBase();
        if (!base) ls.set(K_BEFORE, before); // copia local intacta antes de la primera fusión
        // Sin base: primera vez en este dispositivo. Si aquí no hay nada aún, se toma lo de la nube tal cual.
        const merged = !remote ? before : base ? merge3(base, before, remote) : hasData(before) ? firstMerge(before, remote) : clone(remote);
        if (!remote) {
          try { await rest('/rest/v1/finanzas', { method: 'POST', body: { data: merged, rev: 1 }, headers: { Prefer: 'return=minimal' } }); }
          catch (e) { if (e instanceof ApiError && e.status === 409) continue; throw e; }
        } else if (!same(merged, remote)) {
          const upd = await rest('/rest/v1/finanzas?select=rev&rev=eq.' + row.rev, { method: 'PATCH', body: { data: merged, rev: row.rev + 1 }, headers: { Prefer: 'return=representation' } });
          if (!upd || !upd.length) continue; // otro dispositivo subió antes: se vuelve a leer y fusionar
        }
        S.lastSync = Date.now();
        saveBase(merged, S.lastSync);
        // Lo que se haya tocado aquí durante la subida se conserva encima de lo fusionado.
        const now = S.hooks.get();
        const next = same(now, before) ? merged : merge3(before, now, merged);
        if (!same(next, now)) S.hooks.set(next);
        if (!same(next, merged)) S.again = true;
        setState('ok');
        return;
      }
      setState('error', 'No se ha podido sincronizar: hay cambios simultáneos. Se reintentará.');
      S.again = true;
    } catch (e) {
      if (e instanceof NetError) setState('offline', 'Sin conexión: se subirá al volver.');
      else if (e.code === 'session_expired' || e.code === 'no_session') { /* ya avisado */ }
      else setState('error', humanError(e));
    } finally {
      S.busy = false;
      if (S.again && S.session) { S.again = false; schedule(1500); }
    }
  }

  function schedule(ms) {
    if (!S.session) return;
    clearTimeout(S.timer);
    S.timer = setTimeout(sync, ms === undefined ? 1200 : ms);
  }

  // Al arrancar la app. Si ya había sesión, sincroniza enseguida.
  function init(hooks) {
    Object.assign(S.hooks, hooks);
    S.session = ls.get(K_SESSION);
    if (!S.wired && typeof document !== 'undefined') {
      S.wired = true;
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') schedule(300); });
      addEventListener('online', () => schedule(300));
      setInterval(() => { if (document.visibilityState === 'visible') sync(); }, 5 * 60 * 1000);
    }
    if (!S.session) return;
    const b = baseRec();
    S.lastSync = (b && b.at) || 0;
    setState('ok');
    schedule(900);
  }

  // Tras entrar con email y contraseña: primera sincronización.
  function start() {
    if (!S.session) return;
    const b = baseRec();
    S.lastSync = (b && b.at) || 0;
    setState('ok');
    schedule(0);
  }

  const Sync = {
    // puras (pruebas)
    stable, same, mergeList, merge3, firstMerge, dedupeSnaps, hasData,
    // cliente
    init, sync, schedule, signIn, signUp, signOut, needsFirstBackup, humanError, NetError, ApiError,
    get session() { return S.session; },
    get state() { return S.state; },
    get message() { return S.message; },
    get lastSync() { return S.lastSync; },
    start,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = Sync;
  else root.Sync = Sync;
})(typeof self !== 'undefined' ? self : this);
