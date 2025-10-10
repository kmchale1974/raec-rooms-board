// scripts/transform.js
import fs from 'fs';
import { parse } from 'csv-parse/sync';
import { DateTime } from 'luxon';

const CSV_PATH = process.env.CSV_PATH || 'data/inbox/latest.csv';
const OUT = process.env.JSON_OUT || 'events.json';
const SLOT_MIN = Number(process.env.SLOT_MIN || 30);
const FORCE_ALL = String(process.env.FORCE_ALL || '').toLowerCase() === 'true';
const tz = 'America/Chicago';

/** Extend this with your exact AC room names once we see samples */
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

const norm = s => (s ?? '').toString().trim();
const skinny = s => norm(s).toLowerCase().replace(/[^a-z0-9]+/g, '');

function pick(obj, keys) {
  for (const k of keys) {
    if (k in obj && obj[k] !== undefined && obj[k] !== '') return obj[k];
  }
  return undefined;
}

function parseTimeRange(value) {
  if (!value) return null;
  const v = String(value).trim();

  // "M/D/YYYY h:mm AM - h:mm PM"
  let m = v.match(/^(\d{1,2}\/\d{1,2}\/\d{4})\s+(\d{1,2}:\d{2}\s*[AP]M)\s*-\s*(\d{1,2}:\d{2}\s*[AP]M)$/i);
  if (m) {
    const [ , d1, t1, t2 ] = m;
    const start = DateTime.fromFormat(`${d1} ${t1}`, 'M/d/yyyy h:mm a', { zone: tz });
    let end = DateTime.fromFormat(`${d1} ${t2}`, 'M/d/yyyy h:mm a', { zone: tz });
    if (end <= start) end = end.plus({ days: 1 });
    if (start.isValid && end.isValid) return { start, end };
  }

  // "M/D/YYYY h:mm AM - M/D/YYYY h:mm PM"
  m = v.match(/^(\d{1,2}\/\d{1,2}\/\d{4})\s+(\d{1,2}:\d{2}\s*[AP]M)\s*-\s*(\d{1,2}\/\d{1,2}\/\d{4})\s+(\d{1,2}:\d{2}\s*[AP]M)$/i);
  if (m) {
    const [ , d1, t1, d2, t2 ] = m;
    const start = DateTime.fromFormat(`${d1} ${t1}`, 'M/d/yyyy h:mm a', { zone: tz });
    const end   = DateTime.fromFormat(`${d2} ${t2}`, 'M/d/yyyy h:mm a', { zone: tz });
    if (start.isValid && end.isValid) return { start, end };
  }
  return null;
}

function buildRange({sd, st, ed, et}) {
  if (!sd || !st || !et) return null;
  const start = DateTime.fromFormat(`${sd} ${st}`, 'M/d/yyyy h:mm a', { zone: tz });
  let end;
  if (ed) {
    end = DateTime.fromFormat(`${ed} ${et}`, 'M/d/yyyy h:mm a', { zone: tz });
  } else {
    end = DateTime.fromFormat(`${sd} ${et}`, 'M/d/yyyy h:mm a', { zone: tz });
    if (end <= start) end = end.plus({ days: 1 });
  }
  if (!start.isValid || !end.isValid) return null;
  return { start, end };
}

const ROOM_KEYS       = ['resourcelabel','resource','location','facilityname','room','areaname','space','facility'];
const FACILITY_KEYS   = ['facility','site','building','center'];
const TIME_KEYS       = ['reservedtime','time','reservationtime','startend','starttoend','reservation','dateandtime'];
const START_DATE_KEYS = ['startdate','fromdate','date','begindate'];
const START_TIME_KEYS = ['starttime','fromtime','timein','begintime'];
const END_DATE_KEYS   = ['enddate','todate','finishdate'];
const END_TIME_KEYS   = ['endtime','totime','timeout','finishtime'];
const PURPOSE_KEYS    = ['reservationpurpose','purpose','event','program','activity','description'];
const RESERVEE_KEYS   = ['reservee','reservedby','customer','name'];

function looksACLabel(str) {
  const s = skinny(str);
  return (
    s.includes('ac') ||
    s.includes('fieldhouse') ||
    s.includes('gym') ||
    s.includes('court') ||
    s.includes('turf')
  );
}

function detectRoom(rowObj, directRoom) {
  // 1) use explicit room-like field if present
  if (directRoom) {
    const dr = norm(directRoom);
    if (dr) return dr;
  }
  // 2) prefer 'location' then 'facility' if they look like room labels
  const loc = pick(rowObj, ['location']);
  if (loc && looksACLabel(loc)) return norm(loc);
  const fac = pick(rowObj, ['facility']);
  if (fac && looksACLabel(fac)) return norm(fac);

  // 3) scan entire row for any catalog name
  const joined = Object.values(rowObj).map(v => norm(v)).join(' | ').toLowerCase();
  const sorted = [...ROOMS_CATALOG].sort((a,b)=>b.length-a.length);
  for (const name of sorted) {
    if (joined.includes(name.toLowerCase())) return name;
  }

  // 4) ultimate fallback in FORCE_ALL: show location → facility if present
  if (FORCE_ALL) {
    if (loc) return norm(loc);
    if (fac) return norm(fac);
  }
  return null;
}

// ---------- parse CSV with auto-delimiter ----------
const raw = fs.readFileSync(CSV_PATH, 'utf8');
const delimiters = [',',';','\t'];
let rows = [];
let usedDelimiter = ',';

for (const d of delimiters) {
  try {
    const parsed = parse(raw, {
      bom: true,
      delimiter: d,
      columns: header => header.map(h => skinny(String(h).replace(/:$/, ''))),
      skip_empty_lines: true,
      relax_column_count: true,
      trim: true
    });
    if (parsed.length) {
      rows = parsed;
      usedDelimiter = d;
      break;
    }
  } catch { /* try next */ }
}

if (!rows.length) {
  console.log('CSV parsed but found 0 rows. Check delimiter/encoding.');
  fs.writeFileSync(OUT, JSON.stringify({ tz, slotMin: SLOT_MIN, rooms: [], slots: [], occupancy: {} }));
  process.exit(0);
}

const headerKeys = Object.keys(rows[0] || {});
console.log('Detected headers:', headerKeys.join(', '), `| delimiter="${usedDelimiter === '\t' ? 'TAB' : usedDelimiter}"`);

// Diagnostics: sample out what the CSV calls rooms
const uniq = (arr) => Array.from(new Set(arr.map(x => norm(x))).values()).filter(Boolean);
const sample = (arr, n=8) => arr.slice(0, n);

const locations = uniq(rows.map(r => r.location));
const facilities = uniq(rows.map(r => r.facility));
console.log('Samples • location:', sample(locations).join(' || ') || '(none)');
console.log('Samples • facility:', sample(facilities).join(' || ') || '(none)');

// ---------- extract events ----------
const events = [];

for (const r of rows) {
  const directRoom = pick(r, ROOM_KEYS);
  const whenStr = pick(r, TIME_KEYS);
  const reservee = pick(r, RESERVEE_KEYS);
  const purpose  = pick(r, PURPOSE_KEYS);

  let range = parseTimeRange(whenStr);
  if (!range) {
    const sd = pick(r, START_DATE_KEYS);
    const st = pick(r, START_TIME_KEYS);
    const ed = pick(r, END_DATE_KEYS);
    const et = pick(r, END_TIME_KEYS);
    range = buildRange({ sd, st, ed, et });
  }

  const room = detectRoom(r, directRoom);
  if (!room || !range) continue;

  // Only keep AC rows unless FORCE_ALL is on
  const isAC = looksACLabel(room) || ROOMS_CATALOG.some(n => n.toLowerCase() === room.toLowerCase());
  if (!isAC && !FORCE_ALL) continue;

  events.push({
    room: norm(room),
    purpose: norm(purpose || reservee || ''), // display something useful if purpose missing
    startISO: range.start.toISO(),
    endISO: range.end.toISO()
  });
}

// ---------- build time grid ----------
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

console.log(`Rows parsed: ${rows.length}`);
console.log(`Events found: ${events.length} ${FORCE_ALL ? '(FORCE_ALL on)' : ''}`);
if (!events.length) {
  console.log('No AC events matched. Check the “Samples • location/facility” lines above; we can add a mapping.');
}

const out = { tz, slotMin: SLOT_MIN, dayStart: dayStart.toISO(), dayEnd: dayEnd.toISO(), rooms, slots, occupancy };
fs.writeFileSync(OUT, JSON.stringify(out));
console.log(`Wrote ${OUT} • rooms=${rooms.length} • slots=${slots.length}`);
