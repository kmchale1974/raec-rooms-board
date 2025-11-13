// app.js — compatible with your current index.html structure
// - South/North rooms already exist in the DOM (room-1A, 1B, 2A, 2B, 9A, 9B, 10A, 10B)
// - Fieldhouse/Turf rooms are dynamically created inside #fieldhousePager

// ---------- small helpers ----------
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

function fmtTime(min) {
  const h24 = Math.floor(min / 60);
  const m = min % 60;
  const ampm = h24 >= 12 ? 'pm' : 'am';
  let h = h24 % 12; if (h === 0) h = 12;
  return `${h}:${m.toString().padStart(2, '0')}${ampm}`;
}

function nowMinutes() {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

function groupByRoom(slots) {
  const map = {};
  for (const s of slots) {
    if (!map[s.roomId]) map[s.roomId] = [];
    map[s.roomId].push(s);
  }
  for (const k in map) map[k].sort((a,b)=>a.startMin-b.startMin);
  return map;
}

// ---------- header + fit ----------
function initHeader() {
  const d = new Date();
  $('#headerDate').textContent = d.toLocaleDateString(undefined, { weekday:'long', month:'long', day:'numeric' });
  const tick = () => $('#headerClock').textContent =
    new Date().toLocaleTimeString(undefined, { hour:'numeric', minute:'2-digit' });
  tick(); setInterval(tick, 1000);
}

(function fitStageSetup(){
  const W=1920, H=1080;
  function fit(){
    const vp=$('.viewport'), stage=$('.stage'); if(!vp||!stage) return;
    const s=Math.min(vp.clientWidth/W, vp.clientHeight/H);
    stage.style.transform=`scale(${s})`;
    stage.style.transformOrigin='top left';
    vp.style.minHeight=(H*s)+'px';
  }
  window.addEventListener('resize',fit);
  window.addEventListener('orientationchange',fit);
  document.addEventListener('DOMContentLoaded',fit);
})();

// ---------- UI builders ----------
function ensureEventsPager(roomEl){
  // Your HTML has <div class="events"></div> in each card
  let host = roomEl.querySelector('.events') || roomEl;
  let pager = host.querySelector('.eventsPager');
  if (!pager) {
    pager = document.createElement('div');
    pager.className = 'eventsPager';
    host.innerHTML = '';
    host.appendChild(pager);
  }
  return pager;
}

function setRoomCount(roomEl, n){
  const el = roomEl.querySelector('.roomHeader .count em');
  if (el) el.textContent = n;
}

function chipHTML(ev){
  if (!ev) return '';
  const sub = ev.subtitle ? `<div class="what">${ev.subtitle}</div>` : '';
  return `
    <div class="event">
      <div class="who">${ev.title}</div>
      ${sub}
      <div class="when">${ev.when}</div>
    </div>
  `;
}

function slideSwap(pager, html, animate){
  const next = document.createElement('div');
  next.className = 'page';
  next.innerHTML = html;

  const current = pager.querySelector('.page');
  if (!animate || !current){
    pager.innerHTML = '';
    pager.appendChild(next);
    return;
  }
  // requires CSS for .slide-in/.slide-out (your stylesheet already has this)
  next.classList.add('slide-in');
  pager.appendChild(next);
  current.classList.add('slide-out');
  setTimeout(()=>{ current.remove(); next.classList.remove('slide-in'); }, 450);
}

// ---------- cluster pager (South/North lockstep) ----------
function buildClusterPages(slotsByRoom, roomIds, nowMin){
  // boundaries across all rooms
  const bounds = new Set();
  for (const rid of roomIds){
    for (const s of (slotsByRoom[rid]||[])){
      if (s.endMin <= nowMin) continue;
      bounds.add(Math.max(0, s.startMin));
      bounds.add(s.endMin);
    }
  }
  const sorted = Array.from(bounds).sort((a,b)=>a-b);
  if (sorted.length < 2) return [];

  const pages = [];
  for (let i=0;i<sorted.length-1;i++){
    const a = sorted[i], b = sorted[i+1];
    if (b <= nowMin) continue;

    const rooms = {};
    let any = false;
    for (const rid of roomIds){
      const s = (slotsByRoom[rid]||[]).find(x => x.startMin < b && a < x.endMin && x.endMin > nowMin);
      if (s){
        rooms[rid] = {
          title: s.title,
          subtitle: s.subtitle || '',
          when: `${fmtTime(s.startMin)} – ${fmtTime(s.endMin)}`
        };
        any = true;
      } else {
        rooms[rid] = null;
      }
    }
    if (any) pages.push({ startMin:a, endMin:b, rooms });
  }
  return pages;
}

function runClusterPager(roomIds, slotsByRoom, periodMs=8000){
  const nowMin = nowMinutes();

  // panes + counts
  const panes = {};
  for (const rid of roomIds){
    const el = document.getElementById(`room-${rid}`);
    if (!el){ console.warn('Missing room card', rid); continue; }
    panes[rid] = ensureEventsPager(el);
    const count = (slotsByRoom[rid]||[]).filter(s => s.endMin > nowMin).length;
    setRoomCount(el, count);
  }

  const pages = buildClusterPages(slotsByRoom, roomIds, nowMin);
  console.log('cluster', roomIds, 'pages=', pages.length);

  if (!pages.length){
    for (const rid of roomIds) panes[rid] && slideSwap(panes[rid], '', false);
    return;
  }

  let idx = 0;
  const render = (animate) => {
    const p = pages[idx];
    for (const rid of roomIds){
      const html = chipHTML(p.rooms[rid]);
      panes[rid] && slideSwap(panes[rid], html, animate);
    }
  };

  render(false);
  if (pages.length === 1) return;

  setInterval(()=>{ idx = (idx+1) % pages.length; render(true); }, periodMs);
}

// ---------- fieldhouse/turf ----------
function isTurfSeason(rooms){
  // Decide by presence of Quarter Turf rooms OR by titles with “Quarter Turf”
  // This works regardless of where they are in the rooms array.
  return rooms.some(r => /quarter\s*turf/i.test(r.id || r.label || ''));
}

function makeFieldhouseCard(id, label){
  const card = document.createElement('div');
  card.className = 'room';
  card.id = `room-${id}`;
  card.innerHTML = `
    <div class="roomHeader">
      <div class="id">${label}</div>
      <div class="count">reservations: <em>—</em></div>
    </div>
    <div class="events"></div>
  `;
  return card;
}

function renderFieldhouse(rooms, slotsByRoom){
  const holder = $('#fieldhousePager');
  if (!holder){ console.warn('No #fieldhousePager container'); return; }
  holder.innerHTML = '';

  const turf = isTurfSeason(rooms);
  // pick the fieldhouse room IDs in the order they should be displayed
  let ids, labels;
  if (turf){
    // 2x2 layout desired: NA NB / SA SB
    ids = ['Quarter Turf NA','Quarter Turf NB','Quarter Turf SA','Quarter Turf SB'];
    labels = ids;
    holder.style.display = 'grid';
    holder.style.gridTemplateColumns = '1fr 1fr';
    holder.style.gridTemplateRows = '1fr 1fr';
    holder.style.gap = '12px';
  } else {
    // courts season: 3x2 (3..8)
    ids = ['3','4','5','6','7','8'];
    labels = ids;
    holder.style.display = 'grid';
    holder.style.gridTemplateColumns = 'repeat(3, 1fr)';
    holder.style.gridTemplateRows = '1fr 1fr';
    holder.style.gap = '12px';
  }

  ids.forEach((id, i) => {
    const label = labels[i];
    const card = makeFieldhouseCard(id, label);
    holder.appendChild(card);
  });

  // now populate each created card
  const nowMin = nowMinutes();
  ids.forEach(id => {
    const el = document.getElementById(`room-${id}`);
    if (!el) return;

    const pager = ensureEventsPager(el);
    const list = (slotsByRoom[id] || []).filter(s => s.endMin > nowMin).sort((a,b)=>a.startMin-b.startMin);
    setRoomCount(el, list.length);

    if (!list.length){
      slideSwap(pager, '', false);
      return;
    }
    const pages = list.map(s => ({
      title: s.title,
      subtitle: s.subtitle || '',
      when: `${fmtTime(s.startMin)} – ${fmtTime(s.endMin)}`
    }));

    let idx = 0;
    slideSwap(pager, chipHTML(pages[idx]), false);
    if (pages.length > 1){
      setInterval(()=>{ idx = (idx+1) % pages.length; slideSwap(pager, chipHTML(pages[idx]), true); }, 8000);
    }
  });
}

// ---------- boot ----------
(async function boot(){
  initHeader();

  // fetch with cache-buster + no-store
  const res = await fetch(`./events.json?cb=${Date.now()}`, { cache: 'no-store' });
  const data = await res.json();

  const slots = Array.isArray(data?.slots) ? data.slots : [];
  const rooms = Array.isArray(data?.rooms) ? data.rooms : [];
  const byRoom = groupByRoom(slots);

  // South & North (lockstep cluster paging)
  runClusterPager(['1A','1B','2A','2B'], byRoom, 8000);
  runClusterPager(['9A','9B','10A','10B'], byRoom, 8000);

  // Fieldhouse/Turf
  renderFieldhouse(rooms, byRoom);

  // Diagnostics
  const nowMin = nowMinutes();
  const nonEmpty = Object.fromEntries(Object.entries(byRoom).filter(([,v]) => v?.some(s => s.endMin > nowMin)));
  console.log('events.json loaded:', { totalSlots: slots.length, nonEmptyRooms: Object.keys(nonEmpty) });
})();
