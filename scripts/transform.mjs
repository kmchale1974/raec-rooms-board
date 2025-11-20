// transform.mjs
// Logic:
//  - Group CSV rows by (reservee, purpose, timeRange)
//  - For each group, only create a room slot if ALL required facilities
//    for that room are present in that group's set of facilities
//  - Apply naming rules to produce title/subtitle
//  - Season is driven solely by "Turf Season per NM" in column E

import fs from "fs";
import { parse } from "csv-parse/sync";

// Column indices: A=0, B=1, C=2, ...
const COL_FACILITY = 1;  // "Facility"
const COL_TIMERANGE = 2; // "Time" (e.g. "10:00am - 11:00am")
const COL_RESERVEE = 3;  // "Reservee"
const COL_PURPOSE  = 4;  // "Reservation Purpose" (also used for season flag)
const COL_SEASON   = 4;

// ---------- Room rules: required facilities per room ----------
// For each roomId, ALL of the listed facilities must be present
// (same reservee, same purpose, same timeRange) for the reservation
// to count as being in that room.

const ROOM_RULES = [
  // Front cluster: 1A, 1B, 2A, 2B
  // Championship Court is now OPTIONAL; we only require:
  // Full Gym 1AB & 2AB + Court 1-AB/2-AB + the half court.
  {
    roomId: "1A",
    facilities: [
      "AC Gym - Full Gym 1AB & 2AB",
      "AC Gym - Court 1-AB",
      "AC Gym - Half Court 1A",
    ],
  },
  {
    roomId: "1B",
    facilities: [
      "AC Gym - Full Gym 1AB & 2AB",
      "AC Gym - Court 1-AB",
      "AC Gym - Half Court 1B",
    ],
  },
  {
    roomId: "2A",
    facilities: [
      "AC Gym - Full Gym 1AB & 2AB",
      "AC Gym - Court 2-AB",
      "AC Gym - Half Court 2A",
    ],
  },
  {
    roomId: "2B",
    facilities: [
      "AC Gym - Full Gym 1AB & 2AB",
      "AC Gym - Court 2-AB",
      "AC Gym - Half Court 2B",
    ],
  },

  // Fieldhouse courts: 3–8
  {
    roomId: "3",
    facilities: ["AC Fieldhouse Court 3-8", "AC Fieldhouse - Court 3"],
  },
  {
    roomId: "4",
    facilities: ["AC Fieldhouse Court 3-8", "AC Fieldhouse - Court 4"],
  },
  {
    roomId: "5",
    facilities: ["AC Fieldhouse Court 3-8", "AC Fieldhouse - Court 5"],
  },
  {
    roomId: "6",
    facilities: ["AC Fieldhouse Court 3-8", "AC Fieldhouse - Court 6"],
  },
  {
    roomId: "7",
    facilities: ["AC Fieldhouse Court 3-8", "AC Fieldhouse - Court 7"],
  },
  {
    roomId: "8",
    facilities: ["AC Fieldhouse Court 3-8", "AC Fieldhouse - Court 8"],
  },

  // Turf: NA / NB / SA / SB
  // Use whatever roomIds your front-end expects here.
  {
    roomId: "Quarter Turf NA",
    facilities: [
      "AC Fieldhouse - Full Turf",
      "AC Fieldhouse - Half Turf North",
      "AC Fieldhouse - Quarter Turf NA",
    ],
  },
  {
    roomId: "Quarter Turf NB",
    facilities: [
      "AC Fieldhouse - Full Turf",
      "AC Fieldhouse - Half Turf North",
      "AC Fieldhouse - Quarter Turf NB",
    ],
  },
  {
    roomId: "Quarter Turf SA",
    facilities: [
      "AC Fieldhouse - Full Turf",
      "AC Fieldhouse - Half Turf South",
      "AC Fieldhouse - Quarter Turf SA",
    ],
  },
  {
    roomId: "Quarter Turf SB",
    facilities: [
      "AC Fieldhouse - Full Turf",
      "AC Fieldhouse - Half Turf South",
      "AC Fieldhouse - Quarter Turf SB",
    ],
  },

  // Back cluster: 9A, 9B, 10A, 10B
  {
    roomId: "9A",
    facilities: [
      "AC Gym - Full Gym 9 & 10",
      "AC Gym - Court 9-AB",
      "AC Gym - Half Court 9A",
    ],
  },
  {
    roomId: "9B",
    facilities: [
      "AC Gym - Full Gym 9 & 10",
      "AC Gym - Court 9-AB",
      "AC Gym - Half Court 9B",
    ],
  },
  {
    roomId: "10A",
    facilities: [
      "AC Gym - Full Gym 9 & 10",
      "AC Gym - Court 10-AB",
      "AC Gym - Half Court 10A",
    ],
  },
  {
    roomId: "10B",
    facilities: [
      "AC Gym - Full Gym 9 & 10",
      "AC Gym - Court 10-AB",
      "AC Gym - Half Court 10B",
    ],
  },
];

// ---------- Naming rules ----------

function normalizeReservee(rawReservee) {
  let r = (rawReservee || "").trim();
  if (!r) return "";

  const parts = r.split(",");
  if (parts.length === 2) {
    const left = parts[0].trim();
    const right = parts[1].trim();

    // 1) Collapse exact duplicates like
    //    "Chicago Sport and Social Club, Chicago Sport and Social Club"
    //    or "Illinois Express Basketball, Illinois Express Basketball"
    if (left && right && left.toLowerCase() === right.toLowerCase()) {
      return left;
    }

    // 2) "Last, First" -> "First Last" when it looks like a person name
    const leftHasSpace = left.includes(" ");
    const rightHasComma = right.includes(",");
    if (!leftHasSpace && !rightHasComma && left && right) {
      // e.g. "Smith, John" -> "John Smith"
      return `${right} ${left}`;
    }
  }

  return r;
}

function makeTitleSubtitle(reserveeRaw, purposeRaw) {
  const reservee = normalizeReservee(reserveeRaw);
  const purpose = (purposeRaw || "").trim();

  const lowerR = reservee.toLowerCase();
  const lowerP = purpose.toLowerCase();

  // Open Pickleball / Open Gym
  if (lowerR.includes("open pickleball") || lowerP.includes("open pickleball")) {
    return { title: "Open Pickleball", subtitle: "" };
  }
  if (lowerR.includes("open gym") || lowerP.includes("open gym")) {
    return { title: "Open Gym", subtitle: "" };
  }

  // Catch Corner: keep "Catch Corner" in title, booking detail in subtitle
  if (lowerR.includes("catch corner") || lowerP.includes("catch corner")) {
    const title = "Catch Corner";
    const subtitle = purpose || reservee;
    return { title, subtitle };
  }

  // If no reservee but purpose present → purpose as title
  if (!reservee && purpose) {
    return { title: purpose, subtitle: "" };
  }

  // Default: reservee as title, purpose as subtitle
  if (reservee && purpose) {
    return { title: reservee, subtitle: purpose };
  }
  if (reservee && !purpose) {
    return { title: reservee, subtitle: "" };
  }

  // Fallback
  return { title: "Reserved", subtitle: "" };
}

// ---------- Helpers ----------

// "7:30pm -  9:30pm" -> [startMin, endMin]
function parseTimeRange(rangeStr) {
  if (!rangeStr) return [null, null];

  const parts = rangeStr.split("-");
  if (parts.length !== 2) return [null, null];

  const [startRaw, endRaw] = parts.map((s) => s.trim());

  const toMin = (s) => {
    const m = s.match(/^(\d{1,2}):(\d{2})(am|pm)$/i);
    if (!m) return null;

    let [, hh, mm, ampm] = m;
    let h = parseInt(hh, 10);
    const minutes = parseInt(mm, 10);
    ampm = ampm.toLowerCase();

    if (ampm === "pm" && h !== 12) h += 12;
    if (ampm === "am" && h === 12) h = 0;

    return h * 60 + minutes;
  };

  return [toMin(startRaw), toMin(endRaw)];
}

// Season: if ANY row in column E is "Turf Season per NM" → turf, else courts
function detectSeason(rows) {
  for (const row of rows) {
    const text = String(row[COL_SEASON] || "").trim();
    if (text === "Turf Season per NM") {
      return "turf";
    }
  }
  return "courts";
}

// ---------- Core CSV → slots logic using group + AND rules ----------

function loadSlotsFromCsv(csvPath) {
  const csvText = fs.readFileSync(csvPath, "utf8");

  const records = parse(csvText, {
    skip_empty_lines: true,
  });

  const [header, ...rows] = records;

  // Group rows into logical reservations by (reservee, purpose, timeRange)
  const groups = new Map();
  const allFacilities = new Set(); // for debugging

  for (const row of rows) {
    const facility = String(row[COL_FACILITY] || "").trim();
    const timeRange = String(row[COL_TIMERANGE] || "").trim();
    const reservee = String(row[COL_RESERVEE] || "").trim();
    const purpose  = String(row[COL_PURPOSE]  || "").trim();

    if (!facility || !timeRange || !reservee) continue;

    allFacilities.add(facility);

    const key = `${reservee}||${purpose}||${timeRange}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        reservee,
        purpose,
        timeRange,
        facilities: new Set(),
      };
      groups.set(key, g);
    }
    g.facilities.add(facility);
  }

  const slots = [];
  const seenSlots = new Set();

  for (const group of groups.values()) {
    const [startMin, endMin] = parseTimeRange(group.timeRange);
    if (startMin == null || endMin == null) continue;

    const facilitiesSet = group.facilities;
    const { title, subtitle } = makeTitleSubtitle(
      group.reservee,
      group.purpose
    );

    for (const rule of ROOM_RULES) {
      // Check if ALL required facilities are present for this room
      const ok = rule.facilities.every((needed) =>
        facilitiesSet.has(needed)
      );
      if (!ok) continue;

      const key = `${rule.roomId}|${startMin}|${endMin}|${title}`;
      if (seenSlots.has(key)) continue;
      seenSlots.add(key);

      slots.push({
        roomId: rule.roomId,
        startMin,
        endMin,
        title,
        subtitle,
      });
    }
  }

  return { slots, rows, allFacilities };
}

// ---------- Main ----------

async function run() {
  // Use env vars from build.yml if provided, otherwise fall back for local dev
  const inputCsv   = process.env.IN_CSV   || "./data/input.csv";
  const outputJson = process.env.OUT_JSON || "./events.json";

  console.log(`Using input CSV:  ${inputCsv}`);
  console.log(`Writing events to: ${outputJson}`);

  const { slots, rows, allFacilities } = loadSlotsFromCsv(inputCsv);
  const season = detectSeason(rows);

  const data = {
    season, // "turf" or "courts"
    slots,
  };

  fs.writeFileSync(outputJson, JSON.stringify(data, null, 2));

  console.log("Facilities seen in CSV (for debugging):");
  for (const f of Array.from(allFacilities).sort()) {
    console.log("  -", f);
  }

  console.log(
    `Wrote ${slots.length} slots to ${outputJson} with season="${season}".`
  );
}

run().catch((err) => {
  console.error("transform.mjs failed:", err);
  process.exit(1);
});
