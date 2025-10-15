// === constants & helpers ===
const ORDER = [
  "1A","1B","2A","2B","3","4","5","6","7","8","9A","9B","10A","10B"
];
const ROWS = [["1A","1B"],["2A","2B"],["3","4"],["5","6"],["7","8"],["9A","9B"],["10A","10B"]];

const SOUTH = ["2B","2A","1B","1A"];   // left column top->bottom
const FIELD_L = ["5","4","3"];         // middle-left top->bottom
const FIELD_R = ["8","7","6"];         // middle-right top->bottom
const NORTH = ["10B","10A","9B","9A"]; // right column top->bottom

const DAY_START = 360, DAY_END = 1380;

const fmtTime = m => {
  const h24 = Math.floor(m/60), mm = (m%60).toString().padStart(2,'0');
  const h = (h24 % 12) || 12, ampm = h24 < 12 ? 'am' : 'pm';
  return `${h}:${mm}${ampm}`;
};

async function loadData(){
  const url = `./events.json?ts=${Date.now()}`;
  const r = await fetch(url, { cache: 'no-store' });
  if(!r.ok) throw new Error(`Failed to fetch ${url}: ${r.status}`);
  const data = await r.json();
  console.log('Loaded events:', { rooms:Object.keys(data.rooms||{}).length, slots:(data.slots||[]).length });
  return data;
}

// === header ===
function renderHeader(){
  const d = document.getElementById('headerDate');
  const c = document.getElementById('headerClock');
  const tick = () => {
    const now = new Date();
    d.textContent = now.toLocaleDateString(undefined, { weekday:'long', month:'long', day:'numeric', year:'numeric' });
    c.textContent = now.toLocaleTimeString(undefined, { hour:'2-digit', minute:'2-digit' });
  };
  tick(); setInterval(tick, 1000);
}

// === timeline pieces (kept) ===
function renderRoomsColumn(){
  const box = document.querySelector('.rooms');
  box.querySelectorAll('.room').forEach(n=>n.remove());
  // 10 rows × 2 cells (1A..10B)
  const pairs = [["1A","1B"],["2A","2B"],["3A","3B"],["4A","4B"],["5A","5B"],["6A","6B"],["7A","7B"],["8A","8B"],["9A","9B"],["10A","10B"]];
  pairs.forEach(([a,b])=>{
    const row = document.createElement('div'); row.className='room';
    const ca = document.createElement('div'); ca.textContent=a;
    const cb = document.createElement('div'); cb.textContent=b;
    row.append(ca,cb); box.appendChild(row);
  });
}
function renderGridBackdrop(dayStart=DAY_START, dayEnd=DAY_END){
  const hoursRow = document.getElementById('hoursRow');
  const gridBackdrop = document.getElementById('gridBackdrop');
  const cols = (dayEnd - dayStart)/60;
  hoursRow.style.gridTemplateColumns = `repeat(${cols},1fr)`;
  document.documentElement.style.setProperty('--cols', `repeat(${cols*4},1fr)`);
  hoursRow.innerHTML='';
  for(let i=0;i<cols;i++){
    const t = dayStart + i*60;
    const div = document.createElement('div');
    div.textContent = fmtTime(t);
    hoursRow.appendChild(div);
  }
  gridBackdrop.innerHTML='';
  for(let r=0;r<10;r++){
    for(let c=0;c<cols*4;c++){
      const cell = document.createElement('div'); cell.className='cell';
      gridBackdrop.appendChild(cell);
    }
  }
}
function renderSlots(data){
  const lanes = document.getElementById('lanes');
  const grid = document.getElementById('grid');
  const nowLine = document.getElementById('nowLine');
  lanes.innerHTML='';
  grid.querySelectorAll('.chip').forEach(n=>n.remove());
  for(let i=0;i<10;i++) lanes.appendChild(document.createElement('div'));

  const now = new Date(); const nowMin = now.getHours()*60 + now.getMinutes();
  const total = DAY_END - DAY_START;

  (data.slots||[])
    .filter(s => s.endMin > nowMin) // hide past
    .forEach(s=>{
      // map room to a timeline row index; default to last row if unknown
      const rowIndex = Math.max(0, Math.min(9,
        [["1A","1B"],["2A","2B"],["3","4"],["5","6"],["7","8"],["9A","9B"],["10A","10B"],["x","x"],["x","x"],["x","x"]]
          .findIndex(p=>p.includes(s.room))
      ));

      const start = Math.max(s.startMin, DAY_START);
      const end = Math.min(s.endMin, DAY_END);
      const leftPct = ((start - DAY_START)/total)*100;
      const widthPct = ((end - start)/total)*100;
      const chip = document.createElement('div');
      chip.className='chip';
      chip.style.top = `calc(${rowIndex} * (100%/10))`;
      chip.style.height=`calc(100%/10 - 2px)`;
      chip.style.left=`${leftPct}%`;
      chip.style.width=`${widthPct}%`;
      chip.innerHTML = `<strong>${s.title || s.reservee || 'Reserved'}</strong><small>${fmtTime(s.startMin)}–${fmtTime(s.endMin)} • ${s.room}</small>`;
      grid.appendChild(chip);
    });

  if (nowMin>=DAY_START && nowMin<=DAY_END){
    nowLine.style.left = `${((nowMin - DAY_START)/total)*100}%`;
    nowLine.hidden = false;
  } else nowLine.hidden = true;
}

// === new: whiteboard-style grid ===
function renderGridBoard(data){
  const left = document.getElementById('gbLeft');
  const midL = document.getElementById('gbMidL');
  const midR = document.getElementById('gbMidR');
  const right= document.getElementById('gbRight');
  [left,midL,midR,right].forEach(el => el.innerHTML='');

  // Group events by room id
  const byRoom = {};
  [...SOUTH, ...FIELD_L, ...FIELD_R, ...NORTH].forEach(r => byRoom[r] = []);
  (data.slots||[]).forEach(s => { if(byRoom[s.room]) byRoom[s.room].push(s); });
  for (const r in byRoom) byRoom[r].sort((a,b)=>a.startMin-b.startMin);

  const makeCell = (roomId) => {
    const cell = document.createElement('div'); cell.className='gb-cell';
    const head = document.createElement('div'); head.className='gb-room'; head.textContent=roomId;
    cell.appendChild(head);
    const list = byRoom[roomId] || [];
    if (list.length===0) {
      const empty = document.createElement('div'); empty.className='gb-empty'; empty.textContent='';
      cell.appendChild(empty);
    } else {
      list.forEach(ev=>{
        const row = document.createElement('div'); row.className='gb-event';
        const t = document.createElement('span'); t.className='gb-time'; t.textContent = `${fmtTime(ev.startMin)}–${fmtTime(ev.endMin)}`;
        const lbl = document.createElement('span'); lbl.textContent = ev.title || ev.reservee || 'Reserved';
        row.append(t,lbl); cell.appendChild(row);
      });
    }
    return cell;
  };

  SOUTH.forEach(r => left.appendChild(makeCell(r)));
  FIELD_L.forEach(r => midL.appendChild(makeCell(r)));
  FIELD_R.forEach(r => midR.appendChild(makeCell(r)));
  NORTH.forEach(r => right.appendChild(makeCell(r)));
}

// === view switching & init ===
function setActive(view){
  document.querySelectorAll('.tab').forEach(t=>t.classList.toggle('is-active', t.dataset.view===view));
  document.getElementById('timelineView').style.display = (view==='timeline') ? 'grid' : 'none';
  document.getElementById('gridView').classList.toggle('is-active', view==='grid');
}

async function init(){
  renderHeader();
  const data = await loadData();

  // timeline
  renderRoomsColumn();
  renderGridBackdrop(data.dayStartMin||DAY_START, data.dayEndMin||DAY_END);
  renderSlots(data);

  // whiteboard grid
  renderGridBoard(data);

  // rotate every 20s (set to false to pin one)
  const AUTO_ROTATE = true;
  let view = 'timeline'; setActive(view);
  if (AUTO_ROTATE) setInterval(()=>{ view = (view==='timeline')?'grid':'timeline'; setActive(view); }, 20000);

  document.getElementById('tabBar').addEventListener('click', e=>{
    const t = e.target.closest('.tab'); if(!t) return; setActive(t.dataset.view);
  });
}

document.addEventListener('DOMContentLoaded', init);
