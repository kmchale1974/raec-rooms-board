// scripts/transform.js
import fs from 'fs';
import { parse } from 'csv-parse/sync';
import { DateTime } from 'luxon';

const CSV_PATH = process.env.CSV_PATH || 'data/inbox/latest.csv';
const OUT = process.env.JSON_OUT || 'events.json';
const SLOT_MIN = Number(process.env.SLOT_MIN || 30);
const FORCE_ALL = String(process.env.FORCE_ALL || '').toLowerCase() === 'true'; // set to true to skip AC filter

const tz = 'America/Chicago';

// ---------- helpers ----------
const norm = s => (s ?? '')
  .toString()
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '');

// pick the first present key from candidates
function pick(obj, keys) {
  for (const k of keys) {
    if (k in obj && obj[k] !== undefined && obj[k] !== '') return obj[k];
  }
  return undefined;
}

function parseTimeRange(value) {
  if (!value) return null;
  const v = String(value).trim();

  // 1) "M/D/YYYY h:mm AM - h:mm PM" (same day)
  let m = v.match(/^(\d{1,2}\/\d{1,2}\/\d{4})\s+(\d{1,2}:\d{2}\s*[AP]M)\s*-\s*(\d{1,2}:\d{2}\s*[AP]M)$/i);
  if (m) {
    const [ , d1, t1, t2 ] = m;
    const start = DateTime.fromFormat(`${d1} ${t1}`, 'M/d/yyyy h:mm a', { zone: tz });
    let end = DateTime.fromFormat(`${d1} ${t2}`, 'M/d/yyyy h:mm a', { zone: tz });
    if (end <= start) end = end.plus({ days: 1 });
    return { start, end };
  }
  // 2) "M/D/YYYY h:mm AM - M/D/YYYY h:mm PM"
  m = v.match(/^(\d{1,2}\/\d{1,2}\/\d{4})\s+(\d{1,2}:\d{2}\s*[AP]M)\s*-\s*(\d{1,2}\/\d{1,2}\/\d{4})\s+(\d{1,2}:\d{2}\s*[AP]M)$/i);
  if (m) {
    const [ , d1, t1, d2, t2 ] = m;
    const start = DateTime.fromFormat(`${d1} ${t1}`, 'M/d/yyyy h:mm a', { zone: tz });
    const end   = DateTime.fromFormat(`${d2} ${t2}`, 'M/d/yyyy h:mm a', { zone: tz });
    return { start, end };
  }
  return null;
}

// build from separate columns
function buildRange({sd, st, ed, et}) {
  if (!sd || !st || !et) return null;
  const start = DateTime.fromFormat(`${sd} ${st}`, 'M/d/yyyy h:mm a', { zone: tz });
  let end;
  if (ed) {
    end = DateTime.fromFormat(`${ed} ${et}`, 'M/d/yyyy h:mm a', { zone: tz });
  } else {
    // if end date missing, assume same day
    end = DateTime.fromFormat(`${sd} ${et}`, 'M/d/yyyy h:mm a', { zone: tz });
    if (end <= start) end = end.plus({ days: 1 });
  }
  if (!start.isValid || !end.isValid) return null;
  return { start, end };
}

// ---------- read CSV with flexible settings ----------
const raw = fs.readFileSync(CSV_PATH, 'utf8');

// Try common delimiters
const delimiters = [',', ';', '\t'];
let rows = [];
let usedDelimiter = ',';
for (const d of delimiters) {
  try {
    rows = parse(raw, {
      bom: true,
      delimiter: d,
      columns: header => header.map(h => norm(String(h).replace(/:$/, ''))),
      skip_empty_lines: true,
      relax_column_count: true,
      trim: true
    });
    if (rows.length) { usedDelimiter = d; break; }
  } catch {}
}

// No rows at all?
if (!rows.length) {
  console.log('CSV parsed but found 0 rows. Check delimiter/encoding.');
  fs.writeFileSync(OUT, JSON.stringify({ tz, slotMin: SLOT_MIN, rooms: [], slots: [], occupancy: {} }));
  process.exit(0);
}

// Log detected headers (first row keys)
const headerKeys = Object.keys(rows[0] || {});
console.log('Detected headers:', headerKeys.join(', '), `| delimiter="${usedDelimiter === '\t' ? 'TAB' : usedDelimiter}"`);

// ---------- header variants ----------
const ROOM_KEYS     = ['location', 'resourcelabel', 'resource', 'facilityname', 'room', 'areaname', 'space'];
const FACILITY_KEYS = ['facility', 'site', 'locationfacility', 'building', 'center'];
const TIME_KEYS     = ['reservedtime', 'time', 'reservationtime', 'startend', 'starttoend', 'reservation', 'dateandtime'];

// Separate columns variants
const START_DATE_KEYS = ['startdate', 'fromdate', 'date', 'begindate'];
const START_TIME_KEYS = ['starttime', 'fromtime', 'timein', 'begintime'];
const END_DATE_KEYS   = ['enddate', 'todate', 'finishdate'];
const END_TIME_KEYS   = ['endtime', 'totime', 'timeout', 'finishtime'];

const PURPOSE_KEYS  = ['reservationpurpose', 'purpose', 'event', 'program', 'activity', 'description'];

// ---------- row extraction ----------
const events = [];

for (const r of rows) {
  const room = pick(r, ROOM_KEYS);
  const fac  = pick(r, FACILITY_KEYS);
  const whenStr = pick(r, TIME_KEYS);
  const purpose = pick(r, PURPOSE_KEYS);

  let range = parseTimeRange(whenStr);

  if (!range) {
    const sd = pick(r, START_DATE_KEYS);
    const st = pick(r, START_TIME_KEYS);
    const ed = pick(r, END_DATE_KEYS);
    const et = pick(r, END_TIME_KEYS);
    range = buildRange({ sd, st, ed, et });
  }

  if (!room || !range) continue;

  // Broad AC detection unless FORCE_ALL
  const facStr  = (fac  || '').toLowerCase();
  const roomStr = (room || '').toLowerCase();

  const looksAC =
    facStr.includes('ac') ||
    facStr.includes('athletic') || facStr.includes('event center') ||
    roomStr.includes('ac ') || roomStr.startsWith('ac-') ||
    roomStr.includes('fieldhouse') || roomStr.includes('gym') ||
    roomStr.includes('court') || roomStr.includes('turf');

  if (!FORCE_ALL && !looksAC) continue;

  events.push({
    room: String(room).trim(),
    purpose: (purpose || '').toString().trim(),
    startISO: range.start.toISO(),
    endISO: range.end.toISO()
  });
}

// ---------- build grid ----------
let dayStart = DateTime.now().setZone(tz).startOf('day').plus({ hours: 5 });
let dayEnd   = DateTime.now().setZone(tz).startOf('day').plus({ hours: 23 });

if (events.length) {
  const min = events.reduce((a, e) => DateTime.fromISO(e.startISO) < a ? DateTime.fromISO(e.startISO) : a, DateTime.fromISO(events[0].startISO));
  const max = events.reduce((a, e) => DateTime.fromISO(e.endISO)   > a ? DateTime.fromISO(e.endISO)   : a, DateTime.fromISO(events[0].endISO));
  dayStart = min.minus({ minutes: 30 }).startOf('hour');
  dayEnd   = max.plus({ minutes: 30 }).endOf('hour');
}

const slots = [];
for (let t = dayStart; t < dayEnd; t = t.plus({ minutes: SLOT_MIN })) {
  slots.push(t.toISO());
}

const rooms = Array.from(new Set(events.map(e => e.room))).sort((a, b) => a.localeCompare(b));
const occupancy = {};
for (const room of rooms) occupancy[room] = [];

for (const e of events) {
  const s = DateTime.fromISO(e.startISO);
  const en = DateTime.fromISO(e.endISO);
  for (let i = 0; i < slots.length; i++) {
    const slotStart = DateTime.fromISO(slots[i]);
    const slotEnd = slotStart.plus({ minutes: SLOT_MIN });
    const overlaps = s < slotEnd && en > slotStart;
    occupancy[e.room][i] = occupancy[e.room][i] || (overlaps ? { busy: true, label: e.purpose } : { busy: false });
  }
}
for (const room of rooms) occupancy[room] = (occupancy[room] || []).map(x => x || { busy: false });

const out = { tz, slotMin: SLOT_MIN, dayStart: dayStart.toISO(), dayEnd: dayEnd.toISO(), rooms, slots, occupancy };

if (!rooms.length) {
  console.log('No parsable AC rows. Check headers or Facility values. (Tip: set FORCE_ALL=true to bypass site filter)');
} else {
  console.log(`Wrote ${OUT} • rooms=${rooms.length} • slots=${slots.length}`);
}
fs.writeFileSync(OUT, JSON.stringify(out));
