// ESM transform: parse CSV -> write events.json with minute offsets (no timezone issues)
// Usage in CI: JSON_OUT="events.json" CSV_PATH="data/inbox/latest.csv" node scripts/transform.js

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CSV_PATH = process.env.CSV_PATH || 'data/inbox/latest.csv';
const JSON_OUT = process.env.JSON_OUT || 'events.json';

// Building hours (used by frontend too; we compute mins from 00:00)
const HOURS = { open: '06:00', close: '22:00' };

const ROOMS_ORDER = [
  '1A','1B','2A','2B','3A','3B','4A','4B','5A','5B',
  '6A','6B','7A','7B','8A','8B','9A','9B','10A','10B',
];

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------- helpers ----------
function hmToMinutes(hm) {
  const [h, m] = hm.split(':').map(Number);
  return h * 60 + m;
}
const OPEN_MIN = hmToMinutes(HOURS.open); // 360
const CLOSE_MIN = hmToMinutes(HOURS.close); // 1320

function to24hMinutes(hhmm, ampm) {
  let [h, m] = hhmm.split(':').map(Number);
  const a = ampm.trim().toLowerCase();
  if (a === 'pm' && h !== 12) h += 12;
  if (a === 'am' && h === 12) h = 0;
  return h * 60 + m;
}

function parseTimeWindow(text) {
  // "6:00pm - 9:00pm" or "3:00pm -  4:30pm"
  if (!text) return null;
  const t = String(text).replace(/\s+/g, ' ').trim();
  const m = t.match(/(\d{1,2}:\d{2})\s*([ap]m)\s*-\s*(\d{1,2}:\d{2})\s*([ap]m)/i);
  if (!m) return null;
  const startMin = to24hMinutes(m[1], m[2]);
  const endMin = to24hMinutes(m[3], m[4]);
  // handle overnight edge (unlikely): push end to next day
  return endMin <= startMin ? [startMin, endMin + 24 * 60] : [startMin, endMin];
}

function expandGymRooms(facility) {
  const s = String(facility || '').trim();
  if (!/^AC\s*Gym/i.test(s)) return [];

  // Half Court 10A
  let m = s.match(/Half\s*Court\s*(\d{1,2})([AB])\b/i);
  if (m) {
    const room = `${Number(m[1])}${m[2].toUpperCase()}`;
    return ROOMS_ORDER.includes(room) ? [room] : [];
  }

  // Court 9-AB
  m = s.match(/Court\s*(\d{1,2})-?AB\b/i);
  if (m) {
    const n = Number(m[1]);
    return [`${n}A`, `${n}B`].filter(r => ROOMS_ORDER.includes(r));
  }

  // Court 9-A or 9-B
  m = s.match(/Court\s*(\d{1,2})-([AB])\b/i);
  if (m) {
    const room = `${Number(m[1])}${m[2].toUpperCase()}`;
    return ROOMS_ORDER.includes(room) ? [room] : [];
  }

  // Court 9 (full court) → A & B
  m = s.match(/Court\s*(\d{1,2})\b(?!-)/i);
  if (m) {
    const n = Number(m[1]);
    const rooms = [`${n}A`, `${n}B`].filter(r => ROOMS_ORDER.includes(r));
    if (rooms.length) return rooms;
  }

  // Court 3-8 (range) → all A/B in range
  m = s.match(/Court\s*(\d{1,2})\s*-\s*(\d{1,2})/i);
  if (m) {
    const start = Number(m[1]);
    const end = Number(m[2]);
    if (start <= end) {
      const rooms = [];
      for (let n = start; n <= end; n++) {
        for (const side of ['A','B']) {
          const r = `${n}${side}`;
          if (ROOMS_ORDER.includes(r)) rooms.push(r);
        }
      }
      return rooms;
    }
  }

  return [];
}

// minimal CSV parser with quoted field support
function parseCSV(text) {
  const rows = [];
  let i = 0, field = '', row = [], inQuotes = false;

  const pushField = () => { row.push(field); field = ''; };
  const pushRow = () => { rows.push(row); row = []; };

  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    } else {
      if (c === '"') { inQuotes = true; i++; continue; }
      if (c === ',') { pushField(); i++; continue; }
      if (c === '\n') { pushField(); pushRow(); i++; continue; }
      if (c === '\r') { pushField(); pushRow(); i += (text[i + 1] === '\n') ? 2 : 1; continue; }
      field += c; i++; continue;
    }
  }
  pushField();
  if (row.length > 1 || (row.length === 1 && row[0] !== '')) pushRow();
  return rows;
}

function indexHeaders(headers) {
  const map = {};
  headers.forEach((h, i) => map[h.trim().toLowerCase()] = i);
  return name => map[String(name).trim().toLowerCase()] ?? -1;
}

// ---------- main ----------
async function main() {
  // read CSV (try scripts/.. relative path, then raw)
  let csvBuf;
  try {
    csvBuf = await fs.readFile(path.resolve(__dirname, '..', CSV_PATH));
  } catch {
    csvBuf = await fs.readFile(CSV_PATH);
  }
  const csv = csvBuf.toString('utf8');
  const rows = parseCSV(csv);
  if (!rows.length) {
    await fs.writeFile(JSON_OUT, '[]');
    console.log('No rows; wrote empty events.json'); return;
  }

  const headers = rows[0].map(h => h.trim());
  const getIdx = indexHeaders(headers);

  const idxFacility = getIdx('facility');
  const idxTime     = getIdx('reservedtime');
  const idxReservee = getIdx('reservee');
  const idxPurpose  = getIdx('reservationpurpose');

  const out = [];
  const nowMin = (() => {
    const d = new Date();
    return d.getHours()*60 + d.getMinutes();
  })();

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const facility = idxFacility >= 0 ? row[idxFacility] : '';
    const reservedTime = idxTime >= 0 ? row[idxTime] : '';
    const reservee = idxReservee >= 0 ? row[idxReservee] : '';
    const purpose = idxPurpose >= 0 ? row[idxPurpose] : '';

    if (!facility || !reservedTime) continue;

    // only AC Gym for now
    const rooms = expandGymRooms(facility);
    if (!rooms.length) continue;

    const win = parseTimeWindow(reservedTime);
    if (!win) continue;
    let [startMin, endMin] = win;

    // clip to building hours to avoid drawing outside the grid
    startMin = Math.max(startMin, OPEN_MIN);
    endMin = Math.min(endMin, CLOSE_MIN);

    // skip if already ended (so past events vanish)
    if (endMin <= nowMin) continue;

    const title = (purpose || 'Reserved').trim();
    const who = (reservee || '').trim();

    for (const room of rooms) {
      out.push({ room, title, who, startMin, endMin });
    }
  }

  // deterministic output
  out.sort((a, b) => {
    const t = a.startMin - b.startMin;
    if (t !== 0) return t;
    return ROOMS_ORDER.indexOf(a.room) - ROOMS_ORDER.indexOf(b.room);
  });

  await fs.writeFile(JSON_OUT, JSON.stringify(out, null, 2));
  console.log(`Rows: ${rows.length - 1} • Events: ${out.length} • Wrote ${JSON_OUT}`);
  if (out.length) {
    console.log('Sample event:', out[0]);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
