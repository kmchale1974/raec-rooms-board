#!/usr/bin/env node
// CSV -> events.json with:
// - Gym placement: Half wins; else AB fans; ignore Full/Championship for placement
// - Turf season: quarters NA/NB/SA/SB; map Full/Half to quarters
// - Pickleball normalization
// - "Last, First" → "First Last"
// - Drop RAEC system holds / "Internal Hold per NM"
// - Hide past (relative to TZ)
// - Robust headers: Location/Facility/Reserved Time/Reservee/Reservation Purpose variants

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parse as parseCSV } from 'csv-parse/sync';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const INPUT_CSV   = process.env.IN_CSV   || path.join(__dirname, '..', 'data', 'inbox', 'latest.csv');
const OUTPUT_JSON = process.env.OUT_JSON || path.join(__dirname, '..', 'events.json');

// Board day window
const DAY_START_MIN = 360;   // 06:00
const DAY_END_MIN   = 1380;  // 23:00

// ---------- time helpers ----------
function parseRangeToMinutes(text) {
  if (!text) return null;
  const m = String(text).trim().match(
    /(\d{1,2})\s*:\s*(\d{2})\s*([ap]m)\s*-\s*(\d{1,2})\s*:\s*(\d{2})\s*([ap]m)/i
  );
  if (!m) return null;
  const toMin = (hh, mm, ampm) => {
    let h = parseInt(hh,10), min = parseInt(mm,10);
    const p = ampm.toLowerCase();
    if (h === 12) h = 0;
    if (p === 'pm') h += 12;
    return h*60 + min;
  };
  const startMin = toMin(m[1], m[2], m[3]);
  const endMin   = toMin(m[4], m[5], m[6]);
  return { startMin, endMin };
}

function minutesNowLocal() {
  // Runner has TZ=America/Chicago in your workflow; we can use system time
  const now = new Date();
  return now.getHours()*60 + now.getMinutes();
}

// ---------- string helpers ----------
function clean(s){ return String(s||'').replace(/\s+/g,' ').trim(); }

function field(row, ...names) {
  for (const n of names) {
    if (n in row && row[n] != null && String(row[n]).length) return row[n];
  }
  return '';
}

// ---------- labeling / normalization ----------
function normalizeReservee(raw) {
  const s = clean(raw);

  if (/^raec\s*front\s*desk/i.test(s)) return { type: 'system', org: 'RAEC Front Desk', contact: '' };
  if (/^catch\s*corner/i.test(s))     return { type: 'catch',  org: 'Catch Corner',     contact: '' };

  const parts = s.split(',').map(x => x.trim());
  if (parts.length >= 2) {
    const left  = parts[0];
    const right = parts.slice(1).join(', ');

    // "Last, First"
    if (/^[A-Za-z'.-]+\s+[A-Za-z'.-]+/.test(right) && /^[A-Za-z'.-]+$/.test(left)) {
      const firstLast = `${right} ${left}`.replace(/\s+/g,' ').trim();
      return { type:'person', person:firstLast, org:'', contact:'' };
    }
    return { type:'org+contact', org:left, contact:right };
  }
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

// ---------- season detection ----------
function detectFieldhouseSeason(rows) {
  let turfInstall = false, fieldhouseInstalled = false, turfKeywords = false;

  for (const r of rows) {
    const fac = clean(field(r, 'Facility', 'Facility:', 'fac'));
    const pur = clean(field(r, 'Reservation Purpose', 'Reservation Purpose:', 'Purpose'));

    if (/turf install per nm/i.test(pur)) turfInstall = true;
    if (/fieldhouse installed per nm/i.test(pur)) fieldhouseInstalled = true;

    if (/fieldhouse\s*-\s*(quarter|half|full)\s*turf/i.test(fac)) turfKeywords = true;
  }

  // Turf season when we see turf install (or explicit turf areas) and not "Fieldhouse Installed per NM"
  if ((turfInstall || turfKeywords) && !fieldhouseInstalled) return 'turf';
  return 'court';
}

// ---------- gym patterns ----------
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
  { re: /^ac gym - court 1-ab$/i, pair: '1' },
  { re: /^ac gym - court 2-ab$/i, pair: '2' },
  { re: /^ac gym - court 9-ab$/i, pair: '9' },
  { re: /^ac gym - court 10-ab$/i, pair:'10' },
];

function matchHalf(facility) {
  const f = clean(facility);
  for (const p of HALF_PATTERNS) if (p.re.test(f)) return p.id;
  return null;
}
function matchAB(facility) {
  const f = clean(facility);
  for (const p of AB_PATTERNS) if (p.re.test(f)) return p.pair;
  return null;
}

// ---------- room lists ----------
function fieldhouseRoomsFor(season) {
  if (season === 'turf') {
    return [
      { id:'NA', label:'Quarter Turf NA', group:'fieldhouse' },
      { id:'NB', label:'Quarter Turf NB', group:'fieldhouse' },
      { id:'SA', label:'Quarter Turf SA', group:'fieldhouse' },
      { id:'SB', label:'Quarter Turf SB', group:'fieldhouse' },
    ];
  }
  return [
    { id:'3', label:'3', group:'fieldhouse' },
    { id:'4', label:'4', group:'fieldhouse' },
    { id:'5', label:'5', group:'fieldhouse' },
    { id:'6', label:'6', group:'fieldhouse' },
    { id:'7', label:'7', group:'fieldhouse' },
    { id:'8', label:'8', group:'fieldhouse' },
  ];
}

function allRooms(season) {
  return [
    { id:'1A', label:'1A', group:'south' },
    { id:'1B', label:'1B', group:'south' },
    { id:'2A', label:'2A', group:'south' },
    { id:'2B', label:'2B', group:'south' },
    ...fieldhouseRoomsFor(season),
    { id:'9A',  label:'9A',  group:'north' },
    { id:'9B',  label:'9B',  group:'north' },
    { id:'10A', label:'10A', group:'north' },
    { id:'10B', label:'10B', group:'north' },
  ];
}

// ---------- build slots ----------
function buildSlots(rows, season) {
  const nowMin = minutesNowLocal();

  // Group by (reservee + start + end) to collect all facility lines that belong together
  const groups = new Map();

  const isRAEC = (loc) => /athletic\s*&\s*event\s*center/i.test(loc || '');

  for (const r of rows) {
    const location = clean(field(r, 'Location', 'Location:'));
    if (!isRAEC(location)) continue;

    const facility = clean(field(r, 'Facility', 'Facility:'));
    const timeText = clean(field(r, 'Reserved Time', 'Reserved Time:', 'Time'));
    const reservee = clean(field(r, 'Reservee', 'Reservee:', 'Reserved By'));
    const purpose  = clean(field(r, 'Reservation Purpose', 'Reservation Purpose:', 'Purpose'));

    if (!facility || !timeText) continue;

    // Drop RAEC system + internal holds from display
    if (/^raec\s*front\s*desk/i.test(reservee)) continue;
    if (/internal hold per nm/i.test(purpose)) continue;

    const range = parseRangeToMinutes(timeText);
    if (!range) continue;

    // hide past
    if (range.endMin <= nowMin) continue;

    const key = `${reservee}__${range.startMin}__${range.endMin}`;
    if (!groups.has(key)) {
      groups.set(key, {
        reservee,
        purpose,
        startMin: range.startMin,
        endMin:   range.endMin,
        facilities: []
      });
    }
    groups.get(key).facilities.push(facility);
  }

  const slots = [];

  for (const [, g] of groups) {
    const { startMin, endMin } = g;

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

    // -------- GYM MAPPING --------
    // Collect halves and AB pairs present in this group.
    const halves = new Set(); // 1A,1B,2A,2B,9A,9B,10A,10B
    const ab     = new Set(); // '1','2','9','10'

    for (const f of g.facilities) {
      const h = matchHalf(f); if (h) halves.add(h);
      const k = matchAB(f);   if (k) ab.add(k);
    }

    // Half wins; else AB fans; ignore Full/Championship completely for placement.
    const gymPairs = [
      { a:'1A', b:'1B', k:'1' },
      { a:'2A', b:'2B', k:'2' },
      { a:'9A', b:'9B', k:'9' },
      { a:'10A', b:'10B', k:'10' },
    ];

    function push(roomId){
      slots.push({ roomId, startMin, endMin, title, subtitle, org, contact });
    }

    for (const p of gymPairs) {
      const hasA = halves.has(p.a);
      const hasB = halves.has(p.b);
      if (hasA || hasB) {
        if (hasA) push(p.a);
        if (hasB) push(p.b);
        continue; // ignore AB when halves exist
      }
      if (ab.has(p.k)) {
        push(p.a); push(p.b);
      }
    }

    // -------- FIELDHOUSE (TURF) MAPPING --------
    if (season === 'turf') {
      // Quarter detection
      let hasNA=false, hasNB=false, hasSA=false, hasSB=false;
      let hasHalfNorth=false, hasHalfSouth=false, hasFull=false;

      for (const f of g.facilities) {
        const ff = f.toLowerCase();

        if (/fieldhouse\s*-\s*quarter\s*turf\s*na/i.test(ff)) hasNA = true;
        if (/fieldhouse\s*-\s*quarter\s*turf\s*nb/i.test(ff)) hasNB = true;
        if (/fieldhouse\s*-\s*quarter\s*turf\s*sa/i.test(ff)) hasSA = true;
        if (/fieldhouse\s*-\s*quarter\s*turf\s*sb/i.test(ff)) hasSB = true;

        if (/fieldhouse\s*-\s*half\s*turf\s*north/i.test(ff)) hasHalfNorth = true;
        if (/fieldhouse\s*-\s*half\s*turf\s*south/i.test(ff)) hasHalfSouth = true;

        if (/fieldhouse\s*-\s*full\s*turf/i.test(ff)) hasFull = true;
      }

      // Expand Full/Half to quarters (and keep any explicit quarters)
      if (hasFull) { hasNA = true; hasNB = true; hasSA = true; hasSB = true; }
      if (hasHalfNorth) { hasNA = true; hasNB = true; }
      if (hasHalfSouth) { hasSA = true; hasSB = true; }

      if (hasNA) push('NA');
      if (hasNB) push('NB');
      if (hasSA) push('SA');
      if (hasSB) push('SB');
    }

    // -------- FIELDHOUSE (COURT) MAPPING --------
    if (season === 'court') {
      // Keep your previous 3..8 mapping only if you actually want to display them here.
      // (Given your latest guidance, courts 3..8 are replaced by turf quarters during turf season,
      // and during court season you will have lines like "AC Fieldhouse - Court 3", etc.)
      for (const f of g.facilities) {
        const m = String(f).match(/^AC Fieldhouse - Court\s*([3-8])$/i);
        if (m) push(m[1]);
      }
      // A blanket "AC Fieldhouse Court 3-8" → fan to 3..8 (only if not internal/system)
      if (g.facilities.some(f => /AC Fieldhouse Court 3-8/i.test(f))) {
        ['3','4','5','6','7','8'].forEach(push);
      }
    }
  }

  return slots;
}

// ---------- main ----------
function main() {
  if (!fs.existsSync(INPUT_CSV) || fs.statSync(INPUT_CSV).size === 0) {
    const json = { dayStartMin: DAY_START_MIN, dayEndMin: DAY_END_MIN, rooms: allRooms('court'), slots: [] };
    fs.writeFileSync(OUTPUT_JSON, JSON.stringify(json, null, 2));
    console.log('transform: no CSV; wrote scaffold (court) with 0 slots');
    return;
  }

  const raw = fs.readFileSync(INPUT_CSV, 'utf8');
  const rows = parseCSV(raw, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    trim: true,
  });

  const season = detectFieldhouseSeason(rows);
  const slots  = buildSlots(rows, season);
  const rooms  = allRooms(season);

  const json = { dayStartMin: DAY_START_MIN, dayEndMin: DAY_END_MIN, rooms, slots };
  fs.writeFileSync(OUTPUT_JSON, JSON.stringify(json, null, 2));

  // small summary for workflow logs
  const byRoom = {};
  for (const s of slots) byRoom[s.roomId] = (byRoom[s.roomId]||0) + 1;
  console.log(`transform: season=${season} • slots=${slots.length} • byRoom=${JSON.stringify(byRoom)}`);
}

try {
  main();
} catch (err) {
  console.error('transform.mjs failed:', err);
  process.exit(1);
}
