#!/usr/bin/env node
// Transform latest CSV -> events.json (robust headers + Central Time + specificity)
// - Fuzzy header matching (Location / Location:)
// - Forces America/Chicago for "now" so past/upcoming filter is correct on CI
// - Most-specific facility wins (Half Court > Court AB > Full/Championship)
// - Suppresses internal/front-desk/turf-install holds
// - "Last, First" -> "First Last"; Pickleball -> "Open Pickleball"

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const INPUT_CSV  = process.env.IN_CSV  || path.join(__dirname, '..', 'data', 'inbox', 'latest.csv');
const OUTPUT_JSON= process.env.OUT_JSON || path.join(__dirname, '..', 'events.json');

// ---------- Helpers ----------
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

function parseCsvLoose(text) {
  const rows = [];
  let i = 0, field = '', row = [], inQuote = false;
  const pushField = () => { row.push(field); field = ''; };
  const pushRow   = () => { rows.push(row); row = []; };

  while (i < text.length) {
    const c = text[i];

    if (inQuote) {
      if (c === '"') {
        if (text[i+1] === '"') { field += '"'; i += 2; continue; }
        inQuote = false; i++; continue;
      }
      field += c; i++; continue;
    }

    if (c === '"') { inQuote = true; i++; continue; }
    if (c === ',') { pushField(); i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { pushField(); pushRow(); i++; continue; }

    field += c; i++;
  }
  pushField();
  if (row.length > 1 || row[0] !== '') pushRow();
  return rows;
}

// fuzzy header lookup: strips punctuation/spaces, case-insensitive
function makeHeaderIndex(headerRow) {
  const norm = (s) => clean(s).toLowerCase().replace(/[\s:_-]+/g, '');
  const map = new Map();
  headerRow.forEach((h, idx) => map.set(norm(h), idx));
  const idx = (wanted) => {
    const key = norm(wanted);
    if (map.has(key)) return map.get(key);
    // fallback: try a few variants
    for (const [k, v] of map.entries()) {
      if (k.includes(key) || key.includes(k)) return v;
    }
    return -1;
  };
  return { idx };
}

function toCentralNow() {
  // compute "now" in America/Chicago regardless of runner TZ
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(new Date());

  const get = (t) => Number(parts.find(p => p.type === t).value);
  const y = get('year'), m = get('month'), d = get('day');
  const hh = get('hour'), mm = get('minute'), ss = get('second');
  const dt = new Date(Date.UTC(y, m-1, d, hh, mm, ss)); // make a Date; we'll only use minutes
  const nowMin = hh * 60 + mm;
  return { date: dt, nowMin };
}

function toMinutes(hhmm) {
  const m = clean(hhmm).toLowerCase().match(/^(\d{1,2}):(\d{2})\s*([ap])m$/);
  if (!m) return null;
  let h = parseInt(m[1],10), min = parseInt(m[2],10);
  const mer = m[3];
  if (h === 12) h = 0;
  if (mer === 'p') h += 12;
  return h*60 + min;
}

function parseRangeToMinutes(text) {
  // handles odd spacing like " 7:00pm -  9:00pm"
  const m = String(text).match(/(\d{1,2}:\d{2}\s*[ap]m)\s*-\s*(\d{1,2}:\d{2}\s*[ap]m)/i);
  if (!m) return null;
  const startMin = toMinutes(m[1]);
  const endMin   = toMinutes(m[2]);
  if (startMin == null || endMin == null) return null;
  return { startMin, endMin };
}

function firstLast(name) {
  const s = clean(name);
  const m = s.match(/^([^,]+),\s*(.+)$/);
  if (m) return `${m[2]} ${m[1]}`.replace(/\s+/g, ' ').trim();
  return s;
}

function isPickleball(purpose, reservee) {
  return /pickleball/i.test(String(purpose)) || /pickleball/i.test(String(reservee));
}
function isInternalHold(purpose, reservee) {
  const p = String(purpose);
  const r = String(reservee);
  return (
    /internal hold/i.test(p) ||
    /turf install/i.test(p) ||
    /per\s*nm/i.test(p) ||
    /raec\s*front\s*desk/i.test(r) ||
    /front\s*desk/i.test(r)
  );
}
function isCatchCorner(s) {
  return /catch\s*corner/i.test(String(s));
}

// facility → rooms + specificity
function facilityToRoomsWithSpec(fac) {
  const f = clean(fac).toLowerCase();
  const re = (s) => new RegExp(s, 'i');

  // SOUTH 1/2
  if (re('^ac gym - half court\\s*1a$').test(f)) return { rooms:['1A'], spec:3, area:'south' };
  if (re('^ac gym - half court\\s*1b$').test(f)) return { rooms:['1B'], spec:3, area:'south' };
  if (re('^ac gym - court\\s*1[-\\s]?ab$').test(f)) return { rooms:['1A','1B'], spec:2, area:'south' };

  if (re('^ac gym - half court\\s*2a$').test(f)) return { rooms:['2A'], spec:3, area:'south' };
  if (re('^ac gym - half court\\s*2b$').test(f)) return { rooms:['2B'], spec:3, area:'south' };
  if (re('^ac gym - court\\s*2[-\\s]?ab$').test(f)) return { rooms:['2A','2B'], spec:2, area:'south' };

  if (re('full\\s*(?:gym|court)\\s*1ab\\s*&\\s*2ab').test(f)) return { rooms:['1A','1B','2A','2B'], spec:1, area:'south' };
  if (re('championship\\s*court').test(f))         return { rooms:['1A','1B','2A','2B'], spec:1, area:'south' };

  // NORTH 9/10
  if (re('^ac gym - half court\\s*9a$').test(f)) return { rooms:['9A'], spec:3, area:'north' };
  if (re('^ac gym - half court\\s*9b$').test(f)) return { rooms:['9B'], spec:3, area:'north' };
  if (re('^ac gym - court\\s*9[-\\s]?ab$').test(f)) return { rooms:['9A','9B'], spec:2, area:'north' };

  if (re('^ac gym - half court\\s*10a$').test(f)) return { rooms:['10A'], spec:3, area:'north' };
  if (re('^ac gym - half court\\s*10b$').test(f)) return { rooms:['10B'], spec:3, area:'north' };
  if (re('^ac gym - court\\s*10[-\\s]?ab$').test(f)) return { rooms:['10A','10B'], spec:2, area:'north' };

  if (re('full\\s*(?:gym|court)\\s*9\\s*&\\s*10').test(f)) return { rooms:['9A','9B','10A','10B'], spec:1, area:'north' };

  // FIELDHOUSE 3..8
  const m1 = f.match(/^ac fieldhouse - court\s*([3-8])$/i);
  if (m1) return { rooms:[m1[1]], spec:3, area:'fieldhouse' };
  if (re('^ac fieldhouse - court\\s*3-8$').test(f)) return { rooms:['3','4','5','6','7','8'], spec:1, area:'fieldhouse' };

  // Turf (if present)
  if (re('^ac fieldhouse - full turf$').test(f)) return { rooms:['3','4','5','6','7','8'], spec:1, area:'fieldhouse' };
  if (re('^ac fieldhouse - half turf north$').test(f)) return { rooms:['6','7','8'], spec:2, area:'fieldhouse' };
  if (re('^ac fieldhouse - half turf south$').test(f)) return { rooms:['3','4','5'], spec:2, area:'fieldhouse' };

  return { rooms:[], spec:0, area:'' };
}

// ---------- Main ----------
async function main() {
  // Scaffold if empty
  const base = {
    dayStartMin: 360,
    dayEndMin: 1380,
    rooms: [
      { id: '1A', label: '1A', group: 'south' },
      { id: '1B', label: '1B', group: 'south' },
      { id: '2A', label: '2A', group: 'south' },
      { id: '2B', label: '2B', group: 'south' },
      { id: '3',  label: '3',  group: 'fieldhouse' },
      { id: '4',  label: '4',  group: 'fieldhouse' },
      { id: '5',  label: '5',  group: 'fieldhouse' },
      { id: '6',  label: '6',  group: 'fieldhouse' },
      { id: '7',  label: '7',  group: 'fieldhouse' },
      { id: '8',  label: '8',  group: 'fieldhouse' },
      { id: '9A', label: '9A', group: 'north' },
      { id: '9B', label: '9B', group: 'north' },
      { id: '10A',label: '10A',group: 'north' },
      { id: '10B',label: '10B',group: 'north' }
    ],
    slots: []
  };

  if (!fs.existsSync(INPUT_CSV) || fs.statSync(INPUT_CSV).size === 0) {
    fs.writeFileSync(OUTPUT_JSON, JSON.stringify(base, null, 2));
    console.log('transform: INPUT_CSV missing/empty → wrote scaffold.');
    return;
  }

  const raw = fs.readFileSync(INPUT_CSV, 'utf8');
  const rows = parseCsvLoose(raw);
  if (rows.length < 2) {
    fs.writeFileSync(OUTPUT_JSON, JSON.stringify(base, null, 2));
    console.log('transform: header only → wrote scaffold.');
    return;
  }

  const header = rows[0];
  const { idx } = makeHeaderIndex(header);

  const iLocation  = idx('Location');          // matches "Location" OR "Location:"
  const iFacility  = idx('Facility');
  const iTime      = idx('Reserved Time');
  const iReservee  = idx('Reservee');
  const iPurpose   = idx('Reservation Purpose');

  const { nowMin } = toCentralNow();

  // Debug counters
  let total = 0, kept = 0;
  let dropNoFacility = 0, dropNoTime = 0, dropNonRAEC = 0, dropInternal = 0, dropPast = 0, dropMap = 0;

  const groups = new Map(); // key -> { startMin,endMin,reserveeRaw,purposeRaw,pieces:[] }

  for (let r = 1; r < rows.length; r++) {
    total++;
    const row = rows[r];
    const location = iLocation >= 0 ? clean(row[iLocation]) : '';
    const facility = iFacility >= 0 ? clean(row[iFacility]) : '';
    const timeText = iTime >= 0 ? clean(row[iTime]) : '';
    const reservee = iReservee >= 0 ? clean(row[iReservee]) : '';
    const purpose  = iPurpose >= 0 ? clean(row[iPurpose]) : '';

    if (!facility) { dropNoFacility++; continue; }
    if (!timeText) { dropNoTime++; continue; }

    // Only if a location column exists, require RAEC; otherwise assume RAEC-only CSV
    if (iLocation >= 0 && location && !/athletic\s*&\s*event\s*center/i.test(location)) {
      dropNonRAEC++; continue;
    }

    if (isInternalHold(purpose, reservee)) { dropInternal++; continue; }

    const range = parseRangeToMinutes(timeText);
    if (!range) { dropNoTime++; continue; }

    if (range.endMin <= nowMin) { dropPast++; continue; }

    const map = facilityToRoomsWithSpec(facility);
    if (!map.rooms.length) { dropMap++; continue; }

    const reserveeKey = firstLast(reservee).toLowerCase();
    const key = `${reserveeKey}__${range.startMin}__${range.endMin}`;
    if (!groups.has(key)) {
      groups.set(key, {
        startMin: range.startMin,
        endMin: range.endMin,
        reserveeRaw: reservee,
        purposeRaw: purpose,
        pieces: []
      });
    }
    groups.get(key).pieces.push({ rooms: map.rooms, spec: map.spec, area: map.area, facility });
    kept++;
  }

  // Resolve specificity per area
  const slots = [];
  for (const g of groups.values()) {
    const byArea = new Map();
    for (const p of g.pieces) {
      const cur = byArea.get(p.area);
      if (!cur || p.spec > cur.spec) byArea.set(p.area, { spec: p.spec, rooms: new Set(p.rooms) });
      else if (p.spec === cur.spec) p.rooms.forEach(rm => cur.rooms.add(rm));
    }
    const rooms = [];
    for (const v of byArea.values()) rooms.push(...v.rooms);
    if (!rooms.length) continue;

    // Title / subtitle
    let title = '', subtitle = '';
    const reserveePretty = firstLast(g.reserveeRaw);
    if (isPickleball(g.purposeRaw, g.reserveeRaw)) {
      title = 'Open Pickleball';
      subtitle = '';
    } else if (isCatchCorner(g.reserveeRaw)) {
      title = 'Catch Corner';
      subtitle = clean(g.purposeRaw);
    } else {
      // “Org, Contact” → use org as title
      if (/,/.test(g.reserveeRaw) && !/^\w+,\s*\w+$/i.test(g.reserveeRaw)) {
        const parts = g.reserveeRaw.split(',').map(s => s.trim());
        title = parts[0];
        subtitle = clean(g.purposeRaw || parts.slice(1).join(', '));
      } else if (/volleyball|club|academy|training|athletics|sports|united|elite/i.test(g.reserveeRaw)) {
        title = g.reserveeRaw.split(',')[0];
        subtitle = clean(g.purposeRaw);
      } else {
        title = reserveePretty;
        subtitle = clean(g.purposeRaw);
      }
    }

    for (const rm of rooms) {
      slots.push({
        roomId: rm,
        startMin: g.startMin,
        endMin: g.endMin,
        title,
        subtitle,
        org: title,
        contact: ''
      });
    }
  }

  // Dedup & sort
  const seen = new Set(), outSlots = [];
  for (const s of slots) {
    const k = `${s.roomId}__${s.startMin}__${s.endMin}__${s.title}`;
    if (seen.has(k)) continue;
    seen.add(k);
    outSlots.push(s);
  }
  outSlots.sort((a,b) => (a.roomId.localeCompare(b.roomId)) || (a.startMin - b.startMin) || (a.endMin - b.endMin));

  const json = { ...base, slots: outSlots };
  fs.writeFileSync(OUTPUT_JSON, JSON.stringify(json, null, 2));

  // compact one-line debug so logs stay readable
  console.log(
    `transform: rows=${total} kept=${kept} slots=${outSlots.length} ` +
    `drop[noFacility=${dropNoFacility} noTime=${dropNoTime} nonRAEC=${dropNonRAEC} internal=${dropInternal} past=${dropPast} noMap=${dropMap}]`
  );
}

main().catch(err => {
  console.error('transform.mjs failed:', err);
  process.exit(1);
});
