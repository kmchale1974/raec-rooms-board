// scripts/transform.js
import fs from 'fs';
import { parse } from 'csv-parse/sync';
import { DateTime } from 'luxon';

const CSV_PATH = process.env.CSV_PATH || 'data/inbox/latest.csv';
const OUT = process.env.JSON_OUT || 'events.json';
const SLOT_MIN = Number(process.env.SLOT_MIN || 30);
const tz = 'America/Chicago';

/**
 * Known AC rooms/resources we expect to see embedded anywhere in the row.
 * These come from your SuperGrid sample.
 * Feel free to add/remove as you discover more.
 */
const ROOMS_CATALOG = [
  'AC Fieldhouse - Court 3',
  'AC Fieldhouse - Court 4',
  'AC Fieldhouse - Court 8',
  'AC Fieldhouse Court 3-8',
  'AC Fieldhouse - Full Turf',
  'AC Fieldhouse - Half Turf North',
  'AC Fieldhouse - Half Turf South',
  'AC Fieldhouse - Quarter Turf SA',
  'AC Fieldhouse - Quarter Turf SB',
  'AC Fieldhouse - Quarter Turf NA',
  'AC Fieldhouse - Quarter Turf NB',
  'AC Gym - Court 9-AB',
  'AC Gym - Half Court 9B',
  'AC Gym - Full Gym 9 & 10'
];

// ---------- helpers ----------
const norm = s => (s ?? '')
  .toString()
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '');

const toStr = v => (v === null || v === undefined) ? '' : String(v);

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
    if (start.isValid && end.isValid) return { start, end };
  }
  // 2) "M/D/YYYY h:mm AM - M/D/YYYY h:mm PM"
  m = v.match(/^(\d{1,2}\/\d{1,2}\/\d{4})\s+(\d{1,2}:\d{2}\s*[AP]M)\s*-\s*(\d{1,2}\/\d{1,2}\/\d{4})\s+(\d{1,2}:\d{2}\s*[AP]M)$/i);
  if (m) {
    const [ , d1, t1, d2, t2 ] = m;
    const start = DateTime.fromFormat(`${d1} ${t1}`, 'M/d/yyyy h:mm a', { zone: tz });
    const end   = DateTime.fromFormat(`${d2} ${t2}`, 'M/d/yyyy h:mm a', { zone: tz });
    if (start.isValid && end.isValid) return { start, end };
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

// Try to detect room:
// 1) direct column (location/resource/etc)
// 2) scan all fields for a substring that matches our known rooms catalog
function detectRoom(rowObj, directRoom) {
  if (directRoom) return String(directRoom).trim();

  // Scan all values for any known room name
  const joined = Object.values(rowObj)
    .map(v => toStr(v))
    .join(' | ')
    .toLowerCase();

  // longest match first to avoid partials
  const sortedRooms = [...ROOMS_CATALOG].sort((a, b) => b.length - a.length);
  for (const name of sortedRooms) {
    if (joined.includes(name.toLowerCase())) return name;
  }
  return null;
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

// ---------- header variants present in your file ----------
const ROOM_KEYS     = ['resourcelabel', 'resource', 'location', 'facilityname', 'room', 'areaname', 'space'];
const FACILITY_KEYS = ['facility', 'site', 'locationfacility', 'building', 'center']; // used only for logging
const TIME_KEYS     = ['reservedtime', 'time', 'reservationtime', 'startend', 'starttoend', 'reservation', 'dateandtime'];

// Separate columns variants (if RecTrac exports this style later)
const START_DATE_KEYS = ['startdate', 'fromdate', 'date', 'begindate'];
const START_TIME_KEYS = ['starttime', 'fromtime', 'timein', 'begintime'];
const END_DATE_KEYS   = ['enddate', 'todate', 'finishdate'];
const END_TIME_KEYS   = ['endtime', 'totime', 'timeout', 'finishtime'];

const PURPOSE_KEYS  = ['reservationpurpose', 'purpose', 'event', 'program', 'activity', 'description'];

// ---------- row extraction ----------
const events = [];

for (const r of rows) {
  // Your sample headers include: location, facility, reservedtime, reservee, reservationpurpose, headcount, questionanswerall
  const directRoom = pick(r, ROOM_KEYS);       // may be undefined in this export
  const fac        = pick(r, FACILITY_KEYS);   // e.g., might be "AC" or full center name
  const whenStr    = pick(r, TIME_KEYS);       // e.g., "10/03/2025 6:00 PM - 9:00 PM"
  const purpose    = pick(r, PURPOSE_KEYS);    // e.g., "Pink Elite, C" or "Basketball"

  let range = parseTimeRange(whenStr);

  if (!range) {
    // fallback: if RecTrac ever sends separate date/time columns
    const sd = pick(r, START_DATE_KEYS);
    const st = pick(r, START_TIME_KEYS);
    const ed = pick(r, END_DATE_KEYS);
    const et = pick(r, END_TIME_KEYS);
    range = buildRange({ sd, st, ed, et });
  }

  // Detect room, even if there isn't a dedicated column
  const room = detectRoom(r, directRoom);

  if (!room || !range) continue;

  // We only want AC rooms: if it’s in our catalog, it’s AC by definition
  const isAC = ROOMS_CATALOG.some(name => name.toLowerCase() === room.toLowerCase());
  if (!isAC) continue;

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

// Diagnostics to help us confirm parsing quality
console.log(`Rows parsed: ${rows.length}`);
console.log(`Events found: ${events.length}`);
if (events.length === 0) {
  console.log('No AC events matched. If your CSV doesn’t include room names anywhere, reply here and I’ll add another fallback.');
  // still write an empty structure so the site loads
}

const out = { tz, slotMin: SLOT_MIN, dayStart: dayStart.toISO(), dayEnd: dayEnd.toISO(), rooms, slots, occupancy };
fs.writeFileSync(OUT, JSON.stringify(out));
console.log(`Wrote ${OUT} • rooms=${rooms.length} • slots=${slots.length}`);
