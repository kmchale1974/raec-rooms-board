#!/usr/bin/env node
// Transform latest CSV -> events.json with RAEC rules (most-specific room logic)

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const INPUT_CSV   = process.env.IN_CSV  || path.join(__dirname, '..', 'data', 'inbox', 'latest.csv');
const OUTPUT_JSON = process.env.OUT_JSON || path.join(__dirname, '..', 'events.json');

// --------- small helpers ---------
function clean(s){ return String(s ?? '').replace(/\s+/g,' ').trim(); }

// Parse "h:mmam - h:mmpm" to minutes
function toMin(hhmmampm){
  const m = String(hhmmampm).trim().toLowerCase().match(/^(\d{1,2}):(\d{2})\s*([ap])m$/);
  if (!m) return null;
  let h = parseInt(m[1],10), min = parseInt(m[2],10);
  const mer = m[3];
  if (h === 12) h = 0;
  if (mer === 'p') h += 12;
  return h*60 + min;
}
function parseRange(text){
  const m = String(text).trim().match(/(\d{1,2}:\d{2}\s*[ap]m)\s*-\s*(\d{1,2}:\d{2}\s*[ap]m)/i);
  if (!m) return null;
  return { startMin: toMin(m[1]), endMin: toMin(m[2]) };
}

// “Last, First” → “First Last”; preserve org/contact variants
function normalizeReservee(raw){
  const s = clean(raw);

  // Early: Catch Corner normalization
  if (/^catch\s*corner/i.test(s) || /^catchcorner/i.test(s)) {
    return { kind:'org', org:'Catch Corner', contact:'' };
  }
  if (/raec\s*front\s*desk/i.test(s)) {
    return { kind:'org', org:'RAEC Front Desk', contact:'' };
  }

  // Pure "Last, First" (one comma, no parens on either side)
  const lf = s.match(/^\s*([A-Za-z'.-]+)\s*,\s*([A-Za-z'.-]+)\s*$/);
  if (lf){
    const person = `${lf[2]} ${lf[1]}`.replace(/\s+/g,' ');
    return { kind:'person', person, org:'', contact:'' };
  }

  // "Org, Contact" (most common: "Empower Volleyball (Rec), Dean Baxendale")
  const parts = s.split(',').map(x=>x.trim());
  if (parts.length >= 2){
    const left = parts[0];
    const right = parts.slice(1).join(', ');

    // If right "First Last" → we keep org left as org, contact as right
    if (/^[A-Za-z'.-]+\s+[A-Za-z'.-]+/.test(right)) {
      return { kind:'org+contact', org:left, contact:right };
    }
    // Fallback: still org + contact
    return { kind:'org+contact', org:left, contact:right };
  }

  // Single token => treat as org
  return { kind:'org', org:s, contact:'' };
}

function cleanPurpose(p){
  let s = clean(p);
  if (!s) return '';
  s = s.replace(/^\(+/,'').replace(/\)+$/,'');
  s = s.replace(/internal hold per nm/ig,'').trim();
  return s;
}

function isPickleball(purpose, reservee){
  return /pickleball/i.test(String(purpose)) || /pickleball/i.test(String(reservee));
}

// Court season flag (for turf filtering)
function nthWeekdayOfMonth(year, monthIdx, weekday, n){
  const d = new Date(year, monthIdx, 1);
  let count = 0;
  while (d.getMonth() === monthIdx) {
    if (d.getDay() === weekday){
      count++;
      if (count === n) return new Date(d);
    }
    d.setDate(d.getDate()+1);
  }
  return null;
}
function isCourtSeason(d = new Date()){
  const y = d.getFullYear();
  const thirdMonMar = nthWeekdayOfMonth(y, 2, 1, 3);
  const secondMonNov= nthWeekdayOfMonth(y,10, 1, 2);
  if (!thirdMonMar || !secondMonNov) return true;
  return (d >= thirdMonMar && d < secondMonNov);
}

// Map facility text → list of room IDs
function mapFacilityToRooms(fac){
  const f = clean(fac).toLowerCase();

  // South gym 1/2
  if (/^ac gym - half court 1a$/i.test(fac)) return ['1A'];
  if (/^ac gym - half court 1b$/i.test(fac)) return ['1B'];
  if (/^ac gym - court 1-ab$/i.test(fac))    return ['1A','1B'];

  if (/^ac gym - half court 2a$/i.test(fac)) return ['2A'];
  if (/^ac gym - half court 2b$/i.test(fac)) return ['2B'];
  if (/^ac gym - court 2-ab$/i.test(fac))    return ['2A','2B'];

  if (/full gym 1ab & 2ab/i.test(f))         return ['1A','1B','2A','2B'];
  if (/championship court/i.test(f))         return ['1A','1B','2A','2B'];

  // North gym 9/10
  if (/^ac gym - half court 9a$/i.test(fac)) return ['9A'];
  if (/^ac gym - half court 9b$/i.test(fac)) return ['9B'];
  if (/^ac gym - court 9-ab$/i.test(fac))    return ['9A','9B'];

  if (/^ac gym - half court 10a$/i.test(fac)) return ['10A'];
  if (/^ac gym - half court 10b$/i.test(fac)) return ['10B'];
  if (/^ac gym - court 10-ab$/i.test(fac))    return ['10A','10B'];

  if (/full gym 9\s*&\s*10/i.test(f))        return ['9A','9B','10A','10B'];

  // Fieldhouse (courts 3..8)
  if (/^ac fieldhouse - court\s*([3-8])$/i.test(fac)) {
    const n = parseInt(RegExp.$1,10);
    return [String(n)];
  }
  if (/^ac fieldhouse - court 3-8$/i.test(fac)) return ['3','4','5','6','7','8'];

  // Turf (will be filtered in court season)
  if (/^ac fieldhouse - full turf$/i.test(fac)) return ['3','4','5','6','7','8'];
  if (/^ac fieldhouse - half turf north$/i.test(fac)) return ['6','7','8'];
  if (/^ac fieldhouse - half turf south$/i.test(fac)) return ['3','4','5'];
  if (/^ac fieldhouse - quarter turf n[ab]$/i.test(fac)) return ['7','8'];
  if (/^ac fieldhouse - quarter turf s[ab]$/i.test(fac)) return ['3','4'];

  return [];
}

function overlaps(a,b){ return a.startMin < b.endMin && b.startMin < a.endMin; }

function setKey(set){ return Array.from(new Set(set)).sort().join(','); }

// --------- MAIN ---------
async function main(){
  // If CSV missing/empty → write empty scaffold
  if (!fs.existsSync(INPUT_CSV) || fs.statSync(INPUT_CSV).size === 0){
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
    fs.writeFileSync(OUTPUT_JSON, JSON.stringify(scaffold,null,2));
    console.log('Empty CSV → scaffold written.');
    return;
  }

  const raw = fs.readFileSync(INPUT_CSV,'utf8');
  const lines = raw.split(/\r?\n/).filter(l=>l.trim().length>0);
  if (!lines.length){
    console.log('No rows in CSV.');
    return;
  }

  // crude CSV split (works with your export; if commas inside fields ever appear, we can switch back to csv-parse)
  const header = lines[0].split(',');
  const idx = (name)=> header.findIndex(h => clean(h).toLowerCase() === String(name).toLowerCase());
  const iLocation = idx('Location:');
  const iFacility = idx('Facility');
  const iTime     = idx('Reserved Time');
  const iReservee = idx('Reservee');
  const iPurpose  = idx('Reservation Purpose');

  const courtMode = isCourtSeason(new Date());

  // First pass → items
  const items = [];
  for (let i=1;i<lines.length;i++){
    const row = lines[i].split(',');

    const location = clean(row[iLocation] ?? '');
    const facility = clean(row[iFacility] ?? '');
    const timeText = clean(row[iTime] ?? '');
    const reservee = clean(row[iReservee] ?? '');
    const purpose  = clean(row[iPurpose] ?? '');

    if (!facility || !timeText) continue;
    if (location && !/athletic\s*&\s*event\s*center/i.test(location)) continue;

    // remove system/turf noise
    if (courtMode && /fieldhouse.*turf/i.test(facility)) continue;

    const range = parseRange(timeText);
    if (!range) continue;

    const rooms = mapFacilityToRooms(facility);
    if (!rooms.length) continue;

    // normalize who/title
    const who = normalizeReservee(reservee);
    const pur = cleanPurpose(purpose);

    let title='', subtitle='', org='', contact='';
    if (isPickleball(purpose, reservee)) {
      title = 'Open Pickleball'; subtitle = ''; org='Open Pickleball';
    } else if (who.kind === 'person') {
      title = who.person; subtitle = pur; org = who.person;
    } else if (who.kind === 'org+contact') {
      title = who.org; subtitle = pur || who.contact; org = who.org; contact = who.contact;
    } else { // org
      title = who.org || 'Reservation'; subtitle = pur; org = who.org || '';
    }

    // Drop obvious holds/noise
    const low = (title + ' ' + subtitle).toLowerCase();
    if (low.includes('raec front desk')) continue;
    if (low.includes('turf install per nm')) continue;
    if (low.includes('internal hold per nm')) continue;

    items.push({
      rooms, startMin: range.startMin, endMin: range.endMin,
      title, subtitle, org, contact,
      rawFacility: facility,
      whoRaw: reservee
    });
  }

  // -------- second pass: keep MOST-SPECIFIC rooms per org/time group ----------
  // Group key: normalized org/person (title) + exact time window
  const groups = new Map(); // key -> array of items
  for (const it of items){
    const key = `${(it.org||it.title||'').toLowerCase()}__${it.startMin}-${it.endMin}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(it);
  }

  const kept = [];
  for (const [, arr] of groups){
    // remove umbrella items: drop any item whose room-set is a SUPerset of another item’s room-set
    const keepFlags = arr.map(()=>true);
    const sets = arr.map(it => new Set(it.rooms));
    for (let i=0;i<arr.length;i++){
      if (!keepFlags[i]) continue;
      for (let j=0;j<arr.length;j++){
        if (i===j || !keepFlags[j]) continue;
        // if arr[i] is a superset of arr[j] → drop i
        const A = sets[i], B = sets[j];
        let isSuperset = true;
        for (const b of B){ if (!A.has(b)) { isSuperset = false; break; } }
        if (isSuperset && A.size > B.size){
          keepFlags[i] = false;
          break;
        }
      }
    }
    for (let i=0;i<arr.length;i++){
      if (keepFlags[i]) kept.push(arr[i]);
    }
  }

  // Expand to final slots (each specific room makes a slot)
  const slots = [];
  for (const it of kept){
    for (const r of it.rooms){
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

  // Final JSON
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

  fs.writeFileSync(OUTPUT_JSON, JSON.stringify(json,null,2));
  console.log(`events.json written: slots=${slots.length}`);
}

main().catch(err => {
  console.error('transform.mjs failed:', err);
  process.exit(1);
});
