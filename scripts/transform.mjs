#!/usr/bin/env node
// scripts/transform.mjs
// Robust CSV -> events.json for RAEC board

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parse } from 'csv-parse/sync';

// ---------- Paths ----------
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const INPUT_CSV   = process.env.IN_CSV   || path.join(__dirname, '..', 'data', 'inbox', 'latest.csv');
const OUTPUT_JSON = path.join(__dirname, '..', 'events.json');

// ---------- Helpers ----------
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

function toMin(hhmmampm) {
  const s = clean(hhmmampm).toLowerCase();
  const m = s.match(/^(\d{1,2}):(\d{2})\s*([ap])m$/);
  if (!m) return null;
  let h = parseInt(m[1], 10), min = parseInt(m[2], 10);
  if (h === 12) h = 0;
  if (m[3] === 'p') h += 12;
  return h * 60 + min;
}

function parseRangeToMinutes(text) {
  if (!text) return null;
  // Accept variations like "8:00 AM - 10:00 AM" or "8:00AM-10:00AM"
  const m = String(text).trim().match(/(\d{1,2}:\d{2}\s*[AP]M)\s*-\s*(\d{1,2}:\d{2}\s*[AP]M)/i);
  if (!m) return null;
  const startMin = toMin(m[1]);
  const endMin   = toMin(m[2]);
  if (startMin == null || endMin == null) return null;
  return { startMin, endMin };
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
  const thirdMonMar = nthWeekdayOfMonth(y, 2, 1, 3);
  const secondMonNov= nthWeekdayOfMonth(y,10,1, 2);
  if (!thirdMonMar || !secondMonNov) return true;
  return (d >= thirdMonMar && d < secondMonNov);
}

function cleanPurpose(purpose) {
  let s = clean(purpose);
  if (!s) return '';
  s = s.replace(/^\(+/, '').replace(/\)+$/, '');
  s = s.replace(/internal hold per nm/i, '').replace(/\s{2,}/g, ' ').trim();
  return s;
}

function normalizeReservee(raw) {
  const s = clean(raw);

  if (/^catch\s*corner/i.test(s)) {
    return { type: 'catch', org: 'Catch Corner', contact: '' };
  }
  if (/raec\s*front\s*desk/i.test(s)) {
    return { type: 'system', org: 'RAEC Front Desk', contact: '' };
  }

  const parts = s.split(',').map(x => x.trim());
  if (parts.length >= 2) {
    const left = parts[0];
    const right = parts.slice(1).join(', ');
    if (/\b(Club|Elite|Training|Athletics|Sport|Sports|Basketball|Volleyball|Flight|Academy|United|Pink)\b/i.test(left)) {
      return { type: 'org+contact', org: left, contact: right };
    }
    if (/^[A-Za-z'.-]+\s+[A-Za-z'.-]+/.test(right) && /^[A-Za-z'.-]+$/.test(left)) {
      const person = `${right} ${left}`.replace(/\s+/g, ' ').trim();
      return { type: 'person', person, org: '', contact: '' };
    }
    return { type: 'org+contact', org: left, contact: right };
  }

  return { type: 'org', org: s, contact: '' };
}

function isPickleball(purpose, reservee) {
  return /pickleball/i.test(purpose) || /pickleball/i.test(reservee || '');
}

function mapFacilityToRooms(facility) {
  const f = clean(facility);

  // South gym 1/2
  if (/^ac gym - half court 1a$/i.test(f)) return ['1A'];
  if (/^ac gym - half court 1b$/i.test(f)) return ['1B'];
  if (/^ac gym - court 1-ab$/i.test(f))    return ['1A','1B'];

  if (/^ac gym - half court 2a$/i.test(f)) return ['2A'];
  if (/^ac gym - half court 2b$/i.test(f)) return ['2B'];
  if (/^ac gym - court 2-ab$/i.test(f))    return ['2A','2B'];

  if (/full gym 1ab & 2ab/i.test(f))       return ['1A','1B','2A','2B'];
  if (/championship court/i.test(f))       return ['1A','1B','2A','2B'];

  // North gym 9/10
  if (/^ac gym - half court 9a$/i.test(f)) return ['9A'];
  if (/^ac gym - half court 9b$/i.test(f)) return ['9B'];
  if (/^ac gym - court 9-ab$/i.test(f))    return ['9A','9B'];

  if (/^ac gym - half court 10a$/i.test(f)) return ['10A'];
  if (/^ac gym - half court 10b$/i.test(f)) return ['10B'];
  if (/^ac gym - court 10-ab$/i.test(f))    return ['10A','10B'];

  if (/full court 9 & 10/i.test(f))         return ['9A','9B','10A','10B'];

  // Fieldhouse courts (court season)
  if (/^ac fieldhouse - court\s*([3-8])$/i.test(f)) {
    const n = parseInt(RegExp.$1, 10);
    return [String(n)];
  }
  if (/^ac fieldhouse - court 3-8$/i.test(f)) return ['3','4','5','6','7','8'];

  // Fieldhouse turf
  if (/^ac fieldhouse - full turf$/i.test(f)) return ['3','4','5','6','7','8'];
  if (/^ac fieldhouse - half turf north$/i.test(f)) return ['6','7','8'];
  if (/^ac fieldhouse - half turf south$/i.test(f)) return ['3','4','5'];
  if (/^ac fieldhouse - quarter turf n[ab]$/i.test(f)) return ['7','8'];
  if (/^ac fieldhouse - quarter turf s[ab]$/i.test(f)) return ['3','4'];

  return [];
}

function makeSlot(roomId, startMin, endMin, title, subtitle, org = '', contact = '') {
  return { roomId, startMin, endMin, title, subtitle, org, contact };
}

// Resolve a column by trying multiple header variants
function pickCol(headerRow, candidates) {
  const norm = headerRow.map(h => clean(h).toLowerCase());
  for (const cand of candidates) {
    const idx = norm.indexOf(cand.toLowerCase());
    if (idx !== -1) return idx;
  }
  return -1;
}

// ---------- Main ----------
async function main() {
  if (!fs.existsSync(INPUT_CSV) || fs.statSync(INPUT_CSV).size === 0) {
    // Empty scaffold
    const scaffold = {
      dayStartMin: 360, dayEndMin: 1380,
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
    console.log('CSV missing/empty → wrote empty scaffold.');
    return;
  }

  const raw = fs.readFileSync(INPUT_CSV);
  const records = parse(raw, {
    bom: true,
    columns: true,
    skip_empty_lines: true,
    relax_quotes: true,
    relax_column_count: true,
    trim: true
  });

  if (!records.length) {
    console.log('CSV had headers but no rows → writing scaffold.');
    return await main(); // will take empty path again
  }

  // Capture ordered header names for diagnostics
  const headerRow = Object.keys(records[0]);

  // Map likely columns (accept multiple label variants)
  const iLocationName = pickCol(headerRow, ['Location', 'Location:', 'Facility Location']);
  const iFacilityName = pickCol(headerRow, ['Facility', 'Facility Name']);
  const iTimeName     = pickCol(headerRow, ['Reserved Time', 'Time', 'Reservation Time', 'Reserved Time:', 'Time Range']);
  const iReserveeName = pickCol(headerRow, ['Reservee', 'Reserved By', 'Requester', 'Contact']);
  const iPurposeName  = pickCol(headerRow, ['Reservation Purpose', 'Purpose', 'Event Purpose']);

  // Quick debug print to CI logs (helps when format changes)
  console.log('Columns seen:', headerRow);
  console.log('Using columns:', {
    location: headerRow[iLocationName] ?? '(not found)',
    facility: headerRow[iFacilityName] ?? '(not found)',
    time:     headerRow[iTimeName]     ?? '(not found)',
    reservee: headerRow[iReserveeName] ?? '(not found)',
    purpose:  headerRow[iPurposeName]  ?? '(not found)'
  });

  const courtMode = isCourtSeason(new Date());

  let total = 0, kept = 0, droppedLoc = 0, droppedTime = 0, droppedFac = 0, droppedSeason = 0, droppedRooms = 0;

  const items = [];

  for (const row of records) {
    total++;
    const location  = iLocationName !== -1 ? clean(row[headerRow[iLocationName]]) : '';
    const facility  = iFacilityName !== -1 ? clean(row[headerRow[iFacilityName]]) : '';
    const timeText  = iTimeName     !== -1 ? clean(row[headerRow[iTimeName]])     : '';
    const reservee  = iReserveeName !== -1 ? clean(row[headerRow[iReserveeName]]) : '';
    const purpose   = iPurposeName  !== -1 ? clean(row[headerRow[iPurposeName]])  : '';

    // RAEC-only
    if (location && !/athletic\s*&\s*event\s*center/i.test(location)) {
      droppedLoc++; continue;
    }
    if (!timeText) { droppedTime++; continue; }
    if (!facility) { droppedFac++;  continue; }

    if (courtMode && /fieldhouse.*turf/i.test(facility)) {
      droppedSeason++; continue;
    }

    const range = parseRangeToMinutes(timeText);
    if (!range) { droppedTime++; continue; }

    const rooms = mapFacilityToRooms(facility);
    if (!rooms.length) { droppedRooms++; continue; }

    const who = normalizeReservee(reservee);
    const pur = cleanPurpose(purpose);

    let title = '', subtitle = '', org = '', contact = '';
    if (isPickleball(purpose, reservee)) {
      title = 'Open Pickleball'; subtitle = ''; org = 'Open Pickleball'; contact = '';
    } else if (who.type === 'catch') {
      title = 'Catch Corner'; subtitle = pur; org = 'Catch Corner'; contact = '';
    } else if (who.type === 'person') {
      title = who.person; subtitle = pur; org = who.person; contact = '';
    } else if (who.type === 'org+contact') {
      title = who.org; subtitle = pur || who.contact; org = who.org; contact = who.contact;
    } else {
      title = who.org || 'Reservation'; subtitle = pur; org = who.org || ''; contact = who.contact || '';
    }

    items.push({
      rooms,
      startMin: range.startMin,
      endMin:   range.endMin,
      title, subtitle, org, contact,
      rawFacility: facility,
      rawReservee: reservee
    });
    kept++;
  }

  // Blanket vs specifics dedupe for Fieldhouse
  const resultSlots = [];

  function overlaps(a, b) { return a.startMin < b.endMin && b.startMin < a.endMin; }

  const specifics = items.filter(it => it.rooms.length <= 2 || it.rooms.some(r => /^[3-8]$/.test(r)));

  for (const it of items) {
    const isFieldhouseSet = it.rooms.every(r => /^[3-8]$/.test(r));
    const isBlanket = isFieldhouseSet && it.rooms.length >= 4;

    if (isBlanket) {
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
    } else {
      for (const r of it.rooms) {
        resultSlots.push(makeSlot(r, it.startMin, it.endMin, it.title, it.subtitle, it.org, it.contact));
      }
    }
  }

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
    slots: resultSlots
  };

  fs.writeFileSync(OUTPUT_JSON, JSON.stringify(json, null, 2));

  console.log(`Rows total=${total} kept=${kept}; dropped: loc=${droppedLoc} time=${droppedTime} fac=${droppedFac} season=${droppedSeason} rooms=${droppedRooms}`);
  console.log(`Wrote events.json • rooms=${json.rooms.length} • slots=${json.slots.length}`);
}

main().catch(err => {
  console.error('transform.mjs failed:', err);
  process.exit(1);
});
