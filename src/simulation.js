export const PREP = 60;
export const BAKE = 300;
export const DEAD = 1200;
export const NAMES = ["Margherita","Pepperoni","Diavola","Quattro St.","Capricciosa","Prosciutto","Funghi"];

export function createState() {
  return {
    running: false,
    toc: false,
    auto: false,
    speed: 1,
    simTime: 0,
    nextId: 1,
    orders: [],
    wip: [],
    oven: [null, null],
    done: [],
    chef: null,
    chefBusyTime: 0,
    ovenBusyTime: 0,
    totalTime: 0,
    waste: 0,
    maxWip: 0,
    leadTimes: [],
    autoTimer: 0,
    logs: [],
  };
}

export function rnd(a, b) {
  return Math.floor(Math.random() * (b - a + 1)) + a;
}

export function fmt(s) {
  s = Math.round(s);
  return s < 60 ? s + 's' : Math.floor(s / 60) + 'm' + (s % 60 ? ' ' + (s % 60) + 's' : '');
}

export function bufColor(pct) {
  if (pct > 100) return '#2C2C2A';
  if (pct > 66)  return '#D85A30';
  if (pct > 33)  return '#BA7517';
  return '#1D9E75';
}

export function tickState(state) {
  const s = { ...state };
  const dt = 1;

  s.simTime += dt;
  s.totalTime += dt;
  if (s.chef) s.chefBusyTime += dt;

  const logs = [...s.logs];
  const addLog = (msg) => logs.unshift({ t: fmt(s.simTime), msg });

  s.oven = [...s.oven];
  s.wip = [...s.wip];
  s.orders = [...s.orders];
  s.done = [...s.done];
  s.leadTimes = [...s.leadTimes];

  // Oven busy time
  s.oven.forEach(slot => { if (slot) s.ovenBusyTime += dt; });

  // Auto order
  if (s.auto) {
    s.autoTimer -= dt;
    if (s.autoTimer <= 0) {
      const o = { id: s.nextId++, name: NAMES[rnd(0, NAMES.length - 1)], start: s.simTime, murphy: false, status: 'queue', prepEnd: 0, bakeEnd: 0 };
      s.orders = [...s.orders, o];
      s.autoTimer = rnd(20, 40);
      addLog('#' + o.id + ' ' + o.name + ' — auto zamówienie');
    }
  }

  // Oven — check done
  s.oven = s.oven.map(slot => {
    if (slot && s.simTime >= slot.bakeEnd) {
      const finished = { ...slot, status: 'done' };
      s.done = [...s.done, finished];
      s.leadTimes = [...s.leadTimes, finished.bakeEnd - finished.start];
      addLog('#' + finished.id + ' ' + finished.name + ' gotowa! LT:' + fmt(finished.bakeEnd - finished.start));
      return null;
    }
    return slot;
  });

  // Chef done
  if (s.chef && s.simTime >= s.chef.prepEnd) {
    const job = { ...s.chef };
    s.chef = null;
    if (job.murphy && !s.toc) {
      const bad = { ...job, status: 'wip-bad' };
      s.wip = [...s.wip, bad];
      s.waste++;
      addLog('#' + job.id + ' — brak składnika, pizza utknęła (waste)!');
    } else {
      const freeIdx = s.oven.findIndex(x => x === null);
      if (freeIdx >= 0) {
        const inOven = { ...job, status: 'oven', bakeEnd: s.simTime + BAKE };
        s.oven = s.oven.map((o, i) => i === freeIdx ? inOven : o);
        addLog('#' + job.id + ' ' + job.name + ' — do pieca (slot ' + (freeIdx + 1) + ')');
      } else {
        s.wip = [...s.wip, { ...job, status: 'wip' }];
        addLog('#' + job.id + ' ' + job.name + ' — czeka na blacie (WIP)');
      }
    }
    s.maxWip = Math.max(s.maxWip, s.wip.length);
  }

  // WIP -> oven
  if (!s.chef) {
    const freeIdx = s.oven.findIndex(x => x === null);
    const wipReady = s.wip.find(w => w.status === 'wip');
    if (wipReady && freeIdx >= 0) {
      const inOven = { ...wipReady, status: 'oven', bakeEnd: s.simTime + BAKE };
      s.wip = s.wip.filter(w => w.id !== wipReady.id);
      s.oven = s.oven.map((o, i) => i === freeIdx ? inOven : o);
      addLog('#' + wipReady.id + ' z blatu do pieca (slot ' + (freeIdx + 1) + ')');
    }
  }

  // New chef job
  if (!s.chef) {
    const queue = s.orders.filter(o => o.status === 'queue');
    if (s.toc) {
      const hasFree = s.oven.some(x => x === null);
      if (hasFree) {
        const valid = queue.find(o => !o.murphy);
        if (valid) {
          const updated = { ...valid, status: 'prep', prepEnd: s.simTime + PREP };
          s.orders = s.orders.map(o => o.id === valid.id ? updated : o);
          s.chef = updated;
          addLog('#' + valid.id + ' ' + valid.name + ' — kucharz startuje (TOC/lina)');
        }
      }
    } else {
      if (queue.length > 0) {
        const next = queue[0];
        const updated = { ...next, status: 'prep', prepEnd: s.simTime + PREP };
        s.orders = s.orders.map(o => o.id === next.id ? updated : o);
        s.chef = updated;
        addLog('#' + next.id + ' ' + next.name + ' — kucharz startuje (OEE/push)');
      }
    }
  }

  s.logs = logs.slice(0, 80);
  return s;
}
