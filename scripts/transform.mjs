// transform.mjs
// Read today's RecTrac CSV, map Facility -> roomId using facility-map.mjs,
// detect season from column E, and output events.json in the format
// the board expects.

import fs from "fs";
import { parse } from "csv-parse/sync";
import { FACILITY_TO_ROOMS } from "../facility-map.mjs";

// Adjust these indices if your CSV column order is different:
const COL_FACILITY = 1;  // Facility
const COL_TIMERANGE = 2; // Time (e.g., "7:30pm - 9:30pm")
const COL_RESERVEE = 3;  // Name (e.g., "Tendean, Audrey Felicite")
const COL_PURPOSE = 4;   // Program / Description
const COL_SEASON = 4;    // or wherever "Turf Season per NM" appears if different

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

// Season is entirely driven by column E text:
// If ANY row has "Turf Season per NM" exactly, it's turf, otherwise basketball/courts.
function detectSeason(records) {
  for (const row of records) {
    const text = String(row[COL_SEASON] || "").trim();
    if (text === "Turf Season per NM") {
      return "turf";
    }
  }
  // default if not present anywhere
  return "courts";
}

function loadSlotsFromCsv(csvPath) {
  const csvText = fs.readFileSync(csvPath, "utf8");

  // csv-parse will give array-of-arrays
  const records = parse(csvText, {
    skip_empty_lines: true,
  });

  // If there's a header row, drop it (assumes first row is header)
  const [header, ...rows] = records;

  const slots = [];
  const seen = new Set(); // de-dupe: roomId|start|end|title
  const unknownFacilities = new Set();

  for (const row of rows) {
    const facility = String(row[COL_FACILITY] || "").trim();
    const timeRange = String(row[COL_TIMERANGE] || "").trim();
    const reservee = String(row[COL_RESERVEE] || "").trim();
    const purpose = String(row[COL_PURPOSE] || "").trim();

    if (!facility || !timeRange || !reservee) {
      continue; // skip incomplete rows
    }

    const roomIds = FACILITY_TO_ROOMS[facility];

    if (roomIds === undefined) {
      // We haven't mapped this facility yet → track it for logging
      unknownFacilities.add(facility);
      continue;
    }

    if (roomIds.length === 0) {
      // Facility that we *deliberately* ignore for the rooms board
      continue;
    }

    const [startMin, endMin] = parseTimeRange(timeRange);
    if (startMin == null || endMin == null) {
      continue;
    }

    const title = reservee || "Reserved";
    const subtitle = purpose || "";

    for (const roomId of roomIds) {
      const key = `${roomId}|${startMin}|${endMin}|${title}`;
      if (seen.has(key)) continue; // prevents duplicates for combined facilities
      seen.add(key);

      slots.push({
        roomId,
        startMin,
        endMin,
        title,
        subtitle,
      });
    }
  }

  return { slots, unknownFacilities, records: rows };
}

// ---------- Main ----------

async function run() {
  // Use env vars if provided (from build.yml), otherwise fall back for local dev
  const inputCsv = process.env.IN_CSV || "./data/input.csv";
  const outputJson = process.env.OUT_JSON || "./events.json";

  console.log(`Using input CSV:  ${inputCsv}`);
  console.log(`Writing events to: ${outputJson}`);

  const { slots, unknownFacilities, records } = loadSlotsFromCsv(inputCsv);
  const season = detectSeason(records);

  const data = {
    season, // "turf" or "courts"
    slots,
  };

  fs.writeFileSync(outputJson, JSON.stringify(data, null, 2));

  if (unknownFacilities.size > 0) {
    console.warn("Unknown facilities found in CSV (not in FACILITY_TO_ROOMS):");
    for (const f of unknownFacilities) {
      console.warn("  -", f);
    }
  } else {
    console.log("All facilities in CSV matched FACILITY_TO_ROOMS.");
  }

  console.log(
    `Wrote ${slots.length} slots to ${outputJson} with season="${season}".`
  );
}

  // Log unknown facilities so you can add them to facility-map.mjs later
  if (unknownFacilities.size > 0) {
    console.warn("Unknown facilities found in CSV (not in FACILITY_TO_ROOMS):");
    for (const f of unknownFacilities) {
      console.warn("  -", f);
    }
  } else {
    console.log("All facilities in CSV matched FACILITY_TO_ROOMS.");
  }

  console.log(
    `Wrote ${slots.length} slots to ${outputJson} with season="${season}".`
  );
}

run().catch((err) => {
  console.error("transform.mjs failed:", err);
  process.exit(1);
});
