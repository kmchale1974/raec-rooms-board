import fs from "fs";

/* ----------------------------- Config ----------------------------- */
const CSV_PATH = process.env.CSV_PATH || "data/inbox/latest.csv";
const JSON_OUT = process.env.JSON_OUT || "events.json";

// Building hours (06:00–23:00) in minutes since midnight
const DAY_START_MIN = 6 * 60;
const DAY_END_MIN = 23 * 60;

// Do NOT block on location by default
const ENFORCE_LOCATION = process.env.ENFORCE_LOCATION === "true";

// Court grid 1A..10B in display order
const COURT_NUMBERS = Array.from({ length: 10 }, (_, i) => i + 1);
const COURT_SIDES = ["A", "B"];
const ROOM_IDS = COURT_NUMBERS.flatMap((n) => COURT_SIDES.map((s) => `${n}${s}`));

/* ----------------------------- Helpers ---------------------------- */
const norm = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

function headerIndex(headers, names) {
  const targets = (Array.isArray(names) ? names : [names]).map(norm);
  for (let i = 0; i < headers.length; i++) {
    if (targets.includes(norm(headers[i]))) return i;
  }
  return -1;
}

function detectDelimiter(firstLine) {
  // Prefer tab if present in header row
  if (/\t/.test(firstLine)) return "\t";
  // Else choose the most frequent of common delimiters
  const cands = [",", ";", "|"];
  let best = { d: ",", count: -1 };
  for (const d of cands) {
    const count = firstLine.split(d).length;
    if (count > best.count) best = { d, count };
  }
  return best.d;
}

// Minimal CSV/TSV with quotes support
function parseSeparated(text, delimiter) {
  const rows = [];
  let row = [];
  let field = "";
  let i = 0;
  let inQuotes = false;
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          inQuotes = false; i++;
        }
      } else { field += c; i++; }
    } else {
      if (c === '"') { inQuotes = true; i++; }
      else if (c === delimiter) { row.push(field.trim()); field=""; i++; }
      else if (c === "\r") { i++; }
      else if (c === "\n") { row.push(field.trim()); rows.push(row); row=[]; field=""; i++; }
      else { field += c; i++; }
    }
  }
  if (field.length || row.length) { row.push(field.trim()); rows.push(row); }
  return rows;
}

function readCSVSmart(path) {
  if (!fs.existsSync(path)) return null;
  const text = fs.readFileSync(path, "utf8");
  if (!text.trim()) return null;

  const firstNL = text.indexOf("\n");
  const firstLine = firstNL >= 0 ? text.slice(0, firstNL) : text;
  const delimiter = detectDelimiter(firstLine);
  const rows = parseSeparated(text, delimiter);
  if (!rows || rows.length < 1) return null;

  console.log(
    `Detected headers: ${rows[0].map((h) => h || "<empty>").join(", ")} | delimiter=${JSON.stringify(delimiter)}`
  );

  // show some samples for debugging
  const showSample = (col) => {
    const idx = headerIndex(rows[0], [col, col.replace("time", " time"), `${col}:`]);
    if (idx >= 0) {
      const seen = new Set();
      for (let r = 1; r < rows.length && seen.size < 8; r++) {
        const v = (rows[r][idx] || "").trim();
        if (v) seen.add(v);
      }
      if (seen.size) console.log(`Samples • ${col}: ${Array.from(seen).join(" || ")}`);
    }
  };
  ["location", "facility", "reservedtime", "reservee", "reservationpurpose"].forEach(showSample);

  return rows;
}

/* ------------------------------ Time utils ------------------------------ */
function parseTime12hFlexible(s) {
  if (!s) return null;
  const cleaned = s.replace(/\s+/g, "").toLowerCase(); // handles NBSP/extra spaces
  // allow 9am, 4:30pm, 12:00am
  const m = cleaned.match(/^(\d{1,2})(?::(\d{2}))?([ap]m)$/);
  if (!m) return null;
  let hh = parseInt(m[1], 10);
  const mm = parseInt(m[2] || "0", 10);
  if (m[3] === "pm" && hh !== 12) hh += 12;
  if (m[3] === "am" && hh === 12) hh = 0;
  return hh * 60 + mm;
}

function parseReservedSpan(span) {
  if (!span) return null;
  // robust capture: "4:30pm -  9:30pm", "9am-10pm"
  const m = span.match(/(\d{1,2}(?::\d{2})?\s*[ap]m)\s*-\s*(\d{1,2}(?::\d{2})?\s*[ap]m)/i);
  if (!m) return null;
  const start = parseTime12hFlexible(m[1]);
  const end = parseTime12hFlexible(m[2]);
  if (start == null || end == null) return null;
  return [start, end];
}

function clampToDay(startMin, endMin) {
  const s = Math.max(startMin, DAY_START_MIN);
  const e = Math.min(endMin, DAY_END_MIN);
  return e > s ? [s, e] : null;
}

/* ------------------------------ Room mapping ------------------------------ */
function buildEmptyRooms() {
  const rooms = {};
  ROOM_IDS.forEach((id) => (rooms[id] = { id, label: id }));
  return rooms;
}

function extractRoomsFromFacility(facilityRaw) {
  if (!facilityRaw) return [];

  const facility = facilityRaw
    .replace(/[–—]/g, "-")        // normalize dashes
    .replace(/\s+/g, " ")         // collapse whitespace
    .trim();

  // AC Gym - Half Court 10A
  let m = facility.match(/AC\s*Gym\s*-\s*Half\s*Court\s*(\d{1,2})([AB])\b/i);
  if (m) {
    const id = `${parseInt(m[1], 10)}${m[2].toUpperCase()}`;
    return ROOM_IDS.includes(id) ? [id] : [];
  }

  // AC Gym - Court 9-AB  (or "Court 9 AB")
  m = facility.match(/AC\s*Gym\s*-\s*Court\s*(\d{1,2})\s*[- ]\s*AB\b/i);
  if (m) {
    const n = parseInt(m[1], 10);
    return [`${n}A`, `${n}B`].filter((id) => ROOM_IDS.includes(id));
  }

  // AC Fieldhouse Court 3-8   (no dash after Fieldhouse)
  m = facility.match(/AC\s*Fieldhouse\s*Court\s*(\d{1,2})\s*-\s*(\d{1,2})\b/i);
  if (m) {
    const a = parseInt(m[1], 10), b = parseInt(m[2], 10);
    const ids = [];
    for (let n = Math.min(a, b); n <= Math.max(a, b); n++) ids.push(`${n}A`, `${n}B`);
    return ids.filter((id) => ROOM_IDS.includes(id));
  }

  // AC Fieldhouse - Court 7  → 7A & 7B
  m = facility.match(/AC\s*Fieldhouse\s*-\s*Court\s*(\d{1,2})\b/i);
  if (m) {
    const n = parseInt(m[1], 10);
    return [`${n}A`, `${n}B`].filter((id) => ROOM_IDS.includes(id));
  }

  // Full Gym 9 & 10
  m = facility.match(/Full\s*Gym\s*(\d{1,2})\s*&\s*(\d{1,2})\b/i);
  if (m) {
    const a = parseInt(m[1], 10), b = parseInt(m[2], 10);
    return [`${a}A`, `${a}B`, `${b}A`, `${b}B`].filter((id) => ROOM_IDS.includes(id));
  }

  // Full Gym 1AB & 2AB
  m = facility.match(/Full\s*Gym\s*(\d{1,2})AB\s*&\s*(\d{1,2})AB\b/i);
  if (m) {
    const a = parseInt(m[1], 10), b = parseInt(m[2], 10);
    return [`${a}A`, `${a}B`, `${b}A`, `${b}B`].filter((id) => ROOM_IDS.includes(id));
  }

  // Championship Court → default to 1A/1B (adjust if needed)
  if (/Championship\s*Court/i.test(facility)) return ["1A", "1B"];

  // Generic fallbacks:
  //   "Court 5-AB" → 5A,5B
  m = facility.match(/Court\s*(\d{1,2})\s*[- ]\s*AB\b/i);
  if (m) {
    const n = parseInt(m[1], 10);
    return [`${n}A`, `${n}B`].filter((id) => ROOM_IDS.includes(id));
  }
  //   "Half Court 6A" → 6A
  m = facility.match(/Half\s*Court\s*(\d{1,2})([AB])\b/i);
  if (m) {
    const id = `${parseInt(m[1], 10)}${m[2].toUpperCase()}`;
    return ROOM_IDS.includes(id) ? [id] : [];
  }
  //   "Court 4" → 4A,4B
  m = facility.match(/Court\s*(\d{1,2})\b/i);
  if (m) {
    const n = parseInt(m[1], 10);
    return [`${n}A`, `${n}B`].filter((id) => ROOM_IDS.includes(id));
  }

  // Ignore turf + Fieldhouse turf blocks (board shows court grid only)
  if (/turf|fieldhouse\s*-\s*(full|half|quarter)\s*turf/i.test(facility)) return [];

  return [];
}

/* ---------------------------------- Main ---------------------------------- */
function main() {
  const rows = readCSVSmart(CSV_PATH);

  const out = {
    dayStartMin: DAY_START_MIN,
    dayEndMin: DAY_END_MIN,
    rooms: buildEmptyRooms(),
    slots: [],
  };

  if (!rows || rows.length < 2) {
    fs.writeFileSync(JSON_OUT, JSON.stringify(out, null, 2));
    console.log("No rows; wrote empty scaffold.");
    return;
  }

  const headers = rows[0];

  const idxLocation = headerIndex(headers, ["location", "location:"]);
  const idxFacility = headerIndex(headers, ["facility"]);
  const idxReserved = headerIndex(headers, ["reservedtime", "reserved time", "reservedtime:"]);
  const idxReservee = headerIndex(headers, ["reservee"]);
  const idxPurpose  = headerIndex(headers, ["reservationpurpose", "reservation purpose"]);

  if (idxFacility < 0 || idxReserved < 0) {
    console.log("Required headers not found. Headers were:", headers);
    fs.writeFileSync(JSON_OUT, JSON.stringify(out, null, 2));
    return;
  }

  const slots = [];
  const stats = { rows: 0, kept: 0, skipLoc: 0, skipMap: 0, skipTime: 0, skipClamp: 0 };

  for (let r = 1; r < rows.length; r++) {
    stats.rows++;
    const row = rows[r];

    const location = idxLocation >= 0 ? (row[idxLocation] || "") : "";
    if (ENFORCE_LOCATION && location && !/athletic\s*&\s*event\s*center/i.test(location)) {
      stats.skipLoc++; continue;
    }

    const facility = (row[idxFacility] || "").trim();
    const reservedSpan = (row[idxReserved] || "").trim();
    const reservee = idxReservee >= 0 ? (row[idxReservee] || "").trim() : "";
    const purpose  = idxPurpose  >= 0 ? (row[idxPurpose]  || "").trim() : "";

    const roomIds = extractRoomsFromFacility(facility);
    if (roomIds.length === 0) { stats.skipMap++; continue; }

    const span = parseReservedSpan(reservedSpan);
    if (!span) { stats.skipTime++; continue; }

    const [startRaw, endRaw] = span;
    const clamped = clampToDay(startRaw, endRaw);
    if (!clamped) { stats.skipClamp++; continue; }

    const [startMin, endMin] = clamped;
    const title = reservee || "Reserved";
    const subtitle = purpose || "";

    roomIds.forEach((roomId) => slots.push({ roomId, startMin, endMin, title, subtitle }));
    stats.kept++;
  }

  slots.sort((a, b) =>
    a.startMin - b.startMin ||
    a.endMin - b.endMin ||
    a.roomId.localeCompare(b.roomId)
  );

  out.slots = slots;
  fs.writeFileSync(JSON_OUT, JSON.stringify(out, null, 2));

  console.log(`Wrote ${JSON_OUT} • rooms=${Object.keys(out.rooms).length} • slots=${out.slots.length}`);
  console.log(`Row stats • total=${stats.rows} kept=${stats.kept} skipLoc=${stats.skipLoc} skipMap=${stats.skipMap} skipTime=${stats.skipTime} skipClamp=${stats.skipClamp}`);
}

main();
