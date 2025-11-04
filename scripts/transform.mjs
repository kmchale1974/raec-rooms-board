#!/usr/bin/env node
// scripts/transform.mjs
// Transform RAEC daily CSV -> events.json with Kevin's rules (no external csv lib)

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ---------- Paths ----------
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const INPUT_CSV   = process.env.IN_CSV   || path.join(__dirname, '..', 'data', 'inbox', 'latest.csv');
const OUTPUT_JSON = process.env.OUT_JSON || path.join(__dirname, '..', 'events.json');

// ---------- Tiny CSV parser (RFC4180-ish, enough for our feed) ----------
function parseCSV(text) {
  const rows = [];
  let i = 0, field = '', row = [], inQuotes = false;

  function pushField() { row.push(field); field = ''; }
  function pushRow()   { rows.push(row); row = []; }

  while (i < text.length) {
    const c = text[i];

    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }

    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ',') { pushField(); i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { pushField(); pushRow(); i++; continue; }

    field += c; i++;
  }
  // last field/row
  pushField();
  if (row.length > 1 || (row.length === 1 && row[0] !== '')) pushRow();

  return rows;
}

// ---------- Helpers ----------
function clean(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

function toMin(hhmm) {
  // "h:mm am" or "h:mm pm" (spaces around dash are inconsistent in CSV; we normalize)
  const m = String(hhmm).trim().toLowerCase().match(/^(\d{1,2}):(\d{2})\s*([ap])m$/);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const ap = m[3];
  if (h === 12) h = 0;
  if (ap === 'p') h += 12;
  return h * 60 + min;
}

function parseRangeToMinutes(text) {
  // e.g. " 5:30pm -  8:30pm" → startMin, endMin
  const m = String(text || '').replace(/\s*-\s*/g, ' - ').match(/(\d{1,2}:\d{2}\s*[ap]m)\s*-\s*(\d{1,2}:\d{2}\s*[ap]m)/i);
  if (!m) return null;
  const s = toMin(m[1]);
  const e = toMin(m[2]);
  return (s != null && e != null) ? { startMin: s, endMin: e } : null;
}

function nthWeekdayOfMonth(year, monthIdx, weekday, n) {
  const d = new Date(year, monthIdx, 1);
  let count = 0;
  while (d.getMonth() === monthIdx) {
    if (d.getDay() === weekday) {
      count++;
      if (count === n) return new Date(d);
    }
    d.setDate(d.getDate() + 1);
  }
  return null;
}

function isCourtSeason(d = new Date()) {
  const y = d.getFullYear();
  const thirdMonMar = nthWeekdayOfMonth(y, 2, 1, 3); // March
  const secondMonNov= nthWeekdayOfMonth(y,10, 1, 2); // November
  if (!thirdMonMar || !secondMonNov) return true;
  return (d >= thirdMonMar && d < secondMonNov);
}

function nameFromReservee(s) {
  // normalize “Last, First” → “First Last”
  const t = clean(s).replace(/\(.*?\)/g,'').trim(); // drop parenthetical notes
  const parts = t.split(',').map(x => x.trim()).filter(Boolean);
  if (parts.length >= 2 && /^[A-Za-z'.-]+$/.test(parts[0]) && /^[A-Za-z]/.test(parts[1])) {
    return `${parts.slice(1).join(' ')} ${parts[0]}`.replace(/\s+/g,' ').trim();
  }
  return t;
}

function isSystemHold(s) {
  return /front\s*desk/i.test(s) ||
         /internal hold per nm/i.test(s) ||
         /turf install/i.test(s);
}

function isPickleball(purpose, reservee) {
  return /pickleball/i.test(purpose) || /pickleball/i.test(reservee || '');
}

// Facility → candidate rooms
function mapFacilityToRooms(fac) {
  const f = clean(fac).toLowerCase();

  // helpful helpers for dash/space variants: "court 10-ab" vs "court 10 ab"
  const re = (s) => new RegExp(s, 'i');

  // South 1/2 halves
  if (re('^ac gym - half court\\s*1a$').test(f)) return ['1A'];
  if (re('^ac gym - half court\\s*1b$').test(f)) return ['1B'];
  if (re('^ac gym - court\\s*1[-\\s]?ab$').test(f)) return ['1A','1B'];

  if (re('^ac gym - half court\\s*2a$').test(f)) return ['2A'];
  if (re('^ac gym - half court\\s*2b$').test(f)) return ['2B'];
  if (re('^ac gym - court\\s*2[-\\s]?ab$').test(f)) return ['2A','2B'];

  // “Full Gym/Court 1AB & 2AB” & “Championship Court”
  if (re('full\\s*(?:gym|court)\\s*1ab\\s*&\\s*2ab').test(f)) return ['1A','1B','2A','2B'];
  if (re('championship\\s*court').test(f)) return ['1A','1B','2A','2B'];

  // North 9/10 halves
  if (re('^ac gym - half court\\s*9a$').test(f)) return ['9A'];
  if (re('^ac gym - half court\\s*9b$').test(f)) return ['9B'];
  if (re('^ac gym - court\\s*9[-\\s]?ab$').test(f)) return ['9A','9B'];

  if (re('^ac gym - half court\\s*10a$').test(f)) return ['10A'];
  if (re('^ac gym - half court\\s*10b$').test(f)) return ['10B'];
  if (re('^ac gym - court\\s*10[-\\s]?ab$').test(f)) return ['10A','10B'];

  // “Full Gym/Court 9 & 10” (handle “Full Court” variant)
  if (re('full\\s*(?:gym|court)\\s*9\\s*&\\s*10').test(f)) return ['9A','9B','10A','10B'];

  // Fieldhouse courts
  let m = f.match(/^ac fieldhouse - court\s*([3-8])$/i);
  if (m) return [m[1]];
  if (re('^ac fieldhouse - court\\s*3-8$').test(f)) return ['3','4','5','6','7','8'];

  // Turf variants (filtered out during court season elsewhere, but mapped here)
  if (re('^ac fieldhouse - full turf$').test(f)) return ['3','4','5','6','7','8'];
  if (re('^ac fieldhouse - half turf north$').test(f)) return ['6','7','8'];
  if (re('^ac fieldhouse - half turf south$').test(f)) return ['3','4','5'];

  return [];
}

// specificity rank: lower is more specific
function facilitySpecificity(f) {
  const s = clean(f).toLowerCase();
  if (/half court\s*1[ab]|half court\s*2[ab]|half court\s*9[ab]|half court\s*10[ab]/.test(s)) return 1;
  if (/court\s*1-ab|court\s*2-ab|court\s*9-ab|court\s*10-ab/.test(s)) return 2;
  if (/championship court|full gym 1ab & 2ab|full gym 9 & 10/.test(s)) return 3;
  if (/fieldhouse - court\s*[3-8]/.test(s)) return 1; // specific single fieldhouse court
  if (/fieldhouse - court 3-8/.test(s)) return 3;     // blanket
  // turf is context (3), but will be filtered in court season
  if (/turf/.test(s)) return 3;
  return 4;
}

function groupKey(item) {
  // group by cluster (south, north, fieldhouse), time window, and a normalized “who”
  const cluster =
    item.rooms.some(r => ['1A','1B','2A','2B'].includes(r)) ? 'south' :
    item.rooms.some(r => ['9A','9B','10A','10B'].includes(r)) ? 'north' :
    'field';
  const who = item.pick ? 'Open Pickleball'
            : item.person || item.org || 'Reservation';
  return `${cluster}__${item.startMin}__${item.endMin}__${who.toLowerCase()}`;
}

// ---------- Main ----------
function main() {
  if (!fs.existsSync(INPUT_CSV) || fs.statSync(INPUT_CSV).size === 0) {
    // empty scaffold
    const scaffold = {
      dayStartMin: 360,
      dayEndMin: 1380,
      rooms: [
        { id: '1A', label:'1A', group:'south' }, { id:'1B',label:'1B',group:'south' },
        { id: '2A', label:'2A', group:'south' }, { id:'2B',label:'2B',group:'south' },
        { id: '3', label:'3', group:'field' },   { id:'4',label:'4',group:'field' },
        { id: '5', label:'5', group:'field' },   { id:'6',label:'6',group:'field' },
        { id: '7', label:'7', group:'field' },   { id:'8',label:'8',group:'field' },
        { id: '9A',label:'9A',group:'north' },   { id:'9B',label:'9B',group:'north' },
        { id:'10A',label:'10A',group:'north' },  { id:'10B',label:'10B',group:'north' }
      ],
      slots: []
    };
    fs.writeFileSync(OUTPUT_JSON, JSON.stringify(scaffold, null, 2));
    return;
  }

  const raw = fs.readFileSync(INPUT_CSV, 'utf8');
  const rows = parseCSV(raw);
  if (rows.length < 2) {
    fs.writeFileSync(OUTPUT_JSON, JSON.stringify({ dayStartMin:360, dayEndMin:1380, rooms:[], slots:[] }, null, 2));
    return;
  }

  const header = rows[0].map(h => h.trim().toLowerCase());
  const idx = name => header.findIndex(h => h === name.toLowerCase());

  const iLocation = idx('location:');
  const iFacility = idx('facility');
  const iTime     = idx('reserved time');
  const iReservee = idx('reservee');
  const iPurpose  = idx('reservation purpose');

  const courtMode = isCourtSeason(new Date());
  const items = [];

  // build raw items
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const location = clean(row[iLocation] || '');
    const facility = clean(row[iFacility] || '');
    const timeText = clean(row[iTime]     || '');
    const reservee = clean(row[iReservee] || '');
    const purpose  = clean(row[iPurpose]  || '');

    if (!facility || !timeText) continue;
    if (location && !/athletic\s*&\s*event\s*center/i.test(location)) continue;

    // filter turf during court season
    if (courtMode && /fieldhouse.*turf/i.test(facility)) continue;

    // drop system holds
    if (isSystemHold(reservee) || isSystemHold(purpose)) continue;

    const range = parseRangeToMinutes(timeText);
    if (!range) continue;

    const rooms = mapFacilityToRooms(facility);
    if (!rooms.length) continue;

    const pick = isPickleball(purpose, reservee);
    const personName = pick ? '' : nameFromReservee(reservee);
    const orgName    = pick ? 'Open Pickleball' : '';

    items.push({
      facility,
      rooms,
      startMin: range.startMin,
      endMin:   range.endMin,
      pick,
      person: personName,
      org: orgName,
      purpose
    });
  }

  // Build best-per-group (specificity wins)
  const groups = new Map(); // key -> array of items
  for (const it of items) {
    const key = groupKey(it);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(it);
  }

  const nowLocal = new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' });
  const now = new Date(nowLocal);
  const nowMin = now.getHours() * 60 + now.getMinutes();

  const slots = [];

  for (const [_k, arr] of groups.entries()) {
    // For this time window and who/cluster, collect the *most specific* room assignment(s).
    // Strategy: sort by facility specificity; walk from most specific to least, union rooms.
    const sorted = arr.slice().sort((a,b) => facilitySpecificity(a.facility) - facilitySpecificity(b.facility));

    // gather the rooms from the most specific rows seen; if both halves appear, both show.
    const roomSet = new Set();
    let meta = sorted[0]; // take title data from most specific row

    for (const it of sorted) {
      for (const r of it.rooms) roomSet.add(r);
    }

    // filter out past-today
    if ((meta.endMin ?? 0) <= nowMin) continue;

    const title = meta.pick ? 'Open Pickleball'
                : (meta.person || meta.org || 'Reservation');
    const subtitle = meta.pick ? '' : meta.purpose;

    for (const r of roomSet) {
      slots.push({
        roomId: r,
        startMin: meta.startMin,
        endMin: meta.endMin,
        title,
        subtitle,
        org: meta.org || '',
        contact: ''
      });
    }
  }

  // Output
  const json = {
    dayStartMin: 360,
    dayEndMin: 1380,
    rooms: [
      { id: '1A', label:'1A', group:'south' }, { id:'1B',label:'1B',group:'south' },
      { id: '2A', label:'2A', group:'south' }, { id:'2B',label:'2B',group:'south' },
      { id: '3', label:'3', group:'field' },   { id:'4',label:'4',group:'field' },
      { id: '5', label:'5', group:'field' },   { id:'6',label:'6',group:'field' },
      { id: '7', label:'7', group:'field' },   { id:'8',label:'8',group:'field' },
      { id:'9A',label:'9A',group:'north' },    { id:'9B',label:'9B',group:'north' },
      { id:'10A',label:'10A',group:'north' },  { id:'10B',label:'10B',group:'north' }
    ],
    slots: slots.sort((a,b) => a.startMin - b.startMin || a.endMin - b.endMin)
  };

  fs.writeFileSync(OUTPUT_JSON, JSON.stringify(json, null, 2));
  console.log(`Wrote events.json • rooms=${json.rooms.length} • slots=${json.slots.length}`);
}

try {
  main();
} catch (e) {
  console.error('transform.mjs failed:', e);
  process.exit(1);
}
