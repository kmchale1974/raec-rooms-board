// app.js — Collapses A/B to a single court number unless split is needed

// ---------- Utilities ----------
const $ = sel => document.querySelector(sel);

function fmtClock(d=new Date()){
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
function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, c => (
    { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]
  ));
}

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
  return merged;
}

// ---------- Pairs & clusters ----------
const NUMBERS = Array.from({length:10}, (_,i)=> (i+1));      // 1..10
const PAIRS = Object.fromEntries(NUMBERS.map(n => [n, [`${n}A`, `${n}B`]]));

const SOUTH_NUMS = [1,2];
const FIELD_NUMS = [3,4,5,6,7,8];
const NORTH_NUMS = [9,10];

// ---------- A/B collapse decision ----------
function slotsComparable(slots){
  return (slots||[])
    .map(s => ({
      startMin: s.startMin,
      endMin: s.endMin,
      title: norm(s.title),
      subtitle: norm(s.subtitle || '')
    }))
    .sort((a,b)=> a.startMin - b.startMin || a.endMin - b.endMin ||
                 a.title.localeCompare(b.title) || a.subtitle.localeCompare(b.subtitle));
}

function arraysEqual(a,b){
  if (a.length !== b.length) return false;
  for (let i=0;i<a.length;i++){
    const x=a[i], y=b[i];
    if (x.startMin!==y.startMin || x.endMin!==y.endMin || x.title!==y.title || x.subtitle!==y.subtitle) return false;
  }
  return true;
}

function collapseRooms(cleaned){
  // Build by-room map
  const byRoom = new Map();
  for (const s of cleaned){
    if (!byRoom.has(s.roomId)) byRoom.set(s.roomId, []);
    byRoom.get(s.roomId).push(s);
  }
  // Ensure all rooms exist
  for (const n of NUMBERS){
    for (const id of PAIRS[n]){
      if (!byRoom.has(id)) byRoom.set(id, []);
    }
  }

  // For each number, decide collapsed vs split
  const result = new Map(); // key: number (1..10) -> { split:boolean, A:[], B:[], merged:[] }
  for (const n of NUMBERS){
    const [aId, bId] = PAIRS[n];
    const a = byRoom.get(aId) || [];
    const b = byRoom.get(bId) || [];

    const ac = slotsComparable(a);
    const bc = slotsComparable(b);

    const split = !arraysEqual(ac, bc); // if sets differ, we must show split
    if (split){
      result.set(n, { split:true, A:a, B:b, merged:[] });
    } else {
      // equal sets -> collapse to single merged list (a or b)
      result.set(n, { split:false, A:[], B:[], merged:a });
    }
  }
  return result;
}

// ---------- Render ----------
function renderHeader(){
  $('#headerDate').textContent  = fmtDate();
  $('#headerClock').textContent = fmtClock();
}

function pillHtml(s){
  const line1 = s.title || '';
  const line2 = s.subtitle ? `<small>${escapeHtml(s.subtitle)}</small>` : '';
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
}

function renderNumberCard(containerEl, number, model){
  const titleBadgeCount = model.split
    ? (model.A.length + model.B.length)
    : model.merged.length;

  let bodyHtml = '';

  if (model.split){
    // Side-by-side A/B
    const lane = (label, arr) => `
      <div class="lane">
        <h3>${label}</h3>
        ${arr.length ? arr.map(pillHtml).join('') : `<div class="empty">No current/upcoming events</div>`}
      </div>
    `;
    bodyHtml = `
      <div class="split">
        ${lane(`${number}A`, model.A)}
        ${lane(`${number}B`, model.B)}
      </div>
    `;
  } else {
    // Collapsed single list
    bodyHtml = model.merged.length
      ? model.merged.map(pillHtml).join('')
      : `<div class="empty">No current/upcoming events</div>`;
  }

  containerEl.insertAdjacentHTML('beforeend', `
    <div class="room">
      <div class="title">
        <div>${number}${model.split ? ' (split)' : ''}</div>
        <div class="badge">${titleBadgeCount} event${titleBadgeCount===1?'':'s'}</div>
      </div>
      <div class="body">
        ${bodyHtml}
      </div>
    </div>
  `);
}

function renderBoard(data){
  const now = new Date();
  const nowMin = now.getHours()*60 + now.getMinutes();

  const cleaned = cleanSlots(data.slots || [], nowMin);
  const model   = collapseRooms(cleaned);

  // Containers
  const southEl = $('#southGrid');
  const fieldEl = $('#fhGrid');
  const northEl = $('#northGrid');
  southEl.innerHTML = fieldEl.innerHTML = northEl.innerHTML = '';

  for (const n of SOUTH_NUMS) renderNumberCard(southEl, n, model.get(n));
  for (const n of FIELD_NUMS) renderNumberCard(fieldEl, n, model.get(n));
  for (const n of NORTH_NUMS) renderNumberCard(northEl, n, model.get(n));
}

// ---------- Data loader / loop ----------
async function loadData(){
  const url = `./events.json?ts=${Date.now()}`;
  const resp = await fetch(url, { cache:'no-store' });
  if (!resp.ok) throw new Error(`Failed to fetch ${url}: ${resp.status} ${resp.statusText}`);
  const data = await resp.json();
  console.log('Loaded events.json', data ? (typeof data) : 'null');
  return data;
}

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
  setInterval(()=> renderHeader(), 10_000);
}
function startAutoRefresh(){
  setInterval(()=> tick(), 60_000);
}

document.addEventListener('DOMContentLoaded', () => {
  tick();
  startClock();
  startAutoRefresh();
});
