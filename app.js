// app.js — RAEC Rooms Board (frontend)

// ----------- tiny utils -----------
const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const pad2 = (n) => (n < 10 ? '0' + n : '' + n);

// format minutes since midnight (e.g., 19:00 -> "7:00 PM")
function fmtMinutes(mins) {
  let h = Math.floor(mins / 60);
  const m = mins % 60;
  const mer = h >= 12 ? 'PM' : 'AM';
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:${pad2(m)} ${mer}`;
}

function setHeaderDateClock() {
  const now = new Date();
  const dateStr = now.toLocaleDateString(undefined, {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
  });
  const timeStr = now.toLocaleTimeString(undefined, {
    hour: 'numeric', minute: '2-digit'
  });
  const dateEl  = $('#headerDate');
  const clockEl = $('#headerClock');
  if (dateEl)  dateEl.textContent  = dateStr;
  if (clockEl) clockEl.textContent = timeStr;
}

// ----------- DOM builders -----------
function eventChipHTML(slot) {
  const when = `${fmtMinutes(slot.startMin)} – ${fmtMinutes(slot.endMin)}`;
  const sub  = (slot.subtitle || '').trim();
  return `
    <div class="event" style="
      position:absolute; inset:0;
      display:flex; flex-direction:column; gap:6px;
      background:var(--chip); border:1px solid var(--grid); border-radius:12px;
      padding:12px 14px; box-sizing:border-box;
      will-change:transform,opacity; backface-visibility:hidden; transform:translateZ(0);
      opacity:0; transform:translateX(40px);
      transition: transform 420ms var(--ease, cubic-bezier(.22,.61,.36,1)), opacity 420ms var(--ease, cubic-bezier(.22,.61,.36,1));
    ">
      <div class="who"  style="font-size:20px; font-weight:800; line-height:1.15;">${slot.title}</div>
      ${sub ? `<div class="what" style="font-size:16px; color:var(--muted); line-height:1.2;">${sub}</div>` : ``}
      <div class="when" style="font-size:15px; color:#b7c0cf; font-weight:600;">${when}</div>
    </div>
  `;
}

function buildRoomCard(roomId, labelText) {
  const wrap = document.createElement('div');
  wrap.className = 'room';
  wrap.id = `room-${roomId}`;
  wrap.innerHTML = `
    <div class="roomHeader">
      <div class="id">${labelText}</div>
      <div class="count">reservations: <em>—</em></div>
    </div>
    <div class="events" style="position:relative; height:100%; min-height:0; overflow:hidden;"></div>
  `;
  return wrap;
}

// ----------- rotator (only if >1 items) -----------
function startRotor(container, items, periodMs = 8000) {
  let idx = 0;

  const mount = (i, entering = true) => {
    const html = eventChipHTML(items[i]);
    container.insertAdjacentHTML('beforeend', html);
    const el = container.lastElementChild;
    // enter
    requestAnimationFrame(() => {
      el.style.opacity = '1';
      el.style.transform = 'translateX(0)';
    });
    return el;
  };

  // initial render
  let curr = mount(idx, true);
  if (items.length < 2) return; // no rotation if single item

  const tick = () => {
    const nextIdx = (idx + 1) % items.length;
    const next = mount(nextIdx, true);

    // animate out current
    curr.style.opacity = '0';
    curr.style.transform = 'translateX(-40px)';

    // after transition, remove the old one
    setTimeout(() => {
      try { curr.remove(); } catch {}
      curr = next;
      idx = nextIdx;
    }, 460);
  };

  const timer = setInterval(tick, periodMs);
  // keep a handle in case you want to stop later:
  container._rotorTimer = timer;
}

// ----------- room filling -----------
function fillRoom(roomId, label, slots) {
  // room card exists for 1A/1B/2A/2B/9A/9B/10A/10B in HTML,
  // but Fieldhouse/Turf rooms are generated dynamically (we’ll call buildRoomCard for those).
  const box = $(`#room-${roomId}`);
  if (!box) return;

  const cnt = $('.roomHeader .count em', box);
  const eventsWrap = $('.events', box);

  // guard
  if (!eventsWrap) return;

  // set count
  if (cnt) cnt.textContent = String(slots.length);

  // empty?
  eventsWrap.innerHTML = '';
  if (!slots.length) return;

  // mount a single absolutely-positioned rotor layer
  const rotor = document.createElement('div');
  rotor.className = 'single-rotor';
  rotor.style.position = 'relative';
  rotor.style.height = '100%';
  rotor.style.width = '100%';
  eventsWrap.appendChild(rotor);

  startRotor(rotor, slots, 8000);
}

// ----------- layout build for Fieldhouse/Turf -----------
function renderFieldhouseRooms(events) {
  const holder = $('#fieldhousePager');
  if (!holder) return;

  // Clear & rebuild based on events.rooms (season-aware)
  holder.innerHTML = '';

  // find only fieldhouse group rooms from events.rooms
  const fhRooms = events.rooms.filter(r => r.group === 'fieldhouse');

  // Build a simple 2×3 (courts) or 2×2 (turf) grid by app structure (CSS handles it)
  fhRooms.forEach(r => {
    const card = buildRoomCard(r.id, r.label);
    holder.appendChild(card);
  });
}

// ----------- group slots by room id -----------
function groupSlotsByRoom(events) {
  const map = new Map(); // roomId -> [{...slot}]
  for (const r of events.rooms) map.set(r.id, []);
  for (const s of (events.slots || [])) {
    if (!map.has(s.roomId)) map.set(s.roomId, []);
    map.get(s.roomId).push(s);
  }
  // sort by start then title for stable rotation
  for (const arr of map.values()) {
    arr.sort((a,b) => (a.startMin - b.startMin) || a.title.localeCompare(b.title));
  }
  return map;
}

// ----------- boot -----------
async function boot() {
  // live clock
  setHeaderDateClock();
  setInterval(setHeaderDateClock, 1000);

  // fetch with cache-buster
  const res = await fetch(`./events.json?cb=${Date.now()}`, { cache: 'no-store' });
  const events = await res.json();

  // dev log
  const counts = (events.slots || []).reduce((acc, s) => {
    acc[s.roomId] = (acc[s.roomId] || 0) + 1;
    return acc;
  }, {});
  console.log('events.json loaded:', {
    season: events.season,
    totalSlots: (events.slots || []).length,
    byRoom: counts
  });

  // Build the fieldhouse/turf panel dynamically from events.rooms
  renderFieldhouseRooms(events);

  // group by room & fill
  const byRoom = groupSlotsByRoom(events);

  // Fixed rooms exist in HTML; fieldhouse rooms were just created above.
  // Iterate all known rooms from events.rooms and fill each.
  events.rooms.forEach(r => {
    const slots = byRoom.get(r.id) || [];
    fillRoom(r.id, r.label, slots);
  });
}

boot().catch(err => {
  console.error('app init failed:', err);
});
