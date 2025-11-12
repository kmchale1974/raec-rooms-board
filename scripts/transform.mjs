#!/usr/bin/env node
// scripts/transform.mjs
// Transform latest CSV -> events.json with RAEC rules

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

/* =========================
   Paths & tiny helpers
   ========================= */
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const INPUT_CSV   = process.env.IN_CSV   || path.join(__dirname, '..', 'data', 'inbox', 'latest.csv');
const OUTPUT_JSON = process.env.OUT_JSON || path.join(__dirname, '..', 'events.json');

const DAY_START_MIN = 6 * 60;   // 6:00
const DAY_END_MIN   = 23 * 60;  // 23:00

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/* =========================
   CSV parser (robust enough for quoted/unquoted)
   ========================= */
function parseCSV(text) {
  const rows = [];
  let i = 0, field = '', row = [], inQuotes = false;

  while (i < text.length) {
    const c = text[i];

    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; } // escaped quote
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    } else {
      if (c === '"') { inQuotes = true; i++; continue; }
      if (c === ',') { row.push(field); field = ''; i++; continue; }
      if (c === '\r') { i++; continue; }
      if (c === '\n') { row.push(field); rows.push(row); field = ''; row = []; i++; continue; }
      field += c; i++; continue;
    }
  }
  // last field
  row.push(field);
  rows.push(row);

  // header map
  const header = rows[0]?.map(h => clean(h).toLowerCase()) || [];
  const colIndex = (name) => header.indexOf(name.toLowerCase());

  // normalize to objects
  return rows.slice(1).map(cols => ({
    Location:            cols[colIndex('location:')] ?? cols[colIndex('location')] ?? '',
    Facility:            cols[colIndex('facility')] ?? '',
    'Reserved Time':     cols[colIndex('reserved time')] ?? '',
    Reservee:            cols[colIndex('reservee')] ?? '',
    'Reservation Purpose': cols[colIndex('reservation purpose')] ?? ''
  }));
}

/* =========================
   Time helpers
   ========================= */
function toMin(hhmmampm) {
  const s = clean(hhmmampm).toLowerCase();
  const m = s.match(/^(\d{1,2}):(\d{2})\s*([ap])m$/);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const mer = m[3];
  if (h === 12) h = 0;
  if (mer === 'p') h += 12;
  return h * 60 + min;
}
function parseRangeToMinutes(text) {
  if (!text) return null;
  const m = String(text).match(/(\d{1,2}:\d{2}\s*[ap]m)\s*-\s*(\d{1,2}:\d{2}\s*[ap]m)/i);
  if (!m) return null;
  return { startMin: toMin(m[1]), endMin: toMin(m[2]) };
}
const overlaps = (a, b) => a.startMin < b.endMin && b.startMin < a.endMin;

/* =========================
   Season detection
   ========================= */
function detectSeason(rows) {
  const hasFullTurf      = rows.some(r => /AC Fieldhouse\s*-\s*Full Turf/i.test(r.Facility || ''));
  const anyQuarterTurf   = rows.some(r => /AC Fieldhouse\s*-\s*Quarter Turf/i.test(r.Facility || ''));
  const anyCourt3to8     = rows.some(r => /AC Fieldhouse\s*-?\s*Court\s*3-?8/i.test(r.Facility || ''));

  const purposes = rows.map(r => String(r['Reservation Purpose'] || ''));
  const purposeHas = (re) => purposes.some(p => re.test(p));

  const isTurf =
    purposeHas(/Turf\s*Install\s*per\s*NM/i) ||
    purposeHas(/Turf\s*Season\s*per\s*NM/i) ||
    (anyCourt3to8 && purposeHas(/Turf\s*(Install|Season)\s*per\s*NM/i)) ||
    hasFullTurf || anyQuarterTurf;

  if (isTurf) return 'turf';
  if (purposeHas(/Fieldhouse\s*Installed\s*per\s*NM/i)) return 'courts';
  return 'courts';
}

/* =========================
   Title / subtitle rules
   ========================= */
function isOpenPickleballPurpose(purpose) {
  return /Open\s*Pickleball/i.test(purpose || '');
}
function parseWelchVB(purpose) {
  // "<Sport> - Hold per NM for <Org>"
  const m = String(purpose || '').match(/^\s*([A-Za-z ]+?)\s*-\s*Hold\s*per\s*NM\s*for\s*(.+)\s*$/i);
  if (!m) return null;
  return { sport: clean(m[1]), org: clean(m[2]) };
}
function cleanPurpose(purpose) {
  let s = clean(purpose);
  if (!s) return '';
  s = s.replace(/^\(+|\)+$/g, '');
  s = s.replace(/\s{2,}/g, ' ').trim();
  return s;
}
function makeTitleSubtitle(row) {
  const reservee = clean(row['Reservee'] || '');
  const purpose  = clean(row['Reservation Purpose'] || '');

  // 1) Open Pickleball
  if (isOpenPickleballPurpose(purpose)) {
    return { title: 'Open Pickleball', subtitle: '' };
  }

  // 2) Welch VB style: "<Sport> - Hold per NM for <Org>"
  const welch = parseWelchVB(purpose);
  if (welch) {
    return { title: welch.org, subtitle: welch.sport };
  }

  // 3) Person "Last, First" → "First Last"
  const mPerson = reservee.match(/^\s*([A-Za-z'.-]+),\s*([A-Za-z'.-]+)\s*$/);
  if (mPerson) {
    return { title: `${mPerson[2]} ${mPerson[1]}`, subtitle: cleanPurpose(purpose) };
  }

  // 4) "Org, Contact ..." → title=Org, subtitle=Purpose or contact
  const parts = reservee.split(',').map(x => x.trim());
  if (parts.length >= 2) {
    const org = parts[0];
    const contact = parts.slice(1).join(', ')
      .replace(/\s*\)+\s*$/, '')
      .replace(/^\(+\s*/, '');
    const sub = cleanPurpose(purpose);
    return { title: org, subtitle: sub || contact };
  }

  // 5) Fallback
  return { title: reservee || 'Reservation', subtitle: cleanPurpose(purpose) };
}

/* =========================
   Filtering rules
   ========================= */
function rowIsRAEC(row) {
  const loc = clean(row.Location || '');
  return /athletic\s*&\s*event\s*center/i.test(loc) || /athletic.*event.*center/i.test(loc);
}
function shouldHideRow(row, season) {
  const purpose = clean(row['Reservation Purpose'] || '');
  const facility = clean(row.Facility || '');

  // Never hide Open Pickleball
  if (isOpenPickleballPurpose(purpose)) return false;

  // Hide pure installation/placeholder lines for fieldhouse/turf (unless Open Pickleball)
  if (/Installed\s*per\s*NM/i.test(purpose) || /Turf\s*(Install|Season)\s*per\s*NM/i.test(purpose)) {
    return true;
  }

  // Let normal reservations through
  return false;
}

/* =========================
   Facility → room(s)
   ========================= */
const southNorthMap = {
  'AC Gym - Half Court 1A': ['1A'],
  'AC Gym - Half Court 1B': ['1B'],
  'AC Gym - Court 1-AB':    ['1A','1B'],

  'AC Gym - Half Court 2A': ['2A'],
  'AC Gym - Half Court 2B': ['2B'],
  'AC Gym - Court 2-AB':    ['2A','2B'],

  'AC Gym - Half Court 9A': ['9A'],
  'AC Gym - Half Court 9B': ['9B'],
  'AC Gym - Court 9-AB':    ['9A','9B'],

  'AC Gym - Half Court 10A':['10A'],
  'AC Gym - Half Court 10B':['10B'],
  'AC Gym - Court 10-AB':   ['10A','10B'],

  // Broad patterns we will collapse away by specificity:
  'AC Gym - Championship Court':      ['1A','1B','2A','2B'],
  'AC Gym - Full Gym 1AB & 2AB':      ['1A','1B','2A','2B'],
  'AC Gym - Full Gym 9 & 10':         ['9A','9B','10A','10B']
};

const fieldhouseCourtsMap = {
  'AC Fieldhouse - Court 3': ['3'],
  'AC Fieldhouse - Court 4': ['4'],
  'AC Fieldhouse - Court 5': ['5'],
  'AC Fieldhouse - Court 6': ['6'],
  'AC Fieldhouse - Court 7': ['7'],
  'AC Fieldhouse - Court 8': ['8'],
  'AC Fieldhouse Court 3-8': ['3','4','5','6','7','8']
};

const fieldhouseTurfMap = {
  'AC Fieldhouse - Quarter Turf NA': ['TNA'],
  'AC Fieldhouse - Quarter Turf NB': ['TNB'],
  'AC Fieldhouse - Quarter Turf SA': ['TSA'],
  'AC Fieldhouse - Quarter Turf SB': ['TSB'],
  'AC Fieldhouse - Half Turf North': ['TNA','TNB'],
  'AC Fieldhouse - Half Turf South': ['TSA','TSB'],
  'AC Fieldhouse - Full Turf':       ['TNA','TNB','TSA','TSB']
};

function mapFacilityToRooms(facility, season) {
  const f = clean(facility);

  // South / North
  if (southNorthMap[f]) return southNorthMap[f];

  // Fieldhouse
  if (season === 'turf') {
    if (fieldhouseTurfMap[f]) return fieldhouseTurfMap[f];
  } else {
    if (fieldhouseCourtsMap[f]) return fieldhouseCourtsMap[f];
  }

  return [];
}

/* =========================
   Specificity / collapse rules
   ========================= */
function specificityRank(facility) {
  const f = clean(facility);
  // Half > Court AB > Championship/Full Gym
  if (/Half Court (1A|1B|2A|2B|9A|9B|10A|10B)/i.test(f)) return 3;
  if (/Court (1-AB|2-AB|9-AB|10-AB)/i.test(f)) return 2;
  if (/Championship Court|Full Gym 1AB\s*&\s*2AB|Full Gym 9\s*&\s*10/i.test(f)) return 1;
  // Fieldhouse/turf: single quadrant = 3, half = 2, full=1
  if (/Quarter Turf (NA|NB|SA|SB)/i.test(f)) return 3;
  if (/Half Turf (North|South)/i.test(f)) return 2;
  if (/Full Turf|Court 3-8/i.test(f)) return 1;
  return 0;
}

/* =========================
   Main
   ========================= */
function pushSlot(out, roomId, startMin, endMin, title, subtitle) {
  out.push({ roomId, startMin, endMin, title, subtitle });
}

function main() {
  if (!fs.existsSync(INPUT_CSV) || fs.statSync(INPUT_CSV).size === 0) {
    const empty = {
      dayStartMin: DAY_START_MIN,
      dayEndMin: DAY_END_MIN,
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
    fs.writeFileSync(OUTPUT_JSON, JSON.stringify(empty, null, 2));
    console.log('transform: empty CSV -> scaffold written');
    return;
  }

  const raw = fs.readFileSync(INPUT_CSV, 'utf8');
  const rows = parseCSV(raw);

  const season = detectSeason(rows);
  // Build rooms list by season
  const rooms =
    (season === 'turf')
      ? [
          { id: '1A', label: '1A', group: 'south' },
          { id: '1B', label: '1B', group: 'south' },
          { id: '2A', label: '2A', group: 'south' },
          { id: '2B', label: '2B', group: 'south' },
          { id: 'TNA', label: 'Quarter Turf NA', group: 'fieldhouse' },
          { id: 'TNB', label: 'Quarter Turf NB', group: 'fieldhouse' },
          { id: 'TSA', label: 'Quarter Turf SA', group: 'fieldhouse' },
          { id: 'TSB', label: 'Quarter Turf SB', group: 'fieldhouse' },
          { id: '9A', label: '9A', group: 'north' },
          { id: '9B', label: '9B', group: 'north' },
          { id: '10A',label: '10A',group: 'north' },
          { id: '10B',label: '10B',group: 'north' }
        ]
      : [
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
        ];

  // Filter/prepare candidate items
  const candidates = [];
  for (const r of rows) {
    if (!rowIsRAEC(r)) continue;
    if (shouldHideRow(r, season)) continue;

    const range = parseRangeToMinutes(r['Reserved Time']);
    if (!range) continue;

    // Drop past items for today (but keep “now” & future)
    if (range.endMin <= DAY_START_MIN) continue;

    const roomsForFacility = mapFacilityToRooms(r.Facility, season);
    if (!roomsForFacility.length) continue;

    const { title, subtitle } = makeTitleSubtitle(r);

    candidates.push({
      reservee: clean(r['Reservee'] || ''),
      purpose: clean(r['Reservation Purpose'] || ''),
      facility: clean(r.Facility || ''),
      startMin: range.startMin,
      endMin:   range.endMin,
      rooms: roomsForFacility,
      title, subtitle,
      rank: specificityRank(r.Facility)
    });
  }

  // Collapse by reservee + overlapping time + room specificity
  // Key by group (same person/org, overlapping time window)
  const groups = [];
  for (const it of candidates) {
    // find overlapping group by same reservee & overlap
    let g = groups.find(g =>
      g.reservee.toLowerCase() === it.reservee.toLowerCase() &&
      overlaps(g, it)
    );
    if (!g) {
      g = { reservee: it.reservee, startMin: it.startMin, endMin: it.endMin, items: [] };
      groups.push(g);
    }
    // expand window
    g.startMin = Math.min(g.startMin, it.startMin);
    g.endMin   = Math.max(g.endMin,   it.endMin);
    g.items.push(it);
  }

  const slots = [];
  for (const g of groups) {
    // pick items with max rank per targeted area:
    // Approach:
    // 1) build room -> bestItem map using rank
    const roomBest = new Map();
    for (const it of g.items) {
      for (const roomId of it.rooms) {
        const curr = roomBest.get(roomId);
        if (!curr || it.rank > curr.rank) {
          roomBest.set(roomId, it);
        }
      }
    }
    // 2) Push one slot per kept room
    for (const [roomId, it] of roomBest.entries()) {
      pushSlot(slots, roomId, it.startMin, it.endMin, it.title, it.subtitle);
    }
  }

  // Build summary for logs
  const byRoom = {};
  for (const s of slots) byRoom[s.roomId] = (byRoom[s.roomId] || 0) + 1;

  const out = {
    dayStartMin: DAY_START_MIN,
    dayEndMin:   DAY_END_MIN,
    season,
    rooms,
    slots
  };

  fs.writeFileSync(OUTPUT_JSON, JSON.stringify(out, null, 2));
  console.log(`transform: season=${season} • slots=${slots.length} • byRoom=${JSON.stringify(byRoom)}`);
}

try {
  main();
} catch (e) {
  console.error('transform.mjs failed:', e);
  process.exit(1);
}
