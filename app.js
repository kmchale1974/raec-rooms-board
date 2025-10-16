// app.js — Grid-only board with dedupe, past-event pruning, and auto-refresh

// ---------- Utilities ----------
const $ = sel => document.querySelector(sel);
const $$ = sel => Array.from(document.querySelectorAll(sel));

function fmtClock(d=new Date()){
  // 12h clock with minutes
  let h = d.getHours();
  const m = d.getMinutes().toString().padStart(2,'0');
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${m} ${ampm}`;
}
function fmtDate(d=new Date()){
  return d.toLocaleDateString(undefined, {
    weekday:'long', month:'long', day:'numeric', year:'numeric'
  });
}
function minsToRange(startMin, endMin){
  const toClock = (min) => {
    const h24 = Math.floor(min / 60);
    const m    = (min % 60).toString().padStart(2,'0');
    const ampm = h24 >= 12 ? 'PM' : 'AM';
    const h12  = (h24 % 12) || 12;
    return `${h12}:${m} ${ampm}`;
  };
  return `${toClock(startMin)} – ${toClock(endMin)}`;
}
function norm(s){ return (s||'').trim().replace(/\s+/g,' ').toLowerCase(); }

// ---------- De-dupe & Merge ----------
function dedupeExact(slots){
  const seen = new Set();
  const out = [];
  for (const s of slots){
    const key = [s.roomId, s.startMin, s.endMin, norm(s.title), norm(s.subtitle)].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}
function mergeAdjacent(slots){
  const byRoom = new Map();
  for (const s of slots){
    if (!byRoom.has(s.roomId)) byRoom.set(s.roomId, []);
    byRoom.get(s.roomId).push({...s});
  }
  const merged = [];
  for (const [roomId, arr] of byRoom.entries()){
    arr.sort((a,b)=> a.startMin - b.startMin || a.endMin - b.endMin);
    let cur = null;
    for (const ev of arr){
      if (
        cur &&
        cur.endMin === ev.startMin &&
        norm(cur.title) === norm(ev.title) &&
        norm(cur.subtitle) === norm(ev.subtitle)
      ){
        cur.endMin = ev.endMin; // extend
      } else {
        if (cur) merged.push(cur);
        cur = ev;
      }
    }
    if (cur) merged.push(cur);
  }
  return merged;
}
function cleanSlots(slots, nowMin){
  const upcoming = (slots || []).filter(s => s.endMin > nowMin);
  const uniq     = dedupeExact(upcoming);
  const merged   = mergeAdjacent(uniq);
  // sort inside each room by start time
  merged.sort((a,b)=> (a.roomId.localeCompare(b.roomId)) || (a.startMin - b.startMin));
  return merged;
}

// ---------- Data loader ----------
async function loadData(){
  const url = `./events.json?ts=${Date.now()}`;
  const resp = await fetch(url, { cache:'no-store' });
  if (!resp.ok) throw new Error(`Failed to fetch ${url}: ${resp.status} ${resp.statusText}`);
  const data = await resp.json();
  console.log('Loaded events.json', data ? (typeof data) : 'null');
  return data;
}

// ---------- Room ordering / clustering ----------
const SOUTH = ['1A','1B','2A','2B'];
const NORTH = ['9A','9B','10A','10B'];
// Fieldhouse is everything else in 3A..8B, in A/B order:
const FIELDHOUSE = ['3A','3B','4A','4B','5A','5B','6A','6B','7A','7B','8A','8B'];

// ---------- Render ----------
function renderHeader(){
  $('#headerDate').textContent  = fmtDate();
  $('#headerClock').textContent = fmtClock();
}

function renderClusterRooms(containerEl, roomIds, slotsByRoom){
  containerEl.innerHTML = ''; // clear
  for (const id of roomIds){
    const pillHtml = (slotsByRoom.get(id) || []).map(s => {
      const line1 = s.title || '';
      const line2 = s.subtitle ? `<small>${s.subtitle}</small>` : '';
      const time  = minsToRange(s.startMin, s.endMin);
      return `
        <div class="pill">
          <div>
            <strong>${escapeHtml(line1)}</strong>
            ${line2}
          </div>
          <div class="time">${time}</div>
        </div>
      `;
    }).join('');

    const body = pillHtml || `<div class="empty">No current/upcoming events</div>`;

    containerEl.insertAdjacentHTML('beforeend', `
      <div class="room">
        <div class="title">
          <div>${id}</div>
          <div class="badge">${(slotsByRoom.get(id) || []).length} event${(slotsByRoom.get(id)||[]).length===1?'':'s'}</div>
        </div>
        <div class="body">
          ${body}
        </div>
      </div>
    `);
  }
}

function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, c => (
    { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]
  ));
}

function renderBoard(data){
  const now = new Date();
  const nowMin = now.getHours()*60 + now.getMinutes();

  // Clean + filter
  const cleaned = cleanSlots(data.slots || [], nowMin);
  console.log(`Slots filtered by time+dedupe: ${ (data.slots||[]).length } -> ${ cleaned.length } (now=${nowMin})`);

  // Index by room
  const byRoom = new Map();
  // Initialize all rooms even if empty (so UI shows boxes)
  const allRooms = [...SOUTH, ...FIELDHOUSE, ...NORTH];
  for (const r of allRooms) byRoom.set(r, []);
  for (const s of cleaned){
    if (!byRoom.has(s.roomId)) continue; // ignore rooms not on the grid
    byRoom.get(s.roomId).push(s);
  }

  // Render clusters
  renderClusterRooms($('#southGrid'), SOUTH, byRoom);
  renderClusterRooms($('#fhGrid'),    FIELDHOUSE, byRoom);
  renderClusterRooms($('#northGrid'), NORTH, byRoom);
}

// ---------- Init / Loop ----------
async function tick(){
  try{
    renderHeader();
    const data = await loadData();
    renderBoard(data);
  }catch(err){
    console.error(err);
  }
}

function startClock(){
  // refresh clock text every 10s
  setInterval(()=> renderHeader(), 10_000);
}
function startAutoRefresh(){
  // reload events every 60s so past events fall off
  setInterval(()=> tick(), 60_000);
}

document.addEventListener('DOMContentLoaded', () => {
  tick();
  startClock();
  startAutoRefresh();
});
