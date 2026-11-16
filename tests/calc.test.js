'use strict';
// Pruebas de los cálculos de inversión. Ejecutar con: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const Calc = require('../calc.js');

/* ---------------------------------------------------------
   Caso resuelto a mano
   100 € en enero, febrero y marzo de 2026. Inflación 2,5 % anual.
   Valor (inventado) a final de cada mes: 101 €, 199 €, 306 €.

   Lo que la inflación se come de cada aportación = importe × (1,025^(meses/12) − 1)
     1,025^(1/12) = 1,0020598  → 100 € × 0,0020598 = 0,206 €
     1,025^(2/12) = 1,0041239  → 100 € × 0,0041239 = 0,412 €

   Marzo:  enero lleva 2 meses (0,412 €), febrero 1 mes (0,206 €), marzo 0.
           Inflación acumulada = 0,618 € → 0,62 €
           Aportado 300,00 · Valor 306,00 · Ganancia +6,00
           Valor real 306,00 − 0,62 = 305,38 · Ganancia real +5,38
           Rentabilidad real 5,38 / 300 = +1,79 % → VERDE
   Febrero: enero lleva 1 mes (0,206 € → 0,21 €).
           Aportado 200,00 · Valor 199,00 · Ganancia −1,00
           Valor real 198,79 → ROJO (vale menos de lo aportado)
   Enero:  Aportado 100,00 · Valor 101,00 · Valor real 101,00 → VERDE
   --------------------------------------------------------- */
const flows = [
  { ym: '2026-01', amount: 10000 },
  { ym: '2026-02', amount: 10000 },
  { ym: '2026-03', amount: 10000 },
];

test('caso a mano: marzo', () => {
  const s = Calc.stats(flows, 30600, '2026-03', 2.5);
  assert.equal(s.aportado, 30000);
  assert.equal(s.valor, 30600);
  assert.equal(s.ganancia, 600);
  assert.equal(s.inflacion, 62);
  assert.equal(s.valorReal, 30538);
  assert.equal(s.gananciaReal, 538);
  assert.ok(Math.abs(s.rentReal - 0.017933) < 1e-5);
  assert.ok(Math.abs(s.rentNominal - 0.02) < 1e-9);
  assert.equal(s.luz, 'verde');
});

test('caso a mano: febrero (solo cuentan las aportaciones hasta ese mes)', () => {
  const s = Calc.stats(flows, 19900, '2026-02', 2.5);
  assert.equal(s.aportado, 20000);
  assert.equal(s.inflacion, 21);
  assert.equal(s.valorReal, 19879);
  assert.equal(s.luz, 'rojo');
});

test('caso a mano: enero', () => {
  const s = Calc.stats(flows, 10100, '2026-01', 2.5);
  assert.equal(s.aportado, 10000);
  assert.equal(s.inflacion, 0);
  assert.equal(s.valorReal, 10100);
  assert.equal(s.luz, 'verde');
});

test('ámbar: gana en euros pero no a la inflación', () => {
  // 100 € hace 12 meses, hoy vale 101 €. La inflación se ha comido 2,50 €.
  const s = Calc.stats([{ ym: '2025-03', amount: 10000 }], 10100, '2026-03', 2.5);
  assert.equal(s.inflacion, 250);
  assert.equal(s.valorReal, 9850);
  assert.equal(s.ganancia, 100);
  assert.equal(s.gananciaReal, -150);
  assert.equal(s.luz, 'ambar');
});

test('límite del verde: rentabilidad real exactamente cero', () => {
  const s = Calc.stats([{ ym: '2025-03', amount: 10000 }], 10250, '2026-03', 2.5);
  assert.equal(s.gananciaReal, 0);
  assert.equal(s.luz, 'verde');
});

test('con inflación 0, lo real coincide con lo nominal', () => {
  const s = Calc.stats(flows, 30600, '2026-03', 0);
  assert.equal(s.inflacion, 0);
  assert.equal(s.valorReal, s.valor);
  assert.equal(s.rentReal, s.rentNominal);
});

test('las retiradas restan de lo aportado', () => {
  const f = [{ ym: '2025-03', amount: 20000 }, { ym: '2025-09', amount: -5000 }];
  const s = Calc.stats(f, 16000, '2026-03', 2.5);
  assert.equal(s.aportado, 15000);
  // 200 × (1,025 − 1) − 50 × (1,025^(6/12) − 1) = 5,00 − 0,62 = 4,38
  assert.equal(s.inflacion, 438);
  assert.equal(s.valorReal, 15562);
});

test('sin aportaciones ni valor no hay semáforo', () => {
  const s = Calc.stats([], 0, '2026-03', 2.5);
  assert.equal(s.luz, 'sin-datos');
  assert.equal(s.rentReal, null);
});

test('meses entre fechas, también entre años', () => {
  assert.equal(Calc.monthsBetween('2026-01', '2026-03'), 2);
  assert.equal(Calc.monthsBetween('2025-11', '2026-02'), 3);
  assert.equal(Calc.monthsBetween('2026-03', '2026-01'), -2);
});

/* ---------- a partir de los datos de la app ---------- */

const inv = { id: 'f1', name: 'Fondo', prev: 0, start: '2026-01', value: 30600, archived: false };
const movs = [
  { id: 'a', type: 'gasto', amount: 10000, cat: 'inv-out', date: '2026-01-05', inv: 'f1' },
  { id: 'b', type: 'gasto', amount: 10000, cat: 'inv-out', date: '2026-02-05', inv: 'f1' },
  { id: 'c', type: 'gasto', amount: 10000, cat: 'inv-out', date: '2026-03-05', inv: 'f1' },
  { id: 'x', type: 'gasto', amount: 4200, cat: 'super', date: '2026-03-06' }, // no es inversión
];
const snaps = [
  { id: 's1', inv: 'f1', ym: '2026-01', value: 10100 },
  { id: 's2', inv: 'f1', ym: '2026-02', value: 19900 },
  { id: 's3', inv: 'f1', ym: '2026-03', value: 30600 },
];

test('serie mensual para el gráfico: coincide con el caso a mano', () => {
  const s = Calc.series([inv], movs, snaps, 2.5);
  assert.deepEqual(s, [
    { ym: '2026-01', aportado: 10000, valor: 10100, valorReal: 10100 },
    { ym: '2026-02', aportado: 20000, valor: 19900, valorReal: 19879 },
    { ym: '2026-03', aportado: 30000, valor: 30600, valorReal: 30538 },
  ]);
});

test('totales de la pantalla: coinciden con el caso a mano', () => {
  const t = Calc.totals([inv], movs, '2026-03', 2.5);
  assert.equal(t.aportado, 30000);
  assert.equal(t.valorReal, 30538);
  assert.equal(t.luz, 'verde');
});

test('un mes sin apunte arrastra el último valor conocido', () => {
  const s = Calc.series([inv], movs, [snaps[0], snaps[2]], 2.5);
  assert.equal(s.length, 3);
  assert.equal(s[1].valor, 10100);
  assert.equal(s[1].aportado, 20000);
});

test('lo aportado antes de usar la app cuenta desde el mes de alta', () => {
  const i2 = { id: 'f2', prev: 50000, start: '2025-03', value: 52000, archived: false };
  const f = Calc.invFlows(i2, []);
  assert.deepEqual(f, [{ ym: '2025-03', amount: 50000 }]);
  const t = Calc.totals([i2], [], '2026-03', 2.5);
  assert.equal(t.inflacion, 1250);
  assert.equal(t.valorReal, 50750);
});

test('varias inversiones se suman y las archivadas no cuentan', () => {
  const b = { id: 'f2', prev: 10000, start: '2026-03', value: 10000, archived: false };
  const z = { id: 'f3', prev: 99900, start: '2026-01', value: 1, archived: true };
  const t = Calc.totals([inv, b, z], movs, '2026-03', 2.5);
  assert.equal(t.aportado, 40000);
  assert.equal(t.valor, 40600);
  const s = Calc.series([inv, b, z], movs, [...snaps, { id: 's4', inv: 'f2', ym: '2026-03', value: 10000 }], 2.5);
  assert.equal(s[1].aportado, 20000); // en febrero la segunda aún no existía
  assert.equal(s[2].aportado, 40000);
  assert.equal(s[2].valor, 40600);
});
