// app.js — grid view only, past events hidden, duplicate text cleaned

const ZONES = {
  south: [1, 2],
  field: [3, 4, 5, 6, 7, 8],
  north: [9, 10],
};

const els = {
  date: document.getElementById('headerDate'),
  clock: document.getElementById('headerClock'),
  south: document.getElementById('gridSouth'),
  field: document.getElementById('gridField'),
  north: document.getElementById('gridNorth'),
};

function pad(n){ return String(n).padStart(2,'0'); }
function minsToRange(a,b){
  const fmt = m => {
    let h = Math.floor(m/60), min = m%60;
    const ampm = h >= 12 ? 'pm':'am';
    h = ((h + 11) % 12) + 1;
    return `${h}:${pad(min)}${ampm}`;
  };
  return `${fmt(a)}–${fmt(b)}`;
}
function escapeHtml(s){
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;')
    .replace(/'/g,'&#39;');
}

/** e.g., "Extreme Volleyball, Extreme Volleyball" -> "Extreme Volleyball" */
function squashCommaRepeats(s) {
  if (!s) return s;
  const parts = String(s).split(',').map(p => p.trim()).filter(Boolean);
  const out = [];
  for (const p of parts) {
    const prev = out[out.length - 1];
    if (!prev || p.localeCompare(prev, undefined, { sensitivity: 'accent' }) !== 0) {
      out.push(p);
    }
  }
  return out.join(', ');
}

/** remove exact duplicate slot rows (some CSVs repeat entries) */
function dedupeSlots(slots){
  const seen = new Set();
  const out = [];
  for (const s of slots){
    const key = `${s.roomId}|${s.startMin}|${s.endMin}|${s.title}|${s.subtitle||''}`;
    if (!seen.has(key)){ seen.add(key); out.push(s); }
  }
  return out;
}

/** 1A -> 1, 10B -> 10 */
function roomNumber(roomId){
  const m = String(roomId).match(/^(\d+)[AB]$/i);
  return m ? parseInt(m[1],10) : null;
}
/** 1A -> 'A' | 10B -> 'B' */
function roomSide(roomId){
  const m = String(roomId).match(/([AB])$/i);
  return m ? m[1].toUpperCase() : null;
}

/** Merge A & B into a single numbered cell when they are truly identical bookings */
function mergeAB(slotsByNumber){
  // For each number, if A & B have identical [start,end,title,subtitle], collapse to single entry
  const merged = {};
  for (const [num, bySide] of Object.entries(slotsByNumber)){
    const A = bySide.A || [];
    const B = bySide.B || [];
    const usedB = new Array(B.length).fill(false);
    const both = [];
    const onlyA = [];
    const onlyB = [];

    // Try to pair identical A/B
    A.forEach(a => {
      const matchIdx = B.findIndex((b, i) =>
        !usedB[i] &&
        a.startMin === b.startMin &&
        a.endMin === b.endMin &&
        a.title === b.title &&
        (a.subtitle||'') === (b.subtitle||'')
      );
      if (matchIdx >= 0){
        usedB[matchIdx] = true;
        both.push(a); // keep single copy
      }else{
        onlyA.push(a);
      }
    });
    // Remaining B not paired
    B.forEach((b,i)=>{ if(!usedB[i]) onlyB.push(b); });

    merged[num] = { both, A: onlyA, B: onlyB };
  }
  return merged;
}

function pillHtml(s){
  const line1 = squashCommaRepeats(s.title || '');
  const line2 = s.subtitle ? `<small>${escapeHtml(s.subtitle)}</small>` : '';
  const time  = minsToRange(s.startMin, s.endMin);
  return `
    <div class="pill">
      <div>
        <strong>${escapeHtml(line1)}</strong>
        ${line2}
      </div>
      <div class="time">${time}</div>
    </div>
  `;
}

function emptyHtml(){
  return `<div class="empty">No current/future reservations</div>`;
}

function cellHtml(num, grouped){
  const { both, A, B } = grouped;

  // Header status
  const total = both.length + A.length + B.length;
  const status = total ? `${total} event${total>1?'s':''}` : 'Idle';

  // Body content
  let body = '';
  if (both.length){
    body += both.map(pillHtml).join('');
  }
  if (A.length || B.length){
    // Show side labels only when split is needed
    if (A.length){
      body += `<div class="pill">${A.map(pillHtml).join('')}</div>`;
      body = body.replace('<div class="pill">','<div class="pill"><strong style="margin-right:8px">Side A</strong>');
    }
    if (B.length){
      body += `<div class="pill">${B.map(pillHtml).join('')}</div>`;
      body = body.replace('<div class="pill">','<div class="pill"><strong style="margin-right:8px">Side B</strong>');
    }
  }
  if (!both.length && !A.length && !B.length){
    body = '';
  }

  return `
    <div class="cell">
      <div class="title">
        <div class="court">${num}</div>
        <div class="status">${status}</div>
      </div>
      ${body}
    </div>
  `;
}

/** Render one zone into its container */
function renderZone(container, numbers, merged){
  container.innerHTML = numbers.map(n => cellHtml(n, merged[n] || {both:[],A:[],B:[]})).join('');
}

/** Load and render everything */
async function init(){
  // 1) Date + live clock
  const tick = () => {
    const now = new Date();
    const d = now.toLocaleDateString(undefined, { weekday:'long', month:'long', day:'numeric' });
    const t = now.toLocaleTimeString(undefined, { hour:'2-digit', minute:'2-digit' });
    els.date.textContent = d;
    els.clock.textContent = t;
  };
  tick();
  setInterval(tick, 30_000);

  // 2) Load events.json (no cache)
  const url = `./events.json?ts=${Date.now()}`;
  const resp = await fetch(url, { cache:'no-store' });
  if (!resp.ok){
    console.error('Failed to fetch events.json', resp.status, resp.statusText);
    return;
  }
  const data = await resp.json();
  console.log('Loaded events.json', data ? {} : { error:'no data' });

  const nowMin = new Date().getHours()*60 + new Date().getMinutes();

  // 3) Filter to current/future only
  const allSlots = Array.isArray(data.slots) ? data.slots : [];
  const deduped  = dedupeSlots(allSlots);
  const future   = deduped.filter(s => s.endMin > nowMin);
  console.log(`Slots filtered by time: ${deduped.length} -> ${future.length} (now=${nowMin})`);

  // 4) Group slots by court number & side
  const byNumber = {}; // { [num]: { A:[...], B:[...] } }
  for (const s of future){
    const num = roomNumber(s.roomId);
    const side = roomSide(s.roomId);
    if (!num || !side) continue;
    if (!byNumber[num]) byNumber[num] = { A:[], B:[] };
    byNumber[num][side].push(s);
  }

  // 5) Merge A/B when identical, otherwise show split
  const merged = mergeAB(byNumber);

  // 6) Render zones (South 1–2, Field 3–8, North 9–10)
  renderZone(els.south, ZONES.south, merged);
  renderZone(els.field, ZONES.field, merged);
  renderZone(els.north, ZONES.north, merged);
}

document.addEventListener('DOMContentLoaded', init);
