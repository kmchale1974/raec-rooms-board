#!/usr/bin/env node
// scripts/transform.mjs
// Robust CSV -> events.json for RAEC board (no external CSV lib)

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ---------------- paths/env ----------------
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const INPUT_CSV   = process.env.IN_CSV  || path.join(__dirname, '..', 'data', 'inbox', 'latest.csv');
const OUTPUT_JSON = process.env.OUT_JSON || path.join(__dirname, '..', 'events.json');

const NOW = new Date(); // board runs “today-forward”
const DAY_START_MIN = 360;  // 6:00
const DAY_END_MIN   = 1380; // 23:00

// ---------------- tiny csv parser ----------------
// Handles quotes + commas inside quotes.
function splitCSVLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { // escaped quote
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

// ---------------- helpers ----------------
function clean(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }
function lcstripcolon(s){ return clean(s).replace(/:+$/, '').toLowerCase(); }

function hhmmToMin(hhmm) {
  const m = String(hhmm).trim().toLowerCase().match(/^(\d{1,2}):(\d{2})\s*([ap])m$/);
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
  const m = String(text).trim().match(/(\d{1,2}:\d{2}\s*[ap]m)\s*-\s*(\d{1,2}:\d{2}\s*[ap]m)/i);
  if (!m) return null;
  const startMin = hhmmToMin(m[1]);
  const endMin   = hhmmToMin(m[2]);
  if (startMin == null || endMin == null) return null;
  return { startMin, endMin };
}

function nameLastFirstToFirstLast(s) {
  // "Llanos, David" -> "David Llanos"
  const m = String(s).match(/^\s*([^,]+)\s*,\s*(.+)\s*$/);
  if (!m) return clean(s);
  return clean(`${m[2]} ${m[1]}`);
}

function isInternalHold(text) {
  const s = clean(text).toLowerCase();
  return (
    s.includes('front desk') ||
    s.includes('internal hold') ||
    s.includes('install per nm') ||
    s.includes('per nm')
  );
}

function isPickleball(str1, str2='') {
  const s1 = String(str1 || '').toLowerCase();
  const s2 = String(str2 || '').toLowerCase();
  return s1.includes('pickleball') || s2.includes('pickleball');
}

// Fieldhouse court season (Mar 3rd Mon → day before 2nd Mon Nov)
function nthWeekdayOfMonth(year, monthIdx, weekday, n) {
  const d = new Date(year, monthIdx, 1);
  let c = 0;
  while (d.getMonth() === monthIdx) {
    if (d.getDay() === weekday) {
      c++;
      if (c === n) return new Date(d);
    }
    d.setDate(d.getDate() + 1);
  }
  return null;
}
function isCourtSeason(d = new Date()) {
  const y = d.getFullYear();
  const thirdMonMar = nthWeekdayOfMonth(y, 2, 1, 3);
  const secondMonNov= nthWeekdayOfMonth(y,10, 1, 2);
  if (!thirdMonMar || !secondMonNov) return true;
  return d >= thirdMonMar && d < secondMonNov;
}
const COURT_SEASON = isCourtSeason(NOW);

// Facility → rooms mapping
function mapFacilityToRooms(fac) {
  const f = clean(fac).toLowerCase();

  // South: 1/2
  if (f === 'ac gym - half court 1a') return ['1A'];
  if (f === 'ac gym - half court 1b') return ['1B'];
  if (f === 'ac gym - court 1-ab')    return ['1A','1B'];

  if (f === 'ac gym - half court 2a') return ['2A'];
  if (f === 'ac gym - half court 2b') return ['2B'];
  if (f === 'ac gym - court 2-ab')    return ['2A','2B'];

  if (f.includes('full gym 1ab & 2ab') || f.includes('championship court')) return ['1A','1B','2A','2B'];

  // North: 9/10
  if (f === 'ac gym - half court 9a') return ['9A'];
  if (f === 'ac gym - half court 9b') return ['9B'];
  if (f === 'ac gym - court 9-ab')    return ['9A','9B'];

  if (f === 'ac gym - half court 10a') return ['10A'];
  if (f === 'ac gym - half court 10b') return ['10B'];
  if (f === 'ac gym - court 10-ab')    return ['10A','10B'];

  if (f.includes('full gym 9 & 10'))   return ['9A','9B','10A','10B'];

  // Fieldhouse: 3..8 (court season); otherwise turf (we still map for completeness)
  if (f.startsWith('ac fieldhouse - court ')) {
    const n = f.replace('ac fieldhouse - court ', '').trim();
    if (/^[3-8]$/.test(n)) return [n];
    if (n === '3-8') return ['3','4','5','6','7','8'];
  }
  if (f === 'ac fieldhouse - full turf') return ['3','4','5','6','7','8'];
  if (f === 'ac fieldhouse - half turf north') return ['6','7','8'];
  if (f === 'ac fieldhouse - half turf south') return ['3','4','5'];

  return [];
}

function overlaps(a, b) {
  return a.startMin < b.endMin && b.startMin < a.endMin;
}

// ---------------- main ----------------
async function main() {
  // scaffold if empty/missing
  if (!fs.existsSync(INPUT_CSV) || fs.statSync(INPUT_CSV).size === 0) {
    fs.writeFileSync(OUTPUT_JSON, JSON.stringify({
      dayStartMin: DAY_START_MIN,
      dayEndMin: DAY_END_MIN,
      rooms: [
        { id:'1A',label:'1A',group:'south'},{ id:'1B',label:'1B',group:'south'},
        { id:'2A',label:'2A',group:'south'},{ id:'2B',label:'2B',group:'south'},
        { id:'3',label:'3',group:'fieldhouse'},{ id:'4',label:'4',group:'fieldhouse'},
        { id:'5',label:'5',group:'fieldhouse'},{ id:'6',label:'6',group:'fieldhouse'},
        { id:'7',label:'7',group:'fieldhouse'},{ id:'8',label:'8',group:'fieldhouse'},
        { id:'9A',label:'9A',group:'north'},{ id:'9B',label:'9B',group:'north'},
        { id:'10A',label:'10A',group:'north'},{ id:'10B',label:'10B',group:'north'}
      ],
      slots:[]
    }, null, 2));
    console.log('transform: no CSV; wrote scaffold.');
    return;
  }

  const raw = fs.readFileSync(INPUT_CSV, 'utf8');
  const lines = raw.split(/\r?\n/).filter(l => l.trim().length > 0);
  if (lines.length < 2) {
    console.log('transform: CSV has header only; writing scaffold.');
    return main(); // recurse to scaffold
  }

  // Parse header with robust detection
  const headerCells = splitCSVLine(lines[0]).map(lcstripcolon);

  // Acceptable header variants
  const COL_LOC      = ['location', 'location '];
  const COL_FAC      = ['facility', 'facilities'];
  const COL_TIME     = ['reserved time','reservation time','time','event time'];
  const COL_RESERVEE = ['reservee','reserved by','name'];
  const COL_PURPOSE  = ['reservation purpose','purpose','description','event'];

  function findIdx(names){
    for (const n of names) {
      const i = headerCells.findIndex(h => h === n);
      if (i !== -1) return i;
    }
    // fuzzy: startsWith
    for (const n of names) {
      const i = headerCells.findIndex(h => h.startsWith(n));
      if (i !== -1) return i;
    }
    return -1;
  }

  const iLocation  = findIdx(COL_LOC);
  const iFacility  = findIdx(COL_FAC);
  const iTime      = findIdx(COL_TIME);
  const iReservee  = findIdx(COL_RESERVEE);
  const iPurpose   = findIdx(COL_PURPOSE);

  // debug some basics
  console.log('transform: header map', { iLocation, iFacility, iTime, iReservee, iPurpose });

  let kept = 0;
  const drop = { internal: 0, past: 0, noMap: 0, noTime: 0, nonRAEC: 0 };
  const rowsParsedSample = [];

  const prelim = [];

  for (let r = 1; r < lines.length; r++) {
    const cols = splitCSVLine(lines[r]);
    const location  = iLocation >= 0 ? clean(cols[iLocation])  : '';
    const facility  = iFacility >= 0 ? clean(cols[iFacility])  : '';
    const timeText  = iTime     >= 0 ? clean(cols[iTime])      : '';
    const reservee  = iReservee >= 0 ? clean(cols[iReservee])  : '';
    const purpose   = iPurpose  >= 0 ? clean(cols[iPurpose])   : '';

    if (rowsParsedSample.length < 3) {
      rowsParsedSample.push({ location, facility, timeText, reservee, purpose });
    }

    // Only Athletic & Event Center
    if (location && !/athletic\s*&\s*event\s*center/i.test(location)) {
      drop.nonRAEC++;
      continue;
    }

    if (isInternalHold(reservee) || isInternalHold(purpose)) {
      drop.internal++;
      continue;
    }

    const range = parseRangeToMinutes(timeText);
    if (!range) { drop.noTime++; continue; }

    // drop already-ended slots today (use a 5-minute grace)
    const nowMin = NOW.getHours() * 60 + NOW.getMinutes();
    if (range.endMin < nowMin - 5) { drop.past++; continue; }

    const rooms = mapFacilityToRooms(facility);
    if (!rooms.length) { drop.noMap++; continue; }

    // Fieldhouse: in court season, drop turf
    if (COURT_SEASON && /fieldhouse.*turf/i.test(facility)) {
      drop.noMap++; // treat as not-mapped during court season
      continue;
    }

    // Build normalized identity for precedence
    let title = '';
    let subtitle = '';

    // Pickleball override
    if (isPickleball(purpose, reservee)) {
      title = 'Open Pickleball';
      subtitle = '';
    } else {
      // Reservee normalization
      let who = clean(reservee);
      if (who.includes(',')) who = nameLastFirstToFirstLast(who);
      title = who || 'Reservation';
      subtitle = clean(purpose);
    }

    prelim.push({
      rooms, startMin: range.startMin, endMin: range.endMin,
      title, subtitle,
      orgKey: title.toLowerCase()
    });
    kept++;
  }

  // Precedence / de-dup:
  // If an org has Full/Championship/AB and specific halves, show ONLY the most specific (Half A/B) for overlapping times.
  const outSlots = [];
  const prelimByOrg = new Map();

  for (const it of prelim) {
    if (!prelimByOrg.has(it.orgKey)) prelimByOrg.set(it.orgKey, []);
    prelimByOrg.get(it.orgKey).push(it);
  }

  // classify facility “width”
  function widthScore(rooms) {
    // more specific gets higher score (Half = 2, AB = 1, Full gym = 0)
    if (rooms.length === 1) return 2;                    // 1A, 1B, etc.
    if (rooms.length === 2) return 1;                    // 1AB, 2AB, 9AB, 10AB
    return 0;                                            // Championship / Full Gym 1–2 / 9–10
  }

  for (const [, list] of prelimByOrg) {
    // For each org, eliminate lower-specificity items that overlap with higher-specificity items on same room set.
    // Strategy:
    // 1) Sort by specificity DESC.
    // 2) Walk, adding items; when adding a more specific item, we implicitly shadow overlapping broader items for that room.
    list.sort((a, b) => widthScore(b.rooms) - widthScore(a.rooms));

    const accepted = [];
    for (const cand of list) {
      // if more specific overlaps previously accepted? Accept; it will shadow broader ones later
      accepted.push(cand);
    }

    // Now, expand to final room-level slots but shadow broader-by-room.
    // For each broader item, skip rooms/times already covered by any more-specific accepted item for same org.
    const specificFirst = [...accepted].sort((a, b) => widthScore(b.rooms) - widthScore(a.rooms));
    const taken = []; // track {roomId,startMin,endMin} for this org

    for (const it of specificFirst) {
      const score = widthScore(it.rooms);
      for (const roomId of it.rooms) {
        const conflict = taken.some(t => t.roomId === roomId && overlaps(t, it));
        if (score === 2) {
          // most specific: always allowed; also mark taken
          outSlots.push({ roomId, startMin: it.startMin, endMin: it.endMin, title: it.title, subtitle: it.subtitle });
          taken.push({ roomId, startMin: it.startMin, endMin: it.endMin });
        } else if (score === 1) {
          // mid-specific (AB). Only add if not shadowed by a taken half
          if (!conflict) {
            outSlots.push({ roomId, startMin: it.startMin, endMin: it.endMin, title: it.title, subtitle: it.subtitle });
            taken.push({ roomId, startMin: it.startMin, endMin: it.endMin });
          }
        } else {
          // broad (Full/Championship). Only add if not shadowed by any taken
          if (!conflict) {
            outSlots.push({ roomId, startMin: it.startMin, endMin: it.endMin, title: it.title, subtitle: it.subtitle });
            taken.push({ roomId, startMin: it.startMin, endMin: it.endMin });
          }
        }
      }
    }
  }

  // Build JSON
  const json = {
    dayStartMin: DAY_START_MIN,
    dayEndMin: DAY_END_MIN,
    rooms: [
      { id:'1A',label:'1A',group:'south'},{ id:'1B',label:'1B',group:'south'},
      { id:'2A',label:'2A',group:'south'},{ id:'2B',label:'2B',group:'south'},
      { id:'3',label:'3',group:'fieldhouse'},{ id:'4',label:'4',group:'fieldhouse'},
      { id:'5',label:'5',group:'fieldhouse'},{ id:'6',label:'6',group:'fieldhouse'},
      { id:'7',label:'7',group:'fieldhouse'},{ id:'8',label:'8',group:'fieldhouse'},
      { id:'9A',label:'9A',group:'north'},{ id:'9B',label:'9B',group:'north'},
      { id:'10A',label:'10A',group:'north'},{ id:'10B',label:'10B',group:'north'}
    ],
    slots: outSlots
  };

  // Debug summary
  console.log(
    `transform: rows=${lines.length - 1} kept=${kept} slots=${outSlots.length} ` +
    `drop=${JSON.stringify(drop)}`
  );
  console.log('transform sample rows (first 3 parsed):', rowsParsedSample);

  fs.writeFileSync(OUTPUT_JSON, JSON.stringify(json, null, 2));
  console.log(`Wrote ${OUTPUT_JSON} • slots=${outSlots.length}`);
}

main().catch(err => {
  console.error('transform.mjs failed:', err);
  process.exit(1);
});
