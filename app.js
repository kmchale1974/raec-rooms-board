// app.js — One event per room, global 8s slide, CSV-driven season

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

// startMin/endMin are minutes-from-midnight from transform.mjs
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

// All slots are “today” for this board
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
  setInterval(tick, 30_000);
}

// ---------- Room sets / season ----------

// South/North fixed rooms (already in HTML)
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
          <div class="count">0 of 0 reservations</div>
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
          <div class="count">0 of 0 reservations</div>
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
  for (const [, arr] of map) {
    arr.sort(
      (a, b) => a.startMin - b.startMin || a.title.localeCompare(b.title)
    );
  }
  return map;
}

/**
 * Filter slots for display based on current time:
 *  - only today
 *  - hide past events (endMin <= now)
 *  - hide Open Pickleball after 12:30pm
 */
function filterForDisplay(slots) {
  const nowMin = minutesNowLocal();

  let filtered = slots.filter(
    (s) => isTodaySlot(s) && s.endMin > nowMin // current or future
  );

  const cutoff = 12 * 60 + 30;
  if (nowMin > cutoff) {
    filtered = filtered.filter((s) => !isPickleball(s));
  }

  return filtered;
}

// ---------- Rendering helpers ----------

// Build a single event chip for display
function buildEventChip(slot) {
  const chip = el("div", "event");
  const title = slot.title || "Reserved";
  const subtitle = slot.subtitle || "";
  const when = formatRange(slot.startMin, slot.endMin);

  chip.innerHTML = `
    <div class="who">${title}</div>
    ${subtitle ? `<div class="what">${subtitle}</div>` : ""}
    <div class="when">${when}</div>
  `;
  return chip;
}

// Smooth slide animation: old chip left, new chip in from right
function animateChipSwap(eventsEl, oldChip, newChip) {
  // Ensure container is ready
  eventsEl.style.position = eventsEl.style.position || "relative";
  newChip.style.position = "relative";

  if (!oldChip) {
    // First render: no animation
    eventsEl.innerHTML = "";
    newChip.style.opacity = "1";
    newChip.style.transform = "translateX(0)";
    eventsEl.appendChild(newChip);
    return newChip;
  }

  // Prepare new chip off-screen right
  newChip.style.opacity = "0";
  newChip.style.transform = "translateX(100%)";
  newChip.style.transition = "none";
  eventsEl.appendChild(newChip);

  // Trigger layout, then animate
  newChip.offsetWidth; // force reflow

  const duration = 600; // ms

  oldChip.style.transition = `transform ${duration}ms ease, opacity ${duration}ms ease`;
  newChip.style.transition = `transform ${duration}ms ease, opacity ${duration}ms ease`;

  oldChip.style.transform = "translateX(-100%)";
  oldChip.style.opacity = "0";

  newChip.style.transform = "translateX(0)";
  newChip.style.opacity = "1";

  oldChip.addEventListener(
    "transitionend",
    () => {
      if (oldChip.parentNode === eventsEl) {
        eventsEl.removeChild(oldChip);
      }
    },
    { once: true }
  );

  return newChip;
}

// ---------- Global state + synchronized rotor ----------

let ALL_SLOTS = [];
let FIELDHOUSE_MODE = "courts"; // "turf" or "courts"

// Rooms we rotate through, with JSON->DOM mapping
let ACTIVE_ROOMS = []; // { jsonId, domId }

const ROOM_STATE = new Map(); // roomDomId -> { chip: HTMLElement | null }

let GLOBAL_TICK = 0; // increments every 8s

function buildActiveRooms() {
  ACTIVE_ROOMS = [];
  // Fixed rooms: jsonId == domId
  for (const id of FIXED_ROOMS) {
    ACTIVE_ROOMS.push({ jsonId: id, domId: id });
  }

  if (FIELDHOUSE_MODE === "turf") {
    for (const room of TURF_ROOMS) {
      ACTIVE_ROOMS.push({ jsonId: room.id, domId: room.domId });
    }
  } else {
    for (const id of COURT_ROOMS) {
      ACTIVE_ROOMS.push({ jsonId: id, domId: id });
    }
  }
}

/**
 * One global tick every 8 seconds:
 * - recompute filtered slots
 * - for each room, pick which event index to show
 * - animate chip swap
 */
function globalRotorTick() {
  if (!ALL_SLOTS.length || !ACTIVE_ROOMS.length) return;

  const nowMin = minutesNowLocal();
  const displaySlots = filterForDisplay(ALL_SLOTS);
  const grouped = groupByRoom(displaySlots);

  for (const room of ACTIVE_ROOMS) {
    const jsonId = room.jsonId;
    const domId = room.domId;

    const card = document.getElementById(`room-${domId}`);
    if (!card) continue;

    const countEl = qs(".roomHeader .count", card);
    const eventsEl = qs(".events", card);
    if (!eventsEl || !countEl) continue;

    const slots = grouped.get(jsonId) || [];
    const total = slots.length;

    if (total === 0) {
      // No events: clear chip & label
      countEl.textContent = "0 of 0 reservations";
      eventsEl.innerHTML = "";
      ROOM_STATE.delete(domId);
      continue;
    }

    // Use the same GLOBAL_TICK for every room.
    // Each room shows slot at (tick % total), so if
    // the same event is at the same index in each room,
    // it appears at the same time across rooms.
    const index = GLOBAL_TICK % total;
    const slot = slots[index];

    const label = `${index + 1} of ${total} reservations`;
    countEl.textContent = label;

    const prevState = ROOM_STATE.get(domId) || { chip: null };
    const oldChip = prevState.chip;
    const newChip = buildEventChip(slot);

    const finalChip = animateChipSwap(eventsEl, oldChip, newChip);
    ROOM_STATE.set(domId, { chip: finalChip });
  }

  GLOBAL_TICK++;
}

// ---------- Events.json refresh ----------

async function refreshEventsJson() {
  try {
    const res = await fetch(`./events.json?cb=${Date.now()}`, {
      cache: "no-store",
    });
    const data = await res.json();
    ALL_SLOTS = Array.isArray(data?.slots) ? data.slots : [];

    // If season changes, we could rebuild mode/rooms,
    // but for now assume season is stable for the day.
    console.log("events.json refreshed:", {
      season: data.season,
      totalSlots: ALL_SLOTS.length,
    });
  } catch (err) {
    console.error("Failed to refresh events.json:", err);
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
  FIELDHOUSE_MODE = getFieldhouseMode(data, ALL_SLOTS);

  console.log("events.json loaded:", {
    season: data.season,
    mode: FIELDHOUSE_MODE,
    totalSlots: ALL_SLOTS.length,
  });

  // Build fieldhouse DOM once based on season
  buildFieldhouseContainer(FIELDHOUSE_MODE);

  // Build active room list (fixed + fieldhouse)
  buildActiveRooms();

  // Initial tick so the board isn't empty
  globalRotorTick();

  // Rotate globally every 8 seconds
  setInterval(globalRotorTick, 8000);

  // Refresh events.json every minute so new bookings appear
  setInterval(refreshEventsJson, 60_000);
}

boot().catch((err) => {
  console.error("app init failed:", err);
});
