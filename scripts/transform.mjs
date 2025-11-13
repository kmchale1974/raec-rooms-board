#!/usr/bin/env node
// scripts/transform.mjs
// Robust CSV -> events.json for RAEC board (handles quoted commas, turf/courts, de-dup blankets)

// ---------- std ----------
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ---------- paths ----------
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const INPUT_CSV   = process.env.IN_CSV   || path.join(__dirname, '..', 'data', 'inbox', 'latest.csv');
const OUTPUT_JSON = process.env.OUT_JSON || path.join(__dirname, '..', 'events.json');

// ---------- utils ----------
const clean = s => String(s ?? '').replace(/\s+/g, ' ').trim();

function toMin(hhmm){
  const m = String(hhmm||'').trim().toLowerCase().match(/^(\d{1,2}):(\d{2})\s*([ap])m$/);
  if(!m) return null;
  let h = parseInt(m[1],10), mi=parseInt(m[2],10);
  if(h===12) h=0;
  if(m[3]==='p') h+=12;
  return h*60+mi;
}
function parseRange(text){
  const m = String(text||'').trim().match(/(\d{1,2}:\d{2}\s*[ap]m)\s*-\s*(\d{1,2}:\d{2}\s*[ap]m)/i);
  if(!m) return null;
  return { startMin: toMin(m[1]), endMin: toMin(m[2]) };
}

// ---------- robust CSV parser (RFC-4180-ish) ----------
function parseCSV(text){
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  const pushField = ()=>{ row.push(field); field = ''; };
  const pushRow   = ()=>{ rows.push(row); row = []; };

  for (let i=0; i<text.length; i++){
    const ch = text[i];

    if (inQuotes){
      if (ch === '"'){
        const peek = text[i+1];
        if (peek === '"'){ field += '"'; i++; } // escaped quote
        else { inQuotes = false; }
      } else {
        field += ch;
      }
    } else {
      if (ch === '"'){ inQuotes = true; }
      else if (ch === ','){ pushField(); }
      else if (ch === '\n'){
        pushField(); pushRow();
      } else if (ch === '\r'){
        const peek = text[i+1];
        if (peek === '\n'){ i++; } // CRLF
        pushField(); pushRow();
      } else {
        field += ch;
      }
    }
  }
  // last field/row
  if (field.length || inQuotes){ pushField(); }
  if (row.length){ pushRow(); }

  if (!rows.length) return { header: [], rows: [] };

  const header = rows[0].map(h => h.trim());
  const body   = rows.slice(1).filter(r => r.some(c => String(c).trim().length));
  return { header, rows: body };
}

function idx(header, name){
  const want = String(name).trim().toLowerCase();
  for (let i=0;i<header.length;i++){
    const h = String(header[i]).trim().toLowerCase();
    if (h === want) return i;
  }
  // tolerate "Location" vs "Location:" etc.
  for (let i=0;i<header.length;i++){
    const h = String(header[i]).trim().toLowerCase().replace(/[:]+$/,'');
    if (h === want.replace(/[:]+$/,'')) return i;
  }
  return -1;
}

// Decide season ONLY from CSV column E (Reservation Purpose)
function detectSeason(purposes) {
  // purposes = array of Reservation Purpose strings
  const isTurf = purposes.some(p =>
    clean(p).toLowerCase() === 'turf season per nm'
  );

  // 'courts' here is your "basketball season"
  return isTurf ? 'turf' : 'courts';
}


function baseRooms(){
  return [
    { id:'1A', label:'1A', group:'south' },
    { id:'1B', label:'1B', group:'south' },
    { id:'2A', label:'2A', group:'south' },
    { id:'2B', label:'2B', group:'south' },
    { id:'9A', label:'9A', group:'north' },
    { id:'9B', label:'9B', group:'north' },
    { id:'10A', label:'10A', group:'north' },
    { id:'10B', label:'10B', group:'north' },
  ];
}
function seasonRooms(season){
  if (season === 'turf'){
    return [
      { id:'Quarter Turf NA', label:'Quarter Turf NA', group:'fieldhouse' },
      { id:'Quarter Turf NB', label:'Quarter Turf NB', group:'fieldhouse' },
      { id:'Quarter Turf SA', label:'Quarter Turf SA', group:'fieldhouse' },
      { id:'Quarter Turf SB', label:'Quarter Turf SB', group:'fieldhouse' },
    ];
  }
  return [
    { id:'3', label:'3', group:'fieldhouse' },
    { id:'4', label:'4', group:'fieldhouse' },
    { id:'5', label:'5', group:'fieldhouse' },
    { id:'6', label:'6', group:'fieldhouse' },
    { id:'7', label:'7', group:'fieldhouse' },
    { id:'8', label:'8', group:'fieldhouse' },
  ];
}

// ---------- name/title/subtitle normalization ----------
function normalizeName(raw){
  let s = clean(raw);

  // "Org, Org" -> "Org"
  const dup = s.match(/^(.+?),\s*\1\b/i);
  if (dup) s = dup[1].trim();

  if (/^catch\s*corner/i.test(s)) return 'Catch Corner';

  // Last, First  ->  First Last (if it looks like a person)
  const lf = s.match(/^([A-Za-z'.-]+),\s*([A-Za-z'.-]+)\b/);
  if (lf && lf[1] && lf[2] && !/volleyball|club|training|academy|united|elite|sports?/i.test(s)) {
    s = `${lf[2]} ${lf[1]}`;
  }

  // Trim dangling "("
  s = s.replace(/\(\s*$/, '').trim();
  return s;
}

function makeTitleSubtitle(reservee, purpose){
  const name = normalizeName(reservee);
  let title = name;
  let subtitle = clean(purpose);

  // Pickleball: detect from Purpose or title
  if (/open\s*pickleball/i.test(subtitle) || /open\s*pickleball/i.test(name)){
    return { title:'Open Pickleball', subtitle:'' };
  }

  // Catch Corner: use parenthetical inner as subtitle if present
  if (/^catch\s*corner/i.test(name)){
    const m = subtitle.match(/\(([^)]+)\)/);
    if (m && m[1]) subtitle = m[1].trim();
    return { title: 'Catch Corner', subtitle };
  }

  // Chicago Sport and Social Club: keep full purpose
  if (/^chicago\s*sport\s*and\s*social\s*club/i.test(name)){
    return { title:'Chicago Sport and Social Club', subtitle };
  }

  // Extreme Volleyball already collapsed above
  if (/^extreme\s*volleyball/i.test(name)){
    return { title:'Extreme Volleyball', subtitle };
  }

  // General cleanup
  subtitle = subtitle
    .replace(/\bInternal Hold per NM\b/ig, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  return { title, subtitle };
}

// ---------- facility -> rooms ----------
function mapFacilityToRooms(fac, season){
  const f = clean(fac);

  // South (1/2)
  if (/^AC Gym - Half Court 1A$/i.test(f)) return ['1A'];
  if (/^AC Gym - Half Court 1B$/i.test(f)) return ['1B'];
  if (/^AC Gym - Court 1-AB$/i.test(f))    return ['1A','1B'];

  if (/^AC Gym - Half Court 2A$/i.test(f)) return ['2A'];
  if (/^AC Gym - Half Court 2B$/i.test(f)) return ['2B'];
  if (/^AC Gym - Court 2-AB$/i.test(f))    return ['2A','2B'];

  if (/Full Gym 1AB\s*&\s*2AB/i.test(f))   return ['1A','1B','2A','2B'];
  if (/Championship Court/i.test(f))       return ['1A','1B','2A','2B'];

  // North (9/10)
  if (/^AC Gym - Half Court 9A$/i.test(f)) return ['9A'];
  if (/^AC Gym - Half Court 9B$/i.test(f)) return ['9B'];
  if (/^AC Gym - Court 9-AB$/i.test(f))    return ['9A','9B'];

  if (/^AC Gym - Half Court 10A$/i.test(f)) return ['10A'];
  if (/^AC Gym - Half Court 10B$/i.test(f)) return ['10B'];
  if (/^AC Gym - Court 10-AB$/i.test(f))    return ['10A','10B'];

  if (/Full Gym 9\s*&\s*10/i.test(f))       return ['9A','9B','10A','10B'];

  // Fieldhouse / Turf
  if (season === 'courts'){
    if (/^AC Fieldhouse - Court\s*([3-8])$/i.test(f)) {
      const n = parseInt(RegExp.$1,10);
      return [String(n)];
    }
    if (/^AC Fieldhouse - Court 3-8$/i.test(f)) return ['3','4','5','6','7','8'];
    return []; // ignore turf labels in court season
  }

  // season === 'turf'
  if (/^AC Fieldhouse - Full Turf$/i.test(f))        return ['Quarter Turf NA','Quarter Turf NB','Quarter Turf SA','Quarter Turf SB'];
  if (/^AC Fieldhouse - Half Turf North$/i.test(f))  return ['Quarter Turf NA','Quarter Turf NB'];
  if (/^AC Fieldhouse - Half Turf South$/i.test(f))  return ['Quarter Turf SA','Quarter Turf SB'];
  if (/^AC Fieldhouse - Quarter Turf NA$/i.test(f))  return ['Quarter Turf NA'];
  if (/^AC Fieldhouse - Quarter Turf NB$/i.test(f))  return ['Quarter Turf NB'];
  if (/^AC Fieldhouse - Quarter Turf SA$/i.test(f))  return ['Quarter Turf SA'];
  if (/^AC Fieldhouse - Quarter Turf SB$/i.test(f))  return ['Quarter Turf SB'];

  return [];
}

// ---------- blankets vs specifics (south/north) ----------
function collapseSpecificsSouthNorth(items){
  const groups = [
    { rooms:['1A','1B','2A','2B'] },
    { rooms:['9A','9B','10A','10B'] }
  ];

  function overlaps(a,b){ return a.startMin < b.endMin && b.startMin < a.endMin; }

  let remainder = items.slice();
  let result = [];

  for (const g of groups){
    const inG  = remainder.filter(it => it.rooms.every(r => g.rooms.includes(r)));
    remainder  = remainder.filter(it => !it.rooms.every(r => g.rooms.includes(r)));

    const specifics = inG.filter(it => it.rooms.length === 1);
    const blankets  = inG.filter(it => it.rooms.length > 1);

    // drop blanket rooms covered by specifics (same org + time overlap)
    for (const b of blankets){
      const keep = b.rooms.filter(r => {
        return !specifics.some(s =>
          s.org.toLowerCase() === b.org.toLowerCase() &&
          s.rooms.includes(r) &&
          overlaps(s, b)
        );
      });
      if (keep.length){
        result.push({ ...b, rooms: keep });
      }
    }
    result.push(...specifics);
  }
  result.push(...remainder);

  // de-dup identical entries
  const seen = new Set();
  const out = [];
  for (const it of result){
    const key = `${it.org}|${it.title}|${it.startMin}|${it.endMin}|${it.rooms.join(',')}`;
    if (!seen.has(key)){ seen.add(key); out.push(it); }
  }
  return out;
}

// ---------- main ----------
async function main(){
  // empty scaffold if no CSV
  const scaffold = (season='courts') => ({
    season,
    dayStartMin: 360,
    dayEndMin: 1380,
    rooms: [...baseRooms(), ...seasonRooms(season)],
    slots: []
  });

  if (!fs.existsSync(INPUT_CSV) || fs.statSync(INPUT_CSV).size === 0){
    fs.writeFileSync(OUTPUT_JSON, JSON.stringify(scaffold('courts'), null, 2));
    console.log('transform: no CSV');
    return;
  }

  const raw = fs.readFileSync(INPUT_CSV, 'utf8');
  const { header, rows } = parseCSV(raw);

  if (!rows.length){
    fs.writeFileSync(OUTPUT_JSON, JSON.stringify(scaffold('courts'), null, 2));
    console.log('transform: empty rows');
    return;
  }

  const iLocation = idx(header, 'Location:') !== -1 ? idx(header, 'Location:') : idx(header, 'Location');
  const iFacility = idx(header, 'Facility');
  const iTime     = idx(header, 'Reserved Time');
  const iReservee = idx(header, 'Reservee');
  const iPurpose  = idx(header, 'Reservation Purpose');

  if ([iFacility,iTime,iReservee,iPurpose].some(i => i===-1)){
    fs.writeFileSync(OUTPUT_JSON, JSON.stringify(scaffold('courts'), null, 2));
    console.log('transform: header mismatch', { header });
    return;
  }

  const purposesAll = rows.map(r => clean(r[iPurpose]||''));
  const season = detectSeason(purposesAll);

  const itemsRaw = [];
  const drop = { nonRAEC:0, noFacility:0, noTime:0, internal:0, noMap:0 };

  for (const r of rows){
    const location = clean(r[iLocation] ?? '');
    const facility = clean(r[iFacility] ?? '');
    const timeTxt  = clean(r[iTime]     ?? '');
    const reservee = clean(r[iReservee] ?? '');
    const purpose  = clean(r[iPurpose]  ?? '');

    if (!facility){ drop.noFacility++; continue; }
    if (!timeTxt){  drop.noTime++;     continue; }

    if (location && !/athletic\s*&\s*event\s*center/i.test(location)){
      drop.nonRAEC++; continue;
    }

    // internal holds: keep only if it's pickleball
    const isFrontDesk  = /raec\s*front\s*desk/i.test(reservee);
    const isPickleball = /open\s*pickleball/i.test(purpose);
    if (isFrontDesk && !isPickleball){ drop.internal++; continue; }

    const range = parseRange(timeTxt);
    if (!range) { drop.noTime++; continue; }

    const rooms = mapFacilityToRooms(facility, season);
    if (!rooms.length){ drop.noMap++; continue; }

    const { title, subtitle } = makeTitleSubtitle(reservee, purpose);

    itemsRaw.push({
      rooms,
      startMin: range.startMin,
      endMin:   range.endMin,
      title,
      subtitle,
      org: normalizeName(reservee),
    });
  }

  const items = collapseSpecificsSouthNorth(itemsRaw);

  const roomsOut = [...baseRooms(), ...seasonRooms(season)];
  const slots = [];
  for (const it of items){
    for (const roomId of it.rooms){
      slots.push({
        roomId,
        startMin: it.startMin,
        endMin: it.endMin,
        title: it.title,
        subtitle: it.subtitle
      });
    }
  }

  // sort for stable output
  slots.sort((a,b) => (String(a.roomId).localeCompare(String(b.roomId))) || (a.startMin - b.startMin));

  const json = {
    season,
    dayStartMin: 360,
    dayEndMin: 1380,
    rooms: roomsOut,
    slots
  };

  fs.writeFileSync(OUTPUT_JSON, JSON.stringify(json, null, 2));

  const byRoom = slots.reduce((acc,s)=>{ acc[s.roomId]=(acc[s.roomId]||0)+1; return acc; },{});
  console.log(`transform: season=${season} • rows=${rows.length} • kept=${items.length} • slots=${slots.length} • drop=${JSON.stringify(drop)} • byRoom=${JSON.stringify(byRoom)}`);
}

main().catch(err => {
  console.error('transform.mjs failed:', err);
  process.exit(1);
});
