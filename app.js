// Smoother slide + robust person-name handling using org/contact if present.

const WIFI_SSID = 'RAEC-Public';
const WIFI_PASS = 'Publ!c00';

// ---------- time ----------
function nowMinutesLocal() {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}
function isCurrentOrUpcoming(slot, now = nowMinutesLocal()) {
  return slot.endMin > now;
}
function fmt12h(min) {
  let h = Math.floor(min / 60);
  const m = min % 60;
  const ampm = h >= 12 ? 'pm' : 'am';
  h = h % 12; if (h === 0) h = 12;
  return `${h}:${m.toString().padStart(2,'0')}${ampm}`;
}
function range12h(a,b){ return `${fmt12h(a)} - ${fmt12h(b)}`; }

// ---------- label rules ----------
const PICKLE_RE = /pickleball/i;
const CATCH_RE  = /^catch\s*corner/i;

function cleanSubtitle(sub) {
  if (!sub) return '';
  let s = sub.replace(/internal\s*hold.*$/i,'').trim(); // remove “Internal Hold …”
  s = s.replace(/\)\s*$/,'').trim();                    // trailing )
  return s;
}

function splitOrgContactFromTitle(titleRaw) {
  if (!titleRaw) return { org:'', contact:'' };
  if (CATCH_RE.test(titleRaw)) return { org:'Catch Corner', contact:'' };

  const parts = titleRaw.split(',').map(s=>s.trim()).filter(Boolean);
  if (parts.length >= 2) {
    const org = parts[0];
    const contact = parts.slice(1).join(' ');
    return { org, contact };
  }
  return { org: titleRaw.trim(), contact:'' };
}

function isLikelyPersonComma(text) {
  // "Last, First" style
  return /^[A-Za-z]+,\s*[A-Za-z]/.test(text || '');
}
function personNameFromComma(text) {
  const [last, first = ''] = (text||'').split(',').map(s=>s.trim());
  if (!last) return text || '';
  return `${first} ${last}`.trim();
}

function looksLikeSingleWordName(s){
  return /^[A-Za-z]+$/.test(s || '');
}

// Use org/contact in slot if present; fallback to parsing title.
function deriveOrgContact(slot){
  // prefer explicit fields from transform if provided
  const org = (slot.org || '').trim();
  const contact = (slot.contact || '').trim();
  if (org || contact) return { org, contact };

  // else parse from title
  return splitOrgContactFromTitle(slot.title || '');
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

// ---------- header ----------
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

// ---------- payload builder ----------
function makePayload(slot){
  const now = nowMinutesLocal();
  if (!isCurrentOrUpcoming(slot, now)) return null;

  const subtitle = cleanSubtitle(slot.subtitle || '');

  // Pickleball special
  if (PICKLE_RE.test(slot.title || '') || PICKLE_RE.test(subtitle)) {
    return { who:'Open Pickleball', what:'', when: range12h(slot.startMin, slot.endMin) };
  }

  // Catch Corner special
  if (CATCH_RE.test(slot.title || '') || CATCH_RE.test(slot.org || '')) {
    // Use reservation purpose/details from subtitle (stripped), no leading "Catch Corner"
    const detail = subtitle.replace(/^Catch *Corner\s*/i,'').trim();
    return { who:'Catch Corner', what: detail, when: range12h(slot.startMin, slot.endMin) };
  }

  // If original title is “Last, First”
  if (isLikelyPersonComma(slot.title)) {
    return {
      who: personNameFromComma(slot.title),
      what: subtitle,
      when: range12h(slot.startMin, slot.endMin)
    };
  }

  // If transform already split org/contact, try to detect a person:
  // person if org is single surname and contact is single given name
  const { org, contact } = deriveOrgContact(slot);
  if (looksLikeSingleWordName(org) && looksLikeSingleWordName(contact)) {
    // Display "First Last" in bold
    return {
      who: `${contact} ${org}`.trim(),
      what: subtitle,
      when: range12h(slot.startMin, slot.endMin)
    };
  }

  // Otherwise: org bold, contact (if present) as what; else subtitle
  return {
    who: (org || slot.title || '').trim(),
    what: (contact || subtitle).trim(),
    when: range12h(slot.startMin, slot.endMin)
  };
}

// ---------- rotors ----------
function setCount(roomEl, n){
  const em = roomEl.querySelector('.roomHeader .count em');
  if (em) em.textContent = String(n);
}

// more stable timing than setInterval when animating
function startRotor(container, items, periodMs=8000){
  container.innerHTML = '';
  if (!items.length) return;

  let idx = 0;
  let current = buildEventDOM(items[0].who, items[0].what, items[0].when);
  current.classList.add('fade-enter');
  container.appendChild(current);
  requestAnimationFrame(()=>{
    current.classList.add('fade-enter-active');
    current.classList.remove('fade-enter');
  });

  if (items.length === 1) return;

  function tick(){
    const outgoing = current;
    idx = (idx + 1) % items.length;
    const nextData = items[idx];

    const incoming = buildEventDOM(nextData.who, nextData.what, nextData.when);
    incoming.classList.add('fade-enter');
    container.appendChild(incoming);

    requestAnimationFrame(()=>{
      // outgoing -> exit left
      outgoing.classList.add('fade-exit');
      requestAnimationFrame(()=> outgoing.classList.add('fade-exit-active'));

      // incoming -> slide from right
      incoming.classList.add('fade-enter-active');
      incoming.classList.remove('fade-enter');
    });

    // cleanup after CSS dur (~740ms) + margin
    setTimeout(()=>{
      if (outgoing && outgoing.parentNode) outgoing.parentNode.removeChild(outgoing);
      current = incoming;
      setTimeout(tick, periodMs); // schedule next after period (prevents drift)
    }, 780);
  }

  setTimeout(tick, periodMs);
}

// ---------- renders ----------
function renderABRoom(baseId, slots){
  const aEl = document.getElementById(`room-${baseId}A`);
  const bEl = document.getElementById(`room-${baseId}B`);
  if (!aEl || !bEl) return;

  const upcoming = slots.filter(s => String(s.roomId) === String(baseId) && isCurrentOrUpcoming(s));
  const items = upcoming.map(makePayload).filter(Boolean);

  setCount(aEl, items.length);
  setCount(bEl, items.length);

  startRotor(aEl.querySelector('.single-rotor'), items, 8000);
  startRotor(bEl.querySelector('.single-rotor'), items, 8000);
}

function renderFieldhouse(slots){
  const pager = document.getElementById('fieldhousePager');
  pager.innerHTML = '';

  const page = document.createElement('div');
  page.className = 'page is-active';

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

    const upcoming = slots.filter(s => String(s.roomId) === String(id) && isCurrentOrUpcoming(s));
    const items = upcoming.map(makePayload).filter(Boolean);

    items.forEach(it => list.appendChild(buildEventDOM(it.who, it.what, it.when)));

    header.querySelector('.count em').textContent = String(items.length);
    eventsWrap.appendChild(list);
    card.append(header, eventsWrap);
    page.appendChild(card);
  }

  pager.appendChild(page);
}

function renderAll(data){
  const slots = Array.isArray(data.slots) ? data.slots : [];

  renderABRoom(1, slots);
  renderABRoom(2, slots);

  renderFieldhouse(slots);

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

    // refresh every minute to drop ended items
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
