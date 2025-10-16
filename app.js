// app.js  —  Grid-only board with A/B merge, dedupe, past-event pruning, and clock

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
  console.log("Loaded events.json", data ? Object : null);
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

// Key used to detect A/B duplicates of the same booking
function slotKey(s) {
  return `${s.startMin}-${s.endMin}-${(s.title||"").trim().toLowerCase()}-${(s.subtitle||"").trim().toLowerCase()}`;
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

  // Group by court, then split A/B vs BOTH
  // structure: { [courtNum]: { A:[], B:[], both:[] } }
  const grouped = {};
  for (const s of activeSlots) {
    const info = parseRoomId(s.roomId);
    if (!info) continue;
    const { court, side } = info;
    grouped[court] ||= { A: [], B: [], both: [] };
    // stash base data (clone minimal fields)
    grouped[court][side].push({
      startMin: s.startMin,
      endMin: s.endMin,
      title: s.title || "",
      subtitle: s.subtitle || ""
    });
  }

  // Promote duplicates that appear in both A and B into 'both'
  for (const court of Object.keys(grouped)) {
    const C = grouped[court];
    const seenA = new Map();
    C.A.forEach(item => {
      seenA.set(slotKey(item), item);
    });

    const bothKeys = new Set();
    const leftoversB = [];
    for (const item of C.B) {
      const k = slotKey(item);
      if (seenA.has(k)) {
        bothKeys.add(k);
      } else {
        leftoversB.push(item);
      }
    }

    // Build 'both' from those keys; remove from A
    const leftoversA = [];
    for (const item of C.A) {
      const k = slotKey(item);
      if (bothKeys.has(k)) {
        C.both.push(item); // one copy is enough
      } else {
        leftoversA.push(item);
      }
    }

    C.A = leftoversA;
    C.B = leftoversB;
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
    // Render once and also refresh the board every minute
    const draw = () => renderBoard(data);
    draw();
    setInterval(draw, 60 * 1000);
  } catch (err) {
    console.error(err);
  }
}

document.addEventListener("DOMContentLoaded", init);
