#!/usr/bin/env node
// Transform latest CSV -> events.json with RAEC rules

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ---------- Paths ----------
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const INPUT_CSV   = process.env.IN_CSV   || path.join(__dirname, '..', 'data', 'inbox', 'latest.csv');
const OUTPUT_JSON = process.env.OUT_JSON || path.join(__dirname, '..', 'events.json');

// ---------- CSV parsing (simple/safe; no external deps) ----------
function parseCsvLoose(text) {
  // Handles commas and quoted fields with minimal fuss
  const rows = [];
  let i = 0, field = '', row = [], inQ = false;
  const pushField = () => { row.push(field); field = ''; };
  const pushRow = () => { rows.push(row); row = []; };
  while (i < text.length) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        // Peek for escaped quote
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQ = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQ = true; i++; continue; }
    if (c === ',') { pushField(); i++; continue; }
    if (c === '\n') { pushField(); pushRow(); i++; continue; }
    if (c === '\r') { i++; continue; }
    field += c; i++;
  }
  // flush
  pushField();
  if (row.length > 1 || (row.length === 1 && row[0] !== '')) pushRow();
  return rows;
}

// ---------- Helpers ----------
function cleanWhitespace(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}
function daysSinceMidnightMinutes(date = new Date()) {
  return date.getHours() * 60 + date.getMinutes();
}
function parseRangeToMinutes(text) {
  if (!text) return null;
  const m = String(text).trim().match(/(\d{1,2}:\d{2}\s*[ap]m)\s*-\s*(\d{1,2}:\d{2}\s*[ap]m)/i);
  if (!m) return null;
  return { startMin: toMin(m[1]), endMin: toMin(m[2]) };
}
function toMin(hhmmampm) {
  const s = String(hhmmampm).trim().toLowerCase();
  const m = s.match(/^(\d{1,2}):(\d{2})\s*([ap])m$/);
  if (!m) return null;
  let h = parseInt(m[1], 10), min = parseInt(m[2], 10);
  const mer = m[3];
  if (h === 12) h = 0;
  if (mer === 'p') h += 12;
  return h * 60 + min;
}

// Court vs turf season
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
  const thirdMonMar  = nthWeekdayOfMonth(y, 2, 1, 3); // March, Monday, 3rd
  const secondMonNov = nthWeekdayOfMonth(y, 10, 1, 2); // November, Monday, 2nd
  if (!thirdMonMar || !secondMonNov) return true;
  return (d >= thirdMonMar && d < secondMonNov);
}
const courtMode = isCourtSeason(new Date());

// Pickleball detection
function isPickleball(purpose, reservee) {
  return /pickleball/i.test(purpose) || /pickleball/i.test(reservee || '');
}

// Normalize “Reservee”
function normalizeReservee(raw) {
  const s = cleanWhitespace(raw);

  // Catch Corner
  if (/^catch\s*corner/i.test(s) || /^catchcorner/i.test(s)) {
    return { type: 'catch', org: 'Catch Corner', contact: '' };
  }

  // RAEC Front Desk (system entries)
  if (/raec\s*front\s*desk/i.test(s)) {
    return { type: 'system', org: 'RAEC Front Desk', contact: '' };
  }

  // "Org, Contact" or "Last, First"
  const parts = s.split(',').map(x => x.trim());
  if (parts.length >= 2) {
    const left = parts[0];
    const right = parts.slice(1).join(', ');

    // Looks like person "Last, First"
    if (/^[A-Za-z'.-]+\s+[A-Za-z'.-]+/.test(right) && /^[A-Za-z'.-]+$/.test(left)) {
      const firstLast = `${right} ${left}`.replace(/\s+/g, ' ').trim(); // First Last
      return { type: 'person', person: firstLast, org: '', contact: '' };
    }

    // Heuristic for org names
    if (/\b(Club|Elite|Training|Athletics|Sport|Sports|Basketball|Volleyball|Flight|Academy|United|Pink)\b/i.test(left)) {
      return { type: 'org+contact', org: left, contact: right };
    }
    // Default to org+contact
    return { type: 'org+contact', org: left, contact: right };
  }

  // Single token
  return { type: 'org', org: s, contact: '' };
}

// Robust facility -> rooms mapping (tolerant of spaces, dashes, “AB”, etc.)
function mapFacilityToRooms(facility) {
  const raw = String(facility || '');
  const f = raw.toLowerCase().replace(/\s+/g, ' ').trim();
  const fc = f.replace(/[^a-z0-9]+/g, ''); // collapsed

  const has = (needle) => fc.includes(needle);

  // --- South gym 1/2 ---
  if (has('acgymhalfcourt1a')) return ['1A'];
  if (has('acgymhalfcourt1b')) return ['1B'];
  if (has('acgymcourt1ab') || has('acgymcourt1a1b') || /ac gym\b.*court\s*1[^0-9]*ab/.test(f)) return ['1A','1B'];

  if (has('acgymhalfcourt2a')) return ['2A'];
  if (has('acgymhalfcourt2b')) return ['2B'];
  if (has('acgymcourt2ab') || has('acgymcourt2a2b') || /ac gym\b.*court\s*2[^0-9]*ab/.test(f)) return ['2A','2B'];

  // Full gym / championship → 1A,1B,2A,2B
  if (has('fullgym1ab2ab') || /full\s*gym\s*1\s*ab\s*&\s*2\s*ab/.test(f)) return ['1A','1B','2A','2B'];
  if (has('championshipcourt')) return ['1A','1B','2A','2B'];

  // --- North gym 9/10 ---
  if (has('acgymhalfcourt9a')) return ['9A'];
  if (has('acgymhalfcourt9b')) return ['9B'];
  if (has('acgymcourt9ab') || has('acgymcourt9a9b') || /ac gym\b.*court\s*9[^0-9]*ab/.test(f)) return ['9A','9B'];

  if (has('acgymhalfcourt10a')) return ['10A'];
  if (has('acgymhalfcourt10b')) return ['10B'];
  if (has('acgymcourt10ab') || has('acgymcourt10a10b') || /ac gym\b.*court\s*10[^0-9]*ab/.test(f)) return ['10A','10B'];

  // “Full Court 9 & 10”, “Courts 9-10”
  if (has('fullcourt9') && has('10')) return ['9A','9B','10A','10B'];
  if (/full\s*court.*9.*10/.test(f) || /courts?\s*9\s*[-–&]\s*10/.test(f)) return ['9A','9B','10A','10B'];

  // --- Fieldhouse (courts 3–8) ---
  const mSingle = f.match(/fieldhouse\s*-\s*court\s*([3-8])\b/);
  if (mSingle) return [mSingle[1]];
  if (/fieldhouse\s*-\s*court\s*3\s*-\s*8\b/.test(f)) return ['3','4','5','6','7','8'];

  // Turf (map regardless; season filter below decides show/hide)
  if (/fieldhouse.*full\s*turf/.test(f)) return ['3','4','5','6','7','8'];
  if (/fieldhouse.*half\s*turf\s*north/.test(f)) return ['6','7','8'];
  if (/fieldhouse.*half\s*turf\s*south/.test(f)) return ['3','4','5'];
  if (/fieldhouse.*quarter\s*turf\s*n[ab]/i.test(f)) return ['7','8'];
  if (/fieldhouse.*quarter\s*turf\s*s[ab]/i.test(f)) return ['3','4'];

  return [];
}

function cleanPurpose(purpose) {
  let s = cleanWhitespace(purpose);
  if (!s) return '';
  s = s.replace(/^\(+/, '').replace(/\)+$/, '');
  s = s.replace(/internal hold per nm/i, '').replace(/\s{2,}/g, ' ').trim();
  return s;
}

function makeSlot(roomId, startMin, endMin, title, subtitle, org = '', contact = '') {
  return { roomId, startMin, endMin, title, subtitle, org, contact };
}

function overlaps(a, b) { return a.startMin < b.endMin && b.startMin < a.endMin; }

// ---------- MAIN ----------
async function main() {
  // If no CSV, scaffold an empty display
  if (!fs.existsSync(INPUT_CSV) || fs.statSync(INPUT_CSV).size === 0) {
    const scaffold = {
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
    fs.writeFileSync(OUTPUT_JSON, JSON.stringify(scaffold, null, 2));
    return;
  }

  const rawCsv = fs.readFileSync(INPUT_CSV, 'utf8');
  const rows = parseCsvLoose(rawCsv);
  if (!rows || rows.length < 2) {
    // write scaffold if header only
    return mainEmpty();
  }

  const header = rows[0].map(h => String(h || '').trim());
  const idx = (name) => header.findIndex(h => h.toLowerCase() === name.toLowerCase());

  // Adjust these headers if the CSV changes naming
  const iLocation  = idx('Location:');
  const iFacility  = idx('Facility');
  const iTime      = idx('Reserved Time');
  const iReservee  = idx('Reservee');
  const iPurpose   = idx('Reservation Purpose');

  const items = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];

    const location = cleanWhitespace(row[iLocation]  || '');
    const facility = cleanWhitespace(row[iFacility]  || '');
    const timeText = cleanWhitespace(row[iTime]      || '');
    const reservee = cleanWhitespace(row[iReservee]  || '');
    const purpose  = cleanWhitespace(row[iPurpose]   || '');

    if (!facility || !timeText) continue;

    // Only RAEC
    if (location && !/athletic\s*&\s*event\s*center/i.test(location)) continue;

    // Court season: hide turf for fieldhouse 3..8
    if (courtMode && /fieldhouse.*turf/i.test(facility)) continue;

    // Hide RAEC front desk “internal hold”, “turf install per NM”, etc.
    if (/raec\s*front\s*desk/i.test(reservee) && /(hold|turf.*install|per\s*nm)/i.test(purpose)) continue;

    const range = parseRangeToMinutes(timeText);
    if (!range) continue;

    const rooms = mapFacilityToRooms(facility);
    if (!rooms.length) continue;

    const who = normalizeReservee(reservee);
    const pur = cleanPurpose(purpose);

    let title = '', subtitle = '', org = '', contact = '';
    if (isPickleball(purpose, reservee)) {
      title = 'Open Pickleball';
      subtitle = '';
      org = 'Open Pickleball';
      contact = '';
    } else if (who.type === 'catch') {
      title = 'Catch Corner';
      subtitle = pur;
      org = 'Catch Corner';
      contact = '';
    } else if (who.type === 'person') {
      title = who.person;            // full First Last
      subtitle = pur;
      org = who.person;
      contact = '';
    } else if (who.type === 'org+contact') {
      title = who.org;
      subtitle = pur || who.contact;
      org = who.org; contact = who.contact;
    } else {
      title = who.org || 'Reservation';
      subtitle = pur;
      org = who.org || ''; contact = who.contact || '';
    }

    items.push({
      rooms,
      startMin: range.startMin,
      endMin:   range.endMin,
      title, subtitle, org, contact,
      rawFacility: facility,
      rawReservee: reservee
    });
  }

  // Deduplicate Fieldhouse “Court 3-8” blankets vs specifics (same org/time overlap)
  const specifics = items.filter(it => it.rooms.length <= 2 || it.rooms.some(r => /^[3-8]$/.test(r)));
  const resultSlots = [];

  for (const it of items) {
    const isFieldhouseBlanket =
      it.rooms.every(r => /^[3-8]$/.test(r)) && it.rooms.length >= 4;

    if (isFieldhouseBlanket) {
      const keepRooms = it.rooms.filter(r => {
        const conflict = specifics.some(sp =>
          sp !== it &&
          sp.org.toLowerCase() === it.org.toLowerCase() &&
          overlaps(sp, it) &&
          sp.rooms.includes(r)
        );
        return !conflict;
      });
      for (const r of keepRooms) {
        resultSlots.push(makeSlot(r, it.startMin, it.endMin, it.title, it.subtitle, it.org, it.contact));
      }
      continue;
    }

    for (const r of it.rooms) {
      resultSlots.push(makeSlot(r, it.startMin, it.endMin, it.title, it.subtitle, it.org, it.contact));
    }
  }

  // De-dup exact duplicates (room+start+end+title)
  const dedup = [];
  const seen = new Set();
  for (const s of resultSlots) {
    const key = `${s.roomId}|${s.startMin}|${s.endMin}|${s.title}|${s.subtitle}`;
    if (!seen.has(key)) { seen.add(key); dedup.push(s); }
  }

  // Final JSON (UI filters out past events by endMin)
  const json = {
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
    slots: dedup
  };

  fs.writeFileSync(OUTPUT_JSON, JSON.stringify(json, null, 2));

  // Debug: report unmapped facilities
  const unmapped = new Map();
  for (const it of items) {
    if (!it.rooms || it.rooms.length === 0) {
      const key = (it.rawFacility || '').trim();
      unmapped.set(key, (unmapped.get(key) || 0) + 1);
    }
  }
  if (unmapped.size) {
    console.warn('Unmapped facilities (check mapping):');
    for (const [fac, cnt] of unmapped.entries()) {
      console.warn(`  ${fac}  × ${cnt}`);
    }
  }

  console.log(`Wrote events.json • rooms=${json.rooms.length} • slots=${json.slots.length}`);
}

async function mainEmpty() {
  const scaffold = {
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
  fs.writeFileSync(OUTPUT_JSON, JSON.stringify(scaffold, null, 2));
}

main().catch(err => {
  console.error('transform.mjs failed:', err);
  process.exit(1);
});
