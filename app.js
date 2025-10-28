// app.js — smoother always-left slide; person-name fix for single-token org/contact;
// tighter autoscale to avoid bottom/right clipping; pickleball & Catch Corner rules kept.

// ---------- Time ----------
function to12h(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  const ampm = h >= 12 ? 'pm' : 'am';
  let hh = h % 12;
  if (hh === 0) hh = 12;
  return `${hh}:${m.toString().padStart(2,'0')}${ampm}`;
}

// ---------- Name helpers ----------
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

// ---------- Pickleball normalization ----------
function pickleballOverride(slot) {
  const t = `${slot.title||''} ${slot.subtitle||''}`.toLowerCase();
  if (
    t.includes('pickleball') ||
    (slot.title||'').includes('RAEC Front Desk, Rentals - On Hold') ||
    (slot.subtitle||'').toLowerCase().includes('open pickleball')
  ) {
    return { title:'Open Pickleball', subtitle:'' };
  }
  return null;
}

// ---------- Load ----------
async function loadData() {
  const resp = await fetch(`./events.json?ts=${Date.now()}`, { cache:'no-store' });
  if (!resp.ok) throw new Error(`Failed to fetch events.json: ${resp.status} ${resp.statusText}`);
  const data = await resp.json();
  console.log('Loaded events.json', data);
  return data;
}

// ---------- Fit 1920×1080 safely (extra margin) ----------
function ensureStageFit() {
  const STAGE_W = 1920, STAGE_H = 1080;
  const stage = document.querySelector('.stage');
  const viewport = document.querySelector('.viewport');

  function fit(){
    if (!stage || !viewport) return;
    const sx = window.innerWidth  / STAGE_W;
    const sy = window.innerHeight / STAGE_H;
    // slightly smaller scale to ensure no clipping on tight players
    const s  = Math.min(sx, sy) * 0.97;

    stage.style.transform = `scale(${s})`;
    stage.style.transformOrigin = 'top center';

    viewport.style.display = 'flex';
    viewport.style.justifyContent = 'center';
    viewport.style.alignItems = 'flex-start';
  }
  window.addEventListener('resize', fit);
  window.addEventListener('orientationchange', fit);
  fit();
}

// ---------- Header clock ----------
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

// ---------- Display formatter ----------
function formatDisplay(slot) {
  // 1) Pickleball
  const pb = pickleballOverride(slot);
  if (pb) return { title: pb.title, subtitle: pb.subtitle, when: `${to12h(slot.startMin)}–${to12h(slot.endMin)}` };

  // Prefer structured fields when present
  let org = (slot.org||'').trim();
  let contact = (slot.contact||'').trim();
  let title = (slot.title||'').trim();
  let subtitle = (slot.subtitle||'').trim();

  // If no org/contact but title has comma → try to split
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

  // --- NEW: single-token person pair rule (e.g., org="Vazquez", contact="Isabel") ---
  if (
    org && contact &&
    isSingleToken(org) && isSingleToken(contact) &&
    !looksOrg(org) && !looksOrg(contact)
  ) {
    const person = `${contact} ${org}`; // Isabel Vazquez
    return {
      title: person,
      subtitle: subtitle || '',
      when: `${to12h(slot.startMin)}–${to12h(slot.endMin)}`
    };
  }

  // PERSON-FIRST rule (both look like names)
  if (org && contact && isLikelyPersonName(org) && isLikelyPersonName(contact)) {
    const person = `${contact} ${org}`;
    return {
      title: person,
      subtitle: subtitle || '',
      when: `${to12h(slot.startMin)}–${to12h(slot.endMin)}`
    };
  }

  // Contact alone looks like a person
  if (!org && contact && (isLikelyPersonName(contact) || isSingleToken(contact))) {
    return {
      title: contact,
      subtitle: subtitle || '',
      when: `${to12h(slot.startMin)}–${to12h(slot.endMin)}`
    };
  }

  // Catch Corner tidy-up
  const tidyCatch = (s) => (s||'')
    .replace(/\binternal holds?\b/ig,'')
    .replace(/^\s*[-–,:]\s*/,'')
    .trim();

  // Default: ORG bold; contact or subtitle beneath
  if (org) {
    let detail = contact || subtitle || '';
    if (org.toLowerCase().includes('catch corner')) {
      org = 'Catch Corner';
      detail = tidyCatch(detail || subtitle);
    }
    return {
      title: org,
      subtitle: detail,
      when: `${to12h(slot.startMin)}–${to12h(slot.endMin)}`
    };
  }

  // Fallback: title/subtitle
  return {
    title: (title && isLikelyPersonName(title) ? flipIfPerson(title) : title) || '—',
    subtitle: subtitle || contact || '',
    when: `${to12h(slot.startMin)}–${to12h(slot.endMin)}`
  };
}

// ---------- Pager (always slide left, smoother) ----------
function mountPager(container, pages, { intervalMs=8000, startStaggerMs=0 } = {}) {
  let pageIdx = 0;
  let running = false;

  container.classList.add('roomPager');
  container.innerHTML = '';

  const pageEls = pages.map(evs => {
    const page = document.createElement('div');
    page.className = 'roomPage';
    page.style.transform = 'translateX(100%)';
    page.style.opacity = '0';
    page.style.transition = 'transform 700ms cubic-bezier(.22,.61,.36,1), opacity 700ms ease';
    page.appendChild(renderEventsList(evs));
    container.appendChild(page);
    return page;
  });

  function show(i) {
    const prev = pageEls[pageIdx];
    const next = pageEls[i];

    if (prev === next) {
      next.style.transform = 'translateX(0%)';
      next.style.opacity = '1';
      pageIdx = i;
      return;
    }

    next.style.transition = 'none';
    next.style.transform = 'translateX(100%)';
    next.style.opacity = '0';
    void next.offsetWidth; // reflow

    prev.style.transition = 'transform 700ms cubic-bezier(.22,.61,.36,1), opacity 700ms ease';
    next.style.transition = 'transform 700ms cubic-bezier(.22,.61,.36,1), opacity 700ms ease';

    prev.style.transform = 'translateX(-100%)';
    prev.style.opacity = '0';

    next.style.transform = 'translateX(0%)';
    next.style.opacity = '1';

    pageIdx = i;
  }

  function tick() {
    if (!running || pageEls.length <= 1) return;
    const nextIdx = (pageIdx + 1) % pageEls.length;
    show(nextIdx);
  }

  setTimeout(() => {
    running = true;
    show(0);
    if (pageEls.length > 1) setInterval(tick, intervalMs);
  }, startStaggerMs);
}

function renderEventsList(events) {
  const wrap = document.createElement('div');
  wrap.className = 'eventsPageStack';
  wrap.style.display = 'flex';
  wrap.style.flexDirection = 'column';
  wrap.style.gap = '8px';
  wrap.style.height = '100%';

  events.forEach(ev => {
    const { title, subtitle, when } = formatDisplay(ev);

    const card = document.createElement('div');
    card.className = 'event';
    card.style.background = 'var(--chip)';
    card.style.border = '1px solid var(--grid)';
    card.style.borderRadius = '10px';
    card.style.padding = '8px 10px';
    card.style.display = 'flex';
    card.style.flexDirection = 'column';
    card.style.gap = '4px';
    card.style.minHeight = 0;

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

  // Spacer keeps last card from kissing the bottom edge
  const spacer = document.createElement('div');
  spacer.style.flex = '1 1 auto';
  wrap.appendChild(spacer);

  return wrap;
}

// ---------- Rooms shell ----------
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

function chunk(arr, size) {
  const out = [];
  for (let i=0;i<arr.length;i+=size) out.push(arr.slice(i, i+size));
  return out;
}

function perPageForRoom(id) {
  // A/B rooms rotate one at a time for readability
  if (/^(1|2|9|10)[AB]$/.test(id)) return 1;
  // Fieldhouse single rooms can show two per page
  return 2;
}

// ---------- Init ----------
async function init() {
  ensureStageFit();
  headerClock();
  renderRoomsShell();

  const data = await loadData();

  const now = new Date();
  const nowMin = now.getHours()*60 + now.getMinutes();

  // Keep only current/future
  const slots = (data.slots||[]).filter(s => (s.endMin ?? 1440) > nowMin);

  const wanted = ['1A','1B','2A','2B','3','4','5','6','7','8','9A','9B','10A','10B'];
  const buckets = new Map(wanted.map(k => [k, []]));

  // Map CSV room ids onto our displayed ids
  slots.forEach(s => {
    let rid = String(s.roomId || '').toUpperCase();

    if (/^(1|2|9|10)$/.test(rid)) {
      // If CSV says "1", show in both 1A and 1B (same info)
      ['A','B'].forEach(sfx => buckets.get(rid+sfx)?.push(s));
    } else if (/^(1|2|9|10)[AB]$/.test(rid)) {
      buckets.get(rid)?.push(s);
    } else if (/^[3-8]$/.test(rid)) {
      buckets.get(rid)?.push(s);
    }
  });

  // Mount pagers
  let idx = 0;
  for (const [roomId, arr] of buckets.entries()) {
    const card = findRoomCard(roomId);
    if (!card) continue;

    arr.sort((a,b) => (a.startMin||0) - (b.startMin||0));
    card._setCount(arr.length);

    const size = perPageForRoom(roomId);
    const pages = chunk(arr, size);

    mountPager(card._pagerHost, pages, {
      intervalMs: 8000,
      startStaggerMs: (idx % 6) * 350
    });
    idx++;
  }
}

document.addEventListener('DOMContentLoaded', init);
