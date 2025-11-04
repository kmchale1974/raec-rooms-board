#!/usr/bin/env node
// Transform latest CSV -> events.json (no external CSV lib)
// • Picks most-specific facilities (Half Court > Court AB > Full/Championship)
// • Dedupes duplicates across the facility ladder
// • Converts "Last, First" -> "First Last"
// • Suppresses RAEC front desk / internal holds / turf install
// • Hides past-today slots
// • Keeps Pickleball renamed as "Open Pickleball"
// • Handles North (9/10) variants and South (1/2) variants

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ---------- Paths ----------
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const INPUT_CSV  = process.env.IN_CSV  || path.join(__dirname, '..', 'data', 'inbox', 'latest.csv');
const OUTPUT_JSON= process.env.OUT_JSON || path.join(__dirname, '..', 'events.json');

// ---------- Small utilities ----------
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

function parseCsvLoose(text) {
  // minimal CSV parser handling quotes + commas
  const rows = [];
  let i = 0, field = '', row = [], inQuote = false;
  const pushField = () => { row.push(field); field = ''; };
  const pushRow   = () => { rows.push(row); row = []; };

  while (i < text.length) {
    const c = text[i];

    if (inQuote) {
      if (c === '"') {
        if (text[i+1] === '"') { field += '"'; i += 2; continue; }
        inQuote = false; i++; continue;
      }
      field += c; i++; continue;
    }

    if (c === '"') { inQuote = true; i++; continue; }
    if (c === ',') { pushField(); i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { pushField(); pushRow(); i++; continue; }

    field += c; i++;
  }
  // last field/row
  pushField();
  if (row.length > 1 || row[0] !== '') pushRow();
  return rows;
}

function toMinutes(hhmm) {
  const m = clean(hhmm).toLowerCase().match(/^(\d{1,2}):(\d{2})\s*([ap])m$/);
  if (!m) return null;
  let h = parseInt(m[1],10), min = parseInt(m[2],10);
  const mer = m[3];
  if (h === 12) h = 0;
  if (mer === 'p') h += 12;
  return h*60 + min;
}

function parseRangeToMinutes(text) {
  const m = String(text).match(/(\d{1,2}:\d{2}\s*[ap]m)\s*-\s*(\d{1,2}:\d{2}\s*[ap]m)/i);
  if (!m) return null;
  const startMin = toMinutes(m[1]);
  const endMin   = toMinutes(m[2]);
  if (startMin == null || endMin == null) return null;
  return { startMin, endMin };
}

function firstLast(name) {
  // "Llanos, David" -> "David Llanos"; otherwise leave as-is
  const s = clean(name);
  const m = s.match(/^([^,]+),\s*(.+)$/);
  if (m) return `${m[2]} ${m[1]}`.replace(/\s+/g, ' ').trim();
  return s;
}

function isPickleball(purpose, reservee) {
  return /pickleball/i.test(String(purpose)) || /pickleball/i.test(String(reservee));
}

function isInternalHold(purpose, reservee) {
  const p = String(purpose);
  const r = String(reservee);
  return (
    /internal hold/i.test(p) ||
    /turf install/i.test(p) ||
    /per\s*nm/i.test(p) ||
    /raec\s*front\s*desk/i.test(r) ||
    /front\s*desk/i.test(r)
  );
}

// "catch corner" special tag
function isCatchCorner(s) {
  return /catch\s*corner/i.test(String(s));
}

// ----- Facility mapping with specificity -----
// returns { rooms: string[], spec: number, area: 'south'|'north'|'fieldhouse'|'' }
// Higher spec means more specific (3 = half court, 2 = paired court, 1 = whole-gym blanket)
function facilityToRoomsWithSpec(fac) {
  const f = clean(fac).toLowerCase();

  const re = (s) => new RegExp(s, 'i');
  // SOUTH 1/2
  if (re('^ac gym - half court\\s*1a$').test(f)) return { rooms:['1A'], spec:3, area:'south' };
  if (re('^ac gym - half court\\s*1b$').test(f)) return { rooms:['1B'], spec:3, area:'south' };
  if (re('^ac gym - court\\s*1[-\\s]?ab$').test(f)) return { rooms:['1A','1B'], spec:2, area:'south' };

  if (re('^ac gym - half court\\s*2a$').test(f)) return { rooms:['2A'], spec:3, area:'south' };
  if (re('^ac gym - half court\\s*2b$').test(f)) return { rooms:['2B'], spec:3, area:'south' };
  if (re('^ac gym - court\\s*2[-\\s]?ab$').test(f)) return { rooms:['2A','2B'], spec:2, area:'south' };

  if (re('full\\s*(?:gym|court)\\s*1ab\\s*&\\s*2ab').test(f)) return { rooms:['1A','1B','2A','2B'], spec:1, area:'south' };
  if (re('championship\\s*court').test(f))         return { rooms:['1A','1B','2A','2B'], spec:1, area:'south' };

  // NORTH 9/10
  if (re('^ac gym - half court\\s*9a$').test(f)) return { rooms:['9A'], spec:3, area:'north' };
  if (re('^ac gym - half court\\s*9b$').test(f)) return { rooms:['9B'], spec:3, area:'north' };
  if (re('^ac gym - court\\s*9[-\\s]?ab$').test(f)) return { rooms:['9A','9B'], spec:2, area:'north' };

  if (re('^ac gym - half court\\s*10a$').test(f)) return { rooms:['10A'], spec:3, area:'north' };
  if (re('^ac gym - half court\\s*10b$').test(f)) return { rooms:['10B'], spec:3, area:'north' };
  if (re('^ac gym - court\\s*10[-\\s]?ab$').test(f)) return { rooms:['10A','10B'], spec:2, area:'north' };

  if (re('full\\s*(?:gym|court)\\s*9\\s*&\\s*10').test(f)) return { rooms:['9A','9B','10A','10B'], spec:1, area:'north' };

  // FIELDHOUSE 3..8 (mapped, though your examples are gym)
  const m1 = f.match(/^ac fieldhouse - court\s*([3-8])$/i);
  if (m1) return { rooms:[m1[1]], spec:3, area:'fieldhouse' };
  if (re('^ac fieldhouse - court\\s*3-8$').test(f)) return { rooms:['3','4','5','6','7','8'], spec:1, area:'fieldhouse' };

  // Turf (if present; you can filter later by season if needed)
  if (re('^ac fieldhouse - full turf$').test(f)) return { rooms:['3','4','5','6','7','8'], spec:1, area:'fieldhouse' };
  if (re('^ac fieldhouse - half turf north$').test(f)) return { rooms:['6','7','8'], spec:2, area:'fieldhouse' };
  if (re('^ac fieldhouse - half turf south$').test(f)) return { rooms:['3','4','5'], spec:2, area:'fieldhouse' };

  return { rooms:[], spec:0, area:'' };
}

// ---------- Main transform ----------
async function main() {
  // Empty CSV -> scaffold
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

  const raw = fs.readFileSync(INPUT_CSV, 'utf8');
  const rows = parseCsvLoose(raw);
  if (rows.length < 2) {
    // header only
    fs.writeFileSync(OUTPUT_JSON, JSON.stringify({ dayStartMin:360, dayEndMin:1380, rooms:[], slots:[] }, null, 2));
    return;
  }

  // Header map
  const header = rows[0].map(h => clean(h).toLowerCase());
  const colIx = (name) => header.findIndex(h => h === name.toLowerCase());

  // Common headers from your CSV
  const iLocation  = colIx('location:');
  const iFacility  = colIx('facility');
  const iTime      = colIx('reserved time');
  const iReservee  = colIx('reservee');
  const iPurpose   = colIx('reservation purpose');

  const today = new Date();
  const nowMin = today.getHours()*60 + today.getMinutes();

  // Group by (reserveeKey + start + end). We’ll then keep the most-specific rooms per area.
  const groups = new Map();  // key -> { startMin, endMin, reserveeRaw, purposeRaw, pieces: [ {rooms,spec,area,facility} ... ] }

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const location = clean(row[iLocation] ?? '');
    const facility = clean(row[iFacility] ?? '');
    const timeText = clean(row[iTime] ?? '');
    const reservee = clean(row[iReservee] ?? '');
    const purpose  = clean(row[iPurpose] ?? '');

    if (!facility || !timeText) continue;
    if (location && !/athletic\s*&\s*event\s*center/i.test(location)) continue; // RAEC only

    // skip internal/front-desk/turf-install holds
    if (isInternalHold(purpose, reservee)) continue;

    const range = parseRangeToMinutes(timeText);
    if (!range) continue;

    // hide past-today slots
    if (range.endMin <= nowMin) continue;

    const map = facilityToRoomsWithSpec(facility);
    if (!map.rooms.length) continue;

    const reserveeKey = firstLast(reservee).toLowerCase(); // normalized for keying
    const key = `${reserveeKey}__${range.startMin}__${range.endMin}`;

    if (!groups.has(key)) {
      groups.set(key, {
        startMin: range.startMin,
        endMin: range.endMin,
        reserveeRaw: reservee,
        purposeRaw: purpose,
        pieces: []
      });
    }
    groups.get(key).pieces.push({ rooms: map.rooms, spec: map.spec, area: map.area, facility });
  }

  // Reduce each group to final rooms by area using highest specificity
  const slots = [];
  for (const [key, g] of groups.entries()) {
    // find max spec per area
    const byArea = new Map();
    for (const p of g.pieces) {
      const current = byArea.get(p.area);
      if (!current || p.spec > current.spec) byArea.set(p.area, { spec: p.spec, rooms: new Set(p.rooms) });
      else if (p.spec === current.spec) p.rooms.forEach(rm => current.rooms.add(rm));
    }
    // union all chosen rooms across areas
    const finalRooms = [];
    for (const v of byArea.values()) finalRooms.push(...Array.from(v.rooms));

    if (!finalRooms.length) continue;

    // Title/subtitle logic
    let title = '', subtitle = '';
    const reserveePretty = firstLast(g.reserveeRaw);
    if (isPickleball(g.purposeRaw, g.reserveeRaw)) {
      title = 'Open Pickleball';
      subtitle = '';
    } else if (isCatchCorner(g.reserveeRaw)) {
      title = 'Catch Corner';
      subtitle = clean(g.purposeRaw);
    } else {
      // If reservee looks like "Org, Contact", prefer org as title & purpose as subtitle
      // but your CSV mostly has "Last, First" or "Org (Rec), Contact"
      // heuristic: if contains '(' or 'Rec' or a comma + name, treat left as org
      if (/,/.test(g.reserveeRaw) && !/^\w+,\s*\w+$/i.test(g.reserveeRaw)) {
        // "Empower Volleyball (Rec), Dean Baxendale" -> title: Empower Volleyball (Rec)
        const parts = g.reserveeRaw.split(',').map(s => s.trim());
        title = parts[0];
        subtitle = clean(g.purposeRaw || parts.slice(1).join(', '));
      } else if (/volleyball|club|academy|training|athletics|sports|united|elite/i.test(g.reserveeRaw)) {
        title = g.reserveeRaw.split(',')[0]; // org piece
        subtitle = clean(g.purposeRaw);
      } else {
        title = reserveePretty; // person
        subtitle = clean(g.purposeRaw);
      }
    }

    // Dedup slots by room/time/title
    for (const rm of finalRooms) {
      slots.push({
        roomId: rm,
        startMin: g.startMin,
        endMin: g.endMin,
        title,
        subtitle,
        org: title,
        contact: ''
      });
    }
  }

  // Deduplicate (just in case) by roomId/start/end/title
  const seen = new Set();
  const outSlots = [];
  for (const s of slots) {
    const k = `${s.roomId}__${s.startMin}__${s.endMin}__${s.title}`;
    if (seen.has(k)) continue;
    seen.add(k);
    outSlots.push(s);
  }

  // Sort per room by start time
  outSlots.sort((a,b) => (a.roomId.localeCompare(b.roomId)) || (a.startMin - b.startMin) || (a.endMin - b.endMin));

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
    slots: outSlots
  };

  fs.writeFileSync(OUTPUT_JSON, JSON.stringify(json, null, 2));
  console.log(`Wrote events.json • slots=${json.slots.length}`);
}

main().catch(err => {
  console.error('transform.mjs failed:', err);
  process.exit(1);
});
