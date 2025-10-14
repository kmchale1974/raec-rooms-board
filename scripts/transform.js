/**
 * scripts/transform.js
 *
 * Reads a CSV exported from your booking system and writes a normalized events.json
 * for the rooms board. Designed to be resilient to minor header/name/time variations.
 *
 * ENV:
 *  - CSV_PATH=/path/to/input.csv            (default: data/inbox/latest.csv)
 *  - JSON_OUT=events.json                   (default: events.json at repo root)
 *  - TZ=America/Chicago                     (default: America/Chicago)
 *  - FORCE_ALL=true                         (bypass facility/location filters)
 *  - VERBOSE=true                           (extra console output)
 */

const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const { DateTime } = require('luxon');

// ---------- config ----------
const CSV_PATH = process.env.CSV_PATH || path.join('data', 'inbox', 'latest.csv');
const JSON_OUT = process.env.JSON_OUT || 'events.json';
const tz = process.env.TZ || 'America/Chicago';
const FORCE_ALL = /^true$/i.test(String(process.env.FORCE_ALL || ''));
const VERBOSE = /^true$/i.test(String(process.env.VERBOSE || ''));

// “Site filter” — only include the Athletic & Event Center (AC) unless FORCE_ALL=true
const AC_LOCATION_NAMES = new Set([
  'athletic & event center',
  'athletic and event center',
  'athletic & events center',
  'ac', // just in case exports ever abbreviate
]);

// Facility patterns to keep (unless FORCE_ALL). We’re lenient with spacing/ casing.
const AC_FACILITY_PAT = /\bAC\b/i;

// Map long facility names into your board’s canonical room IDs (optional; keep original if missing).
const ROOM_CANONICAL_MAP = [
  // Fieldhouse / Turf
  [/^ac fieldhouse\s*-\s*full turf$/i, 'AC Fieldhouse - Full Turf'],
  [/^ac fieldhouse\s*-\s*half turf north$/i, 'AC Fieldhouse - Half Turf North'],
  [/^ac fieldhouse\s*-\s*half turf south$/i, 'AC Fieldhouse - Half Turf South'],

  // Gym courts
  [/^ac gym\s*-\s*court\s*9-?ab$/i, 'AC Gym - Court 9-AB'],
  [/^ac gym\s*-\s*court\s*10-?ab$/i, 'AC Gym - Court 10-AB'],
  [/^ac gym\s*-\s*half court\s*9a$/i, 'AC Gym - Half Court 9A'],
  [/^ac gym\s*-\s*half court\s*10a$/i, 'AC Gym - Half Court 10A'],
  [/^ac gym\s*-\s*half court\s*10b$/i, 'AC Gym - Half Court 10B'],
];

// ---------- tiny utils ----------

// Ensure there is a space before am/pm so Luxon "h:mm a" can parse strings like "9:00am".
function withSpaceAMPM(s) {
  return s ? String(s).replace(/\s*([ap]m)\b/i, ' $1').replace(/\s+/g, ' ').trim() : s;
}

function clean(s) {
  if (s == null) return '';
  return String(s).replace(/\u00A0/g, ' ').trim();
}

function lc(s) {
  return clean(s).toLowerCase();
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) out[k] = obj[k];
  return out;
}

function detectDelimiter(sample) {
  // Very simple: choose comma unless semicolons outnumber commas in the first line.
  const firstLine = sample.split(/\r?\n/)[0] || '';
  const commas = (firstLine.match(/,/g) || []).length;
  const semis = (firstLine.match(/;/g) || []).length;
  return semis > commas ? ';' : ',';
}

// ---------- time parsing ----------

/**
 * Parse a time range string into DateTimes.
 * Supports:
 *  - "M/D/YYYY h:mm am - h:mm pm"
 *  - "M/D/YYYY h:mm am - M/D/YYYY h:mm pm"
 *  - "h:mmam - h:mmpm"  (date implied by fallbackDateISO)
 */
function parseTimeRange(value, fallbackDateISO) {
  const v = clean(value);
  if (!v) return null;

  // 1) M/D/YYYY h:mm AM/PM - h:mm AM/PM
  let m = v.match(/^(\d{1,2}\/\d{1,2}\/\d{2,4})\s+(\d{1,2}:\d{2}\s*[ap]m)\s*-\s*(\d{1,2}:\d{2}\s*[ap]m)$/i);
  if (m) {
    const d = m[1];
    const t1 = withSpaceAMPM(m[2]);
    const t2 = withSpaceAMPM(m[3]);
    const start = DateTime.fromFormat(`${d} ${t1}`, 'M/d/yyyy h:mm a', { zone: tz });
    let end = DateTime.fromFormat(`${d} ${t2}`, 'M/d/yyyy h:mm a', { zone: tz });
    if (end <= start) end = end.plus({ days: 1 });
    if (start.isValid && end.isValid) return { start, end };
  }

  // 2) M/D/YYYY h:mm AM/PM - M/D/YYYY h:mm AM/PM
  m = v.match(/^(\d{1,2}\/\d{1,2}\/\d{2,4})\s+(\d{1,2}:\d{2}\s*[ap]m)\s*-\s*(\d{1,2}\/\d{1,2}\/\d{2,4})\s+(\d{1,2}:\d{2}\s*[ap]m)$/i);
  if (m) {
    const d1 = m[1];
    const t1 = withSpaceAMPM(m[2]);
    const d2 = m[3];
    const t2 = withSpaceAMPM(m[4]);
    const start = DateTime.fromFormat(`${d1} ${t1}`, 'M/d/yyyy h:mm a', { zone: tz });
    const end = DateTime.fromFormat(`${d2} ${t2}`, 'M/d/yyyy h:mm a', { zone: tz });
    if (start.isValid && end.isValid) return { start, end };
  }

  // 3) h:mmam - h:mmpm (needs fallback date)
  m = v.match(/^(\d{1,2}:\d{2}\s*[ap]m)\s*-\s*(\d{1,2}:\d{2}\s*[ap]m)$/i);
  if (m && fallbackDateISO) {
    const d = DateTime.fromISO(fallbackDateISO, { zone: tz });
    const t1 = withSpaceAMPM(m[1]);
    const t2 = withSpaceAMPM(m[2]);
    const start = DateTime.fromFormat(`${d.toFormat('M/d/yyyy')} ${t1}`, 'M/d/yyyy h:mm a', { zone: tz });
    let end = DateTime.fromFormat(`${d.toFormat('M/d/yyyy')} ${t2}`, 'M/d/yyyy h:mm a', { zone: tz });
    if (end <= start) end = end.plus({ days: 1 });
    if (start.isValid && end.isValid) return { start, end };
  }

  return null;
}

/**
 * Build a range from split columns (date, start time, end time).
 */
function buildRange({ sd, st, ed, et }) {
  const startDate = clean(sd);
  const endDate = clean(ed);
  st = withSpaceAMPM(clean(st));
  et = withSpaceAMPM(clean(et));

  if (startDate && st && et && !endDate) {
    const start = DateTime.fromFormat(`${startDate} ${st}`, 'M/d/yyyy h:mm a', { zone: tz });
    let end = DateTime.fromFormat(`${startDate} ${et}`, 'M/d/yyyy h:mm a', { zone: tz });
    if (end <= start) end = end.plus({ days: 1 });
    if (start.isValid && end.isValid) return { start, end };
  }

  if (startDate && st && endDate && et) {
    const start = DateTime.fromFormat(`${startDate} ${st}`, 'M/d/yyyy h:mm a', { zone: tz });
    const end = DateTime.fromFormat(`${endDate} ${et}`, 'M/d/yyyy h:mm a', { zone: tz });
    if (start.isValid && end.isValid) return { start, end };
  }

  return null;
}

// ---------- main ----------

function readCSV(fp) {
  if (!fs.existsSync(fp)) return { records: [], headers: [] };
  const raw = fs.readFileSync(fp, 'utf8');
  const delim = detectDelimiter(raw);
  const records = parse(raw, {
    columns: (h) => h.map((s) => lc(s)),
    skip_empty_lines: true,
    trim: true,
    delimiter: delim,
  });
  const headers = Object.keys(records[0] || {});
  console.log(`Detected headers: ${headers.join(', ')} | delimiter="${delim}"`);
  return { records, headers, delimiter: delim };
}

function canonicalRoomName(s) {
  const val = clean(s);
  for (const [re, out] of ROOM_CANONICAL_MAP) {
    if (re.test(val)) return out;
  }
  return val; // default to original
}

function looksLikeAC(row) {
  if (FORCE_ALL) return true;

  const loc = lc(row.location || '');
  const fac = lc(row.facility || '');

  // Pass if location is clearly AC
  if (AC_LOCATION_NAMES.has(loc)) return true;

  // Or if facility has "AC"
  if (AC_FACILITY_PAT.test(fac)) return true;

  return false;
}

function firstN(sampleArr, n = 8) {
  return sampleArr.filter(Boolean).slice(0, n);
}

function inferDateForTimeslot(row) {
  // If the CSV has an explicit date column, prefer it. Else default to "today" in TZ.
  const candidates = ['date', 'eventdate', 'startdate', 'start date'];
  for (const k of candidates) {
    if (row[k]) {
      const dt = DateTime.fromFormat(clean(row[k]), 'M/d/yyyy', { zone: tz });
      if (dt.isValid) return dt.toISODate();
    }
  }
  // Default to "today" in the configured timezone
  return DateTime.now().setZone(tz).toISODate();
}

function buildTitle(row) {
  const reservee = clean(row.reservee || row['reserved by'] || '');
  const purpose = clean(row.reservationpurpose || row.purpose || '');
  if (purpose && reservee) return `${purpose} — ${reservee}`;
  return purpose || reservee || 'Reserved';
}

function main() {
  if (!fs.existsSync(CSV_PATH)) {
    console.log(`No CSV at ${CSV_PATH}.`);
    fs.writeFileSync(JSON_OUT, JSON.stringify({ rooms: [], slots: [] }, null, 2));
    return;
  }

  const { records, headers } = readCSV(CSV_PATH);
  if (!records.length) {
    console.log('No rows found.');
    fs.writeFileSync(JSON_OUT, JSON.stringify({ rooms: [], slots: [] }, null, 2));
    return;
  }

  // Friendly samples for debugging
  const sampleLoc = new Set();
  const sampleFac = new Set();
  const sampleTime = new Set();

  // Collect events per room
  const perRoom = new Map();

  let rowsParsed = 0;
  let eventsFound = 0;

  for (const row of records) {
    rowsParsed++;

    const location = clean(row.location);
    const facility = clean(row.facility);
    const reservedtime = clean(row.reservedtime || row['reserved time'] || row.time || '');

    if (location) sampleLoc.add(location);
    if (facility) sampleFac.add(facility);
    if (reservedtime) sampleTime.add(reservedtime);

    // Filter to AC unless FORCE_ALL
    if (!looksLikeAC(row)) continue;

    // Determine room key
    const roomKey = canonicalRoomName(facility || location || 'Unknown');

    // Determine start/end
    let range = null;

    // If we have a single "reservedtime" field like "9:30am - 12:30pm"
    if (reservedtime) {
      const fallbackDateISO = inferDateForTimeslot(row);
      range = parseTimeRange(reservedtime, fallbackDateISO);
    }

    // Try split fields if needed
    if (!range) {
      range = buildRange({
        sd: row.startdate || row['start date'] || row.date,
        ed: row.enddate || row['end date'],
        st: row.starttime || row['start time'],
        et: row.endtime || row['end time'],
      });
    }

    if (!range) continue; // skip if we can’t parse

    const title = buildTitle(row);
    const headcount = clean(row.headcount);
    const extra = clean(row.questionanswerall || '');

    const evt = {
      title,
      room: roomKey,
      start: range.start.toISO(),
      end: range.end.toISO(),
      meta: {},
    };

    if (headcount) evt.meta.headcount = headcount;
    if (extra) evt.meta.notes = extra;

    if (!perRoom.has(roomKey)) perRoom.set(roomKey, []);
    perRoom.get(roomKey).push(evt);
    eventsFound++;
  }

  // Sort each room’s events by start time; also build a flat list of 15-min slots covering the day
  const rooms = [...perRoom.keys()].sort();
  const events = [];
  for (const r of rooms) {
    const list = perRoom.get(r).sort((a, b) => a.start.localeCompare(b.start));
    events.push(...list);
  }

  // Build display “slots” (36 half-hour or 96 quarter-hour ticks; we’ll use 30-min)
  // If you need 15-min granularity change step to { minutes: 15 } and update board.
  const startOfDay = DateTime.now().setZone(tz).startOf('day').plus({ hours: 6 });  // 6:00 AM
  const endOfDay = startOfDay.plus({ hours: 18 }); // through midnight (6 AM -> midnight = 18h)
  const slots = [];
  for (let t = startOfDay; t < endOfDay; t = t.plus({ minutes: 30 })) {
    slots.push(t.toISO());
  }

  const out = {
    rooms,
    events,
    slots,
    tz,
    generatedAt: DateTime.now().setZone(tz).toISO(),
  };

  // Friendly logging like the CI output you shared
  if (sampleLoc.size) {
    console.log(`Samples • location: ${firstN([...sampleLoc]).join(' || ')}`);
  }
  if (sampleFac.size) {
    console.log(`Samples • facility: ${firstN([...sampleFac]).join(' || ')}`);
  }
  if (sampleTime.size) {
    console.log(`Samples • reservedtime: ${firstN([...sampleTime]).join(' || ')}`);
  }
  console.log(`Rows parsed: ${rowsParsed}`);
  console.log(`Events found: ${eventsFound}`);

  if (eventsFound === 0 && !FORCE_ALL) {
    console.log(
      'No AC events matched. Check Samples above; if times are from a different day than today, we can add a date source.'
    );
  } else if (eventsFound === 0 && FORCE_ALL) {
    console.log(
      'No events matched even with FORCE_ALL=true. Check time format and header names.'
    );
  }

  fs.writeFileSync(JSON_OUT, JSON.stringify(out, null, 2));
  console.log(`Wrote ${JSON_OUT} • rooms=${rooms.length} • slots=${slots.length}`);
}

try {
  main();
} catch (err) {
  console.error('transform.js failed:', err && err.stack ? err.stack : err);
  process.exitCode = 1;
}
