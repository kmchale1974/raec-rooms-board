// ---------- time ----------
function to12h(mins) {
  const h24 = Math.floor(mins / 60);
  const m = mins % 60;
  const ampm = h24 >= 12 ? 'pm' : 'am';
  let h = h24 % 12;
  if (h === 0) h = 12;
  return `${h}:${m.toString().padStart(2,'0')}${ampm}`;
}

// ---------- name/org helpers ----------
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
function isSingleToken(s){ return /^[A-Za-z'.-]+$/.test(s||''); }
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

// ---------- special text rules ----------
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
const tidyCatch = (s) => (s||'')
  .replace(/\binternal holds?\b/ig,'')
  .replace(/^\s*[-–,:]\s*/,'')
  .trim();

// ---------- load ----------
async function loadData() {
  const resp = await fetch(`./events.json?ts=${Date.now()}`, { cache:'no-store' });
  if (!resp.ok) throw new Error(`Failed to fetch events.json: ${resp.status} ${resp.statusText}`);
  const data = await resp.json();
  console.log('Loaded events.json', data);
  return data;
}

// ---------- fit 1920×1080 ----------
function ensureStageFit() {
  const STAGE_W = 1920, STAGE_H = 1080;
  const stage = document.querySelector('.stage');
  function fit(){
    if (!stage) return;
    const sx = window.innerWidth  / STAGE_W;
    const sy = window.innerHeight / STAGE_H;
    const s  = Math.min(sx, sy) * 0.965; // slight inset to guard edges
    stage.style.transform = `scale(${s})`;
    stage.style.transformOrigin = 'top center';
  }
  window.addEventListener('resize', fit);
  window.addEventListener('orientationchange', fit);
  fit();
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

// ---------- format display ----------
function formatDisplay(slot) {
  const pb = pickleballOverride(slot);
  if (pb) return { title: pb.title, subtitle: pb.subtitle, when: `${to12h(slot.startMin)}–${to12h(slot.endMin)}` };

  let org = (slot.org||'').trim();
  let contact = (slot.contact||'').trim();
  let title = (slot.title||'').trim();
  let subtitle = (slot.subtitle||'').trim();

  // derive org/contact from title if absent
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

  const flipIfPerson = (s) => (s && s.includes(',') && isLikelyPersonName(s)) ? flipName(s) : s;
  org = flipIfPerson(org);
  contact = flipIfPerson(contact);

  // Catch Corner cleanup
  if (org && org.toLowerCase().includes('catch corner')) {
    org = 'Catch Corner';
    const detail = tidyCatch(contact || subtitle);
    return { title: org, subtitle: detail, when: `${to12h(slot.startMin)}–${to12h(slot.endMin)}` };
  }

  // Person-first display if we believe it's a person
  if (
    org && contact &&
    isSingleToken(org) && isSingleToken(contact) &&
    !looksOrg(org) && !looksOrg(contact)
  ) {
    const person = `${contact} ${org}`;
    return { title: person, subtitle: subtitle || '', when: `${to12h(slot.startMin)}–${to12h(slot.endMin)}` };
  }
  if (org && contact && isLikelyPersonName(org) && isLikelyPersonName(contact)) {
    const person = `${contact} ${org}`;
    return { title: person, subtitle: subtitle || '', when: `${to12h(slot.startMin)}–${to12h(slot.endMin)}` };
  }
  if (!org && contact && (isLikelyPersonName(contact) || isSingleToken(contact))) {
    return { title: contact, subtitle: subtitle || '', when: `${to12h(slot.startMin)}–${to12h(slot.endMin)}` };
  }

  return {
    title: org || (title && title.includes(',') ? flipName(title) : title) || '—',
    subtitle: subtitle || contact || '',
    when: `${to12h(slot.startMin)}–${to12h(slot.endMin)}`
  };
}

// ---------- room shells ----------
function renderRoomsShell() {
  const south = document.getElementById('southRooms');
  const field = document.getElementById('fieldhouseRooms');
  const north = document.getElementById('northRooms');

  if (south) {
    south.innerHTML = '';
    south.appendChild(roomCard('1A')); south.appendChild(roomCard('1B'));
    south.appendChild(roomCard('2A')); south.appendChild(roomCard('2B'));
  }
  if (field) {
    field.innerHTML = '';
    ['3','4','5','6','7','8'].forEach(id => field.appendChild(roomCard(id)));
  }
  if (north) {
    north.innerHTML = '';
    north.appendChild(roomCard('9A')); north.appendChild(roomCard('9B'));
    north.appendChild(roomCard('10A')); north.appendChild(roomCard('10B'));
  }
}
function roomCard(id) {
  const card = document.createElement('div');
  card.className = 'room';
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

  const pagerHost = document.createElement('div');
  pagerHost.className = 'events';
  pagerHost.style.flex = '1 1 auto';
  pagerHost.style.minHeight = '0';
  pagerHost.style.position = 'relative';
  pagerHost.style.overflow = 'hidden';

  card.appendChild(hdr);
  card.appendChild(pagerHost);

  card._setCount = (n) => { countEl.textContent = n ? `${n} event${n>1?'s':''}` : ''; };
  card._pagerHost = pagerHost;
  return card;
}
function findRoomCard(id) {
  return Array.from(document.querySelectorAll('.room'))
    .find(r => r.querySelector('.roomHeader .id')?.textContent === id) || null;
}

// ---------- page builder (always slide left) ----------
function renderEventsPage(events) {
  const wrap = document.createElement('div');
  wrap.style.display = 'flex';
  wrap.style.flexDirection = 'column';
  wrap.style.gap = '8px';
  wrap.style.height = '100%';
  wrap.style.justifyContent = 'flex-start';
  wrap.style.alignItems = 'stretch';
  wrap.style.textAlign = 'left';
  wrap.style.width = '100%';

  events.forEach(ev => {
    const { title, subtitle, when } = formatDisplay(ev);

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
    wrap.appendChild(card);
  });

  return wrap;
}

function createPager(container, pages) {
  container.innerHTML = '';

  const pageEls = pages.map(evs => {
    const el = document.createElement('div');
    el.className = 'page';
    el.appendChild(renderEventsPage(evs));
    container.appendChild(el);
    return el;
  });

  let idx = 0;
  function show(i, immediate=false) {
    if (!pageEls.length) return;
    const from = pageEls[idx];
    const to = pageEls[i];

    if (immediate) {
      pageEls.forEach(p => p.classList.remove('is-active','is-leaving'));
      to.classList.add('is-active');
      idx = i;
      return;
    }
    if (from === to) {
      to.classList.add('is-active'); to.classList.remove('is-leaving');
      idx = i; return;
    }
    from.classList.remove('is-active'); from.classList.add('is-leaving');
    to.classList.remove('is-leaving'); to.classList.add('is-active');
    idx = i;
  }
  function next() {
    if (pageEls.length <= 1) return;
    const i = (idx + 1) % pageEls.length;
    show(i, false);
  }
  return { show, next };
}

function chunk(arr, size) {
  const out = [];
  for (let i=0;i<arr.length;i+=size) out.push(arr.slice(i, i+size));
  return out;
}
function perPageForRoom(){ return 1; } // identical everywhere

// ---------- robust room routing ----------
function normalizeRoomTargets(roomIdRaw) {
  const raw = String(roomIdRaw||'').trim();
  const s = raw.toUpperCase().replace(/\s+/g,'');      // collapse spaces
  const low = raw.toLowerCase();

  // Championship Court => 1A,1B,2A,2B
  if (low.includes('championship court')) return ['1A','1B','2A','2B'];

  // "Full Gym 9 & 10", "Court 9 & 10", "9-10"
  if (/(^|[^0-9])9\s*(&|-)\s*10([^0-9]|$)/i.test(raw)) return ['9A','9B','10A','10B'];
  if (/(^|[^0-9])1\s*(&|-)\s*2([^0-9]|$)/i.test(raw))  return ['1A','1B','2A','2B'];

  // Explicit half-court A/B (allow "10 A", "10A")
  const halfAB = raw.match(/\b(1|2|9|10)\s*([AB])\b/i);
  if (halfAB) return [`${halfAB[1]}${halfAB[2].toUpperCase()}`];

  // Variants like "Half Court 10A", "Half Court 10 B"
  const halfABTight = raw.match(/half\s*court[^0-9]*\b(1|2|9|10)\s*([AB])\b/i);
  if (halfABTight) return [`${halfABTight[1]}${halfABTight[2].toUpperCase()}`];

  // "Court 10-AB", "10AB", "Court 9 AB"
  const abWide = raw.match(/\b(?:court\s*)?(1|2|9|10)\s*[- ]?\s*AB\b/i);
  if (abWide) {
    const base = abWide[1];
    return [`${base}A`, `${base}B`];
  }

  // Plain “Court 10”, “Gym 2”, etc. → split to A+B for 1/2/9/10
  const justNum = raw.match(/\b(1|2|9|10)\b/);
  if (justNum) {
    const base = justNum[1];
    return [`${base}A`, `${base}B`];
  }

  // Fieldhouse numbers 3..8 map 1:1
  const fh = raw.match(/\b([3-8])\b/);
  if (fh) return [fh[1]];

  // Already exact (e.g., incoming is "10A")
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

// ---------- run ----------
async function init() {
  ensureStageFit();
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

  const pagers = [];
  for (const [roomId, arrRaw] of buckets.entries()) {
    const card = findRoomCard(roomId);
    if (!card) continue;

    const arr = dedupeByKey(arrRaw).sort((a,b) => (a.startMin||0) - (b.startMin||0));
    card._setCount(arr.length);

    const pages = chunk(arr, perPageForRoom(roomId));
    const pager = createPager(card._pagerHost, pages);
    pagers.push(pager);
  }

  // start all pagers in sync
  pagers.forEach(p => p.show(0, true));
  setInterval(() => pagers.forEach(p => p.next()), 8000);
}

document.addEventListener('DOMContentLoaded', init);
