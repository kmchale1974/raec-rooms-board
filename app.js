/* global window, document, fetch */
const TICK_MS = 1000;
const ROTOR_MS = 7000;       // per-room event change
const PAGE_MS  = 15000;      // fieldhouse page swap
const NOW = () => new Date();

async function loadData() {
  const r = await fetch('./events.json', { cache: 'no-store' });
  if (!r.ok) throw new Error('failed to load events.json');
  return r.json();
}

function setHeaderClock() {
  const dateEl = document.getElementById('headerDate');
  const clockEl = document.getElementById('headerClock');
  const d = NOW();
  const dateFmt = d.toLocaleDateString(undefined, { weekday:'long', month:'long', day:'numeric' });
  const timeFmt = d.toLocaleTimeString(undefined, { hour:'2-digit', minute:'2-digit' });
  if (dateEl) dateEl.textContent = dateFmt;
  if (clockEl) clockEl.textContent = timeFmt;
}

function minutesSinceMidnight(d = NOW()) {
  return d.getHours() * 60 + d.getMinutes();
}

function byRoom(slots) {
  const map = new Map();
  for (const s of slots) {
    if (!map.has(s.roomId)) map.set(s.roomId, []);
    map.get(s.roomId).push(s);
  }
  return map;
}

function formatWhen(s) {
  function fromMin(m) {
    const h = Math.floor(m / 60), mm = (m % 60).toString().padStart(2, '0');
    const mer = h >= 12 ? 'PM' : 'AM';
    const h12 = ((h + 11) % 12) + 1;
    return `${h12}:${mm}${mer}`;
  }
  return `${fromMin(s.startMin)} – ${fromMin(s.endMin)}`;
}

function mountSingleRotor(container, events) {
  // Creates a fading slider that always slides left (matches CSS fade-enter/exit)
  let idx = 0;
  let current = null;

  function renderEvent(e) {
    const node = document.createElement('div');
    node.className = 'event fade-enter';
    node.innerHTML = `
      <div class="who">${e.title || ''}</div>
      ${e.subtitle ? `<div class="what">${e.subtitle}</div>` : ''}
      <div class="when">${formatWhen(e)}</div>
    `;
    return node;
  }

  function showNext() {
    if (!events.length) return;
    const next = renderEvent(events[idx]);
    container.appendChild(next);

    // enter
    requestAnimationFrame(() => {
      next.classList.add('fade-enter-active');
      next.classList.remove('fade-enter');
    });

    // exit old
    if (current) {
      current.classList.add('fade-exit', 'fade-exit-active');
      setTimeout(() => {
        if (current && current.parentNode) current.parentNode.removeChild(current);
      }, 740); // matches --dur in CSS
    }

    current = next;
    idx = (idx + 1) % events.length;
  }

  // initial
  container.innerHTML = '';
  showNext();
  return setInterval(showNext, ROTOR_MS);
}

function updateRoom(roomId, futureEvents) {
  const roomEl = document.getElementById(`room-${roomId}`);
  if (!roomEl) return;
  const countEl = roomEl.querySelector('.roomHeader .count em');
  const rotor = roomEl.querySelector('.single-rotor');

  // Sort by start time
  futureEvents.sort((a,b) => a.startMin - b.startMin);

  // update count
  if (countEl) countEl.textContent = String(futureEvents.length);

  // handle empty
  if (!futureEvents.length) {
    rotor.innerHTML = `
      <div class="event">
        <div class="who">No reservations</div>
        <div class="when">—</div>
      </div>`;
    return null;
  }

  // mount rotor
  return mountSingleRotor(rotor, futureEvents);
}

function buildFieldhousePages(container, roomsOrder, roomMap, nowMin) {
  container.innerHTML = '';

  // 6 tiles per page (3x2)
  const pages = [];
  let cur = [];
  for (const rid of roomsOrder) {
    cur.push(rid);
    if (cur.length === 6) { pages.push(cur); cur = []; }
  }
  if (cur.length) pages.push(cur);

  const pageEls = [];
  for (const group of pages) {
    const page = document.createElement('div');
    page.className = 'page';
    for (const rid of group) {
      const box = document.createElement('div');
      box.className = 'room';
      box.innerHTML = `
        <div class="roomHeader">
          <div class="id">${rid}</div>
          <div class="count">reservations: <em>—</em></div>
        </div>
        <div class="events"><div class="single-rotor"></div></div>
      `;
      page.appendChild(box);

      // feed future events into each box
      const events = (roomMap.get(rid) || []).filter(e => e.endMin > nowMin).sort((a,b)=>a.startMin-b.startMin);
      const countEl = box.querySelector('.roomHeader .count em');
      if (countEl) countEl.textContent = String(events.length);

      const rotor = box.querySelector('.single-rotor');
      if (!events.length) {
        rotor.innerHTML = `
          <div class="event">
            <div class="who">No reservations</div>
            <div class="when">—</div>
          </div>`;
      } else {
        mountSingleRotor(rotor, events);
      }
    }
    container.appendChild(page);
    pageEls.push(page);
  }

  // pager animation
  if (pageEls.length <= 1) {
    if (pageEls[0]) pageEls[0].classList.add('is-active');
    return null;
  }

  let p = 0;
  function showPage(i) {
    pageEls.forEach((el, idx) => {
      el.classList.remove('is-active', 'is-leaving');
      if (idx === i) el.classList.add('is-active');
    });
  }
  function leavePage(i) {
    pageEls[i].classList.add('is-leaving');
  }

  showPage(0);
  return setInterval(() => {
    const curIdx = p;
    const nextIdx = (p + 1) % pageEls.length;
    leavePage(curIdx);
    showPage(nextIdx);
    p = nextIdx;
  }, PAGE_MS);
}

function uniqueByKey(arr, keyFn) {
  const out = [];
  const seen = new Set();
  for (const x of arr) {
    const k = keyFn(x);
    if (!seen.has(k)) { seen.add(k); out.push(x); }
  }
  return out;
}

async function boot() {
  setHeaderClock();
  setInterval(setHeaderClock, TICK_MS);

  const data = await loadData();
  const nowMin = minutesSinceMidnight();

  // Future only
  const future = data.slots.filter(s => s.endMin > nowMin);

  // De-dup again defensively
  const slots = uniqueByKey(
    future,
    s => `${s.roomId}|${s.startMin}|${s.endMin}|${(s.title||'').toLowerCase()}|${(s.subtitle||'').toLowerCase()}`
  );

  const roomMap = byRoom(slots);

  // South: 1A/1B/2A/2B
  const southIds = ['1A','1B','2A','2B'];
  const southTimers = [];
  for (const rid of southIds) {
    const evs = (roomMap.get(rid) || []).filter(e => e.endMin > nowMin);
    const t = updateRoom(rid, evs);
    if (t) southTimers.push(t);
  }

  // North: 9A/9B/10A/10B
  const northIds = ['9A','9B','10A','10B'];
  const northTimers = [];
  for (const rid of northIds) {
    const evs = (roomMap.get(rid) || []).filter(e => e.endMin > nowMin);
    const t = updateRoom(rid, evs);
    if (t) northTimers.push(t);
  }

  // Fieldhouse pager: courts 3..8
  const fieldhouseOrder = ['3','4','5','6','7','8'];
  const pagerEl = document.getElementById('fieldhousePager');
  let pagerTimer = null;
  if (pagerEl) {
    pagerTimer = buildFieldhousePages(pagerEl, fieldhouseOrder, roomMap, nowMin);
  }

  // (Optional) refresh every minute to drop finished items and update counts/clock smoothly
  setInterval(() => window.location.reload(), 60 * 1000);
}

document.addEventListener('DOMContentLoaded', () => {
  boot().catch(err => {
    console.error(err);
  });
});
