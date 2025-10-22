// app.js — grid-only board with infinite left slide + robust name handling

// -----------------------------
// Time helpers
// -----------------------------
function fmtTime(mins) {
  const h24 = Math.floor(mins / 60);
  const m = mins % 60;
  const ampm = h24 >= 12 ? 'pm' : 'am';
  let h = h24 % 12;
  if (h === 0) h = 12;
  return `${h}:${m.toString().padStart(2, '0')}${ampm}`;
}
function nowMinutesLocal() {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

// -----------------------------
// String + name utilities
// -----------------------------
const S = v => (typeof v === 'string' ? v : '');

// NEW: very clear “Last, First” detector (no digits; letters/accents/hyphen/apostrophe/period/spaces)
const PERSON_RE = /^\s*[A-Za-zÀ-ÖØ-öø-ÿ'’\-\. ]+,\s*[A-Za-zÀ-ÖØ-öø-ÿ'’\-\. ]+\s*$/u;
// Words that strongly indicate an org (used lightly; won’t block simple “Last, First” matches)
const ORG_HINTS = /\b(llc|inc|corp|co|foundation|association|academy|club|basketball|volleyball|training|gym|league|program|rec)\b/i;

function looksLikePersonLoose(s = '') {
  s = s.trim();
  if (!s || /\d/.test(s)) return false;
  // If it matches clean “Last, First”, call it a person
  if (PERSON_RE.test(s)) return true;

  // Fallback: single comma and second half looks like a first-name block, no org hints
  const parts = s.split(',');
  if (parts.length === 2) {
    const left = parts[0].trim();
    const right = parts[1].trim();
    if (left && right && !ORG_HINTS.test(s)) {
      // Allow 1–3 tokens on right; no digits
      const rtoks = right.split(/\s+/).filter(Boolean);
      if (rtoks.length >= 1 && rtoks.length <= 3 && !/\d/.test(right)) {
        return true;
      }
    }
  }
  return false;
}

function normalizePerson(s = '') {
  s = s.trim();
  const [last, rest] = s.split(',', 2).map(x => x.trim());
  return `${rest} ${last}`.replace(/\s{2,}/g, ' ').trim();
}

function normalizeContactName(s = '') {
  if (looksLikePersonLoose(s)) return normalizePerson(s);
  if (s.includes(',')) {
    // Ambiguous “X, Y” → keep left side (often org)
    return s.split(',', 1)[0].trim();
  }
  return s.trim();
}

// -----------------------------
// Special-case text rules
// -----------------------------
function cleanCatchCornerDetail(s = '') {
  let out = s.replace(/^Catch\s*Corner\s*\(?/i, '')
             .replace(/^CatchCorner\s*\(?/i, '');
  out = out.replace(/\)?\s*$/,'').trim();
  out = out.replace(/internal holds?/i, '').trim();
  return out;
}

function isPickleball(slot) {
  const t = (slot.title || '').toLowerCase();
  const sub = (slot.subtitle || '').toLowerCase();
  return /pickleball/.test(t) || /pickleball/.test(sub);
}
function cleanPickleball(slot) {
  return { ...slot, title: 'Open Pickleball', subtitle: '' };
}

// -----------------------------
// DOM handles
// -----------------------------
const els = {
  headerDate: document.getElementById('headerDate'),
  headerClock: document.getElementById('headerClock'),
  south: document.getElementById('southRooms'),
  fieldhouse: document.getElementById('fieldhouseRooms'),
  north: document.getElementById('northRooms'),
};

// Infinite-slide state
let PAGE_TICK = null;
const PAGE_INTERVAL_MS = 7000; // 7s
const PER_PAGE = 2;            // # events per page (avoid clipping)

// -----------------------------
// Header clock
// -----------------------------
function renderClock() {
  const now = new Date();
  const date = now.toLocaleDateString(undefined, {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });
  let hh = now.getHours(), mm = now.getMinutes(), ss = now.getSeconds();
  const ampm = hh >= 12 ? 'pm' : 'am';
  let h12 = hh % 12; if (h12 === 0) h12 = 12;

  if (els.headerDate) els.headerDate.textContent = date;
  if (els.headerClock) els.headerClock.textContent =
    `${h12}:${String(mm).padStart(2,'0')}:${String(ss).padStart(2,'0')}${ampm}`;
}

// -----------------------------
// Event rendering
// -----------------------------
function eventNode(slot) {
  const rawTitle = S(slot.title);
  const title = rawTitle.replace(/[,\s]+$/, '').trim();
  const subtitle = S(slot.subtitle).trim();

  const node = document.createElement('div');
  node.className = 'event';

  // Pickleball presentation
  if (isPickleball(slot)) {
    const who = document.createElement('div');
    who.className = 'who';
    who.textContent = 'Open Pickleball';

    const when = document.createElement('div');
    when.className = 'when';
    when.textContent = `${fmtTime(slot.startMin)} – ${fmtTime(slot.endMin)}`;

    node.appendChild(who);
    node.appendChild(when);
    return node;
  }

  // Catch Corner presentation
  if (/^catch\s*corner|^catchcorner/i.test(title)) {
    const who = document.createElement('div');
    who.className = 'who';
    who.textContent = 'Catch Corner';

    const detailSrc = subtitle || cleanCatchCornerDetail(title);
    const detail = cleanCatchCornerDetail(detailSrc);

    const when = document.createElement('div');
    when.className = 'when';
    when.textContent = `${fmtTime(slot.startMin)} – ${fmtTime(slot.endMin)}`;

    node.appendChild(who);
    if (detail) {
      const what = document.createElement('div');
      what.className = 'what';
      what.textContent = detail;
      node.appendChild(what);
    }
    node.appendChild(when);
    return node;
  }

  // Person?
  if (looksLikePersonLoose(title)) {
    const who = document.createElement('div');
    who.className = 'who';
    who.textContent = normalizePerson(title); // First Last

    const when = document.createElement('div');
    when.className = 'when';
    when.textContent = `${fmtTime(slot.startMin)} – ${fmtTime(slot.endMin)}`;

    node.appendChild(who);
    if (subtitle) {
      const what = document.createElement('div');
      what.className = 'what';
      what.textContent = subtitle;
      node.appendChild(what);
    }
    node.appendChild(when);
    return node;
  }

  // Generic org/contact
  let orgBold = title, contact = '';
  if (title.includes(',')) {
    orgBold = title.split(',', 1)[0].trim();
    contact = title.split(',').slice(1).join(',').trim();
    if (looksLikePersonLoose(contact)) contact = normalizePerson(contact);
  }

  const who = document.createElement('div');
  who.className = 'who';
  who.textContent = normalizeContactName(orgBold);

  const what = document.createElement('div');
  what.className = 'what';
  what.textContent = subtitle || contact;

  const when = document.createElement('div');
  when.className = 'when';
  when.textContent = `${fmtTime(slot.startMin)} – ${fmtTime(slot.endMin)}`;

  node.appendChild(who);
  if (what.textContent) node.appendChild(what);
  node.appendChild(when);
  return node;
}

// -----------------------------
// Paging (infinite slide-left)
// -----------------------------
function pageify(list, perPage = PER_PAGE) {
  const pages = [];
  for (let i = 0; i < list.length; i += perPage) {
    pages.push(list.slice(i, i + perPage));
  }
  return pages.length ? pages : [[]];
}

function buildRoomCard(room, pages) {
  const card = document.createElement('div');
  card.className = 'room';
  card.dataset.roomId = room.id;

  const header = document.createElement('div');
  header.className = 'roomHeader';

  const id = document.createElement('div');
  id.className = 'id';
  id.textContent = room.label;

  const count = document.createElement('div');
  count.className = 'count';
  const total = pages.reduce((a,b) => a + b.length, 0);
  count.textContent = total > 0 ? `${total} event${total>1?'s':''}` : '';

  header.appendChild(id);
  header.appendChild(count);
  card.appendChild(header);

  const viewport = document.createElement('div');
  viewport.className = 'events';
  viewport.style.position = 'relative';
  viewport.style.overflow = 'hidden';

  const strip = document.createElement('div');
  strip.style.display = 'flex';
  strip.style.gap = '0';
  strip.style.willChange = 'transform';
  strip.style.transition = 'transform 600ms ease';
  strip.style.transform = 'translateX(0)';

  pages.forEach(page => {
    const pageCol = document.createElement('div');
    pageCol.style.flex = '0 0 100%';
    pageCol.style.display = 'flex';
    pageCol.style.flexDirection = 'column';
    pageCol.style.gap = '10px';

    page.forEach(slot => pageCol.appendChild(eventNode(slot)));
    strip.appendChild(pageCol);
  });

  viewport.appendChild(strip);
  card.appendChild(viewport);

  // attach infinite-slide handler state
  card._strip = strip;
  card._pages = pages.length;

  return card;
}

function slideLeftOnce(strip) {
  if (!strip || strip.children.length <= 1) return;
  strip.style.transition = 'transform 600ms ease';
  strip.style.transform = 'translateX(-100%)';
  const handler = () => {
    strip.removeEventListener('transitionend', handler);
    const first = strip.children[0];
    if (first) strip.appendChild(first);
    strip.style.transition = 'none';
    strip.style.transform = 'translateX(0)';
    // force reflow
    // eslint-disable-next-line no-unused-expressions
    strip.offsetHeight;
  };
  strip.addEventListener('transitionend', handler, { once: true });
}

// -----------------------------
// Data prep
// -----------------------------
function dedupeSlots(slots) {
  const seen = new Set();
  const out = [];
  for (const s of slots) {
    const t = S(s.title).replace(/[,\s]+$/, '').trim().toLowerCase();
    const sub = S(s.subtitle).trim().toLowerCase();
    const key = [s.roomId, s.startMin, s.endMin, t, sub].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

// -----------------------------
// Render grid from events
// -----------------------------
function renderGrid(data) {
  const now = nowMinutesLocal();

  let slots = Array.isArray(data.slots) ? data.slots.slice() : [];
  // drop past
  slots = slots.filter(s => s.endMin > now);
  // pickleball cleanup
  slots = slots.map(s => (isPickleball(s) ? cleanPickleball(s) : s));
  // dedupe
  slots = dedupeSlots(slots);

  // group by room
  const byRoom = new Map();
  for (const s of slots) {
    if (!byRoom.has(s.roomId)) byRoom.set(s.roomId, []);
    byRoom.get(s.roomId).push(s);
  }
  for (const list of byRoom.values()) {
    list.sort((a,b) => (a.startMin - b.startMin) || S(a.title).localeCompare(S(b.title)));
  }

  // clear columns
  if (els.south) els.south.innerHTML = '';
  if (els.fieldhouse) els.fieldhouse.innerHTML = '';
  if (els.north) els.north.innerHTML = '';

  const rooms = Array.isArray(data.rooms) ? data.rooms : [];
  const roomCards = [];

  rooms.forEach(room => {
    const list = byRoom.get(room.id) || [];
    const pages = pageify(list, PER_PAGE);
    const card = buildRoomCard(room, pages);
    roomCards.push(card);

    if (room.group === 'south' && els.south) els.south.appendChild(card);
    if (room.group === 'fieldhouse' && els.fieldhouse) els.fieldhouse.appendChild(card);
    if (room.group === 'north' && els.north) els.north.appendChild(card);
  });

  // global ticker: slide every strip left
  if (PAGE_TICK) clearInterval(PAGE_TICK);
  PAGE_TICK = setInterval(() => {
    for (const c of roomCards) {
      if (c._pages > 1) slideLeftOnce(c._strip);
    }
  }, PAGE_INTERVAL_MS);
}

// -----------------------------
// Boot
// -----------------------------
async function loadEvents() {
  const url = `./events.json?ts=${Date.now()}`;
  const resp = await fetch(url, { cache: 'no-store' });
  if (!resp.ok) throw new Error(`Failed to fetch events.json: ${resp.status}`);
  const json = await resp.json();
  console.log('Loaded events.json', json);
  return json;
}

async function init() {
  try {
    const data = await loadEvents();
    renderGrid(data);
  } catch (e) {
    console.error(e);
  }

  renderClock();
  setInterval(renderClock, 1000);

  // refresh board every 2 minutes in case a new CSV lands
  setInterval(async () => {
    try {
      const data = await loadEvents();
      renderGrid(data);
    } catch (e) {
      console.error('refresh failed', e);
    }
  }, 120000);
}

document.addEventListener('DOMContentLoaded', init);
