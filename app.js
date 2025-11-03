// app.js
const EVENTS_URL = `./events.json?ts=${Date.now()}`;

// ---------- Time helpers ----------
function minToClock(m) {
  if (m == null) return '—';
  let h = Math.floor(m / 60);
  const mm = String(m % 60).padStart(2, '0');
  const mer = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${mm} ${mer}`;
}
function tickClock() {
  const d = new Date();
  const dateEl = document.getElementById('headerDate');
  const clockEl = document.getElementById('headerClock');
  if (dateEl) {
    const dow = d.toLocaleDateString(undefined, { weekday: 'long' });
    const mdy = d.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
    dateEl.textContent = `${dow}, ${mdy}`;
  }
  if (clockEl) {
    clockEl.textContent = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }
}

// ---------- Render helpers ----------
function el(tag, attrs = {}, kids = []) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else n.setAttribute(k, v);
  }
  for (const k of ([]).concat(kids)) {
    if (k == null) continue;
    n.appendChild(typeof k === 'string' ? document.createTextNode(k) : k);
  }
  return n;
}

function renderEventCard(slot) {
  // slot: { roomId, startMin, endMin, title, subtitle }
  const when = `${minToClock(slot.startMin)} – ${minToClock(slot.endMin)}`;
  return el('div', { class: 'event' }, [
    el('div', { class: 'who', text: slot.title || 'Reservation' }),
    slot.subtitle ? el('div', { class: 'what', text: slot.subtitle }) : null,
    el('div', { class: 'when', text: when })
  ]);
}

function mountRoom(roomId, slotsForRoom) {
  const room = document.getElementById(`room-${roomId}`);
  if (!room) return;
  // update count
  const countEl = room.querySelector('.roomHeader .count em');
  if (countEl) countEl.textContent = String(slotsForRoom.length);

  const eventsWrap = room.querySelector('.events');
  if (!eventsWrap) return;

  // Clear old
  eventsWrap.innerHTML = '';

  if (slotsForRoom.length <= 1) {
    // single rotor container (even if zero, keep structure)
    const rotor = el('div', { class: 'single-rotor' });
    if (slotsForRoom.length === 1) {
      rotor.appendChild(renderEventCard(slotsForRoom[0]));
    } else {
      rotor.appendChild(
        el('div', { class: 'event' }, [
          el('div', { class: 'who', text: 'No reservations' }),
          el('div', { class: 'what', text: '—' })
        ])
      );
    }
    eventsWrap.appendChild(rotor);
  } else {
    // stacked list
    const list = el('div', { class: 'events-list' });
    for (const s of slotsForRoom) list.appendChild(renderEventCard(s));
    eventsWrap.appendChild(list);
  }
}

function paginateFieldhouse(rooms, perPage = 6) {
  const pages = [];
  for (let i = 0; i < rooms.length; i += perPage) {
    pages.push(rooms.slice(i, i + perPage));
  }
  return pages;
}

function buildFieldhousePage(roomsBatch, slotsByRoom) {
  const page = el('div', { class: 'page' });
  for (const r of roomsBatch) {
    const card = el('div', { class: 'room' }, [
      el('div', { class: 'roomHeader' }, [
        el('div', { class: 'id', text: r.label }),
        el('div', { class: 'count' }, [
          document.createTextNode('reservations: '),
          el('em', {}, [])
        ])
      ]),
      el('div', { class: 'events' })
    ]);
    page.appendChild(card);
  }

  // After mounting, populate counts & events
  requestAnimationFrame(() => {
    for (const r of roomsBatch) {
      // find the card by title id text inside this page
      // simpler: map by order
    }
    // Actually, simpler: assign ids to these temporary cards:
    const cards = page.querySelectorAll('.room');
    roomsBatch.forEach((r, idx) => {
      // inject an id that mountRoom expects (room-<id>)
      cards[idx].id = `room-${r.id}`;
      mountRoom(r.id, slotsByRoom.get(r.id) || []);
    });
  });

  return page;
}

function mountFieldhouse(roomsFH, slotsByRoom) {
  const pager = document.getElementById('fieldhousePager');
  if (!pager) return;

  pager.innerHTML = '';

  const batches = paginateFieldhouse(roomsFH, 6);
  const pages = batches.map(batch => buildFieldhousePage(batch, slotsByRoom));

  if (pages.length === 0) return;

  // First page visible
  pages[0].classList.add('is-active');
  for (const p of pages) pager.appendChild(p);

  if (pages.length === 1) return; // nothing to paginate

  // Simple pager that slides every 12s
  let i = 0;
  setInterval(() => {
    const cur = pages[i];
    const nxt = pages[(i + 1) % pages.length];
    cur.classList.remove('is-active');
    cur.classList.add('is-leaving');
    nxt.classList.add('is-active');
    // clean leaving flag after transition
    setTimeout(() => cur.classList.remove('is-leaving'), 800);
    i = (i + 1) % pages.length;
  }, 12000);
}

// ---------- Main ----------
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

  // data: { dayStartMin, dayEndMin, rooms:[{id,label,group}], slots:[...] }
  const rooms = data.rooms || [];
  const slots = data.slots || [];

  // Group slots by roomId and sort by start time
  const slotsByRoom = new Map();
  for (const s of slots) {
    if (!slotsByRoom.has(s.roomId)) slotsByRoom.set(s.roomId, []);
    slotsByRoom.get(s.roomId).push(s);
  }
  for (const arr of slotsByRoom.values()) {
    arr.sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);
  }

  // South: 1A,1B,2A,2B
  const south = rooms.filter(r => r.group === 'south');
  south.forEach(r => mountRoom(r.id, slotsByRoom.get(r.id) || []));

  // North: 9A,9B,10A,10B
  const north = rooms.filter(r => r.group === 'north');
  north.forEach(r => mountRoom(r.id, slotsByRoom.get(r.id) || []));

  // Fieldhouse: 3..8 (paged 3x2)
  const fieldhouse = rooms.filter(r => r.group === 'fieldhouse');
  mountFieldhouse(fieldhouse, slotsByRoom);
}

document.addEventListener('DOMContentLoaded', init);
