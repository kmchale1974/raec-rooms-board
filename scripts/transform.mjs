#!/usr/bin/env node
// scripts/transform.mjs
// Transform latest CSV -> events.json with RAEC rules

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parse } from 'csv-parse/sync'; // <-- correct import

// ---------- Utilities ----------
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const INPUT_CSV   = process.env.IN_CSV   || path.join(__dirname, '..', 'data', 'inbox', 'latest.csv');
const OUTPUT_JSON = process.env.OUT_JSON || path.join(__dirname, '..', 'events.json');

// Minutes from "h:mmam - h:mmpm"
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

// Date helpers for “court vs turf season”
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
  const thirdMonMar = nthWeekdayOfMonth(y, 2, 1, 3); // March, Monday
  const secondMonNov= nthWeekdayOfMonth(y,10, 1, 2); // November, Monday
  if (!thirdMonMar || !secondMonNov) return true; // safety
  return (d >= thirdMonMar && d < secondMonNov);
}

// Cleaners
function cleanWhitespace(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function normalizeReservee(raw) {
  const s = cleanWhitespace(raw);
  if (/^catch\s*corner/i.test(s) || /^catchcorner/i.test(s)) {
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
      const firstLast = `${right} ${left}`.replace(/\s+/g, ' ').trim();
      return { type: 'person', person: firstLast, org: '', contact: '' };
    }
    return { type: 'org+contact', org: left, contact: right };
  }
  return { type: 'org', org: s, contact: '' };
}

function cleanPurpose(purpose) {
  let s = cleanWhitespace(purpose);
  if (!s) return '';
  s = s.replace(/^\(+/, '').replace(/\)+$/, '');
  s = s.replace(/internal hold per nm/i, '').replace(/\s{2,}/g, ' ').trim();
  return s;
}

function isPickleball(purpose, reservee) {
  return /pickleball/i.test(purpose) || /pickleball/i.test(reservee || '');
}

function mapFacilityToRooms(facility) {
  // exact-name maps first
  if (/^ac gym - half court 1a$/i.test(facility)) return ['1A'];
  if (/^ac gym - half court 1b$/i.test(facility)) return ['1B'];
  if (/^ac gym - court 1-ab$/i.test(facility))    return ['1A','1B'];

  if (/^ac gym - half court 2a$/i.test(facility)) return ['2A'];
  if (/^ac gym - half court 2b$/i.test(facility)) return ['2B'];
  if (/^ac gym - court 2-ab$/i.test(facility))    return ['2A','2B'];

  if (/full gym 1ab & 2ab/i.test(facility))       return ['1A','1B','2A','2B'];
  if (/championship court/i.test(facility))       return ['1A','1B','2A','2B'];

  if (/^ac gym - half court 9a$/i.test(facility)) return ['9A'];
  if (/^ac gym - half court 9b$/i.test(facility)) return ['9B'];
  if (/^ac gym - court 9-ab$/i.test(facility))    return ['9A','9B'];

  if (/^ac gym - half court 10a$/i.test(facility)) return ['10A'];
  if (/^ac gym - half court 10b$/i.test(facility)) return ['10B'];
  if (/^ac gym - court 10-ab$/i.test(facility))    return ['10A','10B'];

  if (/full court 9 & 10/i.test(facility))         return ['9A','9B','10A','10B'];

  if (/^ac fieldhouse - court\s*([3-8])$/i.test(facility)) {
    const n = parseInt(RegExp.$1, 10);
    return [String(n)];
  }
  if (/^ac fieldhouse - court 3-8$/i.test(facility)) return ['3','4','5','6','7','8'];

  if (/^ac fieldhouse - full turf$/i.test(facility)) return ['3','4','5','6','7','8'];
  if (/^ac fieldhouse - half turf north$/i.test(facility)) return ['6','7','8'];
  if (/^ac fieldhouse - half turf south$/i.test(facility)) return ['3','4','5'];
  if (/^ac fieldhouse - quarter turf n[ab]$/i.test(facility)) return ['7','8'];
  if (/^ac fieldhouse - quarter turf s[ab]$/i.test(facility)) return ['3','4'];

  return [];
}

function makeSlot(roomId, startMin, endMin, title, subtitle, org = '', contact = '') {
  return { roomId, startMin, endMin, title, subtitle, org, contact };
}

// ---------- Main ----------
async function main() {
  // If CSV missing/empty → scaffold
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
    console.log('Empty CSV; wrote scaffold events.json');
    return;
  }

  const raw = fs.readFileSync(INPUT_CSV);
  const records = parse(raw, {
    columns: true,
    skip_empty_lines: true,
    bom: true,
    trim: true
  });

  const courtMode = isCourtSeason(new Date());
  const items = [];

  for (const rec of records) {
    const location = cleanWhitespace(rec['Location:'] || rec['Location'] || '');
    const facility = cleanWhitespace(rec['Facility'] || '');
    const timeText = cleanWhitespace(rec['Reserved Time'] || rec['Time'] || '');
    const reservee = cleanWhitespace(rec['Reservee'] || '');
    const purpose  = cleanWhitespace(rec['Reservation Purpose'] || rec['Purpose'] || '');

    if (!facility || !timeText) continue;
    if (location && !/athletic\s*&\s*event\s*center/i.test(location)) continue;

    if (courtMode && /fieldhouse.*turf/i.test(facility)) continue;

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
      org = 'Open Pickleball'; contact = '';
    } else if (who.type === 'catch') {
      title = 'Catch Corner';
      subtitle = pur;
      org = 'Catch Corner'; contact = '';
    } else if (who.type === 'person') {
      title = who.person;
      subtitle = pur;
      org = who.person; contact = '';
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
      title, subtitle, org, contact
    });
  }

  // Dedup blanket vs specific for Fieldhouse
  const resultSlots = [];
  const specifics = items.filter(it => it.rooms.some(r => /^[3-8]$/.test(r)) && it.rooms.length <= 2);

  function overlaps(a, b) { return a.startMin < b.endMin && b.startMin < a.endMin; }

  for (const it of items) {
    const isBlanketFH = it.rooms.every(r => /^[3-8]$/.test(r)) && it.rooms.length >= 4;
    if (isBlanketFH) {
      const keep = it.rooms.filter(r => {
        return !specifics.some(sp =>
          sp.org.toLowerCase() === it.org.toLowerCase() &&
          overlaps(sp, it) &&
          sp.rooms.includes(r)
        );
      });
      for (const r of keep) resultSlots.push(makeSlot(r, it.startMin, it.endMin, it.title, it.subtitle, it.org, it.contact));
      continue;
    }
    for (const r of it.rooms) resultSlots.push(makeSlot(r, it.startMin, it.endMin, it.title, it.subtitle, it.org, it.contact));
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
  console.log(`Wrote events.json • rooms=${json.rooms.length} • slots=${json.slots.length}`);
}

main().catch(err => {
  console.error('transform.mjs failed:', err);
  process.exit(1);
});
