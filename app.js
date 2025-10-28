// app.js — smooth slide-left paging + name formatting + pickleball rule

/* =========================
   0) Utilities
========================= */

// 12-hour time
function to12h(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  const ampm = h >= 12 ? 'pm' : 'am';
  let hh = h % 12;
  if (hh === 0) hh = 12;
  return `${hh}:${m.toString().padStart(2, '0')}${ampm}`;
}

// Person-name detection & formatting
// Heuristics:
// - If `org` exists and isn't same as `contact`, treat `org` as bold line.
// - If `contact` looks like "Last, First" or two simple tokens, show "First Last" as secondary.
// - If there’s no org, but `title` looks like "Last, First", flip to "First Last" as the title.
function isLikelyPersonName(s) {
  if (!s) return false;
  // Ignore obvious org hints
  const orgHints = ['club', 'athletic', 'athletics', 'basketball', 'volleyball', 'elite', 'academy', 'flight', 'omona', 'empower', 'chicago sport', 'pink elite', 'catch corner'];
  const lower = s.toLowerCase();
  if (orgHints.some(h => lower.includes(h))) return false;

  // Comma form "Last, First"
  if (s.includes(',')) {
    const parts = s.split(',').map(x => x.trim()).filter(Boolean);
    if (parts.length === 2 && /^[A-Za-z'.-]+$/.test(parts[0]) && /^[A-Za-z'.-]+(?: [A-Za-z'.-]+)*$/.test(parts[1])) {
      return true;
    }
  }
  // Two tokens
  const tokens = s.split(/\s+/).filter(Boolean);
  if (tokens.length === 2 && tokens.every(t => /^[A-Za-z'.-]+$/.test(t))) return true;

  return false;
}
function flipName(lastCommaFirst) {
  const [last, first] = lastCommaFirst.split(',').map(s => s.trim());
  if (first && last) return `${first} ${last}`;
  return lastCommaFirst;
}

// “Open Pickleball” rule
function formatPickleball(slot) {
  // If anything screams “pickleball” or the RAEC hold that stands for it, normalize:
  const t = `${slot.title || ''} ${slot.subtitle || ''}`.toLowerCase();
  if (
    t.includes('pickleball') ||
    (slot.title || '').includes('RAEC Front Desk, Rentals - On Hold') ||
    (slot.subtitle || '').toLowerCase().includes('open pickleball')
  ) {
    return { title: 'Open Pickleball', subtitle: '' };
  }
  return null;
}

/* =========================
   1) Data loading
========================= */

async function loadData() {
  const url = `./events.json?ts=${Date.now()}`;
  const resp = await fetch(url, { cache: 'no-store' });
  if (!resp.ok) throw new Error(`Failed to fetch events.json: ${resp.status} ${resp.statusText}`);
  const data = await resp.json();
  console.log('Loaded events.json', data);
  return data;
}

/* =========================
   2) Rendering helpers
========================= */

function ensureStageFit() {
  // We keep your fixed 1920x1080 in index.html; this centers and scales without clipping.
  const STAGE_W = 1920, STAGE_H = 1080;
  function fit() {
    const sx = window.innerWidth / STAGE_W;
    const sy = window.innerHeight / STAGE_H;
    const s = Math.min(sx, sy);
    const stage = document.querySelector('.stage');
    if (!stage) return;
    stage.style.transform = `scale(${s})`;
    stage.style.transformOrigin = 'top center';
    document.body.style.minHeight = (STAGE_H * s) + 'px';
    document.documentElement.style.setProperty('--stage-scale', s.toString());
  }
  window.addEventListener('resize', fit);
  window.addEventListener('orientationchange', fit);
  fit();
}

function headerClock() {
  const dateEl = document.getElementById('headerDate');
  const clockEl = document.getElementById('headerClock');
  function tick() {
    const now = new Date();
    const dateFmt = now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
    let hours = now.getHours();
    const minutes = now.getMinutes().toString().padStart(2, '0');
    const ampm = hours >= 12 ? 'pm' : 'am';
    hours = hours % 12; if (hours === 0) hours = 12;
    if (dateEl) dateEl.textContent = dateFmt;
    if (clockEl) clockEl.textContent = `${hours}:${minutes}${ampm}`;
  }
  tick();
  setInterval(tick, 1000);
}

/* =========================
   3) Slot formatting (names/orgs/pickleball)
========================= */

function formatDisplay(slot) {
  // Pickleball override
  const pb = formatPickleball(slot);
  if (pb) {
    return {
      title: pb.title,
      subtitle: pb.subtitle,
      when: `${to12h(slot.startMin)}–${to12h(slot.endMin)}`
    };
  }

  // Prefer structured org/contact if present (your transform script often sets these)
  let org = slot.org?.trim() || '';
  let contact = slot.contact?.trim() || '';
  let title = slot.title?.trim() || '';
  let subtitle = slot.subtitle?.trim() || '';

  // If we don’t have org/contact, try to parse title like “Org, Person” or “Last, First”
  if (!org && !contact && title.includes(',')) {
    const parts = title.split(',').map(s => s.trim()).filter(Boolean);
    if (parts.length >= 2) {
      // Heuristic: first part more “org-like”, second part “person-like”
      if (!isLikelyPersonName(parts[0]) && isLikelyPersonName(parts[1])) {
        org = parts[0];
        contact = parts.slice(1).join(', ');
      } else if (isLikelyPersonName(parts[0])) {
        // Person only
        contact = parts.join(', ');
      } else {
        // Fallback: keep original
      }
    }
  }

  // If contact is like "Last, First" → flip
  if (contact && contact.includes(',') && isLikelyPersonName(contact)) {
    contact = flipName(contact);
  }

  // If the “org” looks like a person and isn’t a known team, treat as person-only
  if (org && isLikelyPersonName(org)) {
    if (org.includes(',')) org = flipName(org);
    if (!contact) { // person only
      title = org;
      org = '';
    }
  }

  // If org exists and is different from contact, bold org + contact normal; else just bold title/name
  let top = '', mid = '';
  if (org) {
    top = org;
    mid = contact || subtitle || '';
  } else if (title) {
    // If title itself is a name like “Last, First”, flip it
    if (title.includes(',') && isLikelyPersonName(title)) {
      title = flipName(title);
    }
    top = title;
    mid = subtitle || contact || '';
  } else {
    top = contact || subtitle || '—';
  }

  // Tidy Catch Corner rule: “Catch Corner” bold; rest (without “Internal Holds”) as subtitle
  if (top.toLowerCase().includes('catch corner')) {
    top = 'Catch Corner';
    mid = (mid || subtitle || '').replace(/\binternal holds?\b/ig, '').trim();
    mid = mid.replace(/^\s*[-–,:]\s*/, '').trim();
  }

  return {
    title: top,
    subtitle: mid,
    when: `${to12h(slot.startMin)}–${to12h(slot.endMin)}`
  };
}

/* =========================
   4) Paging (always slide left)
========================= */

// Creates a pager inside a room cell.
// pages: array of arrays, each inner array is the events to show on that page.
// opts = { intervalMs, startStaggerMs }
function mountPager(container, pages, opts = {}) {
  const interval = opts.intervalMs ?? 8000;   // 8s per page
  const stagger  = opts.startStaggerMs ?? 0;  // per-room stagger
  let pageIdx = 0;
  let running = false;

  container.classList.add('roomPager');
  container.innerHTML = ''; // clean

  // Create page elements
  const pageEls = pages.map((evs, i) => {
    const page = document.createElement('div');
    page.className = 'roomPage';
    // initial offscreen to the right
    page.style.transform = 'translateX(100%)';
    page.style.opacity = '0';
    page.style.transition = 'transform 600ms ease, opacity 600ms ease';

    // render events into this page
    page.appendChild(renderEventsList(evs));
    container.appendChild(page);
    return page;
  });

  function show(i, directionLeftAlways = true) {
    // Always slide left: old page -> translateX(-100%), new page starts at +100% -> 0
    const prev = pageEls[pageIdx];
    const next = pageEls[i];

    if (prev === next) {
      // First paint: bring in from right
      next.style.transform = 'translateX(0%)';
      next.style.opacity = '1';
      pageIdx = i;
      return;
    }

    // Move next to right instantly (prep), then animate in
    next.style.transition = 'none';
    next.style.transform = 'translateX(100%)';
    next.style.opacity = '0';
    // Force reflow to apply the “none” transform before animating
    void next.offsetWidth;

    // Animate both
    prev.style.transition = 'transform 600ms ease, opacity 600ms ease';
    next.style.transition = 'transform 600ms ease, opacity 600ms ease';

    // old page slides left
    prev.style.transform = 'translateX(-100%)';
    prev.style.opacity = '0';

    // next page slides from right into center
    next.style.transform = 'translateX(0%)';
    next.style.opacity = '1';

    pageIdx = i;
  }

  function tick() {
    if (!running || pageEls.length <= 1) return;
    const nextIdx = (pageIdx + 1) % pageEls.length;
    show(nextIdx, true);
  }

  // Start after a stagger to desync rooms
  setTimeout(() => {
    running = true;
    // First show page 0
    show(0, true);
    if (pageEls.length > 1) {
      setInterval(tick, interval);
    }
  }, stagger);
}

/* Render events list into a page (2 events vertical stack) */
function renderEventsList(events) {
  const wrap = document.createElement('div');
  wrap.className = 'eventsPageStack';
  // Style here in case CSS isn’t updated yet
  wrap.style.display = 'flex';
  wrap.style.flexDirection = 'column';
  wrap.style.gap = '10px';
  wrap.style.height = '100%';

  events.forEach(ev => {
    const { title, subtitle, when } = formatDisplay(ev);

    const card = document.createElement('div');
    card.className = 'event';
    card.style.background = 'var(--chip)';
    card.style.border = '1px solid var(--grid)';
    card.style.borderRadius = '12px';
    card.style.padding = '10px 12px';
    card.style.display = 'flex';
    card.style.flexDirection = 'column';
    card.style.gap = '6px';
    card.style.minHeight = 0;

    const who = document.createElement('div');
    who.className = 'who';
    who.style.fontSize = '18px';
    who.style.fontWeight = '800';
    who.style.lineHeight = '1.1';
    who.textContent = title;

    const what = document.createElement('div');
    what.className = 'what';
    what.style.fontSize = '15px';
    what.style.color = 'var(--muted)';
    what.style.lineHeight = '1.2';
    what.textContent = subtitle || '';

    const whenEl = document.createElement('div');
    whenEl.className = 'when';
    whenEl.style.fontSize = '14px';
    whenEl.style.color = '#b7c0cf';
    whenEl.style.fontWeight = '600';
    whenEl.textContent = when;

    card.appendChild(who);
    if (what.textContent) card.appendChild(what);
    card.appendChild(whenEl);

    wrap.appendChild(card);
  });

  // Spacer to push content up a bit (avoid bottom clipping)
  const flexSpacer = document.createElement('div');
  flexSpacer.style.flex = '1 1 auto';
  wrap.appendChild(flexSpacer);

  return wrap;
}

/* =========================
   5) Main render
========================= */

function renderRoomsShell() {
  // Assumes index.html has:
  // #southRooms (1A/1B, 2A/2B), #fieldhouseRooms (3..8 grid), #northRooms (9A/9B, 10A/10B)
  const south = document.getElementById('southRooms');
  const field = document.getElementById('fieldhouseRooms');
  const north = document.getElementById('northRooms');

  if (south) {
    south.innerHTML = '';
    // Row 1: 1A 1B
    south.appendChild(roomCard('1A')); south.appendChild(roomCard('1B'));
    // Row 2: 2A 2B
    south.appendChild(roomCard('2A')); south.appendChild(roomCard('2B'));
  }
  if (field) {
    field.innerHTML = '';
    // 3..8 (2 rows x 3 cols)
    ['3','4','5','6','7','8'].forEach(id => field.appendChild(roomCard(id)));
  }
  if (north) {
    north.innerHTML = '';
    // Row 1: 9A 9B
    north.appendChild(roomCard('9A')); north.appendChild(roomCard('9B'));
    // Row 2: 10A 10B
    north.appendChild(roomCard('10A')); north.appendChild(roomCard('10B'));
  }
}

function roomCard(id) {
  const card = document.createElement('div');
  card.className = 'room';
  card.style.border = '1px solid var(--grid)';
  card.style.borderRadius = '14px';
  card.style.padding = '14px';
  card.style.display = 'flex';
  card.style.flexDirection = 'column';
  card.style.gap = '10px';
  card.style.minHeight = 0;
  card.style.overflow = 'hidden';
  card.style.background = 'linear-gradient(180deg, rgba(255,255,255,0.02), rgba(0,0,0,0))';

  const hdr = document.createElement('div');
  hdr.className = 'roomHeader';
  hdr.style.display = 'flex';
  hdr.style.alignItems = 'center';
  hdr.style.justifyContent = 'space-between';
  hdr.style.gap = '12px';
  hdr.style.borderBottom = '1px dashed var(--grid)';
  hdr.style.paddingBottom = '8px';

  const idEl = document.createElement('div');
  idEl.className = 'id';
  idEl.style.fontSize = '28px';
  idEl.style.fontWeight = '800';
  idEl.style.letterSpacing = '.04em';
  idEl.textContent = id;

  const countEl = document.createElement('div');
  countEl.className = 'count';
  countEl.style.fontSize = '13px';
  countEl.style.color = 'var(--muted)';
  countEl.textContent = '';

  hdr.appendChild(idEl);
  hdr.appendChild(countEl);

  const pagerHost = document.createElement('div');
  pagerHost.className = 'events'; // will be converted to a pager
  pagerHost.style.flex = '1 1 auto';
  pagerHost.style.overflow = 'hidden';

  card.appendChild(hdr);
  card.appendChild(pagerHost);

  // Attach a small API so we can set the count and mount the pager later
  card._setCount = (n) => { countEl.textContent = n ? `${n} event${n>1?'s':''}` : ''; };
  card._pagerHost = pagerHost;

  return card;
}

function chunk(arr, size) {
  const out = [];
  for (let i=0;i<arr.length;i+=size) out.push(arr.slice(i, i+size));
  return out;
}

// Decide how many items per page per room type
function perPageForRoom(id) {
  // A/B rooms: show 1 at a time for readability (paging will rotate)
  if (/^(1|2|9|10)[AB]$/.test(id)) return 1;
  // Single-number fieldhouse rooms: 2 per page
  return 2;
}

function findRoomCard(id) {
  // Search for a .room with header text == id
  const rooms = Array.from(document.querySelectorAll('.room'));
  return rooms.find(r => r.querySelector('.roomHeader .id')?.textContent === id) || null;
}

/* =========================
   6) Glue it together
========================= */

async function init() {
  ensureStageFit();
  headerClock();
  renderRoomsShell();

  const data = await loadData();

  // Filter to “now” (and near-future) slots; also drop past-ended
  const nowMin = (() => {
    const d = new Date();
    return d.getHours()*60 + d.getMinutes();
  })();

  // Only show slots that haven’t ended yet
  let slots = (data.slots || []).filter(s => (s.endMin ?? 1440) > nowMin);

  // Group slots by roomId as rendered on the board:
  // We expect ids to be: 1A,1B,2A,2B, 3..8, 9A,9B,10A,10B
  const buckets = new Map();
  const wantedIds = ['1A','1B','2A','2B','3','4','5','6','7','8','9A','9B','10A','10B'];
  wantedIds.forEach(id => buckets.set(id, []));

  // Place each slot into a bucket:
  slots.forEach(s => {
    let rid = String(s.roomId || '').toUpperCase();
    // Normalize numeric-only ids to their single room (3..8 ok)
    // Keep A/B if present
    // If CSV uses “1” while we show “1A/1B”, we’ll send to both A and B (same info)
    if (/^(1|2|9|10)$/.test(rid)) {
      // duplicate to A and B
      const A = rid+'A', B = rid+'B';
      if (buckets.has(A)) buckets.get(A).push(s);
      if (buckets.has(B)) buckets.get(B).push(s);
    } else if (/^(1|2|9|10)[AB]$/.test(rid)) {
      if (buckets.has(rid)) buckets.get(rid).push(s);
    } else if (/^[3-8]$/.test(rid)) {
      if (buckets.has(rid)) buckets.get(rid).push(s);
    }
    // else ignore unknown ids
  });

  // Mount pagers in each card
  let roomIndex = 0;
  for (const [roomId, arr] of buckets.entries()) {
    const card = findRoomCard(roomId);
    if (!card) continue;

    // Sort by start time ascending
    arr.sort((a,b) => (a.startMin||0) - (b.startMin||0));

    // Tell header how many total
    card._setCount(arr.length);

    // Build pages by room type
    const size = perPageForRoom(roomId);
    const pages = chunk(arr, size);

    // Create pager with a small stagger so rooms don’t flip exactly together
    mountPager(card._pagerHost, pages, {
      intervalMs: 8000,
      startStaggerMs: (roomIndex % 6) * 400
    });

    roomIndex++;
  }
}

document.addEventListener('DOMContentLoaded', init);
