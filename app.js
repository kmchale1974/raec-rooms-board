// app.js

/***** CONFIG *****/
const DATA_URL = `./events.json`;
const PAGE_DWELL_MS = 7000;        // how long each page shows before flipping
const HIDE_PAST     = true;        // drop events whose end < now
const REFRESH_MS    = 60_000;      // recalc every minute so ended events fall off

/***** TIME UTILS (12-hour display) *****/
function nowMinutesLocal(){
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}
function fmt12(min){
  let h = Math.floor(min/60), m = min % 60;
  const ampm = h >= 12 ? 'pm' : 'am';
  h = h % 12; if (h === 0) h = 12;
  return `${h}:${m.toString().padStart(2,'0')}${ampm}`;
}

/***** NAME / ORG FORMATTING *****/
function isPersonish(s){
  // A very light heuristic: "Last, First" → treat as person
  return /.+,\s*.+/.test(s) && !/\b(Club|Basketball|Volleyball|Athletics|Elite|Flight|United|Academy|Sports?)\b/i.test(s);
}
function normalizeReservee(title){
  // Split on comma only if it looks like "Last, First"
  if (isPersonish(title)){
    const [last, first] = title.split(',').map(t=>t.trim());
    return `${first} ${last}`;
  }
  return title;
}

/***** FETCH & RENDER LOOP *****/
async function loadData(){
  const resp = await fetch(`${DATA_URL}?ts=${Date.now()}`, { cache:'no-store' });
  if (!resp.ok) throw new Error(`Failed to fetch events.json: ${resp.status}`);
  const data = await resp.json();
  console.log('Loaded events.json', data);
  return data;
}

function renderHeaderClock(){
  const d = new Date();
  const dow = d.toLocaleDateString(undefined,{ weekday:'long' });
  const mon = d.toLocaleDateString(undefined,{ month:'long' });
  const day = d.getDate();
  const yr  = d.getFullYear();
  const hh = d.getHours();
  const mm = d.getMinutes().toString().padStart(2,'0');
  const ampm = hh >= 12 ? 'PM':'AM';
  const h12 = ((hh%12)||12);

  document.getElementById('headerDate').textContent = `${dow}, ${mon} ${day}, ${yr}`;
  document.getElementById('headerClock').textContent = `${h12}:${mm} ${ampm}`;
}

/***** FILTER / DEDUPE *****/
function filterPast(slots, nowMin){
  if (!HIDE_PAST) return slots;
  return slots.filter(s => s.endMin > nowMin);
}

// Merge duplicates in the same room/time with the same title (keep the first, and join subtitles if different)
function dedupeWithinRoom(list){
  const key = s => `${s.roomId}|${s.startMin}|${s.endMin}|${s.title}`.toLowerCase();
  const seen = new Map();
  for (const s of list){
    const k = key(s);
    if (!seen.has(k)) {
      seen.set(k, { ...s });
    } else {
      const prev = seen.get(k);
      if (s.subtitle && s.subtitle !== prev.subtitle){
        prev.subtitle = `${prev.subtitle}; ${s.subtitle}`;
      }
    }
  }
  return Array.from(seen.values());
}

function groupSlotsByRoom(slots){
  const m = new Map();
  for (const s of slots){
    if (!m.has(s.roomId)) m.set(s.roomId, []);
    m.get(s.roomId).push(s);
  }
  // sort by start time inside each room
  for (const [rid, list] of m.entries()){
    list.sort((a,b)=> a.startMin - b.startMin || a.title.localeCompare(b.title));
  }
  return m;
}

/***** DOM BUILDERS *****/
function buildRoomsShell(rooms){
  const south = document.getElementById('southRooms');
  const north = document.getElementById('northRooms');
  const fh    = document.getElementById('fieldhouseRooms');
  south.innerHTML = ''; north.innerHTML = ''; fh.innerHTML = '';

  const byGroup = {
    south: rooms.filter(r=>r.group==='south').sort((a,b)=> Number(a.id)-Number(b.id)),
    north: rooms.filter(r=>r.group==='north').sort((a,b)=> Number(a.id)-Number(b.id)),
    fieldhouse: rooms.filter(r=>r.group==='fieldhouse').sort((a,b)=> Number(a.id)-Number(b.id)),
  };

  const createCard = (r) => {
    const el = document.createElement('div');
    el.className = 'room';
    el.dataset.roomId = r.id;

    el.innerHTML = `
      <div class="roomHeader">
        <div class="id">${r.label}</div>
        <div class="count" id="count-${r.id}">—</div>
      </div>
      <div class="pages" id="pages-${r.id}"></div>
    `;
    return el;
  };

  byGroup.south.forEach(r => south.appendChild(createCard(r)));
  byGroup.north.forEach(r => north.appendChild(createCard(r)));
  byGroup.fieldhouse.forEach(r => fh.appendChild(createCard(r)));
}

// Create a single event chip
function makeEventChip(slot){
  const whoBold = normalizeReservee(slot.title);
  const sub = (slot.subtitle || '').trim();
  const when = `${fmt12(slot.startMin)} – ${fmt12(slot.endMin)}`;

  const wrap = document.createElement('div');
  wrap.className = 'event';
  wrap.innerHTML = `
    <div class="who">${whoBold}</div>
    ${sub ? `<div class="what">${sub}</div>` : ``}
    <div class="when">${when}</div>
  `;
  return wrap;
}

/***** PAGINATION PER ROOM *****/
function paginateEventsIntoPages(roomCard, events){
  const pagesHost = roomCard.querySelector('.pages');
  pagesHost.innerHTML = '';

  if (!events.length){
    const empty = document.createElement('div');
    empty.className = 'page is-active';
    empty.style.opacity = 1;
    empty.innerHTML = `<div class="event"><div class="who" style="font-weight:600;color:var(--muted)">No reservations</div></div>`;
    pagesHost.appendChild(empty);
    roomCard.querySelector(`#count-${roomCard.dataset.roomId}`).textContent = '0';
    return { pages: [empty], idx: 0 };
  }

  // Create temp page and add events until overflow, then start a new page.
  const pages = [];
  let pageEl = document.createElement('div');
  pageEl.className = 'page';
  pagesHost.appendChild(pageEl);

  const maxHeight = pagesHost.clientHeight || pagesHost.getBoundingClientRect().height;

  for (const ev of events){
    const chip = makeEventChip(ev);
    pageEl.appendChild(chip);

    if (pageEl.scrollHeight > maxHeight){
      // overflowed: move chip to new page
      pageEl.removeChild(chip);
      if (!pageEl.childNodes.length){
        // safety: if a single item is taller than the space, still show it
        pageEl.appendChild(chip);
      } else {
        pageEl = document.createElement('div');
        pageEl.className = 'page';
        pagesHost.appendChild(pageEl);
        pageEl.appendChild(chip);
      }
    }
  }

  // Update count
  roomCard.querySelector(`#count-${roomCard.dataset.roomId}`).textContent = `${events.length}`;

  // Mark first page active
  if (pagesHost.children.length){
    pagesHost.children[0].classList.add('is-active');
    pagesHost.children[0].style.opacity = 1;
  }

  // collect page nodes
  Array.from(pagesHost.children).forEach(p => pages.push(p));
  return { pages, idx: 0 };
}

/***** PER-ROOM PAGE CYCLER WITH 3-STEP ANIMATION PATTERN *****/
const roomCyclers = new Map(); // roomId -> { timer, pages, idx }

function applyTransitionPattern(outPage, inPage, nextIndex){
  // clear previous animation classes
  [outPage, inPage].forEach(el => {
    if (!el) return;
    el.classList.remove('anim-slide-left','anim-appear','anim-slide-in');
  });

  // Pattern cycles over page index: 0→1 uses slide-left, 1→2 uses appear, 2→3 uses slide-in, then repeats.
  const pattern = ['anim-slide-left','anim-appear','anim-slide-in'];
  const anim = pattern[nextIndex % pattern.length];

  if (outPage){
    // Only animate "out" when using slide-left; fade+slide-in focus on "in"
    if (anim === 'anim-slide-left'){
      outPage.classList.add('anim-slide-left');
    } else {
      outPage.style.opacity = 0;
    }
    outPage.classList.remove('is-active');
  }

  if (inPage){
    // Prepare and animate "in"
    if (anim === 'anim-appear') inPage.classList.add('anim-appear');
    if (anim === 'anim-slide-in') inPage.classList.add('anim-slide-in');
    inPage.classList.add('is-active');
    inPage.style.opacity = 1;
  }
}

function startCycler(roomCard, pagesStruct){
  const roomId = roomCard.dataset.roomId;
  // stop previous
  const prev = roomCyclers.get(roomId);
  if (prev && prev.timer) clearInterval(prev.timer);

  const pages = pagesStruct.pages;
  if (pages.length <= 1){
    roomCyclers.set(roomId, { timer:null, pages, idx:0 });
    return;
  }

  let idx = 0;
  const timer = setInterval(() => {
    const out = pages[idx];
    idx = (idx + 1) % pages.length;
    const incoming = pages[idx];
    applyTransitionPattern(out, incoming, idx);
  }, PAGE_DWELL_MS);

  roomCyclers.set(roomId, { timer, pages, idx });
}

/***** RENDER ALL *****/
function renderAll(data){
  // header
  renderHeaderClock();

  // rooms shell
  buildRoomsShell(data.rooms || []);

  // slots: filter, group, dedupe and render per room
  const nowMin = nowMinutesLocal();
  let slots = Array.isArray(data.slots) ? data.slots.slice() : [];
  slots = filterPast(slots, nowMin);

  const grouped = groupSlotsByRoom(slots);
  const allRoomIds = (data.rooms || []).map(r=>r.id);

  for (const roomId of allRoomIds){
    const roomCard = document.querySelector(`.room[data-room-id="${roomId}"]`);
    const list = grouped.get(roomId) || [];
    const deduped = dedupeWithinRoom(list);
    const pagesStruct = paginateEventsIntoPages(roomCard, deduped);
    startCycler(roomCard, pagesStruct);
  }
}

/***** MAIN *****/
async function init(){
  const data = await loadData();
  renderAll(data);

  // live clock
  setInterval(renderHeaderClock, 1000);

  // refresh events every minute so ended events drop and pages shrink
  setInterval(async () => {
    try{
      const fresh = await loadData();
      renderAll(fresh);
    }catch(e){ console.error(e); }
  }, REFRESH_MS);
}

document.addEventListener('DOMContentLoaded', init);
