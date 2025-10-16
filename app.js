// app.js  —  Grid-only board with A/B merge, strong dedupe, past-event pruning, and clock

const WIFI_NAME = "RAEC Public";
const WIFI_PASS = "Publ!c00"; // per your note

// Helper: minutes since midnight local
function nowMin() {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

// Helper: format today's date & a live clock
function updateClock() {
  const d = new Date();
  const dateStr = d.toLocaleDateString(undefined, {
    weekday: "long", month: "long", day: "numeric", year: "numeric"
  });
  const timeStr = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const dateEl = document.getElementById("headerDate");
  const clockEl = document.getElementById("headerClock");
  if (dateEl) dateEl.textContent = dateStr;
  if (clockEl) clockEl.textContent = timeStr;
}

// Clean duplicate trailing segments like "Extreme Volleyball, Extreme Volleyball"
function cleanRepeatedCommaSegments(text = "") {
  const parts = text.split(",").map(p => p.trim()).filter(Boolean);
  const seen = new Set();
  const out = [];
  for (const p of parts) {
    const k = p.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      out.push(p);
    }
  }
  return out.join(", ");
}

async function loadData() {
  const url = `./events.json?ts=${Date.now()}`;
  const resp = await fetch(url, { cache: "no-store" });
  if (!resp.ok) throw new Error(`Failed to fetch events.json: ${resp.status}`);
  const data = await resp.json();
  console.log("Loaded events.json", Object.keys(data || {}).length ? Object : null);
  return data;
}

// Map "10A" -> { court: 10, side: "A" }
function parseRoomId(roomId) {
  const m = String(roomId).match(/^(\d+)([AB])$/i);
  if (!m) return null;
  return { court: parseInt(m[1], 10), side: m[2].toUpperCase() };
}

// Build court columns: South (1–2), Fieldhouse (3–8), North (9–10)
const SOUTH = [1, 2];
const FIELD = [3, 4, 5, 6, 7, 8];
const NORTH = [9, 10];

// Key used to detect identical bookings
function slotKey(s) {
  return `${s.startMin}-${s.endMin}-${(s.title||"").trim().toLowerCase()}-${(s.subtitle||"").trim().toLowerCase()}`;
}

// Deduplicate a list of slots by slotKey
function dedupeSlots(list = []) {
  const seen = new Set();
  const out = [];
  for (const s of list) {
    const k = slotKey(s);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(s);
    }
  }
  return out;
}

function renderBoard(data) {
  const now = nowMin();

  // Filter out past events
  const activeSlots = (data.slots || []).filter(s => s.endMin > now);

  // Normalize titles (remove repeated trailing segments)
  for (const s of activeSlots) {
    s.title = cleanRepeatedCommaSegments(s.title || "");
    s.subtitle = cleanRepeatedCommaSegments(s.subtitle || "");
  }

  // Group by court, separate A/B; we’ll promote true duplicates to BOTH
  // structure: { [courtNum]: { A:[], B:[], both:[] } }
  const grouped = {};
  for (const s of activeSlots) {
    const info = parseRoomId(s.roomId);
    if (!info) continue;
    const { court, side } = info;
    grouped[court] ||= { A: [], B: [], both: [] };
    grouped[court][side].push({
      startMin: s.startMin,
      endMin: s.endMin,
      title: s.title || "",
      subtitle: s.subtitle || ""
    });
  }

  // For each court: strong dedupe and promotion logic
  for (const court of Object.keys(grouped)) {
    const C = grouped[court];

    // First, dedupe raw A/B lists (handles feed duplicates)
    C.A = dedupeSlots(C.A);
    C.B = dedupeSlots(C.B);

    // Build sets of keys for quick intersection
    const keysA = new Set(C.A.map(slotKey));
    const keysB = new Set(C.B.map(slotKey));

    // Intersection keys = appear on both A and B -> promote to BOTH (only once)
    const bothKeys = new Set([...keysA].filter(k => keysB.has(k)));

    // Build BOTH from A (one copy), then remove those from A & B
    C.both = C.A.filter(item => bothKeys.has(slotKey(item)));
    C.A = C.A.filter(item => !bothKeys.has(slotKey(item)));
    C.B = C.B.filter(item => !bothKeys.has(slotKey(item)));

    // Final safety: dedupe again (covers rare edge cases)
    C.both = dedupeSlots(C.both);
    C.A = dedupeSlots(C.A);
    C.B = dedupeSlots(C.B);
  }

  // Render into three columns
  const colSouth = document.getElementById("col-south");
  const colField = document.getElementById("col-field");
  const colNorth = document.getElementById("col-north");
  if (!colSouth || !colField || !colNorth) return;

  colSouth.innerHTML = SOUTH.map(n => courtHtml(n, grouped[n] || { A:[], B:[], both:[] })).join("");
  colField.innerHTML = FIELD.map(n => courtHtml(n, grouped[n] || { A:[], B:[], both:[] })).join("");
  colNorth.innerHTML = NORTH.map(n => courtHtml(n, grouped[n] || { A:[], B:[], both:[] })).join("");
}

function courtHtml(num, G) {
  const total = (G.both?.length || 0) + (G.A?.length || 0) + (G.B?.length || 0);
  const has = total > 0;
  const status = has ? `${total} event${total>1?'s':''}` : "";

  let body = "";

  // Full-court bookings
  if (G.both && G.both.length) {
    body += G.both.map(pillHtml).join("");
  }

  // Split court lanes only when needed
  if ((G.A && G.A.length) || (G.B && G.B.length)) {
    if (G.A && G.A.length) {
      body += `<div class="laneLabel">Side A</div>`;
      body += G.A.map(pillHtml).join("");
    }
    if (G.B && G.B.length) {
      body += `<div class="laneLabel">Side B</div>`;
      body += G.B.map(pillHtml).join("");
    }
  }

  // Truly blank if no events
  if (!has) {
    return `
      <div class="cell is-empty">
        <div class="title">
          <div class="court">${num}</div>
          <div class="status"></div>
        </div>
      </div>
    `;
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

function toTime(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function pillHtml(ev) {
  const time = `${toTime(ev.startMin)}–${toTime(ev.endMin)}`;
  const who = (ev.title || "").trim();
  const what = (ev.subtitle || "").trim();
  const whatSpan = what ? `<span class="what">${what}</span>` : "";
  return `
    <div class="pill">
      <span class="who">${who}</span>
      ${whatSpan}
      <span class="time">${time}</span>
    </div>
  `;
}

// Boot
async function init() {
  try {
    updateClock();
    setInterval(updateClock, 1000 * 30); // tick every 30s

    const data = await loadData();
    const draw = () => renderBoard(data);

    draw();                    // initial paint
    setInterval(draw, 60 * 1000); // refresh every minute (removes finished events)
  } catch (err) {
    console.error(err);
  }
}

document.addEventListener("DOMContentLoaded", init);
