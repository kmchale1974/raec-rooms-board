// app.js  — stable layout, AB rotors (1 event), fieldhouse pager, slide-left sync

const WIFI_SSID = 'RAEC-Public';
const WIFI_PASS = 'Publ!c00';

// ---------- time helpers ----------
function nowMinutesLocal() {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}
function isCurrentOrUpcoming(slot, now = nowMinutesLocal()) {
  return slot.endMin > now; // drop ended
}
function fmt12h(min) {
  let h = Math.floor(min / 60);
  const m = min % 60;
  const ampm = h >= 12 ? 'pm' : 'am';
  h = h % 12; if (h === 0) h = 12;
  return `${h}:${m.toString().padStart(2,'0')}${ampm}`;
}
function range12h(a,b){ return `${fmt12h(a)} - ${fmt12h(b)}`; }

// ---------- name/label rules ----------
const PICKLE_RE = /pickleball/i;
const CATCH_RE  = /^catch\s*corner/i;

function cleanSubtitle(sub) {
  if (!sub) return '';
  // remove “Internal Hold per ...” / stray trailing parens
  let s = sub.replace(/internal\s*hold.*$/i,'').trim();
  s = s.replace(/\)\s*$/,'').trim();
  return s;
}

function splitOrgContact(titleRaw) {
  if (!titleRaw) return { org:'', contact:'' };
  if (CATCH_RE.test(titleRaw)) return { org:'Catch Corner', contact:'' };

  // Pattern: "Org, First Last"  (two commas is still Org, First Last)
  const parts = titleRaw.split(',').map(s=>s.trim()).filter(Boolean);
  if (parts.length >= 2) {
    const org = parts[0];
    const contact = parts.slice(1).join(' ');
    return { org, contact };
  }
  return { org: titleRaw.trim(), contact:'' };
}

function isLikelyPerson(text) {
  // e.g., "Vazquez, Isabel" or "Doe, J"
  if (!text) return false;
  return /^[A-Za-z]+,\s*[A-Za-z]/.test(text) && !CATCH_RE.test(text) && !PICKLE_RE.test(text);
}

function personNameFromComma(text) {
  const [last, first = ''] = text.split(',').map(s=>s.trim());
  if (!last) return text;
  return `${first} ${last}`.trim();
}

function buildEventDOM(whoBold, whatLine, whenLine) {
  const ev = document.createElement('div');
  ev.className = 'event';
  const who = document.createElement('div');
  who.className = 'who';
  who.textContent = whoBold;

  const what = document.createElement('div');
  what.className = 'what';
  what.textContent = whatLine;

  const when = document.createElement('div');
  when.className = 'when';
  when.textContent = whenLine;

  ev.append(who, what, when);
  return ev;
}

// ---------- data load ----------
async function loadData() {
  const resp = await fetch(`./events.json?ts=${Date.now()}`, { cache:'no-store' });
  if (!resp.ok) throw new Error(`events.json ${resp.status}`);
  return resp.json();
}

// ---------- render ----------
function renderHeader() {
  document.getElementById('wifiSsid').textContent = WIFI_SSID;
  document.getElementById('wifiPass').textContent = WIFI_PASS;

  function tick(){
    const d = new Date();
    const dow = d.toLocaleDateString(undefined,{weekday:'long'});
    const date = d.toLocaleDateString(undefined,{month:'long', day:'numeric', year:'numeric'});
    const time = d.toLocaleTimeString(undefined,{hour:'numeric', minute:'2-digit'});
    document.getElementById('headerDate').textContent = `${dow}, ${date}`;
    document.getElementById('headerClock').textContent = time;
  }
  tick(); setInterval(tick, 1000);
}

function attachRotor(container, items, periodMs=8000) {
  // One-at-a-time, always slide left. All rooms tick in sync by same intervals.
  let idx = 0;
  let currentEl = null;

  const mount = (i) => {
    const data = items[i];
    const el = buildEventDOM(data.who, data.what, data.when);
    el.classList.add('fade-enter','event');
    container.appendChild(el);
    // enter
    requestAnimationFrame(()=>{
      el.classList.add('fade-enter-active');
      el.classList.remove('fade-enter');
    });
    currentEl = el;
  };

  const swap = () => {
    if (!items.length) return;
    const outEl = currentEl;
    idx = (idx + 1) % items.length;
    const nextData = items[idx];
    const inEl = buildEventDOM(nextData.who, nextData.what, nextData.when);
    inEl.classList.add('fade-enter','event');
    container.appendChild(inEl);

    // animate both
    requestAnimationFrame(()=>{
      // outgoing -> exit left
      if (outEl){
        outEl.classList.add('fade-exit');
        // next frame to activate
        requestAnimationFrame(()=> outEl.classList.add('fade-exit-active'));
      }
      // incoming -> slide from right to center
      inEl.classList.add('fade-enter-active');
      inEl.classList.remove('fade-enter');
    });

    // clean old after animation
    setTimeout(()=>{
      if (outEl && outEl.parentNode) outEl.parentNode.removeChild(outEl);
      currentEl = inEl;
    }, 460);
  };

  // seed
  if (items.length){
    mount(0);
    if (items.length > 1){
      setInterval(swap, periodMs);
    }
  } else {
    container.innerHTML = '';
  }
}

function setCount(roomEl, n){
  const em = roomEl.querySelector('.roomHeader .count em');
  if (em) em.textContent = String(n);
}

// Prepare event payloads per room
function makePayload(slot){
  // Pickleball rule
  const subt = cleanSubtitle(slot.subtitle || '');
  if (PICKLE_RE.test(slot.title) || PICKLE_RE.test(subt)) {
    return {
      who: 'Open Pickleball',
      what: '',
      when: range12h(slot.startMin, slot.endMin)
    };
  }

  // Catch Corner rule
  const { org, contact } = splitOrgContact(slot.title);
  if (CATCH_RE.test(org)) {
    const detail = cleanSubtitle(slot.subtitle || '').replace(/^Catch *Corner\s*/i,'').trim();
    return {
      who: 'Catch Corner',
      what: detail || '',
      when: range12h(slot.startMin, slot.endMin)
    };
  }

  // Person name: "Last, First" -> bold "First Last"
  if (isLikelyPerson(slot.title)) {
    const full = personNameFromComma(slot.title);
    return {
      who: full,
      what: (slot.subtitle || '').trim(),
      when: range12h(slot.startMin, slot.endMin)
    };
  }

  // Org + optional contact (e.g., "Illinois Flight, Brandon Brown")
  const whoBold = org || (slot.title || '').trim();
  const what = (contact ? contact : cleanSubtitle(slot.subtitle || '')).trim();

  return {
    who: whoBold,
    what,
    when: range12h(slot.startMin, slot.endMin)
  };
}

function renderABRoom(roomIdBase, slotsAll){
  // Duplicate base room’s slots into A and B identically (per your current rule)
  const aEl = document.getElementById(`room-${roomIdBase}A`);
  const bEl = document.getElementById(`room-${roomIdBase}B`);
  if (!aEl || !bEl) return;

  const now = nowMinutesLocal();
  const filtered = slotsAll.filter(s => s.roomId === String(roomIdBase) && isCurrentOrUpcoming(s, now));

  const items = filtered.map(makePayload);

  // counts show total distinct upcoming reservations on that base court
  setCount(aEl, items.length);
  setCount(bEl, items.length);

  const rotorA = aEl.querySelector('.single-rotor');
  const rotorB = bEl.querySelector('.single-rotor');
  rotorA.innerHTML = '';
  rotorB.innerHTML = '';

  attachRotor(rotorA, items, 8000);
  attachRotor(rotorB, items, 8000);
}

function renderFieldhouse(slotsAll){
  // Rooms 3..8, lay them across one pager page (no rotation here for now)
  const pager = document.getElementById('fieldhousePager');
  pager.innerHTML = '';

  const page = document.createElement('div');
  page.className = 'page is-active';

  const now = nowMinutesLocal();

  for (let id = 3; id <= 8; id++){
    const card = document.createElement('div');
    card.className = 'room';
    card.id = `room-${id}`;

    const header = document.createElement('div');
    header.className = 'roomHeader';
    header.innerHTML = `<div class="id">${id}</div><div class="count">reservations: <em>—</em></div>`;

    const eventsWrap = document.createElement('div');
    eventsWrap.className = 'events';
    const list = document.createElement('div');
    list.className = 'events-list';

    const filtered = slotsAll.filter(s => s.roomId === String(id) && isCurrentOrUpcoming(s, now));
    const items = filtered.map(makePayload);

    items.forEach(it => {
      const ev = buildEventDOM(it.who, it.what, it.when);
      list.appendChild(ev);
    });

    const em = header.querySelector('.count em');
    em.textContent = String(items.length);

    eventsWrap.appendChild(list);
    card.append(header, eventsWrap);
    page.appendChild(card);
  }

  pager.appendChild(page);
}

function renderAll(data){
  const slots = Array.isArray(data.slots) ? data.slots : [];

  // South: 1A/1B + 2A/2B
  renderABRoom(1, slots);
  renderABRoom(2, slots);

  // Fieldhouse: 3..8
  renderFieldhouse(slots);

  // North: 9A/9B + 10A/10B
  renderABRoom(9, slots);
  renderABRoom(10, slots);
}

// ---------- boot ----------
async function init(){
  try{
    renderHeader();
    const data = await loadData();
    console.log('Loaded events.json', data);
    renderAll(data);

    // refresh clock/content every minute to drop ended items
    setInterval(async ()=>{
      try{
        const d = await loadData();
        renderAll(d);
      }catch(e){}
    }, 60_000);

  }catch(err){
    console.error(err);
  }
}

document.addEventListener('DOMContentLoaded', init);
