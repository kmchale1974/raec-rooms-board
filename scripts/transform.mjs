#!/usr/bin/env node
// scripts/transform.mjs
// Transform latest CSV -> events.json with RAEC rules

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parse } from 'csv-parse/sync';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const INPUT_CSV   = process.env.IN_CSV   || path.join(__dirname, '..', 'data', 'inbox', 'latest.csv');
const OUTPUT_JSON = process.env.OUT_JSON || path.join(__dirname, '..', 'events.json');

// ---------- Time helpers ----------
function toMin(hhmmampm) {
  if (!hhmmampm) return null;
  const s = String(hhmmampm).trim().toLowerCase();
  const m = s.match(/^(\d{1,2}):(\d{2})\s*([ap])m$/);
  if (!m) return null;
  let h = parseInt(m[1], 10), min = parseInt(m[2], 10);
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
function nowMinutesLocal() {
  const d = new Date(); // respects TZ from env (workflow sets TZ=America/Chicago)
  return d.getHours() * 60 + d.getMinutes();
}

// ---------- String helpers ----------
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const lc = (s) => clean(s).toLowerCase();

function normalizeReservee(raw) {
  const s = clean(raw);

  // RAEC Front Desk & “internal hold per NM” or “turf install per NM” -> filtered elsewhere
  // People “Last, First”
  // Or “Org, Contact”
  const parts = s.split(',').map(x => x.trim()).filter(Boolean);

  // Pattern: "Lastname, Firstname"
  if (parts.length === 2 && /^[A-Za-z'.-]+$/.test(parts[0]) && /^[A-Za-z].+$/.test(parts[1])) {
    return { type: 'person', person: `${parts[1]} ${parts[0]}`.replace(/\s+/g, ' ').trim(), org: '', contact: '' };
  }

  // Pattern: "Org, Contact"
  if (parts.length >= 2) {
    const org = parts[0];
    const contact = parts.slice(1).join(', ');
    return { type: 'org+contact', org, contact, person: '' };
  }

  // Single token -> could be org or person; treat as org fallback
  return { type: 'org', org: s, contact: '', person: '' };
}

function cleanPurpose(purpose) {
  let s = clean(purpose);
  // Strip wrapping parentheses and “Internal Hold per NM”
  s = s.replace(/^\(+/, '').replace(/\)+$/, '');
  s = s.replace(/internal hold per nm/ig, '').replace(/turf install per nm/ig, '');
  return clean(s);
}

const isPickleball = (purpose, reservee) =>
  /pickleball/i.test(purpose || '') || /pickleball/i.test(reservee || '');

// ---------- Facility → rooms mapping ----------
function roomsForFacility(facility) {
  const f = clean(facility);

  // South 1/2
  if (/^ac gym - half court 1a$/i.test(f)) return ['1A'];
  if (/^ac gym - half court 1b$/i.test(f)) return ['1B'];
  if (/^ac gym - court 1-ab$/i.test(f))    return ['1A','1B'];

  if (/^ac gym - half court 2a$/i.test(f)) return ['2A'];
  if (/^ac gym - half court 2b$/i.test(f)) return ['2B'];
  if (/^ac gym - court 2-ab$/i.test(f))    return ['2A','2B'];

  // Umbrellas that cover 1/2
  if (/full gym 1ab\s*&\s*2ab/i.test(f))   return ['1A','1B','2A','2B'];
  if (/championship court/i.test(f))       return ['1A','1B','2A','2B'];

  // North 9/10
  if (/^ac gym - half court 9a$/i.test(f)) return ['9A'];
  if (/^ac gym - half court 9b$/i.test(f)) return ['9B'];
  if (/^ac gym - court 9-ab$/i.test(f))    return ['9A','9B'];

  if (/^ac gym - half court 10a$/i.test(f)) return ['10A'];
  if (/^ac gym - half court 10b$/i.test(f)) return ['10B'];
  if (/^ac gym - court 10-ab$/i.test(f))    return ['10A','10B'];

  if (/full gym 9\s*&\s*10/i.test(f))      return ['9A','9B','10A','10B'];

  // Fieldhouse courts 3..8
  const m = f.match(/^ac fieldhouse - court\s*([3-8])$/i);
  if (m) return [m[1]];
  if (/^ac fieldhouse - court 3-8$/i.test(f)) return ['3','4','5','6','7','8'];

  // Turf lines (drop entirely)
  if (/fieldhouse.*turf/i.test(f)) return [];

  return [];
}

// ---------- Dedup hierarchy within the same org/time ----------
function overlaps(a, b) {
  return a.startMin < b.endMin && b.startMin < a.endMin;
}
function specificityScore(facility) {
  const f = lc(facility);
  if (/half court \d{1,2}[ab]/.test(f)) return 3; // most specific
  if (/court \d{1,2}-ab/.test(f))      return 2; // mid
  if (/full gym|championship court/.test(f)) return 1; // umbrella
  if (/fieldhouse - court \d/.test(f)) return 3; // specific fieldhouse court
  return 0;
}

// ---------- Main ----------
function writeEmptyScaffold() {
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

async function main() {
  if (!fs.existsSync(INPUT_CSV) || fs.statSync(INPUT_CSV).size === 0) {
    writeEmptyScaffold();
    return;
  }

  const raw = fs.readFileSync(INPUT_CSV);
  const rows = parse(raw, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    trim: true
  });

  // Expected headers (case-insensitive matches)
  // "Location:", "Facility", "Reserved Time", "Reservee", "Reservation Purpose"
  const headerMap = Object.keys(rows[0] || {}).reduce((acc, k) => {
    acc[lc(k)] = k;
    return acc;
  }, {});

  const colLocation = headerMap['location:'];
  const colFacility = headerMap['facility'];
  const colTime     = headerMap['reserved time'];
  const colReservee = headerMap['reservee'];
  const colPurpose  = headerMap['reservation purpose'];

  if (!colFacility || !colTime || !colReservee || !colPurpose) {
    // If headers weird, write scaffold to avoid UI crash
    writeEmptyScaffold();
    return;
  }

  const nowMin = nowMinutesLocal();

  // First pass: build raw items & filter junk
  const items = [];
  for (const row of rows) {
    const location = clean(row[colLocation] || '');
    if (location && !/athletic\s*&\s*event\s*center/i.test(location)) continue; // Only RAEC

    const facility = clean(row[colFacility]);
    const timeText = clean(row[colTime]);
    const reservee = clean(row[colReservee]);
    const purpose  = clean(row[colPurpose]);

    if (!facility || !timeText) continue;

    // Filter out RAEC Front Desk / Internal Holds / turf installs (these should never show)
    const junk = /raec\s*front\s*desk/i.test(reservee)
              || /internal hold per nm/i.test(purpose)
              || /internal hold per nm/i.test(reservee)
              || /turf install per nm/i.test(purpose)
              || /turf install per nm/i.test(reservee);
    if (junk) continue;

    const range = parseRangeToMinutes(timeText);
    if (!range) continue;

    // Hide past events today
    if (range.endMin <= nowMin) continue;

    const rooms = roomsForFacility(facility);
    if (!rooms.length) continue;

    const who = normalizeReservee(reservee);
    const pur = cleanPurpose(purpose);

    // Title/subtitle mapping
    let title = '', subtitle = '', org = '', contact = '';

    if (isPickleball(purpose, reservee)) {
      title = 'Open Pickleball';
      subtitle = '';
      org = 'Open Pickleball'; contact = '';
    } else if (who.type === 'person') {
      title = who.person; subtitle = pur;
      org = who.person; contact = '';
    } else if (who.type === 'org+contact') {
      title = who.org; subtitle = pur || who.contact;
      org = who.org; contact = who.contact;
    } else {
      title = who.org || 'Reservation';
      subtitle = pur;
      org = who.org || ''; contact = '';
    }

    items.push({
      facility,
      rooms,
      startMin: range.startMin,
      endMin:   range.endMin,
      title, subtitle, org, contact,
      orgKey: lc(org || title),
      spec: specificityScore(facility)
    });
  }

  // Group by (orgKey + exact time window) to apply umbrella → specific dedup
  const groups = new Map();
  for (const it of items) {
    const key = `${it.orgKey}__${it.startMin}__${it.endMin}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(it);
  }

  const resultSlots = [];

  for (const [, group] of groups) {
    // If group has any half-court/specific entries (spec=3), drop mid (2) and umbrella (1) that overlap rooms
    const hasSpec3 = group.some(g => g.spec === 3);
    const hasSpec2 = group.some(g => g.spec === 2);
    const keep = [];

    if (hasSpec3) {
      // keep spec3 only
      for (const it of group) if (it.spec === 3) keep.push(it);
    } else if (hasSpec2) {
      // keep spec2 only
      for (const it of group) if (it.spec === 2) keep.push(it);
    } else {
      // only umbrellas present
      keep.push(...group);
    }

    // Emit room-by-room
    for (const it of keep) {
      for (const r of it.rooms) {
        resultSlots.push({
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
  }

  // Final de-dup: same room/time/title
  const uniq = new Map();
  for (const s of resultSlots) {
    const key = `${s.roomId}__${s.startMin}__${s.endMin}__${lc(s.title)}__${lc(s.subtitle)}`;
    if (!uniq.has(key)) uniq.set(key, s);
  }

  const json = {
    dayStartMin: 360,
    dayEndMin: 1380,
    rooms: [
      { id: '1A',  label: '1A',  group: 'south' },
      { id: '1B',  label: '1B',  group: 'south' },
      { id: '2A',  label: '2A',  group: 'south' },
      { id: '2B',  label: '2B',  group: 'south' },
      { id: '3',   label: '3',   group: 'fieldhouse' },
      { id: '4',   label: '4',   group: 'fieldhouse' },
      { id: '5',   label: '5',   group: 'fieldhouse' },
      { id: '6',   label: '6',   group: 'fieldhouse' },
      { id: '7',   label: '7',   group: 'fieldhouse' },
      { id: '8',   label: '8',   group: 'fieldhouse' },
      { id: '9A',  label: '9A',  group: 'north' },
      { id: '9B',  label: '9B',  group: 'north' },
      { id: '10A', label: '10A', group: 'north' },
      { id: '10B', label: '10B', group: 'north' }
    ],
    slots: Array.from(uniq.values())
      // sort by room, then start time
      .sort((a,b) => (a.roomId.localeCompare(b.roomId) || a.startMin - b.startMin))
  };

  fs.writeFileSync(OUTPUT_JSON, JSON.stringify(json, null, 2));
  console.log(`Wrote events.json • rooms=${json.rooms.length} • slots=${json.slots.length}`);
}

main().catch(err => {
  console.error('transform.mjs failed:', err);
  process.exit(1);
});
