#!/usr/bin/env node
// scripts/transform.mjs
// RAEC: TSV -> events.json with south/north + fieldhouse/turf logic

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

/* -------------------- Setup -------------------- */
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const INPUT_CSV   = process.env.IN_CSV   || path.join(__dirname, '..', 'data', 'inbox', 'latest.csv');
const OUTPUT_JSON = process.env.OUT_JSON || path.join(__dirname, '..', 'events.json');

// Board day window (06:00–23:00)
const DAY_START_MIN = 6 * 60;
const DAY_END_MIN   = 23 * 60;

/* -------------------- Utils -------------------- */
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

function parseTSV(text) {
  // Your reports are tab-separated; split safely on \t
  const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
  if (!lines.length) return { header: [], rows: [] };
  const header = lines[0].split('\t').map(h => h.trim());
  const idx = Object.fromEntries(header.map((h,i) => [h, i]));
  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split('\t');
    const obj  = {};
    header.forEach((h, j) => { obj[h] = (cols[j] ?? '').trim(); });
    rows.push(obj);
  }
  return { header, rows, idx };
}

function toMinutes(hmm) {
  // "7:30pm" / " 7:30pm" / "7:30 pm" (we'll be lenient)
  const s = clean(hmm).toLowerCase();
  const m = s.match(/^(\d{1,2}):(\d{2})\s*([ap])m$/);
  if (!m) return null;
  let h = parseInt(m[1], 10), min = parseInt(m[2], 10);
  const mer = m[3];
  if (h === 12) h = 0;
  if (mer === 'p') h += 12;
  return h * 60 + min;
}

function parseRangeToMinutes(range) {
  // " 6:30pm -  7:30pm" (spaces irregular)
  const m = String(range || '').match(/(\d{1,2}:\d{2}\s*[ap]m)\s*-\s*(\d{1,2}:\d{2}\s*[ap]m)/i);
  if (!m) return null;
  const startMin = toMinutes(m[1]);
  const endMin   = toMinutes(m[2]);
  if (startMin == null || endMin == null) return null;
  return { startMin, endMin };
}

function isToday(date) {
  // CSV is "Daily" so we assume rows are for today; keep function for safety
  return true;
}

function nowMinutesLocal() {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

function normalizePerson(reserveeRaw) {
  // "Last, First" -> "First Last"; otherwise return as-is
  const s = clean(reserveeRaw);
  const parts = s.split(',').map(p => p.trim());
  if (parts.length >= 2 && /^[A-Za-z'.-]+$/.test(parts[0])) {
    // looks like "Last, First [more]"
    const first = parts.slice(1).join(', ');
    return clean(`${first} ${parts[0]}`);
  }
  return s;
}

function extractWelch(purposeRaw) {
  // "Volleyball - Hold per NM for WELCH VB" => "Welch VB"
  const s = clean(purposeRaw);
  const m = s.match(/for\s+(.+?\bVB)\b/i);
  if (m) {
    const name = clean(m[1]).replace(/\s+/g, ' ');
    return name.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
  }
  return null;
}

/* -------------------- Season detector -------------------- */
function detectSeason(rows) {
  // Turf season if we see "AC Fieldhouse - Full Turf" with purpose "Turf Install per NM"
  const hitsTurf = rows.some(r =>
    /AC Fieldhouse\s*-\s*Full\s*Turf/i.test(r['Facility'] || '') &&
    /Turf Install per NM/i.test(r['Reservation Purpose'] || '')
  );
  if (hitsTurf) return 'turf';

  // Court season if "Full Turf" with "Fieldhouse Installed per NM"
  const hitsCourt = rows.some(r =>
    /AC Fieldhouse\s*-\s*Full\s*Turf/i.test(r['Facility'] || '') &&
    /Fieldhouse Installed per NM/i.test(r['Reservation Purpose'] || '')
  );
  if (hitsCourt) return 'courts';

  // Fallback: default courts
  return 'courts';
}

/* -------------------- Room maps -------------------- */
// South (1/2)
const southHalfMap = {
  'AC Gym - Half Court 1A': ['1A'],
  'AC Gym - Half Court 1B': ['1B'],
  'AC Gym - Court 1-AB':    ['1A','1B'],
  'AC Gym - Half Court 2A': ['2A'],
  'AC Gym - Half Court 2B': ['2B'],
  'AC Gym - Court 2-AB':    ['2A','2B'],
  'AC Gym - Championship Court': ['1A','1B','2A','2B'],
  'AC Gym - Full Gym 1AB & 2AB': ['1A','1B','2A','2B']
};

// North (9/10)
const northHalfMap = {
  'AC Gym - Half Court 9A': ['9A'],
  'AC Gym - Half Court 9B': ['9B'],
  'AC Gym - Court 9-AB':    ['9A','9B'],
  'AC Gym - Half Court 10A': ['10A'],
  'AC Gym - Half Court 10B': ['10B'],
  'AC Gym - Court 10-AB':    ['10A','10B'],
  'AC Gym - Full Gym 9 & 10': ['9A','9B','10A','10B']
};

// Fieldhouse (court season)
const fhCourtMap = {
  'AC Fieldhouse - Court 3': ['3'],
  'AC Fieldhouse - Court 4': ['4'],
  'AC Fieldhouse - Court 5': ['5'],
  'AC Fieldhouse - Court 6': ['6'],
  'AC Fieldhouse - Court 7': ['7'],
  'AC Fieldhouse - Court 8': ['8'],
  'AC Fieldhouse - Court 3-8': ['3','4','5','6','7','8']
};
// Fieldhouse (turf season)
const fhTurfMap = {
  'AC Fieldhouse - Quarter Turf NA': ['TNA'],
  'AC Fieldhouse - Quarter Turf NB': ['TNB'],
  'AC Fieldhouse - Quarter Turf SA': ['TSA'],
  'AC Fieldhouse - Quarter Turf SB': ['TSB'],
  'AC Fieldhouse - Half Turf North': ['TNA','TNB'],
  'AC Fieldhouse - Half Turf South': ['TSA','TSB'],
  'AC Fieldhouse - Full Turf':       ['TNA','TNB','TSA','TSB']
};

function fieldhouseRoomsForSeason(season) {
  return season === 'turf'
    ? [
        { id: 'TNA', label: 'Quarter Turf NA', group: 'fieldhouse' },
        { id: 'TNB', label: 'Quarter Turf NB', group: 'fieldhouse' },
        { id: 'TSA', label: 'Quarter Turf SA', group: 'fieldhouse' },
        { id: 'TSB', label: 'Quarter Turf SB', group: 'fieldhouse' }
      ]
    : [
        { id: '3', label: '3', group: 'fieldhouse' },
        { id: '4', label: '4', group: 'fieldhouse' },
        { id: '5', label: '5', group: 'fieldhouse' },
        { id: '6', label: '6', group: 'fieldhouse' },
        { id: '7', label: '7', group: 'fieldhouse' },
        { id: '8', label: '8', group: 'fieldhouse' }
      ];
}

/* -------------------- Title / Subtitle -------------------- */
function makeTitleSubtitle(row) {
  const reservee = clean(row['Reservee'] || '');
  const purpose  = clean(row['Reservation Purpose'] || '');

  // Pickleball
  if (/pickleball/i.test(reservee) || /pickleball/i.test(purpose)) {
    return { title: 'Open Pickleball', subtitle: '' };
  }

  // Welch VB exception (from Front Desk holds)
  const w = extractWelch(purpose);
  if (w) return { title: w, subtitle: 'Volleyball' };

  // RAEC Front Desk -> we'll likely filter later, but keep graceful label
  if (/^raec\s*front\s*desk/i.test(reservee)) {
    return { title: 'Internal Hold', subtitle: '' };
  }

  // Prefer "First Last" if looks like "Last, First"
  const asPerson = normalizePerson(reservee);
  if (asPerson !== reservee) {
    return { title: asPerson, subtitle: purpose };
  }

  // Otherwise keep org/name as-is; fix a rare dangling '(' only if it ends with it.
  let org = reservee;
  if (/\($/.test(org)) org = org.slice(0, -1);
  return { title: org || 'Reservation', subtitle: purpose };
}

/* -------------------- South/North specificity -------------------- */
function specificityScoreSouthNorth(facility) {
  // Higher = more specific
  if (/Half Court 1A|Half Court 1B|Half Court 2A|Half Court 2B|Half Court 9A|Half Court 9B|Half Court 10A|Half Court 10B/i.test(facility)) return 3;
  if (/Court 1-AB|Court 2-AB|Court 9-AB|Court 10-AB/i.test(facility)) return 2;
  if (/Championship Court|Full Gym 1AB & 2AB|Full Gym 9 & 10/i.test(facility)) return 1;
  return 0;
}

/* Grouping key for south/north: reservee + time window */
function groupKeySouthNorth(row, range) {
  const who = clean(row['Reservee'] || '');
  return `${who}__${range.startMin}__${range.endMin}`;
}

/* After collecting a set of facilities for a group, decide final rooms */
function pickRoomsSouthNorth(facilities) {
  // If any half-courts exist, ONLY use those rooms (ignore broader rows)
  const halves = [];
  facilities.forEach(f => {
    if (southHalfMap[f]) halves.push(...southHalfMap[f]);
    if (northHalfMap[f]) halves.push(...northHalfMap[f]);
  });
  if (halves.length) return Array.from(new Set(halves));

  // Else courts (1-AB/2-AB/9-AB/10-AB)
  const mids = [];
  facilities.forEach(f => {
    if (/Court 1-AB/i.test(f)) mids.push(...southHalfMap['AC Gym - Court 1-AB']);
    if (/Court 2-AB/i.test(f)) mids.push(...southHalfMap['AC Gym - Court 2-AB']);
    if (/Court 9-AB/i.test(f)) mids.push(...northHalfMap['AC Gym - Court 9-AB']);
    if (/Court 10-AB/i.test(f)) mids.push(...northHalfMap['AC Gym - Court 10-AB']);
  });
  if (mids.length) return Array.from(new Set(mids));

  // Else full gym / championship
  const wides = [];
  facilities.forEach(f => {
    if (/Championship Court/i.test(f))  wides.push(...southHalfMap['AC Gym - Championship Court']);
    if (/Full Gym 1AB & 2AB/i.test(f))  wides.push(...southHalfMap['AC Gym - Full Gym 1AB & 2AB']);
    if (/Full Gym 9 & 10/i.test(f))     wides.push(...northHalfMap['AC Gym - Full Gym 9 & 10']);
  });
  if (wides.length) return Array.from(new Set(wides));

  return [];
}

/* -------------------- Fieldhouse mapper -------------------- */
function mapFieldhouseRooms(season, facility) {
  if (season === 'turf') {
    for (const key of Object.keys(fhTurfMap)) {
      if (new RegExp('^' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i').test(facility)) {
        return fhTurfMap[key];
      }
    }
  } else {
    for (const key of Object.keys(fhCourtMap)) {
      if (new RegExp('^' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i').test(facility)) {
        return fhCourtMap[key];
      }
    }
  }
  return [];
}

/* -------------------- Pipeline -------------------- */
function rowIsSouthNorth(fac) {
  return /AC Gym - (Half Court|Court|Full Gym|Championship Court)/i.test(fac);
}
function rowIsFieldhouse(fac) {
  return /AC Fieldhouse/i.test(fac);
}
function isFrontDesk(res) {
  return /^RAEC\s*Front\s*Desk/i.test(res);
}

function shouldHideRow(row) {
  const reservee = clean(row['Reservee'] || '');
  const purpose  = clean(row['Reservation Purpose'] || '');

  // Hide Front Desk routine holds/install messages (unless Welch VB)
  if (isFrontDesk(reservee) && !extractWelch(purpose)) return true;

  // Hide explicit install per NM noise
  if (/Install per NM/i.test(purpose)) return true;

  return false;
}

function makeSlot(roomId, startMin, endMin, title, subtitle, org = '', contact = '') {
  return { roomId, startMin, endMin, title, subtitle, org, contact };
}

/* -------------------- Main -------------------- */
async function main() {
  if (!fs.existsSync(INPUT_CSV)) {
    // Write empty scaffold
    const json = { dayStartMin: DAY_START_MIN, dayEndMin: DAY_END_MIN, rooms: [], slots: [] };
    fs.writeFileSync(OUTPUT_JSON, JSON.stringify(json, null, 2));
    return;
  }

  const raw = fs.readFileSync(INPUT_CSV, 'utf8');
  const { rows } = parseTSV(raw);

  // Quick prefilter: RAEC only
  const onlyRAEC = rows.filter(r => /Athletic\s*&\s*Event\s*Center/i.test(r['Location:'] || ''));
  const season   = detectSeason(onlyRAEC);

  // Build rooms list by season
  const rooms = [
    { id: '1A',  label: '1A',  group: 'south' },
    { id: '1B',  label: '1B',  group: 'south' },
    { id: '2A',  label: '2A',  group: 'south' },
    { id: '2B',  label: '2B',  group: 'south' },
    ...fieldhouseRoomsForSeason(season),
    { id: '9A',  label: '9A',  group: 'north' },
    { id: '9B',  label: '9B',  group: 'north' },
    { id: '10A', label: '10A', group: 'north' },
    { id: '10B', label: '10B', group: 'north' }
  ];

  const nowMin = nowMinutesLocal();
  const slots = [];

  // 1) SOUTH/NORTH — group by reservee+time, gather facilities, then decide room specificity
  const groups = new Map(); // key -> { range, facilities:Set<string>, sampleRow }
  for (const r of onlyRAEC) {
    if (shouldHideRow(r)) continue;

    const facility = clean(r['Facility'] || '');
    if (!rowIsSouthNorth(facility)) continue;

    const range = parseRangeToMinutes(r['Reserved Time']);
    if (!range) continue;
    if (!isToday(new Date())) continue;

    // Keep ongoing+future today; drop fully past
    if (range.endMin <= nowMin) continue;

    const key = groupKeySouthNorth(r, range);
    const g = groups.get(key) || { range, facilities: new Set(), sampleRow: r };
    g.facilities.add(facility);
    groups.set(key, g);
  }

  for (const [, g] of groups) {
    const facilities = Array.from(g.facilities).sort((a,b) =>
      specificityScoreSouthNorth(b) - specificityScoreSouthNorth(a)
    );
    const roomsPicked = pickRoomsSouthNorth(facilities);
    if (!roomsPicked.length) continue;

    const { title, subtitle } = makeTitleSubtitle(g.sampleRow);
    const org = clean(g.sampleRow['Reservee'] || '');

    for (const roomId of roomsPicked) {
      slots.push(makeSlot(roomId, g.range.startMin, g.range.endMin, title, subtitle, org, ''));
    }
  }

  // 2) FIELDHOUSE — per-row mapping (season aware)
  for (const r of onlyRAEC) {
    if (shouldHideRow(r)) continue;

    const facility = clean(r['Facility'] || '');
    if (!rowIsFieldhouse(facility)) continue;

    const range = parseRangeToMinutes(r['Reserved Time']);
    if (!range) continue;
    if (range.endMin <= nowMin) continue;

    const targetRooms = mapFieldhouseRooms(season, facility);
    if (!targetRooms.length) continue;

    const { title, subtitle } = makeTitleSubtitle(r);
    const org = clean(r['Reservee'] || '');

    for (const roomId of targetRooms) {
      slots.push(makeSlot(roomId, range.startMin, range.endMin, title, subtitle, org, ''));
    }
  }

  // 3) De-dup identical room/time/title (safety)
  const seen = new Set();
  const uniq = [];
  for (const s of slots) {
    const k = `${s.roomId}__${s.startMin}__${s.endMin}__${s.title}__${s.subtitle}`;
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(s);
  }

  // 4) Sort by room then start time
  uniq.sort((a,b) => {
    if (a.roomId === b.roomId) return a.startMin - b.startMin;
    return a.roomId.localeCompare(b.roomId, undefined, { numeric:true });
  });

  // 5) Emit
  const json = {
    dayStartMin: DAY_START_MIN,
    dayEndMin: DAY_END_MIN,
    rooms,
    slots: uniq
  };
  fs.writeFileSync(OUTPUT_JSON, JSON.stringify(json, null, 2));

  // Summary
  const byRoom = {};
  for (const s of uniq) byRoom[s.roomId] = (byRoom[s.roomId] || 0) + 1;
  console.log(`transform: season=${season} • slots=${uniq.length} • byRoom=${JSON.stringify(byRoom)}`);
}

main().catch(err => {
  console.error('transform.mjs failed:', err);
  process.exit(1);
});
