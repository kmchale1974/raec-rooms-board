// app.js — grid board with paged rooms + pickleball display rule

const CLOCK_INTERVAL_MS = 1000 * 30;
const ROTATE_MS         = 8000;
const PER_PAGE_SOUTH    = 4;
const PER_PAGE_NORTH    = 4;
const PER_PAGE_FIELD    = 3;

/* ---------------- utils ---------------- */
const two = n => (n<10 ? "0"+n : ""+n);
function fmt12h(mins){
  let h = Math.floor(mins/60), m = mins%60;
  const ampm = h>=12 ? "PM":"AM"; h = h%12 || 12;
  return `${h}:${two(m)} ${ampm}`;
}
function isPersonName(text){
  if (!text || !text.includes(',')) return false;
  const [last, rest] = text.split(',',2).map(s=>s.trim());
  const orgHints = ['club','basketball','volleyball','academy','elite','united','athletics','soccer','football','gym','llc','inc','rec'];
  const low = text.toLowerCase();
  if (orgHints.some(k => low.includes(k))) return false;
  return /^[a-zA-Z' \-]+$/.test(last) && /^[a-zA-Z' \-]+$/.test(rest);
}
const toFirstLast = t => isPersonName(t) ? t.split(',',2).map(s=>s.trim()).reverse().join(' ') : t;

/* ---------------- data ---------------- */
async function loadEvents(){
  const url = `./events.json?ts=${Date.now()}`;
  const r = await fetch(url, { cache:'no-store' });
  if (!r.ok) throw new Error(`fetch ${url}: ${r.status}`);
  const data = await r.json();
  console.log('Loaded events.json', data);
  return data;
}
function filterFutureSlots(slots, nowMin){
  const keep = (slots||[]).filter(s => (s.endMin??0) >= nowMin);
  console.log(`Slots filtered by time: ${(slots||[]).length} -> ${keep.length} (now=${nowMin})`);
  return keep;
}
function byRoom(slots){
  const m = new Map();
  for (const s of slots){ if (!m.has(s.roomId)) m.set(s.roomId, []); m.get(s.roomId).push(s); }
  return m;
}

/* ---------------- header ---------------- */
function renderHeader(){
  const d = new Date();
  document.getElementById('headerDate').textContent = d.toLocaleDateString(undefined,{weekday:'long',month:'long',day:'numeric'});
  document.getElementById('headerClock').textContent = d.toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'});
}

/* ---------------- DOM builders ---------------- */
function buildRoomShell(room){
  const el = document.createElement('div');
  el.className = 'room'; el.dataset.roomId = room.id;

  const header = document.createElement('div'); header.className = 'roomHeader';
  const id = document.createElement('div'); id.className = 'id'; id.textContent = room.label;
  const count = document.createElement('div'); count.className = 'count'; count.textContent = '';
  header.append(id, count);

  const pager = document.createElement('div'); pager.className = 'roomPager'; pager.id = `pager-${room.id}`;
  el.append(header, pager);
  return el;
}

// Clean up subtitle text for display
function cleanSubtitle(text=''){
  let t = text;
  // strip internal-only notes
  t = t.replace(/internal hold per nm/igi, '').trim();
  t = t.replace(/\s{2,}/g,' ').replace(/[|]+/g,'').trim();
  return t;
}

// ---- PICKLEBALL RULE ----
// If title/subtitle mentions pickleball, show ONLY “Open Pickleball” as the title,
// drop “RAEC Front Desk, Rentals - On Hold”, and remove “Internal Hold per NM”.
function isPickleball(slot){
  const low = `${slot.title||''} ${slot.subtitle||''}`.toLowerCase();
  return low.includes('pickleball');
}

function eventNode(slot){
  const div = document.createElement('div'); div.className = 'event';

  // Special handling for Pickleball
  if (isPickleball(slot)){
    const who = document.createElement('div'); who.className = 'who';
    const strong = document.createElement('strong'); strong.textContent = 'Open Pickleball';
    who.appendChild(strong);
    div.appendChild(who);

    // Optional: if subtitle had extra NON-internal context, keep it after cleaning
    const cleaned = cleanSubtitle(slot.subtitle||'');
    if (cleaned && !/open pickleball/i.test(cleaned)){
      const what = document.createElement('div'); what.className='what'; what.textContent = cleaned;
      div.appendChild(what);
    }

    const when = document.createElement('div'); when.className='when';
    when.textContent = `${fmt12h(slot.startMin)} – ${fmt12h(slot.endMin)}`;
    div.appendChild(when);
    return div;
  }

  // Default rendering for everything else
  const who = document.createElement('div'); who.className = 'who';
  const title = slot.title || '';
  if (title.includes(',')){
    const [org, contactRaw] = title.split(',',2).map(s=>s.trim());
    const strong = document.createElement('strong'); strong.textContent = org; who.appendChild(strong);
    const contact = contactRaw ? toFirstLast(contactRaw) : '';
    div.appendChild(who);
    if (contact){ const c = document.createElement('div'); c.className='what'; c.textContent = contact; div.appendChild(c); }
  } else {
    const strong = document.createElement('strong'); strong.textContent = title; who.appendChild(strong);
    div.appendChild(who);
  }

  const sub = cleanSubtitle(slot.subtitle||'');
  if (sub){ const what = document.createElement('div'); what.className='what'; what.textContent = sub; div.appendChild(what); }

  const when = document.createElement('div'); when.className='when';
  when.textContent = `${fmt12h(slot.startMin)} – ${fmt12h(slot.endMin)}`;
  div.appendChild(when);
  return div;
}

function paginate(arr, per){ const out=[]; for(let i=0;i<arr.length;i+=per) out.push(arr.slice(i,i+per)); return out.length?out:[[]]; }

/* ---------------- keyframe slide swap ---------------- */
function swapPage(container, newPage, dir='left'){
  const old = container.querySelector('.roomPage');

  newPage.classList.add('roomPage', dir==='left' ? 'anim-in-left' : 'anim-in-right');
  container.appendChild(newPage);

  if (old){
    old.classList.remove('anim-in-left','anim-in-right','anim-out-left','anim-out-right');
    old.classList.add(dir==='left' ? 'anim-out-left' : 'anim-out-right');
    const done = () => old.remove();
    old.addEventListener('animationend', done, { once:true });
    setTimeout(done, 1300);
  }
}

/* ---------------- per-room paging ---------------- */
function renderRoomPaged(pager, room, items, perPage, rotateMs){
  // header count
  const countEl = pager.parentElement.querySelector('.count');
  countEl.textContent = items.length ? `${items.length} event${items.length>1?'s':''}` : '';

  const pages = paginate(items, perPage);
  let idx = 0;
  const make = i => {
    const p = document.createElement('div');
    for (const it of pages[i]) p.appendChild(eventNode(it));
    return p;
  };

  swapPage(pager, make(0), 'left');

  if (pages.length <= 1) { if (pager._rot) clearInterval(pager._rot); return; }

  if (pager._rot) clearInterval(pager._rot);
  pager._rot = setInterval(() => {
    const prev = idx; idx = (idx+1) % pages.length;
    swapPage(pager, make(idx), idx>prev ? 'left' : 'right');
  }, rotateMs);
}

/* ---------------- mount + render all ---------------- */
function mountRooms(rooms){
  const south = document.getElementById('southRooms');
  const field = document.getElementById('fieldhouseRooms');
  const north = document.getElementById('northRooms');
  south.innerHTML=''; field.innerHTML=''; north.innerHTML='';

  for (const r of rooms){
    const shell = buildRoomShell(r);
    if (r.group==='south') south.appendChild(shell);
    else if (r.group==='fieldhouse') field.appendChild(shell);
    else north.appendChild(shell);
  }
}
function renderAll(rooms, slots){
  mountRooms(rooms);
  const now = new Date(); const nowMin = now.getHours()*60 + now.getMinutes();
  const future = filterFutureSlots(slots, nowMin);
  const map = byRoom(future);

  for (const r of rooms){
    const list = (map.get(r.id)||[]).sort((a,b)=> (a.startMin-b.startMin) || ((a.title||'').localeCompare(b.title||'')));
    const pager = document.getElementById(`pager-${r.id}`);
    const per =
      r.group==='fieldhouse' ? PER_PAGE_FIELD :
      r.group==='south'      ? PER_PAGE_SOUTH :
                               PER_PAGE_NORTH;
    renderRoomPaged(pager, r, list, per, ROTATE_MS);
  }
}

/* ---------------- boot ---------------- */
function init(){
  renderHeader(); setInterval(renderHeader, CLOCK_INTERVAL_MS);

  loadEvents().then(data => {
    const rooms = Array.isArray(data.rooms)?data.rooms:[]; 
    const slots = Array.isArray(data.slots)?data.slots:[];
    renderAll(rooms, slots);
  }).catch(console.error);

  // refresh every 5 min
  setInterval(async () => {
    try {
      const fresh = await loadEvents();
      renderAll(Array.isArray(fresh.rooms)?fresh.rooms:[], Array.isArray(fresh.slots)?fresh.slots:[]);
    } catch {}
  }, 5*60*1000);
}
document.addEventListener('DOMContentLoaded', init);
