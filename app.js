// app.js — Cluster time-block sync, one event per room, global 8s tick, no animation

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

// Turf rooms (JSON IDs) in desired 2×2 layout order:
// Top row: SA (top-left), NA (top-right)
// Bottom row: SB (bottom-left), NB (bottom-right)
const TURF_ROOMS = [
  { jsonId: "Quarter Turf SA", domId: "SA", label: "Turf SA" }, // top-left
  { jsonId: "Quarter Turf NA", domId: "NA", label: "Turf NA" }, // top-right
  { jsonId: "Quarter Turf SB", domId: "SB", label: "Turf SB" }, // bottom-left
  { jsonId: "Quarter Turf NB", domId: "NB", label: "Turf NB" }, // bottom-right
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

  const hasTurf = TURF_ROOMS.some((r) => ids.has(r.jsonId));
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
    // DOM order: SA, NA, SB, NB (for 2×2 layout)
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

// ---------- Global state ----------

let ALL_SLOTS = [];
let FIELDHOUSE_MODE = "courts"; // "turf" or "courts"
let GLOBAL_TICK = 0; // increments every 8s

// Build cluster definitions dynamically (because turf/courts is seasonal)
function getClusters() {
  const clusters = [];

  // Cluster 1: 1A,1B,2A,2B
  clusters.push({
    name: "cluster-front",
    rooms: [
      { jsonId: "1A", domId: "1A" },
      { jsonId: "1B", domId: "1B" },
      { jsonId: "2A", domId: "2A" },
      { jsonId: "2B", domId: "2B" },
    ],
  });

  // Cluster 2: Turf (SA/SB/NA/NB) or Courts 3–8 in fieldhouse
  if (FIELDHOUSE_MODE === "turf") {
    clusters.push({
      name: "cluster-turf",
      rooms: TURF_ROOMS.map((r) => ({
        jsonId: r.jsonId,
        domId: r.domId,
      })),
    });
  } else {
    clusters.push({
      name: "cluster-courts",
      rooms: COURT_ROOMS.map((id) => ({
        jsonId: id,
        domId: id,
      })),
    });
  }

  // Cluster 3: 9A,9B,10A,10B
  clusters.push({
    name: "cluster-back",
    rooms: [
      { jsonId: "9A", domId: "9A" },
      { jsonId: "9B", domId: "9B" },
      { jsonId: "10A", domId: "10A" },
      { jsonId: "10B", domId: "10B" },
    ],
  });

  return clusters;
}

/**
 * Build time blocks for a cluster:
 *  - Each block represents a unique (startMin, endMin) pair
 *  - Each block knows which room(s) have a slot in that time window
 */
function buildTimeBlocksForCluster(cluster, grouped) {
  const blocksMap = new Map(); // key "start-end" -> { startMin, endMin, byRoom: Map(jsonId -> slot) }

  for (const room of cluster.rooms) {
    const roomSlots = grouped.get(room.jsonId) || [];
    for (const slot of roomSlots) {
      const key = `${slot.startMin}-${slot.endMin}`;
      let block = blocksMap.get(key);
      if (!block) {
        block = {
          startMin: slot.startMin,
          endMin: slot.endMin,
          byRoom: new Map(),
        };
        blocksMap.set(key, block);
      }
      // If multiple slots with same start/end in same room, keep the first
      if (!block.byRoom.has(room.jsonId)) {
        block.byRoom.set(room.jsonId, slot);
      }
    }
  }

  const blocks = Array.from(blocksMap.values());
  blocks.sort(
    (a, b) => a.startMin - b.startMin || a.endMin - b.endMin
  );
  return blocks;
}

/**
 * Advance one cluster in sync by time-block:
 *  - Build cluster time blocks from all rooms’ slots
 *  - blockIndex = GLOBAL_TICK % blocks.length
 *  - For that time block:
 *      - Room with a slot in that block shows it
 *      - Room without → blank
 *  - Header label per room:
 *      - **Cluster-based**: "<blockIndex+1> of <blocks.length> reservations"
 *        so labels are consistent & monotonic across the cluster.
 */
function advanceCluster(cluster, grouped) {
  const blocks = buildTimeBlocksForCluster(cluster, grouped);

  if (blocks.length === 0) {
    // No events at all for this cluster
    for (const room of cluster.rooms) {
      const card = document.getElementById(`room-${room.domId}`);
      if (!card) continue;
      const countEl = qs(".roomHeader .count", card);
      const eventsEl = qs(".events", card);
      if (countEl) countEl.textContent = "0 of 0 reservations";
      if (eventsEl) eventsEl.innerHTML = "";
    }
    return;
  }

  const blockIndex = GLOBAL_TICK % blocks.length;
  const block = blocks[blockIndex];
  const blockLabelIndex = blockIndex + 1;
  const blockTotal = blocks.length;
  const clusterLabel = `${blockLabelIndex} of ${blockTotal} reservations`;

  for (const room of cluster.rooms) {
    const card = document.getElementById(`room-${room.domId}`);
    if (!card) continue;

    const countEl = qs(".roomHeader .count", card);
    const eventsEl = qs(".events", card);
    if (!eventsEl || !countEl) continue;

    const roomSlots = grouped.get(room.jsonId) || [];
    const slot = block.byRoom.get(room.jsonId) || null;

    if (!roomSlots.length) {
      // This room has no events at all today (in filtered set)
      countEl.textContent = "0 of 0 reservations";
      eventsEl.innerHTML = "";
      continue;
    }

    if (slot) {
      // Room has a reservation in this time block
      countEl.textContent = clusterLabel;
      const chip = buildEventChip(slot);
      eventsEl.innerHTML = "";
      eventsEl.appendChild(chip);
    } else {
      // Room has no reservation in this time block → blank but keep cluster label
      countEl.textContent = clusterLabel;
      eventsEl.innerHTML = "";
    }
  }
}

/**
 * One global tick every 8 seconds:
 *  - recompute filtered slots
 *  - group by room
 *  - advance each cluster by time-block
 */
function globalRotorTick() {
  if (!ALL_SLOTS.length) return;

  const displaySlots = filterForDisplay(ALL_SLOTS);
  const grouped = groupByRoom(displaySlots);

  const clusters = getClusters();
  for (const cluster of clusters) {
    advanceCluster(cluster, grouped);
  }

  GLOBAL_TICK++;
}

// ---------- events.json refresh ----------

async function refreshEventsJson() {
  try {
    const res = await fetch(`./events.json?cb=${Date.now()}`, {
      cache: "no-store",
    });
    const data = await res.json();
    ALL_SLOTS = Array.isArray(data?.slots) ? data.slots : [];

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
