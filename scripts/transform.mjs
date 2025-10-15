// ES module transformer for the RAEC CSV -> events.json
// Reads env: CSV_PATH (input), JSON_OUT (output)
// Assumptions: report is for "today"; building hours 6:00–23:00 local.
// Leaves past events in the JSON; the app hides events whose end < now.

import fs from "fs";
import path from "path";

// ---------- helpers ----------
const CSV_PATH = process.env.CSV_PATH || "data/inbox/latest.csv";
const JSON_OUT = process.env.JSON_OUT || "events.json";

const ROOM_ORDER = ["1A","1B","2A","2B","3","4","5","6","7","8","9A","9B","10A","10B"];
const BUILDING_OPEN_MIN = 6 * 60;   // 06:00
const BUILDING_CLOSE_MIN = 23 * 60; // 23:00

const lc = (s) => (s ?? "").toString().trim().toLowerCase();
const pad2 = (n) => (n < 10 ? `0${n}` : `${n}`);

// naive CSV parser supporting quotes
function parseCSV(text){
  const rows = [];
  let i = 0, field = "", row = [], inQuotes = false;
  while (i < text.length){
    const c = text[i];
    if (inQuotes){
      if (c === '"'){
        if (text[i+1] === '"'){ field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    } else {
      if (c === '"'){ inQuotes = true; i++; continue; }
      if (c === ','){ row.push(field.trim()); field = ""; i++; continue; }
      if (c === '\r'){ i++; continue; }
      if (c === '\n'){ row.push(field.trim()); rows.push(row); field = ""; row = []; i++; continue; }
      field += c; i++; continue;
    }
  }
  // flush last field/row
  row.push(field.trim()); rows.push(row);
  // drop empty trailing row if present
  if (rows.length && rows[rows.length-1].every(x => x === "")) rows.pop();
  return rows;
}

function indexHeaders(head){
  const map = {};
  head.forEach((h, idx) => map[lc(h)] = idx);
  // aliasing common names
  return {
    location: map["location"],
    facility: map["facility"],
    reservedtime: map["reservedtime"],
    reservee: map["reservee"],
    reservationpurpose: map["reservationpurpose"] ?? map["purpose"] ?? map["event"] ?? map["reservation purpose"],
    headcount: map["headcount"],
    qa: map["questionanswerall"] ?? map["questions/answers"] ?? map["qa"]
  };
}

// "6:30pm -  8:00pm" -> {startMin, endMin}
function parseTimeRange(s){
  if (!s) return null;
  const m = s.replace(/\s+/g, " ").trim().toLowerCase();
  const parts = m.split("-").map(p => p.trim());
  if (parts.length !== 2) return null;
  const toMin = (t) => {
    const mm = t.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i);
    if (!mm) return null;
    let h = parseInt(mm[1],10);
    let min = mm[2] ? parseInt(mm[2],10) : 0;
    const ap = mm[3].toLowerCase();
    if (ap === "pm" && h !== 12) h += 12;
    if (ap === "am" && h === 12) h = 0;
    return h*60 + min;
  };
  const startMin = toMin(parts[0]);
  const endMin = toMin(parts[1]);
  if (startMin == null || endMin == null) return null;
  return { startMin, endMin };
}

// Map facility text to one or more room IDs in ROOM_ORDER
function facilityToRooms(facilityRaw){
  const f = lc(facilityRaw);
  if (!f) return [];
  if (!f.includes("ac gym")) return []; // only gym courts on the board

  // Handle "Court 9-AB" -> ["9A","9B"]
  let numAB = f.match(/court\s*(\d+)\s*-\s*ab/);
  if (numAB){
    const n = numAB[1];
    if (n === "9") return ["9A","9B"];
    if (n === "10") return ["10A","10B"];
  }

  // Handle "Half Court 10A", "Half Court 2B"
  let half = f.match(/half\s*court\s*(\d+)\s*([ab])/);
  if (half){
    return [`${parseInt(half[1],10)}${half[2].toUpperCase()}`];
  }

  // Handle "Court 3", "Court 7"
  let single = f.match(/court\s*(\d+)(?![-\w])/);
  if (single){
    const n = parseInt(single[1],10);
    if (n >= 3 && n <= 8) return [`${n}`];
  }

  // Sometimes strings look like "AC Gym - Court 10-AB || AC Gym - Half Court 10B"
  // Try to collect all occurrences
  const hits = [];
  f.replace(/half\s*court\s*(\d+)\s*([ab])/g, (_m, n, ab) => {
    hits.push(`${parseInt(n,10)}${ab.toUpperCase()}`);
    return _m;
  });
  f.replace(/court\s*(\d+)\s*-\s*ab/g, (_m, n) => {
    if (n === "9"){ hits.push("9A","9B"); }
    if (n === "10"){ hits.push("10A","10B"); }
    return _m;
  });
  f.replace(/court\s*(\d+)(?![-\w])/g, (_m, n) => {
    const num = parseInt(n,10);
    if (num >= 3 && num <= 8) hits.push(`${num}`);
    return _m;
  });
  return hits;
}

function cleanLabel(purpose, reservee){
  const a = (purpose || "").trim();
  const b = (reservee || "").trim();
  if (a && b) return `${a} — ${b}`;
  return a || b || "Reserved";
}

// ---------- main ----------
(async () => {
  if (!fs.existsSync(CSV_PATH)){
    console.log(`CSV not found at ${CSV_PATH}. Writing empty ${JSON_OUT}.`);
    const empty = { dayStartMin: BUILDING_OPEN_MIN, dayEndMin: BUILDING_CLOSE_MIN, rooms: {}, slots: [] };
    fs.writeFileSync(JSON_OUT, JSON.stringify(empty, null, 2));
    process.exit(0);
  }

  const raw = fs.readFileSync(CSV_PATH, "utf8");
  const rows = parseCSV(raw);
  if (rows.length < 2){
    console.log("No parsable rows. Writing empty output.");
    const empty = { dayStartMin: BUILDING_OPEN_MIN, dayEndMin: BUILDING_CLOSE_MIN, rooms: {}, slots: [] };
    fs.writeFileSync(JSON_OUT, JSON.stringify(empty, null, 2));
    process.exit(0);
  }

  const head = rows[0];
  const ix = indexHeaders(head);

  const out = { rooms: {}, slots: [] };
  ROOM_ORDER.forEach(r => (out.rooms[r] = []));

  let minSeen = Infinity;
  let maxSeen = -Infinity;

  for (let i = 1; i < rows.length; i++){
    const r = rows[i];

    const location = ix.location != null ? r[ix.location] : "";
    const facility = ix.facility != null ? r[ix.facility] : "";
    const reservedtime = ix.reservedtime != null ? r[ix.reservedtime] : "";
    const reservee = ix.reservee != null ? r[ix.reservee] : "";
    const purpose = ix.reservationpurpose != null ? r[ix.reservationpurpose] : "";

    // Only the Athletic & Event Center gym courts
    const locOK = lc(location).includes("athletic") || lc(facility).includes("ac gym");
    if (!locOK) continue;

    const rooms = facilityToRooms(facility);
    if (rooms.length === 0) continue;

    const t = parseTimeRange(reservedtime);
    if (!t) continue;

    const label = cleanLabel(purpose, reservee);
    rooms.forEach(roomId => {
      if (!out.rooms[roomId]) out.rooms[roomId] = [];
      out.rooms[roomId].push({ startMin: t.startMin, endMin: t.endMin, label });
    });

    minSeen = Math.min(minSeen, t.startMin);
    maxSeen = Math.max(maxSeen, t.endMin);
  }

  // Day bounds (clamp to building hours; if nothing found, use building hours)
  let dayStartMin = isFinite(minSeen) ? Math.max(BUILDING_OPEN_MIN, Math.min(minSeen, BUILDING_CLOSE_MIN)) : BUILDING_OPEN_MIN;
  let dayEndMin   = isFinite(maxSeen) ? Math.min(BUILDING_CLOSE_MIN, Math.max(maxSeen, BUILDING_OPEN_MIN)) : BUILDING_CLOSE_MIN;

  // snap outward to whole hours to look cleaner
  dayStartMin = Math.floor(dayStartMin / 60) * 60;
  dayEndMin   = Math.ceil(dayEndMin / 60) * 60;

  out.dayStartMin = dayStartMin;
  out.dayEndMin = Math.max(dayEndMin, dayStartMin + 60); // ensure at least 1h

  fs.writeFileSync(JSON_OUT, JSON.stringify(out, null, 2));
  console.log(`Wrote ${JSON_OUT} • rooms=${Object.values(out.rooms).filter(a=>a.length).length} • range ${pad2(Math.floor(out.dayStartMin/60))}:${pad2(out.dayStartMin%60)}–${pad2(Math.floor(out.dayEndMin/60))}:${pad2(out.dayEndMin%60)}`);
})();
