// app.js — safe renderer for RAEC board
// ------------------------------------------------------------

const NOW_GRACE_MIN = 10;          // keep events that just ended within 10 min
const ROTATE_MS      = 8000;       // only used when >1 event in a room
const EASING         = 'cubic-bezier(.22,.61,.36,1)';

// ---- tiny utils ------------------------------------------------
const byId = (id) => document.getElementById(id);
const fmtTime = (m) => {
  const h = Math.floor(m / 60);
  const mm = String(m % 60).padStart(2, '0');
  const h12 = ((h + 11) % 12) + 1;
  const ampm = h < 12 ? 'AM' : 'PM';
  return `${h12}:${mm} ${ampm}`;
};
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

// Name cleaner: "Last, First" => "First Last"
function normalizeReserveeName(raw) {
  const s = String(raw || '').trim();
  // remove doubled org repetition like "X, X"
  if (/,/.test(s)) {
    const [a, ...rest] = s.split(',');
    const right = rest.join(',').trim();
    // If right looks like "First Last" and left is single token => swap
    if (/^[A-Za-z'.-]+\s+[A-Za-z'.-]+/.test(right) && /^[A-Za-z'.-]+$/.test(a.trim())) {
      return `${right} ${a}`.replace(/\s+/g, ' ').trim();
    }
  }
  return s.replace(/\s*\($/, '').trim(); // strip accidental trailing "("
}

function isInternalHold(purpose) {
  const s = String(purpose || '').toLowerCase();
  return /internal hold per nm|installed per nm|hold per nm/.test(s);
}

function isPickleball(titleOrPurpose) {
  return /pickleball/i.test(String(titleOrPurpose || ''));
}

function nowMinutesLocal() {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

// ---- rotor (single card) ---------------------------------------
function startRotor(container, items) {
  // Defensive: container must exist
  if (!container) return;

  // Clean slate
  container.innerHTML = '';

  // Nothing -> render nothing
  if (!items || items.length === 0) return;

  // If only one, just render static and do NOT animate
  if (items.length === 1) {
    container.appendChild(renderCard(items[0]));
    return;
  }

  // Otherwise, rotate
  let idx = 0;
  let current = renderCard(items[idx]);
  container.appendChild(current);

  const tick = () => {
    const nextIdx = (idx + 1) % items.length;
    const next = renderCard(items[nextIdx]);

    // stage next off to the right
    next.style.position = 'absolute';
    next.style.inset = '0';
    next.style.transform = 'translateX(60px)';
    next.style.opacity = '0';
    next.style.transition = `transform 740ms ${EASING}, opacity 740ms ${EASING}`;
    container.appendChild(next);

    // animate current out left, next in
    requestAnimationFrame(() => {
      current.style.transition = `transform 740ms ${EASING}, opacity 740ms ${EASING}`;
      current.style.transform = 'translateX(-60px)';
      current.style.opacity = '0';

      next.style.transform = 'translateX(0)';
      next.style.opacity = '1';
    });

    // cleanup
    setTimeout(() => {
      if (current && current.parentNode === container) container.removeChild(current);
      current = next;
      idx = nextIdx;
    }, 760);
  };

  const loop = () => {
    // Skip anim if items length collapsed to 1 somehow
    if (!container.isConnected) return;
    if (items.length <= 1) return;
    tick();
    container._rotTimer = setTimeout(loop, ROTATE_MS);
  };

  container._rotTimer && clearTimeout(container._rotTimer);
  container._rotTimer = setTimeout(loop, ROTATE_MS);
}

function renderCard(slot) {
  const el = document.createElement('div');
  el.className = 'event';
  const who = document.createElement('div');
  who.className = 'who';
  who.textContent = slot.title || '';

  const what = document.createElement('div');
  what.className = 'what';
  what.textContent = slot.subtitle || '';

  const when = document.createElement('div');
  when.className = 'when';
  when.textContent = `${fmtTime(slot.startMin)} – ${fmtTime(slot.endMin)}`;

  el.appendChild(who);
  if (slot.subtitle) el.appendChild(what);
  el.appendChild(when);
  return el;
}

// ---- render fixed rooms (1/2/9/10) ------------------------------
function fillFixedRoom(roomId, slots) {
  const roomEl = byId(`room-${roomId}`);
  if (!roomEl) return;

  const countEl = roomEl.querySelector('.roomHeader .count em');
  const rotorEl = roomEl.querySelector('.events .single-rotor');
  if (!rotorEl) return;

  // Per room, one card at a time
  const cards = slots.map(s => ({
    ...s,
    title: normalizeReserveeName(s.title),
  }));

  // update count
  countEl && (countEl.textContent = String(cards.length || '0'));
  startRotor(rotorEl, cards);
}

// ---- render fieldhouse (courts 3..8 OR quarter turf NA/NB/SA/SB) ---
function renderFieldhouse(grouped) {
  const host = document.getElementById('fieldhousePager') || document.querySelector('.rooms-fieldhouse');
  if (!host) return;

  // If the page already has cards built into HTML (static 3x2), clear it and rebuild:
  host.innerHTML = '';

  const turfKeys = ['NA', 'NB', 'SA', 'SB'];
  const hasTurf = turfKeys.some(k => grouped[`QT-${k}`] && grouped[`QT-${k}`].length);

  if (hasTurf) {
    // Build 2x2 grid: SA (top-left), NA (top-right), SB (bottom-left), NB (bottom-right)
    const order = [
      ['Quarter Turf SA', 'QT-SA'],
      ['Quarter Turf NA', 'QT-NA'],
      ['Quarter Turf SB', 'QT-SB'],
      ['Quarter Turf NB', 'QT-NB'],
    ];

    // wrapper grid that matches your CSS for fieldhouse
    const grid = document.createElement('div');
    grid.className = 'rooms-fieldhouse';
    grid.style.display = 'grid';
    grid.style.gridTemplateColumns = '1fr 1fr';
    grid.style.gridTemplateRows = '1fr 1fr';
    grid.style.gap = '12px';

    order.forEach(([label, key]) => {
      const card = document.createElement('div');
      card.className = 'room';
      card.innerHTML = `
        <div class="roomHeader">
          <div class="id">${label}</div>
          <div class="count">reservations: <em>—</em></div>
        </div>
        <div class="events"><div class="single-rotor"></div></div>
      `;
      grid.appendChild(card);

      const rotor = card.querySelector('.single-rotor');
      const count = card.querySelector('.count em');
      const items = (grouped[key] || []).map(s => ({
        ...s,
        title: normalizeReserveeName(s.title),
      }));
      count.textContent = String(items.length || '0');
      startRotor(rotor, items);
    });

    host.appendChild(grid);
  } else {
    // Courts 3..8 in a 3x2 grid (3,4,5 / 6,7,8)
    const grid = document.createElement('div');
    grid.className = 'rooms-fieldhouse';
    grid.style.display = 'grid';
    grid.style.gridTemplateColumns = 'repeat(3, 1fr)';
    grid.style.gridTemplateRows = '1fr 1fr';
    grid.style.gap = '12px';

    const order = ['3','4','5','6','7','8'];
    order.forEach(id => {
      const card = document.createElement('div');
      card.className = 'room';
      card.innerHTML = `
        <div class="roomHeader">
          <div class="id">${id}</div>
          <div class="count">reservations: <em>—</em></div>
        </div>
        <div class="events"><div class="single-rotor"></div></div>
      `;
      grid.appendChild(card);

      const rotor = card.querySelector('.single-rotor');
      const count = card.querySelector('.count em');
      const items = (grouped[id] || []).map(s => ({
        ...s,
        title: normalizeReserveeName(s.title),
      }));
      count.textContent = String(items.length || '0');
      startRotor(rotor, items);
    });

    host.appendChild(grid);
  }
}

// ---- data shaping ------------------------------------------------
function groupByRoomSlots(slots) {
  const g = {};
  for (const s of slots) {
    if (!g[s.roomId]) g[s.roomId] = [];
    g[s.roomId].push(s);
  }
  // sort each room chronologically
  Object.values(g).forEach(list => list.sort((a,b) => a.startMin - b.startMin));
  return g;
}

function visibleSlots(raw) {
  const now = nowMinutesLocal();
  const keepPastFloor = now - NOW_GRACE_MIN;

  return (raw || [])
    .filter(s => {
      // drop "internal hold per NM"
      if (isInternalHold(s.subtitle) || isInternalHold(s.title)) return false;

      // drop stale past events
      if (s.endMin < keepPastFloor) return false;

      return true;
    })
    .map(s => {
      // Pickleball normalization
      if (isPickleball(s.title) || isPickleball(s.subtitle)) {
        return {
          ...s,
          title: 'Open Pickleball',
          subtitle: '',
        };
      }
      return s;
    });
}

// ---- clock/date --------------------------------------------------
function startClock() {
  const dEl = byId('headerDate');
  const cEl = byId('headerClock');

  const tick = () => {
    const d = new Date();
    const day = d.toLocaleDateString(undefined, { weekday: 'long' });
    const date = d.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
    const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

    if (dEl) dEl.textContent = `${day}, ${date}`;
    if (cEl) cEl.textContent = time;
  };
  tick();
  setInterval(tick, 1000);
}

// ---- boot --------------------------------------------------------
async function boot() {
  startClock();

  // Cache-busted fetch
  const res = await fetch(`./events.json?cb=${Date.now()}`, { cache: 'no-store' });
  const data = await res.json();

  const all = visibleSlots(Array.isArray(data?.slots) ? data.slots : []);

  // Group per room id
  const grouped = groupByRoomSlots(all);

  // Fixed rooms
  ['1A','1B','2A','2B','9A','9B','10A','10B'].forEach(id => {
    fillFixedRoom(id, grouped[id] || []);
  });

  // Fieldhouse / Turf
  renderFieldhouse(grouped);

  // debug to console
  const nonEmpty = Object.fromEntries(Object.entries(grouped).filter(([,v]) => v.length));
  console.log('events.json loaded:', {
    totalSlots: all.length,
    nonEmptyRooms: nonEmpty
  });
}

boot().catch(err => {
  console.error('app init failed:', err);
});
