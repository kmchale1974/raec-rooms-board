#!/usr/bin/env node
// scripts/transform.mjs
// Reads latest CSV -> events.json with RAEC rules (turf/courts, mapping, cleanup)

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ---------- paths ----------
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const INPUT_CSV   = process.env.IN_CSV   || path.join(__dirname, '..', 'data', 'inbox', 'latest.csv');
const OUTPUT_JSON = process.env.OUT_JSON || path.join(__dirname, '..', 'events.json');

// ---------- helpers ----------
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
const clean = s => String(s||'').replace(/\s+/g,' ').trim();

// Season detection from E col strings
function detectSeason(purposes){
  const turfHit  = purposes.some(p => /turf\s*(install|season)\s*per\s*nm/i.test(p));
  const courtHit = purposes.some(p => /fieldhouse\s*installed\s*per\s*nm/i.test(p));
  if (turfHit) return 'turf';
  if (courtHit) return 'courts';
  // fallback by date (Mar→Nov courts) if ambiguous
  const d = new Date();
  const m = d.getMonth(); // 0..11
  return (m>=2 && m<=10) ? 'courts' : 'turf';
}

// Rooms for season
function seasonRooms(season){
  if (season === 'turf') {
    return [
      { id:'Quarter Turf NA', label:'Quarter Turf NA', group:'fieldhouse' },
      { id:'Quarter Turf NB', label:'Quarter Turf NB', group:'fieldhouse' },
      { id:'Quarter Turf SA', label:'Quarter Turf SA', group:'fieldhouse' },
      { id:'Quarter Turf SB', label:'Quarter Turf SB', group:'fieldhouse' },
    ];
  }
  // courts
  return [
    { id:'3', label:'3', group:'fieldhouse' },
    { id:'4', label:'4', group:'fieldhouse' },
    { id:'5', label:'5', group:'fieldhouse' },
    { id:'6', label:'6', group:'fieldhouse' },
    { id:'7', label:'7', group:'fieldhouse' },
    { id:'8', label:'8', group:'fieldhouse' },
  ];
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

// Normalize reservee / title+subtitle decisions
function normalizeName(raw){
  let s = clean(raw);

  // "Org, Org" -> "Org"
  const dup = s.match(/^(.+?),\s*\1\b/i);
  if (dup) s = dup[1].trim();

  // Catch Corner label
  if (/^catch\s*corner/i.test(s)) return 'Catch Corner';

  // Chicago Sport and Social remains as-is (we'll use full purpose for subtitle later)
  // Extreme Volleyball -> collapse duplicates handled already

  // Last, First -> First Last (heuristic)
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

  // Pickleball detection (even if reservee is RAEC Front Desk)
  if (/open\s*pickleball/i.test(subtitle) || /open\s*pickleball/i.test(name)) {
    return { title: 'Open Pickleball', subtitle: '' };
  }

  // Catch Corner → use parentheses content as subtitle if present
  if (/^catch\s*corner/i.test(name)) {
    const m = subtitle.match(/\(([^)]+)\)/);
    if (m && m[1]) subtitle = m[1].trim();
    return { title: 'Catch Corner', subtitle };
  }

  // Chicago Sport and Social Club → keep full purpose as subtitle
  if (/^chicago\s*sport\s*and\s*social\s*club/i.test(name)) {
    return { title: 'Chicago Sport and Social Club', subtitle };
  }

  // Extreme Volleyball → collapse duplicates name already; purpose remains full
  if (/^extreme\s*volleyball/i.test(name)) {
    return { title: 'Extreme Volleyball', subtitle };
  }

  // General cleanup
  subtitle = subtitle
    .replace(/\bInternal Hold per NM\b/ig, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  return { title, subtitle };
}

// Map Facility -> room ids (raw, before specificity collapse)
function mapFacilityToRooms(fac, season){
  const f = clean(fac).toLowerCase();

  // South (1/2)
  if (/^ac gym - half court 1a$/i.test(fac)) return ['1A'];
  if (/^ac gym - half court 1b$/i.test(fac)) return ['1B'];
  if (/^ac gym - court 1-ab$/i.test(fac))    return ['1A','1B'];

  if (/^ac gym - half court 2a$/i.test(fac)) return ['2A'];
  if (/^ac gym - half court 2b$/i.test(fac)) return ['2B'];
  if (/^ac gym - court 2-ab$/i.test(fac))    return ['2A','2B'];

  if (/full gym 1ab\s*&\s*2ab/i.test(fac))   return ['1A','1B','2A','2B'];
  if (/championship court/i.test(fac))       return ['1A','1B','2A','2B'];

  // North (9/10)
  if (/^ac gym - half court 9a$/i.test(fac)) return ['9A'];
  if (/^ac gym - half court 9b$/i.test(fac)) return ['9B'];
  if (/^ac gym - court 9-ab$/i.test(fac))    return ['9A','9B'];

  if (/^ac gym - half court 10a$/i.test(fac)) return ['10A'];
  if (/^ac gym - half court 10b$/i.test(fac)) return ['10B'];
  if (/^ac gym - court 10-ab$/i.test(fac))    return ['10A','10B'];

  if (/full gym 9\s*&\s*10/i.test(fac))       return ['9A','9B','10A','10B'];

  // Fieldhouse
  if (season === 'courts'){
    if (/^ac fieldhouse - court\s*([3-8])$/i.test(fac)) {
      const n = parseInt(RegExp.$1,10);
      return [String(n)];
    }
    if (/^ac fieldhouse - court 3-8$/i.test(fac)) return ['3','4','5','6','7','8'];
    // ignore turf labels during court season
    return [];
  }

  // season === 'turf'
  if (/^ac fieldhouse - full turf$/i.test(fac))        return ['Quarter Turf NA','Quarter Turf NB','Quarter Turf SA','Quarter Turf SB'];
  if (/^ac fieldhouse - half turf north$/i.test(fac))  return ['Quarter Turf NA','Quarter Turf NB'];
  if (/^ac fieldhouse - half turf south$/i.test(fac))  return ['Quarter Turf SA','Quarter Turf SB'];
  if (/^ac fieldhouse - quarter turf na$/i.test(fac))  return ['Quarter Turf NA'];
  if (/^ac fieldhouse - quarter turf nb$/i.test(fac))  return ['Quarter Turf NB'];
  if (/^ac fieldhouse - quarter turf sa$/i.test(fac))  return ['Quarter Turf SA'];
  if (/^ac fieldhouse - quarter turf sb$/i.test(fac))  return ['Quarter Turf SB'];

  return [];
}

// Specific > blanket collapse within South(1/2) and North(9/10) groups
function collapseSpecificsSouthNorth(items){
  const groups = [
    { rooms:['1A','1B','2A','2B'] },
    { rooms:['9A','9B','10A','10B'] }
  ];

  // For each group, drop blanket coverage where a specific (half-court) overlaps for same org/time
  function overlaps(a,b){ return a.startMin < b.endMin && b.startMin < a.endMin; }

  const out = [];

  for (const g of groups){
    const inGroup = items.filter(it => it.rooms.every(r => g.rooms.includes(r)));
    const others  = items.filter(it => !it.rooms.every(r => g.rooms.includes(r)));

    const specifics = inGroup.filter(it => it.rooms.length === 1); // half courts are single
    const blankets  = inGroup.filter(it => it.rooms.length > 1);

    for (const b of blankets){
      const keepRooms = b.rooms.filter(r => {
        const conflict = specifics.some(s =>
          overlaps(s, b) && s.org.toLowerCase() === b.org.toLowerCase() && s.rooms.includes(r)
        );
        return !conflict;
      });
      if (keepRooms.length){
        out.push({ ...b, rooms: keepRooms });
      }
    }
    // push specifics as-is
    out.push(...specifics);
    // keep non-group items
    out.push(...others);
  }

  // De-dup same object that may have been pushed twice
  const seen = new Set();
  const uniq = [];
  for (const it of out){
    const key = `${it.org}|${it.title}|${it.startMin}|${it.endMin}|${it.rooms.join(',')}`;
    if(!seen.has(key)){ seen.add(key); uniq.push(it); }
  }
  return uniq;
}

// ---------- main ----------
function parseCSVSimple(text){
  // The CSV from RAEC appears simple (no embedded quoted commas in the fields we use).
  // We’ll split by line, then simple commas.
  const lines = text.split(/\r?\n/).filter(l=>l.trim().length>0);
  if (!lines.length) return { header:[], rows:[] };
  const header = lines[0].split(',').map(h=>h.trim());
  const rows   = lines.slice(1).map(l => l.split(',').map(v=>v));
  return { header, rows };
}

function idx(header, name){
  const i = header.findIndex(h => h.trim().toLowerCase() === name.toLowerCase());
  return i >= 0 ? i : -1;
}

async function main(){
  if (!fs.existsSync(INPUT_CSV) || fs.statSync(INPUT_CSV).size === 0){
    // empty scaffold
    const json = {
      season: 'courts',
      dayStartMin: 360,
      dayEndMin: 1380,
      rooms: [...baseRooms(), ...seasonRooms('courts')],
      slots: []
    };
    fs.writeFileSync(OUTPUT_JSON, JSON.stringify(json,null,2));
    return;
  }

  const raw = fs.readFileSync(INPUT_CSV, 'utf8');
  const { header, rows } = parseCSVSimple(raw);
  if (!rows.length){
    const json = {
      season: 'courts',
      dayStartMin: 360,
      dayEndMin: 1380,
      rooms: [...baseRooms(), ...seasonRooms('courts')],
      slots: []
    };
    fs.writeFileSync(OUTPUT_JSON, JSON.stringify(json,null,2));
    return;
  }

  const iLocation = idx(header, 'Location:');
  const iFacility = idx(header, 'Facility');
  const iTime     = idx(header, 'Reserved Time');
  const iReservee = idx(header, 'Reservee');
  const iPurpose  = idx(header, 'Reservation Purpose');

  // season by purposes
  const purposes = rows.map(r => clean(r[iPurpose]||''));
  const season = detectSeason(purposes);

  // collect items
  const itemsRaw = [];
  for (const r of rows){
    const location = clean(r[iLocation]||'');
    const facility = clean(r[iFacility]||'');
    const timeTxt  = clean(r[iTime]||'');
    const reservee = clean(r[iReservee]||'');
    const purpose  = clean(r[iPurpose]||'');

    if (!facility || !timeTxt) continue;
    if (location && !/athletic\s*&\s*event\s*center/i.test(location)) continue;

    // ignore internal non-pickleball holds
    const isFrontDesk = /raec\s*front\s*desk/i.test(reservee);
    const isPickleball = /open\s*pickleball/i.test(purpose);
    if (isFrontDesk && !isPickleball) continue;

    const range = parseRange(timeTxt);
    if (!range) continue;

    const rooms = mapFacilityToRooms(facility, season);
    if (!rooms.length) continue;

    const { title, subtitle } = makeTitleSubtitle(reservee, purpose);

    itemsRaw.push({
      rooms,
      startMin: range.startMin,
      endMin:   range.endMin,
      title, subtitle,
      org: normalizeName(reservee)
    });
  }

  // collapse blankets vs specifics for South/North
  const items = collapseSpecificsSouthNorth(itemsRaw);

  // Build final rooms list in the right order
  const roomsOut = [
    ...baseRooms(),
    ...seasonRooms(season)
  ];

  // Convert to slots (roomId entries)
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

  // Sort slots by room then time
  slots.sort((a,b) => (String(a.roomId).localeCompare(String(b.roomId))) || (a.startMin - b.startMin));

  const json = {
    season,
    dayStartMin: 360,
    dayEndMin: 1380,
    rooms: roomsOut,
    slots
  };

  fs.writeFileSync(OUTPUT_JSON, JSON.stringify(json,null,2));

  // quick console stats to aid debugging in Actions
  const byRoom = slots.reduce((acc,s)=>{ acc[s.roomId]=(acc[s.roomId]||0)+1; return acc; },{});
  console.log(`transform: season=${season} • slots=${slots.length} • byRoom=${JSON.stringify(byRoom)}`);
}

main().catch(err => {
  console.error('transform.mjs failed:', err);
  process.exit(1);
});
