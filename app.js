// app.js
const JSON_URL = './events.json?v=' + Date.now(); // bust cache

// America/Chicago clock
function getNowChicago() {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour12: false,
    year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' });
  // parse back out
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).map(p => [p.type, p.value]));
  const iso = `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:00`;
  return new Date(iso);
}
function minOfDay(d) { return d.getHours()*60 + d.getMinutes(); }

function setHeaderClock() {
  const now = getNowChicago();
  const dateFmt = new Intl.DateTimeFormat('en-US', { timeZone:'America/Chicago', weekday:'long', month:'long', day:'numeric' });
  const timeFmt = new Intl.DateTimeFormat('en-US', { timeZone:'America/Chicago', hour:'numeric', minute:'2-digit' });
  document.getElementById('headerDate').textContent = dateFmt.format(now);
  document.getElementById('headerClock').textContent = timeFmt.format(now);
}
setHeaderClock();
setInterval(setHeaderClock, 10_000);

// Smooth single-card rotor per room
function startRotor(container, items, rotateMs=7000) {
  if (!items || !items.length) {
    container.innerHTML = ''; // no “no upcoming” filler per your request
    return;
  }
  let idx = 0;
  // create first card
  const mk = (i) => {
    const it = items[i];
    const el = document.createElement('div');
    el.className = 'event';
    const title = it.title || '';
    const sub   = it.subtitle || '';
    const when  = `${toClock(it.startMin)} – ${toClock(it.endMin)}`;
    el.innerHTML = `
      <div class="who">${escapeHtml(title)}</div>
      ${sub ? `<div class="what">${escapeHtml(sub)}</div>` : ''}
      <div class="when">${when}</div>
    `;
    return el;
  };
  const first = mk(0);
  first.classList.add('is-enter'); // start as entering, then activate
  container.innerHTML = '';
  container.appendChild(first);
  // activate entrance
  requestAnimationFrame(() => first.classList.add('is-active'));

  idx = 1 % items.length;

  setInterval(() => {
    const current = container.querySelector('.event');
    const next = mk(idx);
    idx = (idx + 1) % items.length;

    // prepare next (enter)
    next.classList.add('is-enter');
    container.appendChild(next);

    // trigger transitions
    requestAnimationFrame(() => {
      // exit current
      if (current) {
        current.classList.remove('is-enter');
        current.classList.add('is-exit','is-active');
      }
      // enter next
      next.classList.add('is-active');
    });

    // cleanup after animation completes
    setTimeout(() => {
      if (current && current.parentNode) current.parentNode.removeChild(current);
      next.classList.remove('is-enter','is-active'); // keep it as the steady card
    }, 600); // matches CSS --dur (520ms) with a little cushion
  }, rotateMs);
}

function toClock(min) {
  let h = Math.floor(min/60), m = min%60;
  const mer = h >= 12 ? 'PM' : 'AM';
  if (h === 0) h = 12; else if (h > 12) h -= 12;
  return `${h}:${String(m).padStart(2,'0')} ${mer}`;
}
function escapeHtml(s){ return String(s||'').replace(/[&<>"']/g,c=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }

// Load and render
(async function init(){
  let data;
  try {
    const res = await fetch(JSON_URL, { cache:'no-store' });
    if (!res.ok) throw new Error(`fetch ${res.status}`);
    data = await res.json();
  } catch (e) {
    console.error('Failed to load events.json', e);
    return;
  }

  const now = getNowChicago();
  const nowMin = minOfDay(now);

  const dayStart = Number(data.dayStartMin ?? 360);
  const dayEnd   = Number(data.dayEndMin   ?? 1380);

  // Filter: only show items that end AFTER "now"
  const future = (data.slots || []).filter(s => Number(s.endMin) > nowMin);

  // Group by roomId
  const byRoom = new Map();
  for (const s of future) {
    if (!byRoom.has(s.roomId)) byRoom.set(s.roomId, []);
    byRoom.get(s.roomId).push(s);
  }

  // Sort each room by start time, then stable
  for (const arr of byRoom.values()) {
    arr.sort((a,b) => a.startMin - b.startMin || a.endMin - b.endMin || (a.title||'').localeCompare(b.title||''));
  }

  // Rooms to place (must match the DOM ids we created in index.html)
  const roomIds = ['1A','1B','2A','2B','3','4','5','6','7','8','9A','9B','10A','10B'];
  for (const rid of roomIds) {
    const card = document.getElementById(`room-${rid}`);
    if (!card) continue;
    const lst = byRoom.get(rid) || [];
    // update count
    const countEl = card.querySelector('.roomHeader .count em');
    if (countEl) countEl.textContent = String(lst.length);

    const rotor = card.querySelector('.single-rotor');
    if (!rotor) continue;

    startRotor(rotor, lst, 7000);
  }
})();
