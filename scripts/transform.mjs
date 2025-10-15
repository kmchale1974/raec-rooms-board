// scripts/transform.mjs
import fs from "fs";

/** ---------------------------------- Config ---------------------------------- */
const CSV_PATH = process.env.CSV_PATH || "data/inbox/latest.csv";
const JSON_OUT = process.env.JSON_OUT || "events.json";

// Building hours 06:00–23:00 (minutes since midnight)
const DAY_START_MIN = 6 * 60;
const DAY_END_MIN = 23 * 60;

// Room grid 1A..10B
const COURT_NUMBERS = Array.from({ length: 10 }, (_, i) => i + 1);
const COURT_SIDES = ["A", "B"];
const ROOM_IDS = COURT_NUMBERS.flatMap((n) => COURT_SIDES.map((s) => `${n}${s}`));

/** ---------------------------- Small helper utils --------------------------- */
const norm = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

function headerIndex(headers, names) {
  const targets = (Array.isArray(names) ? names : [names]).map(norm);
  for (let i = 0; i < headers.length; i++) if (targets.includes(norm(headers[i]))) return i;
  return -1;
}

function detectDelimiter(firstLine) {
  // Try common ones; pick the one with the most splits
  const cands = ["\t", ",", ";", "|"];
  let best = { d: ",", count: -1 };
  for (const d of cands) {
    const count = firstLine.split(d).length;
    if (count > best.count) best = { d, count };
  }
  return best.d;
}

/** ------------------------------- CSV/TSV parser ------------------------------ */
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
      } else if (c === delimiter) {
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
    `Detected headers: ${rows[0].map((h) => h || "<empty>").join(", ")} | delimiter=${JSON.stringify(
      delimiter
    )}`
  );

  // Show quick samples for debugging in Actions log
  const colNames = rows[0].map((h) => norm(h));
  const demoCols = ["location", "facility", "reservedtime", "reservee"];
  const demo = {};
  demoCols.forEach((c) => {
    const idx = headerIndex(rows[0], [c, c.replace("time", " time")]);
    if (idx >= 0) {
      for (let r = 1; r < rows.length && (!demo[c] || demo[c].length < 6); r++) {
        const v = (rows[r][idx] || "").trim();
        if (v) (demo[c] ||= new Set()).add(v);
      }
    }
  });
  Object.entries(demo).forEach(([k, set]) => {
    console.log(`Samples • ${k}: ${Array.from(set).slice(0, 8).join(" || ")}`);
  });

  return rows;
}

/** ---------------------------- Time parsing helpers --------------------------- */
function parseTime12h(s) {
  if (!s) return null;
  const cleaned = s.trim().replace(/\s+/g, "").toLowerCase(); // e.g. "4:00pm"
  const m = cleaned.match(/^(\d{1,2})(?::(\d{2}))?([ap]m)$/i);
  if (!m) return null;
  let hh = parseInt(m[1], 10);
  const mm = parseInt(m[2] || "0", 10);
  const ampm = m[3];
  if (ampm === "pm" && hh !== 12) hh += 12;
  if (ampm === "am" && hh === 12) hh = 0;
  return hh * 60 + mm;
}

function parseReservedSpan(span) {
  // "4:00pm -  7:00pm" or "9:30am - 12:30pm"
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

/** --------------------------- Rooms + mapping logic --------------------------- */
function buildEmptyRooms() {
  const rooms = {};
  ROOM_IDS.forEach((id) => (rooms[id] = { id, label: id }));
  return rooms;
}

function extractRoomsFromFacility(facility) {
  if (!facility) return [];

  // 1) AC Gym - Half Court 9A
  let m = facility.match(/AC\s*Gym\s*-\s*Half\s*Court\s*(\d{1,2})([AB])/i);
  if (m) {
    const id = `${parseInt(m[1], 10)}${m[2].toUpperCase()}`;
    return ROOM_IDS.includes(id) ? [id] : [];
  }

  // 2) AC Gym - Court 9-AB
  m = facility.match(/AC\s*Gym\s*-\s*Court\s*(\d{1,2})\s*-\s*AB/i);
  if (m) {
    const n = parseInt(m[1], 10);
    return [`${n}A`, `${n}B`].filter((id) => ROOM_IDS.includes(id));
  }

  // 3) AC Fieldhouse Court 3-8  (no hyphen after Fieldhouse)
  m = facility.match(/AC\s*Fieldhouse\s*Court\s*(\d{1,2})\s*-\s*(\d{1,2})/i);
  if (m) {
    const a = parseInt(m[1], 10);
    const b = parseInt(m[2], 10);
    const ids = [];
    for (let n = Math.min(a, b); n <= Math.max(a, b); n++) ids.push(`${n}A`, `${n}B`);
    return ids.filter((id) => ROOM_IDS.includes(id));
  }

  // 4) AC Fieldhouse - Court 7  → 7A & 7B
  m = facility.match(/AC\s*Fieldhouse\s*-\s*Court\s*(\d{1,2})/i);
  if (m) {
    const n = parseInt(m[1], 10);
    return [`${n}A`, `${n}B`].filter((id) => ROOM_IDS.includes(id));
  }

  // 5) Full Gym 9 & 10
  m = facility.match(/Full\s*Gym\s*(\d{1,2})\s*&\s*(\d{1,2})/i);
  if (m) {
    const a = parseInt(m[1], 10);
    const b = parseInt(m[2], 10);
    const ids = [`${a}A`, `${a}B`, `${b}A`, `${b}B`];
    return ids.filter((id) => ROOM_IDS.includes(id));
  }

  // 6) Full Gym 1AB & 2AB  (treat AB as both halves on each number)
  m = facility.match(/Full\s*Gym\s*(\d{1,2})AB\s*&\s*(\d{1,2})AB/i);
  if (m) {
    const a = parseInt(m[1], 10);
    const b = parseInt(m[2], 10);
    const ids = [`${a}A`, `${a}B`, `${b}A`, `${b}B`];
    return ids.filter((id) => ROOM_IDS.includes(id));
  }

  // 7) Championship Court → map to Court 1 (A & B) by default
  if (/Championship\s*Court/i.test(facility)) {
    return ["1A", "1B"];
  }

  // Ignore turf and non-gym areas for this board
  if (/turf|fieldhouse\s*-\s*(full|half|quarter)/i.test(facility)) return [];

  return [];
}

/** ----------------------------------- Main ----------------------------------- */
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
  const idxPurpose = headerIndex(headers, ["reservationpurpose", "reservation purpose"]);

  if (idxFacility < 0 || idxReserved < 0) {
    console.log("Required headers not found. Headers were:", headers);
    fs.writeFileSync(JSON_OUT, JSON.stringify(out, null, 2));
    return;
  }

  const slots = [];

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];

    const location = idxLocation >= 0 ? (row[idxLocation] || "") : "";
    // Keep RAEC, but don't crash if blank
    if (location && !/athletic\s*&\s*event\s*center/i.test(location)) continue;

    const facility = (row[idxFacility] || "").trim();
    const reservedSpan = (row[idxReserved] || "").trim();
    const reservee = idxReservee >= 0 ? (row[idxReservee] || "").trim() : "";
    const purpose = idxPurpose >= 0 ? (row[idxPurpose] || "").trim() : "";

    // Facility → room ids
    const roomIds = extractRoomsFromFacility(facility);
    if (roomIds.length === 0) continue;

    // Time span → minutes
    const span = parseReservedSpan(reservedSpan);
    if (!span) continue;

    const [startRaw, endRaw] = span;
    const clamped = clampToDay(startRaw, endRaw);
    if (!clamped) continue;

    const [startMin, endMin] = clamped;
    const title = reservee || "Reserved";
    const subtitle = purpose || "";

    roomIds.forEach((roomId) =>
      slots.push({ roomId, startMin, endMin, title, subtitle })
    );
  }

  // Sort by time, then room
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
