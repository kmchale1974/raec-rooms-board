// app.js — pure JavaScript (no HTML here!)

/** Utilities **/
const pad = (n) => String(n).padStart(2, '0');
function minutesToLabel(m){
  const h24 = Math.floor(m/60), mm = m%60;
  const h12 = ((h24 + 11) % 12) + 1;
  const ampm = h24 >= 12 ? 'pm' : 'am';
  return `${h12}:${pad(mm)}${ampm}`;
}

// Pickleball label cleaner
function normalizePickleball(title, subtitle){
  const blob = `${title || ''} ${subtitle || ''}`.toLowerCase();
  if (blob.includes('pickleball')) {
    return {
      who: 'Open Pickleball',
      what: '', // hide internal note
    };
  }
  // Normal case
  return {
    who: title || '',
    what: subtitle || '',
  };
}

// Collapse duplicate events per room by key
function uniqueByKey(arr, keyFn){
  const seen = new Set();
  const out = [];
  for (const item of arr) {
    const k = keyFn(item);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}

/** Load events.json (with cache-busting) **/
async function loadData(){
  const url = `./events.json?ts=${Date.now()}`;
  const resp = await fetch(url, { cache: 'no-store' });
  if (!resp.ok) throw new Error(`Failed to fetch ${url}: ${resp.status}`);
  const data = await resp.json();
  console.log('Loaded events.json', data);
  return data;
}

/** Render the grid **/
function ensureRoomsContainers(){
  const south = document.getElementById('southRooms');
  const field = document.getElementById('fieldhouseRooms');
  const north = document.getElementById('northRooms');
  if (!south || !field || !north) return;

  // South: rooms 1,2 (stack)
  south.innerHTML = `
    <div class="room" data-room="1"><div class="roomHeader"><div class="id">1</div><div class="count" id="count-1"></div></div><div class="events" id="ev-1"></div></div>
    <div class="room" data-room="2"><div class="roomHeader"><div class="id">2</div><div class="count" id="count-2"></div></div><div class="events" id="ev-2"></div></div>
  `;

  // Fieldhouse: 3..8 (2x3)
  field.innerHTML = '';
  [3,4,5,6,7,8].forEach(id => {
    field.innerHTML += `
      <div class="room" data-room="${id}">
        <div class="roomHeader"><div class="id">${id}</div><div class="count" id="count-${id}"></div></div>
        <div class="events" id="ev-${id}"></div>
      </div>`;
  });

  // North: 9,10 (stack)
  north.innerHTML = `
    <div class="room" data-room="9"><div class="roomHeader"><div class="id">9</div><div class="count" id="count-9"></div></div><div class="events" id="ev-9"></div></div>
    <div class="room" data-room="10"><div class="roomHeader"><div class="id">10</div><div class="count" id="count-10"></div></div><div class="events" id="ev-10"></div></div>
  `;
}

function renderClock(){
  const dateEl = document.getElementById('headerDate');
  const clockEl = document.getElementById('headerClock');
  const now = new Date();
  const day = now.toLocaleDateString(undefined, { weekday: 'long' });
  const date = now.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
  const time = now.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (dateEl) dateEl.textContent = `${day}, ${date}`;
  if (clockEl) clockEl.textContent = time;
}

function render(data){
  ensureRoomsContainers();

  const now = new Date();
  const nowMin = now.getHours()*60 + now.getMinutes();

  // events.json expected: { rooms:[{id,label,group}...], slots:[{roomId,startMin,endMin,title,subtitle}] }
  const allSlots = Array.isArray(data.slots) ? data.slots : [];
  // Hide past events: only keep where end is in the future
  let future = allSlots.filter(s => (s.endMin ?? 0) > nowMin);

  // Clean labels, normalize Pickleball titles, remove exact dupes per room+window+who+what
  future = future.map(s => {
    const clean = normalizePickleball(s.title, s.subtitle);
    return {
      ...s,
      who: clean.who,
      what: clean.what,
      startLabel: minutesToLabel(s.startMin ?? 0),
      endLabel: minutesToLabel(s.endMin ?? 0),
    };
  });

  // De-duplicate exact repeats within a room and same time range and same text
  const dedupedByRoom = {};
  for (const slot of future) {
    const room = String(slot.roomId);
    if (!dedupedByRoom[room]) dedupedByRoom[room] = [];
    dedupedByRoom[room].push(slot);
  }
  Object.keys(dedupedByRoom).forEach(room => {
    dedupedByRoom[room] = uniqueByKey(
      dedupedByRoom[room].sort((a,b)=> (a.startMin-b.startMin) || (a.endMin-b.endMin) || a.who.localeCompare(b.who)),
      s => `${s.startMin}-${s.endMin}-${s.who}-${s.what}`
    );
  });

  // Render per room
  const rooms = (data.rooms || []).map(r => String(r.id));
  rooms.forEach(id => {
    const listEl = document.getElementById(`ev-${id}`);
    const countEl = document.getElementById(`count-${id}`);
    if (!listEl) return;
    const items = dedupedByRoom[id] || [];
    listEl.innerHTML = '';
    if (countEl) countEl.textContent = items.length ? `${items.length} event${items.length>1?'s':''}` : '';
    for (const ev of items) {
      const who = ev.who || '';
      const what = ev.what || '';
      const when = `${ev.startLabel} – ${ev.endLabel}`;
      const card = document.createElement('div');
      card.className = 'event';
      card.innerHTML = `
        <div class="who">${who}</div>
        ${what ? `<div class="what">${what}</div>` : ``}
        <div class="when">${when}</div>
      `;
      listEl.appendChild(card);
    }
  });
}

/** Init **/
async function init(){
  try {
    renderClock();
    setInterval(renderClock, 1000 * 30); // refresh clock every 30s

    const data = await loadData();
    render(data);

    // Optionally refresh events every few minutes
    setInterval(async () => {
      try {
        const fresh = await loadData();
        render(fresh);
      } catch (e) { console.warn('Refresh failed:', e); }
    }, 1000 * 60 * 5);
  } catch (e) {
    console.error(e);
  }
}

document.addEventListener('DOMContentLoaded', init);
