#!/usr/bin/env node
// scripts/transform.mjs
// Transform latest CSV -> events.json with RAEC rules

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parse } from 'csv-parse/sync';

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
  const thirdMonMar  = nthWeekdayOfMonth(y, 2, 1, 3);
  const secondMonNov = nthWeekdayOfMonth(y,10, 1, 2);
  if (!thirdMonMar || !secondMonNov) return true; // safety fallback
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
  const f = cleanWhitespace(facility);

  if (/^AC Gym - Half Court 1A$/i.test(f)) return ['1A'];
  if (/^AC Gym - Half Court 1B$/i.test(f)) return ['1B'];
  if (/^AC Gym - Court 1-AB$/i.test(f))    return ['1A','1B'];

  if (/^AC Gym - Half Court 2A$/i.test(f)) return ['2A'];
  if (/^AC Gym - Half Court 2B$/i.test(f)) return ['2B'];
  if (/^AC Gym - Court 2-AB$/i.test(f))    return ['2A','2B'];

  if (/Full Gym 1AB & 2AB/i.test(f))       return ['1A','1B','2A','2B'];
  if (/Championship Court/i.test(f))       return ['1A','1B','2A','2B'];

  if (/^AC Gym - Half Court 9A$/i.test(f)) return ['9A'];
  if (/^AC Gym - Half Court 9B$/i.test(f)) return ['9B'];
  if (/^AC Gym - Court 9-AB$/i.test(f))    return ['9A','9B'];

  if (/^AC Gym - Half Court 10A$/i.test(f)) return ['10A'];
  if (/^AC Gym - Half Court 10B$/i.test(f)) return ['10B'];
  if (/^AC Gym - Court 10-AB$/i.test(f))    return ['10A','10B'];

  if (/Full Court 9 & 10/i.test(f))         return ['9A','9B','10A','10B'];

  if (/^AC Fieldhouse - Court\s*([3-8])$/i.test(f)) {
    const m = f.match(/^AC Fieldhouse - Court\s*([3-8])$/i);
    return [m[1]];
  }
  if (/^AC Fieldhouse - Court 3-8$/i.test(f)) return ['3','4','5','6','7','8'];

  if (/^AC Fieldhouse - Full Turf$/i.test(f)) return ['3','4','5','6','7','8'];
  if (/^AC Fieldhouse - Half Turf North$/i.test(f)) return ['6','7','8'];
  if (/^AC Fieldhouse - Half Turf South$/i.test(f)) return ['3','4','5'];
  if (/^AC Fieldhouse - Quarter Turf N[AB]$/i.test(f)) return ['7','8'];
  if (/^AC Fieldhouse - Quarter Turf S[AB]$/i.test(f)) return ['3','4'];

  return [];
}

function makeSlot(roomId, startMin, endMin, title, subtitle, org = '', contact = '') {
  return { roomId, startMin, endMin, title, subtitle, org, contact };
}

// ---------- Main ----------
async function main() {
  // Empty CSV → scaffold
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

  const raw = fs.readFileSync(INPUT_CSV, 'utf8');

  // Robust CSV parse (handles quoted commas, etc.)
  const rows = parse(raw, {
    columns: true,
    skip_empty_lines: true,
    trim: true
  });

  if (!rows.length) {
    // same scaffold as above
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
    console.log('No rows; wrote scaffold events.json');
    return;
  }

  // The RecTrac extract you showed used headers like: Location:, Facility, Reserved Time, Reservee, Reservation Purpose
  const nameMap = Object.fromEntries(Object.keys(rows[0]).map(k => [k.trim().toLowerCase(), k]));
  const col = (label) => nameMap[label.toLowerCase()] || null;

  const colLocation = col('Location:') ?? col('Location') ?? null;
  const colFacility = col('Facility');
  const colTime     = col('Reserved Time');
  const colReservee = col('Reservee');
  const colPurpose  = col('Reservation Purpose');

  const courtMode = isCourtSeason(new Date());

  const items = [];
  for (const r of rows) {
    const location = cleanWhitespace(colLocation ? r[colLocation] : '');
    const facility = cleanWhitespace(colFacility ? r[colFacility] : '');
    const timeText = cleanWhitespace(colTime     ? r[colTime]     : '');
    const reservee = cleanWhitespace(colReservee ? r[colReservee] : '');
    const purpose  = cleanWhitespace(colPurpose  ? r[colPurpose]  : '');

    if (!facility || !timeText) continue;
    if (location && !/athletic\s*&\s*event\s*center/i.test(location)) continue;

    // Ignore turf during court season
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
      org = 'Open Pickleball';
    } else if (who.type === 'catch') {
      title = 'Catch Corner';
      subtitle = pur;
      org = 'Catch Corner';
    } else if (who.type === 'person') {
      title = who.person;
      subtitle = pur;
      org = who.person;
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

  // Deduplicate Fieldhouse “Court 3-8” blanket vs specifics for same org/time overlap
  const resultSlots = [];
  const specifics = items.filter(it => it.rooms.length <= 2 || it.rooms.some(r => /^[3-8]$/.test(r)));

  function overlaps(a, b) { return a.startMin < b.endMin && b.startMin < a.endMin; }

  for (const it of items) {
    const isBlanketFH = it.rooms.every(r => /^[3-8]$/.test(r)) && it.rooms.length >= 4;
    if (isBlanketFH) {
      const keepRooms = it.rooms.filter(r => {
        return !specifics.some(sp =>
          sp !== it &&
          sp.org.toLowerCase() === it.org.toLowerCase() &&
          overlaps(sp, it) &&
          sp.rooms.includes(r)
        );
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
