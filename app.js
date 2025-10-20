// app.js — grid-only board with Fieldhouse row taller and event clamping

const MAX_SHOW_PER_CELL = 5; // show up to this many; rest collapse into "+N more"

// Utility: format today’s date and live clock
function formatDate(d){
  return d.toLocaleDateString(undefined, { weekday:'long', month:'long', day:'numeric' });
}
function formatClock(d){
  return d.toLocaleTimeString(undefined, { hour:'numeric', minute:'2-digit' });
}
// Utility: minutes to "h:mma" (e.g., 18:30 -> "6:30 PM")
function minsToLabel(m){
  const h = Math.floor(m/60), mm = m%60;
  const d = new Date();
  d.setHours(h, mm, 0, 0);
  return d.toLocaleTimeString(undefined, { hour:'numeric', minute:'2-digit' });
}
// Clean repeated org names: "X, X" -> "X"
function cleanName(s){
  if (!s) return s;
  const parts = s.split(',').map(p=>p.trim()).filter(Boolean);
  if (parts.length>=2 && parts[0].toLowerCase()===parts[1].toLowerCase()) return parts[0];
  return s;
}
// Load events.json fresh
async function loadData(){
  const url = `./events.json?ts=${Date.now()}`;
  const resp = await fetch(url, { cache:'no-store' });
  if (!resp.ok) throw new Error(`Failed to fetch ${url}: ${resp.status}`);
  const data = await resp.json();
  console.log('Loaded events.json', data);
  return data;
}

// Map room id -> row bucket
function bucketForRoom(id){
  const n = Number(id);
  if (n===1 || n===2) return 'south';
  if (n>=3 && n<=8) return 'field';
  if (n===9 || n===10) return 'north';
  return 'field';
}

// Render 10 placeholder cells into each row so CSS visibility rules work
function ensureRowSkeleton(rowEl){
  rowEl.innerHTML = '';
  for (let i=1;i<=10;i++){
    const cell = document.createElement('div');
    cell.className = 'cell';
    cell.dataset.room = String(i);
    cell.innerHTML = `
      <div class="cellHeader">
        <span class="roomLabel">${i}</span>
        <span class="badge"></span>
      </div>
      <div class="events"></div>
    `;
    rowEl.appendChild(cell);
  }
}

// Insert events into their room cell with spacing, clamping, and dedupe
function renderCells(data){
  const now = new Date();
  const nowMin = now.getHours()*60 + now.getMinutes();

  // Build per-room list
  const perRoom = {};
  (data.slots || []).forEach(s=>{
    // hide past events
    if (typeof s.endMin === 'number' && s.endMin <= nowMin) return;

    const roomId = String(s.roomId);
    if (!perRoom[roomId]) perRoom[roomId] = [];

    // Normalize/clean title
    const title = cleanName(s.title || '').trim();
    const subtitle = (s.subtitle || '').trim();

    perRoom[roomId].push({
      startMin: s.startMin, endMin: s.endMin,
      title, subtitle
    });
  });

  // Fill rows
  ['south','field','north'].forEach(bucket=>{
    const rowEl = document.getElementById(`row-${bucket}`);
    ensureRowSkeleton(rowEl);

    // For each visible cell in this row, place events
    Array.from(rowEl.children).forEach(cell=>{
      const roomId = cell.dataset.room;
      const rBucket = bucketForRoom(roomId);
      const show = (rBucket === bucket);
      cell.style.display = show ? 'flex' : 'none';
      if (!show) return;

      const eventsEl = cell.querySelector('.events');
      const badgeEl = cell.querySelector('.badge');

      // Sort by start time
      let items = (perRoom[roomId] || []).sort((a,b)=>(a.startMin||0)-(b.startMin||0));

      // Dedupe identical (same title + same window)
      const seen = new Set();
      items = items.filter(ev=>{
        const key = `${ev.title}|${ev.startMin}|${ev.endMin}`;
        if (seen.has(key)) return false;
        seen.add(key); return true;
      });

      // Render up to MAX_SHOW_PER_CELL; remainder -> “+N more”
      eventsEl.innerHTML = '';
      const showCount = Math.min(items.length, MAX_SHOW_PER_CELL);
      for (let i=0;i<showCount;i++){
        const ev = items[i];
        const timeStr = (typeof ev.startMin==='number' && typeof ev.endMin==='number')
          ? `${minsToLabel(ev.startMin)} - ${minsToLabel(ev.endMin)}`
          : '';

        const div = document.createElement('div');
        div.className = 'evt';
        div.innerHTML = `
          <div class="title">${ev.title || ''}</div>
          <div class="time">${timeStr}${ev.subtitle ? ` • ${ev.subtitle}`:''}</div>
        `;
        eventsEl.appendChild(div);
      }
      if (items.length > showCount){
        const more = document.createElement('div');
        more.className = 'more';
        more.textContent = `+${items.length - showCount} more`;
        eventsEl.appendChild(more);
      }

      // Badge: simple “Now” if any event currently active in this room
      const active = items.some(ev => ev.startMin <= nowMin && nowMin < ev.endMin);
      badgeEl.textContent = active ? 'Now' : '';
      badgeEl.style.color = active ? '#fff' : 'var(--muted)';
      badgeEl.style.background = active ? 'var(--accent)' : '#0d1118';
      badgeEl.style.borderColor = active ? 'var(--accent)' : 'var(--grid)';
    });
  });
}

function tickHeader(){
  const now = new Date();
  const d = document.getElementById('headerDate');
  const c = document.getElementById('headerClock');
  if (d) d.textContent = formatDate(now);
  if (c) c.textContent = formatClock(now);
}

async function init(){
  tickHeader();
  setInterval(tickHeader, 1000);

  try{
    const data = await loadData();
    renderCells(data);
    // keep it fresh; re-pull every 60s to drop past events automatically
    setInterval(async ()=>{
      try{
        const fresh = await loadData();
        renderCells(fresh);
      }catch(e){ console.error(e); }
    }, 60000);
  }catch(e){
    console.error(e);
  }
}

document.addEventListener('DOMContentLoaded', init);
