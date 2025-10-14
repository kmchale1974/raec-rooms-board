// ESM compatible transform for GitHub Actions runner
// Usage: JSON_OUT="events.json" CSV_PATH="data/inbox/latest.csv" node scripts/transform.js

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------- Config ----------------------
const CSV_PATH = process.env.CSV_PATH || 'data/inbox/latest.csv';
const JSON_OUT = process.env.JSON_OUT || 'events.json';

// Building hours for “today only” timeline in the UI
const HOURS = { open: '06:00', close: '22:00' };

// Rooms that the UI knows about (must match app.js)
const ROOMS_ORDER = [
  '1A','1B','2A','2B','3A','3B','4A','4B','5A','5B',
  '6A','6B','7A','7B','8A','8B','9A','9B','10A','10B',
];

// ---------------------- Helpers ----------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function todayBase() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}

function to24hMinutes(hhmm, ampm) {
  let [h, m] = hhmm.split(':').map(Number);
  const a = ampm.trim().toLowerCase();
  if (a === 'pm' && h !== 12) h += 12;
  if (a === 'am' && h === 12) h = 0;
  return h * 60 + m;
}

function parseTimeWindow(text) {
  // e.g. "6:00pm - 9:00pm" or "3:00pm -  4:30pm"
  // returns [startDate, endDate] (today)
  if (!text) return null;
  const t = String(text).replace(/\s+/g, ' ').trim();
  const m = t.match(/(\d{1,2}:\d{2})\s*([ap]m)\s*-\s*(\d{1,2}:\d{2})\s*([ap]m)/i);
  if (!m) return null;

  const startMins = to24hMinutes(m[1], m[2]);
  const endMins = to24hMinutes(m[3], m[4]);

  const base = todayBase();
  const start = new Date(base.getTime() + startMins * 60000);
  let end = new Date(base.getTime() + endMins * 60000);

  // handle overnight (unlikely here but keep safe)
  if (end <= start) end = new Date(end.getTime() + 24 * 60 * 60000);

  return [start, end];
}

function isPast(end) {
  return new Date(end).getTime() <= Date.now();
}

function expandGymRooms(facility) {
  // Accepts strings like:
  // "AC Gym - Half Court 10A"
  // "AC Gym - Court 9-AB"
  // "AC Gym - Court 3-8"
  // Returns array of room codes like ["9A","9B"] or []

  const s = String(facility || '').trim();

  // Only handle AC Gym for now
  if (!/^AC\s*Gym/i.test(s)) return [];

  // Half Court X[A|B]
  let m = s.match(/Half\s*Court\s*(\d{1,2})([AB])/i);
  if (m) {
    const num = Number(m[1]);
    const side = m[2].toUpperCase();
    const room = `${num}${side}`;
    return ROOMS_ORDER.includes(room) ? [room] : [];
  }

  // Court N-AB  (both halves)
  m = s.match(/Court\s*(\d{1,2})-?AB\b/i);
  if (m) {
    const num = Number(m[1]);
    const rooms = [`${num}A`, `${num}B`].filter(r => ROOMS_ORDER.includes(r));
    return rooms;
  }

  // Court N-A  or Court N-B (rare but handle)
  m = s.match(/Court\s*(\d{1,2})-([AB])\b/i);
  if (m) {
    const num = Number(m[1]);
    const side = m[2].toUpperCase();
    const room = `${num}${side}`;
    return ROOMS_ORDER.includes(room) ? [room] : [];
  }

  // Court N (full court). Assume both halves A and B
  m = s.match(/Court\s*(\d{1,2})\b(?!-)/i);
  if (m) {
    const num = Number(m[1]);
    const rooms = [`${num}A`, `${num}B`].filter(r => ROOMS_ORDER.includes(r));
    if (rooms.length) return rooms;
  }

  // Court X-Y (range). Assume both halves for each number.
  m = s.match(/Court\s*(\d{1,2})\s*-\s*(\d{1,2})/i);
  if (m) {
    const start = Number(m[1]);
    const end = Number(m[2]);
    if (!Number.isNaN(start) && !Number.isNaN(end) && start <= end) {
      const rooms = [];
      for (let n = start; n <= end; n++) {
        for (const half of ['A','B']) {
          const r = `${n}${half}`;
          if (ROOMS_ORDER.includes(r)) rooms.push(r);
        }
      }
      return rooms;
    }
  }

  return [];
}

// Simple CSV parser that supports quoted fields
function parseCSV(text) {
  const rows = [];
  let i = 0, field = '', row = [], inQuotes = false;

  const pushField = () => { row.push(field); field = ''; };
  const pushRow = () => { rows.push(row); row = []; };

  while (i < text.length) {
    const c = text[i];

    if (inQuotes) {
      if (c === '"') {
        const next = text[i + 1];
        if (next === '"') { field += '"'; i += 2; continue; } // escaped quote
        inQuotes = false; i++; continue;
      } else {
        field += c; i++; continue;
      }
    } else {
      if (c === '"') { inQuotes = true; i++; continue; }
      if (c === ',') { pushField(); i++; continue; }
      if (c === '\n') { pushField(); pushRow(); i++; continue; }
      if (c === '\r') { // handle CRLF
        const next = text[i + 1];
        pushField(); pushRow(); i += (next === '\n') ? 2 : 1; continue;
      }
      field += c; i++; continue;
    }
  }
  // last field/row
  pushField();
  if (row.length > 1 || (row.length === 1 && row[0] !== '')) pushRow();

  return rows;
}

function indexHeaders(headers) {
  const map = {};
  headers.forEach((h, idx) => map[h.trim().toLowerCase()] = idx);
  return (name) => {
    const k = String(name).trim().toLowerCase();
    return map[k] ?? -1;
  };
}

// ---------------------- Main ----------------------
async function main() {
  // Read CSV
  const csvBuf = await fs.readFile(path.resolve(__dirname, '..', CSV_PATH)).catch(async () => {
    // also allow absolute / already-correct paths
    return fs.readFile(CSV_PATH);
  });
  const csv = csvBuf.toString('utf8');

  const rows = parseCSV(csv);
  if (!rows.length) {
    await fs.writeFile(JSON_OUT, '[]');
    console.log('No rows in CSV. Wrote empty events.json');
    return;
  }

  const headers = rows[0].map(h => h.trim());
  const getIdx = indexHeaders(headers);

  const idxLocation  = getIdx('location');           // "Athletic & Event Center" etc.
  const idxFacility  = getIdx('facility');           // "AC Gym - Court 9-AB" etc.
  const idxTime      = getIdx('reservedtime');       // "6:00pm - 9:00pm"
  const idxReservee  = getIdx('reservee');           // "Illinois Flight, Brandon Brown"
  const idxPurpose   = getIdx('reservationpurpose'); // optional

  const out = [];
  let samples = { location: [], facility: [], reservedtime: [] };

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];

    const facility = idxFacility >= 0 ? row[idxFacility] : '';
    const reservedTime = idxTime >= 0 ? row[idxTime] : '';
    const reservee = idxReservee >= 0 ? row[idxReservee] : '';
    const purpose = idxPurpose >= 0 ? row[idxPurpose] : '';
    const location = idxLocation >= 0 ? row[idxLocation] : '';

    if (samples.location.length < 1 && location) samples.location.push(location);
    if (samples.facility.length < 8 && facility) samples.facility.push(facility);
    if (samples.reservedtime.length < 8 && reservedTime) samples.reservedtime.push(reservedTime);

    // Only handle AC Gym rows right now
    if (!/^AC\s*Gym/i.test(String(facility))) continue;

    const rooms = expandGymRooms(facility);
    if (!rooms.length) continue;

    const timeWindow = parseTimeWindow(reservedTime);
    if (!timeWindow) continue;

    const [start, end] = timeWindow;

    // Skip events already ended (so they disappear)
    if (isPast(end)) continue;

    const title = purpose?.trim() || 'Reserved';
    const who = reservee?.trim() || '';

    for (const room of rooms) {
      out.push({
        room,
        title,
        start: start.toISOString(),
        end: end.toISOString(),
        area: 'Gym',
        who,
      });
    }
  }

  // Sort by start time then room for deterministic output
  out.sort((a, b) => {
    const t = new Date(a.start) - new Date(b.start);
    if (t !== 0) return t;
    return ROOMS_ORDER.indexOf(a.room) - ROOMS_ORDER.indexOf(b.room);
    });

  await fs.writeFile(JSON_OUT, JSON.stringify(out, null, 2));
  console.log(`Detected headers: ${headers.map(h => h.toLowerCase()).join(', ')} | delimiter=","`);
  if (samples.location.length) console.log(`Samples • location: ${samples.location.join(' || ')}`);
  if (samples.facility.length) console.log(`Samples • facility: ${samples.facility.join(' || ')}`);
  if (samples.reservedtime.length) console.log(`Samples • reservedtime: ${samples.reservedtime.join(' || ')}`);
  console.log(`Rows parsed: ${rows.length - 1}`);
  console.log(`Events written: ${out.length}`);
  console.log(`Wrote ${JSON_OUT}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
