import { useState, useEffect, useRef, useCallback } from 'react';
import './App.css';

// ── STAŁE ──────────────────────────────────────────────────────────────────
const PREP = 60;
const DEAD = 1200;

const INGREDIENTS = ['Ciasto', 'Sos', 'Ser', 'Salami', 'Pieczarki'];

const BOM = {
  'Margherita': ['Ciasto', 'Sos', 'Ser'],
  'Diavola':    ['Ciasto', 'Sos', 'Ser', 'Salami'],
  'Funghi':     ['Ciasto', 'Sos', 'Ser', 'Pieczarki'],
};

const NAMES = Object.keys(BOM);

// ── HELPERS ────────────────────────────────────────────────────────────────
function rnd(a, b) { return Math.floor(Math.random() * (b - a + 1)) + a; }
function fmt(s) {
  s = Math.round(s);
  return s < 60 ? s + 's' : Math.floor(s / 60) + 'm' + (s % 60 ? ' ' + (s % 60) + 's' : '');
}
function bufColor(pct) {
  if (pct > 100) return '#111827';
  if (pct > 66)  return '#dc2626';
  if (pct > 33)  return '#d97706';
  return '#16a34a';
}
function checkMurphy(name, stock) {
  const needed = BOM[name] || [];
  const missing = needed.filter(i => !stock[i]);
  return { murphy: missing.length > 0, missing };
}

// ── STAN ───────────────────────────────────────────────────────────────────
function createStock() {
  const s = {};
  INGREDIENTS.forEach(i => s[i] = true);
  return s;
}

function createState() {
  return {
    running: false, toc: false, auto: true,
    speed: 1, wipLimit: 20, bakeTime: 300, prepTime: 60, autoInterval: 120,
    simTime: 0, nextId: 1,
    orders: [], wip: [], oven: [null, null], done: [],
    chef: null,
    chefBusyTime: 0, ovenBusyTime: 0, totalTime: 0,
    waste: 0, maxWip: 0, leadTimes: [],
    autoTimer: 120, logs: [],
    wastePulse: false,
    wasteList: [],
  };
}

// ── SILNIK ─────────────────────────────────────────────────────────────────
function tickState(s, stock) {
  s = { ...s, oven: [...s.oven], wip: [...s.wip], orders: [...s.orders], done: [...s.done], leadTimes: [...s.leadTimes], wasteList: [...(s.wasteList||[])] };
  const logs = [...s.logs];
  const log = (msg) => logs.unshift({ t: fmt(s.simTime), msg });

  s.simTime += 1;
  s.totalTime += 1;
  if (s.chef) s.chefBusyTime += 1;
  s.oven.forEach(slot => { if (slot) s.ovenBusyTime += 1; });

  // Auto zamówienie
  if (s.auto) {
    s.autoTimer -= 1;
    if (s.autoTimer <= 0) {
      const name = NAMES[rnd(0, NAMES.length - 1)];
      const { murphy, missing } = checkMurphy(name, stock);
      const o = { id: s.nextId++, name, start: s.simTime, murphy, missing: missing || [], status: 'queue', prepEnd: 0, bakeEnd: 0 };
      s.orders = [...s.orders, o];
      s.autoTimer = s.autoInterval;
      log('#' + o.id + ' ' + o.name + (murphy ? ' ⚠ brak: ' + missing.join(', ') : ' — zamówienie'));
    }
  }

  // TOC: zamówienia z brakiem przeterminowane po deadline
  if (s.toc) {
    s.orders = s.orders.map(o => {
      if (o.status === 'queue' && o.murphy && (s.simTime - o.start) >= DEAD) {
        log('⏱ #' + o.id + ' ' + o.name + ' — przeterminowane w kolejce (brak: ' + (o.missing||[]).join(', ') + ')');
        s.waste++;
        s.wastePulse = true;
        return { ...o, status: 'expired' };
      }
      return o;
    });
  }

  // Re-check murphy dla zamówień w kolejce (stock mógł się zmienić)
  s.orders = s.orders.map(o => {
    if (o.status !== 'queue') return o;
    const { murphy, missing } = checkMurphy(o.name, stock);
    return { ...o, murphy, missing };
  });

  // Piec — sprawdź gotowe
  s.oven = s.oven.map(slot => {
    if (slot && s.simTime >= slot.bakeEnd) {
      const done = { ...slot, status: 'done' };
      s.done = [...s.done, done];
      s.leadTimes = [...s.leadTimes, done.bakeEnd - done.start];
      log('#' + done.id + ' ' + done.name + ' gotowa! LT:' + fmt(done.bakeEnd - done.start));
      return null;
    }
    return slot;
  });

  // Blat: wip-bad — sprawdź czy składnik wrócił (OEE)
  if (!s.toc) {
    s.wip = s.wip.map(w => {
      if (w.status === 'wip-bad') {
        const { murphy, missing } = checkMurphy(w.name, stock);
        if (!murphy) {
          log('✓ #' + w.id + ' ' + w.name + ' — składnik dostarczony! Pizza odblokowana');
          return { ...w, status: 'wip', murphy: false, missing: [] };
        }
      }
      return w;
    });
  }

  // Blat → piec: normalne pizze idą do pieca gdy slot wolny
  if (!s.chef) {
    const fi = s.oven.findIndex(x => x === null);
    const ready = s.wip.find(w => w.status === 'wip');
    if (ready && fi >= 0) {
      s.wip = s.wip.filter(w => w.id !== ready.id);
      s.oven = s.oven.map((o, i) => i === fi ? { ...ready, status: 'oven', bakeEnd: s.simTime + s.bakeTime } : o);
      log('#' + ready.id + ' ' + ready.name + ' — do pieca (slot ' + (fi + 1) + ')');
    }
  }

  // Kucharz skończył
  if (s.chef && s.simTime >= s.chef.prepEnd) {
    const job = { ...s.chef };
    s.chef = null;

    if (job.murphy && !s.toc) {
      // OEE: pizza z brakiem → jeśli blat pełny wypchnij najstarszą wip-bad
      if (s.wip.length >= s.wipLimit) {
        const firstBadIdx = s.wip.findIndex(w => w.status === 'wip-bad');
        if (firstBadIdx >= 0) {
          const kicked = s.wip[firstBadIdx];
          s.wip = s.wip.filter((_, i) => i !== firstBadIdx);
          s.waste++;
          s.wastePulse = true;
          s.wasteList = [{ ...kicked, wastedAt: s.simTime }, ...s.wasteList].slice(0, 30);
          log('🗑 #' + kicked.id + ' ' + kicked.name + ' — wypchnięty! STRATA (brak: ' + (kicked.missing||[]).join(', ') + ')');
        } else {
          s.waste++;
          s.wastePulse = true;
          s.wasteList = [{ ...job, wastedAt: s.simTime }, ...s.wasteList].slice(0, 30);
          log('🗑 #' + job.id + ' ' + job.name + ' — blat pełny + brak → STRATA');
          s.maxWip = Math.max(s.maxWip, s.wip.length);
          s.logs = logs.slice(0, 80);
          return s;
        }
      }
      s.wip = [...s.wip, { ...job, status: 'wip-bad' }];
      log('⚠ #' + job.id + ' ' + job.name + ' — na blat z brakiem [' + (job.missing||[]).join(', ') + '] czeka na dostawę');

    } else if (!job.murphy) {
      // Normalna pizza — piec lub blat
      const fi = s.oven.findIndex(x => x === null);
      if (fi >= 0) {
        s.oven = s.oven.map((o, i) => i === fi ? { ...job, status: 'oven', bakeEnd: s.simTime + s.bakeTime } : o);
        log('#' + job.id + ' ' + job.name + ' — do pieca (slot ' + (fi + 1) + ')');
      } else if (s.wip.length < s.wipLimit) {
        s.wip = [...s.wip, { ...job, status: 'wip' }];
        log('#' + job.id + ' ' + job.name + ' — czeka na blacie');
      } else {
        // Blat pełny — wypchnij najstarszą wip-bad FIFO → STRATA
        const firstBadIdx = s.wip.findIndex(w => w.status === 'wip-bad');
        if (firstBadIdx >= 0) {
          const kicked = s.wip[firstBadIdx];
          s.wip = s.wip.filter((_, i) => i !== firstBadIdx);
          s.waste++;
          s.wastePulse = true;
          s.wasteList = [{ ...kicked, wastedAt: s.simTime }, ...s.wasteList].slice(0, 30);
          log('🗑 #' + kicked.id + ' ' + kicked.name + ' — wypchnięty przez #' + job.id + '! STRATA FIFO (brak: ' + (kicked.missing||[]).join(', ') + ')');
          s.wip = [...s.wip, { ...job, status: 'wip' }];
          log('#' + job.id + ' ' + job.name + ' — na blat');
        } else {
          log('⚠ blat pełny (brak wip-bad) — kucharz czeka z #' + job.id);
          s.chef = job;
        }
      }
    }
    s.maxWip = Math.max(s.maxWip, s.wip.length);
  }

  // Kucharz nowe zadanie
  if (!s.chef) {
    const queue = s.orders.filter(o => o.status === 'queue');
    // OEE: kucharz startuje gdy całkowity blat < limit (wip-bad też zajmują miejsce — ale można je wypchnąć)
    // Startuje gdy: wip < wipLimit LUB są wip-bad do wypchnięcia
    const normalWip = s.wip.filter(w => w.status === 'wip').length;
    const badWip = s.wip.filter(w => w.status === 'wip-bad').length;
    const canStart = s.wip.length < s.wipLimit || badWip > 0;
    if (s.toc) {
      if (s.oven.some(x => x === null)) {
        const valid = queue.find(o => !o.murphy);
        if (valid) {
          const upd = { ...valid, status: 'prep', prepEnd: s.simTime + s.prepTime };
          s.orders = s.orders.map(o => o.id === valid.id ? upd : o);
          s.chef = upd;
          log('#' + valid.id + ' ' + valid.name + ' — kucharz startuje (TOC)');
        }
      }
    } else if (queue.length > 0 && canStart) {
      const next = queue[0];
      const upd = { ...next, status: 'prep', prepEnd: s.simTime + s.prepTime };
      s.orders = s.orders.map(o => o.id === next.id ? upd : o);
      s.chef = upd;
      log('#' + next.id + ' ' + next.name + (next.murphy ? ' ⚠ (brak skł.)' : '') + ' — kucharz startuje (OEE)');
    }
  }

  s.logs = logs.slice(0, 80);
  return s;
}

function runHourSimulation(baseState) {
  const stock = createStock();
  let s = { ...createState(), toc: baseState.toc, bakeTime: baseState.bakeTime, autoInterval: baseState.autoInterval, auto: true, autoTimer: baseState.autoInterval };
  while (s.simTime < 3600) s = tickState(s, stock);
  const done = s.done.length;
  const onTime = s.done.filter(o => (o.bakeEnd - o.start) <= DEAD).length;
  return {
    mode: s.toc ? 'TOC/DBR (Pull)' : 'OEE MAX (Push)',
    done, otif: done ? Math.round(onTime / done * 100) : 0,
    avgLt: s.leadTimes.length ? Math.round(s.leadTimes.reduce((a, b) => a + b, 0) / s.leadTimes.length) : 0,
    cu: s.totalTime > 0 ? Math.round(s.chefBusyTime / s.totalTime * 100) : 0,
    ou: s.totalTime > 0 ? Math.round(s.ovenBusyTime / (s.totalTime * 2) * 100) : 0,
    maxWip: s.maxWip, waste: s.waste, bakeTime: s.bakeTime, autoInterval: s.autoInterval,
  };
}

// ── KOMPONENTY ─────────────────────────────────────────────────────────────
function OvenSlot({ order, simTime }) {
  if (!order) return <div className="oslot"><div className="oslot-icon">🔥</div><div>wolny</div></div>;
  const rem = Math.max(0, Math.round(order.bakeEnd - simTime));
  return (
    <div className="oslot hot">
      <div className="oslot-id">#{order.id}</div>
      <div className="oslot-name">{order.name.slice(0, 10)}</div>
      <div className="oslot-rem">{fmt(rem)}</div>
    </div>
  );
}

function Scorecard({ state, onClose }) {
  const done = state.done.length;
  const onTime = state.done.filter(o => (o.bakeEnd - o.start) <= DEAD).length;
  const otif = done ? Math.round(onTime / done * 100) : 0;
  const avgLt = state.leadTimes.length ? Math.round(state.leadTimes.reduce((a, b) => a + b, 0) / state.leadTimes.length) : 0;
  const cu = state.totalTime > 0 ? Math.round(state.chefBusyTime / state.totalTime * 100) : 0;
  const ou = state.totalTime > 0 ? Math.round(state.ovenBusyTime / (state.totalTime * 2) * 100) : 0;
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal-box" onClick={e => e.stopPropagation()}>
        <h2>Factory Scorecard</h2>
        <div className="srow"><span>Tryb</span><span className="sv">{state.toc ? 'TOC/DBR' : 'OEE MAX'}</span></div>
        <div className="srow"><span>Ukończone</span><span className="sv">{done}</span></div>
        <div className="srow"><span>OTIF %</span><span className="sv" style={{ color: otif >= 80 ? '#16a34a' : otif >= 60 ? '#d97706' : '#dc2626' }}>{otif}%</span></div>
        <div className="srow"><span>Śr. Lead Time</span><span className="sv">{avgLt ? fmt(avgLt) : '—'}</span></div>
        <div className="srow"><span>OEE Kucharz</span><span className="sv">{cu}%</span></div>
        <div className="srow"><span>OEE Piec</span><span className="sv">{ou}%</span></div>
        <div className="srow"><span>Szczyt WIP</span><span className="sv">{state.maxWip}</span></div>
        <div className="srow"><span>Straty</span><span className="sv" style={{ color: '#dc2626' }}>{state.waste}</span></div>
        <div className="verdict">{state.toc ? 'TOC/DBR: Kucharz odpoczywał, ale system dowoził każdą pizzę na czas. WIP minimalny, OTIF wysoki.' : 'OEE MAX: Kucharz bardzo zajęty, ale produkował chaos — WIP rósł, składniki marnowane, Lead Time się wydłużał.'}</div>
        <div style={{ marginTop: 16, textAlign: 'right' }}><button className="btn" onClick={onClose}>Zamknij</button></div>
      </div>
    </div>
  );
}

function Scorecard1h({ result, onClose }) {
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal-box" onClick={e => e.stopPropagation()}>
        <h2>Raport 1h</h2>
        <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 12 }}>Tryb: <strong>{result.mode}</strong> · Pieczenie: {Math.round(result.bakeTime / 60)}min · co {result.autoInterval}s</div>
        <div className="srow"><span>Pizze ukończone</span><span className="sv">{result.done}</span></div>
        <div className="srow"><span>OTIF %</span><span className="sv" style={{ color: result.otif >= 80 ? '#16a34a' : result.otif >= 60 ? '#d97706' : '#dc2626' }}>{result.otif}%</span></div>
        <div className="srow"><span>Śr. Lead Time</span><span className="sv">{result.avgLt ? fmt(result.avgLt) : '—'}</span></div>
        <div className="srow"><span>OEE Kucharz</span><span className="sv">{result.cu}%</span></div>
        <div className="srow"><span>OEE Piec</span><span className="sv">{result.ou}%</span></div>
        <div className="srow"><span>Szczyt WIP</span><span className="sv">{result.maxWip}</span></div>
        <div className="srow"><span>Straty</span><span className="sv" style={{ color: '#dc2626' }}>{result.waste}</span></div>
        <div className="verdict">{result.mode.includes('TOC') ? 'TOC/DBR: Kucharz odpoczywał, ale system dowoził każdą pizzę na czas. WIP minimalny, OTIF wysoki.' : 'OEE MAX: Kucharz bardzo zajęty, ale produkował chaos — WIP rósł, składniki marnowane.'}</div>
        <div style={{ marginTop: 16, textAlign: 'right' }}><button className="btn" onClick={onClose}>Zamknij</button></div>
      </div>
    </div>
  );
}

// ── BOM TAB ────────────────────────────────────────────────────────────────
function BomTab({ stock, onToggle }) {
  const blockedByIngredient = {};
  INGREDIENTS.forEach(ing => {
    blockedByIngredient[ing] = NAMES.filter(n => BOM[n].includes(ing));
  });

  return (
    <div className="bom-tab">
      <div className="bom-section">
        <h2 className="bom-title">Magazyn składników</h2>
        <p className="bom-desc">Wyłącz składnik aby zasymulować brak. Wszystkie nowe zamówienia wymagające tego składnika zostaną automatycznie oznaczone jako niekompletne.</p>
        <div className="stock-grid">
          {INGREDIENTS.map(ing => {
            const available = stock[ing];
            const affected = blockedByIngredient[ing];
            return (
              <div key={ing} className={`stock-card ${available ? '' : 'stock-out'}`}>
                <div className="stock-card-top">
                  <span className="stock-name">{ing}</span>
                  <label className="sw">
                    <input type="checkbox" checked={available} onChange={() => onToggle(ing)} />
                    <span className="sl" />
                  </label>
                </div>
                <div className="stock-status">{available ? '✓ Dostępny' : '✗ BRAK'}</div>
                <div className="stock-affects">
                  Używany w: {affected.map(n => (
                    <span key={n} className={`pizza-tag ${!available ? 'pizza-tag-blocked' : ''}`}>{n}</span>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="bom-section">
        <h2 className="bom-title">BOM — Bill of Materials</h2>
        <p className="bom-desc">Składniki wymagane do produkcji każdego typu pizzy.</p>
        <div className="bom-table-wrap">
          <table className="bom-table">
            <thead>
              <tr>
                <th>Pizza</th>
                {INGREDIENTS.map(ing => (
                  <th key={ing} className={!stock[ing] ? 'th-blocked' : ''}>{ing}</th>
                ))}
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {NAMES.map(name => {
                const needed = BOM[name];
                const missing = needed.filter(i => !stock[i]);
                const blocked = missing.length > 0;
                return (
                  <tr key={name} className={blocked ? 'tr-blocked' : ''}>
                    <td className="bom-pizza-name">{blocked ? <s>{name}</s> : name}</td>
                    {INGREDIENTS.map(ing => (
                      <td key={ing} className={`bom-cell ${!stock[ing] && needed.includes(ing) ? 'cell-missing' : ''}`}>
                        {needed.includes(ing) ? (stock[ing] ? '✓' : '✗') : '—'}
                      </td>
                    ))}
                    <td>
                      {blocked
                        ? <span className="bom-blocked-badge">Brak: {missing.join(', ')}</span>
                        : <span className="bom-ok-badge">OK</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ── APP ────────────────────────────────────────────────────────────────────
export default function App() {
  const [state, setState] = useState(createState);
  const [stock, setStock] = useState(createStock);
  const [tab, setTab] = useState('sim');
  const [showReport, setShowReport] = useState(false);
  const [report1h, setReport1h] = useState(null);
  const [computing, setComputing] = useState(false);
  const intervalRef = useRef(null);
  const wastePulseTimer = useRef(null);

  const startLoop = useCallback((speed) => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    const ms = 50; // stały interwał 50ms
    const ticksPerInterval = Math.max(1, Math.round(speed / 20)); // ile ticków na interwał
    intervalRef.current = setInterval(() => {
      setState(prev => {
        let s = prev;
        for (let i = 0; i < ticksPerInterval; i++) {
          s = tickState(s, stock);
        }
        return s;
      });
    }, ms);
  }, [stock]);

  const stopLoop = useCallback(() => {
    if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
  }, []);

  useEffect(() => () => stopLoop(), [stopLoop]);

  // Re-check orders when stock changes
  useEffect(() => {
    setState(prev => ({
      ...prev,
      orders: prev.orders.map(o => {
        if (o.status !== 'queue') return o;
        const { murphy, missing } = checkMurphy(o.name, stock);
        return { ...o, murphy, missing };
      }),
    }));
    if (state.running) startLoop(state.speed);
  }, [stock]);

  // Clear waste pulse
  useEffect(() => {
    if (state.wastePulse) {
      if (wastePulseTimer.current) clearTimeout(wastePulseTimer.current);
      wastePulseTimer.current = setTimeout(() => {
        setState(prev => ({ ...prev, wastePulse: false }));
      }, 1500);
    }
  }, [state.wastePulse]);

  function handleStart() {
    setState(prev => {
      const running = !prev.running;
      if (running) startLoop(prev.speed); else stopLoop();
      return { ...prev, running };
    });
  }

  function handleSpeed(e) {
    const speed = parseInt(e.target.value);
    setState(prev => { if (prev.running) startLoop(speed); return { ...prev, speed }; });
  }

  function handleMode(e) {
    const toc = e.target.checked;
    setState(prev => ({ ...prev, toc, logs: [{ t: fmt(prev.simTime), msg: 'Tryb: ' + (toc ? 'TOC/DBR' : 'OEE MAX') }, ...prev.logs].slice(0, 80) }));
  }

  function handleAuto() {
    setState(prev => {
      const auto = !prev.auto;
      return { ...prev, auto, autoTimer: auto ? prev.autoInterval : 0, logs: [{ t: fmt(prev.simTime), msg: 'Auto: ' + (auto ? 'WŁ' : 'WYŁ') }, ...prev.logs].slice(0, 80) };
    });
  }

  function handleAddOrder() {
    setState(prev => {
      const name = NAMES[rnd(0, NAMES.length - 1)];
      const { murphy, missing } = checkMurphy(name, stock);
      const o = { id: prev.nextId, name, start: prev.simTime, murphy, missing, status: 'queue', prepEnd: 0, bakeEnd: 0 };
      return { ...prev, nextId: prev.nextId + 1, orders: [...prev.orders, o], logs: [{ t: fmt(prev.simTime), msg: '#' + o.id + ' ' + o.name + (murphy ? ' ⚠ brak: ' + missing.join(', ') : '') }, ...prev.logs].slice(0, 80) };
    });
  }

  function handleMurphy() {
    setState(prev => {
      const q = prev.orders.filter(o => o.status === 'queue' && !o.murphy);
      if (!q.length) return { ...prev, logs: [{ t: fmt(prev.simTime), msg: 'Brak zamówień do zablokowania!' }, ...prev.logs].slice(0, 80) };
      const target = q[rnd(0, q.length - 1)];
      const missing = [INGREDIENTS[rnd(0, INGREDIENTS.length - 1)]];
      return { ...prev, orders: prev.orders.map(o => o.id === target.id ? { ...o, murphy: true, missing } : o), logs: [{ t: fmt(prev.simTime), msg: 'Murphy! #' + target.id + ' brak: ' + missing.join(', ') }, ...prev.logs].slice(0, 80) };
    });
  }

  function handleReset() { stopLoop(); setState(createState()); setShowReport(false); setReport1h(null); }

  function handle1h() {
    setComputing(true);
    setTimeout(() => { setReport1h(runHourSimulation(state)); setComputing(false); }, 50);
  }

  function toggleStock(ing) {
    setStock(prev => ({ ...prev, [ing]: !prev[ing] }));
  }

  const { simTime, toc, auto, speed, wipLimit, bakeTime, prepTime, autoInterval, running, orders, wip, oven, done, chef, waste, leadTimes, chefBusyTime, totalTime, ovenBusyTime, logs, wastePulse, wasteList = [] } = state;
  const queue = orders.filter(o => o.status === 'queue');
  const wipBad = wip.filter(w => w.status === 'wip-bad');
  const doneRecent = done.slice(-4).reverse();
  const doneCnt = done.length;
  const onTimeCnt = done.filter(o => (o.bakeEnd - o.start) <= DEAD).length;
  // OTIF: mianownik = ukończone + straty (waste = zamówienia niewykonane)
  const totalOrders = doneCnt + waste;
  const otif = totalOrders > 0 ? Math.round(onTimeCnt / totalOrders * 100) : null;
  const avgLt = leadTimes.length ? Math.round(leadTimes.reduce((a, b) => a + b, 0) / leadTimes.length) : null;
  const cu = totalTime > 0 ? Math.round(chefBusyTime / totalTime * 100) : 0;
  const ou = totalTime > 0 ? Math.round(ovenBusyTime / (totalTime * 2) * 100) : 0;
  const ovenHasFreeSlot = oven.some(x => x === null);
  const blockedInQueue = queue.filter(o => o.murphy).length;
  const stockOut = INGREDIENTS.filter(i => !stock[i]);

  return (
    <div className="app">
      {/* ZEGAR */}
      <div className="sim-clock">
        <span className="sim-clock-icon">{running ? '▶' : '⏸'}</span>
        <span className="sim-clock-time">{fmt(simTime)}</span>
        <span className="sim-clock-label">czas symulacji</span>
      </div>

      {/* TOP BAR */}
      <div className="top-bar">
        <h1>TOC-Pizza</h1>
        <div className="divider" />
        <div className="switch-wrap">
          <span className="mode-lbl oee" style={{ opacity: toc ? 0.4 : 1 }}>OEE</span>
          <label className="sw"><input type="checkbox" checked={toc} onChange={handleMode} /><span className="sl" /></label>
          <span className="mode-lbl toc" style={{ opacity: toc ? 1 : 0.4 }}>TOC</span>
        </div>
        <div className="divider" />
        <div className="ctrl-group">Tempo: <span className="ctrl-val">{speed}x</span><input type="range" min="1" max="1500" step="1" value={speed} onChange={handleSpeed} /></div>
        <div className="ctrl-group">Blat: <span className="ctrl-val">{wipLimit}</span><input type="range" min="0" max="30" step="1" value={wipLimit} onChange={e => setState(prev => ({ ...prev, wipLimit: parseInt(e.target.value) }))} /></div>
        <div className="divider" />
        <button className={`btn ${auto ? 'active' : ''}`} onClick={handleAuto}>Auto: {auto ? 'WŁ' : 'WYŁ'}</button>
        <div className="ctrl-group">co <span className="ctrl-val">{autoInterval}s</span><input type="range" min="5" max="180" step="5" value={autoInterval} onChange={e => setState(prev => ({ ...prev, autoInterval: parseInt(e.target.value), autoTimer: parseInt(e.target.value) }))} /></div>
        <div className="divider" />
        <button className="btn mur" onClick={handleMurphy}>Murphy!</button>
        <button className="btn" onClick={handleAddOrder}>+ Zamówienie</button>
        <button className={`btn ${running ? 'pause' : 'go'}`} onClick={handleStart}>{running ? '⏸ Pauza' : '▶ Start'}</button>
        <button className="btn" onClick={() => setShowReport(true)}>Raport</button>
        <button className="btn" onClick={handle1h} disabled={computing} style={{ borderColor: '#6366f1', color: '#6366f1' }}>{computing ? '⏳...' : 'Raport 1h'}</button>
        <button className="btn reset" onClick={handleReset}>Reset</button>
      </div>

      {/* TABS */}
      <div className="tabs">
        <button className={`tab-btn ${tab === 'sim' ? 'tab-active' : ''}`} onClick={() => setTab('sim')}>Symulacja</button>
        <button className={`tab-btn ${tab === 'bom' ? 'tab-active' : ''}`} onClick={() => setTab('bom')}>
          BOM / Magazyn
          {stockOut.length > 0 && <span className="tab-badge-warn">{stockOut.length} brak</span>}
        </button>
      </div>

      {tab === 'bom' && <BomTab stock={stock} onToggle={toggleStock} />}

      {tab === 'sim' && <>
        {/* MAGAZYN — szybkie przełączniki */}
        <div className="stock-bar">
          <span className="stock-bar-label">Magazyn:</span>
          {INGREDIENTS.map(ing => (
            <button
              key={ing}
              className={`stock-toggle ${stock[ing] ? 'stock-toggle-on' : 'stock-toggle-off'}`}
              onClick={() => toggleStock(ing)}
              title={stock[ing] ? `${ing} — dostępny (kliknij aby wyłączyć)` : `${ing} — BRAK (kliknij aby przywrócić)`}
            >
              <span className="stock-toggle-dot" />
              {ing}
            </button>
          ))}
          {stockOut.length > 0 && (
            <span className="stock-bar-blocked">{blockedInQueue > 0 ? `⚠ ${blockedInQueue} zamówień zablokowanych` : `⚠ brak w magazynie`}</span>
          )}
        </div>

        {/* KPI */}
        <div className="kpi-row">
          <div className="kpi"><div className="kpi-l">Ukończone</div><div className="kpi-v">{doneCnt}</div></div>
          <div className="kpi"><div className="kpi-l">OTIF %</div><div className="kpi-v" style={{ color: otif !== null ? (otif >= 80 ? '#16a34a' : otif >= 60 ? '#d97706' : '#dc2626') : '#1a1d23' }}>{otif !== null ? otif + '%' : '—'}</div></div>
          <div className="kpi"><div className="kpi-l">Lead Time</div><div className="kpi-v">{avgLt ? fmt(avgLt) : '—'}</div></div>
          <div className="kpi"><div className="kpi-l">OEE Kucharz</div><div className="kpi-v">{cu}%</div></div>
          <div className="kpi"><div className="kpi-l">OEE Piec</div><div className="kpi-v">{ou}%</div></div>
          <div className="kpi"><div className="kpi-l">WIP (blat)</div><div className="kpi-v" style={{ color: wip.length > 5 ? '#dc2626' : '#1a1d23' }}>{wip.length}</div></div>
          <div className="kpi"><div className="kpi-l">🗑 Straty</div>
            <div className={`kpi-v waste ${wastePulse ? 'waste-pulse' : ''}`}>{waste}</div>
            {waste > 0 && <div className="kpi-sub">{fmt(waste * prepTime)} robocizny</div>}
          </div>
        </div>

        {/* SIM GRID */}
        <div className="sim-grid">
          {/* KOLEJKA */}
          <div className="station">
            <div className="station-header">
              <span className="station-title">📋 Zamówienia</span>
              <div style={{ display: 'flex', gap: 4 }}>
                {blockedInQueue > 0 && <span className="station-badge warn">⚠ {blockedInQueue}</span>}
                <span className="station-badge">{orders.filter(o => o.status !== 'done').length}</span>
              </div>
            </div>
            <div className="order-list">
              {orders.filter(o => o.status !== 'done').length ? (
                orders.filter(o => o.status !== 'done').map(o => {
                  const pct = Math.min(120, ((simTime - o.start) / DEAD) * 100);
                  const col = bufColor(pct);
                  const statusLabel = { queue: 'Kolejka', prep: 'Przygot.', wip: 'Blat', 'wip-bad': 'Strata', oven: 'Piec' }[o.status] || o.status;
                  const statusColor = { queue: '#6b7280', prep: '#2563eb', wip: '#d97706', 'wip-bad': '#dc2626', oven: '#ea580c' }[o.status] || '#6b7280';
                  return (
                    <div key={o.id} className={`ocard ${o.murphy && o.status === 'queue' ? 'ocard-blocked' : ''} ${o.status === 'wip-bad' ? 'ocard-waste' : ''}`}>
                      <div className="ocard-top">
                        <span className="oid">#{o.id}</span>
                        <span className="oname" style={{ textDecoration: o.murphy ? 'line-through' : 'none', fontStyle: o.murphy ? 'italic' : 'normal' }}>{o.name}</span>
                        {o.murphy && <span className="waste-x">✕</span>}
                        <span style={{ fontSize: 9, fontWeight: 700, color: statusColor, background: statusColor + '18', padding: '1px 5px', borderRadius: 4, whiteSpace: 'nowrap' }}>{statusLabel}</span>
                      </div>
                      {o.murphy && o.missing?.length > 0 && (
                        <div className="missing-label">brak: {o.missing.join(', ')}</div>
                      )}
                      <div className="bbar"><div className="bfill" style={{ width: Math.min(100, pct) + '%', background: col }} /></div>
                      <div className="bpct" style={{ color: col, fontWeight: pct > 66 ? 700 : 500 }}>{Math.round(pct)}%{pct > 100 ? ' — SPÓŹNIONE' : pct > 66 ? ' — PILNE' : ''}</div>
                    </div>
                  );
                })
              ) : <div className="empty">Brak aktywnych zamówień</div>}
            </div>
          </div>

          {/* SYGNAŁ BLAT → kucharz */}
          <div className="arrow-col">
            <div className="rope-signal">
              {wip.length < wipLimit ? (
                <><div className="rs-label" style={{color: toc ? '#2563eb' : '#e85d2f'}}>{toc ? 'WIP OK' : 'PUSH'}</div><div className="rs-arrows"><span className="rs-arr rs-arr-r rs-arr-1">→</span><span className="rs-arr rs-arr-r rs-arr-2">→</span><span className="rs-arr rs-arr-r rs-arr-3">→</span></div><div className="rs-sublabel">blat wolny</div></>
              ) : (
                <><div className="rs-label rs-label-off">BLAT PEŁNY</div><div className="rs-arrows rs-off"><span className="rs-arr">→</span><span className="rs-arr">→</span><span className="rs-arr">→</span></div><div className="rs-sublabel rs-sublabel-off">stop</div></>
              )}
            </div>
          </div>

          {/* KUCHARZ */}
          <div className="station">
            <div className="station-header">
              <span className="station-title">👨‍🍳 Kucharz</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div className="oee-gauge">
                  <svg width="36" height="36" viewBox="0 0 36 36">
                    <circle cx="18" cy="18" r="14" fill="none" stroke="#e5e7eb" strokeWidth="4"/>
                    <circle cx="18" cy="18" r="14" fill="none" stroke={cu >= 80 ? '#16a34a' : cu >= 50 ? '#d97706' : '#dc2626'} strokeWidth="4" strokeDasharray={`${(cu / 100) * 87.96} 87.96`} strokeLinecap="round" transform="rotate(-90 18 18)" style={{ transition: 'stroke-dasharray 0.5s' }}/>
                    <text x="18" y="22" textAnchor="middle" fontSize="9" fontWeight="700" fill={cu >= 80 ? '#16a34a' : cu >= 50 ? '#d97706' : '#dc2626'}>{cu}%</text>
                  </svg>
                  <span className="oee-lbl">OEE</span>
                </div>
                <span className={`station-badge ${chef ? (chef.murphy ? 'warn' : 'ok') : ''}`}>{chef ? (chef.murphy ? '⚠ Strata!' : 'Pracuje') : 'Czeka'}</span>
              </div>
            </div>

            <div className="oven-ctrl">
              <span>Czas przygotowania</span>
              <input type="range" min="0" max="10" step="1"
                value={Math.round(prepTime / 60)}
                onChange={e => setState(prev => ({ ...prev, prepTime: parseInt(e.target.value) * 60 }))} />
              <span className="oven-ctrl-val">{Math.round(prepTime / 60)} min</span>
            </div>

            {chef ? (
              <div className={`chef-card ${chef.murphy ? 'chef-card-waste' : ''}`}>
                <div className="ocard-top">
                  <span className="oid">#{chef.id}</span>
                  <span className="oname" style={{ textDecoration: chef.murphy ? 'line-through' : 'none', fontStyle: chef.murphy ? 'italic' : 'normal' }}>{chef.name}</span>
                  {chef.murphy && <span className="waste-x">✕</span>}
                </div>
                {chef.murphy && <div className="waste-warn-msg">⚠ Zmarnowana robocizna! Brak: {(chef.missing || []).join(', ')}</div>}
                <div className="bbar"><div className="bfill" style={{ width: Math.round(Math.min(100, (1 - Math.max(0, chef.prepEnd - simTime) / prepTime) * 100)) + '%', background: chef.murphy ? '#dc2626' : '#2563eb' }} /></div>
                <div className="bpct" style={{ color: chef.murphy ? '#dc2626' : '#2563eb' }}>Prep: {fmt(Math.max(0, chef.prepEnd - simTime))}</div>
              </div>
            ) : (
              <div className="empty" style={{ paddingBottom: 16 }}>{toc ? 'Czeka na sygnał liny...' : 'Czeka na zamówienie...'}</div>
            )}

            <div className="wip-section">
              <div className="wip-label">
                <span>Blat ({wip.length}/{wipLimit})</span>
                {wipBad.length > 0 && <span className="wip-count">⚠ {wipBad.length} czeka na dostawę</span>}
              </div>
              <div className="wip-zone">
                {wip.length
                  ? wip.slice(0, wipLimit).map((w, idx) => (
                      <div key={w.id} className={`wip-tile ${w.status === 'wip-bad' ? 'wip-tile-bad' : 'wip-tile-ok'}`}
                        title={`#${w.id} ${w.name}${w.status === 'wip-bad' ? ' — czeka na: ' + (w.missing||[]).join(', ') : ''}`}>
                        <span className="wip-tile-icon">{w.status === 'wip-bad' ? '🍕' : '🍕'}</span>
                        <span className="wip-tile-id">#{w.id}</span>
                        {w.status === 'wip-bad' && <span className="wip-tile-missing">{(w.missing||[]).join(',')}</span>}
                      </div>
                    ))
                  : <span className="empty">pusty</span>}
                {wip.length > wipLimit && <span className="wip-overflow">+{wip.length - wipLimit}</span>}
              </div>

              {/* ZMARNOWANE — pizze które wypadły z blatu */}
              {wasteList.length > 0 && (
                <div className="waste-section">
                  <div className="waste-title">🗑 Zmarnowane ({wasteList.length})</div>
                  <div className="waste-list">
                    {wasteList.slice(0, 8).map((w, i) => (
                      <div key={i} className="waste-item">
                        <span className="waste-x">✕</span>
                        <span style={{ textDecoration: 'line-through', fontStyle: 'italic', fontSize: 11, color: '#9ca3af' }}>#{w.id} {w.name}</span>
                        <span className="waste-missing">brak: {(w.missing || []).join(', ')}</span>
                        <span style={{ fontSize: 9, color: '#d1d5db', marginLeft: 'auto' }}>{fmt(w.wastedAt)}</span>
                      </div>
                    ))}
                    {wasteList.length > 8 && <div className="empty">+{wasteList.length - 8} więcej</div>}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* SYGNAŁ PULL — piec → kucharz (tylko TOC) */}
          <div className="arrow-col">
            {toc ? (
              <div className="rope-signal">
                {ovenHasFreeSlot ? (
                  <><div className="rs-label">PULL</div><div className="rs-arrows"><span className="rs-arr rs-arr-1">←</span><span className="rs-arr rs-arr-2">←</span><span className="rs-arr rs-arr-3">←</span></div><div className="rs-sublabel">wolny slot</div></>
                ) : (
                  <><div className="rs-label rs-label-off">WAIT</div><div className="rs-arrows rs-off"><span className="rs-arr">←</span><span className="rs-arr">←</span><span className="rs-arr">←</span></div><div className="rs-sublabel rs-sublabel-off">piec pełny</div></>
                )}
              </div>
            ) : (
              <div className="rope-arrow" style={{ opacity: 0.15, fontSize: 20 }}>→</div>
            )}
          </div>

          {/* PIEC */}
          <div className="station">
            <div className="station-header">
              <span className="station-title">🔥 Piec</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div className="oee-gauge">
                  <svg width="36" height="36" viewBox="0 0 36 36">
                    <circle cx="18" cy="18" r="14" fill="none" stroke="#e5e7eb" strokeWidth="4"/>
                    <circle cx="18" cy="18" r="14" fill="none" stroke={ou >= 80 ? '#16a34a' : ou >= 50 ? '#d97706' : '#dc2626'} strokeWidth="4" strokeDasharray={`${(ou / 100) * 87.96} 87.96`} strokeLinecap="round" transform="rotate(-90 18 18)" style={{ transition: 'stroke-dasharray 0.5s' }}/>
                    <text x="18" y="22" textAnchor="middle" fontSize="9" fontWeight="700" fill={ou >= 80 ? '#16a34a' : ou >= 50 ? '#d97706' : '#dc2626'}>{ou}%</text>
                  </svg>
                  <span className="oee-lbl">OEE</span>
                </div>
                <span className={`station-badge ${oven.some(x => x !== null) ? 'ok' : ''}`}>{oven.filter(x => x !== null).length}/2 slotów</span>
              </div>
            </div>
            <div className="oven-ctrl">
              <span>Czas pieczenia</span>
              <input type="range" min="0" max="10" step="1" value={Math.round(bakeTime / 60)} onChange={e => setState(prev => ({ ...prev, bakeTime: parseInt(e.target.value) * 60 }))} />
              <span className="oven-ctrl-val">{Math.round(bakeTime / 60)} min</span>
            </div>
            <div className="oven-slots">
              <OvenSlot order={oven[0]} simTime={simTime} />
              <OvenSlot order={oven[1]} simTime={simTime} />
            </div>
            <div className="done-label">Ostatnio wydane</div>
            <div className="order-list">
              {doneRecent.length ? doneRecent.map(o => {
                const lt = o.bakeEnd - o.start;
                const ok = lt <= DEAD;
                return (
                  <div key={o.id} className="ocard" style={{ borderColor: ok ? '#86efac' : '#fca5a5', background: ok ? '#f0fdf4' : '#fef2f2' }}>
                    <div className="ocard-top">
                      <span className="oid">#{o.id}</span>
                      <span className="oname">{o.name}</span>
                      <span style={{ fontSize: 10, fontWeight: 600, color: ok ? '#16a34a' : '#dc2626' }}>{ok ? '✓ OK' : '✗ LATE'}</span>
                    </div>
                    <div className="bpct">Lead time: {fmt(lt)}</div>
                  </div>
                );
              }) : <div className="empty">Brak</div>}
            </div>
          </div>
        </div>

        {/* LOG */}
        <div className="log-box">
          <div className="log-title">Log zdarzeń</div>
          <div>{logs.slice(0, 15).map((l, i) => (
            <div key={i} className={`le ${l.msg.includes('STRATA') ? 'le-waste' : ''}`}><span className="ts">[{l.t}]</span>{l.msg}</div>
          ))}</div>
        </div>
      </>}

      {showReport && <Scorecard state={state} onClose={() => setShowReport(false)} />}
      {report1h && <Scorecard1h result={report1h} onClose={() => setReport1h(null)} />}
    </div>
  );
}
