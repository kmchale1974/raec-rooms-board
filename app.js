// app.js (ES module)

// ---------- Config ----------
const DATA_URL = `./events.json?ts=${Date.now()}`;
const HIDE_PAST = true;           // remove events that already ended
const ROOM_PAGE_SIZE = 5;         // events per page in a room card
const ROOM_PAGE_MS   = 8000;      // ms between page flips
const SLIDE_MS       = 500;       // slide animation duration (ms)
const CLOCK_TICK_MS  = 1000;      // live clock refresh

// Pager state per room
const roomPager = Object.create(null);

// ---------- Small style injection for animation ----------
(function injectPagerCSS(){
  const css = `
  .events { position: relative; overflow: hidden; }
  .events .page {
    position: absolute; inset: 0;
    will-change: transform, opacity;
  }
  .events .page.hidden { display: none; }
  `;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);
})();

// ---------- Utilities ----------
function nowMinutesLocal() {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}
function pad2(n) { return String(n).padStart(2,'0'); }
function minsTo12h(mins) {
  const h24 = Math.floor(mins / 60);
  const m = mins % 60;
  const h12 = ((h24 + 11) % 12) + 1;
  const ampm = h24 >= 12 ? 'pm' : 'am';
  return `${h12}:${pad2(m)}${ampm}`;
}
function escapeHTML(s='') {
  return String(s).replace(/[&<>"']/g, c => (
    { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]
  ));
}

// --- Org/person parsing helpers ---
const ORG_HINTS = [
  'basketball','volleyball','club','academy','united','elite','sports','athletics',
  'school','city','parks','rec','association','league','fc','sc','inc','llc','foundation'
];

function looksLikePersonToken(t) {
  // Single word that starts with a letter and not obviously an org keyword
  if (!/^[a-zA-Z][a-zA-Z'.-]*$/.test(t)) return false;
  const low = t.toLowerCase();
  if (ORG_HINTS.includes(low)) return false;
  return true;
}
function looksLikePersonFull(s) {
  // "Last, First[ Middle]" OR "First Last" (2–3 tokens), all word-y
  if (/,/.test(s)) {
    const [l, r] = s.split(',', 2).map(x => x.trim());
    return l && r && looksLikePersonToken(l.split(/\s+/)[0]) && looksLikePersonToken(r.split(/\s+/)[0]);
  }
  const parts = s.trim().split(/\s+/);
  if (parts.length < 2 || parts.length > 4) return false;
  return parts.every(looksLikePersonToken);
}
function looksLikeOrg(s) {
  const low = s.toLowerCase();
  return ORG_HINTS.some(k => low.includes(k));
}
function invertLastFirst(name) {
  // "Doe, John A." -> "John A. Doe"
  if (!/,/.test(name)) return name;
  const [last, first] = name.split(',', 2).map(s => s.trim()).filter(Boolean);
  if (first && last) return `${first} ${last}`.replace(/\s+/g,' ').trim();
  return name;
}

function normalizeOrgAndContact(title = '', subtitle = '') {
  let org = '';
  let contact = '';
  let what = subtitle.trim();

  // Special: Pickleball renaming (hide internal verbiage)
  const combined = `${title} ${subtitle}`.toLowerCase();
  if (combined.includes('pickleball')) {
    return { org: 'Open Pickleball', contact: '', what: '' };
  }

  const raw = title.trim();
  if (raw.includes(',')) {
    const [left, right] = raw.split(',', 2).map(s => s.trim());
    const rightIsPerson = looksLikePersonFull(right);
    const leftIsPerson  = looksLikePersonFull(left);
    const leftIsOrg     = looksLikeOrg(left) || !leftIsPerson;

    if (leftIsOrg && rightIsPerson) {
      org = left;
      contact = invertLastFirst(right);
    } else if (leftIsPerson && !rightIsPerson) {
      // "Brown, Shawnton, Academy"? we’ll treat as person; append right to what
      contact = invertLastFirst(`${left}${right ? ', ' + right : ''}`);
    } else if (leftIsPerson && rightIsPerson) {
      // two names — pick the more likely contact (right), leave org blank
      contact = invertLastFirst(right);
    } else {
      // default: treat left as org
      org = left;
      if (right) what = [what, right].filter(Boolean).join(' • ');
    }
  } else {
    if (looksLikePersonFull(raw)) {
      contact = invertLastFirst(raw);
    } else {
      org = raw;
    }
  }

  return { org, contact, what };
}

function dedupeWithinRoom(slots) {
  const seen = new Set();
  const out = [];
  for (const s of slots) {
    const k = [
      s.startMin, s.endMin,
      (s.org || '').toLowerCase(),
      (s.contact || '').toLowerCase(),
      (s.what || '').toLowerCase()
    ].join('||');
    if (!seen.has(k)) {
      seen.add(k);
      out.push(s);
    }
  }
  return out;
}

// ---------- Rendering ----------
function updateHeaderClock() {
  const d = new Date();
  const dateEl = document.getElementById('headerDate');
  const clockEl = document.getElementById('headerClock');
  if (dateEl) {
    const opts = { weekday:'long', month:'long', day:'numeric' };
    dateEl.textContent = d.toLocaleDateString(undefined, opts);
  }
  if (clockEl) {
    const hh = d.getHours();
    const mm = pad2(d.getMinutes());
    const ampm = hh >= 12 ? 'PM' : 'AM';
    const h12 = ((hh + 11) % 12) + 1;
    clockEl.textContent = `${h12}:${mm} ${ampm}`;
  }
}

function buildRoomCard(roomId, targetContainer) {
  const card = document.createElement('div');
  card.className = 'room';
  const header = document.createElement('div');
  header.className = 'roomHeader';
  header.innerHTML = `
    <div class="id">${escapeHTML(roomId)}</div>
    <div class="count"></div>
  `;
  const list = document.createElement('div');
  list.className = 'events';
  // two paging layers
  const pageA = document.createElement('div');
  const pageB = document.createElement('div');
  pageA.className = 'page';
  pageB.className = 'page';
  list.appendChild(pageA);
  list.appendChild(pageB);

  card.appendChild(header);
  card.appendChild(list);
  targetContainer.appendChild(card);

  return card;
}

function renderEventHTML(evt) {
  const when = `${minsTo12h(evt.startMin)} – ${minsTo12h(evt.endMin)}`;
  const whoLine = evt.org ? `<div class="who"><strong>${escapeHTML(evt.org)}</strong></div>` : '';
  // If we only have a person, show them (not muted)
  const contactLine = evt.contact
    ? `<div class="what">${escapeHTML(evt.contact)}</div>`
    : '';
  const whatLine = (!evt.contact && evt.what)
    ? `<div class="what">${escapeHTML(evt.what)}</div>`
    : '';
  return `
    <div class="event">
      ${whoLine}${contactLine || whatLine || ''}
      <div class="when">${when}</div>
    </div>
  `;
}

// Slide pager: uses two absolutely-positioned .page elements
function renderRoomPaged(roomEl, roomId, eventsForRoom) {
  const list = roomEl.querySelector('.events');
  const pageEls = list.querySelectorAll('.page');
  const pageA = pageEls[0];
  const pageB = pageEls[1];
  const header = roomEl.querySelector('.roomHeader');
  const countEl = header?.querySelector('.count');

  // clear previous timer
  const prev = roomPager[roomId];
  if (prev?.timer) clearInterval(prev.timer);

  // Split into pages
  const pages = [];
  for (let i = 0; i < eventsForRoom.length; i += ROOM_PAGE_SIZE) {
    pages.push(eventsForRoom.slice(i, i + ROOM_PAGE_SIZE));
  }

  // Helper to set page HTML
  const setPageHTML = (el, items) => {
    el.innerHTML = items.map(renderEventHTML).join('');
  };

  // No or one page: no animation
  if (pages.length === 0) {
    pageA.innerHTML = '';
    pageB.innerHTML = '';
    pageA.classList.remove('hidden');
    pageB.classList.add('hidden');
    if (countEl) countEl.textContent = '';
    roomPager[roomId] = { page: 0, pages: 0, timer: null };
    return;
  }
  if (pages.length === 1) {
    setPageHTML(pageA, pages[0]);
    pageA.style.transform = 'translateX(0%)';
    pageB.style.transform = 'translateX(100%)';
    pageA.classList.remove('hidden');
    pageB.classList.add('hidden');
    pageA.style.transition = pageB.style.transition = 'none';
    if (countEl) countEl.textContent = '';
    roomPager[roomId] = { page: 0, pages: 1, timer: null };
    return;
  }

  // Many pages: animate A <-> B sliding left
  let cur = 0;
  setPageHTML(pageA, pages[cur]);
  pageA.style.transition = pageB.style.transition = 'none';
  pageA.style.transform = 'translateX(0%)';
  pageB.style.transform = 'translateX(100%)';
  pageA.classList.remove('hidden');
  pageB.classList.remove('hidden');
  if (countEl) countEl.textContent = `Page ${cur + 1} / ${pages.length}`;

  // ensure transitions after first frame
  requestAnimationFrame(() => {
    pageA.style.transition = pageB.style.transition = `transform ${SLIDE_MS}ms ease-in-out`;
  });

  const tick = () => {
    const next = (cur + 1) % pages.length;
    // Prepare the offscreen page with next content
    const curEl  = (cur % 2 === 0) ? pageA : pageB;
    const nextEl = (cur % 2 === 0) ? pageB : pageA;
    setPageHTML(nextEl, pages[next]);
    // place next page just to the right
    nextEl.style.transform = 'translateX(100%)';

    // Trigger slide
    // In next frame, slide both left
    requestAnimationFrame(() => {
      curEl.style.transform  = 'translateX(-100%)';
      nextEl.style.transform = 'translateX(0%)';
    });

    // After animation, swap roles
    setTimeout(() => {
      // make the now-offscreen page ready on the right for the following tick
      curEl.style.transition = 'none';
      curEl.style.transform  = 'translateX(100%)';
      // re-enable transition
      void curEl.offsetHeight; // force reflow
      curEl.style.transition = `transform ${SLIDE_MS}ms ease-in-out`;

      cur = next;
      if (countEl) countEl.textContent = `Page ${cur + 1} / ${pages.length}`;
    }, SLIDE_MS);
  };

  const timer = setInterval(tick, ROOM_PAGE_MS);
  roomPager[roomId] = { page: cur, pages: pages.length, timer };
}

// ---------- Main ----------
async function loadData() {
  const resp = await fetch(DATA_URL, { cache: 'no-store' });
  if (!resp.ok) throw new Error(`Failed to fetch events.json: ${resp.status}`);
  const json = await resp.json();
  console.log('Loaded events.json', json);
  return json;
}

function prepareRoomsDOM(rooms) {
  const southWrap = document.getElementById('southRooms');
  const fieldWrap = document.getElementById('fieldhouseRooms');
  const northWrap = document.getElementById('northRooms');
  southWrap.innerHTML = '';
  fieldWrap.innerHTML = '';
  northWrap.innerHTML = '';

  const cardByRoom = Object.create(null);

  const south = rooms.filter(r => r.group === 'south').sort((a,b)=>Number(a.id)-Number(b.id));
  const field = rooms.filter(r => r.group === 'fieldhouse').sort((a,b)=>Number(a.id)-Number(b.id));
  const north = rooms.filter(r => r.group === 'north').sort((a,b)=>Number(a.id)-Number(b.id));

  for (const r of south) cardByRoom[r.id] = buildRoomCard(r.label || r.id, southWrap);
  for (const r of field) cardByRoom[r.id] = buildRoomCard(r.label || r.id, fieldWrap);
  for (const r of north) cardByRoom[r.id] = buildRoomCard(r.label || r.id, northWrap);

  return cardByRoom;
}

function normalizeSlots(rawSlots) {
  const out = [];
  for (const s of (rawSlots || [])) {
    if (!s) continue;
    const { roomId, startMin, endMin } = s;
    if (roomId == null || startMin == null || endMin == null) continue;

    const { org, contact, what } = normalizeOrgAndContact(s.title || '', s.subtitle || '');
    out.push({ roomId: String(roomId), startMin, endMin, org, contact, what });
  }
  return out;
}

function filterPast(slots, nowMin) {
  if (!HIDE_PAST) return slots;
  return slots.filter(s => s.endMin > nowMin);
}

function groupSlotsByRoom(slots) {
  const byRoom = new Map();
  for (const s of slots) {
    if (!byRoom.has(s.roomId)) byRoom.set(s.roomId, []);
    byRoom.get(s.roomId).push(s);
  }
  for (const arr of byRoom.values()) arr.sort((a,b)=>a.startMin - b.startMin || a.endMin - b.endMin);
  return byRoom;
}

async function init() {
  // header clock
  updateHeaderClock();
  setInterval(updateHeaderClock, CLOCK_TICK_MS);

  let data = { rooms: [], slots: [], dayStartMin: 360, dayEndMin: 1380 };
  try {
    data = await loadData();
  } catch (e) {
    console.error('Failed to load events.json:', e);
  }

  const cardByRoom = prepareRoomsDOM(data.rooms || []);
  const nowMin = nowMinutesLocal();

  // normalize + filter
  let slots = normalizeSlots(data.slots || []);
  slots = filterPast(slots, nowMin);

  // per-room dedupe + render
  const grouped = groupSlotsByRoom(slots);
  for (const [roomId, list] of grouped.entries()) {
    const deduped = dedupeWithinRoom(list);
    const card = cardByRoom[roomId];
    if (!card) continue;
    renderRoomPaged(card, roomId, deduped);
  }
}

document.addEventListener('DOMContentLoaded', init);
