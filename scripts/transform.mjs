// scripts/transform.mjs
import fs from "fs";

/** ---- Config ---- */
const CSV_PATH = process.env.CSV_PATH || "data/inbox/latest.csv";
const JSON_OUT = process.env.JSON_OUT || "events.json";

// Building hours (minutes from midnight). 6:00 -> 23:00
const DAY_START_MIN = 6 * 60;
const DAY_END_MIN = 23 * 60;

// Generate rooms 1A..10B in the required order
const COURT_NUMBERS = Array.from({ length: 10 }, (_, i) => i + 1);
const COURT_SIDES = ["A", "B"];
const ROOM_IDS = COURT_NUMBERS.flatMap((n) => COURT_SIDES.map((s) => `${n}${s}`));

/** ---- Small CSV parser (comma, quotes) ---- */
function parseCSV(text) {
  const rows = [];
  let i = 0, field = "", row = [], inQuotes = false;

  while (i < text.length) {
    const c = text[i];

    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"'; // escaped quote
          i += 2;
        } else {
          inQuotes = false;
          i++;
        }
      } else {
        field += c;
        i++;
      }
    } else {
      if (c === '"') {
        inQuotes = true;
        i++;
      } else if (c === ",") {
        row.push(field.trim());
        field = "";
        i++;
      } else if (c === "\r") {
        i++; // ignore
      } else if (c === "\n") {
        row.push(field.trim());
        rows.push(row);
        row = [];
        field = "";
        i++;
      } else {
        field += c;
        i++;
      }
    }
  }
  // last field
  if (field.length || row.length) {
    row.push(field.trim());
    rows.push(row);
  }
  return rows;
}

/** ---- Helpers ---- */
function headerIndex(headers, name) {
  const idx = headers.findIndex((h) => h.toLowerCase() === name.toLowerCase());
  return idx >= 0 ? idx : -1;
}

function parseTime12h(s) {
  // "6:00pm", "9:30am", "3:00pm"
  if (!s) return null;
  const m = s.trim().match(/^(\d{1,2})(?::(\d{2}))?\s*([ap]m)$/i);
  if (!m) return null;
  let hh = parseInt(m[1], 10);
  const mm = parseInt(m[2] || "0", 10);
  const ampm = m[3].toLowerCase();
  if (ampm === "pm" && hh !== 12) hh += 12;
  if (ampm === "am" && hh === 12) hh = 0;
  return hh * 60 + mm;
}

function clampToDay(startMin, endMin) {
  const s = Math.max(startMin, DAY_START_MIN);
  const e = Math.min(endMin, DAY_END_MIN);
  return e > s ? [s, e] : null;
}

// Map “AC Gym - Half Court 9A” → ["9A"]
// Map “AC Gym - Court 9-AB” → ["9A","9B"]
function extractRoomsFromFacility(facility) {
  if (!facility) return [];

  // Only AC Gym items belong on the 1A..10B board
  if (!/^AC\s+Gym\b/i.test(facility)) return [];

  // Half Court N[A|B]
  let m = facility.match(/Half\s+Court\s+(\d{1,2})([AB])\b/i);
  if (m) {
    const n = parseInt(m[1], 10);
    const side = m[2].toUpperCase();
    const id = `${n}${side}`;
    return ROOM_IDS.includes(id) ? [id] : [];
  }

  // Court N-AB (both halves)
  m = facility.match(/Court\s+(\d{1,2})-AB\b/i);
  if (m) {
    const n = parseInt(m[1], 10);
    const ids = [`${n}A`, `${n}B`];
    return ids.filter((id) => ROOM_IDS.includes(id));
  }

  // Court N-AB or N-AB variants, also sometimes "Court 9-AB, 10-AB" (rare)
  // Add a fallback: if we see "Court NN-AB" without Half, assume both halves.
  m = facility.match(/Court\s+(\d{1,2})\s*-\s*AB\b/i);
  if (m) {
    const n = parseInt(m[1], 10);
    const ids = [`${n}A`, `${n}B`];
    return ids.filter((id) => ROOM_IDS.includes(id));
  }

  return [];
}

function parseReservedTime(span) {
  // "6:30pm - 9:00pm" or with extra spaces
  if (!span) return null;
  const parts = span.split("-").map((s) => s.trim());
  if (parts.length !== 2) return null;
  const start = parseTime12h(parts[0]);
  const end = parseTime12h(parts[1]);
  if (start == null || end == null) return null;
  return [start, end];
}

/** ---- Main ---- */
function readCSV(path) {
  if (!fs.existsSync(path)) return null;
  const text = fs.readFileSync(path, "utf8");
  if (!text.trim()) return null;
  return parseCSV(text);
}

function buildEmptyRooms() {
  const rooms = {};
  ROOM_IDS.forEach((id) => {
    rooms[id] = { id, label: id }; // minimal; UI can render label
  });
  return rooms;
}

function main() {
  const rows = readCSV(CSV_PATH);
  const out = {
    dayStartMin: DAY_START_MIN,
    dayEndMin: DAY_END_MIN,
    rooms: buildEmptyRooms(),
    slots: [],
  };

  if (!rows || rows.length < 2) {
    fs.writeFileSync(JSON_OUT, JSON.stringify(out, null, 2));
    console.log("No CSV rows found; wrote empty day scaffold.");
    return;
  }

  const headers = rows[0].map((h) => h.trim().toLowerCase());
  const idxLocation = headerIndex(headers, "location");
  const idxFacility = headerIndex(headers, "facility");
  const idxReserved = headerIndex(headers, "reservedtime");
  const idxReservee = headerIndex(headers, "reservee");
  const idxPurpose = headerIndex(headers, "reservationpurpose");

  const slots = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];

    const location = idxLocation >= 0 ? row[idxLocation] : "";
    const facility = idxFacility >= 0 ? row[idxFacility] : "";
    const reservedSpan = idxReserved >= 0 ? row[idxReserved] : "";
    const reservee = idxReservee >= 0 ? row[idxReservee] : "";
    const purpose = idxPurpose >= 0 ? row[idxPurpose] : "";

    // Keep only the Athletic & Event Center rows
    if (location && !/athletic\s*&\s*event\s*center/i.test(location)) continue;

    // Map to 1A..10B rooms
    const roomIds = extractRoomsFromFacility(facility);
    if (roomIds.length === 0) continue;

    const t = parseReservedTime(reservedSpan);
    if (!t) continue;
    const [startMinRaw, endMinRaw] = t;

    const clamped = clampToDay(startMinRaw, endMinRaw);
    if (!clamped) continue;
    const [startMin, endMin] = clamped;

    const title = reservee || "Reserved";
    const subtitle = purpose || "";

    roomIds.forEach((roomId) => {
      slots.push({
        roomId,
        startMin,
        endMin,
        title,
        subtitle,
      });
    });
  }

  // Sort by time then room
  slots.sort((a, b) => (a.startMin - b.startMin) || a.endMin - b.endMin || a.roomId.localeCompare(b.roomId));

  out.slots = slots;

  fs.writeFileSync(JSON_OUT, JSON.stringify(out, null, 2));
  console.log(`Wrote ${JSON_OUT} • rooms=${Object.keys(out.rooms).length} • slots=${out.slots.length}`);
}

main();
