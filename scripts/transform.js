// scripts/transform.js
// RecTrac CSV -> events.json (root) for AC display with 30-min slots and "now" line support.
//
// Usage in GitHub Actions step:
//   TZ=America/Chicago CSV_PATH="data/inbox/latest.csv" JSON_OUT="events.json" node scripts/transform.js
//
// Env vars:
//   CSV_PATH   : path to incoming CSV (default: data/inbox/latest.csv)
//   JSON_OUT   : output JSON path (default: events.json at repo root)
//   TZ         : IANA timezone (default: America/Chicago)
//   SLOT_MIN   : slot minutes (default: 30)
//   ROOM_KEYS  : optional comma list to override room header guesses
//   FACIL_KEYS : optional comma list to override facility header guesses
//   RTIME_KEYS : optional comma list to override time header guesses

import fs from 'fs';
import { parse } from 'csv-parse/sync';
import { DateTime, Interval } from 'luxon';

// ---------- Config ----------
const IN       = process.env.CSV_PATH || 'data/inbox/latest.csv';
const OUT      = process.env.JSON_OUT || 'events.json';          // root output
const TZ       = process.env.TZ || 'America/Chicago';
const SLOT_MIN = parseInt(process.env.SLOT_MIN || '30', 10);

// Header mapping (heuristics; can be overridden with env)
const ROOM_KEYS  = (process.env.ROOM_KEYS  || 'location:,location,room,resource,space,facility')
  .split(',').map(s => s.trim().toLowerCase());
const FACIL_KEYS = (process.env.FACIL_KEYS || 'facility,building,site')
  .split(',').map(s => s.trim().toLowerCase());
const RTIME_KEYS = (process.env.RTIME_KEYS || 'reserved time,reservation time,time')
  .split(',').map(s => s.trim().toLowerCase());

// ---------- Helpers ----------
const norm = s => (s ?? '').toString().trim();
const lc   = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k.toLowerCase(), v]));
const pick = (row, keys) => {
  const l = lc(row);
  for (const want of keys) {
    for (const k in l) {
      if (k.includes(want)) return l[k];
    }
  }
  return '';
};

function parseRange(t) {
  if (!t) return null;
  const txt = t.replace('–', '-'); // normalize en-dash
  const parts = txt.split(/\s+-\s+|\s+to\s+|-/i);
  if (parts.length !== 2) return null;

  const [a, b] = parts.map(s => s.trim());

  // Start — try common formats, then ISO
  let start = DateTime.fromFormat(a, 'M/d/yyyy h:mm a', { zone: TZ });
  if (!start.isValid) start = DateTime.fromFormat(a, 'M/d/yyyy H:mm', { zone: TZ });
  if (!start.isValid) start = DateTime.fromISO(a, { zone: TZ });
  if (!start.isValid) return null;

  // End — may omit date; default to start’s date
  let end = DateTime.fromFormat(b, 'M/d/yyyy h:mm a', { zone: TZ });
  if (!end.isValid) end = DateTime.fromFormat(b, 'h:mm a', { zone: TZ })
    .set({ year: start.year, month: start.month, day: start.day });
  if (!end.isValid) end = DateTime.fromFormat(b, 'H:mm', { zone: TZ })
    .set({ year: start.year, month: start.month, day: start.day });
  if (!end.isValid) end = DateTime.fromISO(b, { zone: TZ });
  if (!end.isValid) return null;

  if (end <= start) end = start.plus({ minutes: 30 });
  return { start, end };
}

// ---------- Read CSV ----------
if (!fs.existsSync(IN)) {
  console.error(`Input CSV not found: ${IN}`);
  fs.writeFileSync(OUT, JSON.stringify({ rooms: [], slotMinutes: SLOT_MIN }, null, 2));
  process.exit(0);
}

const csv = fs.readFileSync(IN, 'utf8');
const rows = parse(csv, { columns: true, skip_empty_lines: true });

// ---------- Build records (AC-only) ----------
const rec = [];
for (const r of rows) {
  const room = norm(pick(r, ROOM_KEYS));
  const fac  = norm(pick(r, FACIL_KEYS));
  const t    = norm(pick(r, RTIME_KEYS));

  // AC-only filter; adjust the regex if your Facility text differs
  const isAC =
    /(^|\b)AC\b/i.test(fac) ||
    /Athletic\s*&\s*Event\s*Center/i.test(fac) ||
    /Fieldhouse|Gym/i.test(room);

  if (!isAC || !room || !t) continue;

  const rng = parseRange(t);
  if (!rng) continue;

  rec.push({ room, ...rng });
}

// If nothing parsed, write an empty payload to avoid 404 on the page
if (!rec.length) {
  console.warn('No parsable AC rows. Check headers or Facility values.');
  const empty = {
    generatedAt: DateTime.now().setZone(TZ).toISO(),
    date: DateTime.now().setZone(TZ).toFormat('cccc, LLL d, yyyy'),
    timeZone: TZ,
    slotMinutes: SLOT_MIN,
    windowStart: DateTime.now().setZone(TZ).startOf('day').toISO(),
    windowEnd: DateTime.now().setZone(TZ).endOf('day').toISO(),
    rooms: []
  };
  fs.writeFileSync(OUT, JSON.stringify(empty, null, 2));
  process.exit(0);
}

// ---------- Compute window & slots ----------
let dayStart = rec.reduce((m, x) => (x.start < m ? x.start : m), rec[0].start);
let dayEnd   = rec.reduce((m, x) => (x.end   > m ? x.end   : m), rec[0].end);

// Snap to slot boundaries
dayStart = dayStart.set({ second: 0, millisecond: 0 }).minus({ minutes: dayStart.minute % SLOT_MIN });
dayEnd   = dayEnd.set({ second: 0, millisecond: 0 }).plus({ minutes: (SLOT_MIN - (dayEnd.minute % SLOT_MIN)) % SLOT_MIN });

// Compose slot edges
const slots = [];
for (let t = dayStart; t < dayEnd; t = t.plus({ minutes: SLOT_MIN })) {
  slots.push([t, t.plus({ minutes: SLOT_MIN })]);
}

// ---------- Build timeline ----------
const rooms = [...new Set(rec.map(x => x.room))].sort();
const book  = new Map();
for (const room of rooms) {
  book.set(room, rec.filter(x => x.room === room).map(x => Interval.fromDateTimes(x.start, x.end)));
}

const timeline = rooms.map(room => ({
  room,
  slots: slots.map(([s, e]) => {
    const si = Interval.fromDateTimes(s, e);
    const booked = book.get(room).some(iv => iv.overlaps(si));
    return { start: s.toISO(), end: e.toISO(), booked };
  })
}));

// ---------- Output payload ----------
const payload = {
  generatedAt: DateTime.now().setZone(TZ).toISO(),
  date: dayStart.toFormat('cccc, LLL d, yyyy'),
  timeZone: TZ,
  slotMinutes: SLOT_MIN,
  windowStart: dayStart.toISO(),
  windowEnd: dayEnd.toISO(),
  rooms: timeline
};

fs.writeFileSync(OUT, JSON.stringify(payload, null, 2));
console.log(`Wrote ${OUT} • rooms=${rooms.length} • slots=${slots.length}`);
