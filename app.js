// app.js
const EVENTS_URL = `./events.json?ts=${Date.now()}`;
const ROTATE_MS = 9000;          // how long each event stays on screen
const ANIM_MS   = 740;           // must match --dur in CSS

// ---------- tiny utils ----------
const $ = (q, r = document) => r.querySelector(q);
const $$ = (q, r = document) => Array.from(r.querySelectorAll(q));

function minToClock(m) {
  if (m == null) return '—';
  let h = Math.floor(m / 60);
  const mm = String(m % 60).padStart(2, '0');
  const mer = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${mm} ${mer}`;
}

function uniqKey(slot) {
  // de-dupe by time+title+subtitle per room
  const t = (slot.title || '').trim().toLowerCase();
  const s = (slot.subtitle || '').trim().toLowerCase();
  return `${slot.roomId}|${slot.startMin}|${slot.endMin}|${t}|${s}`;
}

// ---------- DOM builders ----------
function el(tag, attrs = {}, kids = []) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else n.setAttribute(k, v);
  }
  for (const kid of [].concat(kids)) {
    if (kid == null) continue;
    n.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid);
  }
  return n;
}

function renderCard(slot) {
  return el('div', { class: 'event' }, [
    el('div', { class: 'who',  text: slot.title || 'Reservation' }),
    slot.subtitle ? el('div', { class: 'what', text: slot.subtitle }) : null,
    el('div', { class: 'when', text: `${minToClock(slot.startMin)} – ${minToClock(slot.endMin)}` }),
  ]);
}

// ---------- rotor (animated, single visible) ----------
function startRotor(container, cards) {
  container.innerHTML = '';                 // clean
  if (cards.length === 0) {
    container.appendChild(
      el('div', { class: 'event' }, [
        el('div', { class: 'who', text: 'No reservations' }),
        el('div', { class: 'what', text: '—' }),
      ])
    );
    return;
  }
  // mount all absolute-stacked, show first
  cards.forEach((c, i) => {
    c.style.opacity = i === 0 ? '1' : '0';
    c.style.transform = i === 0 ? 'translateX(0)' : 'translateX(60px)'; // matches --shift
    container.appendChild(c);
  });

  let idx = 0;
  setInterval(() => {
    const cur = cards[idx];
    const nxt = cards[(idx + 1) % cards.length];

    // prepare next to enter
    nxt.classList.remove('fade-exit', 'fade-exit-active');
    nxt.classList.add('fade-enter');
    nxt.style.opacity = '0';

    // force reflow so transition will apply
    // eslint-disable-next-line no-unused-expressions
    nxt.offsetHeight;

    // animate: current exits left, next enters from right (+shift)
    cur.classList.remove('fade-enter', 'fade-enter-active');
    cur.classList.add('fade-exit', 'fade-exit-active');

    nxt.classList.remove('fade-enter');
    nxt.classList.add('fade-enter-active');

    // finalize states after animation time
    setTimeout(() => {
      // snap states to ended positions
      cur.classList.remove('fade-exit', 'fade-exit-active');
      cur.style.opacity = '0';
      cur.style.transform = 'translateX(-60px)';

      nxt.classList.remove('fade-enter-active');
      nxt.style.opacity = '1';
      nxt.style.transform = 'translateX(0)';

      idx = (idx + 1) % cards.length;
    }, ANIM_MS);
  }, ROTATE_MS);
}

// ---------- room mounting ----------
function mountRoom(roomId, slots) {
  const card = $(`#room-${roomId}`);
  if (!card) return;

  // update count
  const countEl = card.querySelector('.roomHeader .count em');
  if (countEl) countEl.textContent = String(slots.length);

  const eventsWrap = card.querySelector('.events');
  if (!eventsWrap) return;

  // Always use the rotor (even if 1 item). That keeps layouts consistent.
  eventsWrap.innerHTML = '';
  const rotor = el('div', { class: 'single-rotor' });
  eventsWrap.appendChild(rotor);

  const cards = slots.map(renderCard);
  startRotor(rotor, cards);
}

// Build 3×2 pages for Fieldhouse, but each room still uses the single-event rotor
function paginate(list, size) {
  const pages = [];
  for (let i = 0; i < list.length; i += size) pages.push(list.slice(i, i + size));
  return pages;
}

function buildFieldhousePage(batch, slotsByRoom) {
  const page = el('div', { class: 'page' });
  for (const r of batch) {
    const room = el('div', { class: 'room', id: `room-${r.id}` }, [
      el('div', { class: 'roomHeader' }, [
        el('div', { class: 'id', text: r.label }),
        el('div', { class: 'count' }, [document.createTextNode('reservations: '), el('em')]),
      ]),
      el('div', { class: 'events' }, [el('div', { class: 'single-rotor' })]),
    ]);
    page.appendChild(room);
  }
  // mount each room’s rotor
  requestAnimationFrame(() => {
    batch.forEach(r => mountRoom(r.id, slotsByRoom.get(r.id) || []));
  });
  return page;
}

function mountFieldhouse(fieldhouseRooms, slotsByRoom) {
  const pager = $('#fieldhousePager');
  if (!pager) return;
  pager.innerHTML = '';

  const batches = paginate(fieldhouseRooms, 6); // 3 cols × 2 rows
  if (batches.length === 0) return;

  const pages = batches.map(b => buildFieldhousePage(b, slotsByRoom));
  pages[0].classList.add('is-active');
  pages.forEach(p => pager.appendChild(p));

  if (pages.length > 1) {
    let i = 0;
    setInterval(() => {
      const cur = pages[i];
      const nxt = pages[(i + 1) % pages.length];
      cur.classList.remove('is-active');
      cur.classList.add('is-leaving');
      nxt.classList.add('is-active');
      setTimeout(() => cur.classList.remove('is-leaving'), ANIM_MS + 60);
      i = (i + 1) % pages.length;
    }, 12000);
  }
}

// ---------- header clock ----------
function tickClock() {
  const d = new Date();
  const dateEl = $('#headerDate');
  const clockEl = $('#headerClock');
  if (dateEl) {
    const dow = d.toLocaleDateString(undefined, { weekday: 'long' });
    const mdy = d.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
    dateEl.textContent = `${dow}, ${mdy}`;
  }
  if (clockEl) {
    clockEl.textContent = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }
}

// ---------- MAIN ----------
async function init() {
  tickClock();
  setInterval(tickClock, 1000);

  let data;
  try {
    const res = await fetch(EVENTS_URL, { cache: 'no-store' });
    data = await res.json();
  } catch (e) {
    console.error('Failed to load events.json', e);
    return;
  }

  // rooms: [{id,label,group}], slots: [{roomId,startMin,endMin,title,subtitle,...}]
  const rooms = data.rooms || [];
  const slots = data.slots || [];

  // group & sort by room, and de-dupe
  const slotsByRoom = new Map();
  for (const s of slots) {
    if (!slotsByRoom.has(s.roomId)) slotsByRoom.set(s.roomId, []);
    slotsByRoom.get(s.roomId).push(s);
  }
  for (const [roomId, arr] of slotsByRoom) {
    // de-dupe exact duplicates
    const seen = new Set();
    const dedup = [];
    for (const s of arr) {
      const k = uniqKey(s);
      if (!seen.has(k)) { seen.add(k); dedup.push(s); }
    }
    dedup.sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);
    slotsByRoom.set(roomId, dedup);
  }

  // mount South & North (each room always uses a rotor; only one visible at a time)
  const south = rooms.filter(r => r.group === 'south');
  south.forEach(r => mountRoom(r.id, slotsByRoom.get(r.id) || []));

  const north = rooms.filter(r => r.group === 'north');
  north.forEach(r => mountRoom(r.id, slotsByRoom.get(r.id) || []));

  // Fieldhouse paged 3×2, each cell still single-event rotor
  const fieldhouse = rooms.filter(r => r.group === 'fieldhouse');
  mountFieldhouse(fieldhouse, slotsByRoom);
}

document.addEventListener('DOMContentLoaded', init);
