#!/usr/bin/env node
// Transform latest CSV -> events.json with RAEC rules (Kevin's spec)

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parse } from 'csv-parse/sync';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const INPUT_CSV   = process.env.IN_CSV   || path.join(__dirname, '..', 'data', 'inbox', 'latest.csv');
const OUTPUT_JSON = process.env.OUT_JSON || path.join(__dirname, '..', 'events.json');

// ---------- Helpers ----------
function clean(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}
function toMin(hhmm) {
  // " 7:00pm " or "7:00 pm" or "7:00PM"
  const m = String(hhmm).trim().toLowerCase().match(/^(\d{1,2}):(\d{2})\s*([ap])m$/i);
  if (!m) return null;
  let h = parseInt(m[1],10);
  const min = parseInt(m[2],10);
  const mer = m[3].toLowerCase();
  if (h === 12) h = 0;
  if (mer === 'p') h += 12;
  return h*60 + min;
}
function parseRangeToMinutes(text) {
  // " 7:00pm -  9:00pm " (allow extra spaces)
  const m = String(text).toLowerCase().match(/(\d{1,2}:\d{2}\s*[ap]m)\s*-\s*(\d{1,2}:\d{2}\s*[ap]m)/i);
  if (!m) return null;
  return { startMin: toMin(m[1]), endMin: toMin(m[2]) };
}
function todayMinutesNow() {
  const now = new Date();
  return now.getHours()*60 + now.getMinutes();
}

// Normalize “Last, First” → “First Last” (only when clearly that pattern)
function normalizePersonName(reserveeRaw) {
  const s = clean(reserveeRaw);
  // If it contains a comma and not obviously an org
  // e.g. "Llanos, David" → "David Llanos"
  const m = s.match(/^\s*([A-Za-z'.-]+)\s*,\s*([A-Za-z'.-]+)\s*$/);
  if (m) return `${m[2]} ${m[1]}`.replace(/\s+/g,' ').trim();
  return s;
}

// Decide if this row is "internal/system" (to drop),
// but **never drop** if it’s Pickleball (we keep Open Pickleball).
function isInternalRow(reservee, purpose) {
  const r = reservee.toLowerCase();
  const p = purpose.toLowerCase();
  const isPickle = p.includes('pickleball') || r.includes('pickleball');
  if (isPickle) return false;

  // Internal/system phrases
  if (r.includes('raec front desk')) return true;
  if (r.includes('internal holds')) return true;
  if (p.includes('internal hold')) return true;
  if (p.includes('turf install')) return true;
  return false;
}

// Title/subtitle mapping
function makeDisplay(reservee, purpose) {
  const r = clean(reservee);
  const p = clean(purpose);

  const isPickle = /pickleball/i.test(r) || /pickleball/i.test(p);
  if (isPickle) {
    return { title: 'Open Pickleball', subtitle: '', org: 'Open Pickleball', contact: '' };
  }

  // If looks like "Last, First" → normalize to "First Last"
  let title = normalizePersonName(r);
  let org = '', contact = '';

  // If it's very org-y with comma (e.g., "Empower Volleyball (Rec), Dean Baxendale")
  // Keep left as org, right as contact.
  if (r.includes(',')) {
    const left = r.split(',')[0].trim();
    const right = r.split(',').slice(1).join(',').trim();
    // Heuristic: if the left has words like Volleyball / Club / Academy / etc, use it as title(org)
    if (/\b(Volleyball|Club|Academy|Athletics|Sports|United|Elite|Training|Catch Corner)\b/i.test(left)) {
      title = left;
      org = left;
      contact = right;
    }
  }

  // Otherwise: if we changed Last, First to First Last, that’s a person.
  if (!org) {
    // Person vs org: if title contains a space but not org keywords, treat as person
    if (/\s/.test(title) && !/\b(Club|Academy|Athletics|Sports|United|Elite|Training|Volleyball|Catch Corner)\b/i.test(title)) {
      org = title;
    }
  }

  const subtitle = p;
  return { title, subtitle, org, contact };
}

// ---------- Facility → rooms mapping ----------
// Return an array of rooms (IDs): ['1A','1B','2A','2B','9A','9B','10A','10B','3'..'8']
// IMPORTANT: We will **not** use wide-only (e.g., Full Gym) to force more rooms if
// half-courts appear in the same (reservee+time) block — the reducer will resolve that.
// Here we still expand logical AB → both halves.
function mapFacilityToRooms(fac) {
  const f = clean(fac).toLowerCase();

  // South 1/2
  if (f === 'ac gym - half court 1a') return ['1A'];
  if (f === 'ac gym - half court 1b') return ['1B'];
  if (f === 'ac gym - court 1-ab')    return ['1A','1B'];

  if (f === 'ac gym - half court 2a') return ['2A'];
  if (f === 'ac gym - half court 2b') return ['2B'];
  if (f === 'ac gym - court 2-ab')    return ['2A','2B'];

  if (f.includes('full gym 1ab & 2ab')) return ['1A','1B','2A','2B']; // wide
  if (f.includes('championship court'))  return ['1A','1B','2A','2B']; // wide

  // North 9/10
  if (f === 'ac gym - half court 9a') return ['9A'];
  if (f === 'ac gym - half court 9b') return ['9B'];
  if (f === 'ac gym - court 9-ab')    return ['9A','9B'];

  if (f === 'ac gym - half court 10a') return ['10A'];
  if (f === 'ac gym - half court 10b') return ['10B'];
  if (f === 'ac gym - court 10-ab')    return ['10A','10B'];

  if (f.includes('full gym 9 & 10'))   return ['9A','9B','10A','10B']; // wide

  // Fieldhouse 3–8 courts (court-season)
  if (/^ac fieldhouse - court\s*([3-8])$/i.test(clean(fac))) {
    return [String(RegExp.$1)];
  }
  if (f === 'ac fieldhouse - court 3-8') return ['3','4','5','6','7','8'];

  // Turf variants (we will drop most internal turf items earlier)
  if (f === 'ac fieldhouse - full turf') return ['3','4','5','6','7','8'];
  if (f === 'ac fieldhouse - half turf north') return ['6','7','8'];
  if (f === 'ac fieldhouse - half turf south') return ['3','4','5'];

  return [];
}

// Narrowing preference: if any half-courts exist, keep only half-courts and
// drop wide rooms that merely duplicate intent (Court AB / Full Gym / Championship).
function narrowRooms(rooms) {
  const set = new Set(rooms);
  const hasHalfSouth = set.has('1A') || set.has('1B') || set.has('2A') || set.has('2B');
  const hasHalfNorth = set.has('9A') || set.has('9B') || set.has('10A') || set.has('10B');

  if (hasHalfSouth) {
    // keep only 1A/1B/2A/2B if any present
    for (const r of ['9A','9B','10A','10B','3','4','5','6','7','8']) set.delete(r);
  }
  if (hasHalfNorth) {
    // keep only 9A/9B/10A/10B if any present
    for (const r of ['1A','1B','2A','2B','3','4','5','6','7','8']) {
      if (!hasHalfSouth) set.delete(r);
    }
  }

  // If neither south nor north half-courts detected (e.g., fieldhouse or pure wide),
  // leave as-is (fieldhouse courts 3–8 stand on their own).

  return Array.from(set);
}

// Grouping key: (reserveeNorm + purposeNorm + startMin + endMin).
// This clusters all wide/half rows of the SAME actual booking.
function groupKey(reservee, purpose, startMin, endMin) {
  return `${clean(reservee).toLowerCase()}|${clean(purpose).toLowerCase()}|${startMin}|${endMin}`;
}

// ---------- Main ----------
function buildEmptyJson() {
  return {
    dayStartMin: 360, // 6:00
    dayEndMin: 1380,  // 23:00
    rooms: [
      { id: '1A',  label:'1A',  group:'south' },
      { id: '1B',  label:'1B',  group:'south' },
      { id: '2A',  label:'2A',  group:'south' },
      { id: '2B',  label:'2B',  group:'south' },
      { id: '3',   label:'3',   group:'fieldhouse' },
      { id: '4',   label:'4',   group:'fieldhouse' },
      { id: '5',   label:'5',   group:'fieldhouse' },
      { id: '6',   label:'6',   group:'fieldhouse' },
      { id: '7',   label:'7',   group:'fieldhouse' },
      { id: '8',   label:'8',   group:'fieldhouse' },
      { id: '9A',  label:'9A',  group:'north' },
      { id: '9B',  label:'9B',  group:'north' },
      { id: '10A', label:'10A', group:'north' },
      { id: '10B', label:'10B', group:'north' },
    ],
    slots: []
  };
}

async function main() {
  if (!fs.existsSync(INPUT_CSV) || fs.statSync(INPUT_CSV).size === 0) {
    fs.writeFileSync(OUTPUT_JSON, JSON.stringify(buildEmptyJson(), null, 2));
    console.log(`transform: no csv -> empty scaffold`);
    return;
  }

  const raw = fs.readFileSync(INPUT_CSV, 'utf8');

  // Parse with csv-parse/sync (robust for commas in names)
  const records = parse(raw, {
    bom: true,
    skip_empty_lines: true
  });

  if (!records.length) {
    fs.writeFileSync(OUTPUT_JSON, JSON.stringify(buildEmptyJson(), null, 2));
    console.log(`transform: parsed 0 rows -> empty scaffold`);
    return;
  }

  // Identify headers
  const header = records[0].map(h => clean(h).toLowerCase());
  const idx = (name) => header.findIndex(h => h === name.toLowerCase());

  const iLocation = idx('location:');         // "Athletic & Event Center"
  const iFacility = idx('facility');          // "AC Gym - Half Court 1B", etc.
  const iTime     = idx('reserved time');     // " 7:00pm -  9:00pm "
  const iReservee = idx('reservee');          // "Llanos, David" or "Empower Volleyball (Rec), Dean Baxendale"
  const iPurpose  = idx('reservation purpose');

  if (iFacility < 0 || iTime < 0 || iReservee < 0 || iPurpose < 0) {
    // minimal safety
    fs.writeFileSync(OUTPUT_JSON, JSON.stringify(buildEmptyJson(), null, 2));
    console.log(`transform: headers missing -> empty scaffold`);
    return;
  }

  const nowMin = todayMinutesNow();

  // 1) First pass: collect only today's RAEC rows, filter internal (except Pickleball),
  //    parse minutes + facility map.
  const kept = [];
  let dropInternal = 0, dropPast = 0, dropNoMap = 0, dropNotRAEC = 0, dropNoTime = 0;

  for (let r = 1; r < records.length; r++) {
    const row = records[r];

    const location = iLocation >= 0 ? clean(row[iLocation]) : 'Athletic & Event Center';
    const facility = clean(row[iFacility]);
    const timeText = clean(row[iTime]);
    const reservee = clean(row[iReservee]);
    const purpose  = clean(row[iPurpose]);

    // Only the Athletic & Event Center
    if (!/athletic\s*&\s*event\s*center/i.test(location)) {
      dropNotRAEC++; continue;
    }

    const range = parseRangeToMinutes(timeText);
    if (!range) { dropNoTime++; continue; }

    // Past filter: show current/future only (end > now)
    if (range.endMin <= nowMin) { dropPast++; continue; }

    if (isInternalRow(reservee, purpose)) {
      dropInternal++; continue;
    }

    const rooms = mapFacilityToRooms(facility);
    if (!rooms.length) { dropNoMap++; continue; }

    kept.push({
      facility,
      reservee,
      purpose,
      startMin: range.startMin,
      endMin: range.endMin,
      rooms
    });
  }

  // 2) Group rows by (reservee+purpose+time) and narrow to most specific half-courts if present.
  const groups = new Map();
  for (const it of kept) {
    const key = groupKey(it.reservee, it.purpose, it.startMin, it.endMin);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(it);
  }

  const slots = [];
  for (const [key, rows] of groups.entries()) {
    // Union all rooms in this block
    const union = new Set();
    for (const r of rows) for (const room of r.rooms) union.add(room);

    // Narrow preference: if any half courts present for north/south, keep only those.
    const narrowed = narrowRooms(Array.from(union));

    // Prepare display text (consistent across rows in this group)
    const any = rows[0];
    const { title, subtitle, org, contact } = makeDisplay(any.reservee, any.purpose);

    for (const roomId of narrowed) {
      slots.push({
        roomId,
        startMin: any.startMin,
        endMin:   any.endMin,
        title,
        subtitle,
        org,
        contact
      });
    }
  }

  // 3) De-duplicate identical room/time/title combos (just in case)
  const seen = new Set();
  const finalSlots = [];
  for (const s of slots) {
    const k = `${s.roomId}|${s.startMin}|${s.endMin}|${s.title}|${s.subtitle}`;
    if (!seen.has(k)) {
      seen.add(k);
      finalSlots.push(s);
    }
  }

  // 4) Output JSON structure (fixed rooms list + slots)
  const out = buildEmptyJson();
  out.slots = finalSlots.sort((a,b) => (a.roomId.localeCompare(b.roomId) || a.startMin - b.startMin));

  fs.writeFileSync(OUTPUT_JSON, JSON.stringify(out, null, 2));
  console.log(
    `transform: kept=${kept.length} slots=${out.slots.length} ` +
    `drop[internal=${dropInternal} past=${dropPast} notRAEC=${dropNotRAEC} noTime=${dropNoTime} noMap=${dropNoMap}]`
  );
}

main().catch(err => {
  console.error('transform.mjs failed:', err);
  process.exit(1);
});
