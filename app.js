// app.js (ES module). Renders a dark time-grid for 1A..10B.
// - No placeholders. If no events, grid stays blank (but with time/lines).
// - Past events hidden. "Now" line shown when within building hours.
// - Rooms ordered 1A (top-left) -> 10B (bottom-right).
// - Assumes events.json in the same directory. Each event { roomCodes:[], start,end, title, sub? }.
//   If your transform outputs facility strings instead, we also map common AC names to room codes.

const STAGE_WIDTH = 1920;  // visual reference only
const BUILDING_OPEN_HOUR = 6;  // 6:00
const BUILDING_CLOSE_HOUR = 22; // 22:00 (10pm). Adjust if needed.

const ROOMS = [
  ["1A","1B"],
  ["2A","2B"],
  ["3A","3B"],
  ["4A","4B"],
  ["5A","5B"],
  ["6A","6B"],
  ["7A","7B"],
  ["8A","8B"],
  ["9A","9B"],
  ["10A","10B"],
];

// Common facility → room code(s) helper (covers both half/whole court/turf strings)
function facilityToRooms(fac) {
  if (!fac) return [];
  const s = fac.toUpperCase();

  // Courts like "AC Gym - Half Court 9A" or "AC Gym - Court 9-AB"
  const half = s.match(/COURT\s*([1-9]|10)\s*([AB])/);
  if (half) {
    const n = half[1];
    const side = half[2];
    return [`${n}${side}`];
  }
  const both = s.match(/COURT\s*([1-9]|10)[-\s]*AB/);
  if (both) {
    const n = both[1];
    return [`${n}A`, `${n}B`];
  }

  // Fieldhouse turf variants — map fieldhouse to 9/10
  if (s.includes("FIELDHOUSE")) {
    if (s.includes("HALF") && s.includes("NORTH")) return ["10A"];
    if (s.includes("HALF") && s.includes("SOUTH")) return ["10B"];
    // Full turf covers both
    return ["10A","10B"];
  }

  // Gym north/south hints (if your data labels that way)
  if (s.includes("NORTH GYM")) {
    // Typically courts 1–5
    if (s.includes("COURT")) {
      const m = s.match(/COURT\s*([1-5])(?:[-\s]*AB)?([AB])?/);
      if (m) return m[2] ? [`${m[1]}${m[2]}`] : [`${m[1]}A`, `${m[1]}B`];
    }
  }
  if (s.includes("SOUTH GYM")) {
    // Typically courts 6–10
    const m = s.match(/COURT\s*([6-9]|10)(?:[-\s]*AB)?([AB])?/);
    if (m) return m[2] ? [`${m[1]}${m[2]}`] : [`${m[1]}A`, `${m[1]}B`];
  }

  return [];
}

// Parse time strings like "7:30pm", "9:00 am", "21:15", return Date on today
function parseTimeToday(str) {
  if (!str) return null;
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth(), d = now.getDate();

  let s = String(str).trim().toLowerCase();
  // Normalize space before am/pm, remove double spaces
  s = s.replace(/\s*(am|pm)$/i, " $1").replace(/\s+/g, " ");

  // 12h format
  let m12 = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i);
  if (m12) {
    let hh = parseInt(m12[1],10);
    const mm = parseInt(m12[2] ?? "0",10);
    const ampm = m12[3].toLowerCase();
    if (ampm === "pm" && hh < 12) hh += 12;
    if (ampm === "am" && hh === 12) hh = 0;
    return new Date(y,m,d,hh,mm,0,0);
  }
  // 24h format
  let m24 = s.match(/^(\d{1,2})(?::(\d{2}))$/);
  if (m24) {
    const hh = parseInt(m24[1],10);
    const mm = parseInt(m24[2],10);
    return new Date(y,m,d,hh,mm,0,0);
  }
  // Fallback: number hour only (e.g., "9pm")
  let m12h = s.match(/^(\d{1,2})\s*(am|pm)$/i);
  if (m12h) {
    let hh = parseInt(m12h[1],10);
    const ampm = m12h[2].toLowerCase();
    if (ampm === "pm" && hh < 12) hh += 12;
    if (ampm === "am" && hh === 12) hh = 0;
    return new Date(y,m,d,hh,0,0,0);
  }
  return null;
}

// Convert reservedtime like "7:30pm - 9:00pm" into {start,end}
function parseReservedTime(rt) {
  if (!rt) return null;
  const parts = String(rt).split("-").map(s => s.trim().replace(/\s{2,}/g," "));
  if (parts.length !== 2) return null;
  const start = parseTimeToday(parts[0]);
  const end = parseTimeToday(parts[1]);
  if (!start || !end) return null;
  return { start, end };
}

function fmtClock(d){
  return d.toLocaleTimeString([], {hour:"2-digit", minute:"2-digit"});
}
function fmtDate(d){
  return d.toLocaleDateString([], {weekday:"long", month:"long", day:"numeric"});
}

// DOM helpers
const elDate = document.getElementById("headerDate");
const elClock = document.getElementById("headerClock");
const elRooms = document.querySelector(".rooms");
const elHoursRow = document.getElementById("hoursRow");
const elBackdrop = document.getElementById("gridBackdrop");
const elLanes = document.getElementById("lanes");
const elNow = document.getElementById("nowLine");
const elTimelineWrap = document.querySelector(".timeline-wrap");

// Render header date + live clock
function renderHeader(){
  const now = new Date();
  elDate.textContent = fmtDate(now);
  elClock.textContent = fmtClock(now);
}
setInterval(renderHeader, 1000);
renderHeader();

// Build room labels (10 rows × 2 cols)
function renderRoomLabels(){
  // Clear old (keep header div)
  const kids = [...elRooms.children].slice(1);
  kids.forEach(n => n.remove());

  for (const [a,b] of ROOMS){
    const row = document.createElement("div");
    row.className = "room";
    const ca = document.createElement("div"); ca.textContent = a;
    const cb = document.createElement("div"); cb.textContent = b;
    row.appendChild(ca); row.appendChild(cb);
    elRooms.appendChild(row);
  }
}

// Build hour header and grid columns based on building hours
function renderGridBackdrop(){
  const cols = [];
  for (let h = BUILDING_OPEN_HOUR; h <= BUILDING_CLOSE_HOUR; h++){
    cols.push("1fr");
  }
  // set CSS var for backdrop columns
  const styleCols = `repeat(${cols.length}, 1fr)`;
  elBackdrop.style.setProperty("--cols", styleCols);
  elHoursRow.style.gridTemplateColumns = styleCols;

  // Hour labels
  elHoursRow.innerHTML = "";
  for (let h = BUILDING_OPEN_HOUR; h <= BUILDING_CLOSE_HOUR; h++){
    const label = new Date(); label.setHours(h,0,0,0);
    const d = document.createElement("div");
    d.textContent = label.toLocaleTimeString([], {hour:"numeric"});
    elHoursRow.appendChild(d);
  }

  // Backdrop cells (10 rows × hour columns)
  elBackdrop.innerHTML = "";
  elBackdrop.style.gridTemplateColumns = styleCols;
  for (let r = 0; r < 10; r++){
    for (let c = 0; c < cols.length; c++){
      const cell = document.createElement("div");
      cell.className = "cell";
      elBackdrop.appendChild(cell);
    }
  }
}

// Convert a Date → x-position (%) within building-day window
function xFromDate(d) {
  const start = new Date(d); start.setHours(BUILDING_OPEN_HOUR,0,0,0);
  const end = new Date(d); end.setHours(BUILDING_CLOSE_HOUR,0,0,0);
  const dayStart = start.getTime();
  const dayEnd = end.getTime();
  const t = d.getTime();
  if (t <= dayStart) return 0;
  if (t >= dayEnd) return 100;
  return ((t - dayStart) / (dayEnd - dayStart)) * 100;
}

// Render the red "now" line when within building hours
function renderNowLine(){
  const now = new Date();
  const h = now.getHours() + now.getMinutes()/60;
  if (h < BUILDING_OPEN_HOUR || h > BUILDING_CLOSE_HOUR) {
    elNow.hidden = true;
    return;
  }
  elNow.hidden = false;
  const x = xFromDate(now);
  elNow.style.left = `${x}%`;
}

// Map event into per-room chips (filter past)
function toChips(ev) {
  const chips = [];
  if (!ev.start || !ev.end) return chips;

  const now = new Date();
  if (ev.end <= now) return chips; // hide past events

  const start = ev.start < now ? now : ev.start; // trim if already started
  const left = xFromDate(start);
  const right = xFromDate(ev.end);
  const width = Math.max(0, right - left);

  const title = ev.title || (ev.reservee ? ev.reservee : "");
  const sub = ev.sub || ev.reservationpurpose || "";

  for (const rc of ev.roomCodes || []) {
    const pos = roomIndex(rc);
    if (!pos) continue;
    const { row, col } = pos;

    chips.push({
      row,
      col,
      leftPct: left,
      widthPct: width,
      title,
      sub,
      time: `${fmtClock(ev.start)}–${fmtClock(ev.end)}`
    });
  }
  return chips;
}

// Find room position (row 0-9, col 0=A / 1=B)
function roomIndex(code) {
  if (!code) return null;
  const up = code.toUpperCase();
  const m = up.match(/^(\d{1,2})([AB])$/);
  if (!m) return null;
  const n = parseInt(m[1],10);
  const side = m[2] === "A" ? 0 : 1;
  if (n < 1 || n > 10) return null;
  return { row: n - 1, col: side };
}

// Render event chips
function renderChips(events) {
  elLanes.innerHTML = "";
  // Build lane rows
  for (let r = 0; r < 10; r++){
    const lane = document.createElement("div");
    lane.style.position = "relative";
    elLanes.appendChild(lane);
  }
  // Place chips
  for (const ev of events) {
    for (const chip of toChips(ev)) {
      const lane = elLanes.children[chip.row];
      const el = document.createElement("div");
      el.className = "chip";
      // Horizontal positioning
      el.style.left = `${chip.leftPct}%`;
      el.style.width = `${chip.widthPct}%`;
      // Vertical: split A/B within row (stack top/bottom 50%)
      el.style.top = chip.col === 0 ? "6%" : "52%";
      el.style.height = "42%";

      el.innerHTML = `<strong>${chip.title || "Reserved"}</strong><small>${chip.time}${chip.sub ? " • " + chip.sub : ""}</small>`;
      lane.appendChild(el);
    }
  }
}

// Try to normalize raw rows from transform outputs
function normalizeEvents(raw) {
  // Accept two shapes:
  // 1) Already normalized: {roomCodes:[], start,end,title,sub}
  // 2) CSV-like rows: { facility, reservedtime, reservee, reservationpurpose }
  const out = [];
  for (const r of raw || []) {
    if (r.start && r.end && r.roomCodes) {
      out.push(r);
      continue;
    }
    const rooms = facilityToRooms(r.facility || r.room || r.location);
    const rt = parseReservedTime(r.reservedtime || r.time);
    if (!rooms.length || !rt) continue;
    out.push({
      roomCodes: rooms,
      start: rt.start,
      end: rt.end,
      title: r.reservee || r.title || "",
      sub: r.reservationpurpose || r.sub || ""
    });
  }
  return out;
}

async function loadEvents() {
  try {
    const res = await fetch("./events.json", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    // If the JSON is a keyed object, try events property; otherwise assume array
    return Array.isArray(json) ? json : (json.events || json.rows || []);
  } catch (err) {
    console.error("Failed to load events.json:", err);
    return [];
  }
}

function syncLayout() {
  renderHeader();
  renderGridBackdrop();
  renderNowLine();
}

async function init(){
  renderRoomLabels();
  syncLayout();

  const raw = await loadEvents();
  const events = normalizeEvents(raw);
  renderChips(events);

  // Update now-line every 30s
  setInterval(renderNowLine, 30000);
  // On resize (just in case)
  window.addEventListener("resize", syncLayout);
}

init();
