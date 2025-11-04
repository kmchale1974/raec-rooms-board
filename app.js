// app.js
const PAGE_SIZE = 3;
const PAGE_MS   = 7000;
const TZ        = 'America/Chicago';

const el = sel => document.querySelector(sel);
const els = sel => Array.from(document.querySelectorAll(sel));

function fmtTime(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  const date = new Date();
  date.setHours(h, m, 0, 0);
  return date.toLocaleTimeString([], { hour:'numeric', minute:'2-digit', hour12:true });
}

function setHeaderClock() {
  function tick() {
    const now = new Date();
    el('#headerClock').textContent = now.toLocaleTimeString([], { hour:'numeric', minute:'2-digit', second:'2-digit' });
    const dateStr = now.toLocaleDateString([], { weekday:'long', month:'long', day:'numeric' });
    el('#headerDate').textContent = dateStr;
    requestAnimationFrame(() => {}); // tiny yield
  }
  tick();
  setInterval(tick, 1000);
}

function mountRoomPager(container, events) {
  const pager = document.createElement('div');
  pager.className = 'eventsPager';
  container.innerHTML = '';
  container.appendChild(pager);

  if (!events.length) return; // nothing to render

  // split pages
  const pages = [];
  for (let i=0; i<events.length; i+=PAGE_SIZE) pages.push(events.slice(i, i+PAGE_SIZE));

  const pageEls = pages.map(pg => {
    const p = document.createElement('div');
    p.className = 'page';
    for (const ev of pg) {
      const card = document.createElement('div');
      card.className = 'event';
      const who  = document.createElement('div'); who.className = 'who';  who.textContent  = ev.title || 'Reservation';
      const what = document.createElement('div'); what.className = 'what'; what.textContent = ev.subtitle || '';
      const when = document.createElement('div'); when.className = 'when'; when.textContent = `${fmtTime(ev.startMin)} — ${fmtTime(ev.endMin)}`;
      card.appendChild(who); if (what.textContent) card.appendChild(what); card.appendChild(when);
      p.appendChild(card);
    }
    pager.appendChild(p);
    return p;
  });

  if (pages.length === 1) {
    // single page: no rotation, but still visible
    pageEls[0].style.position = 'absolute';
    pageEls[0].style.inset = '0';
    return;
  }

  // position all absolute
  pageEls.forEach(pe => { pe.style.position = 'absolute'; pe.style.inset = '0'; });

  let idx = 0;
  pageEls[idx].classList.add('slide-in');

  setInterval(() => {
    const cur = pageEls[idx];
    idx = (idx + 1) % pageEls.length;
    const next = pageEls[idx];

    cur.classList.remove('slide-in');
    cur.classList.add('slide-out');

    next.classList.remove('slide-out');
    // force reflow so CSS animation restarts
    void next.offsetWidth;
    next.classList.add('slide-in');

    // clean up old slide-out after animation finishes
    setTimeout(() => cur.classList.remove('slide-out'), 450);
  }, PAGE_MS);
}

async function loadAndRender() {
  setHeaderClock();

  let data;
  try {
    const res = await fetch('./events.json', { cache:'no-store' });
    data = await res.json();
  } catch (e) {
    console.error('Failed to load events.json', e);
    return;
  }

  // group slots by roomId
  const byRoom = new Map();
  for (const r of data.rooms) byRoom.set(r.id, []);
  for (const s of data.slots) {
    if (!byRoom.has(s.roomId)) byRoom.set(s.roomId, []);
    byRoom.get(s.roomId).push(s);
  }
  for (const [k, arr] of byRoom.entries()) {
    arr.sort((a,b) => a.startMin - b.startMin || a.endMin - b.endMin);
  }

  // mount South
  ['1A','1B','2A','2B'].forEach(id => {
    const roomEl = document.querySelector(`#room-${id} .events`);
    const list = byRoom.get(id) || [];
    document.querySelector(`#room-${id} .roomHeader .count em`).textContent = String(list.length);
    mountRoomPager(roomEl, list);
  });

  // Fieldhouse (3..8) in a 3×2 grid
  const fhHost = document.getElementById('fieldhousePager');
  fhHost.innerHTML = '';
  ['3','4','5','6','7','8'].forEach(id => {
    const card = document.createElement('div');
    card.className = 'room';
    card.innerHTML = `
      <div class="roomHeader">
        <div class="id">${id}</div>
        <div class="count">reservations: <em>—</em></div>
      </div>
      <div class="events"></div>
    `;
    fhHost.appendChild(card);
    const list = byRoom.get(id) || [];
    card.querySelector('.roomHeader .count em').textContent = String(list.length);
    mountRoomPager(card.querySelector('.events'), list);
  });

  // North
  ['9A','9B','10A','10B'].forEach(id => {
    const roomEl = document.querySelector(`#room-${id} .events`);
    const list = byRoom.get(id) || [];
    document.querySelector(`#room-${id} .roomHeader .count em`).textContent = String(list.length);
    mountRoomPager(roomEl, list);
  });
}

window.addEventListener('DOMContentLoaded', loadAndRender);

// scale the fixed 1920×1080 canvas to fit window
(function fitStageSetup(){
  const W = 1920, H = 1080;
  function fit() {
    const vp = document.querySelector('.viewport');
    const stage = document.querySelector('.stage');
    if (!vp || !stage) return;
    const sx = vp.clientWidth / W;
    const sy = vp.clientHeight / H;
    const s  = Math.min(sx, sy);
    stage.style.transform = `scale(${s})`;
    stage.style.transformOrigin = 'top left';
    vp.style.minHeight = (H * s) + 'px';
  }
  window.addEventListener('resize', fit);
  window.addEventListener('orientationchange', fit);
  document.addEventListener('DOMContentLoaded', fit);
})();
