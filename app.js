// app.js (drop-in)
// Smooth single-card rotors + fieldhouse pager + filtering

const DUR_MS = 740;           // keep aligned with --dur
const ROTOR_STAY_MS = 7000;   // time a card is fully visible
const PAGER_STAY_MS = 9000;   // time a fieldhouse page is fully visible

const ROOMS_SOUTH = ["1A","1B","2A","2B"];
const ROOMS_NORTH = ["9A","9B","10A","10B"];
const ROOMS_FIELD = ["3","4","5","6","7","8"];

const q = (sel, el=document) => el.querySelector(sel);
const qa = (sel, el=document) => Array.from(el.querySelectorAll(sel));

// --- Clock / Date ---
function startClock() {
  const dateEl = q('#headerDate');
  const clockEl = q('#headerClock');
  const fmtDate = (d) =>
    d.toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric' });
  const fmtTime = (d) =>
    d.toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit' });

  function tick() {
    const now = new Date();
    if (dateEl) dateEl.textContent = fmtDate(now);
    if (clockEl) clockEl.textContent = fmtTime(now);
  }
  tick();
  setInterval(tick, 1000);
}

// --- Data loading ---
async function loadEvents() {
  const res = await fetch('./events.json', { cache: 'no-store' });
  if (!res.ok) throw new Error('Failed to load events.json');
  return res.json();
}

// --- Helpers ---
function nowMinutes() {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}
function formatTime(mins) {
  let h = Math.floor(mins/60);
  const m = mins%60;
  const mer = h >= 12 ? 'PM' : 'AM';
  if (h === 0) h = 12;
  else if (h > 12) h -= 12;
  return `${h}:${m.toString().padStart(2,'0')} ${mer}`;
}
function groupByRoom(slots) {
  const map = new Map();
  for (const s of slots) {
    if (!map.has(s.roomId)) map.set(s.roomId, []);
    map.get(s.roomId).push(s);
  }
  for (const [k, arr] of map) {
    arr.sort((a,b) => a.startMin - b.startMin || a.endMin - b.endMin);
  }
  return map;
}

// --- Rotor (one visible card, smooth enter/exit) ---
class SingleRotor {
  constructor(container, items) {
    this.container = container;
    this.items = items;
    this.idx = 0;
    this.timer = null;
    this.running = false;
  }

  makeCard(item) {
    const el = document.createElement('div');
    el.className = 'event';
    const who = document.createElement('div');
    who.className = 'who';
    who.textContent = item.title || '';
    const what = document.createElement('div');
    what.className = 'what';
    what.textContent = item.subtitle || '';
    const when = document.createElement('div');
    when.className = 'when';
    when.textContent = `${formatTime(item.startMin)} – ${formatTime(item.endMin)}`;
    el.append(who, what, when);
    return el;
  }

  // Animate: current -> exit, next -> enter (left slide & crossfade)
  swapTo(nextIdx) {
    const current = this.container.querySelector('.event');
    const nextData = this.items[nextIdx];
    const nextEl = this.makeCard(nextData);

    // prepare next (offstage-right)
    nextEl.classList.add('is-enter');
    this.container.appendChild(nextEl);

    // force reflow to allow transition
    // eslint-disable-next-line no-unused-expressions
    nextEl.offsetWidth;

    // arm transitions
    nextEl.classList.add('is-enter-active');
    requestAnimationFrame(() => {
      nextEl.classList.remove('is-enter');
      nextEl.classList.add('is-enter-to');
    });

    if (current) {
      current.classList.add('is-exit');
      // eslint-disable-next-line no-unused-expressions
      current.offsetWidth;
      current.classList.add('is-exit-active');
      requestAnimationFrame(() => {
        current.classList.add('is-exit-to');
      });

      const onEnd = () => {
        current.removeEventListener('transitionend', onEnd);
        current.remove();
      };
      current.addEventListener('transitionend', onEnd);
    }

    this.idx = nextIdx;
  }

  tick = () => {
    if (!this.running) return;
    const next = (this.idx + 1) % this.items.length;
    this.swapTo(next);
    this.timer = setTimeout(this.tick, ROTOR_STAY_MS + DUR_MS);
  };

  start() {
    if (!this.items.length) return;
    if (this.running) return;
    this.running = true;
    // mount first immediately (no animation)
    const first = this.makeCard(this.items[this.idx]);
    this.container.innerHTML = '';
    this.container.appendChild(first);
    this.timer = setTimeout(this.tick, ROTOR_STAY_MS);
  }

  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
  }
}

// --- Fieldhouse pager (3x2 pages sliding left) ---
class Pager {
  constructor(host, pages) {
    this.host = host;
    this.pages = pages;
    this.pageEls = [];
    this.idx = 0;
    this.timer = null;
    this.running = false;
  }

  render() {
    this.host.innerHTML = '';
    this.pageEls = this.pages.map((page) => {
      const el = document.createElement('div');
      el.className = 'page';
      // six boxes (3x2) expected; each a rotor or empty state
      page.forEach(cell => {
        const room = document.createElement('div');
        room.className = 'room';
        const header = document.createElement('div');
        header.className = 'roomHeader';
        header.innerHTML = `<div class="id">${cell.id}</div><div class="count">reservations: <em>${cell.items.length}</em></div>`;
        const events = document.createElement('div');
        events.className = 'events';
        const rotorWrap = document.createElement('div');
        rotorWrap.className = 'single-rotor';
        events.appendChild(rotorWrap);
        room.append(header, events);
        el.appendChild(room);

        // mount rotor
        const rotor = new SingleRotor(rotorWrap, cell.items);
        // show first card immediately to avoid empties
        rotor.start();
      });
      this.host.appendChild(el);
      return el;
    });
  }

  show(idx) {
    this.pageEls.forEach((p, i) => {
      p.classList.remove('is-active','is-leaving');
      if (i === idx) p.classList.add('is-active');
    });
  }

  next() {
    const cur = this.idx;
    const nxt = (cur + 1) % this.pageEls.length;
    const curEl = this.pageEls[cur];
    const nxtEl = this.pageEls[nxt];
    if (!nxtEl || !curEl) return;

    // prepare next (offstage-right)
    nxtEl.classList.remove('is-active','is-leaving');
    // force reflow
    // eslint-disable-next-line no-unused-expressions
    nxtEl.offsetWidth;
    nxtEl.classList.add('is-active');

    // mark current as leaving (slides left)
    curEl.classList.add('is-leaving');

    this.idx = nxt;
  }

  start() {
    if (!this.pages.length) return;
    this.render();
    this.show(this.idx);
    if (this.pages.length > 1) {
      this.running = true;
      this.timer = setInterval(() => this.next(), PAGER_STAY_MS);
    }
  }
}

// Build pages of 3x2 from rooms 3..8
function buildFieldhousePages(roomMap) {
  const cells = ROOMS_FIELD.map(id => ({
    id,
    items: (roomMap.get(id) || [])
  }));
  const pages = [];
  for (let i=0; i<cells.length; i+=6) {
    const slice = cells.slice(i, i+6);
    // ensure 6 cells
    while (slice.length < 6) slice.push({ id:'', items:[] });
    pages.push(slice);
  }
  return pages;
}

// --- Mount everything ---
async function main() {
  startClock();

  const data = await loadEvents();

  // Filter: only events that haven't ended yet
  const nowMin = nowMinutes();
  const upcoming = (data.slots || []).filter(s => s.endMin > nowMin);

  // Group by room
  const byRoom = groupByRoom(upcoming);

  // SOUTH & NORTH rotors
  for (const id of ROOMS_SOUTH.concat(ROOMS_NORTH)) {
    const container = q(`#room-${id} .single-rotor`);
    const countEl = q(`#room-${id} .roomHeader .count em`);
    const items = (byRoom.get(id) || []);
    if (countEl) countEl.textContent = String(items.length);
    if (container) {
      const rotor = new SingleRotor(container, items);
      rotor.start();
    }
  }

  // FIELDHOUSE pager (3..8 => pages of 6)
  const pagerHost = q('#fieldhousePager');
  const pages = buildFieldhousePages(byRoom);
  const pager = new Pager(pagerHost, pages);
  pager.start();
}

main().catch(err => {
  console.error(err);
});
