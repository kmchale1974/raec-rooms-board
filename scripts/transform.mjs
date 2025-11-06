#!/usr/bin/env node
// RAEC: CSV -> events.json with court narrowing + keep Catch Corner + keep Pickleball

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parse } from 'csv-parse/sync';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const INPUT_CSV   = process.env.IN_CSV   || path.join(__dirname, '..', 'data', 'inbox', 'latest.csv');
const OUTPUT_JSON = process.env.OUT_JSON || path.join(__dirname, '..', 'events.json');

function clean(s) { return String(s ?? '').replace(/\s+/g, ' ').trim(); }

function toMin(hhmm) {
  const m = String(hhmm).trim().toLowerCase().match(/^(\d{1,2}):(\d{2})\s*([ap])m$/);
  if (!m) return null;
  let h = parseInt(m[1],10);
  const min = parseInt(m[2],10);
  const mer = m[3];
  if (h === 12) h = 0;
  if (mer === 'p') h += 12;
  return h*60 + min;
}
function parseRangeToMinutes(text) {
  const m = String(text).toLowerCase().match(/(\d{1,2}:\d{2}\s*[ap]m)\s*-\s*(\d{1,2}:\d{2}\s*[ap]m)/i);
  if (!m) return null;
  return { startMin: toMin(m[1]), endMin: toMin(m[2]) };
}
function nowMinutesLocal() {
  const d = new Date();
  return d.getHours()*60 + d.getMinutes();
}

// "Last, First" -> "First Last" for simple person cases.
function normalizePersonName(reserveeRaw) {
  const s = clean(reserveeRaw);
  const m = s.match(/^\s*([A-Za-z'.-]+)\s*,\s*([A-Za-z'.-]+)\s*$/);
  return m ? `${m[2]} ${m[1]}` : s;
}

// Only drop obvious system holds; keep "Internal Holds" rows (Catch Corner etc.)
function isSystemDrop(reservee, purpose) {
  const r = reservee.toLowerCase();
  const p = purpose.toLowerCase();
  if (r.includes('raec front desk')) return true;
  if (p.includes('turf install')) return true;
  return false;
}

function makeDisplay(reservee, purpose) {
  const rRaw = clean(reservee);
  const pRaw = clean(purpose);

  // Pickleball: always show as Open Pickleball
  if (/pickleball/i.test(rRaw) || /pickleball/i.test(pRaw)) {
    return { title: 'Open Pickleball', subtitle: '', org: 'Open Pickleball', contact: '' };
  }

  // Org + contact pattern like "Empower Volleyball (Rec), Dean Baxendale"
  if (rRaw.includes(',')) {
    const left = rRaw.split(',')[0].trim();
    const right = rRaw.split(',').slice(1).join(',').trim();
    if (/\b(Volleyball|Club|Academy|Athletics|Sports|United|Elite|Training|Catch Corner|High School|HS|SPED|School)\b/i.test(left)) {
      return { title: left, subtitle: pRaw, org: left, contact: right };
    }
  }

  // Otherwise, treat as person if it's "Last, First"
  const maybePerson = normalizePersonName(rRaw);
  let org = '';
  if (/\s/.test(maybePerson) && !/\b(Volleyball|Club|Academy|Athletics|Sports|United|Elite|Training|Catch Corner|High School|HS|SPED|School)\b/i.test(maybePerson)) {
    org = maybePerson;
  }
  return { title: maybePerson, subtitle: pRaw, org: org || maybePerson, contact: '' };
}

// Facility -> room list
function mapFacilityToRooms(fac) {
  const f = clean(fac).toLowerCase();

  // South 1/2
  if (f === 'ac gym - half court 1a') return ['1A'];
  if (f === 'ac gym - half court 1b') return ['1B'];
  if (f === 'ac gym - court 1-ab')    return ['1A','1B'];

  if (f === 'ac gym - half court 2a') return ['2A'];
  if (f === 'ac gym - half court 2b') return ['2B'];
  if (f === 'ac gym - court 2-ab')    return ['2A','2B'];

  if (f.includes('full gym 1ab & 2ab')) return ['1A','1B','2A','2B'];
  if (f.includes('championship court'))  return ['1A','1B','2A','2B'];

  // North 9/10
  if (f === 'ac gym - half court 9a') return ['9A'];
  if (f === 'ac gym - half court 9b') return ['9B'];
  if (f === 'ac gym - court 9-ab')    return ['9A','9B'];

  if (f === 'ac gym - half court 10a') return ['10A'];
  if (f === 'ac gym - half court 10b') return ['10B'];
  if (f === 'ac gym - court 10-ab')    return ['10A','10B'];

  if (f.includes('full gym 9 & 10'))   return ['9A','9B','10A','10B'];

  // Fieldhouse 3–8
  if (/^ac fieldhouse - court\s*([3-8])$/i.test(clean(fac))) {
    return [String(RegExp.$1)];
  }
  if (f === 'ac fieldhouse - court 3-8') return ['3','4','5','6','7','8'];

  // Turf variants (kept if posted and not system-dropped)
  if (f === 'ac fieldhouse - full turf') return ['3','4','5','6','7','8'];
  if (f === 'ac fieldhouse - half turf north') return ['6','7','8'];
  if (f === 'ac fieldhouse - half turf south') return ['3','4','5'];

  return [];
}

// If a block includes any half-court(s), keep only halves for that side and drop wide/AB/Full.
function narrowRooms(rooms) {
  const set = new Set(rooms);

  const hasSouthHalf = ['1A','1B','2A','2B'].some(r => set.has(r));
  const hasNorthHalf = ['9A','9B','10A','10B'].some(r => set.has(r));

  if (hasSouthHalf) {
    for (const r of ['9A','9B','10A','10B','3','4','5','6','7','8']) set.delete(r);
  }
  if (hasNorthHalf) {
    for (const r of ['1A','1B','2A','2B','3','4','5','6','7','8']) {
      if (!hasSouthHalf) set.delete(r);
    }
  }
  return Array.from(set);
}

// Canonicalize reservee/purpose for grouping
function canon(s) { return clean(s).toLowerCase(); }
function groupKey(reservee, purpose, startMin, endMin) {
  // strip booking #s in purpose so variants like "... #438632" still group if time matches
  const p = canon(purpose).replace(/#\d{4,}/g, '').replace(/\(booking[^)]*\)/g,'').trim();
  const r = canon(reservee);
  return `${r}|${p}|${startMin}|${endMin}`;
}

function buildEmptyJson() {
  return {
    dayStartMin: 360,
    dayEndMin: 1380,
    rooms: [
      { id:'1A',  label:'1A',  group:'south' },
      { id:'1B',  label:'1B',  group:'south' },
      { id:'2A',  label:'2A',  group:'south' },
      { id:'2B',  label:'2B',  group:'south' },
      { id:'3',   label:'3',   group:'fieldhouse' },
      { id:'4',   label:'4',   group:'fieldhouse' },
      { id:'5',   label:'5',   group:'fieldhouse' },
      { id:'6',   label:'6',   group:'fieldhouse' },
      { id:'7',   label:'7',   group:'fieldhouse' },
      { id:'8',   label:'8',   group:'fieldhouse' },
      { id:'9A',  label:'9A',  group:'north' },
      { id:'9B',  label:'9B',  group:'north' },
      { id:'10A', label:'10A', group:'north' },
      { id:'10B', label:'10B', group:'north' },
    ],
    slots: []
  };
}

async function main() {
  if (!fs.existsSync(INPUT_CSV) || fs.statSync(INPUT_CSV).size === 0) {
    fs.writeFileSync(OUTPUT_JSON, JSON.stringify(buildEmptyJson(), null, 2));
    console.log('transform: no csv -> empty scaffold');
    return;
  }

  const raw = fs.readFileSync(INPUT_CSV, 'utf8');
  const rows = parse(raw, { bom: true, skip_empty_lines: true });
  if (!rows.length) {
    fs.writeFileSync(OUTPUT_JSON, JSON.stringify(buildEmptyJson(), null, 2));
    console.log('transform: parsed 0 rows -> empty scaffold');
    return;
  }

  const header = rows[0].map(h => clean(h).toLowerCase());
  const col = (name) => header.findIndex(h => h === name.toLowerCase());

  const iLocation = col('location:');
  const iFacility = col('facility');
  const iTime     = col('reserved time');
  const iReservee = col('reservee');
  const iPurpose  = col('reservation purpose');

  if (iFacility < 0 || iTime < 0 || iReservee < 0 || iPurpose < 0) {
    fs.writeFileSync(OUTPUT_JSON, JSON.stringify(buildEmptyJson(), null, 2));
    console.log('transform: headers missing -> empty scaffold');
    return;
  }

  const nowMin = nowMinutesLocal();

  // pass 1 — collect
  const kept = [];
  let dropSystem = 0, dropPast = 0, dropNoMap = 0, dropNotRAEC = 0, dropNoTime = 0;

  for (let r = 1; r < rows.length; r++) {
    const rec = rows[r];
    const location = iLocation >= 0 ? clean(rec[iLocation]) : 'Athletic & Event Center';
    const facility = clean(rec[iFacility]);
    const timeText = clean(rec[iTime]);
    const reservee = clean(rec[iReservee]);
    const purpose  = clean(rec[iPurpose]);

    if (!/athletic\s*&\s*event\s*center/i.test(location)) { dropNotRAEC++; continue; }

    const range = parseRangeToMinutes(timeText);
    if (!range) { dropNoTime++; continue; }

    if (range.endMin <= nowMin) { dropPast++; continue; }

    if (isSystemDrop(reservee, purpose)) { dropSystem++; continue; }

    const rooms = mapFacilityToRooms(facility);
    if (!rooms.length) { dropNoMap++; continue; }

    kept.push({ facility, reservee, purpose, startMin: range.startMin, endMin: range.endMin, rooms });
  }

  // pass 2 — group by (reservee+purpose-without-booking# + time) and narrow
  const groups = new Map();
  for (const it of kept) {
    const key = groupKey(it.reservee, it.purpose, it.startMin, it.endMin);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(it);
  }

  const slots = [];
  for (const arr of groups.values()) {
    // union the rooms
    const union = new Set();
    for (const it of arr) for (const r of it.rooms) union.add(r);
    const narrowed = narrowRooms(Array.from(union));

    const any = arr[0];
    const { title, subtitle, org, contact } = makeDisplay(any.reservee, any.purpose);

    for (const roomId of narrowed) {
      slots.push({ roomId, startMin: any.startMin, endMin: any.endMin, title, subtitle, org, contact });
    }
  }

  // dedup safety
  const seen = new Set();
  const finalSlots = [];
  for (const s of slots) {
    const k = `${s.roomId}|${s.startMin}|${s.endMin}|${s.title}|${s.subtitle}`;
    if (!seen.has(k)) { seen.add(k); finalSlots.push(s); }
  }

  const out = buildEmptyJson();
  out.slots = finalSlots.sort((a,b) => (a.roomId.localeCompare(b.roomId) || a.startMin - b.startMin));

  fs.writeFileSync(OUTPUT_JSON, JSON.stringify(out, null, 2));
  console.log(
    `transform: rows=${rows.length-1} kept=${kept.length} slots=${out.slots.length} ` +
    `drop[system=${dropSystem} past=${dropPast} notRAEC=${dropNotRAEC} noTime=${dropNoTime} noMap=${dropNoMap}]`
  );
}

main().catch(err => {
  console.error('transform.mjs failed:', err);
  process.exit(1);
});
