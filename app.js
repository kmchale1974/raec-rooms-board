// Dark board renderer for events.json produced by transform.mjs
// - Hides past events (endMin < now)
// - Blank cells when no events (no placeholders)
// - Rooms ordered 1A..10B
// - Time grid across building hours
// - Date centered + live clock

const ROOM_ORDER = ["1A","1B","2A","2B","3","4","5","6","7","8","9A","9B","10A","10B"];

// Some rooms are single courts (3..8) — display label tweaks
const DISPLAY_NAME = {
  "1A":"Court 1A","1B":"Court 1B",
  "2A":"Court 2A","2B":"Court 2B",
  "3":"Court 3","4":"Court 4","5":"Court 5","6":"Court 6",
  "7":"Court 7","8":"Court 8",
  "9A":"Court 9A","9B":"Court 9B",
  "10A":"Court 10A","10B":"Court 10B",
};

const qs = (id) => document.getElementById(id);

function pad2(n){ return n<10 ? `0${n}` : `${n}`; }
function formatClock(d){
  let h = d.getHours();
  const m = d.getMinutes();
  const ap = h >= 12 ? "PM" : "AM";
  h = h % 12; if (h === 0) h = 12;
  return `${h}:${pad2(m)} ${ap}`;
}
function formatDate(d){
  const opt = { weekday:"long", month:"long", day:"numeric", year:"numeric"};
  return d.toLocaleDateString(undefined, opt);
}
function minutesNow(){
  const d = new Date();
  return d.getHours()*60 + d.getMinutes();
}

function px(n){ return `${n}px`; }

async function fetchJson(url){
  // Cache-bust so Yodeck/GH Pages always pull fresh
  const res = await fetch(`${url}?v=${Date.now()}`, { cache: "no-store" });
  if(!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  return res.json();
}

function renderHeader(){
  const d = new Date();
  qs("date").textContent = formatDate(d);
  qs("clock").textContent = formatClock(d);
}

function startClock(){
  renderHeader();
  setInterval(renderHeader, 1000);
}

function buildScale(dayStartMin, dayEndMin){
  const span = dayEndMin - dayStartMin;
  const x = (min) => ( (min - dayStartMin) / span ); // 0..1
  return { span, x };
}

function renderRuler(timesEl, dayStartMin, dayEndMin){
  timesEl.innerHTML = "";
  const { x } = buildScale(dayStartMin, dayEndMin);

  // Create container width using a wide inner to allow absolute ticks
  const inner = document.createElement("div");
  inner.style.position = "relative";
  inner.style.width = "100%";
  inner.style.height = "100%";
  timesEl.appendChild(inner);

  // Ticks at every hour
  const startHour = Math.ceil(dayStartMin/60);
  const endHour = Math.floor(dayEndMin/60);
  for(let h = startHour; h <= endHour; h++){
    const min = h*60;
    const tick = document.createElement("div");
    tick.className = "tick";
    tick.style.left = `calc(${x(min)*100}% )`;
    inner.appendChild(tick);

    const label = document.createElement("div");
    label.className = "tick-label";
    label.style.left = `calc(${x(min)*100}% )`;
    const hr12 = ((h % 12) === 0) ? 12 : (h % 12);
    const ap = h >= 12 ? "PM" : "AM";
    label.textContent = `${hr12}:00 ${ap}`;
    inner.appendChild(label);
  }

  // Vertical "now" line if within range
  const nowMin = minutesNow();
  if(nowMin >= dayStartMin && nowMin <= dayEndMin){
    const now = document.createElement("div");
    now.className = "now-line";
    now.style.left = `calc(${x(nowMin)*100}% )`;
    inner.appendChild(now);
  }
}

function renderGridBackdrop(timelineEl, dayStartMin, dayEndMin, rowCount){
  timelineEl.innerHTML = "";
  const { x } = buildScale(dayStartMin, dayEndMin);

  // Column lines each hour
  const startHour = Math.ceil(dayStartMin/60);
  const endHour = Math.floor(dayEndMin/60);

  for(let h = startHour; h <= endHour; h++){
    const min = h*60;
    const col = document.createElement("div");
    col.className = "col-line";
    col.style.left = `calc(${x(min)*100}% )`;
    timelineEl.appendChild(col);
  }

  // Create rows container
  ROOM_ORDER.forEach(() => {
    const row = document.createElement("div");
    row.className = "time-row";
    timelineEl.appendChild(row);
  });
}

function renderRoomLabels(roomsEl){
  roomsEl.innerHTML = "";
  ROOM_ORDER.forEach(roomId => {
    const r = document.createElement("div");
    r.className = "row";
    const name = document.createElement("div");
    name.className = "room-name";
    name.textContent = DISPLAY_NAME[roomId] || roomId;
    r.appendChild(name);
    roomsEl.appendChild(r);
  });
}

function renderEvents(timelineEl, data){
  const { rooms, dayStartMin, dayEndMin } = data;
  const { x } = buildScale(dayStartMin, dayEndMin);
  const rows = Array.from(timelineEl.querySelectorAll(".time-row"));

  const nowMin = minutesNow();

  ROOM_ORDER.forEach((roomId, idx) => {
    const rowEl = rows[idx];
    const list = rooms[roomId] || [];
    // Render only events with end > now (hide past)
    list
      .filter(ev => ev.endMin > nowMin)
      .forEach(ev => {
        const evEl = document.createElement("div");
        evEl.className = "event";

        // Clamp into range
        const start = Math.max(ev.startMin, dayStartMin);
        const end   = Math.min(ev.endMin,   dayEndMin);
        const left  = x(start)*100;
        const width = Math.max(0, (x(end) - x(start))*100);

        evEl.style.left = `${left}%`;
        evEl.style.width = `${width}%`;
        evEl.textContent = ev.label || "Reserved";

        rowEl.appendChild(evEl);
      });
  });
}

async function init(){
  // elements present?
  const timesEl = qs("rulerTimes");
  const roomsEl = qs("rooms");
  const timelineEl = qs("timeline");
  if(!timesEl || !roomsEl || !timelineEl){
    console.error("Required DOM nodes not found. Check element IDs in index.html.");
    return;
  }

  startClock();

  let data;
  try{
    data = await fetchJson("./events.json");
  }catch(err){
    console.error(err);
    // Show empty board gracefully
    data = {
      dayStartMin: 6*60,
      dayEndMin: 23*60,
      rooms: {},
      slots: []
    };
  }

  const { dayStartMin, dayEndMin } = data;

  // Build static chrome
  renderRuler(timesEl, dayStartMin, dayEndMin);
  renderRoomLabels(roomsEl);
  renderGridBackdrop(timelineEl, dayStartMin, dayEndMin, ROOM_ORDER.length);
  renderEvents(timelineEl, data);

  // Small timer to keep "now" line fresh & drop ended events
  setInterval(async () => {
    // Re-render ruler now-line only
    renderRuler(timesEl, dayStartMin, dayEndMin);

    // Re-render events from the same data but with updated "now"
    Array.from(timelineEl.querySelectorAll(".time-row")).forEach(el => el.innerHTML = "");
    renderEvents(timelineEl, data);
  }, 60 * 1000);
}

init();
