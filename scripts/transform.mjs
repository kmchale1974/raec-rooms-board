// scripts/transform.mjs
import fs from "fs";

/** -------- Config -------- */
const CSV_PATH = process.env.CSV_PATH || "data/inbox/latest.csv";
const JSON_OUT = process.env.JSON_OUT || "events.json";

// Building hours (6:00–23:00)
const DAY_START_MIN = 6 * 60;
const DAY_END_MIN = 23 * 60;

// Room order 1A..10B
const COURT_NUMBERS = Array.from({ length: 10 }, (_, i) => i + 1);
const COURT_SIDES = ["A", "B"];
const ROOM_IDS = COURT_NUMBERS.flatMap((n) => COURT_SIDES.map((s) => `${n}${s}`));

/** -------- CSV parser -------- */
function parseCSV(text) {
  const rows = [];
  let i = 0, field = "", row = [], inQuotes = false;

  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
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
        i++;
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
  if (field.length || row.length) {
    row.push(field.trim());
    rows.push(row);
  }
  return rows;
}

/** -------- Helpers -------- */
const norm = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

function headerIndex(headers, targetNames) {
  // targetNames: string or array of acceptable names (normalized)
  const targets = Array.isArray(targetNames) ? targetNames : [targetNames];
  const normTargets = targets.map(norm);
  for (let i = 0; i < headers.length; i++) {
    const h = norm(headers[i]);
    if (normTargets.includes(h)) return i;
  }
  return -1;
}

function parseTime12h(s) {
  if (!s) return null;
  const cleaned = s.trim().replace(/\s+/g, ""); // "4:00pm"
  const m = cleaned.match(/^(\d{1,2})(?::(\d{2}))?([ap]m)$/i);
  if (!m) return null;
  let hh = parseInt(m[1], 10);
  const mm = parseInt(m[2] || "0", 10);
  const ampm = m[3].toLowerCase();
  if (ampm === "pm" && hh !== 12) hh += 12;
  if (ampm === "am" && hh === 12) hh = 0;
  return hh * 60 + mm;
}

function parseReservedSpan(span) {
  // e.g. "4:00pm -  7:00pm"
  if (!span) return null;
  const parts = span.split("-").map((t) => t.trim());
  if (parts.length !== 2) return null;
  const start = parseTime12h(parts[0]);
  const end = parseTime12h(parts[1]);
  if (start == null || end == null) return null;
  return [start, end];
}

function clampToDay(startMin, endMin) {
  const s = Math.max(startMin, DAY_START_MIN);
  const e = Math.min(endMin, DAY_END_MIN);
  return e > s ? [s, e] : null;
}

function buildEmptyRooms() {
  const rooms = {};
  ROOM_IDS.forEach((id) => (rooms[id] = { id, label: id }));
  return rooms;
}

/** -------- Facility → room(s) mapping -------- */
function extractRoomsFromFacility(facility) {
  if (!facility) return [];

  // AC Gym - Half Court 9A
  let m = facility.match(/AC\s*Gym\s*-\s*Half\s*Court\s*(\d{1,2})([AB])/i);
  if (m) {
    const id = `${parseInt(m[1], 10)}${m[2].toUpperCase()}`;
    return ROOM_IDS.includes(id) ? [id] : [];
  }

  // AC Gym - Court 9-AB
  m = facility.match(/AC\s*Gym\s*-\s*Court\s*(\d{1,2})\s*-\s*AB/i);
  if (m) {
    const n = parseInt(m[1], 10);
    return [`${n}A`, `${n}B`].filter((id) => ROOM_IDS.includes(id));
  }

  // AC Fieldhouse Court 3-8 (no hyphen after "Fieldhouse")
  m = facility.match(/AC\s*Fieldhouse\s*Court\s*(\d{1,2})\s*-\s*(\d{1,2})/i);
  if (m) {
    const a = parseInt(m[1], 10);
    const b = parseInt(m[2], 10);
    const ids = [];
    for (let n = Math.min(a, b); n <= Math.max(a, b); n++) {
      ids.push(`${n}A`, `${n}B`);
    }
    return ids.filter((id) => ROOM_IDS.includes(id));
  }

  // AC Fieldhouse - Court 7  → 7A & 7B
  m = facility.match(/AC\s*Fieldhouse\s*-\s*Court\s*(\d{1,2})/i);
  if (m) {
    const n = parseInt(m[1], 10);
    return [`${n}A`, `${n}B`].filter((id) => ROOM_IDS.includes(id));
  }

  // Full Gym 9 & 10
  m = facility.match(/Full\s*Gym\s*(\d{1,2})\s*&\s*(\d{1,2})/i);
  if (m) {
    const a = parseInt(m[1], 10);
    const b = parseInt(m[2], 10);
    const ids = [`${a}A`, `${a}B`, `${b}A`, `${b}B`];
    return ids.filter((id) => ROOM_IDS.includes(id));
  }

  // Full Gym 1AB & 2AB  (treat AB as both halves on each court number)
  m = facility.match(/Full\s*Gym\s*(\d{1,2})AB\s*&\s*(\d{1,2})AB/i);
  if (m) {
    const a = parseInt(m[1], 10);
    const b = parseInt(m[2], 10);
    const ids = [`${a}A`, `${a}B`, `${b}A`, `${b}B`];
    return ids.filter((id) => ROOM_IDS.includes(id));
  }

  // Championship Court → pick a sensible default; map to 1A+1B
  if (/Championship\s*Court/i.test(facility)) {
    return ["1A", "1B"];
  }

  // Ignore turf & other areas for the gym board
  return [];
}

/** -------- Main -------- */
function readCSV(path) {
  if (!fs.existsSync(path)) return null;
  const text = fs.readFileSync(path, "utf8");
  if (!text.trim()) return null;
  return parseCSV(text);
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

  const headers = rows[0];

  const idxLocation = headerIndex(headers, ["location"]);
  const idxFacility = headerIndex(headers, ["facility"]);
  const idxReserved = headerIndex(headers, ["reservedtime", "reserved time"]);
  const idxReservee = headerIndex(headers, ["reservee"]);
  const idxPurpose  = headerIndex(headers, ["reservationpurpose", "reservation purpose"]);

  const slots = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];

    const location = idxLocation >= 0 ? row[idxLocation] : "";
    const facility = idxFacility >= 0 ? row[idxFacility] : "";
    const reservedSpan = idxReserved >= 0 ? row[idxReserved] : "";
    const reservee = idxReservee >= 0 ? row[idxReservee] : "";
    const purpose = idxPurpose >= 0 ? row[idxPurpose] : "";

    // Keep only RAEC rows (but tolerate minor header/spacing differences)
    if (location && !/athletic\s*&\s*event\s*center/i.test(location)) continue;

    const roomIds = extractRoomsFromFacility(facility);
    if (roomIds.length === 0) continue;

    const t = parseReservedSpan(reservedSpan);
    if (!t) continue;

    const [startRaw, endRaw] = t;
    const clamped = clampToDay(startRaw, endRaw);
    if (!clamped) continue;

    const [startMin, endMin] = clamped;
    const title = reservee || "Reserved";
    const subtitle = purpose || "";

    roomIds.forEach((roomId) => {
      slots.push({ roomId, startMin, endMin, title, subtitle });
    });
  }

  // Sort chronologically, then by room id
  slots.sort(
    (a, b) =>
      a.startMin - b.startMin ||
      a.endMin - b.endMin ||
      a.roomId.localeCompare(b.roomId)
  );

  out.slots = slots;
  fs.writeFileSync(JSON_OUT, JSON.stringify(out, null, 2));
  console.log(`Wrote ${JSON_OUT} • rooms=${Object.keys(out.rooms).length} • slots=${out.slots.length}`);
}

main();
