'use strict';

/* =========================================================
   Datos y migraciones
   Importes siempre en céntimos (enteros) para evitar errores de redondeo.
   ========================================================= */

const KEY = 'finanzas.data';
const KEY_BAK = 'finanzas.data.bak';
const VERSION = 2;
const APP_VERSION = '1.2.0';
const DEFAULT_INFLATION = 2.5; // % anual, editable en Inversiones

const INV_OUT = 'inv-out'; // categoría de sistema: aportación a inversión (gasto)
const INV_IN = 'inv-in';   // categoría de sistema: retirada de inversión (ingreso)
const METHODS = ['Bizum', 'Efectivo', 'Transferencia', 'Tarjeta', 'Otro'];

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function defaultData() {
  const g = ['Supermercado', 'Restaurantes', 'Transporte', 'Casa', 'Ocio', 'Ropa', 'Salud', 'Suscripciones', 'Otros'];
  const i = ['Nómina', 'Bizum', 'Regalos', 'Otros'];
  return {
    version: VERSION,
    movs: [],
    cats: [
      ...g.map(name => ({ id: uid(), name, type: 'gasto', archived: false })),
      ...i.map(name => ({ id: uid(), name, type: 'ingreso', archived: false })),
      { id: INV_OUT, name: 'Inversiones', type: 'gasto', system: true, archived: false },
      { id: INV_IN, name: 'Inversiones', type: 'ingreso', system: true, archived: false },
    ],
    pend: [],
    invs: [],
    snaps: [], // valor de cada inversión mes a mes: { id, inv, ym, value, est? }
    cfg: { inflation: DEFAULT_INFLATION },
    lastBackup: null,
  };
}

// Cada migración recibe datos de la versión N y devuelve la versión N+1.
// Para cambiar la estructura: añade aquí una función y sube VERSION.
const MIGRATIONS = {
  // 1 → 2: historial mensual del valor de las inversiones e inflación.
  // No se toca ningún dato existente: solo se añaden campos.
  1: d => {
    const movs = Array.isArray(d.movs) ? d.movs : [];
    d.snaps = [];
    d.cfg = { inflation: DEFAULT_INFLATION };
    for (const inv of (Array.isArray(d.invs) ? d.invs : [])) {
      const valueDate = inv.valueDate || todayISO();
      let start = valueDate;
      for (const m of movs) if (m.inv === inv.id && m.date < start) start = m.date;
      inv.start = start.slice(0, 7); // mes desde el que cuenta lo aportado antes de la app
      d.snaps.push({ id: uid(), inv: inv.id, ym: valueDate.slice(0, 7), value: inv.value || 0 });
    }
    d.version = 2;
    return d;
  },
};

function migrate(d) {
  if (!d || typeof d !== 'object') return defaultData();
  if (!d.version) d.version = 1;
  while (d.version < VERSION) {
    const m = MIGRATIONS[d.version];
    if (!m) throw new Error('Falta la migración desde la versión ' + d.version);
    d = m(d);
  }
  if (d.version > VERSION) throw new Error('Los datos son de una versión más nueva de la app');
  // Normalización defensiva
  d.movs = Array.isArray(d.movs) ? d.movs : [];
  d.cats = Array.isArray(d.cats) ? d.cats : defaultData().cats;
  d.pend = Array.isArray(d.pend) ? d.pend : [];
  d.invs = Array.isArray(d.invs) ? d.invs : [];
  d.snaps = Array.isArray(d.snaps) ? d.snaps : [];
  if (!d.cfg || typeof d.cfg !== 'object') d.cfg = {};
  if (typeof d.cfg.inflation !== 'number' || !isFinite(d.cfg.inflation)) d.cfg.inflation = DEFAULT_INFLATION;
  for (const sys of defaultData().cats.filter(c => c.system)) {
    if (!d.cats.some(c => c.id === sys.id)) d.cats.push(sys);
  }
  return d;
}

function validShape(d) {
  return d && typeof d === 'object' && Array.isArray(d.movs) && Array.isArray(d.cats);
}

function load() {
  for (const k of [KEY, KEY_BAK]) {
    const raw = localStorage.getItem(k);
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      const from = (parsed && parsed.version) || 1;
      // Antes de migrar se guarda una copia intacta de los datos tal como estaban.
      if (from < VERSION && !localStorage.getItem(`${KEY}.v${from}`)) {
        try { localStorage.setItem(`${KEY}.v${from}`, raw); } catch (_) { /* sin espacio: save() conserva igualmente la versión anterior en .bak */ }
      }
      const d = migrate(parsed);
      if (validShape(d)) return d;
      throw new Error('estructura no válida');
    } catch (e) {
      console.error('No se pudo leer', k, e);
      // Nunca se pisa algo que no se ha podido leer: se aparta una copia intacta.
      try { localStorage.setItem(k + '.ilegible-' + Date.now(), raw); } catch (_) {}
      if (k === KEY) localStorage.removeItem(KEY);
    }
  }
  return defaultData();
}

let db = load();

function save() {
  try {
    const prev = localStorage.getItem(KEY);
    if (prev) localStorage.setItem(KEY_BAK, prev); // la copia anterior siempre es legible: load() aparta las que no
    localStorage.setItem(KEY, JSON.stringify(db));
    return true;
  } catch (e) {
    alert('No se han podido guardar los datos: ' + e.message);
    return false;
  }
}

// Pide al navegador que no borre los datos por falta de espacio.
if (navigator.storage && navigator.storage.persist) {
  navigator.storage.persisted().then(p => { if (!p) navigator.storage.persist(); }).catch(() => {});
}

/* =========================================================
   Utilidades
   ========================================================= */

const eur = new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' });
const fmt = c => eur.format(c / 100);
const fmtSigned = c => (c > 0 ? '+' : c < 0 ? '−' : '') + eur.format(Math.abs(c) / 100);
const pct = new Intl.NumberFormat('es-ES', { style: 'percent', maximumFractionDigits: 1, signDisplay: 'exceptZero' });

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const monthOf = iso => iso.slice(0, 7);
function shiftMonth(ym, n) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function monthLabel(ym, opts = { month: 'long', year: 'numeric' }) {
  const [y, m] = ym.split('-').map(Number);
  const s = new Intl.DateTimeFormat('es-ES', opts).format(new Date(y, m - 1, 1));
  return s.charAt(0).toUpperCase() + s.slice(1);
}
function dayLabel(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short' }).format(new Date(y, m - 1, d));
}

// "12,5" / "12.50" -> 1250 céntimos. Devuelve NaN si no es válido.
function parseAmount(s) {
  s = String(s).trim().replace(/\s|€/g, '');
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  if (!/^\d+(\.\d{0,2})?$/.test(s)) return NaN;
  return Math.round(parseFloat(s) * 100);
}
const centsToInput = c => (c / 100).toFixed(2).replace('.', ',');

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

const $ = sel => document.querySelector(sel);
const catById = id => db.cats.find(c => c.id === id);
const catName = id => (catById(id) || { name: 'Sin categoría' }).name;
const activeCats = type => db.cats.filter(c => c.type === type && !c.archived && !c.system);

/* =========================================================
   Movimiento: entradas, cifras que cuentan y confeti.
   Todo es decorativo: nada bloquea ni retrasa lo que se toca.
   ========================================================= */

const REDUCE = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
const EASE_OUT = 'cubic-bezier(0.23, 1, 0.32, 1)';
const EASE_DRAWER = 'cubic-bezier(0.32, 0.72, 0, 1)';

function motion(el, frames, opts) {
  if (REDUCE || !el || !el.animate) return null;
  return el.animate(frames, opts);
}

// Cifra que cuenta desde cero al entrar en una pantalla.
const num = (c, signed) => `<span data-n="${c}"${signed ? ' data-s="1"' : ''}>${signed ? fmtSigned(c) : fmt(c)}</span>`;
function countUp(root) {
  if (REDUCE) return;
  root.querySelectorAll('[data-n]').forEach(el => {
    const to = Number(el.dataset.n);
    if (!to) return;
    const f = el.dataset.s === '1' ? fmtSigned : fmt;
    const t0 = performance.now(), dur = 900;
    const tick = now => {
      if (!el.isConnected) return;
      const p = Math.min(1, (now - t0) / dur);
      el.textContent = f(p < 1 ? Math.round(to * (1 - Math.pow(1 - p, 4))) : to);
      if (p < 1) requestAnimationFrame(tick);
    };
    el.textContent = f(0);
    requestAnimationFrame(tick);
  });
}

// Anima la entrada del contenido de la pantalla (cls: enter, slide-l o slide-r).
let enterTimer;
function enter(cls) {
  const v = $('#view');
  const off = () => v.classList.remove('enter', 'slide-l', 'slide-r');
  off();
  if (REDUCE) return;
  void v.offsetWidth; // reinicia las animaciones
  v.classList.add(cls);
  countUp(v);
  clearTimeout(enterTimer);
  enterTimer = setTimeout(off, 1800);
  // Si se toca algo antes de que acabe, lo siguiente que se pinte ya no se anima.
  addEventListener('pointerdown', off, { once: true, capture: true });
}

// Confeti en amarillo, blanco y gris desde un punto de la pantalla.
const fx = { parts: [], raf: 0 };
function burst(x, y, n, power) {
  const cv = $('#fx');
  if (REDUCE || !cv || !cv.getContext) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  if (cv.width !== Math.round(innerWidth * dpr) || cv.height !== Math.round(innerHeight * dpr)) {
    cv.width = Math.round(innerWidth * dpr); cv.height = Math.round(innerHeight * dpr);
  }
  const colors = ['#ffdd00', '#ffdd00', '#ffffff', '#fff3a0', '#8a8a8a'];
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.5;
    const v = (5 + Math.random() * 9) * power;
    fx.parts.push({
      x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 2 * power,
      w: 5 + Math.random() * 6, h: 3 + Math.random() * 5, r: Math.random() * 6.3, vr: (Math.random() - 0.5) * 0.5,
      c: colors[i % colors.length], life: 0, max: 50 + Math.random() * 40 * power, round: i % 4 === 0,
    });
  }
  if (fx.raf) return;
  const ctx = cv.getContext('2d');
  const step = () => {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    fx.parts = fx.parts.filter(q => q.life < q.max);
    for (const q of fx.parts) {
      q.life++; q.vy += 0.42; q.vx *= 0.985; q.vy *= 0.985; q.x += q.vx; q.y += q.vy; q.r += q.vr;
      ctx.globalAlpha = Math.min(1, (q.max - q.life) / 18);
      ctx.fillStyle = q.c;
      ctx.save(); ctx.translate(q.x, q.y); ctx.rotate(q.r);
      if (q.round) { ctx.beginPath(); ctx.arc(0, 0, q.w / 2.2, 0, 6.3); ctx.fill(); }
      else ctx.fillRect(-q.w / 2, -q.h / 2, q.w, q.h);
      ctx.restore();
    }
    fx.raf = fx.parts.length ? requestAnimationFrame(step) : 0;
    if (!fx.raf) ctx.clearRect(0, 0, innerWidth, innerHeight);
  };
  fx.raf = requestAnimationFrame(step);
}

// iOS solo aplica :active a los botones si hay un listener táctil en el documento.
document.addEventListener('touchstart', () => {}, { passive: true });

const initial = s => (String(s || '').trim().charAt(0) || '·').toUpperCase();

// Selector de dos opciones con pastilla deslizante.
const seg = (id, a, b, cur) => `
    <div class="seg" id="${id}" data-on="${cur === b[0] ? 1 : 0}"><i class="thumb"></i>
      <button data-t="${a[0]}" class="${cur === a[0] ? 'on' : ''}">${a[1]}</button>
      <button data-t="${b[0]}" class="${cur === b[0] ? 'on' : ''}">${b[1]}</button>
    </div>`;
// Tras repintar, la pastilla se desliza desde donde estaba.
function slideSeg(id, from) {
  const el = $('#' + id);
  if (!el) return;
  const to = Number(el.dataset.on);
  if (from !== to) motion(el.querySelector('.thumb'), [{ transform: `translateX(${from * 100}%)` }, { transform: `translateX(${to * 100}%)` }], { duration: 360, easing: EASE_DRAWER });
}

/* =========================================================
   Aviso superior (toast) con deshacer
   ========================================================= */

let toastTimer;
function toast(msg, actionLabel, action) {
  const t = $('#toast');
  t.innerHTML = `<span>${esc(msg)}</span>`;
  if (actionLabel) {
    const b = document.createElement('button');
    b.textContent = actionLabel;
    b.onclick = () => { hideToast(); action(); };
    t.appendChild(b);
  }
  toastSeq++;
  t.hidden = false;
  motion(t, [{ opacity: 0, transform: 'translateY(-130%) scale(0.94)' }, { opacity: 1, transform: 'none' }], { duration: 460, easing: EASE_DRAWER });
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, actionLabel ? 6000 : 2500);
}
let toastSeq = 0;
function hideToast() {
  const t = $('#toast');
  if (t.hidden) return;
  const id = toastSeq;
  const a = motion(t, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(-60%)' }], { duration: 180, easing: 'ease-in', fill: 'forwards' });
  const done = () => { if (a) a.cancel(); if (id === toastSeq) t.hidden = true; };
  if (a) a.onfinish = done; else done();
}

/* =========================================================
   Hoja inferior genérica
   ========================================================= */

let sheetTimer;
function openSheet(html, bind) {
  const bd = $('#sheetBackdrop');
  const sh = $('#sheet');
  clearTimeout(sheetTimer);
  bd.classList.remove('closing');
  sh.innerHTML = html;
  sh.scrollTop = 0;
  bd.hidden = false;
  bd.onclick = e => { if (e.target === bd) closeSheet(); };
  // Con teclado físico: Intro en un campo pulsa el botón principal de la hoja.
  sh.onkeydown = e => {
    if (e.key !== 'Enter' || !e.target.matches('input') || bd.classList.contains('closing')) return;
    const b = sh.querySelector(e.target.dataset.enter || '.btn:not(.secondary):not(.danger)');
    if (b) { e.preventDefault(); b.click(); }
  };
  bind && bind(sh);
}
function closeSheet() {
  const bd = $('#sheetBackdrop');
  if (bd.hidden || bd.classList.contains('closing')) return;
  const end = () => { bd.hidden = true; bd.classList.remove('closing'); $('#sheet').innerHTML = ''; };
  if (document.activeElement && bd.contains(document.activeElement)) document.activeElement.blur();
  if (REDUCE) { end(); return; }
  bd.classList.add('closing'); // mientras sale no admite toques (ver styles.css)
  sheetTimer = setTimeout(end, 200);
}
// Mientras la hoja se cierra no atiende más pulsaciones: evita guardar dos veces con un doble toque.
$('#sheet').addEventListener('click', e => {
  if ($('#sheetBackdrop').classList.contains('closing')) { e.stopPropagation(); e.preventDefault(); }
}, true);

function catOptions(type, selected) {
  return db.cats
    .filter(c => c.type === type && (!c.archived || c.id === selected) && (!c.system || c.id === selected))
    .map(c => `<option value="${c.id}" ${c.id === selected ? 'selected' : ''}>${esc(c.name)}</option>`)
    .join('');
}

/* =========================================================
   Navegación
   ========================================================= */

const state = {
  tab: 'add',
  addType: 'gasto',
  amount: '',
  note: '',
  date: todayISO(),
  month: monthOf(todayISO()),
  listType: 'gasto',
  invSel: null, // mes señalado en el gráfico de inversiones
};

const views = { add: renderAdd, month: renderMonth, pend: renderPend, inv: renderInv, set: renderSet };

const TABS = ['add', 'month', 'pend', 'inv', 'set'];
function go(tab) {
  state.tab = tab;
  document.querySelectorAll('.tabbar button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  $('#tabbar').style.setProperty('--i', TABS.indexOf(tab));
  render();
  window.scrollTo(0, 0);
  enter('enter');
}
function render() {
  $('#view').dataset.tab = state.tab;
  views[state.tab]();
  updateBackupDot();
  $('#invDot').hidden = !invsMissing().length;
}
document.querySelectorAll('.tabbar button').forEach(b => b.addEventListener('click', () => go(b.dataset.tab)));

/* =========================================================
   Añadir: teclado propio, se guarda al tocar la categoría
   ========================================================= */

function renderAdd() {
  const cents = parseAmount(state.amount || '0');
  const has = state.amount !== '' && cents > 0;
  const shown = state.amount === '' ? '0' : state.amount;
  const isToday = state.date === todayISO();
  $('#view').innerHTML = `
    ${seg('typeSeg', ['gasto', 'Gasto'], ['ingreso', 'Ingreso'], state.addType)}
    <div class="amount ${has ? '' : 'empty'} ${shown.length > 6 ? 'long' : ''}" id="amount"><span class="sign">${state.addType === 'gasto' ? '−' : '+'}</span>${esc(shown)} €</div>
    <div class="hint ${has ? 'go' : ''}">${has ? 'Toca una categoría para guardar' : 'Escribe el importe'}${isToday ? '' : ' · ' + esc(dayLabel(state.date))}</div>
    <div class="meta-row">
      <input id="note" type="text" placeholder="Nota (opcional)" value="${esc(state.note)}" autocomplete="off" enterkeyhint="done">
      <input id="date" type="date" value="${state.date}" max="${todayISO()}" aria-label="Fecha">
    </div>
    <div class="cats ${has ? '' : 'disabled'}" id="cats">
      ${activeCats(state.addType).map(c => `<button data-c="${c.id}">${esc(c.name)}</button>`).join('')}
    </div>
    <div class="keypad" id="keypad">
      ${['1', '2', '3', '4', '5', '6', '7', '8', '9', ',', '0', '⌫'].map(k => `<button data-k="${k}" aria-label="${k === '⌫' ? 'Borrar' : k}">${k === '⌫' ? '<svg viewBox="0 0 24 24"><path d="M9 6h10a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H9l-6-6 6-6zM12 10l4 4M16 10l-4 4"/></svg>' : k}</button>`).join('')}
    </div>`;

  $('#typeSeg').onclick = e => {
    const t = e.target.closest('button');
    if (!t) return;
    const from = state.addType === 'gasto' ? 0 : 1;
    state.addType = t.dataset.t;
    renderAdd();
    slideSeg('typeSeg', from);
  };
  $('#note').oninput = e => { state.note = e.target.value; };
  $('#date').onchange = e => { state.date = e.target.value || todayISO(); renderAdd(); };
  $('#keypad').onclick = e => {
    const b = e.target.closest('button');
    if (!b) return;
    pressKey(b.dataset.k);
  };
  $('#cats').onclick = e => {
    const b = e.target.closest('button');
    if (!b) return;
    const c = parseAmount(state.amount || '0');
    if (!(c > 0)) { toast('Primero escribe el importe'); return; }
    const r = b.getBoundingClientRect();
    addMov({ type: state.addType, amount: c, cat: b.dataset.c, note: state.note.trim(), date: state.date }, { x: r.left + r.width / 2, y: r.top + r.height / 2 });
  };
}

function pressKey(k) {
  let a = state.amount;
  if (k === '⌫') a = a.slice(0, -1);
  else if (k === ',') { if (!a.includes(',')) a = (a || '0') + ','; }
  else {
    if (a.includes(',') && a.split(',')[1].length >= 2) return;
    if (a.replace(',', '').length >= 9) return;
    a = a === '0' ? k : a + k;
  }
  state.amount = a;
  // Actualización ligera sin repintar todo (más fluido al teclear)
  const cents = parseAmount(a || '0');
  const has = a !== '' && cents > 0;
  const el = $('#amount');
  el.classList.toggle('empty', !has);
  el.classList.toggle('long', a.length > 6);
  el.innerHTML = `<span class="sign">${state.addType === 'gasto' ? '−' : '+'}</span>${esc(a === '' ? '0' : a)} €`;
  if (k !== '⌫') motion(el, [{ transform: 'scale(1.05)' }, { transform: 'none' }], { duration: 180, easing: EASE_OUT });
  $('#cats').classList.toggle('disabled', !has);
  const isToday = state.date === todayISO();
  const hint = document.querySelector('.hint');
  hint.classList.toggle('go', has);
  hint.textContent = (has ? 'Toca una categoría para guardar' : 'Escribe el importe') + (isToday ? '' : ' · ' + dayLabel(state.date));
}

// En el ordenador el importe también se puede escribir con el teclado.
document.addEventListener('keydown', e => {
  const open = !$('#sheetBackdrop').hidden;
  if (e.key === 'Escape' && open) { closeSheet(); return; }
  if (state.tab !== 'add' || open || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target && /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
  if (/^\d$/.test(e.key)) pressKey(e.key);
  else if (e.key === ',' || e.key === '.') pressKey(',');
  else if (e.key === 'Backspace') pressKey('⌫');
  else return;
  e.preventDefault();
});

function addMov(m, from) {
  const mov = { id: uid(), created: Date.now(), ...m };
  db.movs.push(mov);
  if (!save()) { db.movs.pop(); return; }
  state.amount = '';
  state.note = '';
  state.date = todayISO();
  renderAdd();
  // Confirmación visual: el importe se recoloca y salta un poco de confeti desde la categoría tocada.
  motion($('#amount'), [{ transform: 'scale(0.82)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 420, easing: EASE_OUT });
  if (from) burst(from.x, from.y, 18, 0.62);
  toast(`${m.type === 'gasto' ? 'Gasto' : 'Ingreso'} de ${fmt(m.amount)} en ${catName(m.cat)}`, 'Deshacer', () => {
    db.movs = db.movs.filter(x => x.id !== mov.id);
    save();
    render();
    toast('Deshecho');
  });
}

/* =========================================================
   Mes: balance, gráficos, gasto por categoría y movimientos
   ========================================================= */

function monthTotals(ym) {
  let ing = 0, gas = 0;
  for (const m of db.movs) {
    if (monthOf(m.date) !== ym) continue;
    if (m.type === 'ingreso') ing += m.amount; else gas += m.amount;
  }
  return { ing, gas, bal: ing - gas };
}

function renderMonth() {
  const ym = state.month;
  const cur = monthOf(todayISO());
  const t = monthTotals(ym);
  const movs = db.movs.filter(m => monthOf(m.date) === ym);

  // Gasto por categoría
  const byCat = {};
  movs.filter(m => m.type === 'gasto').forEach(m => { byCat[m.cat] = (byCat[m.cat] || 0) + m.amount; });
  const catRows = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
  const maxCat = catRows.length ? catRows[0][1] : 0;

  const list = movs
    .filter(m => m.type === state.listType)
    .sort((a, b) => b.date.localeCompare(a.date) || b.created - a.created);

  $('#view').innerHTML = `
    <div class="month-nav">
      <button class="icon-btn" id="prevM" aria-label="Mes anterior">‹</button>
      <h1>${esc(monthLabel(ym))}</h1>
      <button class="icon-btn" id="nextM" aria-label="Mes siguiente" ${ym >= cur ? 'disabled' : ''}>›</button>
    </div>

    <div class="hero bal">
      <div class="lbl">Balance del mes</div>
      <div class="big num">${num(t.bal, true)}</div>
      <div class="chip"><span>Ingresos</span><b>${num(t.ing)}</b></div>
      <div class="chip"><span>Gastos</span><b>${num(t.gas)}</b></div>
    </div>

    <div class="cols">
    <div class="col">
    <h2>Últimos 6 meses</h2>
    <div class="card chart">${barChart(ym)}
      <div class="legend"><span><i class="sw" style="background:var(--ingreso)"></i>Ingresos</span><span><i class="sw" style="background:var(--gasto)"></i>Gastos</span></div>
      <div class="small muted" style="margin-top:4px">Toca un mes para verlo.</div>
    </div>

    <h2>Gasto por categoría</h2>
    <div class="card catbars">
      ${catRows.length ? catRows.map(([id, v], i) => `
        <div class="item">
          <div class="row"><span>${esc(catName(id))}</span><span class="num">${fmt(v)} <span class="muted small">${Math.round(v / t.gas * 100)} %</span></span></div>
          <div class="track"><div class="fill" style="width:${Math.max(2, v / maxCat * 100)}%;--i:${i}"></div></div>
        </div>`).join('') : '<div class="muted">Sin gastos este mes.</div>'}
    </div>

    </div>
    <div class="col">
    <h2>Movimientos</h2>
    ${seg('listSeg', ['gasto', 'Gastos'], ['ingreso', 'Ingresos'], state.listType)}
    <div class="list" id="movList">
      ${list.length ? list.map(m => `
        <button class="li" data-id="${m.id}">
          <span class="av${m.inv ? ' inv' : ''}">${esc(initial(catName(m.cat)))}</span>
          <div class="main"><div class="t">${esc(catName(m.cat))}</div><div class="s">${esc(dayLabel(m.date))}${m.note ? ' · ' + esc(m.note) : ''}</div></div>
          <div class="a${m.type === 'ingreso' ? ' pos' : ''}">${m.type === 'gasto' ? '−' : '+'}${fmt(m.amount)}</div>
        </button>`).join('') : `<div class="empty-state">No hay ${state.listType === 'gasto' ? 'gastos' : 'ingresos'} este mes.</div>`}
    </div>
    </div>
    </div>`;

  $('#prevM').onclick = () => { state.month = shiftMonth(ym, -1); renderMonth(); enter('slide-l'); };
  $('#nextM').onclick = () => { state.month = shiftMonth(ym, 1); renderMonth(); enter('slide-r'); };
  $('#listSeg').onclick = e => {
    const b = e.target.closest('button');
    if (!b) return;
    const from = state.listType === 'gasto' ? 0 : 1;
    state.listType = b.dataset.t;
    renderMonth();
    slideSeg('listSeg', from);
  };
  $('#movList').onclick = e => {
    const b = e.target.closest('.li');
    if (b) editMov(b.dataset.id);
  };
  document.querySelectorAll('.chart [data-m]').forEach(r => r.addEventListener('click', () => {
    if (r.dataset.m === ym) return;
    const dir = r.dataset.m < ym ? 'slide-l' : 'slide-r';
    state.month = r.dataset.m;
    renderMonth();
    enter(dir);
  }));
}

// Barras agrupadas ingresos/gastos de los 6 meses que acaban en el mes elegido.
function barChart(ym) {
  const months = [];
  for (let i = 5; i >= 0; i--) months.push(shiftMonth(ym, -i));
  const data = months.map(m => ({ m, ...monthTotals(m) }));
  const max = Math.max(1, ...data.map(d => Math.max(d.ing, d.gas)));
  const W = 340, H = 170, top = 10, bottom = 22, left = 4, right = 4;
  const ph = H - top - bottom;
  const slot = (W - left - right) / months.length;
  const bw = Math.min(14, slot / 2 - 5);
  const y = v => top + ph - (v / max) * ph;
  // Barra en forma de píldora apoyada en la base
  const bar = (x, v, cls, i) => {
    if (v <= 0) return '';
    const h = Math.max(4, (v / max) * ph);
    return `<rect class="${cls}" style="--i:${i}" x="${x}" y="${top + ph - h}" width="${bw}" height="${h}" rx="${Math.min(bw / 2, h / 2)}"/>`;
  };
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Ingresos y gastos de los últimos seis meses">`;
  data.forEach((d, i) => {
    const cx = left + slot * i + slot / 2;
    if (d.m === ym) svg += `<rect class="sel" x="${cx - slot / 2 + 3}" y="${top - 6}" width="${slot - 6}" height="${ph + 6 + bottom}" rx="14"/>`;
    svg += bar(cx - bw - 1.5, d.ing, 'bar-i', i);
    svg += bar(cx + 1.5, d.gas, 'bar-g', i);
    svg += `<text class="axis${d.m === ym ? ' on' : ''}" x="${cx}" y="${H - 6}" text-anchor="middle">${esc(monthLabel(d.m, { month: 'short' }).replace('.', ''))}</text>`;
    svg += `<rect class="hit" data-m="${d.m}" x="${cx - slot / 2}" y="0" width="${slot}" height="${H}"><title>${esc(monthLabel(d.m))}: ingresos ${fmt(d.ing)}, gastos ${fmt(d.gas)}, balance ${fmtSigned(d.bal)}</title></rect>`;
  });
  svg += `<text class="axis" x="${left}" y="${y(max) - 2}" font-size="10">${esc(fmt(max).replace(/,00/, ''))}</text>`;
  return svg + '</svg>';
}

function editMov(id) {
  const m = db.movs.find(x => x.id === id);
  if (!m) return;
  const isInv = m.cat === INV_OUT || m.cat === INV_IN;
  openSheet(`
    <h3>Editar ${m.type === 'gasto' ? 'gasto' : 'ingreso'}</h3>
    <label class="field"><span>Importe (€)</span><input id="eAmt" inputmode="decimal" value="${centsToInput(m.amount)}"></label>
    <label class="field"><span>Categoría</span><select id="eCat" ${isInv ? 'disabled' : ''}>${catOptions(m.type, m.cat)}</select></label>
    ${isInv ? '<p class="small muted">Movimiento de inversión: la categoría no se puede cambiar. El valor de la inversión no varía; si hace falta, corrígelo en Inversiones.</p>' : ''}
    <label class="field"><span>Nota</span><input id="eNote" value="${esc(m.note || '')}"></label>
    <label class="field"><span>Fecha</span><input id="eDate" type="date" value="${m.date}"></label>
    <button class="btn" id="eSave">Guardar</button>
    <button class="btn danger" id="eDel">Borrar</button>`, sh => {
    sh.querySelector('#eSave').onclick = () => {
      const a = parseAmount(sh.querySelector('#eAmt').value);
      if (!(a > 0)) { alert('Importe no válido'); return; }
      const before = { ...m };
      m.amount = a;
      if (!isInv) m.cat = sh.querySelector('#eCat').value;
      m.note = sh.querySelector('#eNote').value.trim();
      m.date = sh.querySelector('#eDate').value || m.date;
      if (!save()) Object.assign(m, before);
      closeSheet();
      render();
    };
    sh.querySelector('#eDel').onclick = () => {
      const idx = db.movs.indexOf(m);
      db.movs.splice(idx, 1);
      save();
      closeSheet();
      render();
      toast('Movimiento borrado', 'Deshacer', () => { db.movs.splice(idx, 0, m); save(); render(); });
    };
  });
}

/* =========================================================
   Pendiente: lo que me deben y lo que debo
   ========================================================= */

function renderPend() {
  const open = db.pend.filter(p => !p.settled).sort((a, b) => b.date.localeCompare(a.date));
  const done = db.pend.filter(p => p.settled).sort((a, b) => b.settled.localeCompare(a.settled)).slice(0, 10);
  const meDeben = open.filter(p => p.dir === 'meDeben').reduce((s, p) => s + p.amount, 0);
  const debo = open.filter(p => p.dir === 'debo').reduce((s, p) => s + p.amount, 0);
  const item = p => `
    <button class="li" data-id="${p.id}">
      <span class="av">${esc(initial(p.person))}</span>
      <div class="main"><div class="t">${esc(p.person)}</div><div class="s">${esc([p.reason, p.method, dayLabel(p.date)].filter(Boolean).join(' · '))}</div></div>
      <div class="a${p.dir === 'meDeben' ? ' pos' : ''}">${p.dir === 'meDeben' ? '+' : '−'}${fmt(p.amount)}</div>
    </button>`;
  $('#view').innerHTML = `
    <h1>Pendiente</h1>
    <div class="head">
    <div class="card">
      <div class="stat"><span>Te deben</span><b>${num(meDeben)}</b></div>
      <div class="stat"><span>Debes</span><b>${num(debo)}</b></div>
    </div>
    <button class="btn" id="newPend">Añadir pendiente</button>
    </div>
    <div class="cols">
    <div class="col">
    <h2>Te deben</h2>
    <div class="list pl">${open.filter(p => p.dir === 'meDeben').map(item).join('') || '<div class="empty-state">Nadie te debe nada.</div>'}</div>
    </div>
    <div class="col">
    <h2>Debes</h2>
    <div class="list pl">${open.filter(p => p.dir === 'debo').map(item).join('') || '<div class="empty-state">No debes nada.</div>'}</div>
    </div>
    </div>
    ${done.length ? `<h2>Saldados recientes</h2><div class="list pl">${done.map(item).join('')}</div>` : ''}`;
  $('#newPend').onclick = () => editPend(null);
  document.querySelectorAll('.pl').forEach(l => l.onclick = e => {
    const b = e.target.closest('.li');
    if (b) editPend(b.dataset.id);
  });
}

function editPend(id) {
  const p = id ? db.pend.find(x => x.id === id) : { dir: 'meDeben', person: '', amount: 0, reason: '', method: 'Bizum', date: todayISO(), settled: null };
  if (!p) return;
  const isNew = !id;
  openSheet(`
    <h3>${isNew ? 'Nuevo pendiente' : p.settled ? 'Pendiente saldado' : 'Pendiente'}</h3>
    ${seg('pDir', ['meDeben', 'Me deben'], ['debo', 'Debo'], p.dir)}
    <label class="field"><span>Persona</span><input id="pPerson" value="${esc(p.person)}" autocomplete="off"></label>
    <label class="field"><span>Importe (€)</span><input id="pAmt" inputmode="decimal" value="${p.amount ? centsToInput(p.amount) : ''}"></label>
    <label class="field"><span>Motivo</span><input id="pReason" value="${esc(p.reason)}" placeholder="Cena, entradas…"></label>
    <label class="field"><span>Medio</span><select id="pMethod">${METHODS.map(m => `<option ${m === p.method ? 'selected' : ''}>${m}</option>`).join('')}</select></label>
    <label class="field"><span>Fecha</span><input id="pDate" type="date" value="${p.date}"></label>
    <button class="btn" id="pSave">Guardar</button>
    ${!isNew && !p.settled ? '<button class="btn secondary" id="pSettle">Marcar como saldado</button>' : ''}
    ${!isNew && p.settled ? '<button class="btn secondary" id="pReopen">Reabrir</button>' : ''}
    ${!isNew ? '<button class="btn danger" id="pDel">Borrar</button>' : ''}`, sh => {
    let dir = p.dir;
    sh.querySelector('#pDir').onclick = e => {
      const b = e.target.closest('button');
      if (!b) return;
      dir = b.dataset.t;
      sh.querySelectorAll('#pDir button').forEach(x => x.classList.toggle('on', x === b));
      sh.querySelector('#pDir').dataset.on = dir === 'debo' ? 1 : 0;
    };
    const read = () => {
      const amount = parseAmount(sh.querySelector('#pAmt').value);
      const person = sh.querySelector('#pPerson').value.trim();
      if (!person) { alert('Indica la persona'); return null; }
      if (!(amount > 0)) { alert('Importe no válido'); return null; }
      return { dir, person, amount, reason: sh.querySelector('#pReason').value.trim(), method: sh.querySelector('#pMethod').value, date: sh.querySelector('#pDate').value || todayISO() };
    };
    sh.querySelector('#pSave').onclick = () => {
      const v = read();
      if (!v) return;
      if (isNew) db.pend.push({ id: uid(), settled: null, ...v }); else Object.assign(p, v);
      save(); closeSheet(); render();
    };
    const settleBtn = sh.querySelector('#pSettle');
    if (settleBtn) settleBtn.onclick = () => {
      const v = read();
      if (!v) return;
      Object.assign(p, v);
      settlePend(p);
    };
    const reopen = sh.querySelector('#pReopen');
    if (reopen) reopen.onclick = () => { p.settled = null; save(); closeSheet(); render(); };
    const del = sh.querySelector('#pDel');
    if (del) del.onclick = () => {
      if (!confirm('¿Borrar este pendiente?')) return;
      db.pend = db.pend.filter(x => x !== p);
      save(); closeSheet(); render();
    };
  });
}

// Al saldar, se puede registrar el cobro (ingreso) o el pago (gasto) en el balance.
function settlePend(p) {
  const type = p.dir === 'meDeben' ? 'ingreso' : 'gasto';
  const defCat = activeCats(type).find(c => c.name.toLowerCase() === p.method.toLowerCase()) ||
    activeCats(type).find(c => c.name === 'Otros') || activeCats(type)[0];
  openSheet(`
    <h3>Saldar ${fmt(p.amount)}</h3>
    <p class="muted">${p.dir === 'meDeben' ? `${esc(p.person)} te ha pagado.` : `Has pagado a ${esc(p.person)}.`} ¿Lo apunto también como ${type} de hoy?</p>
    <label class="field"><span>Categoría</span><select id="sCat">${catOptions(type, defCat && defCat.id)}</select></label>
    <button class="btn" id="sYes">Saldar y apuntar ${type}</button>
    <button class="btn secondary" id="sNo">Solo saldar</button>`, sh => {
    const finish = withMov => {
      p.settled = todayISO();
      if (withMov) db.movs.push({ id: uid(), created: Date.now(), type, amount: p.amount, cat: sh.querySelector('#sCat').value, note: [p.person, p.reason].filter(Boolean).join(' · '), date: todayISO(), pend: p.id });
      save(); closeSheet(); render();
      toast('Saldado');
      burst(innerWidth / 2, innerHeight * 0.4, 60, 1);
    };
    sh.querySelector('#sYes').onclick = () => finish(true);
    sh.querySelector('#sNo').onclick = () => finish(false);
  });
}

/* =========================================================
   Inversiones
   Aportar = gasto (categoría Inversiones). Retirar = ingreso.
   Cada mes se apunta el valor actual; con eso y la inflación se calcula
   si la inversión conserva su poder adquisitivo (ver calc.js).
   ========================================================= */

const curYM = () => monthOf(todayISO());
const monthName = ym => monthLabel(ym, { month: 'long' }).toLowerCase();
const pctPlain = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 2 });

// Guarda el valor de una inversión y lo anota en el historial del mes en curso.
// est = valor estimado por la app (tras una retirada), no apuntado por ti.
function setInvValue(inv, value, est) {
  inv.value = value;
  inv.valueDate = todayISO();
  const ym = curYM();
  const s = db.snaps.find(x => x.inv === inv.id && x.ym === ym);
  if (s) { s.value = value; if (!est) delete s.est; }
  else db.snaps.push({ id: uid(), inv: inv.id, ym, value, ...(est ? { est: true } : {}) });
}
const hasMonthValue = inv => db.snaps.some(s => s.inv === inv.id && s.ym === curYM() && !s.est);
const invsMissing = () => db.invs.filter(i => !i.archived && !hasMonthValue(i));

function invStats(inv) {
  return Calc.stats(Calc.invFlows(inv, db.movs), inv.value, curYM(), db.cfg.inflation);
}

const LIGHTS = {
  verde: { icon: 'M5 12.5l4.5 4.5L19 7.5', text: 'Vas bien: ganas a la inflación' },
  ambar: { icon: 'M12 6v7.5M12 17.6v.2', text: 'Ganas dinero, pero menos que la inflación' },
  rojo: { icon: 'M12 5v14M6 13l6 6 6-6', text: 'Tu inversión vale menos de lo aportado' },
};
const rentTxt = r => (r === null ? '—' : pct.format(r));

function renderInv() {
  const ym = curYM();
  const invs = db.invs.filter(i => !i.archived);
  const missing = invsMissing();

  if (!invs.length) {
    $('#view').innerHTML = `
      <h1>Inversiones</h1>
      <div class="card">
        <p style="margin-top:0">Añade tu fondo y apunta cada mes dos cosas: lo que aportas y lo que vale. La app te dirá si tu dinero gana a la inflación.</p>
        <button class="btn" id="newInv">Añadir mi primera inversión</button>
      </div>`;
    $('#newInv').onclick = newInv;
    return;
  }

  const t = Calc.totals(invs, db.movs, ym, db.cfg.inflation);
  const L = LIGHTS[t.luz];
  const serie = Calc.series(invs, db.movs, db.snaps, db.cfg.inflation);
  const sel = serie.find(p => p.ym === state.invSel) || serie[serie.length - 1];

  // Enlace con el resto de la app: lo que sobra este mes y lo que se ha invertido.
  let ing = 0, gas = 0, aportMes = 0;
  for (const m of db.movs) {
    if (monthOf(m.date) !== ym) continue;
    if (m.cat === INV_OUT) aportMes += m.amount;
    else if (m.cat === INV_IN) continue;
    else if (m.type === 'ingreso') ing += m.amount;
    else gas += m.amount;
  }
  const ahorro = ing - gas;

  $('#view').innerHTML = `
    <h1>Inversiones</h1>
    ${missing.length ? `<div class="banner warn">
      <div>Falta el valor de ${esc(monthName(ym))}${invs.length > 1 ? ' de ' + esc(missing.map(i => i.name).join(', ')) : ''}.</div>
      <button class="link" id="fillNow">Apuntar ahora</button>
    </div>` : ''}
    <div class="cols">
      <div class="col">
        <h2>¿Voy bien?</h2>
        <div class="hero inv ${t.luz}">
          <i class="glow"></i>
          ${L ? `<div class="light"><span class="lamp" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="${L.icon}"/></svg></span><span>${L.text}</span></div>` : ''}
          <div class="lbl">Ganancia real, descontada la inflación</div>
          <div class="bigfig num">${num(t.gananciaReal, true)} <span class="rent">${rentTxt(t.rentReal)}</span></div>
          <div class="stat"><span>Aportado</span><b>${fmt(t.aportado)}</b></div>
          <div class="stat"><span>Valor actual</span><b>${fmt(t.valor)}</b></div>
          <div class="stat"><span>Ganancia</span><b>${fmtSigned(t.ganancia)} (${rentTxt(t.rentNominal)})</b></div>
          <div class="stat"><span>Lo que se come la inflación</span><b>${fmtSigned(-t.inflacion)}</b></div>
          <div class="stat"><span>Valor real</span><b>${fmt(t.valorReal)}</b></div>
          <div class="stat sep"><span>Inflación anual</span><button class="link" id="setInfl">${pctPlain.format(db.cfg.inflation)} % · Cambiar</button></div>
        </div>
        <h2>${esc(monthLabel(ym, { month: 'long' }))}</h2>
        <div class="card">
          <div class="stat"><span>Ahorro antes de invertir</span><b>${fmtSigned(ahorro)}</b></div>
          <div class="stat"><span>Aportado a inversión</span><b>${fmt(aportMes)}</b></div>
          <div class="small muted">Ingresos menos gastos del mes, sin contar inversiones.</div>
        </div>
      </div>
      <div class="col">
        <h2>Aportado y valor real</h2>
        <div class="card chart">
          ${serie.length ? lineChart(serie, sel.ym) : ''}
          <div class="legend"><span><i class="sw" style="background:var(--accent)"></i>Valor real</span><span><i class="sw dash"></i>Aportado</span></div>
          <div class="small muted" style="margin-top:4px">${sel ? `${esc(monthLabel(sel.ym))}: aportado ${fmt(sel.aportado)}, valor real ${fmt(sel.valorReal)} (${fmtSigned(sel.valorReal - sel.aportado)}).` : ''}${serie.length < 2 ? ' La línea aparecerá cuando apuntes el segundo mes.' : ''}</div>
        </div>
        <h2>Mis inversiones</h2>
        <div class="list" id="invList">
          ${invs.map(i => {
            const st = invStats(i);
            return `<button class="li" data-id="${i.id}">
              <span class="av inv">${esc(initial(i.name))}</span>
              <div class="main"><div class="t">${esc(i.name)}</div><div class="s">${hasMonthValue(i) ? `Valor a ${esc(dayLabel(i.valueDate))}` : `Falta el valor de ${esc(monthName(ym))}`} · aportado ${fmt(st.aportado)}</div></div>
              <div style="text-align:right"><div class="a">${fmt(i.value)}</div><div class="s small muted num">${fmtSigned(st.gananciaReal)} real</div></div>
            </button>`;
          }).join('')}
        </div>
        <button class="link" id="newInv">+ Nueva inversión</button>
        <p class="small muted">Las aportaciones cuentan como gasto en el balance del mes y las retiradas como ingreso. El valor actual lo apuntas tú.</p>
      </div>
    </div>`;

  $('#newInv').onclick = newInv;
  const fill = $('#fillNow');
  if (fill) fill.onclick = () => invSheet(missing[0].id);
  $('#setInfl').onclick = editInflation;
  $('#invList').onclick = e => {
    const b = e.target.closest('.li');
    if (b) invSheet(b.dataset.id);
  };
  document.querySelectorAll('.chart [data-m]').forEach(r => r.addEventListener('click', () => {
    state.invSel = r.dataset.m;
    renderInv();
  }));
}

// Líneas de aportado y valor real, un punto por mes.
function lineChart(serie, selYm) {
  const W = 340, H = 180, top = 12, bottom = 22, left = 4, right = 4;
  const ph = H - top - bottom, pw = W - left - right;
  const vals = serie.flatMap(p => [p.aportado, p.valorReal]);
  // Escala con números redondos (1, 2 o 5 × 10ⁿ euros por tramo)
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const rough = Math.max(100, (hi - lo) / 2);
  const mag = Math.pow(10, Math.floor(Math.log10(rough)));
  const step = [1, 2, 5, 10].map(k => k * mag).find(v => v >= rough);
  const min = Math.max(0, Math.floor((lo - step * 0.1) / step) * step);
  const max = Math.max(min + step, Math.ceil((hi + step * 0.1) / step) * step);
  const n = serie.length;
  const x = i => (n === 1 ? left + pw / 2 : left + 14 + (pw - 28) * i / (n - 1));
  const y = v => top + ph - ((v - min) / (max - min)) * ph;
  const path = key => serie.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p[key]).toFixed(1)}`).join(' ');
  const short = c => eur.format(c / 100).replace(/,00/, '');
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Evolución de lo aportado y del valor real">
    <defs><linearGradient id="gArea" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffdd00" stop-opacity=".32"/><stop offset="1" stop-color="#ffdd00" stop-opacity="0"/></linearGradient></defs>`;
  [0, 0.5, 1].forEach(f => { const yy = top + ph - ph * f; svg += `<line class="grid" x1="${left}" x2="${W - right}" y1="${yy}" y2="${yy}"/>`; });
  svg += `<text class="axis" x="${left}" y="${top - 3}" font-size="10">${esc(short(max))}</text>`;
  svg += `<text class="axis" x="${left}" y="${top + ph - 4}" font-size="10">${esc(short(min))}</text>`;
  const slot = n === 1 ? pw : (pw - 28) / (n - 1);
  const selI = serie.findIndex(p => p.ym === selYm);
  if (selI >= 0) svg += `<line class="selx" x1="${x(selI)}" x2="${x(selI)}" y1="${top}" y2="${top + ph}"/>`;
  // El valor real debajo y lo aportado encima, a trazos, para que se distingan cuando casi coinciden.
  if (n > 1) svg += `<path class="area-v" d="${path('valorReal')} L${x(n - 1).toFixed(1)},${top + ph} L${x(0).toFixed(1)},${top + ph} Z"/><path class="line-v" pathLength="1" d="${path('valorReal')}"/><path class="line-a" d="${path('aportado')}"/>`;
  const every = Math.ceil(n / 6);
  serie.forEach((p, i) => {
    if (n <= 12 || i === selI) svg += `<circle class="dot-v" style="--i:${i}" cx="${x(i)}" cy="${y(p.valorReal)}" r="3.5"/><circle class="dot-a" style="--i:${i}" cx="${x(i)}" cy="${y(p.aportado)}" r="2"/>`;
    if ((n - 1 - i) % every === 0) svg += `<text class="axis${i === selI ? ' on' : ''}" x="${x(i)}" y="${H - 6}" text-anchor="middle">${esc(monthLabel(p.ym, { month: 'short' }).replace('.', ''))}</text>`;
    svg += `<rect class="hit" data-m="${p.ym}" x="${x(i) - slot / 2}" y="0" width="${slot}" height="${H}"><title>${esc(monthLabel(p.ym))}: aportado ${fmt(p.aportado)}, valor real ${fmt(p.valorReal)}</title></rect>`;
  });
  return svg + '</svg>';
}

function editInflation() {
  openSheet(`
    <h3>Inflación anual</h3>
    <label class="field"><span>Inflación anual estimada (%)</span><input id="fInfl" inputmode="decimal" value="${String(db.cfg.inflation).replace('.', ',')}"></label>
    <p class="small muted">Se aplica a cada aportación desde el mes en que la hiciste. Pon la media que esperas, no el dato de un mes concreto.</p>
    <button class="btn" id="fSave">Guardar</button>`, sh => {
    sh.querySelector('#fSave').onclick = () => {
      const v = parseFloat(sh.querySelector('#fInfl').value.trim().replace(',', '.').replace('%', ''));
      if (!isFinite(v) || v < -10 || v > 50) { alert('Pon un porcentaje entre −10 y 50'); return; }
      db.cfg.inflation = Math.round(v * 100) / 100;
      save(); closeSheet(); render();
    };
  });
}

function newInv() {
  openSheet(`
    <h3>Nueva inversión</h3>
    <label class="field"><span>Nombre</span><input id="iName" placeholder="Fondo indexado global…" autocomplete="off"></label>
    <label class="field"><span>Ya aportado antes de usar la app (€)</span><input id="iPrev" inputmode="decimal" placeholder="0"></label>
    <label class="field"><span>Valor actual (€)</span><input id="iVal" inputmode="decimal" placeholder="0"></label>
    <p class="small muted">Si empiezas ahora, deja los dos importes en blanco. Lo aportado antes no cuenta como gasto de este mes.</p>
    <button class="btn" id="iSave">Crear</button>`, sh => {
    sh.querySelector('#iSave').onclick = () => {
      const name = sh.querySelector('#iName').value.trim();
      const prevS = sh.querySelector('#iPrev').value.trim();
      const valS = sh.querySelector('#iVal').value.trim();
      const prev = prevS ? parseAmount(prevS) : 0;
      const value = valS ? parseAmount(valS) : prev;
      if (!name) { alert('Ponle un nombre'); return; }
      if (isNaN(prev) || isNaN(value)) { alert('Importe no válido'); return; }
      const inv = { id: uid(), name, prev, value, valueDate: todayISO(), start: curYM(), archived: false };
      db.invs.push(inv);
      const empty = !prev && !value;
      if (!empty) setInvValue(inv, value);
      save(); closeSheet(); render();
      if (empty) invSheet(inv.id); // si empieza de cero, pasa directo al primer apunte
    };
  });
}

// Apunte mensual: dos campos (aportación y valor actual) y guardar.
function invSheet(id) {
  const inv = db.invs.find(i => i.id === id);
  if (!inv) return;
  const ym = curYM();
  const st = invStats(inv);
  const aports = db.movs.filter(m => m.inv === inv.id && m.type === 'gasto')
    .sort((a, b) => a.date.localeCompare(b.date) || (a.created || 0) - (b.created || 0));
  const thisMonth = aports.filter(m => monthOf(m.date) === ym).reduce((s, m) => s + m.amount, 0);
  const last = aports[aports.length - 1];
  const prefill = !thisMonth && last ? centsToInput(last.amount) : '';
  openSheet(`
    <h3>${esc(inv.name)}</h3>
    <p class="muted" style="margin-top:-6px">Apunte de ${esc(monthName(ym))}${hasMonthValue(inv) ? ' · valor ya apuntado el ' + esc(dayLabel(inv.valueDate)) : ''}</p>
    <label class="field"><span>Aportación de este mes (€)</span><input id="mAp" inputmode="decimal" value="${prefill}" placeholder="0,00" autocomplete="off"></label>
    ${thisMonth ? `<p class="small muted" style="margin-top:-6px">Este mes ya has aportado ${fmt(thisMonth)}. Lo que pongas aquí se suma.</p>` : ''}
    <label class="field"><span>Valor actual (€)</span><input id="mVal" inputmode="decimal" placeholder="${centsToInput(inv.value)}" autocomplete="off"></label>
    <button class="btn" id="mSave">Guardar</button>
    <div class="card" style="margin-top:16px">
      <div class="stat"><span>Aportado</span><b>${fmt(st.aportado)}</b></div>
      <div class="stat"><span>Valor actual</span><b>${fmt(inv.value)}</b></div>
      <div class="stat"><span>Ganancia</span><b>${fmtSigned(st.ganancia)} (${rentTxt(st.rentNominal)})</b></div>
      <div class="stat"><span>Ganancia real</span><b>${fmtSigned(st.gananciaReal)} (${rentTxt(st.rentReal)})</b></div>
    </div>
    <details class="more">
      <summary>Más opciones</summary>
      <label class="field"><span>Retirar dinero (€)</span><input id="vOutAmt" inputmode="decimal" placeholder="0,00" data-enter="#vOut"></label>
      <button class="btn secondary" id="vOut">Retirar</button>
      <p class="small muted">La retirada cuenta como ingreso del mes y se resta del valor actual.</p>
      <button class="btn secondary" id="vRen">Renombrar</button>
      <button class="btn danger" id="vDel">Quitar de la lista</button>
    </details>`, sh => {
    sh.querySelector('#mSave').onclick = () => {
      const apS = sh.querySelector('#mAp').value.trim();
      const valS = sh.querySelector('#mVal').value.trim();
      const ap = apS ? parseAmount(apS) : 0;
      if (isNaN(ap)) { alert('Aportación no válida'); return; }
      if (!valS) { alert('Indica el valor actual de la inversión'); sh.querySelector('#mVal').focus(); return; }
      const val = parseAmount(valS);
      if (isNaN(val)) { alert('Valor no válido'); return; }
      const before = JSON.stringify(db);
      if (ap > 0) db.movs.push({ id: uid(), created: Date.now(), type: 'gasto', amount: ap, cat: INV_OUT, note: inv.name, date: todayISO(), inv: inv.id });
      setInvValue(inv, val);
      if (!save()) { db = JSON.parse(before); return; }
      closeSheet(); render();
      // Celebración solo cuando el apunte deja el semáforo en verde.
      if (Calc.totals(db.invs, db.movs, curYM(), db.cfg.inflation).luz === 'verde') burst(innerWidth / 2, innerHeight * 0.38, 110, 1.25);
      toast(ap > 0 ? `Apuntado: ${fmt(ap)} aportados, valor ${fmt(val)}` : `Valor apuntado: ${fmt(val)}`, 'Deshacer', () => {
        db = JSON.parse(before); save(); render(); toast('Deshecho');
      });
    };
    sh.querySelector('#vOut').onclick = () => {
      const a = parseAmount(sh.querySelector('#vOutAmt').value);
      if (!(a > 0)) { alert('Importe no válido'); return; }
      if (a > inv.value) { alert('No puedes retirar más del valor actual'); return; }
      db.movs.push({ id: uid(), created: Date.now(), type: 'ingreso', amount: a, cat: INV_IN, note: inv.name, date: todayISO(), inv: inv.id });
      setInvValue(inv, inv.value - a, true);
      save(); closeSheet(); render();
      toast(`Retirados ${fmt(a)}`);
    };
    sh.querySelector('#vRen').onclick = () => {
      const n = prompt('Nuevo nombre', inv.name);
      if (n && n.trim()) { inv.name = n.trim(); save(); closeSheet(); render(); }
    };
    sh.querySelector('#vDel').onclick = () => {
      if (!confirm('¿Quitar esta inversión de la lista? Sus aportaciones seguirán contando en el balance de cada mes.')) return;
      inv.archived = true; save(); closeSheet(); render();
    };
    // En el móvil el cursor va directo al valor, que es lo único que hay que escribir casi siempre.
    sh.querySelector(prefill || thisMonth ? '#mVal' : '#mAp').focus();
  });
}

/* =========================================================
   Ajustes: categorías y copia de seguridad
   ========================================================= */

const BACKUP_DAYS = 30;
function backupDue() {
  const hasData = db.movs.length || db.pend.length || db.invs.length;
  if (!hasData) return false;
  return !db.lastBackup || Date.now() - db.lastBackup > BACKUP_DAYS * 864e5;
}
function updateBackupDot() { $('#backupDot').hidden = !backupDue(); }

function renderSet() {
  const catList = type => activeCats(type).map(c => `
    <button class="li" data-id="${c.id}"><div class="main"><div class="t">${esc(c.name)}</div></div><span class="muted">›</span></button>`).join('');
  $('#view').innerHTML = `
    <h1>Ajustes</h1>
    ${backupDue() ? `<div class="banner">${db.lastBackup ? `Tu última copia es del ${esc(new Date(db.lastBackup).toLocaleDateString('es-ES'))}.` : 'Aún no has hecho ninguna copia.'} Exporta una ahora para no perder tus datos.</div>` : ''}
    <div class="cols three">
    <div class="col">
    <h2>Copia de seguridad</h2>
    <div class="card">
      <p class="small muted" style="margin-top:0">Los datos solo están en este dispositivo. Guarda la copia en Archivos o iCloud Drive.</p>
      <button class="btn" id="exp">Exportar copia</button>
      <button class="btn secondary" id="imp">Importar copia</button>
      <input type="file" id="impFile" accept="application/json,.json" hidden>
      <p class="small muted" style="margin-bottom:0">Última copia: ${db.lastBackup ? esc(new Date(db.lastBackup).toLocaleString('es-ES')) : 'nunca'}</p>
    </div>
    </div>
    <div class="col">
    <h2>Categorías de gasto</h2>
    <div class="list plain catl">${catList('gasto')}</div>
    <button class="link" data-add="gasto">+ Añadir categoría de gasto</button>
    </div>
    <div class="col">
    <h2>Categorías de ingreso</h2>
    <div class="list plain catl">${catList('ingreso')}</div>
    <button class="link" data-add="ingreso">+ Añadir categoría de ingreso</button>
    </div>
    </div>
    <p class="small muted" style="margin-top:24px">Versión ${APP_VERSION} · ${db.movs.length} movimientos guardados</p>`;

  $('#exp').onclick = exportData;
  $('#imp').onclick = () => $('#impFile').click();
  $('#impFile').onchange = e => { const f = e.target.files[0]; if (f) importData(f); e.target.value = ''; };
  document.querySelectorAll('[data-add]').forEach(b => b.onclick = () => {
    const n = prompt('Nombre de la categoría');
    if (!n || !n.trim()) return;
    db.cats.push({ id: uid(), name: n.trim(), type: b.dataset.add, archived: false });
    save(); render();
  });
  document.querySelectorAll('.catl').forEach(l => l.onclick = e => {
    const b = e.target.closest('.li');
    if (b) catSheet(b.dataset.id);
  });
}

function catSheet(id) {
  const c = catById(id);
  if (!c) return;
  const uses = db.movs.filter(m => m.cat === id).length;
  openSheet(`
    <h3>${esc(c.name)}</h3>
    <label class="field"><span>Nombre</span><input id="cName" value="${esc(c.name)}"></label>
    <button class="btn" id="cSave">Guardar</button>
    <button class="btn danger" id="cDel">Borrar categoría</button>
    <p class="small muted">${uses ? `Tiene ${uses} movimientos. Si la borras, dejará de salir al añadir, pero esos movimientos la conservan.` : 'No tiene movimientos.'}</p>`, sh => {
    sh.querySelector('#cSave').onclick = () => {
      const n = sh.querySelector('#cName').value.trim();
      if (!n) return;
      c.name = n; save(); closeSheet(); render();
    };
    sh.querySelector('#cDel').onclick = () => {
      if (activeCats(c.type).length <= 1) { alert('Tiene que quedar al menos una categoría'); return; }
      c.archived = true; save(); closeSheet(); render();
    };
  });
}

async function exportData() {
  const json = JSON.stringify(db, null, 1);
  const name = `finanzas-${todayISO()}.json`;
  const file = new File([json], name, { type: 'application/json' });
  const done = () => { db.lastBackup = Date.now(); save(); render(); toast('Copia exportada'); };
  try {
    // En iPhone, la hoja de compartir permite "Guardar en Archivos".
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: name });
      done();
      return;
    }
  } catch (e) {
    if (e.name === 'AbortError') return; // el usuario cerró la hoja
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  done();
}

async function importData(f) {
  try {
    const d = migrate(JSON.parse(await f.text()));
    if (!validShape(d)) throw new Error('El archivo no es una copia de esta app');
    const msg = `La copia tiene ${d.movs.length} movimientos, ${d.pend.length} pendientes y ${d.invs.length} inversiones.\n\nSustituirá los datos actuales (${db.movs.length} movimientos). ¿Continuar?`;
    if (!confirm(msg)) return;
    db = d;
    save();
    render();
    toast('Copia importada');
  } catch (e) {
    alert('No se pudo importar: ' + e.message);
  }
}

/* =========================================================
   Arranque
   ========================================================= */

// Al volver a la app otro día, la fecha por defecto pasa a ser hoy.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.tab === 'add' && state.amount === '') {
    state.date = todayISO();
    renderAdd();
  }
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(e => console.warn('SW', e)));
}

render();
enter('enter');
