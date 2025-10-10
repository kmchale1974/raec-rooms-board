// scripts/transform.js
import fs from 'fs';
import { parse } from 'csv-parse/sync';
import { DateTime } from 'luxon';

const CSV_PATH = process.env.CSV_PATH || 'data/inbox/latest.csv';
const OUT = process.env.JSON_OUT || 'events.json';
const SLOT_MIN = Number(process.env.SLOT_MIN || 30);
const tz = 'America/Chicago';

// Known room names (extend as needed)
const ROOMS_CATALOG = [
  'AC Fieldhouse - Full Turf',
  'AC Fieldhouse - Half Turf North',
  'AC Fieldhouse - Half Turf South',
  'AC Fieldhouse - Quarter Turf SA',
  'AC Fieldhouse - Quarter Turf SB',
  'AC Fieldhouse - Quarter Turf NA',
  'AC Fieldhouse - Quarter Turf NB',
  'AC Fieldhouse - Court 3',
  'AC Fieldhouse - Court 4',
  'AC Fieldhouse - Court 8',
  'AC Fieldhouse Court 3-8',
  'AC Gym - Court 10-AB',
  'AC Gym - Half Court 10A',
  'AC Gym - Half Court 10B',
  'AC Gym - Court 9-AB',
  'AC Gym - Half Court 9A',
  'AC Gym - Full Gym 9 & 10'
];

const norm = s => (s ?? '').toString().trim();
const skinny = s => norm(s).toLowerCase().replace(/[^a-z0-9]+/g, '');
const uniq = arr => Array.from(new Set(arr.map(x => norm(x))).values()).filter(Boolean);
const sample = (arr, n=8) => arr.slice(0, n);

function pick(obj, keys) {
  for (const k of keys) if (k in obj && obj[k] !== undefined && obj[k] !== '') return obj[k];
  return undefined;
}

// ───────────────── time parsing ─────────────────
function cleanRangeString(value) {
  return String(value)
    // normalize separators (hyphen, en dash, em dash, " to ")
    .replace(/\s+–\s+|\s+—\s+|\s+-\s+|\s+to\s+/gi, ' - ')
    .replace(/\u00A0/g, ' ') // non-breaking space
    .trim();
}

function parseTimeRange(value, fallbackDateISO) {
  if (!value) return null;
  const v = cleanRangeString(value);

  // 0) TIME-ONLY: h:mmam - h:mmpm (no date present)
  //    Use fallbackDateISO (today in tz) if provided.
  let m = v.match(/^(\d{1,2}:\d{2}\s*[ap]m)\s*-\s*(\d{1,2}:\d{2}\s*[ap]m)$/i);
  if (m && fallbackDateISO) {
    const d = DateTime.fromISO(fallbackDateISO, { zone: tz });
    const start = DateTime.fromFormat(`${d.toFormat('M/d/yyyy')} ${m[1]}`, 'M/d/yyyy h:mm a', { zone: tz });
    let end = DateTime.fromFormat(`${d.toFormat('M/d/yyyy')} ${m[2]}`, 'M/d/yyyy h:mm a', { zone: tz });
    if (end <= start) end = end.plus({ days: 1 });
    if (start.isValid && end.isValid) return { start, end };
  }

  // 1) M/D/YYYY h:mm AM - h:mm PM
  m = v.match(/^(\d{1,2}\/\d{1,2}\/\d{2,4})\s+(\d{1,2}:\d{2}\s*[AP]M)\s*-\s*(\d{1,2}:\d{2}\s*[AP]M)$/i);
  if (m) {
    let [ , d1, t1, t2 ] = m;
    if (d1.match(/\/\d{2}$/)) {
      const dt = DateTime.fromFormat(d1, 'M/d/yy'); if (dt.isValid) d1 = dt.toFormat('M/d/yyyy');
    }
    const start = DateTime.fromFormat(`${d1} ${t1}`, 'M/d/yyyy h:mm a', { zone: tz });
    let end = DateTime.fromFormat(`${d1} ${t2}`, 'M/d/yyyy h:mm a', { zone: tz });
    if (end <= start) end = end.plus({ days: 1 });
    if (start.isValid && end.isValid) return { start, end };
  }

  // 2) M/D/YYYY h:mm AM - M/D/YYYY h:mm PM
  m = v.match(/^(\d{1,2}\/\d{1,2}\/\d{2,4})\s+(\d{1,2}:\d{2}\s*[AP]M)\s*-\s*(\d{1,2}\/\d{1,2}\/\d{2,4})\s+(\d{1,2}:\d{2}\s*[AP]M)$/i);
  if (m) {
    let [ , d1, t1, d2, t2 ] = m;
    if (d1.match(/\/\d{2}$/)) {
      const dt1 = DateTime.fromFormat(d1, 'M/d/yy'); if (dt1.isValid) d1 = dt1.toFormat('M/d/yyyy');
    }
    if (d2.match(/\/\d{2}$/)) {
      const dt2 = DateTime.fromFormat(d2, 'M/d/yy'); if (dt2.isValid) d2 = dt2.toFormat('M/d/yyyy');
    }
    const start = DateTime.fromFormat(`${d1} ${t1}`, 'M/d/yyyy h:mm a', { zone: tz });
    const end   = DateTime.fromFormat(`${d2} ${t2}`, 'M/d/yyyy h:mm a', { zone: tz });
    if (start.isValid && end.isValid) return { start, end };
  }

  // 3) M/D/YYYY H:mm - H:mm (24h)
  m = v.match(/^(\d{1,2}\/\d{1,2}\/\d{2,4})\s+(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/);
  if (m) {
    let [ , d1, t1, t2 ] = m;
    if (d1.match(/\/\d{2}$/)) {
      const dt = DateTime.fromFormat(d1, 'M/d/yy'); if (dt.isValid) d1 = dt.toFormat('M/d/yyyy');
    }
    const start = DateTime.fromFormat(`${d1} ${t1}`, 'M/d/yyyy H:mm', { zone: tz });
    let end = DateTime.fromFormat(`${d1} ${t2}`, 'M/d/yyyy H:mm', { zone: tz });
    if (end <= start) end = end.plus({ days: 1 });
    if (start.isValid && end.isValid) return { start, end };
  }

  return null;
}

function buildRange({sd, st, ed, et}) {
  if (!sd || !st || !et) return null;

  const fixY = (d) => d && d.match(/\/\d{2}$/)
    ? (DateTime.fromFormat(d, 'M/d/yy').isValid
        ? DateTime.fromFormat(d, 'M/d/yy').toFormat('M/d/yyyy')
        : d)
    : d;

  sd = fixY(sd); ed = fixY(ed);

  const start = DateTime.fromFormat(`${sd} ${st}`, 'M/d/yyyy h:mm a', { zone: tz })
            || DateTime.fromFormat(`${sd} ${st}`, 'M/d/yyyy H:mm',    { zone: tz });
  let end;
  if (ed) {
    end = DateTime.fromFormat(`${ed} ${et}`, 'M/d/yyyy h:mm a', { zone: tz })
       || DateTime.fromFormat(`${ed} ${et}`, 'M/d/yyyy H:mm',    { zone: tz });
  } else {
    end = DateTime.fromFormat(`${sd} ${et}`, 'M/d/yyyy h:mm a', { zone: tz })
       || DateTime.fromFormat(`${sd} ${et}`, 'M/d/yyyy H:mm',    { zone: tz });
    if (end <= start) end = end.plus({ days: 1 });
  }
  if (!start?.isValid || !end?.isValid) return null;
  return { start, end };
}

// ── keys (prefer FACILITY before LOCATION) ──
const ROOM_KEYS       = ['resourcelabel','resource','facility','facilityname','room','areaname','space','location'];
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
    s.includes('fieldhouse') ||
    s.includes('gym') ||
    s.includes('court') ||
    s.includes('turf') ||
    /^ac/.test(s)
  );
}

function detectRoom(rowObj, directRoom) {
  if (directRoom) {
    const dr = norm(directRoom);
    if (dr) return dr;
  }
  const fac = pick(rowObj, ['facility']);
  if (fac && looksACLabel(fac)) return norm(fac);

  const loc = pick(rowObj, ['location']);
  if (loc && looksACLabel(loc)) return norm(loc);

  const joined = Object.values(rowObj).map(v => norm(v)).join(' | ').toLowerCase();
  const sorted = [...ROOMS_CATALOG].sort((a,b)=>b.length-a.length);
  for (const name of sorted) if (joined.includes(name.toLowerCase())) return name;

  return null;
}

// ───────────────── CSV parse (auto-delim) ─────────────────
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
    if (parsed.length) { rows = parsed; usedDelimiter = d; break; }
  } catch { /* try next */ }
}

if (!rows.length) {
  console.log('CSV parsed but found 0 rows. Check delimiter/encoding.');
  fs.writeFileSync(OUT, JSON.stringify({ tz, slotMin: SLOT_MIN, rooms: [], slots: [], occupancy: {} }));
  process.exit(0);
}

const headerKeys = Object.keys(rows[0] || {});
console.log('Detected headers:', headerKeys.join(', '), `| delimiter="${usedDelimiter === '\t' ? 'TAB' : usedDelimiter}"`);

// Diagnostics
const locations = uniq(rows.map(r => r.location));
const facilities = uniq(rows.map(r => r.facility));
const reservedTimes = uniq(rows.map(r => r.reservedtime));
console.log('Samples • location:', sample(locations).join(' || ') || '(none)');
console.log('Samples • facility:', sample(facilities).join(' || ') || '(none)');
console.log('Samples • reservedtime:', sample(reservedTimes).join(' || ') || '(none)');

// Determine fallback date (today) if there is no date column at all
const haveAnyDateCol = headerKeys.some(k => START_DATE_KEYS.includes(k) || END_DATE_KEYS.includes(k));
const fallbackDateISO = !haveAnyDateCol ? DateTime.now().setZone(tz).startOf('day').toISO() : null;

// ───────────────── extract events ─────────────────
const events = [];

for (const r of rows) {
  const directRoom = pick(r, ROOM_KEYS);
  const whenStr = pick(r, TIME_KEYS);
  const reservee = pick(r, RESERVEE_KEYS);
  const purpose  = pick(r, PURPOSE_KEYS);

  let range = parseTimeRange(whenStr, fallbackDateISO);
  if (!range) {
    const sd = pick(r, START_DATE_KEYS);
    const st = pick(r, START_TIME_KEYS);
    const ed = pick(r, END_DATE_KEYS);
    const et = pick(r, END_TIME_KEYS);
    range = buildRange({ sd, st, ed, et });
  }

  const room = detectRoom(r, directRoom);
  if (!room || !range) continue;

  const isAC = looksACLabel(room) || ROOMS_CATALOG.some(n => n.toLowerCase() === room.toLowerCase());
  if (!isAC) continue;

  events.push({
    room: norm(room),
    purpose: norm(purpose || reservee || ''),
    startISO: range.start.toISO(),
    endISO: range.end.toISO()
  });
}

// ───────────────── build time grid ─────────────────
let dayStart = DateTime.now().setZone(tz).startOf('day').plus({ hours: 5 });
let dayEnd   = DateTime.now().setZone(tz).startOf('day').plus({ hours: 23 });

if (events.length) {
  const min = events.reduce((a, e) => DateTime.fromISO(e.startISO) < a ? DateTime.fromISO(e.startISO) : a, DateTime.fromISO(events[0].startISO));
  const max = events.reduce((a, e) => DateTime.fromISO(e.endISO)   > a ? DateTime.fromISO(e.endISO)   : a, DateTime.fromISO(events[0].endISO));
  dayStart = min.minus({ minutes: 30 }).startOf('hour');
  dayEnd   = max.plus({ minutes: 30 }).endOf('hour');
}

const slots = [];
for (let t = dayStart; t < dayEnd; t = t.plus({ minutes: SLOT_MIN })) slots.push(t.toISO());

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
console.log(`Events found: ${events.length}`);
if (!events.length) {
  console.log('No AC events matched. Check Samples above; if times are from a different day than today, we can add a date source.');
}

const out = { tz, slotMin: SLOT_MIN, dayStart: dayStart.toISO(), dayEnd: dayEnd.toISO(), rooms, slots, occupancy };
fs.writeFileSync(OUT, JSON.stringify(out));
console.log(`Wrote ${OUT} • rooms=${rooms.length} • slots=${slots.length}`);
