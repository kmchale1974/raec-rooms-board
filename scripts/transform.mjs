// scripts/transform.mjs
// ESM. No external CSV lib; includes a simple CSV parser.
// Usage in CI: `node scripts/transform.mjs`
// Reads:  data/inbox/latest.csv
// Writes: events.json

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const IN_CSV  = process.env.CSV_PATH   || path.join(__dirname, '..', 'data', 'inbox', 'latest.csv');
const OUT_JSON= process.env.JSON_OUT   || path.join(__dirname, '..', 'events.json');

// --- helpers ---------------------------------------------------------------

function trim(s){ return (s ?? '').toString().trim(); }

// very small CSV parser that handles quotes + commas
function parseCSV(text){
  const rows = [];
  let row = [];
  let cur = '';
  let inQ = false;

  for (let i=0;i<text.length;i++){
    const ch = text[i];
    if (inQ){
      if (ch === '"'){
        if (text[i+1] === '"'){ cur += '"'; i++; }
        else { inQ = false; }
      } else {
        cur += ch;
      }
    } else {
      if (ch === '"'){ inQ = true; }
      else if (ch === ','){ row.push(cur); cur = ''; }
      else if (ch === '\n'){
        row.push(cur); cur = '';
        rows.push(row); row = [];
      } else if (ch === '\r'){
        // ignore, handle on \n
      } else {
        cur += ch;
      }
    }
  }
  // last field
  if (cur.length || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

function parseTimeRange(s){
  // "9:30am - 12:30pm" or "4:00pm -  7:00pm" (note double spaces sometimes)
  const m = trim(s).match(/(\d{1,2}:\d{2}\s*[ap]m)\s*-\s*(\d{1,2}:\d{2}\s*[ap]m)/i);
  if (!m) return null;
  return [toMin(m[1]), toMin(m[2])];
}
function toMin(label){
  // "4:30pm" → minutes since midnight
  const t = trim(label).toLowerCase();
  const m = t.match(/(\d{1,2}):(\d{2})\s*([ap]m)/);
  if (!m) return null;
  let h = parseInt(m[1],10);
  const mm = parseInt(m[2],10);
  const ap = m[3];
  if (ap === 'pm' && h !== 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  return h*60 + mm;
}

// business logic: turf vs basketball in fieldhouse (yearly)
function nthWeekdayOfMonth(year, month /*0-11*/, weekday /*0=Sun*/, n){
  const d = new Date(year, month, 1);
  const offset = (7 + weekday - d.getDay()) % 7;
  const day = 1 + offset + (n-1)*7;
  return new Date(year, month, day);
}
function isTurfSeason(d){
  const y = d.getFullYear();
  const secondMonNov = nthWeekdayOfMonth(y, 10, 1, 2);    // Nov, Monday, 2nd
  const thirdMonMar  = nthWeekdayOfMonth(y+1, 2, 1, 3);   // Next year March, Monday, 3rd

  // Turf from 2nd Mon Nov until 3rd Mon Mar (exclusive)
  // If date >= Nov cutoff, it's turf season; else if < Mar cutoff, also turf.
  const novCutoff = secondMonNov;
  const marCutoff = thirdMonMar;
  if (d >= novCutoff) return true;
  const jan1 = new Date(y, 0, 1);
  if (d >= jan1 && d < marCutoff) return true;
  return false;
}

// normalize reservee wording
function normalizePickleball(title, purpose){
  const t = (title||'').toLowerCase();
  const p = (purpose||'').toLowerCase();
  if (t.includes('raec front desk') || t.includes('on hold')){
    if (p.includes('open pickleball')) return 'Open Pickleball';
  }
  return null;
}

// collapse "Name, Name" to "Name"
function cleanName(s){
  if (!s) return '';
  const parts = s.split(',').map(p=>p.trim()).filter(Boolean);
  if (parts.length>=2 && parts[0].toLowerCase()===parts[1].toLowerCase()) return parts[0];
  return s;
}

// map facility → room id(s) (numbers only UI: 1..10)
function mapFacilityToRooms(facility, todayIsTurf){
  const f = (facility||'').toLowerCase();

  // South Gym (always)
  if (f.includes('ac gym - half court 1a') || f.includes('ac gym - court 1-ab') || f.includes('full gym 1ab & 2ab') || f.includes('championship court')){
    return ['1','2']; // champ court equals 1 & 2; full gym 1&2 too.
  }
  if (f.includes('ac gym - half court 1b')) return ['1'];
  if (f.includes('ac gym - half court 2a') || f.includes('ac gym - court 2-ab')) return ['2'];
  if (f.includes('ac gym - half court 2b')) return ['2'];

  // North Gym (always)
  if (f.includes('ac gym - half court 9a') || f.includes('ac gym - court 9-ab')) return ['9'];
  if (f.includes('ac gym - half court 9b')) return ['9'];
  if (f.includes('ac gym - half court 10a') || f.includes('ac gym - court 10-ab')) return ['10'];
  if (f.includes('ac gym - half court 10b')) return ['10'];
  if (f.includes('full gym 9 & 10')) return ['9','10'];

  // Fieldhouse
  if (!todayIsTurf){
    // Basketball season → courts 3..8
    if (f.includes('fieldhouse court 3-8')) return ['3','4','5','6','7','8'];
    const m = f.match(/fieldhouse\s*-\s*court\s*(\d+)/i);
    if (m){
      const n = parseInt(m[1],10);
      if (n>=3 && n<=8) return [String(n)];
    }
    // Ignore turf descriptors during court season
    if (f.includes('fieldhouse - full turf') ||
        f.includes('half turf') ||
        f.includes('quarter turf')){
      return []; // ignored out of season
    }
  } else {
    // Turf season: keep turf descriptors
    if (f.includes('fieldhouse - full turf')) return ['3','4','5','6','7','8']; // show across all six
    if (f.includes('half turf north')) return ['6','7','8'];
    if (f.includes('half turf south')) return ['3','4','5'];
    if (f.includes('quarter turf')){
      // map NA/NB = 6/7 ; SA/SB = 4/5 (or similar) – tweak as needed
      if (f.includes('na')) return ['6'];
      if (f.includes('nb')) return ['7'];
      if (f.includes('sa')) return ['4'];
      if (f.includes('sb')) return ['5'];
      return [];
    }
    const m = f.match(/fieldhouse\s*-\s*court\s*(\d+)/i);
    if (m){
      const n = parseInt(m[1],10);
      if (n>=3 && n<=8) return [String(n)];
    }
  }

  return [];
}

// --- main transform --------------------------------------------------------

async function main(){
  let csvRaw = '';
  try {
    csvRaw = await fs.readFile(IN_CSV, 'utf8');
  } catch (e){
    console.log('No CSV found; writing empty scaffold.');
    await writeOut({ rooms: defaultRooms(), slots: [] });
    return;
  }

  const rows = parseCSV(csvRaw);
  if (!rows.length){
    console.log('Empty CSV; writing empty scaffold.');
    await writeOut({ rooms: defaultRooms(), slots: [] });
    return;
  }

  // header detection
  const header = rows[0].map(h => trim(h).toLowerCase());
  const idx = {
    location: header.findIndex(h => h.startsWith('location')),
    facility: header.findIndex(h => h.startsWith('facility')),
    time:     header.findIndex(h => h.startsWith('reserved time')),
    reservee: header.findIndex(h => h.startsWith('reservee')),
    purpose:  header.findIndex(h => h.startsWith('reservation purpose')),
    headcnt:  header.findIndex(h => h.startsWith('headcount')),
  };

  const today = new Date();
  const turf = isTurfSeason(today);

  // Parse rows -> raw events
  const raw = [];
  for (let i=1;i<rows.length;i++){
    const r = rows[i];
    if (!r || !r.length) continue;

    const loc = trim(r[idx.location] ?? '');
    // Only care about the Athletic & Event Center (drop others)
    if (loc && !/^athletic\s*&\s*event\s*center$/i.test(loc)) continue;

    const facility = trim(r[idx.facility] ?? '');
    const time = trim(r[idx.time] ?? '');
    const reservee = trim(r[idx.reservee] ?? '');
    const purpose  = trim(r[idx.purpose] ?? '');

    const t = parseTimeRange(time);
    if (!t) continue;
    const [startMin, endMin] = t;

    let title = cleanName(reservee);
    const pb = normalizePickleball(reservee, purpose);
    if (pb) title = pb;

    const rooms = mapFacilityToRooms(facility, turf);
    if (!rooms.length) continue;

    raw.push({ rooms, startMin, endMin, title, purpose, facility });
  }

  // --- Fieldhouse “3-8” disambiguation (basketball season only) ------------
  let processed = [];
  if (!turf){
    // Build explicit court map by (reservee/time)
    const keyOf = (ev)=> `${ev.title}|${ev.startMin}|${ev.endMin}`;
    const explicitByKey = new Map();   // key -> Set(room)
    const allKeysAtWindow = new Map(); // "start|end" -> Map(title -> Set(room))

    for (const ev of raw){
      const isExact = ev.rooms.length===1 && ['3','4','5','6','7','8'].includes(ev.rooms[0]);
      if (isExact){
        const k = keyOf(ev);
        if (!explicitByKey.has(k)) explicitByKey.set(k, new Set());
        explicitByKey.get(k).add(ev.rooms[0]);

        const win = `${ev.startMin}|${ev.endMin}`;
        if (!allKeysAtWindow.has(win)) allKeysAtWindow.set(win, new Map());
        const m = allKeysAtWindow.get(win);
        if (!m.has(ev.title)) m.set(ev.title, new Set());
        m.get(ev.title).add(ev.rooms[0]);
      }
    }

    for (const ev of raw){
      const isRange = ev.rooms.length===6 && ev.rooms.every(x => ['3','4','5','6','7','8'].includes(x));
      if (!isRange){
        processed.push(ev);
        continue;
      }
      // If explicit courts exist for same title + time → use only those
      const k = keyOf(ev);
      const exp = explicitByKey.get(k);
      if (exp && exp.size){
        processed.push({ ...ev, rooms: Array.from(exp).sort() });
        continue;
      }

      // Otherwise, see if other orgs at same window grabbed explicit courts;
      // assign remainder to this org if it’s the only range holder.
      const win = `${ev.startMin}|${ev.endMin}`;
      const m = allKeysAtWindow.get(win); // Map(title -> Set(courts))
      if (m && m.size){
        const taken = new Set();
        for (const [t,_set] of m) for (const c of _set) taken.add(c);
        const all = new Set(['3','4','5','6','7','8']);
        for (const c of taken) all.delete(c);

        // If there’s only one range org at this window, give them remaining courts
        const rangeCount = raw.filter(x =>
          x !== ev &&
          x.rooms.length===6 &&
          x.startMin===ev.startMin &&
          x.endMin===ev.endMin
        ).length + 1; // include current

        if (rangeCount === 1 && all.size){
          processed.push({ ...ev, rooms: Array.from(all).sort() });
          continue;
        }
      }

      // fallback: keep full 3–8
      processed.push(ev);
    }
  } else {
    processed = raw;
  }

  // --- Expand per-room events; dedupe identical slots ----------------------
  const outSlots = [];
  const seen = new Set();
  for (const ev of processed){
    for (const room of ev.rooms){
      const sub = ev.purpose ? ` ${ev.purpose}` : '';
      const key = `${room}|${ev.startMin}|${ev.endMin}|${ev.title}|${ev.purpose||''}`;
      if (seen.has(key)) continue;
      seen.add(key);

      outSlots.push({
        roomId: room,
        startMin: ev.startMin,
        endMin: ev.endMin,
        title: ev.title,
        subtitle: ev.purpose ? ev.purpose : ''
      });
    }
  }

  // Sort by room then time
  outSlots.sort((a,b)=> (Number(a.roomId)-Number(b.roomId)) || (a.startMin-b.startMin));

  const out = {
    dayStartMin: 360,
    dayEndMin: 1380,
    rooms: defaultRooms(),
    slots: outSlots
  };

  await writeOut(out);
  console.log(`Wrote events.json • rooms=${out.rooms.length} • slots=${out.slots.length}`);
}

function defaultRooms(){
  return [
    { id:'1',  label:'1',  group:'south' },
    { id:'2',  label:'2',  group:'south' },
    { id:'3',  label:'3',  group:'fieldhouse' },
    { id:'4',  label:'4',  group:'fieldhouse' },
    { id:'5',  label:'5',  group:'fieldhouse' },
    { id:'6',  label:'6',  group:'fieldhouse' },
    { id:'7',  label:'7',  group:'fieldhouse' },
    { id:'8',  label:'8',  group:'fieldhouse' },
    { id:'9',  label:'9',  group:'north' },
    { id:'10', label:'10', group:'north' }
  ];
}

async function writeOut(obj){
  await fs.writeFile(OUT_JSON, JSON.stringify(obj, null, 2), 'utf8');
}

// run
main().catch(err=>{
  console.error('transform failed:', err);
  process.exit(1);
});
