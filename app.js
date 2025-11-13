// app.js — NOW + NEXT per room, X of Y reservations, CSV-driven season

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

// startMin/endMin are already minutes-from-midnight from transform.mjs
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

// All slots are “today” in this board
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
