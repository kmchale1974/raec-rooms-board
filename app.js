// app.js
const EVENTS_URL = `./events.json?ts=${Date.now()}`;

// Timings (match your CSS --dur ≈ 740ms)
const ROTATE_MS = 9000;
const ANIM_MS   = 740;

// ---------- small helpers ----------
const $ = (q, r = document) => r.querySelector(q);
function minToClock(m) {
  if (m == null) return '—';
  let h = Math.floor(m / 60), mm = String(m % 60).padStart(2,'0');
  const mer = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${mm} ${mer}`;
}

// “now” in minutes from midnight local
function nowMinutes() {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

// trivial checks
const looksLikePerson = (s) => /\b[A-Za-z][A-Za-z'.-]*\s+[A-Za-z][A-Za-z'.-]*/.test(s || '');
const isOneWord       = (s) => !!s && s.trim().split(/\s+/).length === 1;

// noise filters (front-end safety net)
function isNoise(slot) {
  const t = (slot.title || '').toLowerCase();
  const sub = (slot.subtitle || '').toLowerCase();
  const org = (slot.org || '').toLowerCase();
  // front desk / turf install holds we never want to see
  if (org.includes('raec front desk')) return true;
  if (t.includes('turf install') || sub.includes('turf install')) return true;
  if (sub.includes('internal hold per nm') || t.includes('internal hold per nm')) return true;
  return false;
}

// prefer showing a real full name if title is just a last name
function displayWho(slot) {
  const title = (slot.title || '').trim();
  const contact = (slot.contact || '').trim();
  if (isOneWord(title) && looksLikePerson(contact)) return contact;
  return title || 'Reservation';
}

// de-dupe by room/time/title/subtitle
function key(slot) {
  return [
    slot.roomId,
    slot.startMin, slot.endMin,
    (slot.title || '').trim().toLowerCase(),
    (slot.subtitle || '').trim().toLowerCase()
  ].join('|');
}

// ---------- DOM ----------
function el(tag, attrs = {}, kids = []) {
  const n = document.createElement(tag);
  for (const [k,v] of Object.entries(attrs)) {
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

function buildCard(slot) {
  return el('div', { class: 'event', style: `opacity:0; transform:translateX(60px); transition:opacity ${ANIM_MS}ms var(--ease), transform ${ANIM_MS}ms var(--ease);` }, [
    el('div', { class: 'who',  text: displayWho(slot) }),
    slot.subtitle ? el('div', { class: 'what', text: slot.subtitle }) : null,
    el('div', { class: 'when', text: `${minToClock(slot.startMin)} – ${minToClock(slot.endMin)}` })
  ]);
}

// crossfade rotor: one visible at a time, smooth overlap
function startRotor(container, cards) {
  container.innerHTML = '';

  if (cards.length === 0) {
    container.appendChild(
      el('div', { class: 'event', style:`opacity:1;` }, [
        el('div', { class: 'who', text: 'No reservations' }),
        el('div', { class: 'what', text: '—' })
      ])
    );
    return;
  }

  // mount & show first
  cards.forEach(c => container.appendChild(c));
  // force reflow then reveal first
  // eslint-disable-next-line no-unused-expressions
  container.offsetHeight;
  cards[0].style.opacity = '1';
  cards[0].style.transform = 'translateX(0)';

  let i = 0;
  setInterval(() => {
    const cur = cards[i];
    const nxt = cards[(i + 1) % cards.length];

    // bring next in (start visible)
    nxt.style.opacity = '1';
    nxt.style.transform = 'translateX(0)';
    nxt.style.zIndex = '2';

    // slide/fade current out with slight overlap
    cur.style.opacity = '0';
    cur.style.transform = 'translateX(-60px)';
    cur.style.zIndex = '1';

    setTimeout(() => {
      // ensure stacking reset for next cycle
      cur.style.zIndex = '';
      nxt.style.zIndex = '';
      i = (i + 1) % cards.length;
    }, ANIM_MS);
  }, ROTATE_MS);
}

function mountRoom(roomId, slots) {
  const host = document.getElementById(`room-${roomId}`);
  if (!host) return;
  const countEl = host.querySelector('.roomHeader .count em');
  const wrap = host.querySelector('.events');
  if (!wrap) return;

  // past-event filter and noise filter
  const nowMin = nowMinutes();
  const filtered = slots.filter(s => s.endMin > nowMin && !isNoise(s));

  // de-dupe & sort
  const seen = new Set();
  const dedup = [];
  for (const s of filtered) {
    const k = key(s);
    if (!seen.has(k)) { seen.add(k); dedup.push(s); }
  }
  dedup.sort((a,b) => a.startMin - b.startMin || a.endMin - b.endMin);

  if (countEl) countEl.textContent = String(dedup.length);

  wrap.innerHTML = '';
  const rotor = el('div', { class: 'single-rotor' });
  wrap.appendChild(rotor);
  startRotor(rotor, dedup.map(buildCard));
}

// paginate fieldhouse (3×2 grid), but each cell still rotor=single visible
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
        el('div', { class: 'count' }, ['reservations: ', el('em', { text: '—' })])
      ]),
      el('div', { class: 'events' }, [ el('div', { class: 'single-rotor' }) ])
    ]);
    page.appendChild(room);
  }
  requestAnimationFrame(() => {
    batch.forEach(r => mountRoom(r.id, slotsByRoom.get(r.id) || []));
  });
  return page;
}

function mountFieldhouse(fieldhouseRooms, slotsByRoom) {
  const pager = $('#fieldhousePager');
  if (!pager) return;
  pager.innerHTML = '';

  const batches = paginate(fieldhouseRooms, 6);
  if (batches.length === 0) return;

  const pages = batches.map(b => buildFieldhousePage(b, slotsByRoom));
  pages.forEach(p => pager.appendChild(p));
  pages[0].classList.add('is-active');

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
  const dow = d.toLocaleDateString(undefined, { weekday: 'long' });
  const mdy = d.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
  const hm  = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const dateEl = $('#headerDate'), clockEl = $('#headerClock');
  if (dateEl) dateEl.textContent = `${dow}, ${mdy}`;
  if (clockEl) clockEl.textContent = hm;
}

// ---------- main ----------
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

  const rooms = data.rooms || [];
  const slots = data.slots || [];

  // group by room
  const slotsByRoom = new Map();
  for (const s of slots) {
    if (!slotsByRoom.has(s.roomId)) slotsByRoom.set(s.roomId, []);
    slotsByRoom.get(s.roomId).push(s);
  }

  // south & north
  rooms.filter(r => r.group === 'south').forEach(r => mountRoom(r.id, slotsByRoom.get(r.id) || []));
  rooms.filter(r => r.group === 'north').forEach(r => mountRoom(r.id, slotsByRoom.get(r.id) || []));

  // fieldhouse 3×2 pages
  mountFieldhouse(rooms.filter(r => r.group === 'fieldhouse'), slotsByRoom);
}

document.addEventListener('DOMContentLoaded', init);
