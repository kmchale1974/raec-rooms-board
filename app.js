// app.js

// ------------ helpers
const PAD = n => String(n).padStart(2, '0');
function fmt12h(mins){
  let h = Math.floor(mins/60), m = mins%60;
  const ampm = h >= 12 ? 'pm' : 'am';
  h = h % 12; if (h === 0) h = 12;
  return `${h}:${PAD(m)}${ampm}`;
}
function timeRange(s,e){ return `${fmt12h(s)} - ${fmt12h(e)}`; }

function isNowBetween(startMin, endMin){
  const dt = new Date();
  const nowMin = dt.getHours()*60 + dt.getMinutes();
  return endMin > nowMin; // hide ended events
}

// Name & content cleaners
function titleCaseName(s){
  // "Vazquez, Isabel" => "Isabel Vazquez"; leave org-like strings alone
  if (!s) return s;
  if (s.includes('@')) return s; // email-ish
  // quick heuristic: one comma and two tokens -> likely a person
  const parts = s.split(',').map(t=>t.trim()).filter(Boolean);
  if (parts.length === 2 && parts[0].split(' ').length <= 2 && parts[1].split(' ').length <= 3){
    return `${parts[1]} ${parts[0]}`;
  }
  return s;
}

function cleanupPickleball(slot){
  // If it's a Pickleball internal hold, show "Open Pickleball" only
  const t = (slot.title||'').toLowerCase();
  const u = (slot.subtitle||'').toLowerCase();
  if (t.includes('pickleball') || u.includes('pickleball')){
    return {
      ...slot,
      title: 'Open Pickleball',
      subtitle: ''
    };
  }
  return slot;
}

function cleanupCatchCorner(slot){
  // "Catch Corner (Internal Holds, ...)" => title "Catch Corner", subtitle stripped inside
  const t = slot.title || '';
  if (/^catch\s*corner/i.test(t)){
    let sub = slot.subtitle || '';
    // Remove "CatchCorner (" wrapper if present
    sub = sub.replace(/^CatchCorner\s*\((.*)\)\s*$/i, '$1');
    // Also strip leading "Internal Holds," or similar if left in title
    return { ...slot, title: 'Catch Corner', subtitle: sub };
  }
  return slot;
}

function splitOrgContact(rawTitle){
  // Try to keep org bold and contact below (e.g., "Illinois Flight, Brandon Brown")
  if (!rawTitle) return { org: '', contact: '' };
  const m = rawTitle.split(',').map(s=>s.trim());
  if (m.length >= 2){
    const org = m[0];
    const contact = m.slice(1).join(', ');
    return { org, contact };
  }
  return { org: rawTitle, contact: '' };
}

// If a slot is unsplit for courts 1/2/9/10 (meaning covers whole court), mirror it into A & B
function expandABSlots(slots){
  const BOTH = new Set(['1','2','9','10']); // unsplit means both halves
  const out = [];
  for (const s of slots){
    const rid = String(s.roomId);
    if (BOTH.has(rid)){
      out.push({ ...s, roomId: `${rid}A` });
      out.push({ ...s, roomId: `${rid}B` });
    }else{
      out.push(s);
    }
  }
  return out;
}

// Keep only current/future events and apply cleanup rules
function normalizeSlots(slots){
  return expandABSlots(slots)
    .filter(s => isNowBetween(s.startMin, s.endMin))
    .map(s => cleanupPickleball(s))
    .map(s => cleanupCatchCorner(s))
    .map(s => {
      // Derive org/contact if missing
      const base = splitOrgContact(s.title || '');
      let org = s.org || base.org || '';
      let contact = s.contact || base.contact || '';

      // If org looks like a person ("Last, First"), convert to "First Last"
      const tcOrg = titleCaseName(org);
      // If contact exists and is a person "Last, First", convert
      const tcContact = titleCaseName(contact);

      return { ...s, org: tcOrg, contact: tcContact };
    });
}

// Group rooms for rendering
const SOUTH_ROOMS = ['1A','1B','2A','2B'];
const NORTH_ROOMS = ['9A','9B','10A','10B'];
const FIELD_ROOMS = ['3','4','5','6','7','8'];

function roomGroup(roomId){
  if (SOUTH_ROOMS.includes(roomId)) return 'south';
  if (NORTH_ROOMS.includes(roomId)) return 'north';
  if (FIELD_ROOMS.includes(roomId)) return 'fieldhouse';
  return 'unknown';
}

// ------------ rendering
function el(tag, cls, text){
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function renderHeaderClock(){
  const dEl = document.getElementById('headerDate');
  const cEl = document.getElementById('headerClock');
  function tick(){
    const now = new Date();
    const optsD = { weekday:'long', month:'long', day:'numeric' };
    dEl.textContent = now.toLocaleDateString(undefined, optsD);
    const hh = now.getHours(), mm = now.getMinutes();
    const ampm = hh >= 12 ? 'PM' : 'AM';
    let h12 = hh % 12; if (h12 === 0) h12 = 12;
    cEl.textContent = `${h12}:${PAD(mm)} ${ampm}`;
  }
  tick();
  setInterval(tick, 1000*10);
}

function makeRoomCard(roomId, events){
  const card = el('div','room');
  const hdr = el('div','roomHeader');
  hdr.append(el('div','id', roomId));
  hdr.append(el('div','count', events.length ? `${events.length} event${events.length>1?'s':''}` : ''));
  card.append(hdr);

  const list = el('div','events');

  // show up to TWO events per tile
  const toShow = events.slice(0,2);
  toShow.forEach(s => {
    const item = el('div','event');
    // Bold org (or title fallback), then regular line for contact/purpose, then time
    const who = el('div','who', s.org || s.title || '—');
    const whatBits = [];
    if (s.contact && s.contact !== s.org) whatBits.push(s.contact);
    if (s.subtitle) whatBits.push(s.subtitle);
    const what = el('div','what', whatBits.join(' • '));
    const when = el('div','when', timeRange(s.startMin, s.endMin));
    item.append(who);
    if (what.textContent) item.append(what);
    item.append(when);
    list.append(item);
  });

  if (events.length > 2){
    list.append(el('div','more', `+${events.length-2} more`));
  }

  card.append(list);
  return card;
}

function renderGrid(data){
  const southWrap = document.getElementById('southRooms');
  const northWrap = document.getElementById('northRooms');
  const fieldWrap = document.getElementById('fieldhouseRooms');
  southWrap.innerHTML = ''; northWrap.innerHTML = ''; fieldWrap.innerHTML = '';

  const slots = normalizeSlots(Array.isArray(data.slots) ? data.slots : []);
  const byRoom = new Map();
  const allRooms = [...SOUTH_ROOMS, ...FIELD_ROOMS, ...NORTH_ROOMS];
  allRooms.forEach(id => byRoom.set(id, []));

  for (const s of slots){
    const id = String(s.roomId);
    if (!byRoom.has(id)) byRoom.set(id, []);
    byRoom.get(id).push(s);
  }

  // Sort events in each room by start time
  for (const [id, arr] of byRoom) arr.sort((a,b)=>a.startMin-b.startMin);

  // South
  SOUTH_ROOMS.forEach(id => {
    southWrap.append( makeRoomCard(id, byRoom.get(id) || []) );
  });
  // Fieldhouse 3..8 laid out 3 columns x 2 rows
  FIELD_ROOMS.forEach(id => {
    fieldWrap.append( makeRoomCard(id, byRoom.get(id) || []) );
  });
  // North
  NORTH_ROOMS.forEach(id => {
    northWrap.append( makeRoomCard(id, byRoom.get(id) || []) );
  });
}

// ------------ data load & init
async function loadData(){
  const url = `./events.json?ts=${Date.now()}`;
  const resp = await fetch(url, { cache:'no-store' });
  if (!resp.ok) throw new Error(`Failed to fetch events.json: ${resp.status}`);
  return resp.json();
}

async function init(){
  renderHeaderClock();
  try{
    const data = await loadData();
    console.log('Loaded events.json', data);
    renderGrid(data);
  }catch(err){
    console.error(err);
  }
}
document.addEventListener('DOMContentLoaded', init);

// Optional: refresh the board every 5 minutes
setInterval(()=>init(), 5*60*1000);
