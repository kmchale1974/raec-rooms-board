#!/usr/bin/env node
// scripts/transform.mjs
// Transform latest CSV -> events.json with RAEC rules (South 1/2, Fieldhouse 3..8, North 9/10)
// - Drops "internal hold"/front desk turf install rows
// - Hides past events (by local time; relies on TZ=America/Chicago in workflow)
// - De-duplicates blanket vs specific (Full/Championship/Court AB vs Half)
// - Pickleball override => title "Open Pickleball", no subtitle
// - Normalizes "Last, First" -> "First Last"

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ---------- Paths ----------
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const INPUT_CSV   = process.env.IN_CSV   || path.join(__dirname, '..', 'data', 'inbox', 'latest.csv');
const OUTPUT_JSON = process.env.OUT_JSON || path.join(__dirname, '..', 'events.json');

// ---------- Small utils ----------
function clean(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }

function toMin(hhmmampm) {
  const s = String(hhmmampm || '').trim().toLowerCase();
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
  const m = String(text).trim().match(/(\d{1,2}:\d{2}\s*[ap]m)\s*-\s*(\d{1,2}:\d{2}\s*[ap]m)/i);
  if (!m) return null;
  return { startMin: toMin(m[1]), endMin: toMin(m[2]) };
}

// Today’s minutes (local; set TZ in workflow)
function nowMinutes() {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

// ---------- Normalizers ----------
function normalizeReservee(raw) {
  const s = clean(raw);

  // Flip "Last, First"
  const m = s.match(/^([A-Za-z'.-]+),\s*([A-Za-z'.-]+)(.*)$/);
  if (m) return `${m[2]} ${m[1]}`.replace(/\s+/g, ' ').trim();

  return s;
}

function cleanPurpose(purpose) {
  let s = clean(purpose);
  if (!s) return '';
  s = s.replace(/^\(+/, '').replace(/\)+$/, '');
  s = s.replace(/internal hold per nm/i, '').trim();
  return s;
}

// ---------- Filters ----------
function isInternalHold(purpose, reservee) {
  const p = String(purpose || '').toLowerCase();
  const r = String(reservee || '').toLowerCase();
  if (p.includes('internal hold')) return true;
  // “front desk turf install per nm”, or anything “per nm” + turf/install
  if (r.includes('front desk')) return true;
  if (p.includes('per nm') && (p.includes('turf') || p.includes('install'))) return true;
  return false;
}

function isPickleball(purpose, reservee) {
  const a = String(purpose || '').toLowerCase();
  const b = String(reservee || '').toLowerCase();
  return a.includes('pickleball') || b.includes('pickleball');
}

// ---------- Mapping (facilities -> room IDs we show on the board) ----------
function mapFacilityToRooms(facility) {
  const f = clean(facility).toLowerCase();

  // South courts 1/2
  if (f === 'ac gym - half court 1a') return ['1A'];
  if (f === 'ac gym - half court 1b') return ['1B'];
  if (f === 'ac gym - court 1-ab')    return ['1A','1B'];
  if (f === 'ac gym - half court 2a') return ['2A'];
  if (f === 'ac gym - half court 2b') return ['2B'];
  if (f === 'ac gym - court 2-ab')    return ['2A','2B'];
  if (f.includes('full gym 1ab & 2ab')) return ['1A','1B','2A','2B'];
  if (f.includes('championship court'))  return ['1A','1B','2A','2B'];

  // North courts 9/10
  if (f === 'ac gym - half court 9a')  return ['9A'];
  if (f === 'ac gym - half court 9b')  return ['9B'];
  if (f === 'ac gym - court 9-ab')     return ['9A','9B'];
  if (f === 'ac gym - half court 10a') return ['10A'];
  if (f === 'ac gym - half court 10b') return ['10B'];
  if (f === 'ac gym - court 10-ab')    return ['10A','10B'];
  if (f.includes('full gym 9 & 10'))   return ['9A','9B','10A','10B'];

  // Fieldhouse 3..8 (during court season)
  const m = f.match(/^ac fieldhouse - court\s*([3-8])$/i);
  if (m) return [String(m[1])];
  if (f === 'ac fieldhouse - court 3-8') return ['3','4','5','6','7','8'];

  // Turf mappings (if you want to include in non-court season)
  if (f === 'ac fieldhouse - full turf') return ['3','4','5','6','7','8'];
  if (f === 'ac fieldhouse - half turf north') return ['6','7','8'];
  if (f === 'ac fieldhouse - half turf south') return ['3','4','5'];
  if (/^ac fieldhouse - quarter turf n[ab]$/.test(f)) return ['7','8'];
  if (/^ac fieldhouse - quarter turf s[ab]$/.test(f)) return ['3','4'];

  return [];
}

// ---------- Blanket vs Specific de-dup ----------
// We treat items with many rooms as "blanket" and items with fewer rooms as "specific".
// For same org (case-insensitive) & overlapping time, remove covered rooms from blanket.
function overlaps(a, b) {
  return a.startMin < b.endMin && b.startMin < a.endMin;
}
function orgKey(s) {
  return clean(s || '').toLowerCase();
}

function carveBlankets(items) {
  // Work on a deep copy to annotate which rooms remain
  const clones = items.map(it => ({ ...it, rooms: [...it.rooms] }));

  for (let i = 0; i < clones.length; i++) {
    for (let j = 0; j < clones.length; j++) {
      if (i === j) continue;
      const A = clones[i];
      const B = clones[j];
      // only remove from A if A is more blanket than B (more rooms)
      if (A.rooms.length > B.rooms.length &&
          orgKey(A.org || A.title) === orgKey(B.org || B.title) &&
          overlaps(A, B)) {
        // remove in A the rooms that B explicitly targets
        A.rooms = A.rooms.filter(r => !B.rooms.includes(r));
      }
    }
  }

  // Remove items that lost all rooms
  return clones.filter(it => it.rooms.length > 0);
}

// ---------- Main ----------
async function main() {
  // If no csv -> write empty scaffold
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
    console.log(`Wrote ${OUTPUT_JSON} • slots=0`);
    return;
  }

  const raw = fs.readFileSync(INPUT_CSV, 'utf8');
  const lines = raw.split(/\r?\n/).filter(l => l.trim().length > 0);
  if (!lines.length) {
    console.log('CSV has no rows; writing empty scaffold.');
    return main();
  }

  // Header
  const header = lines[0].split(',');
  const idx = (name) => header.findIndex(h => clean(h).toLowerCase() === name.toLowerCase());
  const iLocation = idx('Location:');
  const iFacility = idx('Facility');
  const iTime     = idx('Reserved Time');
  const iReservee = idx('Reservee');
  const iPurpose  = idx('Reservation Purpose');

  // Counters
  let drop_internal = 0;
  let drop_past = 0;
  let kept_rows = 0;

  const nowMin = nowMinutes();

  // Pass 1: read rows -> preliminary items
  const pre = [];
  for (let i = 1; i < lines.length; i++) {
    const row = lines[i].split(',');

    const location  = clean(row[iLocation]  || '');
    const facility  = clean(row[iFacility]  || '');
    const timeText  = clean(row[iTime]      || '');
    const reserveeR = clean(row[iReservee]  || '');
    const purposeR  = clean(row[iPurpose]   || '');

    if (!facility || !timeText) continue;

    // RAEC only
    if (location && !/athletic\s*&\s*event\s*center/i.test(location)) continue;

    // Filter internal/front-desk turf install holds
    if (isInternalHold(purposeR, reserveeR)) { drop_internal++; continue; }

    const range = parseRangeToMinutes(timeText);
    if (!range) continue;

    // Past events drop (end time)
    if (range.endMin != null && range.endMin <= nowMin) { drop_past++; continue; }

    const rooms = mapFacilityToRooms(facility);
    if (!rooms.length) continue;

    // Build display fields
    let who = normalizeReservee(reserveeR);
    let title = who || 'Reservation';
    let subtitle = cleanPurpose(purposeR);
    let org = title;
    let contact = '';

    // If reservee looked like "Org, Person", set org/contact
    if (reserveeR.includes(',')) {
      const parts = reserveeR.split(',').map(s => s.trim());
      if (parts.length >= 2) {
        const left = parts[0]; // org or last name
        const right = parts.slice(1).join(', ');
        // If right looks like "First Last", treat as contact
        if (/^[A-Za-z'.-]+\s+[A-Za-z'.-]+/.test(right)) {
          org = left;
          contact = right;
          title = org;
        }
      }
    }

    // ---- Pickleball override ----
    if (isPickleball(purposeR, reserveeR)) {
      title = 'Open Pickleball';
      subtitle = '';
      org = 'Open Pickleball';
      contact = '';
    }

    pre.push({
      rooms,
      startMin: range.startMin,
      endMin:   range.endMin,
      title, subtitle, org, contact
    });

    kept_rows++;
  }

  // Pass 2: carve blankets using org/time overlap logic
  const carved = carveBlankets(pre);

  // Final slots (room-per-item)
  const slots = [];
  for (const it of carved) {
    for (const r of it.rooms) {
      slots.push({
        roomId: r,
        startMin: it.startMin,
        endMin: it.endMin,
        title: it.title,
        subtitle: it.subtitle,
        org: it.org,
        contact: it.contact
      });
    }
  }

  // Sort slots by start
  slots.sort((a, b) => (a.startMin - b.startMin) || a.roomId.localeCompare(b.roomId));

  // Final JSON structure
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
    slots
  };

  fs.writeFileSync(OUTPUT_JSON, JSON.stringify(json, null, 2));
  console.log(
    `transform: rows=${lines.length - 1} kept=${kept_rows} slots=${slots.length} drop={"internal":${drop_internal},"past":${drop_past}}`
  );
  console.log(`Wrote ${OUTPUT_JSON} • slots=${slots.length}`);
}

main().catch(err => {
  console.error('transform.mjs failed:', err);
  process.exit(1);
});
