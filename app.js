// app.js — RAEC Rooms Board (frontend)

// ---------- utilities ----------
const $  = (s, r=document)=>r.querySelector(s);
const $$ = (s, r=document)=>Array.from(r.querySelectorAll(s));
const pad2 = n => (n<10?'0'+n:''+n);

// minutes -> "h:mm AM/PM"
function fmtMinutes(mins){
  let h = Math.floor(mins/60), m = mins%60;
  const mer = h>=12 ? 'PM':'AM';
  h = h%12; if(h===0) h=12;
  return `${h}:${pad2(m)} ${mer}`;
}
function minutesNowLocal(){
  const d = new Date();
  return d.getHours()*60 + d.getMinutes();
}
function setHeaderDateClock(){
  const now = new Date();
  const dateStr = now.toLocaleDateString(undefined, {
    weekday:'long', month:'long', day:'numeric', year:'numeric'
  });
  const timeStr = now.toLocaleTimeString(undefined, { hour:'numeric', minute:'2-digit' });
  const dateEl = $('#headerDate'), clkEl = $('#headerClock');
  if(dateEl) dateEl.textContent = dateStr;
  if(clkEl)  clkEl.textContent  = timeStr;
}

// ---------- display normalizers (guard against imperfect transform) ----------
function normalizeTitle(raw){
  let t = String(raw||'').trim();

  // "Org, Org" -> "Org"
  const dup = t.match(/^(.+?),\s*\1\b/i);
  if(dup) t = dup[1].trim();

  // "Catch Corner (Internal Holds, Catch Corner (Internal Holds" -> "Catch Corner"
  if (/^catch\s*corner/i.test(t)) t = 'Catch Corner';

  // Last, First -> First Last (only if looks like personal name)
  const lf = t.match(/^([A-Za-z'.-]+),\s*([A-Za-z'.-]+)\b/);
  if(lf && lf[1] && lf[2] && !/volleyball|club|training|academy|united|elite|sports?/i.test(t)){
    t = `${lf[2]} ${lf[1]}`;
  }

  // "Extreme Volleyball, Extreme Volleyball" -> "Extreme Volleyball"
  if (/^(.+?),\s*\1\b/i.test(t)) t = t.replace(/^(.+?),\s*\1\b/i, '$1');

  // Trim a dangling "("
  t = t.replace(/\(\s*$/, '').trim();

  return t;
}

function normalizeSubtitle(rawTitle, rawSubtitle){
  let s = String(rawSubtitle||'').trim();

  // Chicago Sport and Social: ensure full E column shows (no truncation)
  // (Nothing special to do here; just avoid cutting at ')' — we keep all)

  // Catch Corner: show only content **inside** parentheses, if present and informative
  if (/^catch\s*corner/i.test(String(rawTitle||''))){
    const m = s.match(/\(([^)]+)\)/);
    if (m && m[1]) s = m[1].trim();
  }

  // Collapse common placeholders
  s = s
    .replace(/\bInternal Hold per NM\b/ig, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  return s;
}

// ---------- a single event chip ----------
function eventChip(slot){
  const when = `${fmtMinutes(slot.startMin)} – ${fmtMinutes(slot.endMin)}`;
  const who  = normalizeTitle(slot.title);
  const what = normalizeSubtitle(slot.title, slot.subtitle);

  const el = document.createElement('div');
  el.className = 'event';
  el.style.position = 'absolute';
  el.style.inset = '0';
  el.style.display = 'flex';
  el.style.flexDirection = 'column';
  el.style.gap = '6px';
  el.style.background = 'var(--chip)';
  el.style.border = '1px solid var(--grid)';
  el.style.borderRadius = '12px';
  el.style.padding = '12px 14px';
  el.style.boxSizing = 'border-box';
  el.style.willChange = 'transform,opacity';
  el.style.backfaceVisibility = 'hidden';
  el.style.transform = 'translateZ(0)';
  el.style.opacity = '0';
  el.style.transform = 'translateX(40px)';
  el.style.transition = 'transform 420ms var(--ease, cubic-bezier(.22,.61,.36,1)), opacity 420ms var(--ease, cubic-bezier(.22,.61,.36,1))';

  el.innerHTML = `
    <div class="who"  style="font-size:20px; font-weight:800; line-height:1.15;">${who}</div>
    ${what ? `<div class="what" style="font-size:16px; color:var(--muted); line-height:1.2;">${what}</div>` : ``}
    <div class="when" style="font-size:15px; color:#b7c0cf; font-weight:600;">${when}</div>
  `;
  return el;
}

// ---------- rotor (only if >1) ----------
function startRotor(container, items, periodMs=8000){
  let idx = 0;
  const mount = (i) => {
    const el = eventChip(items[i]);
    container.appendChild(el);
    requestAnimationFrame(()=>{ el.style.opacity='1'; el.style.transform='translateX(0)'; });
    return el;
  };

  let curr = mount(idx);
  if (items.length < 2) return; // no rotation if just one

  const tick = () => {
    const nextIdx = (idx+1) % items.length;
    const next = mount(nextIdx);
    // exit current
    curr.style.opacity = '0';
    curr.style.transform = 'translateX(-40px)';
    setTimeout(()=>{ try{curr.remove();}catch{} curr = next; idx = nextIdx; }, 460);
  };
  const t = setInterval(tick, periodMs);
  container._rotorTimer = t;
}

// ---------- fill a room ----------
function fillRoom(roomId, slots){
  const card = document.getElementById(`room-${roomId}`);
  if(!card) return;
  const cnt = card.querySelector('.roomHeader .count em');
  const wrap = card.querySelector('.events');
  if(cnt)  cnt.textContent = String(slots.length);
  if(!wrap) return;

  wrap.innerHTML='';
  if(!slots.length) return;

  const rotor = document.createElement('div');
  rotor.className = 'single-rotor';
  rotor.style.position='relative';
  rotor.style.height='100%';
  rotor.style.width='100%';
  wrap.appendChild(rotor);

  startRotor(rotor, slots, 8000);
}

// ---------- fieldhouse/turf area ----------
function isTurfRoomId(id){
  return /Quarter Turf (NA|NB|SA|SB)/i.test(id);
}
function renderFieldhouseRooms(events){
  const holder = $('#fieldhousePager');
  if(!holder) return;

  holder.innerHTML='';

  // If any room id is "Quarter Turf *", switch to 2×2. Otherwise default (css) 2×3.
  const hasTurf = (events.rooms||[]).some(r => isTurfRoomId(r.id));
  if(hasTurf){
    holder.style.display = 'grid';
    holder.style.gridTemplateColumns = '1fr 1fr';
    holder.style.gridTemplateRows    = '1fr 1fr';
    holder.style.gap = '12px';
  }else{
    holder.style.display = 'grid';
    holder.style.gridTemplateColumns = '1fr 1fr 1fr';
    holder.style.gridTemplateRows    = '1fr 1fr';
    holder.style.gap = '12px';
  }

  // Only add the fieldhouse/turf rooms here; fixed south/north are in HTML.
  const fh = (events.rooms||[]).filter(r => r.group === 'fieldhouse');
  for(const r of fh){
    const div = document.createElement('div');
    div.className = 'room';
    div.id = `room-${r.id}`;
    div.innerHTML = `
      <div class="roomHeader">
        <div class="id">${r.label}</div>
        <div class="count">reservations: <em>—</em></div>
      </div>
      <div class="events"></div>
    `;
    holder.appendChild(div);
  }
}

// ---------- grouping & filters ----------
function groupSlotsByRoom(events){
  const map = new Map();
  for (const r of (events.rooms||[])) map.set(r.id, []);
  for (const s of (events.slots||[])) {
    if (!map.has(s.roomId)) map.set(s.roomId, []);
    map.get(s.roomId).push(s);
  }
  // sort by time then title
  for (const arr of map.values()){
    arr.sort((a,b)=>(a.startMin-b.startMin)||String(a.title).localeCompare(String(b.title)));
  }
  return map;
}

// Hide pickleball after 12:30 PM local
function filterPickleballTime(slots){
  const mins = minutesNowLocal();           // local minutes
  const cutoff = 12*60 + 30;                // 12:30 PM
  return (slots||[]).filter(s => {
    const isPB = /^open pickleball$/i.test(String(s.title||'').trim());
    if (!isPB) return true;
    return mins < cutoff;
  });
}

// ---------- boot ----------
async function boot(){
  setHeaderDateClock();
  setInterval(setHeaderDateClock, 1000);

  const res = await fetch(`./events.json?cb=${Date.now()}`, { cache: 'no-store' });
  const events = await res.json();

  // Fieldhouse/Turf dynamic frame
  renderFieldhouseRooms(events);

  // Time-based front-end filter for Pickleball (after 12:30 → hide)
  const eventsFiltered = {
    ...events,
    slots: filterPickleballTime(events.slots)
  };

  const byRoom = groupSlotsByRoom(eventsFiltered);

  // Fill every known room id from events.rooms
  for (const r of (events.rooms||[])){
    const list = byRoom.get(r.id)||[];
    fillRoom(r.id, list);
  }

  // dev log
  const counts = {};
  for (const s of (eventsFiltered.slots||[])) counts[s.roomId]=(counts[s.roomId]||0)+1;
  console.log('events.json loaded:', {
    season: events.season,
    totalSlots: (eventsFiltered.slots||[]).length,
    byRoom: counts
  });
}

boot().catch(err => console.error('app init failed:', err));
