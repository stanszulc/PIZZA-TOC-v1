import { useState, useEffect, useRef, useCallback } from 'react';
import './App.css';

// ── STAŁE ──────────────────────────────────────────────────────────────────
const PREP = 60;
const DEAD = 1200;
const NAMES = ["Margherita","Pepperoni","Diavola","Quattro St.","Capricciosa","Prosciutto","Funghi"];

// ── HELPERS ────────────────────────────────────────────────────────────────
function rnd(a, b) { return Math.floor(Math.random() * (b - a + 1)) + a; }
function fmt(s) {
  s = Math.round(s);
  return s < 60 ? s + 's' : Math.floor(s / 60) + 'm' + (s % 60 ? ' ' + (s % 60) + 's' : '');
}
function bufColor(pct) {
  if (pct > 100) return '#111827'; // Czarny — Spóźnione
  if (pct > 66)  return '#dc2626'; // Czerwony
  if (pct > 33)  return '#d97706'; // Żółty
  return '#16a34a';                // Zielony
}

// ── STAN ───────────────────────────────────────────────────────────────────
function createState() {
  return {
    running: false, toc: false, auto: true,
    speed: 1, wipLimit: 20, bakeTime: 300, autoInterval: 120,
    simTime: 0, nextId: 1,
    orders: [], wip: [], oven: [null, null], done: [],
    chef: null,
    chefBusyTime: 0, ovenBusyTime: 0, totalTime: 0,
    waste: 0, maxWip: 0, leadTimes: [],
    autoTimer: 120, logs: [],
  };
}

// ── SILNIK ─────────────────────────────────────────────────────────────────
function tickState(s) {
  s = { ...s, oven: [...s.oven], wip: [...s.wip], orders: [...s.orders], done: [...s.done], leadTimes: [...s.leadTimes] };
  const logs = [...s.logs];
  const log = (msg) => logs.unshift({ t: fmt(s.simTime), msg });

  s.simTime += 1;
  s.totalTime += 1;
  if (s.chef) s.chefBusyTime += 1;
  s.oven.forEach(slot => { if (slot) s.ovenBusyTime += 1; });

  if (s.auto) {
    s.autoTimer -= 1;
    if (s.autoTimer <= 0) {
      const o = { id: s.nextId++, name: NAMES[rnd(0, NAMES.length - 1)], start: s.simTime, murphy: false, status: 'queue', prepEnd: 0, bakeEnd: 0 };
      s.orders = [...s.orders, o];
      s.autoTimer = s.autoInterval;
      log('#' + o.id + ' ' + o.name + ' — auto zamówienie');
    }
  }

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

  if (s.chef && s.simTime >= s.chef.prepEnd) {
    const job = { ...s.chef };
    s.chef = null;
    if (job.murphy && !s.toc) {
      s.wip = [...s.wip, { ...job, status: 'wip-bad' }];
      s.waste++;
      log('#' + job.id + ' — brak składnika, pizza utknęła (waste)!');
    } else {
      const fi = s.oven.findIndex(x => x === null);
      if (fi >= 0) {
        s.oven = s.oven.map((o, i) => i === fi ? { ...job, status: 'oven', bakeEnd: s.simTime + s.bakeTime } : o);
        log('#' + job.id + ' ' + job.name + ' — do pieca (slot ' + (fi + 1) + ')');
      } else {
        s.wip = [...s.wip, { ...job, status: 'wip' }];
        log('#' + job.id + ' ' + job.name + ' — czeka na blacie (WIP)');
      }
    }
    s.maxWip = Math.max(s.maxWip, s.wip.length);
  }

  if (!s.chef) {
    const fi = s.oven.findIndex(x => x === null);
    const ready = s.wip.find(w => w.status === 'wip');
    if (ready && fi >= 0) {
      s.wip = s.wip.filter(w => w.id !== ready.id);
      s.oven = s.oven.map((o, i) => i === fi ? { ...ready, status: 'oven', bakeEnd: s.simTime + s.bakeTime } : o);
      log('#' + ready.id + ' z blatu do pieca (slot ' + (fi + 1) + ')');
    }
  }

  if (!s.chef) {
    const queue = s.orders.filter(o => o.status === 'queue');
    if (s.toc) {
      if (s.oven.some(x => x === null)) {
        const valid = queue.find(o => !o.murphy);
        if (valid) {
          const upd = { ...valid, status: 'prep', prepEnd: s.simTime + PREP };
          s.orders = s.orders.map(o => o.id === valid.id ? upd : o);
          s.chef = upd;
          log('#' + valid.id + ' ' + valid.name + ' — kucharz startuje (TOC/lina)');
        }
      }
    } else if (queue.length > 0) {
      const next = queue[0];
      const upd = { ...next, status: 'prep', prepEnd: s.simTime + PREP };
      s.orders = s.orders.map(o => o.id === next.id ? upd : o);
      s.chef = upd;
      log('#' + next.id + ' ' + next.name + ' — kucharz startuje (OEE/push)');
    }
  }

  s.logs = logs.slice(0, 80);
  return s;
}

// ── SYMULACJA 1H W TLE ─────────────────────────────────────────────────────
function runHourSimulation(baseState) {
  let s = {
    ...createState(),
    toc: baseState.toc,
    bakeTime: baseState.bakeTime,
    autoInterval: baseState.autoInterval,
    auto: true,
    autoTimer: baseState.autoInterval,
  };
  const TARGET = 3600;
  while (s.simTime < TARGET) {
    s = tickState(s);
  }
  const done = s.done.length;
  const onTime = s.done.filter(o => (o.bakeEnd - o.start) <= DEAD).length;
  return {
    mode: s.toc ? 'TOC/DBR (Pull)' : 'OEE MAX (Push)',
    done,
    otif: done ? Math.round(onTime / done * 100) : 0,
    avgLt: s.leadTimes.length ? Math.round(s.leadTimes.reduce((a, b) => a + b, 0) / s.leadTimes.length) : 0,
    cu: s.totalTime > 0 ? Math.round(s.chefBusyTime / s.totalTime * 100) : 0,
    ou: s.totalTime > 0 ? Math.round(s.ovenBusyTime / (s.totalTime * 2) * 100) : 0,
    maxWip: s.maxWip,
    waste: s.waste,
    bakeTime: s.bakeTime,
    autoInterval: s.autoInterval,
  };
}

// ── KOMPONENTY ─────────────────────────────────────────────────────────────
function OrderCard({ order, simTime }) {
  const pct = Math.min(120, ((simTime - order.start) / DEAD) * 100);
  const col = bufColor(pct);
  return (
    <div className="ocard">
      <div className="ocard-top">
        <span className="oid">#{order.id}</span>
        <span className="oname">{order.name}</span>
        {order.murphy && <span className="warn">⚠</span>}
      </div>
      <div className="bbar"><div className="bfill" style={{ width: Math.min(100, pct) + '%', background: col }} /></div>
      <div className="bpct" style={{ color: col }}>{Math.round(pct)}%{pct > 100 ? ' — SPÓŹNIONE' : ''}</div>
    </div>
  );
}

function OvenSlot({ order, simTime }) {
  if (!order) return (
    <div className="oslot">
      <div className="oslot-icon">🔥</div>
      <div>wolny</div>
    </div>
  );
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
        <div className="srow"><span>Tryb</span><span className="sv">{state.toc ? 'TOC/DBR (Pull)' : 'OEE MAX (Push)'}</span></div>
        <div className="srow"><span>Ukończone</span><span className="sv">{done}</span></div>
        <div className="srow"><span>OTIF %</span><span className="sv">{otif}%</span></div>
        <div className="srow"><span>Śr. Lead Time</span><span className="sv">{avgLt ? fmt(avgLt) : '—'}</span></div>
        <div className="srow"><span>OEE Kucharz</span><span className="sv">{cu}%</span></div>
        <div className="srow"><span>OEE Piec</span><span className="sv">{ou}%</span></div>
        <div className="srow"><span>Szczyt WIP</span><span className="sv">{state.maxWip}</span></div>
        <div className="srow"><span>Straty</span><span className="sv" style={{ color: '#dc2626' }}>{state.waste}</span></div>
        <div className="verdict">
          {state.toc
            ? 'TOC/DBR: Kucharz odpoczywał, ale system dowoził każdą pizzę na czas dzięki synchronizacji z piecem. Piec pracował optymalnie, WIP minimalny, OTIF wysoki.'
            : 'OEE MAX: Kucharz był bardzo zajęty, ale produkował chaos — WIP rósł, składniki marnowane, Lead Time się wydłużał. Lokalny optymum ≠ globalny optymum.'}
        </div>
        <div style={{ marginTop: 16, textAlign: 'right' }}>
          <button className="btn" onClick={onClose}>Zamknij</button>
        </div>
      </div>
    </div>
  );
}

function Scorecard1h({ result, onClose }) {
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal-box" onClick={e => e.stopPropagation()}>
        <h2>Raport 1h — symulacja</h2>
        <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 12 }}>
          Tryb: <strong>{result.mode}</strong> · Pieczenie: {Math.round(result.bakeTime / 60)}min · Zamówienie co {result.autoInterval}s
        </div>
        <div className="srow"><span>Pizze ukończone</span><span className="sv">{result.done}</span></div>
        <div className="srow"><span>OTIF %</span>
          <span className="sv" style={{ color: result.otif >= 80 ? '#16a34a' : result.otif >= 60 ? '#d97706' : '#dc2626' }}>{result.otif}%</span>
        </div>
        <div className="srow"><span>Śr. Lead Time</span><span className="sv">{result.avgLt ? fmt(result.avgLt) : '—'}</span></div>
        <div className="srow"><span>OEE Kucharz</span><span className="sv">{result.cu}%</span></div>
        <div className="srow"><span>OEE Piec</span><span className="sv">{result.ou}%</span></div>
        <div className="srow"><span>Szczyt WIP</span><span className="sv">{result.maxWip}</span></div>
        <div className="srow"><span>Straty (waste)</span><span className="sv" style={{ color: '#dc2626' }}>{result.waste}</span></div>
        <div className="verdict">
          {result.mode.includes('TOC')
            ? 'TOC/DBR: Kucharz odpoczywał, ale system dowoził każdą pizzę na czas dzięki synchronizacji z piecem. WIP minimalny, OTIF wysoki.'
            : 'OEE MAX: Kucharz był bardzo zajęty, ale produkował chaos — WIP rósł, składniki marnowane, Lead Time się wydłużał. Lokalny optymum ≠ globalny optymum.'}
        </div>
        <div style={{ marginTop: 16, textAlign: 'right' }}>
          <button className="btn" onClick={onClose}>Zamknij</button>
        </div>
      </div>
    </div>
  );
}
export default function App() {
  const [state, setState] = useState(createState);
  const [showReport, setShowReport] = useState(false);
  const [report1h, setReport1h] = useState(null);
  const [computing, setComputing] = useState(false);
  const intervalRef = useRef(null);

  const startLoop = useCallback((speed) => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    intervalRef.current = setInterval(() => setState(prev => tickState(prev)), Math.max(50, Math.round(1000 / speed)));
  }, []);

  const stopLoop = useCallback(() => {
    if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
  }, []);

  useEffect(() => () => stopLoop(), [stopLoop]);

  const set = (key, val) => setState(prev => ({ ...prev, [key]: val }));

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
      const o = { id: prev.nextId, name: NAMES[rnd(0, NAMES.length - 1)], start: prev.simTime, murphy: false, status: 'queue', prepEnd: 0, bakeEnd: 0 };
      return { ...prev, nextId: prev.nextId + 1, orders: [...prev.orders, o], logs: [{ t: fmt(prev.simTime), msg: '#' + o.id + ' ' + o.name + ' — zamówienie' }, ...prev.logs].slice(0, 80) };
    });
  }

  function handleMurphy() {
    setState(prev => {
      const q = prev.orders.filter(o => o.status === 'queue');
      if (!q.length) return { ...prev, logs: [{ t: fmt(prev.simTime), msg: 'Brak zamówień!' }, ...prev.logs].slice(0, 80) };
      const target = q[rnd(0, q.length - 1)];
      return { ...prev, orders: prev.orders.map(o => o.id === target.id ? { ...o, murphy: true } : o), logs: [{ t: fmt(prev.simTime), msg: 'Murphy! #' + target.id + ' — brak składnika' }, ...prev.logs].slice(0, 80) };
    });
  }

  function handleReset() { stopLoop(); setState(createState()); setShowReport(false); setReport1h(null); }

  function handle1h() {
    setComputing(true);
    setTimeout(() => {
      const result = runHourSimulation(state);
      setReport1h(result);
      setComputing(false);
    }, 50);
  }

  const { simTime, toc, auto, speed, wipLimit, bakeTime, autoInterval, running, orders, wip, oven, done, chef, waste, leadTimes, chefBusyTime, totalTime, ovenBusyTime, logs } = state;
  const queue = orders.filter(o => o.status === 'queue');
  const doneRecent = done.slice(-4).reverse();
  const doneCnt = done.length;
  const onTimeCnt = done.filter(o => (o.bakeEnd - o.start) <= DEAD).length;
  const otif = doneCnt ? Math.round(onTimeCnt / doneCnt * 100) : null;
  const avgLt = leadTimes.length ? Math.round(leadTimes.reduce((a, b) => a + b, 0) / leadTimes.length) : null;
  const cu = totalTime > 0 ? Math.round(chefBusyTime / totalTime * 100) : 0;
  const ou = totalTime > 0 ? Math.round(ovenBusyTime / (totalTime * 2) * 100) : 0;
  const ropeActive = toc && oven.some(x => x === null) && !chef;
  const ovenHasFreeSlot = oven.some(x => x === null);

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
        <div className="ctrl-group">
          Tempo: <span className="ctrl-val">{speed}x</span>
          <input type="range" min="1" max="500" step="1" value={speed} onChange={handleSpeed} />
        </div>
        <div className="ctrl-group">
          Blat: <span className="ctrl-val">{wipLimit}</span>
          <input type="range" min="0" max="30" step="1" value={wipLimit} onChange={e => set('wipLimit', parseInt(e.target.value))} />
        </div>
        <div className="divider" />
        <button className={`btn ${auto ? 'active' : ''}`} onClick={handleAuto}>Auto: {auto ? 'WŁ' : 'WYŁ'}</button>
        <div className="ctrl-group">
          co <span className="ctrl-val">{autoInterval}s</span>
          <input type="range" min="5" max="180" step="5" value={autoInterval} onChange={e => setState(prev => ({ ...prev, autoInterval: parseInt(e.target.value), autoTimer: parseInt(e.target.value) }))} />
        </div>
        <div className="divider" />
        <button className="btn mur" onClick={handleMurphy}>Murphy!</button>
        <button className="btn" onClick={handleAddOrder}>+ Zamówienie</button>
        <button className={`btn ${running ? 'pause' : 'go'}`} onClick={handleStart}>{running ? '⏸ Pauza' : '▶ Start'}</button>
        <button className="btn" onClick={() => setShowReport(true)}>Raport</button>
        <button className="btn" onClick={handle1h} disabled={computing} style={{ borderColor: '#6366f1', color: '#6366f1' }}>
          {computing ? '⏳ Liczę...' : 'Raport 1h'}
        </button>
        <button className="btn reset" onClick={handleReset}>Reset</button>
      </div>

      {/* KPI */}
      <div className="kpi-row">
        <div className="kpi"><div className="kpi-l">Ukończone</div><div className="kpi-v">{doneCnt}</div></div>
        <div className="kpi"><div className="kpi-l">OTIF %</div><div className="kpi-v" style={{ color: otif !== null ? (otif >= 80 ? '#16a34a' : otif >= 60 ? '#d97706' : '#dc2626') : '#1a1d23' }}>{otif !== null ? otif + '%' : '—'}</div></div>
        <div className="kpi"><div className="kpi-l">Lead Time</div><div className="kpi-v">{avgLt ? fmt(avgLt) : '—'}</div></div>
        <div className="kpi"><div className="kpi-l">OEE Kucharz</div><div className="kpi-v">{cu}%</div></div>
        <div className="kpi"><div className="kpi-l">OEE Piec</div><div className="kpi-v">{ou}%</div></div>
        <div className="kpi"><div className="kpi-l">WIP (blat)</div><div className="kpi-v" style={{ color: wip.length > 5 ? '#dc2626' : '#1a1d23' }}>{wip.length}</div></div>
        <div className="kpi"><div className="kpi-l">Straty</div><div className="kpi-v waste">{waste}</div></div>
      </div>

      {/* SIM GRID */}
      <div className="sim-grid">

        {/* KOLEJKA */}
        <div className="station">
          <div className="station-header">
            <span className="station-title">📋 Zamówienia</span>
            <span className={`station-badge ${queue.length > 5 ? 'warn' : ''}`}>{orders.filter(o => o.status !== 'done').length} aktywnych</span>
          </div>
          <div className="order-list">
            {orders.filter(o => o.status !== 'done').length ? (
              orders.filter(o => o.status !== 'done').map(o => {
                const pct = Math.min(120, ((simTime - o.start) / DEAD) * 100);
                const col = bufColor(pct);
                const statusLabel = { queue: 'Kolejka', prep: 'Przygot.', wip: 'Blat', 'wip-bad': 'Blat ⚠', oven: 'Piec' }[o.status] || o.status;
                const statusColor = { queue: '#6b7280', prep: '#2563eb', wip: '#d97706', 'wip-bad': '#dc2626', oven: '#ea580c' }[o.status] || '#6b7280';
                return (
                  <div key={o.id} className="ocard" style={ pct > 100 ? { borderColor: '#111827', background: '#f9fafb' } : {}}>
                    <div className="ocard-top">
                      <span className="oid">#{o.id}</span>
                      <span className="oname">{o.name}</span>
                      {o.murphy && <span className="warn">⚠</span>}
                      <span style={{ fontSize: 9, fontWeight: 700, color: statusColor, background: statusColor + '18', padding: '1px 5px', borderRadius: 4, whiteSpace: 'nowrap' }}>{statusLabel}</span>
                    </div>
                    <div className="bbar">
                      <div className="bfill" style={{ width: Math.min(100, pct) + '%', background: col }} />
                    </div>
                    <div className="bpct" style={{ color: col, fontWeight: pct > 66 ? 700 : 500 }}>
                      {Math.round(pct)}%{pct > 100 ? ' — SPÓŹNIONE' : pct > 66 ? ' — PILNE' : ''}
                    </div>
                  </div>
                );
              })
            ) : <div className="empty">Brak aktywnych zamówień</div>}
          </div>
        </div>

        {/* SYGNAŁ BLAT — kolejka → kucharz (zawsze widoczny) */}
        <div className="arrow-col">
          <div className="rope-signal">
            {wip.length < wipLimit ? (
              <>
                <div className="rs-label">WIP OK</div>
                <div className="rs-arrows">
                  <span className="rs-arr rs-arr-r rs-arr-1">→</span>
                  <span className="rs-arr rs-arr-r rs-arr-2">→</span>
                  <span className="rs-arr rs-arr-r rs-arr-3">→</span>
                </div>
                <div className="rs-sublabel">blat wolny</div>
              </>
            ) : (
              <>
                <div className="rs-label rs-label-off">BLAT PEŁNY</div>
                <div className="rs-arrows rs-off">
                  <span className="rs-arr">→</span>
                  <span className="rs-arr">→</span>
                  <span className="rs-arr">→</span>
                </div>
                <div className="rs-sublabel rs-sublabel-off">stop</div>
              </>
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
                  <circle cx="18" cy="18" r="14" fill="none"
                    stroke={cu >= 80 ? '#16a34a' : cu >= 50 ? '#d97706' : '#dc2626'}
                    strokeWidth="4"
                    strokeDasharray={`${(cu / 100) * 87.96} 87.96`}
                    strokeLinecap="round"
                    transform="rotate(-90 18 18)"
                    style={{ transition: 'stroke-dasharray 0.5s' }}
                  />
                  <text x="18" y="22" textAnchor="middle" fontSize="9" fontWeight="700"
                    fill={cu >= 80 ? '#16a34a' : cu >= 50 ? '#d97706' : '#dc2626'}>{cu}%</text>
                </svg>
                <span className="oee-lbl">OEE</span>
              </div>
              <span className={`station-badge ${chef ? 'ok' : ''}`}>{chef ? 'Pracuje' : 'Czeka'}</span>
            </div>
          </div>

          {chef ? (
            <div className="chef-card">
              <div className="ocard-top">
                <span className="oid">#{chef.id}</span>
                <span className="oname">{chef.name}</span>
              </div>
              <div className="bbar">
                <div className="bfill" style={{ width: Math.round(Math.min(100, (1 - Math.max(0, chef.prepEnd - simTime) / PREP) * 100)) + '%', background: '#2563eb' }} />
              </div>
              <div className="bpct" style={{ color: '#2563eb' }}>Prep: {fmt(Math.max(0, chef.prepEnd - simTime))}</div>
            </div>
          ) : (
            <div className="empty" style={{ paddingBottom: 16 }}>{toc ? 'Czeka na sygnał liny...' : 'Czeka na zamówienie...'}</div>
          )}

          <div className="wip-section">
            <div className="wip-label">
              <span>Blat (WIP)</span>
              {wip.length > 0 && <span className="wip-count">{wip.length}</span>}
            </div>
            <div className="wip-zone">
              {wip.length
                ? <>
                    {wip.slice(0, wipLimit).map(w => (
                      <span key={w.id} className={`wpiz ${w.status === 'wip-bad' ? 'bad' : ''}`} title={`#${w.id} ${w.name}${w.status === 'wip-bad' ? ' [brak skł.]' : ''}`}>🍕</span>
                    ))}
                    {wip.length > wipLimit && <span className="wip-overflow">+{wip.length - wipLimit}</span>}
                  </>
                : <span className="empty">pusty</span>}
            </div>
          </div>
        </div>

        {/* SYGNAŁ PULL — piec → kucharz (tylko TOC) */}
        <div className="arrow-col">
          {toc ? (
            <div className="rope-signal">
              {ovenHasFreeSlot ? (
                <>
                  <div className="rs-label">PULL</div>
                  <div className="rs-arrows">
                    <span className="rs-arr rs-arr-1">←</span>
                    <span className="rs-arr rs-arr-2">←</span>
                    <span className="rs-arr rs-arr-3">←</span>
                  </div>
                  <div className="rs-sublabel">wolny slot</div>
                </>
              ) : (
                <>
                  <div className="rs-label rs-label-off">WAIT</div>
                  <div className="rs-arrows rs-off">
                    <span className="rs-arr">←</span>
                    <span className="rs-arr">←</span>
                    <span className="rs-arr">←</span>
                  </div>
                  <div className="rs-sublabel rs-sublabel-off">piec pełny</div>
                </>
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
                  <circle cx="18" cy="18" r="14" fill="none"
                    stroke={ou >= 80 ? '#16a34a' : ou >= 50 ? '#d97706' : '#dc2626'}
                    strokeWidth="4"
                    strokeDasharray={`${(ou / 100) * 87.96} 87.96`}
                    strokeLinecap="round"
                    transform="rotate(-90 18 18)"
                    style={{ transition: 'stroke-dasharray 0.5s' }}
                  />
                  <text x="18" y="22" textAnchor="middle" fontSize="9" fontWeight="700"
                    fill={ou >= 80 ? '#16a34a' : ou >= 50 ? '#d97706' : '#dc2626'}>{ou}%</text>
                </svg>
                <span className="oee-lbl">OEE</span>
              </div>
              <span className={`station-badge ${oven.some(x => x !== null) ? 'ok' : ''}`}>
                {oven.filter(x => x !== null).length}/2 slotów
              </span>
            </div>
          </div>

          <div className="oven-ctrl">
            <span>Czas pieczenia</span>
            <input type="range" min="0" max="10" step="1"
              value={Math.round(bakeTime / 60)}
              onChange={e => set('bakeTime', parseInt(e.target.value) * 60)} />
            <span className="oven-ctrl-val">{Math.round(bakeTime / 60)} min</span>
          </div>

          <div className="oven-slots">
            <OvenSlot order={oven[0]} simTime={simTime} />
            <OvenSlot order={oven[1]} simTime={simTime} />
          </div>

          <div className="done-label">Ostatnio wydane</div>
          <div className="order-list">
            {doneRecent.length
              ? doneRecent.map(o => {
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
                })
              : <div className="empty">Brak</div>}
          </div>
        </div>
      </div>

      {/* LOG */}
      <div className="log-box">
        <div className="log-title">Log zdarzeń</div>
        <div>
          {logs.slice(0, 15).map((l, i) => (
            <div key={i} className="le"><span className="ts">[{l.t}]</span>{l.msg}</div>
          ))}
        </div>
      </div>

      {showReport && <Scorecard state={state} onClose={() => setShowReport(false)} />}
      {report1h && <Scorecard1h result={report1h} onClose={() => setReport1h(null)} />}
    </div>
  );
}
