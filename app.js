// app.js

/*********************
 * Clock + date
 *********************/
function updateClock() {
  const now = new Date();
  const dateFmt = { weekday: 'long', month: 'long', day: 'numeric' };
  const timeFmt = { hour: 'numeric', minute: '2-digit' };
  const d = document.getElementById('headerDate');
  const t = document.getElementById('headerClock');
  if (d) d.textContent = now.toLocaleDateString(undefined, dateFmt);
  if (t) t.textContent = now.toLocaleTimeString(undefined, timeFmt).toLowerCase();
}
setInterval(updateClock, 1000);
updateClock();

/*********************
 * Fetch events.json
 *********************/
async function loadEvents() {
  const url = `./events.json?ts=${Date.now()}`;
  const resp = await fetch(url, { cache: 'no-store' });
  if (!resp.ok) throw new Error(`Failed to fetch ${url}: ${resp.status}`);
  const data = await resp.json();
  console.log('Loaded events.json', data);
  return data;
}

/*********************
 * Time helpers
 *********************/
const PAD = n => String(n).padStart(2, '0');
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

/*********************
 * Text rules
 *********************/
const NAME_RX = /^[a-z' -]+$/i;
function toFirstLast(last, first) {
  const L = (last || '').trim();
  const F = (first || '').trim();
  return F && L ? `${F} ${L}` : (F || L || '');
}

function cleanSubtitle(sub) {
  if (!sub) return '';
  let s = sub;
  // remove “Internal Hold …”
  s = s.replace(/\binternal hold.*$/i, '').trim();
  // remove duplicated “Open Pickleball …”
  s = s.replace(/\bopen\s+pickleball\b.*$/i, '').trim();
  // trim punctuation
  s = s.replace(/^[\-\–—:,.\s]+|[\-\–—:,.\s]+$/g, '');
  return s;
}

// Title parser for raw “X, Y”
function parseTitleRaw(titleRaw) {
  const title = (titleRaw || '').trim();
  const parts = title.split(',').map(s => s.trim()).filter(Boolean);
  if (parts.length !== 2) {
    return { org: title || null, contact: null, isPerson: false, isOrgPerson: false };
  }
  const left = parts[0];      // could be Last OR Org
  const right = parts[1];     // could be First OR Contact
  const leftWords = left.split(/\s+/).filter(Boolean).length;
  const rightWords = right.split(/\s+/).filter(Boolean).length;

  const leftIsNamey = NAME_RX.test(left);
  const rightIsNamey = NAME_RX.test(right);

  const looksPerson = (leftWords === 1 && rightIsNamey && rightWords >= 1 && rightWords <= 3);
  const looksOrgPerson = (leftWords >= 2 && rightIsNamey && rightWords >= 1 && rightWords <= 3);

  if (looksPerson) {
    return { org: null, contact: toFirstLast(left, right), isPerson: true, isOrgPerson: false };
  }
  if (looksOrgPerson) {
    return { org: left, contact: right, isPerson: false, isOrgPerson: true };
  }
  return { org: title || null, contact: null, isPerson: false, isOrgPerson: false };
}

/**
 * normalizeWho(slot):
 * - Honors backend-provided slot.org/slot.contact if present (best signal)
 * - Pickleball rule
 * - Catch Corner rule
 * - Fallback to raw-title parsing
 */
function normalizeWho(slot) {
  const title = slot.title || '';
  const subtitle = slot.subtitle || '';
  const lowerTitle = title.toLowerCase();
  const lowerSub = subtitle.toLowerCase();

  // 1) Pickleball
  if (lowerTitle.includes('pickleball') || lowerSub.includes('pickleball')) {
    const line2 = cleanSubtitle(subtitle);
    return { whoBold: 'Open Pickleball', whoLine2: line2 || null };
  }

  // 2) Catch Corner
  if (/catch\s*corner/i.test(title)) {
    let detail = subtitle || title;
    detail = detail.replace(/^catch\s*corner\s*\(?\s*/i, '');
    detail = detail.replace(/^\(+|\)+$/g, '');
    detail = cleanSubtitle(detail);
    return { whoBold: 'Catch Corner', whoLine2: detail || null };
  }

  // 3) Prefer explicit fields from transform (if present)
  // Cases:
  //   A) org + contact  -> bold org, line2 "Contact — subtitle?"
  //   B) contact only   -> bold First Last (if title looked like "Last, First"; else contact), line2 subtitle
  //   C) org only       -> bold org, line2 subtitle
  if (slot.org && slot.contact) {
    // If org seems like a person (rare), still present org on top per your preference.
    const line2Sub = cleanSubtitle(subtitle);
    const line2 = line2Sub ? `${slot.contact} — ${line2Sub}` : slot.contact;
    return { whoBold: slot.org, whoLine2: line2 };
  }
  if (slot.contact && !slot.org) {
    // If title was “Last, First”, make sure we show “First Last”
    const parsed = parseTitleRaw(title);
    const personName = parsed.isPerson ? parsed.contact : slot.contact;
    const line2 = cleanSubtitle(subtitle);
    return { whoBold: personName || slot.contact, whoLine2: line2 || null };
  }
  if (slot.org && !slot.contact) {
    const line2 = cleanSubtitle(subtitle);
    return { whoBold: slot.org, whoLine2: line2 || null };
  }

  // 4) Fallback to parsing the raw title
  const parsed = parseTitleRaw(title);
  if (parsed.isPerson) {
    const line2 = cleanSubtitle(subtitle);
    return { whoBold: parsed.contact, whoLine2: line2 || null };
  }
  if (parsed.isOrgPerson) {
    const line2Sub = cleanSubtitle(subtitle);
    const line2 = line2Sub ? `${parsed.contact} — ${line2Sub}` : parsed.contact;
    return { whoBold: parsed.org, whoLine2: line2 };
  }
  const line2 = cleanSubtitle(subtitle);
  return { whoBold: parsed.org || title || '—', whoLine2: line2 || null };
}

/*********************
 * Layout + buckets
 *********************/
const SOUTH_TILES = ['1A','1B','2A','2B'];
const FIELD_TILES = ['3','4','5','6','7','8'];
const NORTH_TILES = ['9A','9B','10A','10B'];

function distributeSlots(rawSlots) {
  const active = (rawSlots || []).filter(notEnded);
  const perTile = {};
  const put = (tile, s) => { (perTile[tile] ||= []).push(s); };

  for (const s of active) {
    const r = String(s.roomId);
    if (['1','2','9','10'].includes(r)) {
      put(`${r}A`, s);
      put(`${r}B`, s);
    } else {
      put(r, s); // fieldhouse numeric tiles
    }
  }

  // de-dupe within each tile
  for (const k of Object.keys(perTile)) {
    const seen = new Set();
    perTile[k] = perTile[k].filter(sl => {
      const key = `${sl.startMin}|${sl.endMin}|${(sl.title||'').toLowerCase()}|${(sl.subtitle||'').toLowerCase()}|${(sl.org||'').toLowerCase()}|${(sl.contact||'').toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  return perTile;
}

/*********************
 * DOM helper
 *********************/
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

/*********************
 * Smooth left-slide pager
 *********************/
/**
 * Mounts slides and animates *always left* with a smoother feel:
 * - Uses translate3d for GPU
 * - Sets both slides to absolute, forces reflow, then animates
 * - Easing tuned for smoothness
 */
function runPager(eventsWrap, slides, intervalMs = 8000, transMs = 600) {
  if (slides.length <= 1) {
    // Single (or none): just ensure the one slide is in normal flow
    if (slides[0] && !eventsWrap.contains(slides[0])) eventsWrap.appendChild(slides[0]);
    return;
  }

  // Ensure container is a viewport
  eventsWrap.style.position = 'relative';
  eventsWrap.style.overflow = 'hidden';

  // Start with first slide in normal flow
  let curr = slides[0];
  if (!eventsWrap.contains(curr)) eventsWrap.appendChild(curr);

  function slideLeft(next) {
    const nextEl = slides[next];

    // Prepare both slides
    // Current: make absolute at 0
    curr.style.position = 'absolute';
    curr.style.inset = '0';
    curr.style.transform = 'translate3d(0,0,0)';
    curr.style.willChange = 'transform';

    // Next: start off-screen right
    nextEl.style.position = 'absolute';
    nextEl.style.inset = '0';
    nextEl.style.transform = 'translate3d(100%,0,0)';
    nextEl.style.willChange = 'transform';
    eventsWrap.appendChild(nextEl);

    // Force reflow before animating
    // eslint-disable-next-line no-unused-expressions
    nextEl.offsetHeight;

    // Animate both
    const ease = 'cubic-bezier(.22,.61,.36,1)';
    curr.style.transition = `transform ${transMs}ms ${ease}`;
    nextEl.style.transition = `transform ${transMs}ms ${ease}`;

    requestAnimationFrame(() => {
      curr.style.transform = 'translate3d(-100%,0,0)';
      nextEl.style.transform = 'translate3d(0,0,0)';
    });

    // Cleanup after transition
    setTimeout(() => {
      // Remove the old slide, put the new slide into normal flow
      if (eventsWrap.contains(curr)) eventsWrap.removeChild(curr);
      nextEl.style.position = 'static';
      nextEl.style.inset = '';
      nextEl.style.transition = '';
      nextEl.style.transform = '';
      nextEl.style.willChange = '';

      curr = nextEl; // new current
    }, transMs + 40);
  }

  let ix = 0;
  setInterval(() => {
    ix = (ix + 1) % slides.length;
    slideLeft(ix);
  }, intervalMs);
}

/*********************
 * Render one room
 *********************/
function renderRoomTile(container, tileId, slots, maxPerPage) {
  const room = el('div', 'room');
  const header = el('div', 'roomHeader');
  const id = el('div', 'id', tileId);
  const count = el('div', 'count');
  header.append(id, count);
  room.appendChild(header);

  const eventsWrap = el('div', 'events');
  // keep some height so pager looks stable
  eventsWrap.style.minHeight = '1px';
  room.appendChild(eventsWrap);

  const sorted = (slots || []).slice().sort((a,b)=>a.startMin - b.startMin);
  const pages = [];
  for (let i=0; i<sorted.length; i+=maxPerPage) {
    pages.push(sorted.slice(i, i+maxPerPage));
  }
  if (pages.length === 0) pages.push([]);

  count.textContent = sorted.length ? `${sorted.length} event${sorted.length>1?'s':''}` : 'No events';

  const slides = pages.map(items => {
    const slide = el('div', 'slide');
    slide.style.display = 'flex';
    slide.style.flexDirection = 'column';
    slide.style.gap = '8px';

    items.forEach(slot => {
      const { whoBold, whoLine2 } = normalizeWho(slot);
      const card = el('div', 'event');
      const who = el('div', 'who', whoBold || '—');
      card.appendChild(who);
      if (whoLine2) {
        const what = el('div', 'what', whoLine2);
        card.appendChild(what);
      }
      const when = el('div', 'when', timeRange(slot.startMin, slot.endMin));
      card.appendChild(when);
      slide.appendChild(card);
    });

    return slide;
  });

  // Mount/pager
  if (slides.length === 1) {
    eventsWrap.appendChild(slides[0]);
  } else {
    // start with first
    eventsWrap.appendChild(slides[0]);
    runPager(eventsWrap, slides, 8000, 650); // slightly longer + eased
  }

  container.appendChild(room);
}

/*********************
 * Render board
 *********************/
function renderBoard(data) {
  const south = document.getElementById('southRooms');
  const fieldhouse = document.getElementById('fieldhouseRooms');
  const north = document.getElementById('northRooms');
  if (!south || !fieldhouse || !north) return;

  south.innerHTML = fieldhouse.innerHTML = north.innerHTML = '';

  const perTile = distributeSlots(Array.isArray(data.slots) ? data.slots : []);

  // South: 1 per page
  SOUTH_TILES.forEach(t => {
    renderRoomTile(south, t, perTile[t] || [], 1);
  });

  // Fieldhouse: 2 per page
  FIELD_TILES.forEach(t => {
    renderRoomTile(fieldhouse, t, perTile[t] || [], 2);
  });

  // North: 1 per page
  NORTH_TILES.forEach(t => {
    renderRoomTile(north, t, perTile[t] || [], 1);
  });
}

/*********************
 * Init + refresh
 *********************/
async function init() {
  try {
    const data = await loadEvents();
    renderBoard(data);
  } catch (e) {
    console.error('Init failed:', e);
  }
}
document.addEventListener('DOMContentLoaded', init);
// refresh every 60s so ended events fall off and pages repaginate
setInterval(init, 60_000);
