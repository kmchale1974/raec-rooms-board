#!/usr/bin/env node
// scripts/transform.mjs
// CSV -> events.json with gym-half selection, AB fallback, turf/court season switch,
// pickleball normalization, RAEC holds filtering, and past-event filtering.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parse as parseCSV } from 'csv-parse/sync';

// ---------- Paths ----------
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const INPUT_CSV   = process.env.IN_CSV   || path.join(__dirname, '..', 'data', 'inbox', 'latest.csv');
const OUTPUT_JSON = process.env.OUT_JSON || path.join(__dirname, '..', 'events.json');

// ---------- Time helpers ----------
const DAY_START_MIN = 360;   // 6:00 AM
const DAY_END_MIN   = 1380;  // 11:00 PM

function pad(n){ return n < 10 ? '0'+n : ''+n; }
function parseRangeToMinutes(text) {
  if (!text) return null;
  // tolerant: " 7:00pm -  9:00pm" and "7:00 PM - 9:00 PM"
  const m = String(text).trim().match(/(\d{1,2})\s*:\s*(\d{2})\s*([ap]m)\s*-\s*(\d{1,2})\s*:\s*(\d{2})\s*([ap]m)/i);
  if (!m) return null;
  const toMin = (hh, mm, ampm) => {
    let h = parseInt(hh,10), m = parseInt(mm,10);
    const p = ampm.toLowerCase();
    if (h === 12) h = 0;
    if (p === 'pm') h += 12;
    return h*60 + m;
  };
  const startMin = toMin(m[1], m[2], m[3]);
  const endMin   = toMin(m[4], m[5], m[6]);
  return { startMin, endMin };
}

function minutesNowInChicago() {
  // crude local clock is fine for signage; if you must force TZ, set TZ=America/Chicago in workflow
  const now = new Date();
  return now.getHours()*60 + now.getMinutes();
}

// ---------- String helpers ----------
function clean(s){ return String(s||'').replace(/\s+/g,' ').trim(); }

function normalizeReservee(raw) {
  const s = clean(raw);

  // RAEC system lines
  if (/^raec\s*front\s*desk/i.test(s)) return { type: 'system', org: 'RAEC Front Desk', contact: '' };

  // "Catch Corner" handling
  if (/^catch\s*corner/i.test(s)) return { type: 'catch', org: 'Catch Corner', contact: '' };

  // Pattern "Org, Contact"
  const parts = s.split(',').map(x => x.trim());
  if (parts.length >= 2) {
    const left = parts[0];
    const right = parts.slice(1).join(', ');

    // If "Last, First" person
    if (/^[A-Za-z'.-]+\s+[A-Za-z'.-]+/.test(right) && /^[A-Za-z'.-]+$/.test(left)) {
      const firstLast = `${right} ${left}`.replace(/\s+/g,' ').trim();
      return { type:'person', person:firstLast, org:'', contact:'' };
    }
    // Else org + contact
    return { type:'org+contact', org:left, contact:right };
  }

  // Single token -> org
  return { type:'org', org:s, contact:'' };
}

function cleanPurpose(purpose) {
  let s = clean(purpose);
  if (!s) return '';
  s = s.replace(/^\(+/, '').replace(/\)+$/, '');
  s = s.replace(/internal hold per nm/i,'').trim();
  return s;
}

function isPickleball(purpose, reservee) {
  return /pickleball/i.test(purpose || '') || /pickleball/i.test(reservee || '');
}

// ---------- Fieldhouse season detect ----------
function detectFieldhouseSeason(rows) {
  // If any row shows "Reservation Purpose" => "Turf Install per NM", treat as TURF season (2×2 quarters)
  let turfInstall = false, fieldhouseInstalled = false;

  for (const r of rows) {
    const fac = clean(r.Facility || r['Facility:'] || '');
    const pur = clean(r['Reservation Purpose'] || r.Purpose || r['Reservation Purpose:'] || '');
    if (/turf install per nm/i.test(pur)) turfInstall = true;
    if (/fieldhouse installed per nm/i.test(pur)) fieldhouseInstalled = true;

    // Also, explicit quarters/north/south presence strongly implies turf layout active today
    if (/fieldhouse\s*-\s*quarter turf/i.test(fac) || /fieldhouse\s*-\s*half turf/i.test(fac) || /fieldhouse\s*-\s*full turf/i.test(fac)) {
      turfInstall = true;
    }
  }
  return turfInstall && !fieldhouseInstalled ? 'turf' : 'court';
}

// ---------- Gym facility parsing ----------
const HALF_PATTERNS = [
  { re: /^ac gym - half court 1a$/i, id: '1A' },
  { re: /^ac gym - half court 1b$/i, id: '1B' },
  { re: /^ac gym - half court 2a$/i, id: '2A' },
  { re: /^ac gym - half court 2b$/i, id: '2B' },
  { re: /^ac gym - half court 9a$/i, id: '9A' },
  { re: /^ac gym - half court 9b$/i, id: '9B' },
  { re: /^ac gym - half court 10a$/i, id: '10A' },
  { re: /^ac gym - half court 10b$/i, id: '10B' },
];

const AB_PATTERNS = [
  { re: /^ac gym - court 1-ab$/i, ids: ['1A','1B'] },
  { re: /^ac gym - court 2-ab$/i, ids: ['2A','2B'] },
  { re: /^ac gym - court 9-ab$/i, ids: ['9A','9B'] },
  { re: /^ac gym - court 10-ab$/i, ids: ['10A','10B'] },
];

function matchHalf(facility) {
  const f = clean(facility);
  for (const p of HALF_PATTERNS) if (p.re.test(f)) return p.id;
  return null;
}
function matchAB(facility) {
  const f = clean(facility);
  for (const p of AB_PATTERNS) if (p.re.test(f)) return p.ids;
  return null;
}

// ---------- Rooms list builder ----------
function roomsForSeason(season) {
  if (season === 'turf') {
    return [
      { id: 'NA', label:'Quarter Turf NA', group:'fieldhouse' },
      { id: 'NB', label:'Quarter Turf NB', group:'fieldhouse' },
      { id: 'SA', label:'Quarter Turf SA', group:'fieldhouse' },
      { id: 'SB', label:'Quarter Turf SB', group:'fieldhouse' },
    ];
  }
  // court season
  return [
    { id:'3',  label:'3',  group:'fieldhouse' },
    { id:'4',  label:'4',  group:'fieldhouse' },
    { id:'5',  label:'5',  group:'fieldhouse' },
    { id:'6',  label:'6',  group:'fieldhouse' },
    { id:'7',  label:'7',  group:'fieldhouse' },
    { id:'8',  label:'8',  group:'fieldhouse' },
  ];
}

function baseRooms(season) {
  return [
    { id:'1A', label:'1A', group:'south' },
    { id:'1B', label:'1B', group:'south' },
    { id:'2A', label:'2A', group:'south' },
    { id:'2B', label:'2B', group:'south' },
    ...roomsForSeason(season),
    { id:'9A', label:'9A', group:'north' },
    { id:'9B', label:'9B', group:'north' },
    { id:'10A', label:'10A', group:'north' },
    { id:'10B', label:'10B', group:'north' },
  ];
}

// ---------- Main ----------
function buildSlots(rows) {
  const nowMin = minutesNowInChicago();

  // Group rows by (reservee + exact time range). Each group may contain Half, AB, Full, Championship lines.
  const groups = new Map();

  const locOk = (loc) => /athletic\s*&\s*event\s*center/i.test(loc || '');

  for (const r of rows) {
    const location = clean(r['Location'] || r['Location:'] || r.Location || '');
    if (!locOk(location)) continue;

    const facility = clean(r['Facility'] || r['Facility:'] || r.Facility || '');
    const timeText = clean(r['Reserved Time'] || r['Reserved Time:'] || r['Time'] || '');
    const reservee = clean(r['Reservee'] || r['Reservee:'] || r['Reserved By'] || '');
    const purpose  = clean(r['Reservation Purpose'] || r.Purpose || r['Reservation Purpose:'] || '');

    if (!facility || !timeText) continue;

    // Filter out RAEC system and internal “holds” from *display*
    if (/^raec\s*front\s*desk/i.test(reservee)) continue;
    if (/internal hold per nm/i.test(purpose)) continue;

    const range = parseRangeToMinutes(timeText);
    if (!range) continue;

    // Hide past items
    if (range.endMin <= nowMin) continue;

    const key = `${reservee}__${range.startMin}__${range.endMin}`;
    if (!groups.has(key)) groups.set(key, {
      rows: [],
      startMin: range.startMin,
      endMin: range.endMin,
      reservee,
      purpose,
    });
    groups.get(key).rows.push({ facility, purpose, reservee });
  }

  const slots = [];
  for (const [, g] of groups) {
    const startMin = g.startMin, endMin = g.endMin;

    // Extract all gym-related hints for this group
    const halves = new Set();   // e.g., '1A','1B','2A','2B','9A','9B','10A','10B'
    const ab     = new Set();   // '1','2','9','10' (pair keys)

    // Track turf quarters that actually appear (for when season=turf)
    const turfQuarters = new Set(); // NA/NB/SA/SB

    for (const row of g.rows) {
      const f = row.facility;

      // Gym half
      const id = matchHalf(f);
      if (id) { halves.add(id); continue; }

      // Gym AB
      const ids = matchAB(f);
      if (ids) {
        const pair = ids[0].replace(/[AB]/g,''); // '1A' -> '1'
        ab.add(pair);
        continue;
      }

      // Turf quarter presence (used only in turf season to show the correct four squares)
      if (/fieldhouse\s*-\s*quarter turf\s*na/i.test(f)) turfQuarters.add('NA');
      if (/fieldhouse\s*-\s*quarter turf\s*nb/i.test(f)) turfQuarters.add('NB');
      if (/fieldhouse\s*-\s*quarter turf\s*sa/i.test(f)) turfQuarters.add('SA');
      if (/fieldhouse\s*-\s*quarter turf\s*sb/i.test(f)) turfQuarters.add('SB');

      // Half Turf North/South (we won’t fan these automatically; signage is by quarters NA/NB/SA/SB)
      // Full Turf similarly not fanned (just indicates turf season)
    }

    // Decide title/subtitle
    const who = normalizeReservee(g.reservee);
    const pur = cleanPurpose(g.purpose);
    let title = '', subtitle = '', org = '', contact = '';

    if (isPickleball(g.purpose, g.reservee)) {
      title = 'Open Pickleball';
      subtitle = '';
      org = 'Open Pickleball';
    } else if (who.type === 'catch') {
      title = 'Catch Corner';
      subtitle = pur;
      org = 'Catch Corner';
    } else if (who.type === 'person') {
      title = who.person;
      subtitle = pur;
      org = who.person;
    } else if (who.type === 'org+contact') {
      title = who.org;
      subtitle = pur || who.contact;
      org = who.org; contact = who.contact;
    } else {
      title = who.org || 'Reservation';
      subtitle = pur;
      org = who.org || '';
    }

    // ROOM PLACEMENT (GYM): Half wins. If no half for a pair but AB present, expand to both halves.
    function pushSlot(roomId) {
      slots.push({ roomId, startMin, endMin, title, subtitle, org, contact });
    }

    const pairs = [
      { a:'1A', b:'1B', k:'1' },
      { a:'2A', b:'2B', k:'2' },
      { a:'9A', b:'9B', k:'9' },
      { a:'10A',b:'10B',k:'10' },
    ];

    for (const p of pairs) {
      const hasA = halves.has(p.a);
      const hasB = halves.has(p.b);
      if (hasA || hasB) {
        if (hasA) pushSlot(p.a);
        if (hasB) pushSlot(p.b);
        continue; // ignore AB/full/champ for this pair
      }
      // No half in this pair; check AB
      if (ab.has(p.k)) {
        pushSlot(p.a); pushSlot(p.b);
      }
      // Ignore Full Gym / Championship by design to prevent over-filling other pairs
    }

    // TURF QUARTERS: if present, add those quarters (the season builder will render the 2x2 board)
    for (const q of turfQuarters) {
      pushSlot(q);
    }
  }

  return slots;
}

// ---------- Entrypoint ----------
function main() {
  if (!fs.existsSync(INPUT_CSV) || fs.statSync(INPUT_CSV).size === 0) {
    // scaffold
    const season = 'court';
    const json = { dayStartMin: DAY_START_MIN, dayEndMin: DAY_END_MIN, rooms: baseRooms(season), slots: [] };
    fs.writeFileSync(OUTPUT_JSON, JSON.stringify(json, null, 2));
    console.log('transform: no CSV; wrote scaffold with 0 slots');
    return;
  }

  const raw = fs.readFileSync(INPUT_CSV, 'utf8');
  // Some CSVs come with duplicated headers or uneven columns, so relax a bit.
  const rows = parseCSV(raw, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    trim: true
  });

  // Decide Fieldhouse season from the CSV content
  const season = detectFieldhouseSeason(rows);

  // Build slots per rules
  const slots = buildSlots(rows);

  // Compose final rooms list (South + Fieldhouse season + North)
  const rooms = baseRooms(season);

  const json = { dayStartMin: DAY_START_MIN, dayEndMin: DAY_END_MIN, rooms, slots };
  fs.writeFileSync(OUTPUT_JSON, JSON.stringify(json, null, 2));

  const kept = slots.length;
  console.log(`transform: season=${season} • slots=${kept}`);
}

try {
  main();
} catch (err) {
  console.error('transform.mjs failed:', err);
  process.exit(1);
}
