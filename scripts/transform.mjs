// scripts/transform.mjs
// Node ESM
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Inputs/outputs
const CSV_PATH  = process.env.CSV_PATH  || "data/inbox/latest.csv";
const JSON_OUT  = process.env.JSON_OUT  || "events.json";

// Board day window (minutes since midnight)
const DAY_START_MIN = 6 * 60;   // 06:00
const DAY_END_MIN   = 23 * 60;  // 23:00

// Numbers that can split (A/B) when CSV explicitly uses half courts
const SPLITTABLE = [1, 2, 9, 10];

// --- tiny CSV parser (sufficient for your export shape) ---
function parseCSV(raw) {
  const lines = raw.split(/\r?\n/).filter(Boolean);
  if (!lines.length) return { headers: [], rows: [] };
  const headers = lines[0].split(",").map(h => h.trim());
  const rows = lines.slice(1).map(line => {
    const cols = line.split(",").map(c => c.trim());
    const obj = {};
    headers.forEach((h, i) => { obj[h] = cols[i] ?? ""; });
    return obj;
  });
  return { headers, rows };
}

// --- time helpers ---
function clampToDay(mins) {
  return Math.max(DAY_START_MIN, Math.min(DAY_END_MIN, mins));
}
function toMin(hh, mm, ampm) {
  let h = parseInt(hh, 10) % 12;
  const m = parseInt(mm, 10) || 0;
  if (ampm === "pm") h += 12;
  return h * 60 + m;
}
function parseTimeRange(s) {
  // e.g. "4:30pm -  6:00pm" or "9:00am - 10:00pm"
  const m = s.toLowerCase().match(/(\d{1,2}):?(\d{2})?\s*(am|pm)\s*-\s*(\d{1,2}):?(\d{2})?\s*(am|pm)/);
  if (!m) return null;
  const [, sh, sm = "00", sap, eh, em = "00", eap] = m;
  let start = toMin(sh, sm, sap);
  let end   = toMin(eh, em, eap);
  if (end <= start) end += 12 * 60; // normalize noon/midnight weirdness
  start = clampToDay(start);
  end   = clampToDay(end);
  if (end <= start) return null;
  return { startMin: start, endMin: end };
}

// --- text clean: remove repeated comma segments (e.g., "X, X") ---
function cleanRepeatedCommaSegments(str) {
  if (!str) return "";
  const parts = str.split(",").map(s => s.trim()).filter(Boolean);
  const seen = new Set();
  const out = [];
  for (const p of parts) {
    const key = p.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out.join(", ");
}

// Detect if any half-court A/B usage exists for a given number in this CSV
function detectSplits(rows, keyFacility) {
  const split = { 1:false, 2:false, 9:false, 10:false };

  for (const r of rows) {
    const fac = (r[keyFacility] || "").trim();

    // "AC Gym - Half Court 10A" etc. = explicit split
    let m = fac.match(/^AC\s+Gym\s*-\s*Half\s+Court\s+(\d{1,2})([AB])$/i);
    if (m) {
      const num = parseInt(m[1], 10);
      if (SPLITTABLE.includes(num)) split[num] = true;
      continue;
    }

    // If you want "Court X-AB" to force split, uncomment below:
    // m = fac.match(/^AC\s+Gym\s*-\s*Court\s+(\d{1,2})-AB$/i);
    // if (m) { const num = parseInt(m[1], 10); if (SPLITTABLE.includes(num)) split[num] = true; }
  }
  return split;
}

// Build the room list based on whether 1/2/9/10 are split today
function buildBoardRooms(splitFlags) {
  const rooms = [];
  // 1
  if (splitFlags[1]) rooms.push("1A","1B"); else rooms.push("1");
  // 2
  if (splitFlags[2]) rooms.push("2A","2B"); else rooms.push("2");
  // 3..8 (Fieldhouse always single)
  rooms.push("3","4","5","6","7","8");
  // 9
  if (splitFlags[9]) rooms.push("9A","9B"); else rooms.push("9");
  // 10
  if (splitFlags[10]) rooms.push("10A","10B"); else rooms.push("10");
  return rooms;
}

// Facility → room IDs mapping per your rules, conditioned by split flags
function facilityToRoomIds(fac, splitFlags) {
  if (!fac) return [];
  const f = fac.trim();

  // 1) GYM half courts (explicit split)
  let m = f.match(/^AC\s+Gym\s*-\s*Half\s+Court\s+(\d{1,2})([AB])$/i);
  if (m) {
    const num = parseInt(m[1], 10);
    const ab  = m[2].toUpperCase();
    if (SPLITTABLE.includes(num)) return [`${num}${ab}`]; // appears only on that A/B lane
  }

  // 2) GYM single court spanning A/B (e.g., "AC Gym - Court 10-AB")
  m = f.match(/^AC\s+Gym\s*-\s*Court\s+(\d{1,2})-AB$/i);
  if (m) {
    const num = parseInt(m[1], 10);
    if (!SPLITTABLE.includes(num)) return [];
    if (splitFlags[num]) return [`${num}A`, `${num}B`];
    return [String(num)];
  }

  // 3) GYM full gym combos
  if (/^AC\s+Gym\s*-\s*Full\s+Gym\s+1AB\s*&\s*2AB$/i.test(f)) {
    if (splitFlags[1] || splitFlags[2]) return ["1A","1B","2A","2B"];
    return ["1","2"];
  }
  if (/^AC\s+Gym\s*-\s*Full\s+Gym\s+9\s*&\s*10$/i.test(f)) {
    if (splitFlags[9] || splitFlags[10]) return ["9A","9B","10A","10B"];
    return ["9","10"];
  }

  // 4) Fieldhouse full/aggregate (always 3..8 single cells)
  if (/^AC\s*Fieldhouse\s*-\s*Full\s*Turf$/i.test(f)) {
    return ["3","4","5","6","7","8"];
  }
  if (/^AC\s*Fieldhouse\s*Court\s*3-8$/i.test(f)) {
    return ["3","4","5","6","7","8"];
  }

  // 5) Fieldhouse half turf north/south
  if (/^AC\s*Fieldhouse\s*-\s*Half\s*Turf\s*North$/i.test(f)) {
    return ["6","7","8"];
  }
  if (/^AC\s*Fieldhouse\s*-\s*Half\s*Turf\s*South$/i.test(f)) {
    return ["3","4","5"];
  }

  // 6) Fieldhouse quarter (temporary assumption)
  if (/^AC\s*Fieldhouse\s*-\s*Quarter\s*Turf\s*(NA|NB)$/i.test(f)) {
    return ["6","7","8"]; // map to North half by default
  }
  if (/^AC\s*Fieldhouse\s*-\s*Quarter\s*Turf\s*(SA|SB)$/i.test(f)) {
    return ["3","4","5"]; // map to South half by default
  }

  // 7) Fieldhouse - Court N  (3..8)
  m = f.match(/^AC\s*Fieldhouse\s*-\s*Court\s*(\d)$/i);
  if (m) {
    const n = parseInt(m[1], 10);
    if (n >= 3 && n <= 8) return [String(n)];
  }

  // 8) Championship Court = same as Courts 1 & 2
  if (/^AC\s*Gym\s*-\s*Championship\s*Court$/i.test(f) || /Championship\s*Court$/i.test(f)) {
    if (splitFlags[1] || splitFlags[2]) return ["1A","1B","2A","2B"];
    return ["1","2"];
  }

  // 9) Defensive duplicate of Court X-AB with flexible spacing
  m = f.match(/^AC\s*Gym\s*-\s*Court\s*(\d{1,2})-AB$/i);
  if (m) {
    const num = parseInt(m[1], 10);
    if (!SPLITTABLE.includes(num)) return [];
    return splitFlags[num] ? [`${num}A`, `${num}B`] : [String(num)];
  }

  // 10) Defensive: nothing matched
  return [];
}

// Rooms object (id+label) produced in visual order
function makeRoomsObj(orderedIds) {
  const rooms = {};
  for (const id of orderedIds) rooms[id] = { id, label: id };
  return rooms;
}

// Header normalization
function normalizeHeaderMap(headers) {
  // csv headers like: "Location:", "Facility", "Reserved Time", "Reservee", "Reservation Purpose", "Headcount"
  const map = {};
  headers.forEach((h) => {
    const k = h.toLowerCase().replace(/\s+/g, "").replace(/:$/, "");
    if (k === "location") map.location = h;
    else if (k === "facility") map.facility = h;
    else if (k === "reservedtime") map.reservedtime = h;
    else if (k === "reservee") map.reservee = h;
    else if (k === "reservationpurpose") map.reservationpurpose = h;
    else if (k === "headcount") map.headcount = h;
  });
  return map;
}

function writeJson(obj) {
  fs.writeFileSync(JSON_OUT, JSON.stringify(obj, null, 2), "utf8");
}

// --- MAIN ---
function main() {
  if (!fs.existsSync(CSV_PATH)) {
    console.log("No rows; wrote empty scaffold.");
    const ids = buildBoardRooms({1:false,2:false,9:false,10:false});
    writeJson({ dayStartMin: DAY_START_MIN, dayEndMin: DAY_END_MIN, rooms: makeRoomsObj(ids), slots: [] });
    return;
  }

  const raw = fs.readFileSync(CSV_PATH, "utf8");
  const { headers, rows } = parseCSV(raw);
  const keyMap = normalizeHeaderMap(headers);
  const need = ["location","facility","reservedtime","reservee","reservationpurpose","headcount"];
  for (const k of need) {
    if (!keyMap[k]) {
      console.log("No rows; wrote empty scaffold.");
      const ids = buildBoardRooms({1:false,2:false,9:false,10:false});
      writeJson({ dayStartMin: DAY_START_MIN, dayEndMin: DAY_END_MIN, rooms: makeRoomsObj(ids), slots: [] });
      return;
    }
  }

  // Only Athletic & Event Center
  const filtered = rows.filter(r => {
    const loc = (r[keyMap.location] || "").trim();
    return !loc || /Athletic\s*&\s*Event\s*Center/i.test(loc);
  });

  // Detect per-day splits based on explicit half-court usage
  const splitFlags = detectSplits(filtered, keyMap.facility);
  const BOARD_IDS = buildBoardRooms(splitFlags);

  const slots = [];
  let skipMap = 0, skipTime = 0;

  for (const r of filtered) {
    const fac   = (r[keyMap.facility] || "").trim();
    const time  = (r[keyMap.reservedtime] || "").trim();
    const who   = cleanRepeatedCommaSegments((r[keyMap.reservee] || "").trim());
    const what  = cleanRepeatedCommaSegments((r[keyMap.reservationpurpose] || "").trim());
    const hc    = Number(r[keyMap.headcount] || 0);

    const range = parseTimeRange(time);
    if (!range) { skipTime++; continue; }
    const { startMin, endMin } = range;
    if (endMin <= startMin) { skipTime++; continue; }

    const roomIds = facilityToRoomIds(fac, splitFlags);
    if (!roomIds.length) { skipMap++; continue; }

    for (const roomId of roomIds) {
      if (!BOARD_IDS.includes(roomId)) continue; // ignore if not on today’s layout
      slots.push({
        roomId,
        startMin, endMin,
        title: who,
        subtitle: what,
        headcount: hc
      });
    }
  }

  // per-room de-duplication: (roomId, start, end, title, subtitle)
  const seen = new Set();
  const unique = [];
  for (const s of slots) {
    const key = [
      s.roomId,
      s.startMin, s.endMin,
      (s.title || "").toLowerCase(),
      (s.subtitle || "").toLowerCase()
    ].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(s);
  }

  writeJson({
    dayStartMin: DAY_START_MIN,
    dayEndMin: DAY_END_MIN,
    rooms: makeRoomsObj(BOARD_IDS),
    slots: unique
  });

  console.log(`Wrote ${JSON_OUT} • rooms=${BOARD_IDS.length} • slots=${unique.length}`);
  console.log(`Row stats • total=${rows.length} kept=${unique.length} skipMap=${skipMap} skipTime=${skipTime}`);
}

main();
