// app.js (debug-capable version)
const debug =
  /[?#]debug(=1)?/i.test(location.search) ||
  /[?#]debug(=1)?/i.test(location.hash);

// Option: add &relax=1 (in debug mode) to relax the time filter (helpful if everything looks “past”)
const relax = debug && (/[?#]relax(=1)?/i.test(location.search) || /[?#]relax(=1)?/i.test(location.hash));

const JSON_URL = new URL('./events.json', location.href).toString() + '?v=' + Date.now();

// ---------- Time helpers ----------
function getNowChicago() {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', hour12: false,
    year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit'
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).map(p => [p.type, p.value]));
  const iso = `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:00`;
  return new Date(iso);
}
function minOfDay(d) { return d.getHours()*60 + d.getMinutes(); }

function setHeaderClock() {
  const now = getNowChicago();
  const dateFmt = new Intl.DateTimeFormat('en-US', { timeZone:'America/Chicago', weekday:'long', month:'long', day:'numeric' });
  const timeFmt = new Intl.DateTimeFormat('en-US', { timeZone:'America/Chicago', hour:'numeric', minute:'2-digit' });
  const dEl = document.getElementById('headerDate');
  const tEl = document.getElementById('headerClock');
  if (dEl) dEl.textContent = dateFmt.format(now);
  if (tEl) tEl.textContent = timeFmt.format(now);
}
setHeaderClock();
setInterval(setHeaderClock, 10_000);

// ---------- Tiny debug overlay ----------
function ensureDebugOverlay() {
  if (!debug) return null;
  let el = document.getElementById('dbg');
  if (!el) {
    el = document.createElement('div');
    el.id = 'dbg';
    Object.assign(el.style, {
      position: 'fixed', left: '12px', bottom: '12px', zIndex: 9999,
      background: 'rgba(0,0,0,.7)', color: '#fff', padding: '10px 12px',
      font: '12px/1.4 Monospace', borderRadius: '8px', border: '1px solid #333',
      maxWidth: '540px', whiteSpace: 'pre-wrap'
    });
    document.body.appendChild(el);
  }
  return el;
}
function dbg(msg) {
  if (!debug) return;
  const el = ensureDebugOverlay();
  el.textContent += (el.textContent ? '\n' : '') + msg;
}

// ---------- UI helpers ----------
function toClock(min) {
  let h = Math.floor(min/60), m = min%60;
  const mer = h >= 12 ? 'PM' : 'AM';
  if (h === 0) h = 12; else if (h > 12) h -= 12;
  return `${h}:${String(m).padStart(2,'0')} ${mer}`;
}
function escapeHtml(s){ return String(s||'').replace(/[&<>"']/g,c=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }

// Smooth single-card rotor per room
function startRotor(container, items, rotateMs=7000) {
  if (!items || !items.length) {
    container.innerHTML = ''; // no filler card
    return;
  }
  let idx = 0;
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

  // first card
  const first = mk(0);
  first.classList.add('is-enter');
  container.innerHTML = '';
  container.appendChild(first);
  requestAnimationFrame(() => first.classList.add('is-active'));
  idx = 1 % items.length;

  setInterval(() => {
    const current = container.querySelector('.event');
    const next = mk(idx);
    idx = (idx + 1) % items.length;

    next.classList.add('is-enter');
    container.appendChild(next);

    requestAnimationFrame(() => {
      if (current) {
        current.classList.remove('is-enter');
        current.classList.add('is-exit','is-active');
      }
      next.classList.add('is-active');
    });

    setTimeout(() => {
      if (current && current.parentNode) current.parentNode.removeChild(current);
      next.classList.remove('is-enter','is-active');
    }, 620);
  }, rotateMs);
}

// ---------- Render ----------
(async function init(){
  // 1) Fetch JSON
  let data;
  try {
    const res = await fetch(JSON_URL, { cache:'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
  } catch (e) {
    dbg(`❌ Failed to load events.json: ${e.message}`);
    console.error('Failed to load events.json', e);
    return;
  }

  // 2) Basic validation / quick stats
  const slots = Array.isArray(data.slots) ? data.slots : [];
  dbg(`Loaded slots: ${slots.length}`);

  // 3) Time filter: hide past
  const now = getNowChicago();
  const nowMin = minOfDay(now);

  // In debug+relax mode, include items ending within the last 60 minutes
  const grace = relax ? 60 : 0;
  const future = slots.filter(s => Number(s.endMin) > (nowMin - grace));

  dbg(`After time filter (grace ${grace}m): ${future.length}`);

  // 4) Group by roomId
  const byRoom = new Map();
  const unknownRoomIds = new Set();
  for (const s of future) {
    const rid = String(s.roomId || '').trim();
    if (!rid) continue;
    if (!/^1A|1B|2A|2B|3|4|5|6|7|8|9A|9B|10A|10B$/.test(rid)) {
      unknownRoomIds.add(rid);
    }
    if (!byRoom.has(rid)) byRoom.set(rid, []);
    byRoom.get(rid).push(s);
  }
  if (debug && unknownRoomIds.size) {
    dbg(`⚠️ Unknown roomIds in JSON: ${[...unknownRoomIds].join(', ')}`);
  }

  // 5) Sort each room
  for (const arr of byRoom.values()) {
    arr.sort((a,b) => (a.startMin - b.startMin) || (a.endMin - b.endMin) || (a.title||'').localeCompare(b.title||''));
  }

  // 6) Wire rooms -> DOM
  const roomIds = ['1A','1B','2A','2B','3','4','5','6','7','8','9A','9B','10A','10B'];
  for (const rid of roomIds) {
    const card = document.getElementById(`room-${rid}`);
    if (!card) { dbg(`Missing DOM for room ${rid}`); continue; }

    const lst = byRoom.get(rid) || [];
    const countEl = card.querySelector('.roomHeader .count em');
    if (countEl) countEl.textContent = String(lst.length);

    const rotor = card.querySelector('.single-rotor');
    if (!rotor) { dbg(`Missing rotor for room ${rid}`); continue; }

    startRotor(rotor, lst, 7000);
  }
})();
