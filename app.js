// app.js — cluster pager + slide-left animation

const NOW = (() => {
  // Local minutes since midnight, America/Chicago (page runs in local browser; board is local)
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
})();

// ---- utils ----
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function fmtTime(min) {
  const h24 = Math.floor(min / 60);
  const m = min % 60;
  const ampm = h24 >= 12 ? 'pm' : 'am';
  let h = h24 % 12;
  if (h === 0) h = 12;
  return `${h}:${m.toString().padStart(2, '0')}${ampm}`;
}

function groupByRoom(slots) {
  const map = {};
  for (const s of slots) {
    if (!map[s.roomId]) map[s.roomId] = [];
    map[s.roomId].push(s);
  }
  for (const r in map) {
    map[r].sort((a, b) => a.startMin - b.startMin);
  }
  return map;
}

// Build cluster-wide time pages: take ALL start/end boundaries across rooms → slice
function buildClusterPages(slotsByRoom, roomIds) {
  // gather boundaries
  const bounds = new Set();
  for (const rid of roomIds) {
    const list = slotsByRoom[rid] || [];
    for (const s of list) {
      // ignore past-only items
      if (s.endMin <= NOW) continue;
      bounds.add(Math.max(s.startMin, 0));
      bounds.add(s.endMin);
    }
  }
  const sorted = Array.from(bounds).sort((a, b) => a - b);
  // if no boundaries -> single empty page
  if (sorted.length < 2) return [];

  const pages = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i], b = sorted[i + 1];
    if (b <= NOW) continue; // whole slice is already past

    // page content per room
    const page = { startMin: a, endMin: b, rooms: {} };
    let anyoneHas = false;

    for (const rid of roomIds) {
      const list = slotsByRoom[rid] || [];
      // find a slot that overlaps slice (strict overlap)
      const s = list.find(x => x.startMin < b && a < x.endMin);
      if (s && s.endMin > NOW) {
        // keep the original full-time label
        page.rooms[rid] = {
          title: s.title,
          subtitle: s.subtitle || '',
          when: `${fmtTime(s.startMin)} – ${fmtTime(s.endMin)}`
        };
        anyoneHas = true;
      } else {
        page.rooms[rid] = null;
      }
    }
    if (anyoneHas) pages.push(page);
  }
  return pages;
}

function chipHTML(ev) {
  if (!ev) return ''; // blank slot
  const sub = ev.subtitle ? `<div class="what">${ev.subtitle}</div>` : '';
  return `
    <div class="event">
      <div class="who">${ev.title}</div>
      ${sub}
      <div class="when">${ev.when}</div>
    </div>
  `;
}

// Slide controller for a single room’s visual pane
function makeRoomPane(roomEl) {
  const host = roomEl.querySelector('.events') || roomEl; // fallback
  // ensure pager container exists
  let container = host.querySelector('.eventsPager');
  if (!container) {
    container = document.createElement('div');
    container.className = 'eventsPager';
    host.innerHTML = '';
    host.appendChild(container);
  }

  let current = null; // currently mounted .page

  function setHTML(html, animate) {
    const next = document.createElement('div');
    next.className = 'page';
    next.innerHTML = html || '';

    if (!animate || !current) {
      // first mount or no animation
      container.innerHTML = '';
      container.appendChild(next);
      current = next;
      return;
    }

    // slide in next from right, slide out current to left
    next.classList.add('slide-in');
    container.appendChild(next);

    // trigger slide-out on current
    current.classList.add('slide-out');

    // cleanup after animation (match CSS durations ~400ms)
    setTimeout(() => {
      if (current && current.parentNode === container) {
        container.removeChild(current);
      }
      next.classList.remove('slide-in');
      current = next;
    }, 450);
  }

  return { setHTML };
}

// Run a cluster pager (South or North)
function runClusterPager({ roomIds, slotsByRoom, periodMs = 8000 }) {
  // setup panes per room
  const panes = {};
  for (const rid of roomIds) {
    const el = document.getElementById(`room-${rid}`);
    if (!el) continue;
    panes[rid] = makeRoomPane(el);
    // initialize counters → we'll update below
    const countEl = el.querySelector('.roomHeader .count em');
    if (countEl) {
      const n = (slotsByRoom[rid] || []).filter(s => s.endMin > NOW).length;
      countEl.textContent = n;
    }
  }

  const pages = buildClusterPages(slotsByRoom, roomIds);

  // if no pages, just clear
  if (!pages.length) {
    for (const rid of roomIds) {
      panes[rid]?.setHTML('', false);
    }
    return;
  }

  // initial render (no animation)
  let idx = 0;
  const render = (animate) => {
    const page = pages[idx];
    for (const rid of roomIds) {
      const ev = page.rooms[rid];
      panes[rid]?.setHTML(chipHTML(ev), animate);
    }
  };

  render(false);

  if (pages.length === 1) {
    // no rotation needed
    return;
  }

  // rotate with animation
  setInterval(() => {
    const next = (idx + 1) % pages.length;
    idx = next;
    render(true);
  }, periodMs);
}

// Render Fieldhouse/Turf rooms individually (simple rotor per room)
function fillFieldhouseRooms(slotsByRoom, fieldIds) {
  for (const rid of fieldIds) {
    const el = document.getElementById(`room-${rid.replace(/\s+/g, '\\ ')}`) || document.getElementById(`room-${rid}`);
    if (!el) continue;

    const pane = makeRoomPane(el);
    const list = (slotsByRoom[rid] || []).filter(s => s.endMin > NOW).sort((a,b) => a.startMin - b.startMin);

    // header count
    const countEl = el.querySelector('.roomHeader .count em');
    if (countEl) countEl.textContent = list.length;

    if (!list.length) {
      pane.setHTML('', false);
      continue;
    }

    // Build simple pages = each event → a page
    const pages = list.map(s => ({
      title: s.title,
      subtitle: s.subtitle || '',
      when: `${fmtTime(s.startMin)} – ${fmtTime(s.endMin)}`
    }));

    // first mount
    let idx = 0;
    pane.setHTML(chipHTML(pages[idx]), false);

    if (pages.length === 1) continue;

    setInterval(() => {
      idx = (idx + 1) % pages.length;
      pane.setHTML(chipHTML(pages[idx]), true);
    }, 8000);
  }
}

// Fill date/clock + wifi (static)
function initHeader() {
  const d = new Date();
  const fmt = d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  $('#headerDate').textContent = fmt;

  function tick() {
    const now = new Date();
    const t = now.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    $('#headerClock').textContent = t;
  }
  tick();
  setInterval(tick, 1000);
}

// Fit 1920×1080 canvas
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

// ---- boot ----
(async function boot(){
  initHeader();

  // fetch with cache-buster
  const res = await fetch(`./events.json?cb=${Date.now()}`, { cache: 'no-store' });
  const data = await res.json();

  const slots = Array.isArray(data?.slots) ? data.slots : [];
  const rooms = Array.isArray(data?.rooms) ? data.rooms : [];

  // render room cards exist? If your HTML uses fixed IDs already, skip creating them.
  // (Your index.html already has #room-<ID> cards laid out)

  // group slots by room
  const byRoom = groupByRoom(slots);

  // Which room IDs are present per season?
  const fieldIds = rooms.filter(r => r.group === 'fieldhouse').map(r => r.id);
  const southIds = ['1A','1B','2A','2B'];
  const northIds = ['9A','9B','10A','10B'];

  // Run cluster pagers
  runClusterPager({ roomIds: southIds, slotsByRoom: byRoom, periodMs: 8000 });
  runClusterPager({ roomIds: northIds, slotsByRoom: byRoom, periodMs: 8000 });

  // Fieldhouse/Turf rooms individually
  fillFieldhouseRooms(byRoom, fieldIds);

  // log
  const nonEmpty = Object.fromEntries(Object.entries(byRoom).filter(([,v]) => v?.some(s => s.endMin > NOW)));
  console.log('events.json loaded:', { totalSlots: slots.length, nonEmptyRooms: nonEmpty });
})();
