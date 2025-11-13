// app.js — stable pager, no flicker, lockstep clusters

/* =========================
   Tiny helpers
   ========================= */
const $  = (s, r=document) => r.querySelector(s);
const $$ = (s, r=document) => Array.from(r.querySelectorAll(s));

function toNowMin() {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}
function fmt(min) {
  const h24 = Math.floor(min/60), m=min%60;
  const ampm = h24>=12 ? 'pm' : 'am';
  let h = h24%12; if (h===0) h=12;
  return `${h}:${String(m).padStart(2,'0')}${ampm}`;
}
function groupByRoom(slots) {
  const m = {};
  for (const s of slots) {
    (m[s.roomId] ||= []).push(s);
  }
  for (const k in m) m[k].sort((a,b)=>a.startMin-b.startMin);
  return m;
}

/* =========================
   Header + canvas fit
   ========================= */
function initHeader() {
  const d = new Date();
  $('#headerDate').textContent = d.toLocaleDateString(undefined, { weekday:'long', month:'long', day:'numeric' });
  const tick = () => { $('#headerClock').textContent = new Date().toLocaleTimeString(undefined, { hour:'numeric', minute:'2-digit' }); };
  tick(); setInterval(tick, 1000);
}
(function fitStage(){
  const W=1920,H=1080;
  function fit(){
    const vp=$('.viewport'), st=$('.stage'); if(!vp||!st) return;
    const s=Math.min(vp.clientWidth/W, vp.clientHeight/H);
    st.style.transform=`scale(${s})`; st.style.transformOrigin='top left';
    vp.style.minHeight = `${H*s}px`;
  }
  addEventListener('resize',fit); addEventListener('orientationchange',fit);
  document.addEventListener('DOMContentLoaded',fit);
})();

/* =========================
   DOM builders
   ========================= */
function ensurePager(roomEl) {
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
function setCount(roomEl, n) {
  const el = roomEl.querySelector('.roomHeader .count em');
  if (el) el.textContent = n;
}
function chip(ev) {
  if (!ev) return '';
  const sub = ev.subtitle ? `<div class="what">${ev.subtitle}</div>` : '';
  return `<div class="event">
    <div class="who">${ev.title}</div>
    ${sub}
    <div class="when">${ev.when}</div>
  </div>`;
}

/* =========================
   Safer slide swap (no flicker)
   ========================= */
function slideSwap(pager, html, animate) {
  // If the HTML is identical to current, do nothing to avoid micro-flashes
  const current = pager.querySelector('.page');
  if (current && current.dataset.html === html) return;

  const next = document.createElement('div');
  next.className = 'page';
  next.dataset.html = html;
  next.innerHTML = html;

  if (!animate || !current) {
    pager.innerHTML = '';
    pager.appendChild(next);
    return;
  }

  // animate only when we truly have two different pages
  next.classList.add('slide-in');
  pager.appendChild(next);
  current.classList.add('slide-out');
  setTimeout(() => {
    current.remove();
    next.classList.remove('slide-in');
  }, 450);
}

/* =========================
   Cluster pager: keeps rooms in sync by time segment
   ========================= */
function buildClusterPages(byRoom, roomIds, nowMin) {
  // Collect the union of all time boundaries among these rooms (future and current)
  const cuts = new Set();
  for (const rid of roomIds) {
    for (const s of (byRoom[rid]||[])) {
      if (s.endMin <= nowMin) continue;      // past only -> ignore
      cuts.add(Math.max(s.startMin, nowMin)); // start can't precede "now"
      cuts.add(s.endMin);
    }
  }
  const bounds = Array.from(cuts).sort((a,b)=>a-b);
  if (bounds.length < 2) return [];

  // Build time segments [a,b) and extract per-room event (or null)
  const pages = [];
  for (let i=0;i<bounds.length-1;i++){
    const a = bounds[i], b=bounds[i+1];
    if (b <= nowMin) continue;

    let any=false;
    const rooms = {};
    for (const rid of roomIds) {
      const ev = (byRoom[rid]||[]).find(s => s.startMin < b && a < s.endMin);
      if (ev) {
        any = true;
        rooms[rid] = {
          title: ev.title,
          subtitle: ev.subtitle || '',
          when: `${fmt(ev.startMin)} – ${fmt(ev.endMin)}`
        };
      } else {
        rooms[rid] = null;
      }
    }
    if (any) pages.push({ startMin:a, endMin:b, rooms });
  }
  return pages;
}

function runClusterPager(roomIds, byRoom, periodMs=8000) {
  const nowMin = toNowMin();
  const panes = {};
  for (const rid of roomIds) {
    const roomEl = document.getElementById(`room-${rid}`);
    if (!roomEl) { console.warn('Missing room card', rid); continue; }
    panes[rid] = ensurePager(roomEl);
    const futureCount = (byRoom[rid]||[]).filter(s => s.endMin > nowMin).length;
    setCount(roomEl, futureCount);
  }

  const pages = buildClusterPages(byRoom, roomIds, nowMin);
  // If there are no usable pages, clear panes and stop
  if (!pages.length) {
    roomIds.forEach(rid => panes[rid] && slideSwap(panes[rid], '', false));
    return;
  }

  // Render the first page without animation
  let idx = 0;
  const render = (animate) => {
    const p = pages[idx];
    roomIds.forEach(rid => {
      const html = chip(p.rooms[rid] || null);
      panes[rid] && slideSwap(panes[rid], html, animate);
    });
  };
  render(false);

  // Only rotate if there’s more than one page
  if (pages.length > 1) {
    setInterval(() => {
      idx = (idx + 1) % pages.length;
      render(true);
    }, periodMs);
  }
}

/* =========================
   Fieldhouse / Turf
   ========================= */
function isTurfSeason(rooms) {
  // Robust detection: any room id/label containing "Quarter Turf"
  return rooms.some(r => /quarter\s*turf/i.test(r?.id || r?.label || ''));
}
function makeRoomCard(id, label) {
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
function renderFieldhouse(rooms, byRoom) {
  const holder = $('#fieldhousePager');
  if (!holder) { console.warn('No #fieldhousePager'); return; }
  holder.innerHTML = '';

  const turf = isTurfSeason(rooms);
  let ids;
  if (turf) {
    // 2×2 Quarter Turf (row1: NA NB, row2: SA SB)
    ids = ['Quarter Turf NA','Quarter Turf NB','Quarter Turf SA','Quarter Turf SB'];
    holder.style.display = 'grid';
    holder.style.gridTemplateColumns = '1fr 1fr';
    holder.style.gridTemplateRows    = '1fr 1fr';
    holder.style.gap = '12px';
  } else {
    // Courts 3..8, 3×2 grid
    ids = ['3','4','5','6','7','8'];
    holder.style.display = 'grid';
    holder.style.gridTemplateColumns = 'repeat(3, 1fr)';
    holder.style.gridTemplateRows    = '1fr 1fr';
    holder.style.gap = '12px';
  }

  // Create the cards and fill them
  const nowMin = toNowMin();
  ids.forEach(id => holder.appendChild(makeRoomCard(id, id)));

  ids.forEach(id => {
    const roomEl = document.getElementById(`room-${id}`);
    if (!roomEl) return;
    const pager = ensurePager(roomEl);
    const list = (byRoom[id]||[]).filter(s => s.endMin > nowMin).sort((a,b)=>a.startMin-b.startMin);

    setCount(roomEl, list.length);
    if (!list.length) {
      slideSwap(pager, '', false);
      return;
    }

    // Build simple per-room pages (no lockstep for fieldhouse squares)
    const pages = list.map(s => ({
      title: s.title,
      subtitle: s.subtitle || '',
      when: `${fmt(s.startMin)} – ${fmt(s.endMin)}`
    }));

    // First render (no anim)
    slideSwap(pager, chip(pages[0]), false);

    // Rotate only if more than one
    if (pages.length > 1) {
      let i = 0;
      setInterval(() => {
        i = (i + 1) % pages.length;
        slideSwap(pager, chip(pages[i]), true);
      }, 8000);
    }
  });
}

/* =========================
   Boot
   ========================= */
(async function boot(){
  initHeader();

  // Always bust cache
  const res  = await fetch(`./events.json?cb=${Date.now()}`, { cache: 'no-store' });
  const data = await res.json();

  const slots = Array.isArray(data?.slots) ? data.slots : [];
  const rooms = Array.isArray(data?.rooms) ? data.rooms : [];

  // Filter past slots (ends before now)
  const nowMin = toNowMin();
  const future = slots.filter(s => s?.endMin > nowMin);

  const byRoom = groupByRoom(future);

  // South & North in lockstep so time changes don't desync panels
  runClusterPager(['1A','1B','2A','2B'], byRoom, 8000);
  runClusterPager(['9A','9B','10A','10B'], byRoom, 8000);

  // Fieldhouse/Turf cards + rotation
  renderFieldhouse(rooms, byRoom);

  // Diagnostics
  const nonEmpty = Object.keys(byRoom).filter(k => byRoom[k]?.length);
  console.log('events.json loaded:', { totalSlots: slots.length, futureSlots: future.length, nonEmptyRooms: nonEmpty });
})();
