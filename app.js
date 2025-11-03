// RAEC Rooms Board front-end
const NOW_TICK_MS = 1000;           // clock tick
const ROTATE_MS   = 6000;           // per-room event rotation
const PAGE_MS     = 8000;           // fieldhouse page dwell (we have one page but keep logic)
const REFRESH_MS  = 60 * 1000;      // re-pull events.json every minute

const roomsSouth = ['1A','1B','2A','2B'];
const roomsField = ['3','4','5','6','7','8'];
const roomsNorth = ['9A','9B','10A','10B'];

const roomAll = [...roomsSouth, ...roomsField, ...roomsNorth];

function pad2(n){ return String(n).padStart(2,'0'); }
function minutesNowLocal(){
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

function setHeaderClock(){
  const d = new Date();
  const dow = d.toLocaleDateString(undefined, { weekday: 'long' });
  const mon = d.toLocaleDateString(undefined, { month: 'long' });
  const date = d.getDate();
  const yr = d.getFullYear();
  const h = d.getHours();
  const m = pad2(d.getMinutes());
  const s = pad2(d.getSeconds());
  const ampm = h >= 12 ? 'PM' : 'AM';
  const hh = ((h + 11) % 12) + 1;
  document.getElementById('headerDate').textContent = `${dow}, ${mon} ${date}, ${yr}`;
  document.getElementById('headerClock').textContent = `${hh}:${m}:${s} ${ampm}`;
}

function makeEventChip(slot){
  const el = document.createElement('div');
  el.className = 'event';
  const who = document.createElement('div');
  who.className = 'who';
  who.textContent = slot.title || 'Reservation';

  const what = document.createElement('div');
  what.className = 'what';
  what.textContent = slot.subtitle || '';

  const when = document.createElement('div');
  when.className = 'when';
  const t = (min)=> {
    let h = Math.floor(min/60), m = min%60;
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = ((h + 11) % 12) + 1;
    return `${h}:${pad2(m)} ${ampm}`;
  };
  when.textContent = `${t(slot.startMin)} – ${t(slot.endMin)}`;

  el.appendChild(who);
  if (what.textContent.trim()) el.appendChild(what);
  el.appendChild(when);
  return el;
}

// Smooth single-card rotor (always keep one .event on screen)
function startRotor(root, events){
  if (!root) return;
  root.innerHTML = '';
  if (!events || events.length === 0){
    const empty = document.createElement('div');
    empty.className = 'event';
    empty.innerHTML = `<div class="who">—</div><div class="what">No upcoming reservations</div>`;
    root.appendChild(empty);
    return;
  }

  let idx = 0;
  let cur = makeEventChip(events[idx]);
  root.appendChild(cur);

  setInterval(()=> {
    const nextIdx = (idx + 1) % events.length;
    const next = makeEventChip(events[nextIdx]);

    // prepare states
    next.classList.add('is-enter');
    root.appendChild(next);
    // force reflow so transitions apply
    void next.offsetWidth;

    // animate
    cur.classList.add('is-exit');
    next.classList.add('is-enter-to');

    // after transition, finalize and cleanup
    setTimeout(()=>{
      cur.remove();
      next.classList.remove('is-enter','is-enter-to');
      idx = nextIdx;
      cur = next;
    }, 740); // must match --dur
  }, ROTATE_MS);
}

function updateCounts(roomId, count){
  const el = document.querySelector(`#room-${CSS.escape(roomId)} .roomHeader .count em`);
  if (el) el.textContent = String(count);
}

function systemFilter(slot){
  // Drop system/holds/turf install lines that should not display
  const t = (slot.title || '').toLowerCase();
  const s = (slot.subtitle || '').toLowerCase();
  if (t.includes('raec front desk')) return false;
  if (s.includes('turf install per nm')) return false;
  if (s.includes('internal hold per nm')) return false;
  return true;
}

function timeFilter(slot, nowMin){
  // show ongoing or upcoming (hide if ended)
  return slot.endMin > nowMin;
}

async function loadData(){
  const bust = `?v=${Date.now()}`;
  const res = await fetch(`./events.json${bust}`, { cache:'no-store' });
  if (!res.ok) throw new Error('failed to fetch events.json');
  return res.json();
}

function byStartThenTitle(a,b){
  if (a.startMin !== b.startMin) return a.startMin - b.startMin;
  return (a.title||'').localeCompare(b.title||'');
}

// Build the fieldhouse pager (single page 3..8; but keep pager hooks for future)
function buildFieldhousePage(){
  const pager = document.getElementById('fieldhousePager');
  pager.innerHTML = '';
  const page = document.createElement('div');
  page.className = 'page is-active';
  const ids = roomsField;
  for (const id of ids){
    const card = document.createElement('div');
    card.className = 'room';
    card.id = `room-${id}`;
    card.innerHTML = `
      <div class="roomHeader">
        <div class="id">${id}</div>
        <div class="count">reservations: <em>—</em></div>
      </div>
      <div class="events"><div class="single-rotor"></div></div>
    `;
    page.appendChild(card);
  }
  pager.appendChild(page);
}

async function render(){
  setHeaderClock();

  // ensure fieldhouse grid exists
  buildFieldhousePage();

  const data = await loadData();

  const nowMin = minutesNowLocal();

  // index slots per room
  const slotsByRoom = {};
  for (const r of roomAll) slotsByRoom[r] = [];

  for (const s of (data.slots || [])){
    if (!s || !s.roomId) continue;
    if (!roomAll.includes(s.roomId)) continue;

    if (!systemFilter(s)) continue;
    if (!timeFilter(s, nowMin)) continue;

    slotsByRoom[s.roomId].push(s);
  }

  // sort and mount rotors
  for (const r of roomAll){
    const container = document.querySelector(`#room-${CSS.escape(r)} .single-rotor`);
    const arr = (slotsByRoom[r] || []).sort(byStartThenTitle);
    updateCounts(r, arr.length);
    startRotor(container, arr);
  }
}

function start(){
  // live clock
  setHeaderClock();
  setInterval(setHeaderClock, NOW_TICK_MS);

  // initial render + refresh loop
  render().catch(console.error);
  setInterval(()=> render().catch(console.error), REFRESH_MS);
}

document.addEventListener('DOMContentLoaded', start);
