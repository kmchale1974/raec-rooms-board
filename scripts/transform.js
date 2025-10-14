/**
 * scripts/transform.js
 *
 * Reads the AC CSV and writes a normalized events.json for the whiteboard.
 *
 * ENV:
 *  - CSV_PATH (default: data/inbox/latest.csv)
 *  - JSON_OUT (default: events.json)
 *  - TZ (default: America/Chicago)
 *  - FORCE_ALL=true (bypass AC filtering)
 *  - VERBOSE=true (extra logs)
 */

const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const { DateTime } = require('luxon');

const CSV_PATH = process.env.CSV_PATH || path.join('data', 'inbox', 'latest.csv');
const JSON_OUT = process.env.JSON_OUT || 'events.json';
const tz = process.env.TZ || 'America/Chicago';
const FORCE_ALL = /^true$/i.test(String(process.env.FORCE_ALL || ''));
const VERBOSE = /^true$/i.test(String(process.env.VERBOSE || ''));

// —— Site filter: keep only the Athletic & Event Center (unless FORCE_ALL) ——
const AC_LOCATION_NAMES = new Set([
  'athletic & event center',
  'athletic and event center',
  'athletic & events center',
  'ac',
]);

const AC_FACILITY_PAT = /\bAC\b/i;

// —— Board mapping ————————————————————————————————————————————————
// Map booking-system facility strings to board cell IDs.
// If a booking reserves a *full* court (e.g. "9-AB"), we return both halves
// so the event appears in each cell on the physical board.
function toBoardRooms(rawFacility) {
  const f = (rawFacility || '').trim().toLowerCase();

  // 9/10 courts (right-side stack on the board)
  if (/(^|\s)ac gym\s*-\s*half court\s*9a$/i.test(rawFacility)) return ['9A'];
  if (/(^|\s)ac gym\s*-\s*half court\s*9b$/i.test(rawFacility)) return ['9B'];
  if (/(^|\s)ac gym\s*-\s*half court\s*10a$/i.test(rawFacility)) return ['10A'];
  if (/(^|\s)ac gym\s*-\s*half court\s*10b$/i.test(rawFacility)) return ['10B'];

  if (/(^|\s)ac gym\s*-\s*court\s*9-?ab$/i.test(rawFacility)) return ['9A', '9B'];
  if (/(^|\s)ac gym\s*-\s*court\s*10-?ab$/i.test(rawFacility)) return ['10A', '10B'];

  // If your CSV ever lists center courts explicitly, map them here:
  // e.g., "AC Gym - Court 3" => "3"
  const mCourt = String(rawFacility || '').match(/ac gym\s*-\s*court\s*(\d{1,2})\b/i);
  if (mCourt) return [mCourt[1]];

  // Fieldhouse/turf (optional): if you later want these on board cells (3–8),
  // add explicit mappings here. For now we leave them unmapped so they pass
  // through as-is and still render in the app’s room list.
  // Examples if you want to pin them:
  // if (/^ac fieldhouse\s*-\s*full turf$/i.test(rawFacility)) return ['3','4','5','6','7','8'];
  // if (/^ac fieldhouse\s*-\s*half turf north$/i.test(rawFacility)) return ['3','4','5'];
  // if (/^ac fieldhouse\s*-\s*half turf south$/i.test(rawFacility)) return ['6','7','8'];

  return null; // unknown → let canonical name fall through
}

// For rooms that don’t map to a board cell, keep a clean canonical name.
function canonicalRoomName(s) {
  return (s || '').toString().replace(/\u00A0/g, ' ').trim();
}

// Suggested display order to mirror the whiteboard (optional for your UI)
const ROOMS_DISPLAY_ORDER = [
  '2B','2A','1B','1A',  // left stack
  '5','4','3','6','7','8', // middle columns (the photo shows 3–8)
  '10B','10A','9B','9A', // right stack top→bottom
];

// —— helpers ————————————————————————————————————————————————
function withSpaceAMPM(s) {
  return s ? String(s).replace(/\s*([ap]m)\b/i, ' $1').replace(/\s+/g, ' ').trim() : s;
}
function clean(s) { return s == null ? '' : String(s).replace(/\u00A0/g, ' ').trim(); }
function lc(s) { return clean(s).toLowerCase(); }
function firstN(arr, n=8) { return arr.filter(Boolean).slice(0,n); }

function detectDelimiter(sample) {
  const first = (sample.split(/\r?\n/)[0] || '');
  const commas = (first.match(/,/g) || []).length;
  const semis = (first.match(/;/g) || []).length;
  return semis > commas ? ';' : ',';
}

// —— time parsing ———————————————————————————————————————————————
function parseTimeRange(value, fallbackDateISO) {
  const v = clean(value);
  if (!v) return null;

  // 1) M/D/YYYY h:mm am - h:mm pm
  let m = v.match(/^(\d{1,2}\/\d{1,2}\/\d{2,4})\s+(\d{1,2}:\d{2}\s*[ap]m)\s*-\s*(\d{1,2}:\d{2}\s*[ap]m)$/i);
  if (m) {
    const [_, d, t1Raw, t2Raw] = m;
    const t1 = withSpaceAMPM(t1Raw);
    const t2 = withSpaceAMPM(t2Raw);
    const start = DateTime.fromFormat(`${d} ${t1}`, 'M/d/yyyy h:mm a', { zone: tz });
    let end  = DateTime.fromFormat(`${d} ${t2}`, 'M/d/yyyy h:mm a', { zone: tz });
    if (end <= start) end = end.plus({ days: 1 });
    if (start.isValid && end.isValid) return { start, end };
  }

  // 2) M/D/YYYY h:mm am - M/D/YYYY h:mm pm
  m = v.match(/^(\d{1,2}\/\d{1,2}\/\d{2,4})\s+(\d{1,2}:\d{2}\s*[ap]m)\s*-\s*(\d{1,2}\/\d{1,2}\/\d{2,4})\s+(\d{1,2}:\d{2}\s*[ap]m)$/i);
  if (m) {
    const [_, d1, t1Raw, d2, t2Raw] = m;
    const t1 = withSpaceAMPM(t1Raw);
    const t2 = withSpaceAMPM(t2Raw);
    const start = DateTime.fromFormat(`${d1} ${t1}`, 'M/d/yyyy h:mm a', { zone: tz });
    const end   = DateTime.fromFormat(`${d2} ${t2}`, 'M/d/yyyy h:mm a', { zone: tz });
    if (start.isValid && end.isValid) return { start, end };
  }

  // 3) h:mmam - h:mmpm (date implied)
  m = v.match(/^(\d{1,2}:\d{2}\s*[ap]m)\s*-\s*(\d{1,2}:\d{2}\s*[ap]m)$/i);
  if (m && fallbackDateISO) {
    const d = DateTime.fromISO(fallbackDateISO, { zone: tz });
    const t1 = withSpaceAMPM(m[1]);
    const t2 = withSpaceAMPM(m[2]);
    const start = DateTime.fromFormat(`${d.toFormat('M/d/yyyy')} ${t1}`, 'M/d/yyyy h:mm a', { zone: tz });
    let end  = DateTime.fromFormat(`${d.toFormat('M/d/yyyy')} ${t2}`, 'M/d/yyyy h:mm a', { zone: tz });
    if (end <= start) end = end.plus({ days: 1 });
    if (start.isValid && end.isValid) return { start, end };
  }

  return null;
}

function buildRange({ sd, st, ed, et }) {
  const startDate = clean(sd);
  const endDate   = clean(ed);
  st = withSpaceAMPM(clean(st));
  et = withSpaceAMPM(clean(et));

  if (startDate && st && et && !endDate) {
    const start = DateTime.fromFormat(`${startDate} ${st}`, 'M/d/yyyy h:mm a', { zone: tz });
    let end  = DateTime.fromFormat(`${startDate} ${et}`, 'M/d/yyyy h:mm a', { zone: tz });
    if (end <= start) end = end.plus({ days: 1 });
    if (start.isValid && end.isValid) return { start, end };
  }
  if (startDate && st && endDate && et) {
    const start = DateTime.fromFormat(`${startDate} ${st}`, 'M/d/yyyy h:mm a', { zone: tz });
    const end   = DateTime.fromFormat(`${endDate} ${et}`, 'M/d/yyyy h:mm a', { zone: tz });
    if (start.isValid && end.isValid) return { start, end };
  }
  return null;
}

// —— CSV IO ————————————————————————————————————————————————
function readCSV(fp) {
  if (!fs.existsSync(fp)) return { records: [], headers: [] };
  const raw = fs.readFileSync(fp, 'utf8');
  const delimiter = detectDelimiter(raw);
  const records = parse(raw, {
    columns: (h) => h.map((s) => lc(s)),
    skip_empty_lines: true,
    trim: true,
    delimiter,
  });
  const headers = Object.keys(records[0] || {});
  console.log(`Detected headers: ${headers.join(', ')} | delimiter="${delimiter}"`);
  return { records, headers, delimiter };
}

function looksLikeAC(row) {
  if (FORCE_ALL) return true;
  const loc = lc(row.location || '');
  const fac = lc(row.facility || '');
  if (AC_LOCATION_NAMES.has(loc)) return true;
  if (AC_FACILITY_PAT.test(fac)) return true;
  return false;
}

function inferDateForTimeslot(row) {
  for (const k of ['date','eventdate','startdate','start date']) {
    if (row[k]) {
      const dt = DateTime.fromFormat(clean(row[k]), 'M/d/yyyy', { zone: tz });
      if (dt.isValid) return dt.toISODate();
    }
  }
  return DateTime.now().setZone(tz).toISODate();
}

function buildTitle(row) {
  const reservee = clean(row.reservee || row['reserved by'] || '');
  const purpose  = clean(row.reservationpurpose || row.purpose || '');
  if (purpose && reservee) return `${purpose} — ${reservee}`;
  return purpose || reservee || 'Reserved';
}

// —— MAIN ————————————————————————————————————————————————
function main() {
  if (!fs.existsSync(CSV_PATH)) {
    console.log(`No CSV at ${CSV_PATH}.`);
    fs.writeFileSync(JSON_OUT, JSON.stringify({ rooms: [], events: [], slots: [] }, null, 2));
    return;
  }

  const { records } = readCSV(CSV_PATH);
  if (!records.length) {
    console.log('No rows found.');
    fs.writeFileSync(JSON_OUT, JSON.stringify({ rooms: [], events: [], slots: [] }, null, 2));
    return;
  }

  const sampleLoc = new Set();
  const sampleFac = new Set();
  const sampleTime = new Set();

  const perRoom = new Map();
  let rowsParsed = 0, eventsFound = 0;

  for (const row of records) {
    rowsParsed++;

    const location    = clean(row.location);
    const facilityRaw = clean(row.facility);
    const reservedRaw = clean(row.reservedtime || row['reserved time'] || row.time || '');

    if (location) sampleLoc.add(location);
    if (facilityRaw) sampleFac.add(facilityRaw);
    if (reservedRaw) sampleTime.add(reservedRaw);

    if (!looksLikeAC(row)) continue;

    // figure rooms for the board
    const boardRooms = toBoardRooms(facilityRaw);
    const roomFallback = canonicalRoomName(facilityRaw || location || 'Unknown');

    // parse time
    let range = null;
    if (reservedRaw) {
      range = parseTimeRange(reservedRaw, inferDateForTimeslot(row));
    }
    if (!range) {
      range = buildRange({
        sd: row.startdate || row['start date'] || row.date,
        ed: row.enddate   || row['end date'],
        st: row.starttime || row['start time'],
        et: row.endtime   || row['end time'],
      });
    }
    if (!range) continue;

    const base = {
      title: buildTitle(row),
      start: range.start.toISO(),
      end: range.end.toISO(),
      meta: {},
    };
    const headcount = clean(row.headcount);
    const extra = clean(row.questionanswerall || '');
    if (headcount) base.meta.headcount = headcount;
    if (extra) base.meta.notes = extra;

    // push to each mapped room (full-court → both halves). If no mapping,
    // fall back to the canonical facility name.
    const targets = boardRooms && boardRooms.length ? boardRooms : [roomFallback];
    for (const r of targets) {
      const evt = { ...base, room: r };
      if (!perRoom.has(r)) perRoom.set(r, []);
      perRoom.get(r).push(evt);
      eventsFound++;
    }
  }

  // Sort and flatten
  const rooms = [...perRoom.keys()].sort((a, b) => {
    const ia = ROOMS_DISPLAY_ORDER.indexOf(a);
    const ib = ROOMS_DISPLAY_ORDER.indexOf(b);
    if (ia >= 0 && ib >= 0) return ia - ib;
    if (ia >= 0) return -1;
    if (ib >= 0) return 1;
    return String(a).localeCompare(String(b));
  });

  const events = [];
  for (const r of rooms) {
    const list = perRoom.get(r).sort((a, b) => a.start.localeCompare(b.start));
    events.push(...list);
  }

  // 30-min display slots from 6:00am–midnight
  const startOfDay = DateTime.now().setZone(tz).startOf('day').plus({ hours: 6 });
  const endOfDay   = startOfDay.plus({ hours: 18 });
  const slots = [];
  for (let t = startOfDay; t < endOfDay; t = t.plus({ minutes: 30 })) {
    slots.push(t.toISO());
  }

  // friendly logs to match your CI output
  if (sampleLoc.size)  console.log(`Samples • location: ${firstN([...sampleLoc]).join(' || ')}`);
  if (sampleFac.size)  console.log(`Samples • facility: ${firstN([...sampleFac]).join(' || ')}`);
  if (sampleTime.size) console.log(`Samples • reservedtime: ${firstN([...sampleTime]).join(' || ')}`);
  console.log(`Rows parsed: ${rowsParsed}`);
  console.log(`Events found: ${eventsFound}`);
  if (eventsFound === 0) {
    console.log('No AC events matched. If the CSV has different court labels, tell me and I’ll add them.');
  }

  fs.writeFileSync(JSON_OUT, JSON.stringify({
    rooms, events, slots, tz,
    generatedAt: DateTime.now().setZone(tz).toISO(),
    roomsDisplayOrder: ROOMS_DISPLAY_ORDER,
  }, null, 2));
  console.log(`Wrote ${JSON_OUT} • rooms=${rooms.length} • slots=${slots.length}`);
}

try {
  main();
} catch (err) {
  console.error('transform.js failed:', err && err.stack ? err.stack : err);
  process.exitCode = 1;
}
