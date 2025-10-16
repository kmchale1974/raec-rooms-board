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

/* ------------------------------------------------------------------ */
/* Season rules                                                        */
/* Basketball flooring period: 3rd Monday in March  -> 2nd Monday Nov */
/* Turf period:                   otherwise (Nov 2nd Mon -> Mar 3rd)  */
/* ------------------------------------------------------------------ */

// 0=Sun..6=Sat
function nthWeekdayOfMonth(year, monthIndex, weekday, n) {
  const d = new Date(Date.UTC(year, monthIndex, 1));
  const firstW = d.getUTCDay();
  let offset = (weekday - firstW + 7) % 7; // days to first <weekday>
  offset += (n - 1) * 7;
  d.setUTCDate(1 + offset);
  return d; // UTC date at 00:00
}

function isBasketballFloorSeason(dateUtc /* Date in UTC */) {
  const y = dateUtc.getUTCFullYear();

  const thirdMondayMarch = nthWeekdayOfMonth(y, 2 /*Mar*/, 1 /*Mon*/, 3);
  const secondMondayNov  = nthWeekdayOfMonth(y, 10/*Nov*/, 1 /*Mon*/, 2);

  // If date is before March 3rd-Mon, it belongs to previous year's turf span;
  // but our rule is only needed to decide if BETWEEN Mar(3rd Mon) and Nov(2nd Mon)
  // is basketball-floor season. Everything else (outside) is turf season.
  return dateUtc >= thirdMondayMarch && dateUtc < secondMondayNov;
}

// Optional manual override via env (useful for testing):
//   SEASON_FORCE=basketball  or  SEASON_FORCE=turf
function getSeasonNow() {
  const force = (process.env.SEASON_FORCE || "").toLowerCase();
  if (force === "basketball") return { basketball: true };
  if (force === "turf")       return { basketball: false };
  // Use current UTC date to avoid TZ ambiguity in runners
  const now = new Date();
  // Normalize to UTC midnight (date-only comparison)
  const todayUtc = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()
  ));
  return { basketball: isBasketballFloorSeason(todayUtc) };
}

/* ------------------------------------------------------------------ */
/* CSV parsing & time helpers                                          */
/* ------------------------------------------------------------------ */
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
  // "4:30pm -  6:00pm" or "9:00am - 10:00pm"
  const m = s.toLowerCase().match(
    /(\d{1,2}):?(\d{2})?\s*(am|pm)\s*-\s*(\d{1,2}):?(\d{2})?\s*(am|pm)/
  );
  if (!m) return null;
  const [, sh, sm = "00", sap, eh, em = "00", eap] = m;
  let start = toMin(sh, sm, sap);
  let end   = toMin(eh, em, eap);
  if (end <= start) end += 12 * 60;
  start = clampToDay(start);
  end   = clampToDay(end);
  if (end <= start) return null;
  return { startMin: start, endMin: end };
}

// remove repeated comma segments (e.g., "Extreme Volleyball, Extreme Volleyball")
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

/* ------------------------------------------------------------------ */
/* Split detection & room model                                        */
/* ------------------------------------------------------------------ */
function detectSplits(rows, keyFacility) {
  const split = { 1:false, 2:false, 9:false, 10:false };

  for (const r of rows) {
    const fac = (r[keyFacility] || "").trim();
    const m = fac.match(/^AC\s+Gym\s*-\s*Half\s+Court\s+(\d{1,2})([AB])$/i);
    if (m) {
      const num = parseInt(m[1], 10);
      if (SPLITTABLE.includes(num)) split[num] = true;
      continue;
    }
    // If you also want Court X-AB to force split, uncomment:
    // const m2 = fac.match(/^AC\s+Gym\s*-\s*Court\s+(\d{1,2})-AB$/i);
    // if (m2) { const num = parseInt(m2[1], 10); if (SPLITTABLE.includes(num)) split[num] = true; }
  }
  return split;
}

function buildBoardRooms(splitFlags) {
  const rooms = [];
  if (splitFlags[1]) rooms.push("1A","1B"); else rooms.push("1");
  if (splitFlags[2]) rooms.push("2A","2B"); else rooms.push("2");
  rooms.push("3","4","5","6","7","8");
  if (splitFlags[9]) rooms.push("9A","9B"); else rooms.push("9");
  if (splitFlags[10]) rooms.push("10A","10B"); else rooms.push("10");
  return rooms;
}

function makeRoomsObj(orderedIds) {
  const rooms = {};
  for (const id of orderedIds) rooms[id] = { id, label: id };
  return rooms;
}

/* ------------------------------------------------------------------ */
/* Facility mapping (with season-aware turf filtering)                 */
/* ------------------------------------------------------------------ */
function isTurfFacility(f) {
  return /^AC\s*Fieldhouse\s*-\s*(Full\s*Turf|Half\s*Turf\s*(North|South)|Quarter\s*Turf\s*(NA|NB|SA|SB))$/i.test(f);
}

function facilityToRoomIds(fac, splitFlags, season) {
  if (!fac) return [];
  const f = fac.trim();

  // If basketball-floor season, ignore turf-related Fieldhouse items entirely
  if (season.basketball && isTurfFacility(f)) {
    return []; // filtered out during March(3rd Mon) -> Nov(2nd Mon)
  }

  // 1) GYM half courts (explicit split)
  let m = f.match(/^AC\s+Gym\s*-\s*Half\s+Court\s+(\d{1,2})([AB])$/i);
  if (m) {
    const num = parseInt(m[1], 10);
    const ab  = m[2].toUpperCase();
    if (SPLITTABLE.includes(num)) return [`${num}${ab}`];
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

  // 4) Fieldhouse full/aggregate (3..8 single cells)
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
    return ["6","7","8"]; // map to North half
  }
  if (/^AC\s*Fieldhouse\s*-\s*Quarter\s*Turf\s*(SA|SB)$/i.test(f)) {
    return ["3","4","5"]; // map to South half
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

  // 9) Defensive duplicate of Court X-AB
  m = f.match(/^AC\s*Gym\s*-\s*Court\s*(\d{1,2})-AB$/i);
  if (m) {
    const num = parseInt(m[1], 10);
    if (!SPLITTABLE.includes(num)) return [];
    return splitFlags[num] ? [`${num}A`, `${num}B`] : [String(num)];
  }

  return [];
}

/* ------------------------------------------------------------------ */
/* Header normalization                                                */
/* ------------------------------------------------------------------ */
function normalizeHeaderMap(headers) {
  // e.g. "Location:", "Facility", "Reserved Time", "Reservee", "Reservation Purpose", "Headcount"
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

/* ------------------------------------------------------------------ */
/* MAIN                                                                */
/* ------------------------------------------------------------------ */
function main() {
  const season = getSeasonNow(); // { basketball: true|false }

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
  let skipMap = 0, skipTime = 0, skipSeason = 0;

  for (const r of filtered) {
    const fac   = (r[keyMap.facility] || "").trim();
    const time  = (r[keyMap.reservedtime] || "").trim();
    const who   = cleanRepeatedCommaSegments((r[keyMap.reservee] || "").trim());
    const what  = cleanRepeatedCommaSegments((r[keyMap.reservationpurpose] || "").trim());
    const hc    = Number(r[keyMap.headcount] || 0);

    // Season filter: if basketball-floor season, turf facilities are dropped
    if (season.basketball && isTurfFacility(fac)) {
      skipSeason++; 
      continue;
    }

    const range = parseTimeRange(time);
    if (!range) { skipTime++; continue; }
    const { startMin, endMin } = range;
    if (endMin <= startMin) { skipTime++; continue; }

    const roomIds = facilityToRoomIds(fac, splitFlags, season);
    if (!roomIds.length) { skipMap++; continue; }

    for (const roomId of roomIds) {
      if (!BOARD_IDS.includes(roomId)) continue;
      slots.push({
        roomId,
        startMin, endMin,
        title: who,
        subtitle: what,
        headcount: hc
      });
    }
  }

  // per-room de-duplication
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

  console.log(`Season: ${season.basketball ? "basketball-floor" : "turf"}`);
  console.log(`Wrote ${JSON_OUT} • rooms=${BOARD_IDS.length} • slots=${unique.length}`);
  console.log(`Row stats • total=${rows.length} kept=${unique.length} skipSeason=${skipSeason} skipMap=${skipMap} skipTime=${skipTime}`);
}

main();
