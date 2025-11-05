#!/usr/bin/env node
// Robust CSV -> events.json for RAEC Rooms Board

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
const TZ = 'America/Chicago';
function todayChicagoDate() {
  // normalize to “today” in America/Chicago (clock only matters for end-time cutoff)
  const now = new Date();
  return now; // We’ll treat “past” by minutes since midnight local time.
}

function toMinFromRange(text) {
  if (!text) return null;
  const m = String(text).trim().match(/(\d{1,2}:\d{2})\s*([AP]M)\s*-\s*(\d{1,2}:\d{2})\s*([AP]M)/i);
  if (!m) return null;
  const start = toMin(`${m[1]} ${m[2]}`);
  const end   = toMin(`${m[3]} ${m[4]}`);
  if (start == null || end == null) return null;
  return { startMin: start, endMin: end };
}

function toMin(hhmmMer) {
  const m = String(hhmmMer).trim().match(/^(\d{1,2}):(\d{2})\s*([AP]M)$/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const mer = m[3].toLowerCase();
  if (h === 12) h = 0;
  if (mer === 'pm') h += 12;
  return h * 60 + min;
}

function clean(s) {
  return String(s ?? '').replace(/\uFEFF/g, '').replace(/\s+/g, ' ').trim();
}

function headerIndex(header, names) {
  // find first match ignoring case, optional colon
  const H = header.map(h => clean(h).replace(/:$/, '').toLowerCase());
  for (const name of names) {
    const want = name.toLowerCase().replace(/:$/, '');
    const i = H.indexOf(want);
    if (i !== -1) return i;
  }
  return -1;
}

function isInternalHold(s) {
  const x = clean(s).toLowerCase();
  if (!x) return false;
  return /internal hold/i.test(x) || /raec front desk/i.test(x) || /turf install/i.test(x);
}

function normalizeReservee(s) {
  const t = clean(s);
  // “Last, First” -> “First Last”
  const m = t.match(/^([A-Za-z'.-]+),\s*([A-Za-z'.-]+)(.*)$/);
  if (m) {
    const firstLast = `${m[2]} ${m[1]}`.replace(/\s+/g, ' ').trim();
    return firstLast;
  }
  // “Org, Contact” -> keep as-is (we show org in title, not contact)
  return t;
}

function isPickleball(purpose, reservee) {
  const a = clean(purpose).toLowerCase();
  const b = clean(reservee).toLowerCase();
  return /pickleball/.test(a) || /pickleball/.test(b);
}

// -------- Facility → room mapping (returns array of room ids) --------
function roomsForFacility(fac) {
  const f = clean(fac).toLowerCase();

  // South (1/2)
  if (/ac gym - half court 1a/i.test(f)) return ['1A'];
  if (/ac gym - half court 1b/i.test(f)) return ['1B'];
  if (/ac gym - court 1-?ab/i.test(f))  return ['1A', '1B'];

  if (/ac gym - half court 2a/i.test(f)) return ['2A'];
  if (/ac gym - half court 2b/i.test(f)) return ['2B'];
  if (/ac gym - court 2-?ab/i.test(f))  return ['2A', '2B'];

  if (/full gym 1ab\s*&\s*2ab/i.test(f)) return ['1A','1B','2A','2B'];
  if (/championship court/i.test(f))     return ['1A','1B','2A','2B'];

  // North (9/10)
  if (/ac gym - half court 9a/i.test(f)) return ['9A'];
  if (/ac gym - half court 9b/i.test(f)) return ['9B'];
  if (/ac gym - court 9-?ab/i.test(f))  return ['9A','9B'];

  if (/ac gym - half court 10a/i.test(f)) return ['10A'];
  if (/ac gym - half court 10b/i.test(f)) return ['10B'];
  if (/ac gym - court 10-?ab/i.test(f))  return ['10A','10B'];

  if (/full gym 9\s*&\s*10/i.test(f))    return ['9A','9B','10A','10B'];

  // Fieldhouse (court season)
  if (/ac fieldhouse - court\s*([3-8])/i.test(f)) {
    return [f.match(/([3-8])/)[1]];
  }
  if (/ac fieldhouse - court 3-8/i.test(f)) return ['3','4','5','6','7','8'];

  // Turf variants are ignored for court season (we do not map them)
  return [];
}

// more-specific score (higher = more specific)
function specificityScore(rooms) {
  // 1 room  -> 100
  // 2 rooms -> 80
  // 4 rooms -> 60 (AB+AB / Championship / Full Gym 1&2)
  // 6+ rooms (3-8 blanket) -> 40
  const n = rooms.length;
  if (n <= 1) return 100;
  if (n === 2) return 80;
  if (n <= 4) return 60;
  return 40;
}

// keep “most specific” per org/time/room
function collapseToSpecific(items) {
  // For each org+time window, keep the most specific room occupancy
  // Algorithm:
  // 1) explode to (room, startMin, endMin, org, what/title, purpose)
  // 2) group by room + [start,end] + org string
  // 3) within group, keep event with highest specificity score (from its parent’s rooms list)

  const exploded = [];
  for (const it of items) {
    for (const r of it.rooms) {
      exploded.push({
        roomId: r,
        startMin: it.startMin,
        endMin: it.endMin,
        org: it.org,
        who: it.who,
        title: it.title,
        subtitle: it.subtitle,
        spec: specificityScore(it.rooms),
      });
    }
  }

  const key = (e) => `${e.roomId}__${e.startMin}-${e.endMin}__${e.org.toLowerCase()}`;
  const best = new Map();
  for (const e of exploded) {
    const k = key(e);
    const prev = best.get(k);
    if (!prev || e.spec > prev.spec) best.set(k, e);
  }
  return Array.from(best.values());
}

// ---------- MAIN ----------
function writeScaffold() {
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
    slots: []
  };
  fs.writeFileSync(OUTPUT_JSON, JSON.stringify(json, null, 2));
}

async function main() {
  if (!fs.existsSync(INPUT_CSV) || fs.statSync(INPUT_CSV).size === 0) {
    writeScaffold();
    console.log('transform: no CSV — wrote scaffold');
    return;
  }

  const raw = fs.readFileSync(INPUT_CSV);
  const records = parse(raw, {
    bom: true,
    relax_column_count: true,
    skip_empty_lines: true
  });

  if (!records.length) {
    writeScaffold();
    console.log('transform: empty CSV — wrote scaffold');
    return;
  }

  const header = records[0].map(h => clean(h));
  const iLocation = headerIndex(header, ['Location:', 'Location']);
  const iFacility = headerIndex(header, ['Facility']);
  const iTime     = headerIndex(header, ['Reserved Time', 'Time', 'Reservation Time']);
  const iReservee = headerIndex(header, ['Reservee', 'Reserved By', 'Contact']);
  const iPurpose  = headerIndex(header, ['Reservation Purpose', 'Purpose', 'Event']);

  if ([iFacility, iTime, iReservee].some(i => i < 0)) {
    writeScaffold();
    console.log('transform: required headers not found — wrote scaffold');
    return;
  }

  const today = todayChicagoDate();
  const nowMin = (today.getHours() * 60) + today.getMinutes();

  let kept = 0;
  const drops = { internal: 0, past: 0, nonRAEC: 0, noMap: 0, badTime: 0 };

  // First pass: parse → raw items
  const rawItems = [];
  for (let r = 1; r < records.length; r++) {
    const row = records[r];

    const location = iLocation >= 0 ? clean(row[iLocation]) : '';
    const facility = clean(row[iFacility]);
    const timeText = clean(row[iTime]);
    const reservee = clean(row[iReservee]);
    const purpose  = iPurpose >= 0 ? clean(row[iPurpose]) : '';

    // Limit to RAEC (be very flexible)
    if (location && !/athletic\s*&\s*event\s*center/i.test(location)) {
      drops.nonRAEC++;
      continue;
    }

    // Time range
    const range = toMinFromRange(timeText);
    if (!range) { drops.badTime++; continue; }

    // Drop events that have already ended today
    if (range.endMin <= nowMin) { drops.past++; continue; }

    // Skip internal holds/front desk/turf install
    if (isInternalHold(purpose) || isInternalHold(reservee)) { drops.internal++; continue; }

    const rooms = roomsForFacility(facility);
    if (rooms.length === 0) { drops.noMap++; continue; }

    // Display fields
    let title = '';
    let subtitle = '';
    let who = '';
    let org = '';

    if (isPickleball(purpose, reservee)) {
      title = 'Open Pickleball';
      subtitle = '';
      who = 'Open Pickleball';
      org = 'Open Pickleball';
    } else {
      // If it's clearly “Org, Contact” we treat left as org
      if (reservee.includes(',')) {
        const [left, right] = reservee.split(',').map(s => clean(s));
        // Heuristic: if left looks like a person (First Last), use that as who
        if (/^[A-Za-z'.-]+\s+[A-Za-z'.-]+$/.test(left)) {
          who = left;
          org = left;
          subtitle = purpose;
        } else {
          who = normalizeReservee(reservee); // will flip Last, First → First Last
          org = left;
          subtitle = purpose || right || '';
        }
      } else {
        who = normalizeReservee(reservee);
        org = who;
        subtitle = purpose;
      }
      title = who;
    }

    rawItems.push({
      rooms,
      startMin: range.startMin,
      endMin: range.endMin,
      who, title, subtitle, org
    });
    kept++;
  }

  // Collapse blanket/full to specific
  const finalPerRoom = collapseToSpecific(rawItems);

  // Build final JSON
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
    slots: finalPerRoom.map(e => ({
      roomId: e.roomId,
      startMin: e.startMin,
      endMin: e.endMin,
      title: e.title,
      subtitle: e.subtitle
    }))
  };

  fs.writeFileSync(OUTPUT_JSON, JSON.stringify(json, null, 2));

  console.log(
    `transform: rows=${records.length - 1} kept=${kept} slots=${json.slots.length} ` +
    `drop=${JSON.stringify(drops)}`
  );
  console.log(`Wrote ${OUTPUT_JSON} • slots=${json.slots.length}`);
}

main().catch(err => {
  console.error('transform failed:', err);
  writeScaffold();
  process.exit(1);
});
