// Supabase simulado en memoria para las pruebas: inicio de sesión, una fila
// por usuario con control de versión (rev) y registro cerrado tras la primera
// cuenta, igual que las reglas que se crean en el proyecto real.
'use strict';

function fakeSupabase() {
  const users = [];            // { id, email, password }
  const rows = new Map();      // uid -> { data, rev }
  const access = new Map();    // token -> { uid, exp }
  const refresh = new Map();   // token -> uid
  let n = 0;
  const srv = {
    users, rows, access, refresh,
    calls: [],
    down: false,               // simula estar sin conexión
    beforePatch: null,         // función que se ejecuta una vez entre leer y escribir
  };

  function issue(u) {
    const a = 'at-' + (++n), r = 'rt-' + n;
    const exp = Math.floor(Date.now() / 1000) + 3600;
    access.set(a, { uid: u.id, exp });
    refresh.set(r, u.id);
    return { access_token: a, refresh_token: r, token_type: 'bearer', expires_in: 3600, expires_at: exp, user: { id: u.id, email: u.email } };
  }
  const res = (status, json) => ({ status, json });

  srv.handle = async (method, url, headers, body) => {
    const u = new URL(url);
    const path = u.pathname, q = u.searchParams;
    srv.calls.push(method + ' ' + path + (u.search || ''));
    if (!headers.apikey) return res(401, { message: 'No API key found in request' });

    if (path === '/auth/v1/signup' && method === 'POST') {
      if (users.length) return res(500, { code: 'unexpected_failure', message: 'Database error saving new user' });
      if (!body.password || body.password.length < 6) return res(422, { code: 'weak_password', message: 'Password should be at least 6 characters.' });
      const user = { id: 'uid-' + (users.length + 1), email: body.email, password: body.password };
      users.push(user);
      return res(200, issue(user));
    }
    if (path === '/auth/v1/token' && method === 'POST') {
      if (q.get('grant_type') === 'password') {
        const user = users.find(x => x.email === body.email && x.password === body.password);
        if (!user) return res(400, { code: 'invalid_credentials', message: 'Invalid login credentials' });
        return res(200, issue(user));
      }
      if (q.get('grant_type') === 'refresh_token') {
        const id = refresh.get(body.refresh_token);
        if (!id) return res(400, { code: 'refresh_token_not_found', message: 'Invalid Refresh Token' });
        refresh.delete(body.refresh_token); // los tokens de renovación se usan una vez
        return res(200, issue(users.find(x => x.id === id)));
      }
    }
    if (path === '/auth/v1/logout') return res(204, null);

    if (path === '/rest/v1/finanzas') {
      const tok = (headers.authorization || headers.Authorization || '').replace('Bearer ', '');
      const a = access.get(tok);
      if (!a) return res(401, { code: 'PGRST301', message: 'JWT invalid' });
      if (a.exp < Date.now() / 1000) return res(401, { code: 'PGRST303', message: 'JWT expired' });
      const row = rows.get(a.uid);
      if (method === 'GET') return res(200, row ? [{ data: row.data, rev: row.rev }] : []);
      if (method === 'POST') {
        if (row) return res(409, { code: '23505', message: 'duplicate key value violates unique constraint "finanzas_pkey"' });
        rows.set(a.uid, { data: JSON.parse(JSON.stringify(body.data)), rev: body.rev || 1 });
        return res(201, null);
      }
      if (method === 'PATCH') {
        if (srv.beforePatch) { const f = srv.beforePatch; srv.beforePatch = null; await f(); }
        const cur = rows.get(a.uid);
        const want = Number((q.get('rev') || '').replace('eq.', ''));
        if (!cur || cur.rev !== want) return res(200, []);
        cur.data = JSON.parse(JSON.stringify(body.data));
        cur.rev = body.rev;
        return res(200, [{ rev: cur.rev }]);
      }
    }
    return res(404, { message: 'no route ' + method + ' ' + path });
  };

  // fetch compatible para Node
  srv.fetch = async (url, opts = {}) => {
    if (srv.down) throw new TypeError('Failed to fetch');
    const headers = {};
    for (const [k, v] of Object.entries(opts.headers || {})) headers[k.toLowerCase()] = v;
    const r = await srv.handle(opts.method || 'GET', url, headers, opts.body ? JSON.parse(opts.body) : undefined);
    const text = r.json === null ? '' : JSON.stringify(r.json);
    return { ok: r.status < 400, status: r.status, text: async () => text };
  };
  return srv;
}

module.exports = { fakeSupabase };
