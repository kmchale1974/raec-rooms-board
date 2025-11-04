// Timing
const NOW_TICK_MS = 1000;
const ROTATE_MS   = 6000;
const REFRESH_MS  = 60 * 1000;

const roomsSouth = ['1A','1B','2A','2B'];
const roomsField = ['3','4','5','6','7','8'];
const roomsNorth = ['9A','9B','10A','10B'];
const roomAll = [...roomsSouth, ...roomsField, ...roomsNorth];

// Clock
function pad2(n){ return String(n).padStart(2,'0'); }
function setHeaderClock(){
  const d = new Date();
  const dow = d.toLocaleDateString(undefined, { weekday: 'long' });
  const mon = d.toLocaleDateString(undefined, { month: 'long' });
  document.getElementById('headerDate').textContent = `${dow}, ${mon} ${d.getDate()}, ${d.getFullYear()}`;
  const h = d.getHours(), hh = ((h + 11) % 12) + 1;
  document.getElementById('headerClock').textContent = `${hh}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())} ${h>=12?'PM':'AM'}`;
}
function minutesNowLocal(){ const d = new Date(); return d.getHours()*60 + d.getMinutes(); }

// UI helpers
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
  const fmt = (min)=>{ let h=Math.floor(min/60), m=min%60, ap=h>=12?'PM':'AM'; h=((h+11)%12)+1; return `${h}:${pad2(m)} ${ap}`; };
  when.textContent = `${fmt(slot.startMin)} – ${fmt(slot.endMin)}`;
  el.append(who);
  if (what.textContent.trim()) el.append(what);
  el.append(when);
  return el;
}

function updateCounts(roomId, count){
  const el = document.querySelector(`#room-${CSS.escape(roomId)} .roomHeader .count em`);
  if (el) el.textContent = String(count);
}

// Filters
function systemFilter(s){
  const t = (s.title||'').toLowerCase();
  const u = (s.subtitle||'').toLowerCase();
  if (t.includes('raec front desk')) return false;
  if (u.includes('turf install per nm')) return false;
  if (u.includes('internal hold per nm')) return false;
  return true;
}
function timeFilter(s, nowMin){ return s.endMin > nowMin; }

// Data
async function loadData(){
  const bust = `?v=${Date.now()}`;
  const res = await fetch(`./events.json${bust}`, { cache:'no-store' });
  if (!res.ok) throw new Error('failed to fetch events.json');
  return res.json();
}
function byStartThenTitle(a,b){ if (a.startMin!==b.startMin) return a.startMin-b.startMin; return (a.title||'').localeCompare(b.title||''); }

// Fieldhouse grid builder (one page, but extensible)
function buildFieldhousePage(){
  const pager = document.getElementById('fieldhousePager');
  pager.innerHTML = '';
  const page = document.createElement('div');
  page.className = 'page is-active';
  for (const id of roomsField){
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

// Single-card rotor with smooth slide/fade
function startRotor(root, events){
  if (!root) return;
  root.innerHTML = '';

  // guarantee container has height even if empty
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

  setInterval(()=>{
    const nextIdx = (idx + 1) % events.length;
    const next = makeEventChip(events[nextIdx]);

    // prepare entering state
    next.classList.add('is-enter');
    root.appendChild(next);
    void next.offsetWidth; // reflow

    // animate both
    cur.classList.add('is-exit');
    next.classList.add('is-enter-to');

    // finalize after transition (matches --dur)
    setTimeout(()=>{
      cur.remove();
      next.classList.remove('is-enter','is-enter-to');
      idx = nextIdx;
      cur = next;
    }, 740);
  }, ROTATE_MS);
}

async function render(){
  setHeaderClock();
  buildFieldhousePage();

  const data = await loadData();
  const nowMin = minutesNowLocal();

  // bucket by room
  const byRoom = {};
  for (const r of roomAll) byRoom[r] = [];

  for (const s of (data.slots||[])){
    if (!s || !s.roomId) continue;
    if (!roomAll.includes(s.roomId)) continue;
    if (!systemFilter(s)) continue;
    if (!timeFilter(s, nowMin)) continue;
    byRoom[s.roomId].push(s);
  }

  // Sort + mount
  for (const r of roomAll){
    const arr = byRoom[r].sort(byStartThenTitle);
    updateCounts(r, arr.length);
    const root = document.querySelector(`#room-${CSS.escape(r)} .single-rotor`);
    startRotor(root, arr);
  }
}

function start(){
  setHeaderClock();
  setInterval(setHeaderClock, NOW_TICK_MS);
  render().catch(console.error);
  setInterval(()=>render().catch(console.error), REFRESH_MS);
}

document.addEventListener('DOMContentLoaded', start);
