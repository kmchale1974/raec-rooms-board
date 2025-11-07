#!/usr/bin/env node
// CSV -> events.json with:
// - Gym placement: Half wins; else AB fans; ignore Full/Championship for placement
// - Turf season: quarters NA/NB/SA/SB; map Full/Half to quarters
// - Pickleball normalization
// - "Last, First" → "First Last"
// - Drop RAEC system holds / "Internal Hold per NM"
// - Hide past (relative to TZ)
// - Forgiving regex for gym facility parsing

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parse as parseCSV } from 'csv-parse/sync';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const INPUT_CSV   = process.env.IN_CSV   || path.join(__dirname, '..', 'data', 'inbox', 'latest.csv');
const OUTPUT_JSON = process.env.OUT_JSON || path.join(__dirname, '..', 'events.json');

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
  if ((turfInstall || turfKeywords) && !fieldhouseInstalled) return 'turf';
  return 'court';
}

// ---------- forgiving gym parsers ----------
const reHalf = /^ac\s*gym\s*-\s*half\s*court\s*(1|2|9|10)\s*([ab])\s*$/i;
const reAB   = /^ac\s*gym\s*-\s*court\s*(1|2|9|10)\s*-\s*ab\s*$/i;
// Ignore-only (do not place)
const reFull = /^ac\s*gym\s*-\s*full\s*gym\s*1ab\s*&\s*2ab\s*$/i;
const reChamp= /^ac\s*gym\s*-\s*championship\s*court\s*$/i;

function parseHalfId(fac) {
  const m = clean(fac).match(reHalf);
  if (!m) return null;
  const num = m[1];
  const letter = m[2].toUpperCase();
  return (num === '10') ? `10${letter}` : `${num}${letter}`;
}
function parseABPair(fac) {
  const m = clean(fac).match(reAB);
  return m ? m[1] : null; // '1','2','9','10'
}
function isGymIgnore(fac) {
  const f = clean(fac);
  return reFull.test(f) || reChamp.test(f);
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

    // Title/subtitle
    const who = normalizeReservee(g.reservee);
    const pur = cleanPurpose(g.purpose);
    let title = '', subtitle = '', org = '', contact = '';

    if (isPickleball(g.purpose, g.reservee)) {
      title = 'Open Pickleball'; subtitle = ''; org = 'Open Pickleball';
    } else if (who.type === 'catch') {
      title = 'Catch Corner'; subtitle = pur; org = 'Catch Corner';
    } else if (who.type === 'person') {
      title = who.person; subtitle = pur; org = who.person;
    } else if (who.type === 'org+contact') {
      title = who.org; subtitle = pur || who.contact; org = who.org; contact = who.contact;
    } else {
      title = who.org || 'Reservation'; subtitle = pur; org = who.org || '';
    }

    const push = (roomId) =>
      slots.push({ roomId, startMin, endMin, title, subtitle, org, contact });

    // -------- GYM MAPPING (forgiving) --------
    const halves = new Set(); // 1A,1B,2A,2B,9A,9B,10A,10B
    const ab     = new Set(); // '1','2','9','10'
    let gymFacSeen = 0;

    for (const f of g.facilities) {
      if (isGymIgnore(f)) continue;
      const h = parseHalfId(f);    if (h) { halves.add(h); gymFacSeen++; continue; }
      const k = parseABPair(f);    if (k) { ab.add(k);     gymFacSeen++; continue; }
      // not a gym item — might be fieldhouse/turf/etc., ignore here
    }

    const gymPairs = [
      { a:'1A', b:'1B', k:'1' },
      { a:'2A', b:'2B', k:'2' },
      { a:'9A', b:'9B', k:'9' },
      { a:'10A', b:'10B', k:'10' },
    ];

    for (const p of gymPairs) {
      const hasA = halves.has(p.a);
      const hasB = halves.has(p.b);
      if (hasA || hasB) {
        if (hasA) push(p.a);
        if (hasB) push(p.b);
        continue; // halves win
      }
      if (ab.has(p.k)) {
        push(p.a); push(p.b);
      }
    }

    // -------- FIELDHOUSE (TURF) MAPPING --------
    if (season === 'turf') {
      let hasNA=false, hasNB=false, hasSA=false, hasSB=false;
      let hasHalfNorth=false, hasHalfSouth=false, hasFull=false;

      for (const f of g.facilities) {
        const ff = f.toLowerCase();

        if (/fieldhouse\s*-\s*quarter\s*turf\s*na/.test(ff)) hasNA = true;
        if (/fieldhouse\s*-\s*quarter\s*turf\s*nb/.test(ff)) hasNB = true;
        if (/fieldhouse\s*-\s*quarter\s*turf\s*sa/.test(ff)) hasSA = true;
        if (/fieldhouse\s*-\s*quarter\s*turf\s*sb/.test(ff)) hasSB = true;

        if (/fieldhouse\s*-\s*half\s*turf\s*north/.test(ff)) hasHalfNorth = true;
        if (/fieldhouse\s*-\s*half\s*turf\s*south/.test(ff)) hasHalfSouth = true;

        if (/fieldhouse\s*-\s*full\s*turf/.test(ff)) hasFull = true;
      }

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
      for (const f of g.facilities) {
        const m = String(f).match(/^AC Fieldhouse - Court\s*([3-8])$/i);
        if (m) push(m[1]);
      }
      if (g.facilities.some(f => /AC Fieldhouse Court 3-8/i.test(f))) {
        ['3','4','5','6','7','8'].forEach(push);
      }
    }

    // Optional tiny debug in logs for gym recognition
    if (gymFacSeen && ![...halves, ...['1','2','9','10'].filter(k=>ab.has(k))].length) {
      // If we saw gym-like facs but mapped none, log the facilities once
      // (kept minimal so logs stay clean)
      // console.log('debug: gym facilities seen but no map', g.reservee, g.facilities);
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
