// ESM version (works with "type": "module")
import fs from "fs";
import fsp from "fs/promises";
import path from "path";

// --- Config --------------------------------------------------------------

// Facilities we want to show on the gym board, mapped to board cells.
// Multi-court entries like "9-AB" expand to both halves.
const FACILITY_TO_BOARD_CELL = {
  "AC Gym - Court 3": ["3"],
  "AC Gym - Court 4": ["4"],
  "AC Gym - Court 5": ["5"],
  "AC Gym - Court 6": ["6"],
  "AC Gym - Court 7": ["7"],
  "AC Gym - Court 8": ["8"],

  "AC Gym - Court 9-AB": ["9A", "9B"],
  "AC Gym - Half Court 9A": ["9A"],
  "AC Gym - Half Court 9B": ["9B"],

  "AC Gym - Court 10-AB": ["10A", "10B"],
  "AC Gym - Half Court 10A": ["10A"],
  "AC Gym - Half Court 10B": ["10B"],

  // If you ever decide to surface 1A/1B/2A/2B, just uncomment or add:
  // "AC Gym - Half Court 1A": ["1A"],
  // "AC Gym - Half Court 1B": ["1B"],
  // "AC Gym - Half Court 2A": ["2A"],
  // "AC Gym - Half Court 2B": ["2B"],
};

// Building hours (local) for the board timeline – used only for validation/clipping if needed
const DAY_START_MIN = 6 * 60;   // 6:00 AM
const DAY_END_MIN   = 23 * 60;  // 11:00 PM

// Inputs/outputs via env (keeps your action step the same)
const CSV_PATH = process.env.CSV_PATH || "data/inbox/latest.csv";
const JSON_OUT = process.env.JSON_OUT || "events.json";

// --- Helpers -------------------------------------------------------------

const todayLocal = () => {
  const now = new Date();
  // Normalize to today’s local yyyy-mm-dd
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
};

const toMinutes = (h, m, ampm) => {
  let hh = parseInt(h, 10);
  const mm = parseInt(m || "0", 10);
  const ap = (ampm || "").toLowerCase();
  if (ap === "pm" && hh !== 12) hh += 12;
  if (ap === "am" && hh === 12) hh = 0;
  return hh * 60 + mm;
};

// Parse strings like "6:00pm - 9:00pm" or "7:30am -  9:00am"
const parseReservedTime = (s) => {
  if (!s) return null;
  const str = s.replace(/\s+/g, " ").trim().toLowerCase();
  // e.g. "6:00pm - 9:00pm"
  const m = str.match(
    /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*-\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/
  );
  if (!m) return null;
  const [, h1, m1, ap1, h2, m2, ap2] = m;
  let startMin = toMinutes(h1, m1, ap1);
  let endMin = toMinutes(h2, m2, ap2);

  // Handle cases that roll past midnight (shouldn’t happen here, but safe)
  if (endMin <= startMin) endMin += 24 * 60;
  return { startMin, endMin };
};

// very small CSV parser good enough for CivicRec exports (comma, quotes)
const parseCsv = (text) => {
  const rows = [];
  let i = 0;
  let field = "";
  let row = [];
  let inQuotes = false;

  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    rows.push(row);
    row = [];
  };

  while (i < text.length) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        // check for escaped double quote
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          inQuotes = false;
          i++;
        }
      } else {
        field += ch;
        i++;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
        i++;
      } else if (ch === ",") {
        pushField();
        i++;
      } else if (ch === "\n") {
        pushField();
        pushRow();
        i++;
      } else if (ch === "\r") {
        // handle CRLF
        i++;
      } else {
        field += ch;
        i++;
      }
    }
  }
  // last field/row
  if (field.length > 0 || row.length > 0) {
    pushField();
    pushRow();
  }
  return rows;
};

const indexHeaders = (headers) => {
  const map = {};
  headers.forEach((h, idx) => {
    const key = h.trim().toLowerCase();
    map[key] = idx;
  });
  return map;
};

const pick = (row, headersIdx, name) => {
  const idx = headersIdx[name];
  return idx == null ? "" : String(row[idx] || "").trim();
};

// Compose an event label
const makeLabel = (reservee, purpose) => {
  const who = reservee || "";
  const why = purpose ? ` — ${purpose}` : "";
  return (who + why).trim();
};

// --- Main ---------------------------------------------------------------

const run = async () => {
  if (!fs.existsSync(CSV_PATH)) {
    console.log(`CSV not found at ${CSV_PATH}. Writing empty ${JSON_OUT}.`);
    await fsp.writeFile(
      JSON_OUT,
      JSON.stringify(
        { generatedAt: new Date().toISOString(), rooms: {}, slots: [] },
        null,
        2
      )
    );
    return;
  }

  const buf = await fsp.readFile(CSV_PATH, "utf8");
  if (!buf.trim()) {
    console.log(`CSV empty at ${CSV_PATH}. Writing empty ${JSON_OUT}.`);
    await fsp.writeFile(
      JSON_OUT,
      JSON.stringify(
        { generatedAt: new Date().toISOString(), rooms: {}, slots: [] },
        null,
        2
      )
    );
    return;
  }

  const rows = parseCsv(buf);
  if (rows.length === 0) {
    console.log("No CSV rows parsed.");
    return;
  }

  const headers = rows[0].map((s) => s.trim());
  const idx = indexHeaders(headers);

  // Expected CivicRec columns (case-insensitive):
  // location, facility, reservedtime, reservee, reservationpurpose, headcount, questionanswerall
  const required = ["location", "facility", "reservedtime"];
  const missing = required.filter((k) => idx[k] == null);
  if (missing.length) {
    console.log(
      `Missing headers: ${missing.join(
        ", "
      )}. Found headers=${headers.join(" | ")}`
    );
  }

  // Sample logging (helps when Action runs)
  const sample = (col) =>
    rows
      .slice(1, 9)
      .map((r) => pick(r, idx, col))
      .filter(Boolean)
      .slice(0, 8);

  const locSamples = sample("location");
  const facSamples = sample("facility");
  const timeSamples = sample("reservedtime");

  if (locSamples.length) {
    console.log(`Samples • location: ${[...new Set(locSamples)].join(" || ")}`);
  }
  if (facSamples.length) {
    console.log(`Samples • facility: ${[...new Set(facSamples)].join(" || ")}`);
  }
  if (timeSamples.length) {
    console.log(
      `Samples • reservedtime: ${[...new Set(timeSamples)].join(" || ")}`
    );
  }

  // Build events per board-cell
  const eventsByRoom = {}; // { "3": [ {startMin,endMin,label}, ... ], "9A": [...] }

  const today = todayLocal(); // we assume report is for "today"
  const dayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 0, 0, 0);

  // Iterate CSV data rows
  let parsedRows = 0;
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.length === 0) continue;

    const facility = pick(row, idx, "facility");
    const reservedTime = pick(row, idx, "reservedtime");
    const reservee = pick(row, idx, "reservee");
    const purpose = pick(row, idx, "reservationpurpose");

    // Only gym items that we know how to map
    const cells = FACILITY_TO_BOARD_CELL[facility];
    if (!cells) continue;

    const t = parseReservedTime(reservedTime);
    if (!t) continue;

    // Clip to building hours just in case
    const startMin = Math.max(t.startMin, DAY_START_MIN);
    const endMin = Math.min(t.endMin, DAY_END_MIN);
    if (endMin <= startMin) continue;

    const label = makeLabel(reservee, purpose);

    cells.forEach((cell) => {
      if (!eventsByRoom[cell]) eventsByRoom[cell] = [];
      eventsByRoom[cell].push({ startMin, endMin, label });
    });

    parsedRows++;
  }

  // Normalize & sort
  Object.keys(eventsByRoom).forEach((cell) => {
    eventsByRoom[cell].sort((a, b) => a.startMin - b.startMin);
  });

  // Build fixed slots (every 30 mins) for the front-end grid from DAY_START_MIN..DAY_END_MIN
  const slots = [];
  for (let m = DAY_START_MIN; m <= DAY_END_MIN; m += 30) {
    slots.push(m); // minutes since midnight local
  }

  // Write JSON in the shape the board expects
  const out = {
    generatedAt: new Date().toISOString(),
    dayStartMin: DAY_START_MIN,
    dayEndMin: DAY_END_MIN,
    slotIntervalMin: 30,
    rooms: eventsByRoom, // keyed by "3","4","5","6","7","8","9A","9B","10A","10B"
    slots,                // array of minute marks used to draw columns
  };

  await fsp.writeFile(JSON_OUT, JSON.stringify(out, null, 2));

  const roomCount = Object.keys(eventsByRoom).length;
  console.log(
    `Rows parsed: ${rows.length - 1}\nEvents found: ${roomCount ? Object.values(eventsByRoom).reduce((a, v) => a + v.length, 0) : 0}`
  );

  if (!roomCount) {
    console.log(
      "No AC Gym events matched. Check the “Samples • facility” lines above; the mapping can be extended if needed."
    );
  } else {
    console.log(
      `Wrote ${JSON_OUT} • rooms=${roomCount} • slots=${slots.length}`
    );
  }
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
