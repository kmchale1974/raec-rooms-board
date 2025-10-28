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
 *  Text cleanup + parsing
 **************************/
const NAME_RX = /^[a-z' -]+$/i;

// returns {org, contact, isPersonTitle, isOrgPerson}
function parseTitle(titleRaw) {
  const title = (titleRaw || '').trim();

  // Split on the first comma only (org, person) OR (last, first)
  const parts = title.split(',').map(s => s.trim()).filter(Boolean);
  if (parts.length !== 2) {
    return { org: title, contact: null, isPersonTitle: false, isOrgPerson: false };
  }
  const left = parts[0];
  const right = parts[1];

  const leftWordCount = left.split(/\s+/).filter(Boolean).length;
  const rightWordCount = right.split(/\s+/).filter(Boolean).length;
  const leftAlpha = NAME_RX.test(left);
  const rightAlpha = NAME_RX.test(right);

  // PERSON pattern: "Last, First" (single-word last name on left, first is alpha words)
  const looksPerson = (leftWordCount === 1 && rightAlpha && rightWordCount >= 1 && rightWordCount <= 3);

  // ORG,PERSON pattern: left has 2+ words (org name), right looks like a human name
  const looksOrgPerson = (leftWordCount >= 2 && rightAlpha && rightWordCount >= 1 && rightWordCount <= 3);

  if (looksPerson) {
    return { org: null, contact: `${right} ${left}`.trim(), isPersonTitle: true, isOrgPerson: false };
  }
  if (looksOrgPerson) {
    return { org: left, contact: right, isPersonTitle: false, isOrgPerson: true };
  }
  // default: treat as org with no contact
  return { org: title, contact: null, isPersonTitle: false, isOrgPerson: false };
}

function cleanSubtitle(sub) {
  if (!sub) return '';
  let s = sub;

  // remove "Internal Hold..." phrases
  s = s.replace(/\binternal hold.*$/i, '').trim();

  // remove duplicated "Open Pickleball" if present
  s = s.replace(/\bopen\s+pickleball\b.*$/i, '').trim();

  // trim stray punctuation
  s = s.replace(/^[\-\–—:,.\s]+|[\-\–—:,.\s]+$/g, '');

  return s;
}

function normalizeWho(slot) {
  const title = slot.title || '';
  const subtitle = slot.subtitle || '';
  const lowerTitle = title.toLowerCase();
  const lowerSub = subtitle.toLowerCase();

  // 1) Pickleball rule
  if (lowerTitle.includes('pickleball') || lowerSub.includes('pickleball')) {
    // Bold: Open Pickleball
    // Line 2: cleaned subtitle (without "Internal Hold..." or duplicated phrase)
    const line2 = cleanSubtitle(subtitle);
    return { whoBold: 'Open Pickleball', whoLine2: line2 || null };
  }

  // 2) Catch Corner rule
  if (/catch\s*corner/i.test(title)) {
    let detail = subtitle || title;
    // strip leading "Catch Corner" and parens
    detail = detail.replace(/^catch\s*corner\s*\(?\s*/i, '');
    detail = detail.replace(/^\(+|\)+$/g, '');
    detail = cleanSubtitle(detail);
    return { whoBold: 'Catch Corner', whoLine2: detail || null };
  }

  // 3) Title parsing (Org, Person) or (Last, First)
  const { org, contact, isPersonTitle, isOrgPerson } = parseTitle(title);

  if (isPersonTitle) {
    // Person only: bold First Last; line 2 is the subtitle (if any)
    const line2 = cleanSubtitle(subtitle);
    return { whoBold: contact, whoLine2: line2 || null };
  }

  if (isOrgPerson) {
    // Org + contact: bold org; line 2: "Contact — subtitle?" (if subtitle exists)
    const line2Sub = cleanSubtitle(subtitle);
    const line2 = line2Sub ? `${contact} — ${line2Sub}` : contact;
    return { whoBold: org, whoLine2: line2 };
  }

  // 4) Fallback: bold the title, show cleaned subtitle if present
  const line2 = cleanSubtitle(subtitle);
  return { whoBold: org || title || '—', whoLine2: line2 || null };
}

/**************************
 *  Layout constants
 **************************/
const SOUTH_TILES = ['1A','1B','2A','2B'];
const FIELD_TILES = ['3','4','5','6','7','8'];
const NORTH_TILES = ['9A','9B','10A','10B'];

/**************************
 *  Slot distribution
 **************************/
function distributeSlots(rawSlots) {
  const active = (rawSlots || []).filter(notEnded);

  const perTile = {};
  const put = (tile, s) => { (perTile[tile] ||= []).push(s); };

  for (const s of active) {
    const r = String(s.roomId);
    if (['1','2','9','10'].includes(r)) {
      // Mirror numeric to A/B
      put(`${r}A`, s);
      put(`${r}B`, s);
    } else {
      // Fieldhouse remain numeric
      put(r, s);
    }
  }

  // De-duplicate within each tile (same time+title+subtitle)
  for (const k of Object.keys(perTile)) {
    const seen = new Set();
    perTile[k] = perTile[k].filter(sl => {
      const key = `${sl.startMin}|${sl.endMin}|${(sl.title||'').toLowerCase()}|${(sl.subtitle||'').toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  return perTile;
}

/**************************
 *  DOM helpers
 **************************/
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

/**************************
 *  Room tile renderer (paged + left slide)
 **************************/
function renderRoomTile(container, tileId, slots, maxPerPage) {
  const room = el('div', 'room');
  const header = el('div', 'roomHeader');
  const id = el('div', 'id', tileId);
  const count = el('div', 'count');
  header.append(id, count);
  room.appendChild(header);

  const eventsWrap = el('div', 'events');
  // ensure wrapper holds height even while slides are absolute
  eventsWrap.style.position = 'relative';
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
    slide.style.minHeight = '0';
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

  // Mount first slide in normal flow
  if (slides[0]) eventsWrap.appendChild(slides[0]);

  if (slides.length > 1) {
    let ix = 0;
    const INTERVAL = 8000; // 8s per page
    const TRANS = 450;     // ms

    function slideLeft(next) {
      const currEl = eventsWrap.firstElementChild;
      const nextEl = slides[next];

      // position next off-screen right
      nextEl.style.position = 'absolute';
      nextEl.style.inset = '0';
      nextEl.style.transform = 'translateX(100%)';
      nextEl.style.transition = `transform ${TRANS}ms ease`;
      eventsWrap.appendChild(nextEl);

      // animate both to slide left
      requestAnimationFrame(() => {
        if (currEl) {
          currEl.style.position = 'absolute';
          currEl.style.inset = '0';
          currEl.style.transition = `transform ${TRANS}ms ease`;
          currEl.style.transform = 'translateX(-100%)';
        }
        nextEl.style.transform = 'translateX(0%)';
      });

      // cleanup and reset next into normal flow so container doesn't collapse
      setTimeout(() => {
        if (currEl) eventsWrap.removeChild(currEl);
        nextEl.style.position = 'static';
        nextEl.style.inset = '';
        nextEl.style.transition = '';
        nextEl.style.transform = '';
      }, TRANS + 40);
    }

    setInterval(() => {
      ix = (ix + 1) % slides.length;
      slideLeft(ix);
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

  const perTile = distributeSlots(Array.isArray(data.slots) ? data.slots : []);

  // South: 1 event per A/B tile
  SOUTH_TILES.forEach(t => {
    renderRoomTile(south, t, perTile[t] || [], 1);
  });

  // Fieldhouse: 2 events per tile + pager
  FIELD_TILES.forEach(t => {
    renderRoomTile(fieldhouse, t, perTile[t] || [], 2);
  });

  // North: 1 event per A/B tile
  NORTH_TILES.forEach(t => {
    renderRoomTile(north, t, perTile[t] || [], 1);
  });
}

/**************************
 *  Init + periodic refresh
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

// refresh every 60s so ended events drop off + layout repaginates
setInterval(init, 60_000);
