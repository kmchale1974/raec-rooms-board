// ---------- time ----------
function to12h(mins) {
  const h24 = Math.floor(mins / 60);
  const m = mins % 60;
  const ampm = h24 >= 12 ? 'pm' : 'am';
  let h = h24 % 12; if (h === 0) h = 12;
  return `${h}:${m.toString().padStart(2,'0')}${ampm}`;
}
const to12Range = s => `${to12h(s.startMin)}–${to12h(s.endMin)}`;

// ---------- org/name detection ----------
const ORG_HINTS = [
  'club','athletic','athletics','basketball','volleyball','elite','academy',
  'flight','omona','empower','chicago sport','pink elite','catch corner','training',
  'school','rec','soccer','baseball'
];
function looksOrg(s) {
  if (!s) return false;
  const lower = s.toLowerCase();
  return ORG_HINTS.some(h => lower.includes(h));
}
function isLikelyPersonName(s) {
  if (!s) return false;
  if (looksOrg(s)) return false;
  if (s.includes(',')) {
    const parts = s.split(',').map(x=>x.trim()).filter(Boolean);
    if (
      parts.length === 2 &&
      /^[A-Za-z'.-]+$/.test(parts[0]) &&
      /^[A-Za-z'.-]+(?: [A-Za-z'.-]+)*$/.test(parts[1])
    ) return true;
  }
  const tokens = s.split(/\s+/).filter(Boolean);
  if (tokens.length === 2 && tokens.every(t => /^[A-Za-z'.-]+$/.test(t))) return true;
  return false;
}
function flipName(lastCommaFirst) {
  const [last, first] = lastCommaFirst.split(',').map(s => s.trim());
  if (first && last) return `${first} ${last}`;
  return lastCommaFirst;
}

// Helpers for cleanup
const stripInternalNotes = (s='') =>
  s.replace(/\binternal holds?\b/ig,'')
   .replace(/\binternal hold per nm\b/ig,'')
   .replace(/^\s*[-–,:]\s*/,'')
   .trim();

const stripLeadingCatchCorner = (s='') =>
  s.replace(/^\s*catch\s*corner\s*\(?\)?\s*:?/i,'').trim();

// ---------- special cases ----------
function pickleballOverride(slot) {
  const t = `${slot.title||''} ${slot.subtitle||''} ${slot.org||''} ${slot.contact||''}`.toLowerCase();
  if (
    t.includes('pickleball') ||
    (slot.title||'').includes('RAEC Front Desk, Rentals - On Hold') ||
    (slot.subtitle||'').toLowerCase().includes('open pickleball')
  ) {
    return { title:'Open Pickleball', subtitle:'' };
  }
  return null;
}

// ---------- fetch ----------
async function loadData() {
  const resp = await fetch(`./events.json?ts=${Date.now()}`, { cache:'no-store' });
  if (!resp.ok) throw new Error(`Failed to fetch events.json: ${resp.status} ${resp.statusText}`);
  const data = await resp.json();
  console.log('Loaded events.json', data);
  return data;
}

// ---------- header clock ----------
function headerClock() {
  const dateEl = document.getElementById('headerDate');
  const clockEl = document.getElementById('headerClock');
  function tick() {
    const now = new Date();
    const dateFmt = now.toLocaleDateString(undefined, { weekday:'long', month:'long', day:'numeric' });
    let h = now.getHours(), m = now.getMinutes().toString().padStart(2,'0');
    const ampm = h>=12?'pm':'am'; h = h%12 || 12;
    if (dateEl) dateEl.textContent = dateFmt;
    if (clockEl) clockEl.textContent = `${h}:${m}${ampm}`;
  }
  tick();
  setInterval(tick, 1000);
}

// ---------- shells ----------
function renderRoomsShell() {
  const south = document.getElementById('southRooms');
  const field = document.getElementById('fieldhouseRooms');
  const north = document.getElementById('northRooms');

  if (south) {
    south.innerHTML = '';
    south.appendChild(roomCard('1A', true)); south.appendChild(roomCard('1B', true));
    south.appendChild(roomCard('2A', true)); south.appendChild(roomCard('2B', true));
  }
  if (field) {
    field.innerHTML = '';
    ['3','4','5','6','7','8'].forEach(id => field.appendChild(roomCard(id, false)));
  }
  if (north) {
    north.innerHTML = '';
    north.appendChild(roomCard('9A', true)); north.appendChild(roomCard('9B', true));
    north.appendChild(roomCard('10A', true)); north.appendChild(roomCard('10B', true));
  }
}

function roomCard(id, compact=false) {
  const card = document.createElement('div');
  card.className = 'room' + (compact ? ' compact' : '');
  card.dataset.roomid = id;

  const hdr = document.createElement('div');
  hdr.className = 'roomHeader';

  const idEl = document.createElement('div');
  idEl.className = 'id';
  idEl.textContent = id;

  const countEl = document.createElement('div');
  countEl.className = 'count';
  countEl.textContent = '';

  hdr.appendChild(idEl);
  hdr.appendChild(countEl);

  const eventsWrap = document.createElement('div');
  eventsWrap.className = 'events';

  card.appendChild(hdr);
  card.appendChild(eventsWrap);

  // <<< label now says "reservations" >>>
  card._setCount = (n) => { countEl.textContent = n ? `${n} reservation${n>1?'s':''}` : ''; };
  card._eventsWrap = eventsWrap;
  return card;
}

function findRoomCard(id) {
  return Array.from(document.querySelectorAll('.room'))
    .find(r => r.querySelector('.roomHeader .id')?.textContent === id) || null;
}

// ---------- rendering helpers ----------
function eventNode(slot) {
  const { title, subtitle, when } = formatDisplay(slot);
  const card = document.createElement('div');
  card.className = 'event';

  const who = document.createElement('div');
  who.className = 'who';
  who.textContent = title;

  const what = document.createElement('div');
  what.className = 'what';
  what.textContent = subtitle || '';

  const whenEl = document.createElement('div');
  whenEl.className = 'when';
  whenEl.textContent = when;

  card.appendChild(who);
  if (what.textContent) card.appendChild(what);
  card.appendChild(whenEl);
  return card;
}

function renderEventsPage(events) {
  const wrap = document.createElement('div');
  wrap.className = 'page';
  const inner = document.createElement('div');
  inner.style.display = 'flex';
  inner.style.flexDirection = 'column';
  inner.style.gap = '8px';
  inner.style.height = '100%';
  inner.style.justifyContent = 'flex-start';
  inner.style.alignItems = 'stretch';
  events.forEach(ev => inner.appendChild(eventNode(ev)));
  wrap.appendChild(inner);
  return wrap;
}

// Pager for fieldhouse rooms (2 per page)
function createPager(container, pages) {
  container.innerHTML = '';
  const pageEls = pages.map(evs => {
    const el = renderEventsPage(evs);
    container.appendChild(el);
    return el;
  });
  if (pageEls[0]) pageEls[0].classList.add('is-active');

  let idx = 0;
  function show(i, immediate=false) {
    if (!pageEls.length) return;
    const from = pageEls[idx];
    const to = pageEls[i];
    if (immediate) {
      pageEls.forEach(p => p.classList.remove('is-active','is-leaving'));
      to.classList.add('is-active');
      idx = i; return;
    }
    if (from !== to) {
      from.classList.remove('is-active'); from.classList.add('is-leaving');
      to.classList.remove('is-leaving'); to.classList.add('is-active');
    }
    idx = i;
  }
  function next(){ if (pageEls.length>1) show((idx+1)%pageEls.length); }
  return { show, next };
}

// Single rotator for A/B rooms (exactly one event rendered at a time)
function createSingleRotator(container, items) {
  container.innerHTML = '';
  const host = document.createElement('div');
  host.className = 'single-rotor';
  container.appendChild(host);

  let idx = 0;
  let current = null;

  function paint(i, immediate=false) {
    const item = items[i];
    const nextEl = eventNode(item);
    if (!current) {
      nextEl.classList.add('fade-enter','fade-enter-active');
      host.innerHTML = '';
      host.appendChild(nextEl);
      requestAnimationFrame(()=> nextEl.classList.remove('fade-enter'));
      current = nextEl;
      return;
    }
    // exit current
    current.classList.add('fade-exit','fade-exit-active');
    setTimeout(() => {
      host.innerHTML = '';
      nextEl.classList.add('fade-enter','fade-enter-active');
      host.appendChild(nextEl);
      requestAnimationFrame(()=> nextEl.classList.remove('fade-enter'));
      current = nextEl;
    }, immediate ? 0 : 250);
  }

  function show(i, immediate=false){ idx = i; paint(i, immediate); }
  function next(){ if (items.length>1) show((idx+1)%items.length); }
  return { show, next };
}

// utilities
function chunk(arr, size) { const out=[]; for (let i=0;i<arr.length;i+=size) out.push(arr.slice(i, i+size)); return out; }
function perPageForRoom(roomId){ return /^(1|2|9|10)[AB]$/.test(roomId) ? 1 : 2; }

// ---------- display logic ----------
function formatDisplay(slot) {
  // Pickleball override
  const pb = pickleballOverride(slot);
  if (pb) return { title: pb.title, subtitle: '', when: to12Range(slot) };

  // Extract base fields
  let org = (slot.org||'').trim();
  let contact = (slot.contact||'').trim();
  let title = (slot.title||'').trim();
  let subtitle = (slot.subtitle||'').trim();

 // ---- Catch Corner special rule ----
if (
  (org && /catch\s*corner/i.test(org)) ||
  (title && /catch\s*corner/i.test(title))
) {
  let purpose = stripLeadingCatchCorner(stripInternalNotes(subtitle || ''));
  // Remove any dangling parens like " ... Basketball)"
  purpose = purpose.replace(/^\(\s*/,'').replace(/\)\s*$/,'').trim();

  return {
    title: 'Catch Corner',
    subtitle: purpose,
    when: to12Range(slot)
  };
}

  // Derive org/contact if missing from title "Org, Person"
  if (!org && !contact && title.includes(',')) {
    const parts = title.split(',').map(s=>s.trim()).filter(Boolean);
    if (parts.length >= 2) {
      if (!isLikelyPersonName(parts[0]) && isLikelyPersonName(parts[1])) {
        org = parts[0];
        contact = parts.slice(1).join(', ');
      } else if (isLikelyPersonName(parts[0])) {
        contact = parts.join(', ');
      }
    }
  }

  // Flip "Last, First" to "First Last" where appropriate
  const flipIfPerson = (s) => (s && s.includes(',') && isLikelyPersonName(s)) ? flipName(s) : s;
  org = flipIfPerson(org);
  contact = flipIfPerson(contact);

  // ---- Person-only two-token join: "Isabel" + "Vazquez" -> "Isabel Vazquez" in bold ----
  if (
    org && contact &&
    /^[A-Za-z'.-]+$/.test(org) && /^[A-Za-z'.-]+(?: [A-Za-z'.-]+)*$/.test(contact) &&
    !looksOrg(org) && !looksOrg(contact)
  ) {
    // If org is a single token (likely last name) and contact looks like a first name (or first+middle),
    // construct full person name.
    const orgParts = org.split(/\s+/);
    const contactParts = contact.split(/\s+/);
    if (orgParts.length === 1 && contactParts.length >= 1) {
      const fullName = `${contact} ${org}`.replace(/\s+/g,' ').trim();
      return { title: fullName, subtitle: subtitle || '', when: to12Range(slot) };
    }
  }

  // If org itself looks like a person name, use it as bold line
  if (isLikelyPersonName(org)) {
    return { title: org, subtitle: subtitle || '', when: to12Range(slot) };
  }
  // If no org but contact is a person name, bold that
  if (!org && isLikelyPersonName(contact)) {
    return { title: contact, subtitle: subtitle || '', when: to12Range(slot) };
  }

  // Default org/title/subtitle mapping
  return {
    title: org || (title && title.includes(',') ? flipName(title) : title) || '—',
    subtitle: subtitle || contact || '',
    when: to12Range(slot)
  };
}

// ---------- room routing ----------
function normalizeRoomTargets(roomIdRaw) {
  const raw = String(roomIdRaw||'').trim();
  const s = raw.toUpperCase().replace(/\s+/g,'');
  const low = raw.toLowerCase();

  if (low.includes('championship court')) return ['1A','1B','2A','2B'];
  if (/(^|[^0-9])9\s*(&|-)\s*10([^0-9]|$)/i.test(raw)) return ['9A','9B','10A','10B'];
  if (/(^|[^0-9])1\s*(&|-)\s*2([^0-9]|$)/i.test(raw))  return ['1A','1B','2A','2B'];

  const halfAB = raw.match(/\b(1|2|9|10)\s*([AB])\b/i);
  if (halfAB) return [`${halfAB[1]}${halfAB[2].toUpperCase()}`];

  const abWide = raw.match(/\b(?:court\s*)?(1|2|9|10)\s*[- ]?\s*AB\b/i);
  if (abWide) {
    const base = abWide[1]; return [`${base}A`, `${base}B`];
  }

  const justNum = raw.match(/\b(1|2|9|10)\b/);
  if (justNum) {
    const base = justNum[1]; return [`${base}A`, `${base}B`];
  }

  const fh = raw.match(/\b([3-8])\b/);
  if (fh) return [fh[1]];

  if (/^(1|2|9|10)[AB]$/.test(s)) return [s];

  return [];
}

function dedupeByKey(arr) {
  const seen = new Set();
  const out = [];
  for (const s of arr) {
    const k = `${s.startMin}|${s.endMin}|${(s.org||s.title||'').toLowerCase()}|${(s.subtitle||'').toLowerCase()}|${(s.contact||'').toLowerCase()}`;
    if (!seen.has(k)) { seen.add(k); out.push(s); }
  }
  return out;
}

// ---------- main ----------
async function init() {
  headerClock();
  renderRoomsShell();

  const data = await loadData();
  const now = new Date();
  const nowMin = now.getHours()*60 + now.getMinutes();
  const slots = (data.slots||[]).filter(s => (s.endMin ?? 1440) > nowMin);

  const wanted = ['1A','1B','2A','2B','3','4','5','6','7','8','9A','9B','10A','10B'];
  const buckets = new Map(wanted.map(k => [k, []]));

  for (const s of slots) {
    const targets = normalizeRoomTargets(s.roomId);
    targets.forEach(t => { if (buckets.has(t)) buckets.get(t).push(s); });
  }

  const controllers = [];
  for (const [roomId, arrRaw] of buckets.entries()) {
    const card = findRoomCard(roomId);
    if (!card) continue;

    const arr = dedupeByKey(arrRaw).sort((a,b) => (a.startMin||0) - (b.startMin||0));
    card._setCount(arr.length);

    const isAB = /^(1|2|9|10)[AB]$/.test(roomId);
    if (isAB) {
      // A/B: single rotator (one reservation visible at a time)
      if (arr.length === 0) { card._eventsWrap.innerHTML = ''; continue; }
      const rotor = createSingleRotator(card._eventsWrap, arr);
      controllers.push(rotor);
    } else {
      // Fieldhouse: 2 per page pager
      const pages = chunk(arr, 2);
      const pager = createPager(card._eventsWrap, pages);
      controllers.push(pager);
    }
  }

  // First paint
  controllers.forEach(c => c.show(0, true));
  // Rotate in sync
  setInterval(() => controllers.forEach(c => c.next()), 8000);
}

document.addEventListener('DOMContentLoaded', init);
