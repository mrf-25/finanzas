/* =========================================================
   Cálculos de inversión (sin interfaz, para poder probarlos).
   Importes en céntimos. Meses como 'AAAA-MM'. Inflación anual en %.

   Valor real = valor actual − lo que la inflación se ha comido de
   cada aportación desde el mes en que se hizo.
   ========================================================= */
(function (root) {
  'use strict';

  // Meses que van de a hasta b ('2026-01' → '2026-03' = 2).
  function monthsBetween(a, b) {
    const [ya, ma] = a.split('-').map(Number);
    const [yb, mb] = b.split('-').map(Number);
    return (yb - ya) * 12 + (mb - ma);
  }

  function nextMonth(ym) {
    const [y, m] = ym.split('-').map(Number);
    return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  }

  // Céntimos (con decimales) que la inflación resta a unos flujos hasta el mes asOf.
  function erosion(flows, asOf, infl) {
    let e = 0;
    for (const f of flows) {
      const months = monthsBetween(f.ym, asOf);
      if (months < 0) continue;
      e += f.amount * (Math.pow(1 + infl / 100, months / 12) - 1);
    }
    return e;
  }

  // Verde: gana a la inflación. Ámbar: gana en euros pero no a la inflación.
  // Rojo: vale menos de lo aportado.
  function light(aportado, valor, gananciaReal) {
    if (aportado === 0 && valor === 0) return 'sin-datos';
    if (gananciaReal >= 0) return 'verde';
    return valor - aportado >= 0 ? 'ambar' : 'rojo';
  }

  // flows: [{ ym, amount }] con aportaciones en positivo y retiradas en negativo.
  function stats(flows, valor, asOf, infl) {
    const upTo = flows.filter(f => monthsBetween(f.ym, asOf) >= 0);
    const aportado = upTo.reduce((s, f) => s + f.amount, 0);
    const inflacion = Math.round(erosion(upTo, asOf, infl));
    const valorReal = valor - inflacion;
    const ganancia = valor - aportado;
    const gananciaReal = valorReal - aportado;
    return {
      aportado, valor, ganancia, inflacion, valorReal, gananciaReal,
      rentNominal: aportado > 0 ? ganancia / aportado : null,
      rentReal: aportado > 0 ? gananciaReal / aportado : null,
      luz: light(aportado, valor, gananciaReal),
    };
  }

  // Flujos de una inversión a partir de los datos de la app.
  function invFlows(inv, movs) {
    const flows = [];
    if (inv.prev > 0) flows.push({ ym: inv.start, amount: inv.prev });
    for (const m of movs) {
      if (m.inv !== inv.id) continue;
      flows.push({ ym: m.date.slice(0, 7), amount: m.type === 'gasto' ? m.amount : -m.amount });
    }
    return flows;
  }

  // Totales de todas las inversiones activas, con su valor actual.
  function totals(invs, movs, asOf, infl) {
    let flows = [], valor = 0;
    for (const inv of invs) {
      if (inv.archived) continue;
      flows = flows.concat(invFlows(inv, movs));
      valor += inv.value;
    }
    return stats(flows, valor, asOf, infl);
  }

  // Un punto por mes desde el primer valor apuntado hasta el último.
  // Cada inversión entra en la serie a partir de su primer valor; un mes sin
  // apunte arrastra el último valor conocido.
  function series(invs, movs, snaps, infl) {
    const per = [];
    for (const inv of invs) {
      if (inv.archived) continue;
      const ss = snaps.filter(s => s.inv === inv.id).sort((a, b) => a.ym.localeCompare(b.ym));
      if (ss.length) per.push({ flows: invFlows(inv, movs), snaps: ss });
    }
    if (!per.length) return [];
    let first = per[0].snaps[0].ym, last = first;
    for (const p of per) {
      if (p.snaps[0].ym < first) first = p.snaps[0].ym;
      const l = p.snaps[p.snaps.length - 1].ym;
      if (l > last) last = l;
    }
    const out = [];
    for (let ym = first; ym <= last; ym = nextMonth(ym)) {
      let flows = [], valor = 0;
      for (const p of per) {
        if (p.snaps[0].ym > ym) continue;
        let v = 0;
        for (const s of p.snaps) { if (s.ym <= ym) v = s.value; else break; }
        valor += v;
        flows = flows.concat(p.flows);
      }
      const st = stats(flows, valor, ym, infl);
      out.push({ ym, aportado: st.aportado, valor: st.valor, valorReal: st.valorReal });
    }
    return out;
  }

  const Calc = { monthsBetween, nextMonth, erosion, light, stats, invFlows, totals, series };
  if (typeof module !== 'undefined' && module.exports) module.exports = Calc;
  else root.Calc = Calc;
})(typeof self !== 'undefined' ? self : this);
