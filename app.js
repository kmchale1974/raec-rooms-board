// app.js

/**************************
 *  Clock + date header
 **************************/
function updateClock() {
  const now = new Date();
  const optsDate = { weekday: 'long', month: 'long', day: 'numeric' };
  const optsTime = { hour: 'numeric', minute: '2-digit' };
  document.getElementById('headerDate').textContent =
    now.toLocaleDateString(undefined, optsDate);
  document.getElementById('headerClock').textContent =
    now.toLocaleTimeString(undefined, optsTime).toLowerCase();
}
setInterval(updateClock, 1000);
updateClock();

/**************************
 *  Fetch events.json
 **************************/
async function loadEvents() {
  const url = `./events.json?ts=${Date.now()}`;
  const resp = await fetch(url, { cache: 'no-store' });
  if (!resp.ok) throw new Error(`Failed to fetch ${url}: ${resp.status}`);
  const data = await resp.json();
  console.log('Loaded events.json', data);
  return data;
}

/**************************
 *  Time helpers
 **************************/
const PAD = (n) => String(n).padStart(2, '0');
function fmt12h(mins) {
  let h = Math.floor(mins / 60);
  const m = mins % 60;
  const ampm = h >= 12 ? 'pm' : 'am';
  h = h % 12; if (h === 0) h = 12;
  return `${h}:${PAD(m)}${ampm}`;
}
function timeRange(s, e) { return `${fmt12h(s)} - ${fmt12h(e)}`; }
function notEnded(slot) {
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  return slot.endMin > nowMin;
}

/**************************
 *  Text cleanup rules
 **************************/
function isLikelyPersonName(s) {
  // "Last, First" => person (no @, not too many commas)
  if (!s) return false;
  if (s.includes('@')) return false;
  const parts = s.split(',').map(t => t.trim()).filter(Boolean);
  if (parts.length !== 2) return false;
  // Heuristics: short-ish tokens
  const [last, first] = parts;
  const bothAlpha = /^[a-z' -]+$/i.test(last) && /^[a-z' -]+$/i.test(first);
  return bothAlpha && last.split(' ').length <= 2 && first.split(' ').length <= 3;
}

function normalizeWho(slot) {
  // Return {whoBold, whoLine2} to render
  let title = slot.title || '';
  let subtitle = slot.subtitle || '';

  // Pickleball: always "Open Pickleball"
  if (/pickleball/i.test(title) || /pickleball/i.test(subtitle)) {
    const cleaned = subtitle.replace(/internal hold.*$/i, '').trim();
    return { whoBold: 'Open Pickleball', whoLine2: cleaned || null };
  }

  // Catch Corner: normalize
  if (/catch\s*corner/i.test(title)) {
    // Bold "Catch Corner"
    let detail = subtitle || title;
    // remove "CatchCorner (" wrapper if present
    detail = detail.replace(/^catch\s*corner\s*\(?\s*/i, '');
    detail = detail.replace(/^\(+|\)+$/g, '');
    return { whoBold: 'Catch Corner', whoLine2: detail.trim() || null };
  }

  // Try "Org, Person" form → bold org, line2 person + (optional purpose)
  const parts = title.split(',').map(t => t.trim()).filter(Boolean);
  if (parts.length === 2 && !isLikelyPersonName(title)) {
    const org = parts[0];
    const maybePerson = parts[1];
    // If looks like a person name (has space and alphabetic), separate lines
    if (/\b[a-z]+\s+[a-z]+\b/i.test(maybePerson)) {
      const line2 = subtitle ? `${maybePerson} — ${subtitle}` : maybePerson;
      return { whoBold: org, whoLine2: line2 };
    }
  }

  // "Last, First" → "First Last"
  if (isLikelyPersonName(title)) {
    const [last, first] = title.split(',').map(s => s.trim());
    const person = `${first} ${last}`;
    return { whoBold: person, whoLine2: subtitle || null };
  }

  // default: bold title; subtitle as line2 if present
  return { whoBold: title, whoLine2: subtitle || null };
}

/**************************
 *  Room layout
 *  We explicitly render tiles for:
 *   South: 1A,1B,2A,2B (1 event each)
 *   Fieldhouse: 3,4,5,6,7,8 (2 events/pager)
 *   North: 9A,9B,10A,10B (1 event each)
 **************************/
const SOUTH_TILES = ['1A','1B','2A','2B'];
const FIELD_TILES = ['3','4','5','6','7','8'];
const NORTH_TILES = ['9A','9B','10A','10B'];

function numericRoomId(tileId) {
  // "1A" -> 1 ; "3" -> 3
  const n = parseInt(tileId, 10);
  return isNaN(n) ? null : n;
}

/**************************
 *  Slot distribution
 *  - Data slot.roomId is numeric (1..10) → mirror to A/B where needed
 *  - Hide ended
 *  - De-duplicate exact duplicates within same room/time/title/subtitle
 **************************/
function distributeSlots(rawSlots) {
  const active = rawSlots.filter(notEnded);

  // Build per-tile list
  const perTile = {};
  const push = (tile, s) => {
    (perTile[tile] ||= []).push(s);
  };

  for (const s of active) {
    const r = String(s.roomId);
    // South/North mirror into A/B
    if (['1','2','9','10'].includes(r)) {
      push(`${r}A`, s);
      push(`${r}B`, s);
    } else {
      // Fieldhouse numeric 3..8
      push(r, s);
    }
  }

  // De-dup within each tile
  for (const key of Object.keys(perTile)) {
    const seen = new Set();
    perTile[key] = perTile[key].filter(sl => {
      const k = `${sl.startMin}|${sl.endMin}|${(sl.title||'').toLowerCase()}|${(sl.subtitle||'').toLowerCase()}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  return perTile;
}

/**************************
 *  DOM builders
 **************************/
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function renderRoomTile(container, tileId, slots, maxPerPage) {
  // wrapper
  const room = el('div', 'room');
  const header = el('div', 'roomHeader');
  const id = el('div', 'id', tileId);
  const count = el('div', 'count');
  header.append(id, count);
  room.appendChild(header);

  // events pager container
  const eventsWrap = el('div', 'events');
  room.appendChild(eventsWrap);

  // sort by start time
  const sorted = (slots || []).slice().sort((a,b)=>a.startMin - b.startMin);

  // chunk into pages
  const pages = [];
  for (let i=0; i<sorted.length; i+=maxPerPage) {
    pages.push(sorted.slice(i, i+maxPerPage));
  }
  if (pages.length === 0) pages.push([]);

  count.textContent = pages[0].length ? `${sorted.length} event${sorted.length>1?'s':''}` : 'No events';

  // build slides
  const slides = pages.map(pageItems => {
    const slide = el('div', 'slide');
    slide.style.minHeight = '0';
    slide.style.display = 'flex';
    slide.style.flexDirection = 'column';
    slide.style.gap = '8px';

    pageItems.forEach(slot => {
      const { whoBold, whoLine2 } = normalizeWho(slot);
      const card = el('div', 'event');
      const who = el('div', 'who', whoBold || '—');
      const what = el('div', 'what', whoLine2 || '');
      const when = el('div', 'when', timeRange(slot.startMin, slot.endMin));
      card.append(who);
      if (whoLine2) card.append(what);
      card.append(when);
      slide.appendChild(card);
    });
    return slide;
  });

  // mount first slide
  if (slides[0]) eventsWrap.appendChild(slides[0]);

  // paginate with left-slide if more than 1 page
  if (slides.length > 1) {
    let ix = 0;
    const INTERVAL = 7000; // 7s
    const TRANS = 450;     // 0.45s

    eventsWrap.style.position = 'relative';
    eventsWrap.style.overflow = 'hidden';

    function show(next) {
      const currEl = eventsWrap.firstElementChild;
      const nextEl = slides[next];

      // position next off-screen right
      nextEl.style.position = 'absolute';
      nextEl.style.inset = '0';
      nextEl.style.transform = 'translateX(100%)';
      nextEl.style.transition = `transform ${TRANS}ms ease`;
      eventsWrap.appendChild(nextEl);

      // animate: current left, next in
      requestAnimationFrame(() => {
        if (currEl) {
          currEl.style.position = 'absolute';
          currEl.style.inset = '0';
          currEl.style.transition = `transform ${TRANS}ms ease`;
          currEl.style.transform = 'translateX(-100%)';
        }
        nextEl.style.transform = 'translateX(0%)';
      });

      setTimeout(() => {
        if (currEl) eventsWrap.removeChild(currEl);
      }, TRANS + 40);
    }

    setInterval(() => {
      const curr = ix;
      const next = (ix + 1) % slides.length;
      ix = next;
      show(next);
    }, INTERVAL);
  }

  container.appendChild(room);
}

/**************************
 *  Render whole board
 **************************/
function renderBoard(data) {
  const south = document.getElementById('southRooms');
  const fieldhouse = document.getElementById('fieldhouseRooms');
  const north = document.getElementById('northRooms');
  south.innerHTML = fieldhouse.innerHTML = north.innerHTML = '';

  // Distribute
  const perTile = distributeSlots(Array.isArray(data.slots) ? data.slots : []);

  // South (1A,1B,2A,2B) — 1 event per tile
  for (const t of SOUTH_TILES) {
    renderRoomTile(south, t, perTile[t] || [], 1);
  }

  // Fieldhouse (3..8) — 2 events per tile
  for (const t of FIELD_TILES) {
    renderRoomTile(fieldhouse, t, perTile[t] || [], 2);
  }

  // North (9A,9B,10A,10B) — 1 event per tile
  for (const t of NORTH_TILES) {
    renderRoomTile(north, t, perTile[t] || [], 1);
  }
}

/**************************
 *  Init + auto-refresh
 **************************/
async function init() {
  try {
    const data = await loadEvents();
    renderBoard(data);
  } catch (e) {
    console.error('Init failed:', e);
  }
}
document.addEventListener('DOMContentLoaded', init);

// Refresh from disk every 60 seconds so ended events fall off
setInterval(init, 60_000);
