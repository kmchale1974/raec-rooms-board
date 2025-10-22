// app.js — smooth paged grid with slide animation

const CLOCK_INTERVAL_MS = 1000 * 30;  // refresh header clock twice a minute
const ROTATE_MS         = 8000;       // per-room page dwell
const PER_PAGE_SOUTH    = 4;
const PER_PAGE_NORTH    = 4;
const PER_PAGE_FIELD    = 3;

// -------- utilities --------
const two = (n) => (n < 10 ? "0" + n : "" + n);
function fmt12h(mins) {
  // mins = minutes after midnight
  let h = Math.floor(mins / 60);
  const m = mins % 60;
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12; if (h === 0) h = 12;
  return `${h}:${two(m)} ${ampm}`;
}

function isPersonName(text) {
  // Very light heuristic: "Last, First" form and both tokens alphabetic
  if (!text || !text.includes(',')) return false;
  const [last, rest] = text.split(',', 2).map(s => s.trim());
  if (!last || !rest) return false;
  // common org hints
  const orgHints = ['club','basketball','volleyball','academy','elite','united','athletics','soccer','football','gym','llc','inc'];
  const low = text.toLowerCase();
  if (orgHints.some(k => low.includes(k))) return false;
  // simple alpha check
  return /^[a-zA-Z' \-]+$/.test(last) && /^[a-zA-Z' \-]+$/.test(rest);
}
function toFirstLast(text) {
  if (!isPersonName(text)) return text;
  const [last, rest] = text.split(',', 2).map(s => s.trim());
  return `${rest} ${last}`.replace(/\s+/g,' ').trim();
}

// slide animation swap
function animatePageSwap(container, newPageEl, { direction = 'left' } = {}) {
  const h = container.offsetHeight;
  container.style.minHeight = h + 'px';

  const old = container.querySelector('.roomPage');
  newPageEl.classList.add('roomPage');
  const enterClass = direction === 'left' ? 'page-enter-right' : 'page-enter-left';
  newPageEl.classList.add(enterClass);
  container.appendChild(newPageEl);

  requestAnimationFrame(() => {
    if (old) {
      old.classList.remove('page-enter-active', 'page-enter-left', 'page-enter-right');
      old.classList.add(direction === 'left' ? 'page-exit-left' : 'page-exit-right');
    }
    newPageEl.classList.add('page-enter-active');
  });

  const done = () => {
    old && old.remove();
    container.style.minHeight = '';
    container.removeEventListener('transitionend', onEnd, true);
  };
  const onEnd = (e) => { if (e.target === newPageEl) done(); };
  container.addEventListener('transitionend', onEnd, true);
  setTimeout(done, 1200); // safety
}

// -------- data loading --------
async function loadEvents() {
  const url = `./events.json?ts=${Date.now()}`;
  const resp = await fetch(url, { cache: 'no-store' });
  if (!resp.ok) throw new Error(`Failed to fetch ${url}: ${resp.status}`);
  const data = await resp.json();
  console.log('Loaded events.json', data);
  return data;
}

// Filter out past events: only show ones that have not ended
function filterFutureSlots(slots, nowMin) {
  const keep = (slots || []).filter(s => (s.endMin ?? 0) >= nowMin);
  console.log(`Slots filtered by time: ${(slots||[]).length} -> ${keep.length} (now=${nowMin})`);
  return keep;
}

// Group slots by roomId
function byRoom(slots) {
  const map = new Map();
  for (const s of slots) {
    if (!map.has(s.roomId)) map.set(s.roomId, []);
    map.get(s.roomId).push(s);
  }
  return map;
}

// -------- rendering --------
function renderHeader() {
  const d = new Date();
  const opts = { weekday:'long', month:'long', day:'numeric' };
  document.getElementById('headerDate').textContent =
    d.toLocaleDateString(undefined, opts);
  document.getElementById('headerClock').textContent =
    d.toLocaleTimeString(undefined, { hour:'numeric', minute:'2-digit' });
}

function buildRoomShell(room) {
  const el = document.createElement('div');
  el.className = 'room';
  el.dataset.roomId = room.id;

  // header
  const header = document.createElement('div');
  header.className = 'roomHeader';
  const id = document.createElement('div'); id.className = 'id'; id.textContent = room.label;
  const count = document.createElement('div'); count.className = 'count'; count.textContent = '';
  header.appendChild(id); header.appendChild(count);

  // pager
  const pager = document.createElement('div');
  pager.className = 'roomPager';
  pager.id = `pager-${room.id}`;

  el.appendChild(header);
  el.appendChild(pager);
  return el;
}

function eventNode(slot) {
  const div = document.createElement('div');
  div.className = 'event';

  // Who (title) might contain org + person, e.g. "Illinois Flight, Brandon Brown"
  const who = document.createElement('div');
  who.className = 'who';

  // Split on first comma to style org + contact
  const title = slot.title || '';
  if (title.includes(',')) {
    const [org, contactRaw] = title.split(',', 2).map(s => s.trim());
    const strong = document.createElement('strong');
    strong.textContent = org;
    who.appendChild(strong);

    const contact = contactRaw ? toFirstLast(contactRaw) : '';
    if (contact) {
      const br = document.createElement('div');
      br.className = 'what';
      br.textContent = contact;
      div.appendChild(who);
      div.appendChild(br);
    } else {
      div.appendChild(who);
    }
  } else {
    const strong = document.createElement('strong');
    strong.textContent = title;
    who.appendChild(strong);
    div.appendChild(who);
  }

  // What (subtitle)
  const whatText = slot.subtitle || '';
  if (whatText) {
    const what = document.createElement('div');
    what.className = 'what';
    what.textContent = whatText;
    div.appendChild(what);
  }

  // When (inside the chip; we don’t repeat time elsewhere)
  const when = document.createElement('div');
  when.className = 'when';
  when.textContent = `${fmt12h(slot.startMin)} – ${fmt12h(slot.endMin)}`;
  div.appendChild(when);

  return div;
}

function paginate(arr, perPage) {
  const pages = [];
  for (let i = 0; i < arr.length; i += perPage) {
    pages.push(arr.slice(i, i + perPage));
  }
  return pages.length ? pages : [[]];
}

function renderRoomPaged(container, room, events, perPage, rotateMs) {
  // Show how many items total
  const headerCount = container.parentElement.querySelector('.count');
  headerCount.textContent = events.length ? `${events.length} event${events.length>1?'s':''}` : '';

  const pages = paginate(events, perPage);
  let idx = 0;

  function buildPageEl(items) {
    const page = document.createElement('div');
    page.className = 'roomPage';
    for (const it of items) page.appendChild(eventNode(it));
    return page;
  }

  // initial mount
  container.classList.add('roomPager');
  container.dataset.lastPageIndex = '0';
  animatePageSwap(container, buildPageEl(pages[0]), { direction: 'left' });

  if (pages.length <= 1) return; // no rotation needed

  // rotate
  if (container._rotTimer) clearInterval(container._rotTimer);
  container._rotTimer = setInterval(() => {
    const prev = idx;
    idx = (idx + 1) % pages.length;
    const dir = idx > prev ? 'left' : 'right';
    animatePageSwap(container, buildPageEl(pages[idx]), { direction: dir });
  }, rotateMs);
}

function mountRooms(rooms) {
  // build containers in proper groups
  const southEl = document.getElementById('southRooms');
  const fieldEl = document.getElementById('fieldhouseRooms');
  const northEl = document.getElementById('northRooms');

  southEl.innerHTML = ''; fieldEl.innerHTML = ''; northEl.innerHTML = '';

  for (const r of rooms) {
    const shell = buildRoomShell(r);
    if (r.group === 'south') southEl.appendChild(shell);
    else if (r.group === 'fieldhouse') fieldEl.appendChild(shell);
    else if (r.group === 'north') northEl.appendChild(shell);
  }
}

function renderAll(rooms, slots) {
  mountRooms(rooms);

  const now = new Date();
  const nowMin = now.getHours()*60 + now.getMinutes();
  const futureSlots = filterFutureSlots(slots, nowMin);
  const map = byRoom(futureSlots);

  for (const r of rooms) {
    const roomSlots = (map.get(r.id) || [])
      .sort((a,b) => (a.startMin - b.startMin) || ((a.title||'').localeCompare(b.title||'')));

    const pager = document.getElementById(`pager-${r.id}`);
    const perPage =
      r.group === 'fieldhouse' ? PER_PAGE_FIELD :
      r.group === 'south'      ? PER_PAGE_SOUTH :
                                 PER_PAGE_NORTH;

    renderRoomPaged(pager, r, roomSlots, perPage, ROTATE_MS);
  }
}

// -------- boot --------
async function init() {
  renderHeader();
  setInterval(renderHeader, CLOCK_INTERVAL_MS);

  let data;
  try {
    data = await loadEvents();
  } catch (e) {
    console.error('Failed to load events.json', e);
    return;
  }

  // Defensive defaults
  const rooms = Array.isArray(data.rooms) ? data.rooms : [];
  const slots = Array.isArray(data.slots) ? data.slots : [];

  renderAll(rooms, slots);

  // Optional: refresh board every 5 minutes to pick up new events.json
  setInterval(async () => {
    try {
      const fresh = await loadEvents();
      const fr = Array.isArray(fresh.rooms) ? fresh.rooms : rooms;
      const fs = Array.isArray(fresh.slots) ? fresh.slots : [];
      renderAll(fr, fs);
    } catch {}
  }, 5 * 60 * 1000);
}

document.addEventListener('DOMContentLoaded', init);
