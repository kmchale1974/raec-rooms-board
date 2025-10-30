// RAEC Rooms Board — smooth always-left slide via Web Animations API
// FIX: rotor registry to prevent overlapping timers => consistent 8s cadence

const WIFI_SSID = 'RAEC-Public';
const WIFI_PASS = 'Publ!c00';

const SLIDE_MS = 780;   // slide duration
const PERIOD_MS = 8000; // how long each card stays before sliding

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
  return /^[A-Za-z]+,\s*[A-Za-z]/.test(text || ''); // "Last, First"
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
  const org = (slot.org || '').trim();
  const contact = (slot.contact || '').trim();
  if (org || contact) return { org, contact };
  return splitOrgContactFromTitle(slot.title || '');
}

function buildEventDOM(whoBold, whatLine, whenLine) {
  const ev = document.createElement('div');
  ev.className = 'event';
  ev.style.position = 'absolute';
  ev.style.inset = '0';
  ev.style.display = 'flex';
  ev.style.flexDirection = 'column';
  ev.style.gap = '6px';
  ev.style.background = 'var(--chip)';
  ev.style.border = '1px solid var(--grid)';
  ev.style.borderRadius = '12px';
  ev.style.padding = '10px 12px';
  ev.style.boxSizing = 'border-box';
  ev.style.willChange = 'transform, opacity';
  ev.style.backfaceVisibility = 'hidden';
  ev.style.transform = 'translateZ(0)';

  const who = document.createElement('div');
  who.className = 'who';
  who.style.fontSize = '18px';
  who.style.fontWeight = '800';
  who.style.lineHeight = '1.1';
  who.style.wordWrap = 'break-word';
  who.style.overflowWrap = 'anywhere';
  who.textContent = whoBold;

  const what = document.createElement('div');
  what.className = 'what';
  what.style.fontSize = '15px';
  what.style.color = 'var(--muted)';
  what.style.lineHeight = '1.2';
  what.style.wordWrap = 'break-word';
  what.style.overflowWrap = 'anywhere';
  what.textContent = whatLine;

  const when = document.createElement('div');
  when.className = 'when';
  when.style.fontSize = '14px';
  when.style.color = '#b7c0cf';
  when.style.fontWeight = '600';
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
  const ssidEl = document.getElementById('wifiSsid');
  const passEl = document.getElementById('wifiPass');
  if (ssidEl) ssidEl.textContent = WIFI_SSID;
  if (passEl) passEl.textContent = WIFI_PASS;

  function tick(){
    const d = new Date();
    const dow = d.toLocaleDateString(undefined,{weekday:'long'});
    const date = d.toLocaleDateString(undefined,{month:'long', day:'numeric', year:'numeric'});
    const time = d.toLocaleTimeString(undefined,{hour:'numeric', minute:'2-digit'});
    const hd = document.getElementById('headerDate');
    const hc = document.getElementById('headerClock');
    if (hd) hd.textContent = `${dow}, ${date}`;
    if (hc) hc.textContent = time;
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
    const detail = subtitle.replace(/^Catch *Corner\s*/i,'').trim();
    return { who:'Catch Corner', what: detail, when: range12h(slot.startMin, slot.endMin) };
  }

  // "Last, First"
  if (isLikelyPersonComma(slot.title)) {
    return {
      who: personNameFromComma(slot.title),
      what: subtitle,
      when: range12h(slot.startMin, slot.endMin)
    };
  }

  // org/contact heuristic
  const { org, contact } = deriveOrgContact(slot);
  if (looksLikeSingleWordName(org) && looksLikeSingleWordName(contact)) {
    return {
      who: `${contact} ${org}`.trim(),
      what: subtitle,
      when: range12h(slot.startMin, slot.endMin)
    };
  }

  return {
    who: (org || slot.title || '').trim(),
    what: (contact || subtitle).trim(),
    when: range12h(slot.startMin, slot.endMin)
  };
}

// ---------- Rotor registry (prevents overlapping loops) ----------
const rotorRegistry = new WeakMap(); // container -> {stop: fn}

function stopRotor(container) {
  const state = rotorRegistry.get(container);
  if (state && state.stop) {
    state.stop();
    rotorRegistry.delete(container);
  }
}

/**
 * Smooth, always-left slide using Web Animations API
 * container: .single-rotor (position:relative; height:100%)
 * items: [{who, what, when}]
 * Ensures only ONE rotor per container.
 */
function startRotor(container, items, periodMs = PERIOD_MS, slideMs = SLIDE_MS){
  // Cancel any previous rotor on this container
  stopRotor(container);

  container.innerHTML = '';
  container.style.position = 'relative';
  container.style.height = '100%';
  if (!items.length) return;

  let idx = 0;
  let current = buildEventDOM(items[0].who, items[0].what, items[0].when);
  container.appendChild(current);

  if (items.length === 1) {
    // Register a no-op stopper to keep semantics consistent
    rotorRegistry.set(container, { stop: () => {} });
    return;
  }

  const easing = 'cubic-bezier(.22,.61,.36,1)';
  let timerId = null;
  let cancelled = false;

  function scheduleNext() {
    if (cancelled) return;
    timerId = setTimeout(cycle, periodMs);
  }

  function cycle(){
    if (cancelled) return;

    const outgoing = current;
    idx = (idx + 1) % items.length;
    const next = buildEventDOM(items[idx].who, items[idx].what, items[idx].when);
    next.style.transform = 'translateX(60px)';
    next.style.opacity = '0';
    container.appendChild(next);

    const outAnim = outgoing.animate(
      [
        { transform: 'translateX(0)', opacity: 1 },
        { transform: 'translateX(-60px)', opacity: 0 }
      ],
      { duration: slideMs, easing, fill: 'forwards' }
    );

    const inAnim = next.animate(
      [
        { transform: 'translateX(60px)', opacity: 0 },
        { transform: 'translateX(0)', opacity: 1 }
      ],
      { duration: slideMs, easing, fill: 'forwards' }
    );

    Promise.all([outAnim.finished, inAnim.finished]).then(() => {
      if (cancelled) return;
      if (outgoing && outgoing.parentNode) outgoing.parentNode.removeChild(outgoing);
      current = next;
      scheduleNext();
    }).catch(() => {
      if (outgoing && outgoing.parentNode) outgoing.parentNode.removeChild(outgoing);
      current = next;
      scheduleNext();
    });
  }

  // Expose stopper
  rotorRegistry.set(container, {
    stop: () => {
      cancelled = true;
      if (timerId) { clearTimeout(timerId); timerId = null; }
      // No need to cancel animations explicitly; they’ll be GC’d with DOM removal
    }
  });

  // start the loop
  scheduleNext();
}

function setCount(roomEl, n){
  const em = roomEl.querySelector('.roomHeader .count em');
  if (em) em.textContent = String(n);
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

  startRotor(aEl.querySelector('.single-rotor'), items);
  startRotor(bEl.querySelector('.single-rotor'), items);
}

function renderFieldhouse(slots){
  const pager = document.getElementById('fieldhousePager');
  if (!pager) return;
  pager.innerHTML = '';

  const page = document.createElement('div');
  page.className = 'page is-active';
  page.style.position = 'absolute';
  page.style.inset = '0';
  page.style.display = 'grid';
  page.style.gridTemplateColumns = 'repeat(3,1fr)';
  page.style.gridTemplateRows = '1fr 1fr';
  page.style.gap = '12px';

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
    list.style.display = 'flex';
    list.style.flexDirection = 'column';
    list.style.gap = '10px';
    list.style.height = '100%';
    list.style.minHeight = '0';
    list.style.overflow = 'hidden';

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

    // refresh every minute to drop ended items (rotors are rebuilt safely)
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
