// app.js  (ES Module)

// --------------------------
// CONFIG
// --------------------------
const BUILDING_HOURS = {
  // Per-area overrides. If your events include e.area ("Gym", "Fieldhouse", etc.)
  // these hours will be used; otherwise the DEFAULT applies.
  DEFAULT: { open: "06:00", close: "22:00" },
  Gym:     { open: "06:00", close: "22:00" },
  Fieldhouse: { open: "06:00", close: "22:00" },
};

const ROOMS_ORDER = [
  "1A","1B","2A","2B","3A","3B","4A","4B","5A","5B",
  "6A","6B","7A","7B","8A","8B","9A","9B","10A","10B",
];

// How often to refresh events (ms)
const REFRESH_MS = 60_000;

// URL to your generated data (GitHub Pages)
const EVENTS_URL = "events.json";

// --------------------------
// UTILS
// --------------------------
function injectFontsAndTheme() {
  // Inter font
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = "https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap";
  document.head.appendChild(link);

  // Dark theme styles (scoped to this app)
  const css = `
    :root {
      --bg: #0b0f14;
      --panel: #121821;
      --panel-2: #0f141c;
      --text: #e8eef6;
      --muted: #9fb0c6;
      --accent: #5aa8ff;
      --grid: #1b2431;
      --now: #ff6b6b;
      --block: #1f2a3a;
      --block-border: #33455f;
    }
    * { box-sizing: border-box; }
    body { margin:0; background:var(--bg); color:var(--text); font-family: Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; }
    #app { padding: 24px; max-width: 1920px; margin: 0 auto; }

    .header {
      display:flex; flex-direction:column; gap:8px; align-items:center; justify-content:center; margin-bottom: 12px;
    }
    .title-row {
      display:flex; align-items:center; gap:16px; justify-content:center;
    }
    .title {
      font-size: clamp(20px, 2.2vw, 32px);
      font-weight: 700;
      letter-spacing: 0.3px;
      text-align: center;
    }
    .clock {
      font-variant-numeric: tabular-nums;
      font-weight: 600;
      color: var(--muted);
      font-size: clamp(16px, 1.8vw, 22px);
      padding: 4px 10px;
      background: var(--panel);
      border: 1px solid #1d2a3a;
      border-radius: 10px;
      min-width: 130px;
      text-align: center;
    }

    .tabs {
      display:flex; gap:8px; justify-content:center; margin: 10px 0 18px;
      flex-wrap: wrap;
    }
    .tab {
      padding: 8px 14px;
      background: var(--panel-2);
      border: 1px solid #1b2838;
      color: var(--muted);
      border-radius: 10px;
      cursor: default; /* non-interactive display */
      user-select: none;
    }
    .tab.active {
      color: var(--text);
      background: linear-gradient(180deg, #162131, #121a28);
      border-color: #29405c;
      box-shadow: inset 0 0 0 1px rgba(90,168,255,0.15);
    }

    .board {
      border: 1px solid #1b2838;
      background: var(--panel);
      border-radius: 14px;
      overflow: hidden;
    }

    .grid {
      display:grid;
      grid-template-columns: 220px 1fr;
      min-height: 70vh;
    }

    .rooms {
      border-right:1px solid var(--grid);
      background: var(--panel-2);
      display:grid;
      grid-auto-rows: minmax(48px, auto);
    }
    .room {
      border-bottom:1px solid var(--grid);
      display:flex; align-items:center; padding: 10px 14px;
      font-weight: 600; color: var(--text);
    }

    .timeline {
      position:relative;
      overflow:hidden;
    }
    .hours {
      display:flex;
      position:sticky; top:0; z-index:2;
      background: linear-gradient(180deg, #101724, #0f151f);
      border-bottom:1px solid var(--grid);
    }
    .hour {
      flex:1; min-width: 80px;
      font-size: 12px; color: var(--muted);
      text-align:center; padding: 8px 0;
      border-left: 1px solid var(--grid);
    }
    .hour:first-child { border-left:none; }

    .rows {
      position:relative;
      height: calc(48px * ${ROOMS_ORDER.length});
      background:
        linear-gradient(#0000, #0000) padding-box,
        repeating-linear-gradient(
          to bottom,
          #0000 0,
          #0000 47px,
          var(--grid) 47px,
          var(--grid) 48px
        );
    }

    .col-grid {
      position:absolute; inset:0;
      background:
        repeating-linear-gradient(
          to right,
          #0000 0,
          #0000 var(--hourW),
          rgba(255,255,255,0.03) var(--hourW),
          rgba(255,255,255,0.03) calc(var(--hourW) + 1px)
        );
      pointer-events:none;
    }

    .now {
      position:absolute; top:0; bottom:0;
      width:2px;
      background: var(--now);
      box-shadow: 0 0 8px rgba(255,107,107,0.8);
      z-index: 3;
    }

    .event {
      position:absolute;
      background: var(--block);
      border: 1px solid var(--block-border);
      color: var(--text);
      border-radius: 8px;
      padding: 6px 10px;
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
      font-size: 13px;
    }
    .event .who {
      color: var(--muted);
      font-size: 12px;
      margin-left: 6px;
    }
    .empty-hint {
      text-align:center; color: var(--muted);
      padding: 20px 0 26px; font-size: 14px;
    }
  `;
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);
}

function fmtDateHeader(d = new Date()) {
  const weekday = d.toLocaleDateString(undefined, { weekday: "long" });
  const date = d.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });
  return `${weekday}, ${date}`;
}

function fmtClock(d = new Date()) {
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function parseTimeToMinutes(t24) {
  // t24 like "06:00" -> minutes from midnight
  const [h, m] = t24.split(":").map(Number);
  return h * 60 + m;
}

function minutesSinceMidnight(d = new Date()) {
  return d.getHours() * 60 + d.getMinutes();
}

function getAreas(events) {
  const areas = new Set();
  for (const e of events) if (e.area) areas.add(e.area);
  return areas.size ? Array.from(areas) : ["All"];
}

function hoursForArea(area) {
  return BUILDING_HOURS[area] || BUILDING_HOURS.DEFAULT;
}

function cacheBust(url) {
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}t=${Date.now()}`;
}

// --------------------------
// DATA
// --------------------------
async function loadEvents() {
  const res = await fetch(cacheBust(EVENTS_URL), { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to load events.json (${res.status})`);
  const data = await res.json();
  // Normalize
  return (Array.isArray(data) ? data : data.events || []).map(e => ({
    room: String(e.room || "").trim(),
    title: e.title || "",
    start: e.start, // ISO
    end:   e.end,   // ISO
    area:  e.area || undefined,
    who:   e.reservee || e.who || "",
  })).filter(e => e.room && e.start && e.end);
}

// --------------------------
// RENDER
// --------------------------
function buildHeader(container) {
  const header = document.createElement("div");
  header.className = "header";

  const titleRow = document.createElement("div");
  titleRow.className = "title-row";

  const title = document.createElement("div");
  title.className = "title";
  title.id = "dateText";
  title.textContent = fmtDateHeader();

  const clock = document.createElement("div");
  clock.className = "clock";
  clock.id = "clockText";
  clock.textContent = fmtClock();

  titleRow.append(title, clock);
  header.appendChild(titleRow);
  container.appendChild(header);
}

function buildTabs(container, areas, activeArea) {
  if (areas.length <= 1) return; // no tabs needed
  const tabs = document.createElement("div");
  tabs.className = "tabs";
  for (const a of areas) {
    const el = document.createElement("div");
    el.className = "tab" + (a === activeArea ? " active" : "");
    el.textContent = a;
    // non-interactive display, but we still indicate active
    tabs.appendChild(el);
  }
  container.appendChild(tabs);
}

function areaFilter(evts, area) {
  if (area === "All") return evts;
  return evts.filter(e => (e.area || "All") === area);
}

function computeLayout(openMins, closeMins, areaEvents) {
  // Hide events that have already ended
  const now = Date.now();
  const upcoming = areaEvents.filter(e => new Date(e.end).getTime() > now);

  // Keep only rooms in ROOMS_ORDER (and keep order)
  const known = upcoming.filter(e => ROOMS_ORDER.includes(e.room));

  // Group by room
  const byRoom = new Map(ROOMS_ORDER.map(r => [r, []]));
  for (const e of known) byRoom.get(e.room).push(e);

  // Compute pixel positions relative to open/close
  const totalMinutes = closeMins - openMins;
  return { byRoom, totalMinutes };
}

function buildBoard(container, area, areaEvents) {
  const { open, close } = hoursForArea(area);
  const openMins = parseTimeToMinutes(open);
  const closeMins = parseTimeToMinutes(close);
  const totalMinutes = closeMins - openMins;

  // Root
  const board = document.createElement("div");
  board.className = "board";

  // Grid
  const grid = document.createElement("div");
  grid.className = "grid";

  // Rooms rail
  const roomsCol = document.createElement("div");
  roomsCol.className = "rooms";
  for (const room of ROOMS_ORDER) {
    const row = document.createElement("div");
    row.className = "room";
    row.textContent = `Court ${room}`;
    roomsCol.appendChild(row);
  }

  // Timeline col
  const timeline = document.createElement("div");
  timeline.className = "timeline";

  // Hour header
  const hoursHead = document.createElement("div");
  hoursHead.className = "hours";
  const hourSpan = Math.max(1, Math.ceil((closeMins - openMins) / 60));
  for (let i = 0; i < hourSpan; i++) {
    const labelMins = openMins + i * 60;
    const h = Math.floor(labelMins / 60);
    const disp = new Date(0, 0, 0, h).toLocaleTimeString([], { hour: "numeric" });
    const hour = document.createElement("div");
    hour.className = "hour";
    hour.textContent = disp;
    hoursHead.appendChild(hour);
  }

  // Rows + background grid columns
  const rows = document.createElement("div");
  rows.className = "rows";
  // expose CSS var for hour width: rows.clientWidth is not yet known; use percentage grid backdrop
  const colGrid = document.createElement("div");
  colGrid.className = "col-grid";
  colGrid.style.setProperty("--hourW", `${100 / hourSpan}%`);
  rows.appendChild(colGrid);

  // Events layout
  const { byRoom } = computeLayout(openMins, closeMins, areaEvents);

  const rowHeight = 48; // must match CSS grid auto rows
  const timelineRectWidth = () => rows.clientWidth;

  // Place events as absolute blocks
  function placeEvents() {
    // clear previous blocks (if re-rendering)
    rows.querySelectorAll(".event, .now").forEach(n => n.remove());

    const width = timelineRectWidth();
    const pxPerMin = width / totalMinutes;

    // Current time red line (only if inside building hours today)
    const nowM = minutesSinceMidnight();
    if (nowM >= openMins && nowM <= closeMins) {
      const nowX = (nowM - openMins) * pxPerMin;
      const now = document.createElement("div");
      now.className = "now";
      now.style.left = `${nowX}px`;
      rows.appendChild(now);
    }

    let any = false;
    ROOMS_ORDER.forEach((room, idx) => {
      const list = byRoom.get(room);
      for (const e of list) {
        any = true;
        const s = new Date(e.start);
        const en = new Date(e.end);
        const sM = s.getHours() * 60 + s.getMinutes();
        const eM = en.getHours() * 60 + en.getMinutes();

        const clampedStart = Math.max(sM, openMins);
        const clampedEnd = Math.min(eM, closeMins);
        if (clampedEnd <= openMins || clampedStart >= closeMins) continue;

        const left = (clampedStart - openMins) * pxPerMin;
        const widthPx = Math.max(2, (clampedEnd - clampedStart) * pxPerMin);

        const block = document.createElement("div");
        block.className = "event";
        block.style.top = `${idx * rowHeight + 6}px`;
        block.style.height = `${rowHeight - 12}px`;
        block.style.left = `${left}px`;
        block.style.width = `${widthPx}px`;

        const title = e.title || "Reserved";
        const who = e.who ? `— ${e.who}` : "";
        block.innerHTML = `<strong>${title}</strong> <span class="who">${who}</span>`;
        rows.appendChild(block);
      }
    });

    // Empty hint
    if (!any) {
      const hint = document.createElement("div");
      hint.className = "empty-hint";
      hint.textContent = "No reservations during building hours.";
      rows.appendChild(hint);
    }
  }

  // Initial build
  timeline.append(hoursHead, rows);
  grid.append(roomsCol, timeline);
  board.appendChild(grid);
  container.appendChild(board);

  // After attached to DOM, we can measure widths and place events
  requestAnimationFrame(placeEvents);
  // Reflow on resize (e.g., Yodeck player resizes)
  window.addEventListener("resize", placeEvents, { passive: true });

  // Return a tiny API to update only the moving parts (now line) without rebuilding everything
  return {
    updateNowLine: placeEvents,
  };
}

// --------------------------
// APP
// --------------------------
let currentArea = "All";
let boards = []; // one per area

async function render() {
  const root = document.getElementById("app");
  root.innerHTML = "";

  // Header
  buildHeader(root);

  // Data
  const events = await loadEvents();

  // Areas (tabs look)
  const areas = getAreas(events);
  if (!areas.includes(currentArea)) currentArea = areas[0];
  buildTabs(root, areas, currentArea);

  // Build one board per area (non-interactive tabs => still show only active)
  const showingAreas = [currentArea];
  boards = [];

  for (const a of showingAreas) {
    const areaEvents = areaFilter(events, a);
    const boardApi = buildBoard(root, a, areaEvents);
    boards.push(boardApi);
  }
}

function tickHeaderClock() {
  const dateEl = document.getElementById("dateText");
  const clockEl = document.getElementById("clockText");
  if (dateEl) dateEl.textContent = fmtDateHeader();
  if (clockEl) clockEl.textContent = fmtClock();
  // Move the "now" line if the minutes changed
  for (const b of boards) b?.updateNowLine?.();
}

async function boot() {
  injectFontsAndTheme();
  await render();

  // Clock + now-line every 60s
  setInterval(tickHeaderClock, 60 * 1000);

  // Full data refresh every REFRESH_MS
  setInterval(async () => {
    try { await render(); } catch (e) { /* keep screen up even on fetch hiccup */ }
  }, REFRESH_MS);
}

// Start
boot().catch(console.error);
