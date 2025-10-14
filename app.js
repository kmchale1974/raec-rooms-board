// app.js (ESM) — renders the board exactly like the whiteboard and drops events into the right boxes

/* -------------------------
   DATE BANNER (pretty like the photo)
--------------------------*/
const bannerDay = document.querySelector("#banner-day");
const bannerDate = document.querySelector("#banner-date");

// Format like: FRIDAY  •  October 10th, 2025
const now = new Date();
const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: "long" });
const dateFmt = new Intl.DateTimeFormat(undefined, { month: "long", day: "numeric", year: "numeric" });

function ordinal(n){
  const s = ["th","st","nd","rd"];
  const v = n % 100;
  return n + (s[(v-20)%10] || s[v] || s[0]);
}
bannerDay.textContent = dayFmt.format(now).toUpperCase();
const dayNum = now.getDate();
const [month, rest] = dateFmt.format(now).split(" ");
bannerDate.innerHTML = `${month} ${ordinal(dayNum)}, ${now.getFullYear()}`;

/* -------------------------
   EVENT LOADING
--------------------------*/

// Where to render
const buckets = {
  "1A": document.getElementById("room-1A"),
  "1B": document.getElementById("room-1B"),
  "2A": document.getElementById("room-2A"),
  "2B": document.getElementById("room-2B"),

  "3": document.getElementById("room-3"),
  "4": document.getElementById("room-4"),
  "5": document.getElementById("room-5"),
  "6": document.getElementById("room-6"),
  "7": document.getElementById("room-7"),
  "8": document.getElementById("room-8"),

  "9A": document.getElementById("room-9A"),
  "9B": document.getElementById("room-9B"),
  "10A": document.getElementById("room-10A"),
  "10B": document.getElementById("room-10B")
};

// Minimal mapping helper: translate facility strings -> board boxes
// Extend as you see new names in your CSV.
function roomsFromFacility(str = "") {
  const s = str.toLowerCase();

  // Gym full/AB courts
  if (s.includes("court 10-ab") || s.includes("court 10 - ab")) return ["10A","10B"];
  if (s.includes("court 9-ab") || s.includes("court 9 - ab")) return ["9A","9B"];

  // Half courts
  if (s.includes("half court 10a")) return ["10A"];
  if (s.includes("half court 10b")) return ["10B"];
  if (s.includes("half court 9a"))  return ["9A"];
  if (s.includes("half court 9b"))  return ["9B"];

  // Central numbered courts/fields
  for (const n of ["3","4","5","6","7","8"]) {
    if (s.includes(` ${n}`) || s.endsWith(`-${n}`) || s.includes(`court ${n}`)) return [n];
  }

  // Rooms 1A/1B/2A/2B if mentioned
  for (const code of ["1A","1B","2A","2B"]) {
    if (s.includes(code.toLowerCase())) return [code];
  }

  return []; // unknown → won’t place
}

// Some CSVs only carry “reservee/purpose” + a time range. Build a nice line.
function slotLine({ time, who, purpose }) {
  const el = document.createElement("div");
  el.className = "slot";

  const t = document.createElement("span");
  t.className = "time";
  t.textContent = time || "";

  const w = document.createElement("span");
  w.className = "who";
  w.textContent = who || "";

  const p = document.createElement("span");
  p.className = "note";
  p.textContent = purpose || "";

  el.append(t, w, p);
  return el;
}

/* -------------------------
   FETCH events.json (from your transform step)
--------------------------*/
async function loadEvents() {
  try {
    const res = await fetch("events.json", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    // Expected structure:
    // data.events = [{ facility, roomCode?, start, end, who, purpose }]
    // If roomCode missing, derive it from facility string.
    const events = Array.isArray(data?.events) ? data.events : [];

    if (!events.length) {
      showEmptyHints();
      return;
    }

    for (const ev of events) {
      const roomCodes = ev.roomCode ? [ev.roomCode] : roomsFromFacility(ev.facility || "");
      if (!roomCodes.length) continue;

      const time = formatTimeRange(ev.start, ev.end, ev.timeText);
      const line = slotLine({
        time,
        who: ev.who || ev.reservee || "",
        purpose: ev.purpose || ev.reservationpurpose || ""
      });

      for (const rc of roomCodes) {
        const bucket = buckets[rc];
        if (bucket) bucket.appendChild(line.cloneNode(true));
      }
    }
  } catch (err) {
    console.error("Failed to load events.json:", err);
    showEmptyHints("Couldn’t load events.json");
  }
}

function formatTimeRange(startISO, endISO, fallback) {
  if (fallback) return fallback;
  const fmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
  if (!startISO || !endISO) return "";
  const s = fmt.format(new Date(startISO)).replace(" ", "");
  const e = fmt.format(new Date(endISO)).replace(" ", "");
  return `${s} - ${e}`;
}

function showEmptyHints(extra) {
  const sample = slotLine({
    time: "7:00p - 9:00p",
    who: "PINK Elite",
    purpose: ""
  });
  const sample2 = slotLine({
    time: "7:30p - 9:30p",
    who: "FFB",
    purpose: ""
  });
  buckets["7"]?.appendChild(sample.cloneNode(true));
  buckets["5"]?.appendChild(sample2.cloneNode(true));
  if (extra) {
    const n = document.createElement("div");
    n.style.padding="10px 12px"; n.style.fontSize="14px"; n.style.opacity=".6";
    n.textContent = extra;
    buckets["3"]?.appendChild(n);
  }
}

loadEvents();
