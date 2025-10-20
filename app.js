// app.js (ESM front-end)

const GRID_ID = 'gridwrap';
const CLOCK_ID = 'clock';

// fetch JSON with cache-bust
async function loadData(){
  const url = `./events.json?ts=${Date.now()}`;
  const resp = await fetch(url, { cache: 'no-store' });
  if(!resp.ok) throw new Error(`Failed to fetch ${url}: ${resp.status}`);
  const data = await resp.json();
  console.log('Loaded events.json', data);
  return data;
}

function nowMinutes(){
  const d=new Date();
  return d.getHours()*60 + d.getMinutes();
}

function formatTime(min){
  let h=Math.floor(min/60), m=min%60;
  const ap = h>=12 ? 'pm':'am';
  h = h%12 || 12;
  return `${h}:${String(m).padStart(2,'0')}${ap}`;
}

// render header clock
function startClock(){
  const el = document.getElementById(CLOCK_ID);
  function tick(){
    const d=new Date();
    const opts={weekday:'long', month:'long', day:'numeric'};
    el.textContent = `${d.toLocaleDateString(undefined,opts)} • ${d.toLocaleTimeString([], {hour:'numeric', minute:'2-digit'})}`;
  }
  tick();
  setInterval(tick, 1000*15);
}

function groupClass(id){
  if(id==='1'||id==='2') return 'south';
  if(id==='9'||id==='10') return 'north';
  return 'field';
}

function buildRoomCell(room, events){
  const cell = document.createElement('div');
  cell.className = `cell ${groupClass(room.id)}`;

  const head = document.createElement('div');
  head.className='roomtag';
  head.innerHTML = `<span>${room.label}</span><span class="badge">${room.group}</span>`;
  cell.appendChild(head);

  const wrap = document.createElement('div'); wrap.className='events';
  if(!events.length){
    const empty=document.createElement('div'); empty.className='empty'; empty.textContent='No reservations';
    wrap.appendChild(empty);
  }else{
    for(const ev of events){
      const evt=document.createElement('div'); evt.className='evt';
      const t=document.createElement('div'); t.className='title';
      t.textContent = ev.title;
      const s=document.createElement('div'); s.className='sub';
      // show full times inside the event; removed outer time row per your ask
      s.textContent = ev.subtitle ? `${formatTime(ev.startMin)}–${formatTime(ev.endMin)} • ${ev.subtitle}` :
                                    `${formatTime(ev.startMin)}–${formatTime(ev.endMin)}`;
      evt.appendChild(t); evt.appendChild(s);
      wrap.appendChild(evt);
    }
  }
  cell.appendChild(wrap);
  return cell;
}

function renderGrid(data){
  const grid = document.getElementById(GRID_ID);
  grid.innerHTML='';

  const now = nowMinutes();
  // keep events that haven't ended yet
  const futureSlots = (data.slots||[]).filter(s => s.endMin > now);

  // group by room
  const byRoom = new Map();
  for(const r of data.rooms) byRoom.set(r.id, []);
  for(const s of futureSlots){
    if(!byRoom.has(s.roomId)) byRoom.set(s.roomId, []);
    byRoom.get(s.roomId).push(s);
  }
  for(const [id,list] of byRoom){
    list.sort((a,b)=> a.startMin - b.startMin);
  }

  // rooms are already ordered 1..10 in data.rooms
  for(const r of data.rooms){
    const events = byRoom.get(r.id) || [];
    grid.appendChild(buildRoomCell(r, events));
  }
}

async function init(){
  try{
    const data = await loadData();
    startClock();
    renderGrid(data);
    // refresh every minute to remove elapsed events
    setInterval(async ()=>{
      const d=await loadData();
      renderGrid(d);
    }, 60000);
  }catch(e){
    console.error(e);
  }
}

document.addEventListener('DOMContentLoaded', init);
