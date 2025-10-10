// scripts/transform.js
import fs from 'fs';
import { parse } from 'csv-parse/sync';
import { DateTime } from 'luxon';

const CSV_PATH = process.env.CSV_PATH || 'data/inbox/latest.csv';
const OUT = process.env.JSON_OUT || 'events.json';

// 30-min slots default (you can change to 60 if you prefer)
const SLOT_MIN = Number(process.env.SLOT_MIN || 30);

// Normalize header names: lower, strip non-alphanum
const norm = s => (s || '')
  .toString()
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '');

// Try to parse a “Reserved Time” cell into start/end (America/Chicago)
const tz = 'America/Chicago';
function parseTimeRange(value) {
  if (!value) return null;
  const v = String(value).trim();

  // Format A: M/d/yyyy h:mm a - h:mm a (same-day)
  // Example: 10/10/2025 6:00 PM - 8:00 PM
  let m = v.match(/^(\d{1,2}\/\d{1,2}\/\d{4})\s+(\d{1,2}:\d{2}\s*[AP]M)\s*-\s*(\d{1,2}:\d{2}\s*[AP]M)$/i);
  if (m) {
    const [ , d1, t1, t2 ] = m;
    const start = DateTime.fromFormat(`${d1} ${t1}`, 'M/d/yyyy h:mm a', { zone: tz });
    let end = DateTime.fromFormat(`${d1} ${t2}`, 'M/d/yyyy h:mm a', { zone: tz });
    if (end <= start) end = end.plus({ days: 1 }); // handle overnight just in case
    return { start, end };
  }

  // Format B: M/d/yyyy h:mm a - M/d/yyyy h:mm a (explicit end date)
  // Example: 10/10/2025 6:00 PM - 10/10/2025 8:00 PM
  m = v.match(/^(\d{1,2}\/\d{1,2}\/\d{4})\s+(\d{1,2}:\d{2}\s*[AP]M)\s*-\s*(\d{1,2}\/\d{1,2}\/\d{4})\s+(\d{1,2}:\d{2}\s*[AP]M)$/i);
  if (m) {
    const [ , d1, t1, d2, t2 ] = m;
    const start = DateTime.fromFormat(`${d1} ${t1}`, 'M/d/yyyy h:mm a', { zone: tz });
    const end = DateTime.fromFormat(`${d2} ${t2}`, 'M/d/yyyy h:mm a', { zone: tz });
    return { start, end };
  }

  return null;
}

// Read CSV
const raw = fs.readFileSync(CSV_PATH, 'utf8');
const rows = parse(raw, {
  bom: true,
  columns: header => header.map(h => norm(h.replace(/:$/, ''))), // strip trailing ":" too
  skip_empty_lines: true,
  relax_column_count: true,
  trim: true
});

// Detect likely header keys across RecTrac variants
// We’ll probe several possible names for each logical field.
function pick(obj, keys) {
  for (const k of keys) {
    if (k in obj && obj[k] !== undefined && obj[k] !== '') return obj[k];
  }
  return undefined;
}

// Keys we’ll consider equal
const ROOM_KEYS     = ['location', 'resourcelabel', 'resource', 'facilityname', 'room', 'areaname'];
const FACILITY_KEYS = ['facility', 'site', 'locationfacility', 'building'];
const TIME_KEYS     = ['reservedtime', 'time', 'reservationtime', 'startend', 'starttoend'];
const PURPOSE_KEYS  = ['reservationpurpose', 'purpose', 'event', 'program'];

const events = [];
for (const r of rows) {
  const room = pick(r, ROOM_KEYS);
  const fac  = pick(r, FACILITY_KEYS);
  const when = pick(r, TIME_KEYS);
  const purpose = pick(r, PURPOSE_KEYS);

  // Broad AC filter:
  const facStr  = (fac  || '').toLowerCase();
  const roomStr = (room || '').toLowerCase();
  const isAC =
    facStr.includes('ac') ||
    facStr.includes('athletic') || facStr.includes('event center') ||
    roomStr.includes('ac ') || roomStr.includes('fieldhouse') ||
    roomStr.includes('gym') || roomStr.includes('court') || roomStr.includes('turf');

  if (!room || !when || !isAC) continue;

  const range = parseTimeRange(when);
  if (!range) continue;

  events.push({
    room: String(room).trim(),
    purpose: (purpose || '').toString().trim(),
    startISO: range.start.toISO(),
    endISO: range.end.toISO()
  });
}

// Build day grid bounds from events (fallback to 5:00–23:00 if no events)
let dayStart = DateTime.now().setZone(tz).startOf('day').plus({ hours: 5 });
let dayEnd   = DateTime.now().setZone(tz).startOf('day').plus({ hours: 23 });

if (events.length) {
  const min = events.reduce((a, e) => DateTime.fromISO(e.startISO) < a ? DateTime.fromISO(e.startISO) : a, DateTime.fromISO(events[0].startISO));
  const max = events.reduce((a, e) => DateTime.fromISO(e.endISO)   > a ? DateTime.fromISO(e.endISO)   : a, DateTime.fromISO(events[0].endISO));
  // pad 30 minutes
  dayStart = min.minus({ minutes: 30 }).startOf('hour');
  dayEnd   = max.plus({ minutes: 30 }).endOf('hour');
}

// Build slots
const slots = [];
for (let t = dayStart; t < dayEnd; t = t.plus({ minutes: SLOT_MIN })) {
  slots.push(t.toISO());
}

// Room list and occupancy map
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

// Fill any holes with "available" flags
for (const room of rooms) {
  occupancy[room] = (occupancy[room] || []).map(x => x || { busy: false });
}

// Emit JSON
const out = {
  tz,
  slotMin: SLOT_MIN,
  dayStart: dayStart.toISO(),
  dayEnd: dayEnd.toISO(),
  rooms,
  slots,
  occupancy
};

if (!rooms.length) {
  console.log('No parsable AC rows. Check headers or Facility values.');
} else {
  console.log(`Wrote ${OUT} • rooms=${rooms.length} • slots=${slots.length}`);
}

fs.writeFileSync(OUT, JSON.stringify(out));
