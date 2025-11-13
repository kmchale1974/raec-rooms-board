// app.js — "NOW + NEXT" version (no per-room rotors)

const STAGE_WIDTH = 1920;
const STAGE_HEIGHT = 1080;

// ---------- Utilities ----------

function pad(n) {
  return (n < 10 ? "0" : "") + n;
}

function minutesNowLocal() {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

// transform.mjs gives startMin/endMin in minutes-from-midnight
function formatRange(startMin, endMin) {
  const fmt = (m) => {
    const h24 = Math.floor(m / 60);
    const h12 = ((h24 + 11) % 12) + 1;
    const mm = m % 60;
    const ampm = h24 >= 12 ? "pm" : "am";
    return `${h12}:${pad(mm)}${ampm}`;
  };
  return `${fmt(startMin)}–${fmt(endMin)}`;
}

// All slots are for "today" already
function isTodaySlot(_slot) {
  return true;
}

function isPickleball(slot) {
  const title = (slot.title || "").toLowerCase();
  const sub = (slot.subtitle || "").toLowerCase();
  return title.includes("pickleball") || sub.includes("pickleball");
}

// ---------- DOM helpers ----------

function qs(sel, root = document) {
  return root.querySelector(sel);
}

function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
}

// ---------- Scale 1920×1080 canvas to viewport ----------

(function fitStageSetup() {
  function fit() {
    const vp = qs(".viewport");
    const stage = qs(".stage");
    if (!vp || !stage) return;
    const sx = vp.clientWidth / STAGE_WIDTH;
    const sy = vp.clientHeight / STAGE_HEIGHT;
    const s = Math.min(sx, sy);
    stage.style.transform = `scale(${s})`;
    stage.style.transformOrigin = "top left";
    vp.style.minHeight = STAGE_HEIGHT * s + "px";
  }

  window.addEventListener("resize", fit);
  window.addEventListener("orientationchange", fit);
  document.addEventListener("DOMContentLoaded", fit);
})();

// ---------- Header clock/date ----------

function startHeaderClock() {
  const dEl = qs("#headerDate");
  const cEl = qs("#headerClock");

  function tick() {
    const d = new Date();
    const dateFmt = d.toLocaleDateString(undefined, {
      weekday: "long",
      month: "long",
      day: "numeric",
    });
    const timeFmt = d.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    });
    if (dEl) dEl.textContent = dateFmt;
    if (cEl) cEl.textContent = timeFmt;
  }

  tick();
  setInterval(tick, 1000 * 30);
}

// ---------- Room sets / season ----------

// South/North fixed rooms (in your HTML)
const FIXED_ROOMS = ["1A", "1B", "2A", "2B", "9A", "9B", "10A", "10B"];

// Turf rooms as emitted by events.json (group: "fieldhouse")
const TURF_ROOMS = [
  { id: "Quarter Turf NA", domId: "NA", label: "Turf NA" },
  { id: "Quarter Turf NB", domId: "NB", label: "Turf NB" },
  { id: "Quarter Turf SA", domId: "SA", label: "Turf SA" },
  { id: "Quarter Turf SB", domId: "SB", label: "Turf SB" },
];

// Courts (basketball) rooms in fieldhouse
const COURT_ROOMS = ["3", "4", "5", "6", "7", "8"];

/**
 * Decide Turf vs Courts using events.json.season first,
 * then fall back to heuristics if needed.
 */
function getFieldhouseMode(data, slots) {
  if (data && data.season === "turf") return "turf";
  if (data && (data.season === "courts" || data.season === "basketball"))
    return "courts";

  const ids = new Set(slots.map((s) => s.roomId));

  const hasTurf = TURF_ROOMS.some((r) => ids.has(r.id));
  if (hasTurf) return "turf";

  const hasCourts = COURT_ROOMS.some((id) => ids.has(id));
  if (hasCourts) return "courts";

  return "courts";
}

/**
 * Build the middle (Fieldhouse) container depending on mode.
 * - Turf: 2×2 quarters
 * - Courts: 3×2 courts 3..8
 *
 * Creates .roomHeader + .events for JS to fill.
 */
function buildFieldhouseContainer(mode) {
  const holder = qs("#fieldhousePager");
  if (!holder) return;

  const isTurf = mode === "turf";

  holder.classList.remove("turf-2x2", "courts-3x2");
  holder.classList.add(isTurf ? "turf-2x2" : "courts-3x2");
  holder.innerHTML = "";

  if (isTurf) {
    for (const room of TURF_ROOMS) {
      const div = el("div", "room");
      div.id = `room-${room.domId}`;
      div.innerHTML = `
        <div class="roomHeader">
          <div class="id">${room.label}</div>
          <div class="count"><em>0</em> reservations</div>
        </div>
        <div class="events"></div>
      `;
      holder.appendChild(div);
    }
  } else {
    for (const id of COURT_ROOMS) {
      const room = el("div", "room");
      room.id = `room-${id}`;
      room.innerHTML = `
        <div class="roomHeader">
          <div class="id">${id}</div>
          <div class="count"><em>0</em> reservations</div>
        </div>
        <div class="events"></div>
      `;
      holder.appendChild(room);
    }
  }
}

// ---------- Data prep ----------

function groupByRoom(slots) {
  const map = new Map();
  for (const s of slots) {
    if (!map.has(s.roomId)) map.set(s.roomId, []);
    map.get(s.roomId).push(s);
  }
  for (const [_, arr] of map) {
    arr.sort(
      (a, b) => a.startMin - b.startMin || a.title.localeCompare(b.title)
    );
  }
  return map;
}

/**
 * Filter slots for display based on current time:
 * - only today
 * - hide past events (endMin <= now)
 * - hide Open Pickleball after 12:30pm
 */
function filterForDisplay(slots) {
  const nowMin = minutesNowLocal();

  let filtered = slots.filter(
    (s) => isTodaySlot(s) && s.endMin > nowMin // keep current / upcoming
  );

  const cutoff = 12 * 60 + 30;
  if (nowMin > cutoff) {
    filtered = filtered.filter((s) => !isPickleball(s));
  }

  return filtered;
}

/**
 * For a room’s sorted slots, find:
 * - current event: startMin <= now < endMin (latest matching)
 * - next event: earliest startMin > now
 */
function getCurrentAndNext(slots, nowMin) {
  let current = null;
  let next = null;

  for (const s of slots) {
    if (s.startMin <= nowMin && s.endMin > nowMin) {
      if (!current || s.startMin > current.startMin) current = s;
    } else if (s.startMin > nowMin) {
      if (!next || s.startMin < next.startMin) next = s;
    }
  }

  return { current, next };
}

// ---------- Rendering: NOW + NEXT per room ----------

function renderRoomEvents(container, current, next) {
  container.innerHTML = "";

  const makeChip = (kind, slot) => {
    const chip = el("div", "event");
    chip.classList.add(kind); // "current" or "next"

    if (!slot) {
      if (kind === "current") {
        chip.innerHTML = `
          <div class="who">Open</div>
          <div class="when"></div>
        `;
      } else {
        chip.innerHTML = `
          <div class="who">No upcoming reservation</div>
          <div class="when"></div>
        `;
      }
      return chip;
    }

    const title = slot.title || "Reserved";
    const subtitle = slot.subtitle || "";
    const when = formatRange(slot.startMin, slot.endMin);

    chip.innerHTML = `
      <div class="who">${title}</div>
      ${
        subtitle
          ? `<div class="what">${subtitle}</div>`
          : ""
      }
      <div class="when">${when}</div>
    `;
    return chip;
  };

  container.appendChild(makeChip("current", current));
  container.appendChild(makeChip("next", next));
}

/**
 * Update a single room card:
 * - set reservation count
 * - render NOW + NEXT chips
 */
function updateRoomCard(roomDomId, roomSlots, nowMin) {
  const card = document.getElementById(`room-${roomDomId}`);
  if (!card) return;

  const countEl = qs(".roomHeader .count em", card);
  const eventsEl = qs(".events", card);

  if (countEl) countEl.textContent = roomSlots.length;
  if (!eventsEl) return;

  const { current, next } = getCurrentAndNext(roomSlots, nowMin);
  renderRoomEvents(eventsEl, current, next);
}

// ---------- Global state + main loop ----------

let ALL_SLOTS = [];
let FIELDHOUSE_MODE = "courts"; // "turf" or "courts"

function refreshBoard() {
  if (!ALL_SLOTS.length) return;

  const displaySlots = filterForDisplay(ALL_SLOTS);
  const grouped = groupByRoom(displaySlots);
  const nowMin = minutesNowLocal();

  // South/North fixed rooms (exist in HTML)
  for (const id of FIXED_ROOMS) {
    const roomSlots = grouped.get(id) || [];
    updateRoomCard(id, roomSlots, nowMin);
  }

  // Fieldhouse rooms depending on mode
  if (FIELDHOUSE_MODE === "turf") {
    for (const room of TURF_ROOMS) {
      const roomSlots = grouped.get(room.id) || [];
      updateRoomCard(room.domId, roomSlots, nowMin);
    }
  } else {
    for (const id of COURT_ROOMS) {
      const roomSlots = grouped.get(id) || [];
      updateRoomCard(id, roomSlots, nowMin);
    }
  }
}

// ---------- Boot ----------

async function boot() {
  startHeaderClock();

  const res = await fetch(`./events.json?cb=${Date.now()}`, {
    cache: "no-store",
  });
  const data = await res.json();

  ALL_SLOTS = Array.isArray(data?.slots) ? data.slots : [];

  const mode = getFieldhouseMode(data, ALL_SLOTS);
  FIELDHOUSE_MODE = mode;

  console.log("events.json loaded:", {
    season: data.season,
    mode: FIELDHOUSE_MODE,
    totalSlots: ALL_SLOTS.length,
  });

  // Build fieldhouse DOM once based on season
  buildFieldhouseContainer(FIELDHOUSE_MODE);

  // Initial render
  refreshBoard();

  // Recompute NOW/NEXT for every room once per minute
  setInterval(refreshBoard, 60_000);
}

boot().catch((err) => {
  console.error("app init failed:", err);
});
