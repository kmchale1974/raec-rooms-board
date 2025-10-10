import fs from 'fs';
import { parse } from 'csv-parse/sync';
import { DateTime, Interval } from 'luxon';

const IN = process.env.CSV_PATH || 'data/inbox/latest.csv';
const OUT = process.env.JSON_OUT || 'public/events.json';
const TZ = process.env.TZ || 'America/Chicago';
const SLOT_MIN = parseInt(process.env.SLOT_MIN || '30', 10);

// Header mapping
const ROOM_KEYS = ['location:', 'location', 'room', 'resource', 'space'];
const FACIL_KEYS= ['facility', 'building', 'site'];
const RTIME_KEYS= ['reserved time', 'reservation time', 'time'];

const norm = s => (s ?? '').toString().trim();
const lc = o => Object.fromEntries(Object.entries(o).map(([k,v]) => [k.toLowerCase(), v]));
const pick = (row, keys) => { const l = lc(row); for (const want of keys) for (const k in l) if (k.includes(want)) return l[k]; return ''; };

function parseRange(t) {
  if (!t) return null;
  const txt = t.replace('–', '-');
  const parts = txt.split(/\s+-\s+|\s+to\s+|-/i);
  if (parts.length !== 2) return null;
  const [a, b] = parts.map(s => s.trim());
  let start = DateTime.fromFormat(a, 'M/d/yyyy h:mm a', { zone: TZ });
  if (!start.isValid) start = DateTime.fromFormat(a, 'M/d/yyyy H:mm', { zone: TZ });
  if (!start.isValid) start = DateTime.fromISO(a, { zone: TZ });
  if (!start.isValid) return null;
  let end = DateTime.fromFormat(b, 'M/d/yyyy h:mm a', { zone: TZ });
  if (!end.isValid) end = DateTime.fromFormat(b, 'h:mm a', { zone: TZ }).set({ year: start.year, month: start.month, day: start.day });
  if (!end.isValid) end = DateTime.fromFormat(b, 'H:mm', { zone: TZ }).set({ year: start.year, month: start.month, day: start.day });
  if (!end.isValid) end = DateTime.fromISO(b, { zone: TZ });
  if (!end.isValid) return null;
  if (end <= start) end = start.plus({ minutes: 30 });
  return { start, end };
}

const csv = fs.readFileSync(IN, 'utf8');
const rows = parse(csv, { columns: true, skip_empty_lines: true });

const rec = [];
for (const r of rows) {
  const room = norm(pick(r, ROOM_KEYS));
  const fac  = norm(pick(r, FACIL_KEYS));
  const t    = norm(pick(r, RTIME_KEYS));
  // AC-only filter (tweak if your Facility text differs)
  const isAC = /(^|\b)AC\b/i.test(fac) || /Athletic\s*&\s*Event\s*Center/i.test(fac) || /Fieldhouse|Gym/i.test(room);
  if (!isAC || !room || !t) continue;
  const rng = parseRange(t); if (!rng) continue;
  rec.push({ room, ...rng });
}
if (!rec.length) {
  console.error('No parsable AC rows. Check headers or Facility values.');
  fs.mkdirSync('public', { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ rooms: [], slotMinutes: SLOT_MIN }, null, 2));
  process.exit(0);
}

let dayStart = rec.reduce((m, x) => x.start < m ? x.start : m, rec[0].start);
let dayEnd   = rec.reduce((m, x) => x.end   > m ? x.end   : m, rec[0].end);

// snap to slot boundaries
dayStart = dayStart.set({ second: 0, millisecond: 0 }).minus({ minutes: dayStart.minute % SLOT_MIN });
dayEnd   = dayEnd.set({ second: 0, millisecond: 0 }).plus({ minutes: (SLOT_MIN - (dayEnd.minute % SLOT_MIN)) % SLOT_MIN });

const slots = [];
for (let t = dayStart; t < dayEnd; t = t.plus({ minutes: SLOT_MIN })) slots.push([t, t.plus({ minutes: SLOT_MIN })]);

const rooms = [...new Set(rec.map(x => x.room))].sort();
const book = new Map();
for (const room of rooms) book.set(room, rec.filter(x => x.room === room).map(x => Interval.fromDateTimes(x.start, x.end)));

const timeline = rooms.map(room => ({
  room,
  slots: slots.map(([s, e]) => {
    const si = Interval.fromDateTimes(s, e);
    const booked = book.get(room).some(i => i.overlaps(si));
    return { start: s.toISO(), end: e.toISO(), booked };
  })
}));

const payload = {
  generatedAt: DateTime.now().setZone(TZ).toISO(),
  date: dayStart.toFormat('cccc, LLL d, yyyy'),
  timeZone: TZ,
  slotMinutes: SLOT_MIN,
  windowStart: dayStart.toISO(),
  windowEnd: dayEnd.toISO(),
  rooms: timeline
};

fs.mkdirSync('public', { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(payload, null, 2));
console.log(`Wrote ${OUT} • rooms=${rooms.length} • slots=${slots.length}`);
