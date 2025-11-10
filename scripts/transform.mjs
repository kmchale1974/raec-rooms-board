#!/usr/bin/env node
// scripts/transform.mjs
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parse } from 'csv-parse/sync';

// ---------- Paths ----------
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const INPUT_CSV   = process.env.IN_CSV   || path.join(__dirname, '..', 'data', 'inbox', 'latest.csv');
const OUTPUT_JSON = process.env.OUT_JSON || path.join(__dirname, '..', 'events.json');

// ---------- Helpers ----------
function toMin(hhmmampm) {
  const s = String(hhmmampm || '').trim().toLowerCase();
  const m = s.match(/^(\d{1,2}):(\d{2})\s*([ap])m$/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const mer = m[3].toLowerCase();
  if (h === 12) h = 0;
  if (mer === 'p') h += 12;
  return h * 60 + min;
}
function parseRange(text) {
  const m = String(text || '').trim().match(/(\d{1,2}:\d{2}\s*[ap]m)\s*-\s*(\d{1,2}:\d{2}\s*[ap]m)/i);
  if (!m) return null;
  return { startMin: toMin(m[1]), endMin: toMin(m[2]) };
}
function cleanSpaces(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}
function sameTime(a, b) {
  return a.startMin === b.startMin && a.endMin === b.endMin;
}
function overlaps(a, b) {
  return a.startMin < b.endMin && b.startMin < a.endMin;
}
function titleCaseName(s) {
  return s.replace(/\b([A-Za-z][a-z']*)\b/g, w => w[0].toUpperCase() + w.slice(1));
}

// ---------- Season detection ----------
function turfSeasonFromRows(rows) {
  // If we ever see “AC Fieldhouse - Full Turf” + a Purpose that includes Turf Install per NM → Turf season.
  // If Purpose includes “Fieldhouse Installed per NM” → court season.
  let turf = false, court = false;
  for (const r of rows) {
    const facility = cleanSpaces(r['Facility'] || r['Facility '] || r['Facility:'] || r['Facility'] || '');
    const purpose  = cleanSpaces(r['Reservation Purpose'] || r['Reservation Purpose '] || '');
    if (/^ac fieldhouse - full turf$/i.test(facility) && /turf install per nm/i.test(purpose)) turf = true;
    if (/fieldhouse installed per nm/i.test(purpose)) court = true;
  }
  // Prefer explicit turf signal
  if (turf) return 'turf';
  if (court) return 'court';
  // Fallback: court mode
  return 'court';
}

// ---------- Reservee / Purpose normalization ----------
function normalizeReservee(rawReservee) {
  let s = cleanSpaces(rawReservee);

  // Collapse duplicates like "Chicago Sport and Social Club, Chicago Sport and Social Club"
  const parts = s.split(',').map(x => x.trim()).filter(Boolean);
  if (parts.length >= 2 && parts[0].toLowerCase() === parts[1]?.toLowerCase()) {
    s = parts[0];
  }

  // People "Last, First" -> "First Last"
  if (parts.length === 2 && /^[A-Za-z'.-]+$/.test(parts[0]) && /^[A-Za-z].+/.test(parts[1])) {
    const firstLast = `${parts[1]} ${parts[0]}`.replace(/\s+/g, ' ');
    return { type: 'person', name: titleCaseName(firstLast) };
  }

  // RAEC Front Desk (system holds) — we’ll possibly remap via purpose
  if (/^raec\s*front\s*desk/i.test(s)) {
    return { type: 'system', org: 'RAEC Front Desk' };
  }

  return { type: 'org', org: s };
}

function normalizePurpose(raw) {
  let s = cleanSpaces(raw);
  // remove surrounding parentheses
  s = s.replace(/^\(+/, '').replace(/\)+$/, '').trim();
  return s;
}

function isPickleball(reservee, purpose) {
  return /pickle\s*ball|pickleball/i.test(reservee) || /pickle\s*ball|pickleball/i.test(purpose);
}

function remapSystemHold(reserveeObj, purpose) {
  // If “...Hold per NM for WELCH VB” → title “Welch VB”, subtitle “Volleyball”
  const mWelch = purpose.match(/hold per nm for\s+(.+?)\s*$/i);
  if (mWelch) {
    const team = mWelch[1].trim();
    // If the phrase doesn't include "VB"/"Volleyball", we still show Volleyball as subtitle for clarity.
    return { title: team, subtitle: 'Volleyball' };
  }
  return null;
}

// ---------- Facility → target rooms ----------
const SOUTH_HALF = { 'AC GYM - HALF COURT 1A': '1A', 'AC GYM - HALF COURT 1B': '1B', 'AC GYM - HALF COURT 2A': '2A', 'AC GYM - HALF COURT 2B': '2B' };
const SOUTH_AB   = { 'AC GYM - COURT 1-AB': ['1A','1B'], 'AC GYM - COURT 2-AB': ['2A','2B'] };
const SOUTH_FULL = { 'AC GYM - FULL GYM 1AB & 2AB': ['1A','1B','2A','2B'], 'AC GYM - CHAMPIONSHIP COURT': ['1A','1B','2A','2B'] };

const NORTH_HALF = { 'AC GYM - HALF COURT 9A': '9A', 'AC GYM - HALF COURT 9B': '9B', 'AC GYM - HALF COURT 10A': '10A', 'AC GYM - HALF COURT 10B': '10B' };
const NORTH_AB   = { 'AC GYM - COURT 9-AB': ['9A','9B'], 'AC GYM - COURT 10-AB': ['10A','10B'] };
const NORTH_FULL = { 'AC GYM - FULL GYM 9 & 10': ['9A','9B','10A','10B'] };

const FH_COURTS  = { 'AC FIELDHOUSE - COURT 3': ['3'], 'AC FIELDHOUSE - COURT 4': ['4'], 'AC FIELDHOUSE - COURT 5': ['5'], 'AC FIELDHOUSE - COURT 6': ['6'], 'AC FIELDHOUSE - COURT 7': ['7'], 'AC FIELDHOUSE - COURT 8': ['8'], 'AC FIELDHOUSE - COURT 3-8': ['3','4','5','6','7','8'] };
const FH_TURF    = {
  'AC FIELDHOUSE - QUARTER TURF NA': ['QUARTER TURF NA'],
  'AC FIELDHOUSE - QUARTER TURF NB': ['QUARTER TURF NB'],
  'AC FIELDHOUSE - QUARTER TURF SA': ['QUARTER TURF SA'],
  'AC FIELDHOUSE - QUARTER TURF SB': ['QUARTER TURF SB'],
  'AC FIELDHOUSE - HALF TURF NORTH': ['QUARTER TURF NA','QUARTER TURF NB'],
  'AC FIELDHOUSE - HALF TURF SOUTH': ['QUARTER TURF SA','QUARTER TURF SB'],
  'AC FIELDHOUSE - FULL TURF': ['QUARTER TURF NA','QUARTER TURF NB','QUARTER TURF SA','QUARTER TURF SB']
};

function mapFacility(facility, seasonMode) {
  const f = cleanSpaces(facility).toUpperCase();

  // South
  if (SOUTH_HALF[f]) return { targets: [SOUTH_HALF[f]], rank: 3 };
  if (SOUTH_AB[f])   return { targets: SOUTH_AB[f], rank: 2 };
  if (SOUTH_FULL[f]) return { targets: SOUTH_FULL[f], rank: 1 };

  // North
  if (NORTH_HALF[f]) return { targets: [NORTH_HALF[f]], rank: 3 };
  if (NORTH_AB[f])   return { targets: NORTH_AB[f], rank: 2 };
  if (NORTH_FULL[f]) return { targets: NORTH_FULL[f], rank: 1 };

  // Fieldhouse
  if (seasonMode === 'court') {
    if (FH_COURTS[f]) return { targets: FH_COURTS[f], rank: 3 };
  } else {
    if (FH_TURF[f])   return { targets: FH_TURF[f],   rank: 3 };
  }

  return { targets: [], rank: 0 };
}

// ---------- Main ----------
function roomsListForSeason(seasonMode) {
  if (seasonMode === 'turf') {
    return [
      { id: '1A', label: '1A', group: 'south' },
      { id: '1B', label: '1B', group: 'south' },
      { id: '2A', label: '2A', group: 'south' },
      { id: '2B', label: '2B', group: 'south' },
      { id: 'QUARTER TURF NA', label: 'NA', group: 'fieldhouse' },
      { id: 'QUARTER TURF NB', label: 'NB', group: 'fieldhouse' },
      { id: 'QUARTER TURF SA', label: 'SA', group: 'fieldhouse' },
      { id: 'QUARTER TURF SB', label: 'SB', group: 'fieldhouse' },
      { id: '9A', label: '9A', group: 'north' },
      { id: '9B', label: '9B', group: 'north' },
      { id: '10A', label: '10A', group: 'north' },
      { id: '10B', label: '10B', group: 'north' }
    ];
  }
  // court season
  return [
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
}

function buildKey(roomId, startMin, endMin, reservee) {
  return `${roomId}__${startMin}-${endMin}__${reservee.toLowerCase()}`;
}

async function main() {
  if (!fs.existsSync(INPUT_CSV) || fs.statSync(INPUT_CSV).size === 0) {
    const seasonMode = 'court';
    const json = { dayStartMin: 360, dayEndMin: 1380, rooms: roomsListForSeason(seasonMode), slots: [] };
    fs.writeFileSync(OUTPUT_JSON, JSON.stringify(json, null, 2));
    console.log(`Wrote ${OUTPUT_JSON} • slots=0 (empty CSV)`);
    return;
  }

  const raw = fs.readFileSync(INPUT_CSV);
  const rows = parse(raw, { columns: true, skip_empty_lines: true });

  const seasonMode = turfSeasonFromRows(rows); // 'turf' or 'court'
  const roomsList = roomsListForSeason(seasonMode);

  const items = [];
  for (const r of rows) {
    const location = cleanSpaces(r['Location:'] || r['Location'] || '');
    if (!/athletic\s*&\s*event\s*center/i.test(location)) continue;

    const facility = cleanSpaces(r['Facility'] || '');
    const timeText = cleanSpaces(r['Reserved Time'] || r['Reserved Time '] || '');
    const reserveeRaw = cleanSpaces(r['Reservee'] || '');
    const purposeRaw  = cleanSpaces(r['Reservation Purpose'] || '');

    const range = parseRange(timeText);
    if (!range) continue;

    const reservee = normalizeReservee(reserveeRaw);
    const purpose  = normalizePurpose(purposeRaw);

    // Pickleball override
    let title = '';
    let subtitle = '';
    if (isPickleball(reserveeRaw, purpose)) {
      title = 'Open Pickleball';
      subtitle = '';
    } else if (reservee.type === 'system') {
      // RAEC Front Desk…Hold per NM for X
      const remap = remapSystemHold(reservee, purpose);
      if (remap) {
        title = remap.title;
        subtitle = remap.subtitle || '';
      } else {
        // suppress generic system holds (e.g., turf install) from display
        if (/installed per nm|turf install per nm/i.test(purpose)) continue;
        title = 'Reservation';
        subtitle = purpose;
      }
    } else if (reservee.type === 'person') {
      title = reservee.name;
      subtitle = purpose;
    } else {
      title = reservee.org;
      subtitle = purpose;
    }

    const { targets, rank } = mapFacility(facility, seasonMode);
    if (!targets.length) continue;

    items.push({
      targets, rank,
      startMin: range.startMin,
      endMin:   range.endMin,
      title, subtitle,
      rawReservee: reserveeRaw
    });
  }

  // -------- DEDUP by specificity per room/reservee/time overlap --------
  // For each room, time overlap, and reservee, keep the HIGHEST rank only.
  const bestByKey = new Map(); // key = roomId__start-end__reservee
  for (const it of items) {
    for (const roomId of it.targets) {
      const key = buildKey(roomId, it.startMin, it.endMin, it.rawReservee);
      const prev = bestByKey.get(key);
      if (!prev || it.rank > prev.rank) {
        bestByKey.set(key, { ...it, roomId });
      }
    }
  }

  // Convert to slots
  const slots = [...bestByKey.values()]
    .map(it => ({
      roomId: it.roomId,
      startMin: it.startMin,
      endMin: it.endMin,
      title: it.title,
      subtitle: it.subtitle
    }))
    // ensure within board hours
    .filter(s => s.startMin < 1380 && s.endMin > 360);

  const json = {
    dayStartMin: 360,
    dayEndMin: 1380,
    rooms: roomsList,
    slots
  };

  fs.writeFileSync(OUTPUT_JSON, JSON.stringify(json, null, 2));
  console.log(`Wrote ${OUTPUT_JSON} • season=${seasonMode} • slots=${slots.length}`);
}

main().catch(err => {
  console.error('transform.mjs failed:', err);
  process.exit(1);
});
