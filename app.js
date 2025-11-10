// app.js — safe renderer for RAEC board (matches your HTML)
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

function normalizeReserveeName(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  // Fix trailing "(" artifacts
  const cleaned = s.replace(/\s*\($/, '');
  // "Last, First" → "First Last" when it looks like a person
  if (cleaned.includes(',')) {
    const [left, ...rest] = cleaned.split(',');
    const right = rest.join(',').trim();
    if (/^[A-Za-z'.-]+\s+[A-Za-z'.-]+/.test(right) && /^[A-Za-z'.-]+$/.test(left.trim())) {
      return `${right} ${left}`.replace(/\s+/g, ' ').trim();
    }
  }
  return cleaned;
}

function isInternalHold(s) {
  const t = String(s || '').toLowerCase();
  return (
    /internal hold per nm/.test(t) ||
    /installed per nm/.test(t) ||
    /hold per nm/.test(t) ||
    /raec front desk/.test(t)
  );
}

function isPickleball(s) {
  return /pickleball/i.test(String(s || ''));
}

function nowMinutesLocal() {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

// ---- card + rotor ----------------------------------------------
function renderCard(slot) {
  const el = document.createElement('div');
  el.className = 'event';

  const who = document.createElement('div');
  who.className = 'who';
  who.textContent = slot.title || '';

  const what = document.createElement('div');
  what.className = 'what';
  if (slot.subtitle) {
    what.textContent = slot.subtitle;
  }

  const when = document.createElement('div');
  when.className = 'when';
  when.textContent = `${fmtTime(slot.startMin)} – ${fmtTime(slot.endMin)}`;

  el.appendChild(who);
  if (slot.subtitle) el.appendChild(what);
  el.appendChild(when);
  return el;
}

/**
 * Start a rotor inside the room's ".events" box.
 * If there is no ".single-rotor" child, we create one.
 */
function startRotor(eventsBox, items) {
  if (!eventsBox) return;

  // Ensure a rotor element exists
  let rotor = eventsBox.querySelector('.single-rotor');
  if (!rotor) {
    rotor = document.createElement('div');
    rotor.className = 'single-rotor';
    eventsBox.innerHTML = '';
    eventsBox.appendChild(rotor);
  }

  // Clean previous content/timers
  rotor._rotTimer && clearTimeout(rotor._rotTimer);
  rotor.innerHTML = '';

  if (!items || items.length === 0) {
    // Render nothing if empty
    return;
  }

  if (items.length === 1) {
    // Single card, no animation
    rotor.appendChild(renderCard(items[0]));
    return;
  }

  // Rotate multiple
  let idx = 0;
  let current = renderCard(items[idx]);
  rotor.appendChild(current);

  const tick = () => {
    const nextIdx = (idx + 1) % items.length;
    const next = renderCard(items[nextIdx]);

    // stage next off to the right
    next.style.position = 'absolute';
    next.style.inset = '0';
    next.style.transform = 'translateX(60px)';
    next.style.opacity = '0';
    next.style.transition = `transform 740ms ${EASING}, opacity 740ms ${EASING}`;
    rotor.appendChild(next);

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
      if (current && current.parentNode === rotor) rotor.removeChild(current);
      current = next;
      idx = nextIdx;
    }, 760);
  };

  const loop = () => {
    if (!rotor.isConnected) return;
    if (items.length <= 1) return;
    tick();
    rotor._rotTimer = setTimeout(loop, ROTATE_MS);
  };

  rotor._rotTimer = setTimeout(loop, ROTATE_MS);
}

// ---- render fixed rooms (1/2/9/10) ------------------------------
function fillFixedRoom(roomId, slots) {
  const roomEl = byId(`room-${roomId}`);
  if (!roomEl) return;

  const countEl  = roomEl.querySelector('.roomHeader .count em');
  const eventsEl = roomEl.querySelector('.events');
  if (!eventsEl) return;

  const cards = (slots || []).map(s => ({
    ...s,
    title: normalizeReserveeName(s.title),
  }));

  if (countEl) countEl.textContent = String(cards.length || '0');
  startRotor(eventsEl, cards);
}

// ---- render fieldhouse (courts 3..8 OR quarter turf NA/NB/SA/SB) ---
function renderFieldhouse(grouped) {
  const host = document.getElementById('fieldhousePager');
  if (!host) return;

  host.innerHTML = ''; // rebuild fresh each load

  const turfKeys = ['QT-NA', 'QT-NB', 'QT-SA', 'QT-SB'];
  const hasTurf = turfKeys.some(k => (grouped[k] || []).length > 0);

  if (hasTurf) {
    // 2x2: SA (top-left), NA (top-right), SB (bottom-left), NB (bottom-right)
    const order = [
      ['Quarter Turf SA', 'QT-SA'],
      ['Quarter Turf NA', 'QT-NA'],
      ['Quarter Turf SB', 'QT-SB'],
      ['Quarter Turf NB', 'QT-NB'],
    ];

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
        <div class="events"></div>
      `;
      grid.appendChild(card);

      const eventsBox = card.querySelector('.events');
      const count     = card.querySelector('.count em');
      const items     = (grouped[key] || []).map(s => ({
        ...s,
        title: normalizeReserveeName(s.title),
      }));
      if (count) count.textContent = String(items.length || '0');
      startRotor(eventsBox, items);
    });

    host.appendChild(grid);
  } else {
    // Courts 3..8 in a 3x2 grid (3,4,5 / 6,7,8)
    const order = ['3','4','5','6','7','8'];

    const grid = document.createElement('div');
    grid.className = 'rooms-fieldhouse';
    grid.style.display = 'grid';
    grid.style.gridTemplateColumns = 'repeat(3, 1fr)';
    grid.style.gridTemplateRows = '1fr 1fr';
    grid.style.gap = '12px';

    order.forEach(id => {
      const card = document.createElement('div');
      card.className = 'room';
      card.innerHTML = `
        <div class="roomHeader">
          <div class="id">${id}</div>
          <div class="count">reservations: <em>—</em></div>
        </div>
        <div class="events"></div>
      `;
      grid.appendChild(card);

      const eventsBox = card.querySelector('.events');
      const count     = card.querySelector('.count em');
      const items     = (grouped[id] || []).map(s => ({
        ...s,
        title: normalizeReserveeName(s.title),
      }));
      if (count) count.textContent = String(items.length || '0');
      startRotor(eventsBox, items);
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
      // drop internal/front-desk/turf-install noise
      if (isInternalHold(s.subtitle) || isInternalHold(s.title)) return false;
      // drop stale past events (with grace)
      if (s.endMin < keepPastFloor) return false;
      return true;
    })
    .map(s => {
      // Normalize Pickleball
      if (isPickleball(s.title) || isPickleball(s.subtitle)) {
        return { ...s, title: 'Open Pickleball', subtitle: '' };
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
    const day  = d.toLocaleDateString(undefined, { weekday: 'long' });
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

  // Fixed rooms (your HTML IDs exist for each of these)
  ['1A','1B','2A','2B','9A','9B','10A','10B'].forEach(id => {
    fillFixedRoom(id, grouped[id] || []);
  });

  // Fieldhouse / Turf (auto)
  renderFieldhouse(grouped);

  // debug to console
  const nonEmpty = Object.fromEntries(Object.entries(grouped).filter(([,v]) => v.length));
  console.log('events.json loaded:', { totalSlots: all.length, nonEmptyRooms: nonEmpty });
}

boot().catch(err => {
  console.error('app init failed:', err);
});
