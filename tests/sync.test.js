// Pruebas de la sincronización: node --test tests/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Sync = require('../sync.js');
const { fakeSupabase } = require('./fake-supabase.js');

const plain = v => JSON.parse(JSON.stringify(v));
const ids = list => list.map(x => x.id).sort();

/* ---------------- fusión ---------------- */

test('fusión: lo cambiado en un solo lado gana ese lado', () => {
  const base = [{ id: 'a', n: 1 }, { id: 'b', n: 1 }];
  const local = [{ id: 'a', n: 2 }, { id: 'b', n: 1 }];
  const remote = [{ id: 'a', n: 1 }, { id: 'b', n: 3 }];
  assert.deepEqual(plain(Sync.mergeList(base, local, remote)), [{ id: 'a', n: 2 }, { id: 'b', n: 3 }]);
});

test('fusión: lo añadido en cada lado se suma', () => {
  const out = Sync.mergeList([{ id: 'a' }], [{ id: 'a' }, { id: 'l' }], [{ id: 'a' }, { id: 'r' }]);
  assert.deepEqual(ids(out), ['a', 'l', 'r']);
});

test('fusión: borrado en un lado sin tocar en el otro → se borra', () => {
  const base = [{ id: 'a', n: 1 }, { id: 'b', n: 1 }];
  assert.deepEqual(ids(Sync.mergeList(base, [{ id: 'b', n: 1 }], base)), ['b']);       // borrado aquí
  assert.deepEqual(ids(Sync.mergeList(base, base, [{ id: 'a', n: 1 }])), ['a']);       // borrado en la nube
  assert.deepEqual(ids(Sync.mergeList(base, [{ id: 'b', n: 1 }], [{ id: 'b', n: 1 }])), ['b']); // en los dos
});

test('fusión: borrado en un lado y editado en el otro → se conserva', () => {
  const base = [{ id: 'a', n: 1 }];
  assert.deepEqual(plain(Sync.mergeList(base, [], [{ id: 'a', n: 2 }])), [{ id: 'a', n: 2 }]);
  assert.deepEqual(plain(Sync.mergeList(base, [{ id: 'a', n: 3 }], [])), [{ id: 'a', n: 3 }]);
});

test('fusión: editado en los dos lados → gana este dispositivo', () => {
  const out = Sync.mergeList([{ id: 'a', n: 1 }], [{ id: 'a', n: 2 }], [{ id: 'a', n: 3 }]);
  assert.deepEqual(plain(out), [{ id: 'a', n: 2 }]);
});

test('fusión: el orden de las claves no cuenta como cambio', () => {
  const out = Sync.mergeList([{ id: 'a', x: 1, y: 2 }], [{ y: 2, x: 1, id: 'a' }], [{ id: 'a', x: 1, y: 9 }]);
  assert.deepEqual(plain(out), [{ id: 'a', x: 1, y: 9 }]);
});

test('fusión: un solo valor por inversión y mes, el apuntado más tarde', () => {
  const snaps = [
    { id: 's1', inv: 'f', ym: '2026-11', value: 100, t: 10 },
    { id: 's2', inv: 'f', ym: '2026-11', value: 120, t: 20 },
    { id: 's3', inv: 'f', ym: '2026-10', value: 90 },
  ];
  assert.deepEqual(ids(Sync.dedupeSnaps(snaps)), ['s2', 's3']);
});

test('fusión: inflación, gana el lado que la cambió', () => {
  const d = (infl, extra) => Object.assign({ version: 2, movs: [], cats: [], pend: [], invs: [], snaps: [], cfg: { inflation: infl } }, extra);
  assert.equal(Sync.merge3(d(2.5), d(3), d(2.5)).cfg.inflation, 3);
  assert.equal(Sync.merge3(d(2.5), d(2.5), d(4)).cfg.inflation, 4);
  assert.equal(Sync.merge3(d(2.5, { lastBackup: 5 }), d(2.5, { lastBackup: 5 }), d(2.5, { lastBackup: 9 })).lastBackup, 9);
});

test('primera unión: categorías con el mismo nombre se juntan y los movimientos se reasignan', () => {
  const local = {
    version: 2, pend: [], invs: [], snaps: [], cfg: { inflation: 2.5 },
    cats: [{ id: 'l-super', name: 'Supermercado', type: 'gasto' }, { id: 'l-gym', name: 'Gimnasio', type: 'gasto' }, { id: 'inv-out', name: 'Inversiones', type: 'gasto', system: true }],
    movs: [{ id: 'm1', cat: 'l-super', amount: 100 }, { id: 'm2', cat: 'l-gym', amount: 30 }],
  };
  const remote = {
    version: 2, pend: [], invs: [], snaps: [], cfg: { inflation: 2.5 },
    cats: [{ id: 'r-super', name: 'supermercado ', type: 'gasto' }, { id: 'inv-out', name: 'Inversiones', type: 'gasto', system: true }],
    movs: [{ id: 'm9', cat: 'r-super', amount: 50 }],
  };
  const out = Sync.firstMerge(local, remote);
  assert.deepEqual(ids(out.cats), ['inv-out', 'l-gym', 'r-super']);
  assert.deepEqual(plain(out.movs).sort((a, b) => a.id < b.id ? -1 : 1).map(m => m.cat), ['r-super', 'l-gym', 'r-super']);
  assert.equal(local.movs[0].cat, 'l-super', 'no modifica los datos de entrada');
});

/* ---------------- cliente contra la nube simulada ---------------- */

const SRC = fs.readFileSync(path.join(__dirname, '..', 'sync.js'), 'utf8');

// Un "dispositivo": su propio almacenamiento, su copia de sync.js y sus datos.
function device(srv, data) {
  const store = new Map();
  const ctx = {
    localStorage: { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) },
    navigator: { onLine: true },
    fetch: (...a) => srv.fetch(...a),
    setTimeout: () => 0, clearTimeout() {}, setInterval() {}, console,
  };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  const dev = { ctx, store, Sync: ctx.Sync, db: plain(data), states: [] };
  dev.Sync.init({
    get: () => dev.db,
    set: d => { dev.db = plain(d); },
    migrate: d => d,
    version: 2,
    onState: s => dev.states.push(s.state),
  });
  return dev;
}

const cats0 = prefix => [
  { id: prefix + '-super', name: 'Supermercado', type: 'gasto', archived: false },
  { id: prefix + '-nom', name: 'Nómina', type: 'ingreso', archived: false },
  { id: 'inv-out', name: 'Inversiones', type: 'gasto', system: true, archived: false },
  { id: 'inv-in', name: 'Inversiones', type: 'ingreso', system: true, archived: false },
];
const doc = (prefix, movs = []) => ({ version: 2, movs, cats: cats0(prefix), pend: [], invs: [], snaps: [], cfg: { inflation: 2.5 }, lastBackup: null });
const mov = (id, cat, amount) => ({ id, created: 1, type: 'gasto', amount, cat, note: '', date: '2026-11-10' });

async function pair() {
  const srv = fakeSupabase();
  const phone = device(srv, doc('p', [mov('m1', 'p-super', 4250), mov('m2', 'p-super', 1000)]));
  const pc = device(srv, doc('o'));
  assert.equal((await phone.Sync.signUp('yo@ejemplo.com', 'secreta1')).ok, true);
  assert.equal(phone.Sync.needsFirstBackup(), true);
  await phone.Sync.sync();
  assert.equal((await pc.Sync.signIn('yo@ejemplo.com', 'secreta1')).ok, true);
  assert.equal(pc.Sync.needsFirstBackup(), false, 'el ordenador vacío no necesita copia');
  await pc.Sync.sync();
  return { srv, phone, pc };
}

test('nube: el móvil sube sus datos y guarda antes una copia intacta', async () => {
  const srv = fakeSupabase();
  const phone = device(srv, doc('p', [mov('m1', 'p-super', 4250)]));
  await phone.Sync.signUp('yo@ejemplo.com', 'secreta1');
  await phone.Sync.sync();
  const row = srv.rows.get('uid-1');
  assert.equal(row.rev, 1);
  assert.deepEqual(ids(row.data.movs), ['m1']);
  assert.deepEqual(JSON.parse(phone.store.get('finanzas.data.antes-nube')).movs.map(m => m.id), ['m1']);
  assert.equal(phone.Sync.state, 'ok');
  assert.ok(phone.Sync.lastSync > 0);
  assert.equal(phone.Sync.needsFirstBackup(), false);
});

test('nube: un ordenador vacío recibe los datos tal cual (sin duplicar categorías)', async () => {
  const { srv, phone, pc } = await pair();
  assert.deepEqual(plain(pc.db), plain(srv.rows.get('uid-1').data));
  assert.deepEqual(ids(pc.db.cats), ids(phone.db.cats));
  assert.deepEqual(ids(pc.db.movs), ['m1', 'm2']);
});

test('nube: lo que se añade en un dispositivo llega al otro', async () => {
  const { srv, phone, pc } = await pair();
  pc.db.movs.push(mov('m3', 'p-super', 999));
  await pc.Sync.sync();
  assert.equal(srv.rows.get('uid-1').rev, 2);
  await phone.Sync.sync();
  assert.deepEqual(ids(phone.db.movs), ['m1', 'm2', 'm3']);
});

test('nube: cambios a la vez en los dos dispositivos se juntan sin perder nada', async () => {
  const { srv, phone, pc } = await pair();
  phone.db.movs = phone.db.movs.filter(m => m.id !== 'm1');          // borra m1 en el móvil
  pc.db.movs.find(m => m.id === 'm2').amount = 2000;                  // edita m2 en el ordenador
  pc.db.movs.push(mov('m4', 'p-super', 1));                           // y añade m4
  await phone.Sync.sync();
  await pc.Sync.sync();
  await phone.Sync.sync();
  for (const d of [phone.db, pc.db, srv.rows.get('uid-1').data]) {
    assert.deepEqual(ids(d.movs), ['m2', 'm4']);
    assert.equal(d.movs.find(m => m.id === 'm2').amount, 2000);
  }
});

test('nube: si otro dispositivo escribe justo antes, se vuelve a leer y se fusiona', async () => {
  const { srv, phone, pc } = await pair();
  phone.db.movs.push(mov('mp', 'p-super', 5));
  pc.db.movs.push(mov('mo', 'p-super', 6));
  srv.beforePatch = () => pc.Sync.sync();   // el ordenador sube entre la lectura y la escritura del móvil
  await phone.Sync.sync();
  const data = srv.rows.get('uid-1').data;
  assert.deepEqual(ids(data.movs), ['m1', 'm2', 'mo', 'mp']);
  assert.equal(srv.rows.get('uid-1').rev, 3);
  assert.equal(phone.Sync.state, 'ok');
});

test('nube: lo que se toca durante la subida no se pierde', async () => {
  const { srv, phone } = await pair();
  phone.db.movs.push(mov('antes', 'p-super', 1));
  srv.beforePatch = () => { phone.db.movs.push(mov('durante', 'p-super', 2)); };
  await phone.Sync.sync();
  assert.deepEqual(ids(phone.db.movs), ['antes', 'durante', 'm1', 'm2']);
  await phone.Sync.sync();
  assert.deepEqual(ids(srv.rows.get('uid-1').data.movs), ['antes', 'durante', 'm1', 'm2']);
});

test('nube: un móvil y un ordenador con datos propios se juntan la primera vez', async () => {
  const srv = fakeSupabase();
  const pc = device(srv, doc('o', [mov('o1', 'o-super', 100)]));
  await pc.Sync.signUp('yo@ejemplo.com', 'secreta1');
  await pc.Sync.sync();
  const phone = device(srv, doc('p', [mov('p1', 'p-super', 200)]));
  await phone.Sync.signIn('yo@ejemplo.com', 'secreta1');
  assert.equal(phone.Sync.needsFirstBackup(), true);
  await phone.Sync.sync();
  assert.deepEqual(ids(phone.db.movs), ['o1', 'p1']);
  assert.ok(phone.db.movs.every(m => m.cat === 'o-super'), 'Supermercado del móvil pasa a ser la misma categoría');
  assert.equal(phone.db.cats.filter(c => c.name === 'Supermercado').length, 1);
});

test('nube: sin conexión no se toca nada y se avisa', async () => {
  const { srv, phone } = await pair();
  phone.db.movs.push(mov('x', 'p-super', 1));
  srv.down = true;
  await phone.Sync.sync();
  assert.equal(phone.Sync.state, 'offline');
  assert.deepEqual(ids(phone.db.movs), ['m1', 'm2', 'x']);
  srv.down = false;
  phone.ctx.navigator.onLine = false;
  await phone.Sync.sync();
  assert.equal(phone.Sync.state, 'offline');
  phone.ctx.navigator.onLine = true;
  await phone.Sync.sync();
  assert.deepEqual(ids(srv.rows.get('uid-1').data.movs), ['m1', 'm2', 'x']);
});

test('nube: si la nube tiene una versión más nueva de los datos, no se fusiona', async () => {
  const { srv, phone } = await pair();
  srv.rows.get('uid-1').data.version = 3;
  srv.rows.get('uid-1').rev++;
  const before = plain(phone.db);
  await phone.Sync.sync();
  assert.equal(phone.Sync.state, 'outdated');
  assert.deepEqual(plain(phone.db), before);
});

// Simula que ha pasado más de una hora desde que se entró.
function expire(dev) {
  dev.Sync.session.expires_at = 0;
  const s = JSON.parse(dev.store.get('finanzas.nube.sesion'));
  s.expires_at = 0;
  dev.store.set('finanzas.nube.sesion', JSON.stringify(s));
}

test('nube: la sesión caducada se renueva sola', async () => {
  const { srv, phone } = await pair();
  expire(phone);
  phone.db.movs.push(mov('r', 'p-super', 1));
  await phone.Sync.sync();
  assert.equal(phone.Sync.state, 'ok');
  assert.ok(srv.calls.some(c => c.includes('grant_type=refresh_token')));
  assert.deepEqual(ids(srv.rows.get('uid-1').data.movs), ['m1', 'm2', 'r']);
});

test('nube: si ya no se puede renovar, pide volver a entrar sin tocar los datos', async () => {
  const { srv, phone } = await pair();
  expire(phone);
  srv.refresh.clear();
  await phone.Sync.sync();
  assert.equal(phone.Sync.state, 'login');
  assert.equal(phone.Sync.session, null);
  assert.deepEqual(ids(phone.db.movs), ['m1', 'm2']);
});

test('nube: si el servidor rechaza el token, se renueva y se reintenta una vez', async () => {
  const { srv, phone } = await pair();
  srv.access.clear(); // tokens anulados en el servidor aunque no hayan caducado aquí
  phone.db.movs.push(mov('k', 'p-super', 1));
  await phone.Sync.sync();
  assert.equal(phone.Sync.state, 'ok');
  assert.deepEqual(ids(srv.rows.get('uid-1').data.movs), ['k', 'm1', 'm2']);
});

test('nube: si otra pestaña ya renovó la sesión, se usa esa', async () => {
  const { srv, phone } = await pair();
  expire(phone);
  // La otra pestaña renueva y guarda la sesión nueva en el almacenamiento compartido.
  const fresh = await srv.fetch('https://x/auth/v1/token?grant_type=refresh_token', { method: 'POST', headers: { apikey: 'k' }, body: JSON.stringify({ refresh_token: JSON.parse(phone.store.get('finanzas.nube.sesion')).refresh_token }) });
  const j = JSON.parse(await fresh.text());
  phone.store.set('finanzas.nube.sesion', JSON.stringify({ access_token: j.access_token, refresh_token: j.refresh_token, expires_at: j.expires_at, user: j.user }));
  const before = srv.calls.length;
  await phone.Sync.sync();
  assert.equal(phone.Sync.state, 'ok');
  assert.ok(!srv.calls.slice(before).some(c => c.includes('refresh_token')), 'no vuelve a renovar con un token ya usado');
});

test('nube: registro cerrado tras la primera cuenta y mensajes claros', async () => {
  const srv = fakeSupabase();
  const a = device(srv, doc('a'));
  assert.equal((await a.Sync.signUp('yo@ejemplo.com', 'secreta1')).ok, true);
  const b = device(srv, doc('b'));
  const r = await b.Sync.signUp('otro@ejemplo.com', 'secreta2');
  assert.equal(r.ok, false);
  assert.match(r.error, /registro está cerrado/);
  assert.match((await b.Sync.signIn('yo@ejemplo.com', 'mal')).error, /no son correctos/);
  srv.down = true;
  assert.match((await b.Sync.signIn('yo@ejemplo.com', 'secreta1')).error, /No hay conexión/);
});

test('nube: cerrar sesión deja los datos en el dispositivo', async () => {
  const { phone } = await pair();
  await phone.Sync.signOut();
  assert.equal(phone.Sync.session, null);
  assert.equal(phone.Sync.state, 'off');
  assert.deepEqual(ids(phone.db.movs), ['m1', 'm2']);
  assert.equal(phone.store.has('finanzas.nube.sesion'), false);
});
