// app.js — robust grid with per-room paging + safe pickleball rule

/************ constants ************/
const CLOCK_INTERVAL_MS = 30_000;     // header clock refresh
const REFRESH_MS        = 5 * 60_000; // re-poll events.json
const ROTATE_MS         = 8_000;      // per-room page rotate

// per-room items per page (so cards don’t clip)
const PER_PAGE = {
  south:      4,   // rooms 1–2
  fieldhouse: 3,   // rooms 3–8
  north:      4,   // rooms 9–10
};

/************ tiny utils ************/
const two = n => (n < 10 ? "0" + n : "" + n);
function fmt12h(mins){
  let h = Math.floor(mins/60), m = mins%60;
  const ampm = h>=12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${two(m)} ${ampm}`;
}
function safeArray(a){ return Array.isArray(a) ? a : []; }
function isNum(x){ return typeof x === 'number' && Number.isFinite(x); }

/************ name helpers ************/
function isLikelyOrg(text=""){
  const low = text.toLowerCase();
  return [
    'club','basketball','volleyball','academy','elite','united','athletics','soccer',
    'football','gym','llc','inc','rec','flight','pink','empower','extreme'
  ].some(k => low.includes(k));
}
function isPersonName(text){
  if (!text || !text.includes(',')) return false;
  const [last, first] = text.split(',',2).map(s=>s.trim());
  if (!last || !first) return false;
  if (isLikelyOrg(text)) return false;
  return /^[a-zA-Z' \-]+$/.test(last) && /^[a-zA-Z' \-]+$/.test(first);
}
function toFirstLast(t){
  return isPersonName(t) ? t.split(',',2).map(s=>s.trim()).reverse().join(' ') : t;
}

/************ pickleball + text cleaning ************/
function isPickleball(slot){
  const low = `${slot?.title||''} ${slot?.subtitle||''}`.toLowerCase();
  return low.includes('pickleball');
}
function cleanSubtitle(text=''){
  return text
    .replace(/internal hold per nm/ig, '')       // strip internal note
    .replace(/raec front desk, rentals - on hold/ig, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/[|]+/g, '')
    .trim();
}

/************ data loading ************/
async function loadEvents(){
  const url = `./events.json?ts=${Date.now()}`;
  const r = await fetch(url, { cache:'no-store' });
  if (!r.ok) throw new Error(`Failed to fetch ${url}: ${r.status}`);
  const data = await r.json();
  console.log('Loaded events.json', data);
  return data;
}

/************ filters & grouping ************/
function filterFutureSlots(slots, nowMin){
  const input = safeArray(slots);
  const out = [];
  for (const s of input){
    // validate each slot to avoid runtime errors
    if (!s || !s.roomId) continue;
    if (!isNum(s.startMin) || !isNum(s.endMin)) continue;
    if (s.endMin < nowMin) continue; // drop past
    out.push(s);
  }
  console.log(`Slots filtered by time: ${input.length} -> ${out.length} (now=${nowMin})`);
  return out;
}
function byRoom(slots){
  const m = new Map();
  for (const s of slots){
    if (!m.has(s.roomId)) m.set(s.roomId, []);
    m.get(s.roomId).push(s);
  }
  return m;
}

/************ header ************/
function renderHeader(){
  const d = new Date();
  const dateEl  = document.getElementById('headerDate');
  const clockEl = document.getElementById('headerClock');
  if (dateEl)  dateEl.textContent  = d.toLocaleDateString(undefined,{ weekday:'long', month:'long', day:'numeric' });
  if (clockEl) clockEl.textContent = d.toLocaleTimeString(undefined,{ hour:'numeric', minute:'2-digit' });
}

/************ DOM builders ************/
function buildRoomShell(room){
  const el = document.createElement('div');
  el.className = 'room';
  el.dataset.roomId = room.id;

  const header = document.createElement('div');
  header.className = 'roomHeader';

  const id = document.createElement('div');
  id.className = 'id';
  id.textContent = room.label;

  const count = document.createElement('div');
  count.className = 'count';
  count.textContent = '';

  header.append(id, count);

  const pager = document.createElement('div');
  pager.className = 'roomPager';
  pager.id = `pager-${room.id}`;

  el.append(header, pager);
  return el;
}

function eventNode(slot){
  // ultra defensive: never throw here
  try{
    const div = document.createElement('div');
    div.className = 'event';

    if (isPickleball(slot)){
      const who = document.createElement('div'); who.className='who';
      const strong = document.createElement('strong'); strong.textContent = 'Open Pickleball';
      who.appendChild(strong);
      div.appendChild(who);

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

    // Normal rendering
    const who = document.createElement('div'); who.className='who';
    const title = slot.title || '';
    if (title.includes(',')){
      const [org, contactRaw] = title.split(',',2).map(s=>s.trim());
      const strong = document.createElement('strong'); strong.textContent = org; who.appendChild(strong);
      div.appendChild(who);

      const contact = contactRaw ? toFirstLast(contactRaw) : '';
      if (contact){
        const c = document.createElement('div'); c.className='what'; c.textContent = contact;
        div.appendChild(c);
      }
    } else {
      const strong = document.createElement('strong'); strong.textContent = title;
      who.appendChild(strong);
      div.appendChild(who);
    }

    const sub = cleanSubtitle(slot.subtitle||'');
    if (sub){
      const what = document.createElement('div'); what.className='what'; what.textContent = sub;
      div.appendChild(what);
    }

    const when = document.createElement('div'); when.className='when';
    when.textContent = `${fmt12h(slot.startMin)} – ${fmt12h(slot.endMin)}`;
    div.appendChild(when);

    return div;
  } catch (e){
    console.warn('eventNode error; slot skipped', e, slot);
    const div = document.createElement('div');
    div.className = 'event';
    div.textContent = '—';
    return div;
  }
}

function paginate(arr, per){
  const out = [];
  for (let i=0;i<arr.length;i+=per) out.push(arr.slice(i,i+per));
  return out.length ? out : [[]];
}

/************ page swap (animation class hooks are in CSS) ************/
function swapPage(container, newPage, dir='left'){
  newPage.classList.add('roomPage', dir==='left' ? 'anim-in-left' : 'anim-in-right');
  container.appendChild(newPage);

  const old = Array.from(container.children).find(c => c !== newPage && c.classList.contains('roomPage'));
  if (old){
    old.classList.remove('anim-in-left','anim-in-right','anim-out-left','anim-out-right');
    old.classList.add(dir==='left' ? 'anim-out-left' : 'anim-out-right');
    const done = () => old.remove();
    old.addEventListener('animationend', done, { once:true });
    setTimeout(done, 1500);
  }
}

/************ per-room paging ************/
function renderRoomPaged(pager, room, items, perPage, rotateMs){
  const countEl = pager.parentElement.querySelector('.count');
  countEl.textContent = items.length ? `${items.length} event${items.length>1?'s':''}` : '';

  const pages = paginate(items, perPage);
  let idx = 0;

  const build = i => {
    const page = document.createElement('div');
    page.className = 'roomPage';
    for (const it of pages[i]) page.appendChild(eventNode(it));
    return page;
  };

  // first render
  pager.innerHTML = '';
  swapPage(pager, build(0), 'left');

  // rotate if more than one page
  if (pager._rot) clearInterval(pager._rot);
  if (pages.length <= 1) return;

  pager._rot = setInterval(() => {
    const prev = idx;
    idx = (idx + 1) % pages.length;
    swapPage(pager, build(idx), idx > prev ? 'left' : 'right');
  }, rotateMs);
}

/************ layout mount + render ************/
function mountRooms(rooms){
  const south = document.getElementById('southRooms');
  const field = document.getElementById('fieldhouseRooms');
  const north = document.getElementById('northRooms');
  if (!south || !field || !north) return;

  south.innerHTML=''; field.innerHTML=''; north.innerHTML='';

  for (const r of rooms){
    const shell = buildRoomShell(r);
    if (r.group === 'south') south.appendChild(shell);
    else if (r.group === 'fieldhouse') field.appendChild(shell);
    else north.appendChild(shell);
  }
}

function renderAll(rooms, slots){
  mountRooms(rooms);

  const now = new Date();
  const nowMin = now.getHours()*60 + now.getMinutes();
  const future = filterFutureSlots(slots, nowMin);
  const grouped = byRoom(future);

  for (const r of rooms){
    const list = safeArray(grouped.get(r.id)).sort(
      (a,b) => (a.startMin - b.startMin) || String(a.title||'').localeCompare(String(b.title||''))
    );
    const pager = document.getElementById(`pager-${r.id}`);
    if (!pager) continue;
    const per = PER_PAGE[r.group] ?? 4;
    renderRoomPaged(pager, r, list, per, ROTATE_MS);
  }
}

/************ boot ************/
function init(){
  // header clock
  renderHeader();
  setInterval(renderHeader, CLOCK_INTERVAL_MS);

  // first load
  loadEvents()
    .then(data => {
      const rooms = safeArray(data.rooms);
      const slots = safeArray(data.slots);
      renderAll(rooms, slots);
    })
    .catch(err => console.error('Init failed:', err));

  // refresh periodically
  setInterval(async () => {
    try{
      const fresh = await loadEvents();
      renderAll(safeArray(fresh.rooms), safeArray(fresh.slots));
    }catch(e){
      console.warn('Refresh failed', e);
    }
  }, REFRESH_MS);
}
document.addEventListener('DOMContentLoaded', init);
