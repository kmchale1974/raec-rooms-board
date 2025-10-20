// app.js — grid only, no scrollbars, fits 1920×1080, past events auto-hide

// How many events to show per cell (to avoid overflow on non-interactive screens)
const MAX_SHOW_PER_CELL = 3;

// date/clock
function formatDate(d){
  return d.toLocaleDateString(undefined, { weekday:'long', month:'long', day:'numeric' });
}
function formatClock(d){
  return d.toLocaleTimeString(undefined, { hour:'numeric', minute:'2-digit' });
}
function minsToLabel(m){
  const h = Math.floor(m/60), mm = m%60;
  const d = new Date(); d.setHours(h, mm, 0, 0);
  return d.toLocaleTimeString(undefined, { hour:'numeric', minute:'2-digit' });
}

// collapse "X, X" to "X"
function cleanName(s){
  if (!s) return s;
  const parts = s.split(',').map(p=>p.trim()).filter(Boolean);
  if (parts.length>=2 && parts[0].toLowerCase()===parts[1].toLowerCase()) return parts[0];
  return s;
}

async function loadData(){
  const url = `./events.json?ts=${Date.now()}`;
  const resp = await fetch(url, { cache:'no-store' });
  if (!resp.ok) throw new Error(`Failed to fetch ${url}: ${resp.status}`);
  const data = await resp.json();
  console.log('Loaded events.json', data);
  return data;
}

function bucketForRoom(id){
  const n = Number(id);
  if (n===1 || n===2) return 'south';
  if (n>=3 && n<=8) return 'field';
  if (n===9 || n===10) return 'north';
  return 'field';
}

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

function renderCells(data){
  const now = new Date();
  const nowMin = now.getHours()*60 + now.getMinutes();

  // Group by room & hide past
  const perRoom = {};
  (data.slots || []).forEach(s=>{
    if (typeof s.endMin === 'number' && s.endMin <= nowMin) return;
    const roomId = String(s.roomId);
    if (!perRoom[roomId]) perRoom[roomId] = [];
    perRoom[roomId].push({
      startMin: s.startMin,
      endMin: s.endMin,
      title: cleanName((s.title||'').trim()),
      subtitle: (s.subtitle||'').trim()
    });
  });

  ['south','field','north'].forEach(bucket=>{
    const rowEl = document.getElementById(`row-${bucket}`);
    ensureRowSkeleton(rowEl);

    Array.from(rowEl.children).forEach(cell=>{
      const roomId = cell.dataset.room;
      const rBucket = bucketForRoom(roomId);
      const show = (rBucket === bucket);
      cell.style.display = show ? 'flex' : 'none';
      if (!show) return;

      const eventsEl = cell.querySelector('.events');
      const badgeEl = cell.querySelector('.badge');

      let items = (perRoom[roomId] || []).sort((a,b)=>(a.startMin||0)-(b.startMin||0));

      // dedupe exact same (title/subtitle/time), keeps the first
      const seen = new Set();
      items = items.filter(ev=>{
        const key = `${ev.title}|${ev.subtitle}|${ev.startMin}|${ev.endMin}`;
        if (seen.has(key)) return false;
        seen.add(key); return true;
      });

      eventsEl.innerHTML = '';
      const showCount = Math.min(items.length, MAX_SHOW_PER_CELL);
      for (let i=0;i<showCount;i++){
        const ev = items[i];
        const timeStr = (typeof ev.startMin==='number' && typeof ev.endMin==='number')
          ? `${minsToLabel(ev.startMin)} - ${minsToLabel(ev.endMin)}`
          : '';
        const subtitle = ev.subtitle ? ` • ${ev.subtitle}` : '';

        const div = document.createElement('div');
        div.className = 'evt';
        div.innerHTML = `
          <div class="title">${ev.title || ''}</div>
          <div class="time">${timeStr}${subtitle}</div>
        `;
        eventsEl.appendChild(div);
      }
      if (items.length > showCount){
        const more = document.createElement('div');
        more.className = 'more';
        more.textContent = `+${items.length - showCount} more`;
        eventsEl.appendChild(more);
      }

      // “Now” badge if something is currently active
      const active = items.some(ev => ev.startMin <= nowMin && nowMin < ev.endMin);
      if (active){
        badgeEl.textContent = 'Now';
        badgeEl.style.display = 'inline-block';
      }else{
        badgeEl.textContent = '';
        badgeEl.style.display = 'none';
      }
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
    // refresh every minute to drop past events / load new email transform
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
