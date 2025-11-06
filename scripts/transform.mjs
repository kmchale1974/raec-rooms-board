#!/usr/bin/env node
// RAEC transform: prefer explicit half-court rows over AB/Full/Championship expansions.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parse } from 'csv-parse/sync';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const INPUT_CSV   = process.env.IN_CSV   || path.join(__dirname, '..', 'data', 'inbox', 'latest.csv');
const OUTPUT_JSON = process.env.OUT_JSON || path.join(__dirname, '..', 'events.json');

/* ----------------- utils ----------------- */
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const lc = (s) => clean(s).toLowerCase();

function toMin(hhmm) {
  const m = String(hhmm).trim().toLowerCase().match(/^(\d{1,2}):(\d{2})\s*([ap])m$/);
  if (!m) return null;
  let h = parseInt(m[1],10), min = parseInt(m[2],10);
  if (h === 12) h = 0;
  if (m[3] === 'p') h += 12;
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

// "Last, First" -> "First Last" for simple people
function normalizePersonName(reserveeRaw) {
  const s = clean(reserveeRaw);
  const m = s.match(/^\s*([A-Za-z'.-]+)\s*,\s*([A-Za-z'.-]+)\s*$/);
  return m ? `${m[2]} ${m[1]}` : s;
}

// drop only real system rows; keep "Internal Holds" (Catch Corner etc.)
function isSystemDrop(reservee, purpose) {
  const r = lc(reservee);
  const p = lc(purpose);
  if (r.includes('raec front desk')) return true;
  if (p.includes('turf install')) return true;
  return false;
}

function makeDisplay(reservee, purpose) {
  const rRaw = clean(reservee);
  const pRaw = clean(purpose);

  // Pickleball normalizer
  if (/pickleball/i.test(rRaw) || /pickleball/i.test(pRaw)) {
    return { title: 'Open Pickleball', subtitle: '', org: 'Open Pickleball', contact: '' };
  }

  // Org + contact like "Empower Volleyball (Rec), Dean Baxendale"
  if (rRaw.includes(',')) {
    const left  = rRaw.split(',')[0].trim();
    const right = rRaw.split(',').slice(1).join(',').trim();
    if (/\b(Volleyball|Club|Academy|Athletics|Sports|United|Elite|Training|Catch Corner|High School|HS|SPED|School)\b/i.test(left)) {
      return { title: left, subtitle: pRaw, org: left, contact: right };
    }
  }

  // person fallback
  const maybePerson = normalizePersonName(rRaw);
  if (/\s/.test(maybePerson) &&
      !/\b(Volleyball|Club|Academy|Athletics|Sports|United|Elite|Training|Catch Corner|High School|HS|SPED|School)\b/i.test(maybePerson)) {
    return { title: maybePerson, subtitle: pRaw, org: maybePerson, contact: '' };
  }
  return { title: maybePerson, subtitle: pRaw, org: maybePerson, contact: '' };
}

/* ----------------- facility classifier -----------------
   We DO NOT expand AB/Full/Champ here. We record tokens and whether a row is an explicit half.
   South tokens: S1A,S1B,S2A,S2B (explicit halves), S1PAIR,S2PAIR, SALL, SCHAMP
   North tokens: N9A,N9B,N10A,N10B (explicit halves), N9PAIR,N10PAIR, NALL
   Fieldhouse: explicit court numbers '3'..'8' (no implied).
-------------------------------------------------------- */
function classifyFacility(facility) {
  const f = lc(facility);

  // --- South ---
  if (f === 'ac gym - half court 1a') return { tokens: ['S1A'], explicitHalf: true };
  if (f === 'ac gym - half court 1b') return { tokens: ['S1B'], explicitHalf: true };
  if (f === 'ac gym - court 1-ab')    return { tokens: ['S1PAIR'], explicitHalf: false };

  if (f === 'ac gym - half court 2a') return { tokens: ['S2A'], explicitHalf: true };
  if (f === 'ac gym - half court 2b') return { tokens: ['S2B'], explicitHalf: true };
  if (f === 'ac gym - court 2-ab')    return { tokens: ['S2PAIR'], explicitHalf: false };

  if (f.includes('full gym 1ab & 2ab')) return { tokens: ['SALL'],   explicitHalf: false };
  if (f.includes('championship court'))  return { tokens: ['SCHAMP'], explicitHalf: false };

  // --- North ---
  if (f === 'ac gym - half court 9a')  return { tokens: ['N9A'],  explicitHalf: true };
  if (f === 'ac gym - half court 9b')  return { tokens: ['N9B'],  explicitHalf: true };
  if (f === 'ac gym - court 9-ab')     return { tokens: ['N9PAIR'], explicitHalf: false };

  if (f === 'ac gym - half court 10a') return { tokens: ['N10A'], explicitHalf: true };
  if (f === 'ac gym - half court 10b') return { tokens: ['N10B'], explicitHalf: true };
  if (f === 'ac gym - court 10-ab')    return { tokens: ['N10PAIR'], explicitHalf: false };

  if (f.includes('full gym 9 & 10'))   return { tokens: ['NALL'], explicitHalf: false };

  // --- Fieldhouse 3..8 ---
  const m = clean(facility).match(/^AC Fieldhouse - Court\s*([3-8])$/i);
  if (m) return { tokens: [m[1]], explicitHalf: true }; // treat as explicit

  if (f === 'ac fieldhouse - court 3-8')       return { tokens: ['3','4','5','6','7','8'], explicitHalf: true };
  if (f === 'ac fieldhouse - full turf')       return { tokens: ['3','4','5','6','7','8'], explicitHalf: false };
  if (f === 'ac fieldhouse - half turf north') return { tokens: ['6','7','8'], explicitHalf: false };
  if (f === 'ac fieldhouse - half turf south') return { tokens: ['3','4','5'], explicitHalf: false };

  return { tokens: [], explicitHalf: false };
}

/* ----------------- side resolver -----------------
   Given the union of tokens for a time block + reservee/purpose:
   - If any explicit south halves present, keep only those halves (ignore S1PAIR,S2PAIR,SALL,SCHAMP)
   - Else expand as indicated by pairs/full/champ
   Same for north.
-------------------------------------------------- */
function resolveRoomsFromTokens(tokenSet) {
  const t = tokenSet; // Set<string>

  // South
  const southExplicit = [];
  if (t.has('S1A')) southExplicit.push('1A');
  if (t.has('S1B')) southExplicit.push('1B');
  if (t.has('S2A')) southExplicit.push('2A');
  if (t.has('S2B')) southExplicit.push('2B');

  const southFinal = [];
  if (southExplicit.length) {
    southFinal.push(...southExplicit);
  } else {
    if (t.has('S1PAIR')) southFinal.push('1A','1B');
    if (t.has('S2PAIR')) southFinal.push('2A','2B');
    if (t.has('SALL') || t.has('SCHAMP')) southFinal.push('1A','1B','2A','2B');
  }

  // North
  const northExplicit = [];
  if (t.has('N9A'))  northExplicit.push('9A');
  if (t.has('N9B'))  northExplicit.push('9B');
  if (t.has('N10A')) northExplicit.push('10A');
  if (t.has('N10B')) northExplicit.push('10B');

  const northFinal = [];
  if (northExplicit.length) {
    northFinal.push(...northExplicit);
  } else {
    if (t.has('N9PAIR'))  northFinal.push('9A','9B');
    if (t.has('N10PAIR')) northFinal.push('10A','10B');
    if (t.has('NALL'))    northFinal.push('9A','9B','10A','10B');
  }

  // Fieldhouse (tokens are already explicit court numbers)
  const field = [];
  for (const k of t) {
    if (/^[3-8]$/.test(k)) field.push(k);
  }

  // union and stable sort
  const rooms = Array.from(new Set([...southFinal, ...northFinal, ...field]));
  const order = ['1A','1B','2A','2B','3','4','5','6','7','8','9A','9B','10A','10B'];
  rooms.sort((a,b)=>order.indexOf(a)-order.indexOf(b));
  return rooms;
}

/* ----------------- grouping key ----------------- */
function canon(s) {
  return clean(s).toLowerCase();
}
function groupKey(reservee, purpose, startMin, endMin) {
  // normalize booking numbers so variants group together
  const p = canon(purpose).replace(/#\d{4,}/g, '').replace(/\(booking[^)]*\)/g,'').trim();
  const r = canon(reservee);
  return `${r}|${p}|${startMin}|${endMin}`;
}

/* ----------------- output skeleton ----------------- */
function scaffold() {
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

/* ----------------- main ----------------- */
async function main() {
  if (!fs.existsSync(INPUT_CSV) || fs.statSync(INPUT_CSV).size === 0) {
    fs.writeFileSync(OUTPUT_JSON, JSON.stringify(scaffold(), null, 2));
    console.log('transform: no csv -> scaffold');
    return;
  }

  const raw = fs.readFileSync(INPUT_CSV, 'utf8');
  const rows = parse(raw, { bom: true, skip_empty_lines: true });
  if (!rows.length) {
    fs.writeFileSync(OUTPUT_JSON, JSON.stringify(scaffold(), null, 2));
    console.log('transform: empty rows -> scaffold');
    return;
  }

  const header = rows[0].map(h => lc(h));
  const col = (name) => header.findIndex(h => h === name.toLowerCase());

  const iLocation = col('location:');
  const iFacility = col('facility');
  const iTime     = col('reserved time');
  const iReservee = col('reservee');
  const iPurpose  = col('reservation purpose');

  if (iFacility < 0 || iTime < 0 || iReservee < 0 || iPurpose < 0) {
    fs.writeFileSync(OUTPUT_JSON, JSON.stringify(scaffold(), null, 2));
    console.log('transform: headers missing -> scaffold');
    return;
  }

  const nowMin = nowMinutesLocal();

  // collect kept rows (with tokens; do NOT expand pairs/full yet)
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

    const { tokens } = classifyFacility(facility);
    if (!tokens.length) { dropNoMap++; continue; }

    kept.push({
      reservee, purpose,
      startMin: range.startMin, endMin: range.endMin,
      tokens
    });
  }

  // group by reservee+purpose(time) and resolve with explicit-first logic
  const groups = new Map();
  for (const it of kept) {
    const key = groupKey(it.reservee, it.purpose, it.startMin, it.endMin);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(it);
  }

  const slots = [];
  for (const arr of groups.values()) {
    // union tokens
    const tokenSet = new Set();
    for (const it of arr) for (const tk of it.tokens) tokenSet.add(tk);

    // pick final rooms using explicit-first rules
    const rooms = resolveRoomsFromTokens(tokenSet);
    if (!rooms.length) continue;

    const any = arr[0];
    const { title, subtitle, org, contact } = makeDisplay(any.reservee, any.purpose);

    for (const roomId of rooms) {
      slots.push({ roomId, startMin: any.startMin, endMin: any.endMin, title, subtitle, org, contact });
    }
  }

  // dedup + sort
  const seen = new Set();
  const final = [];
  for (const s of slots) {
    const k = `${s.roomId}|${s.startMin}|${s.endMin}|${s.title}|${s.subtitle}`;
    if (!seen.has(k)) { seen.add(k); final.push(s); }
  }
  final.sort((a,b)=>{
    const order = ['1A','1B','2A','2B','3','4','5','6','7','8','9A','9B','10A','10B'];
    return (order.indexOf(a.roomId) - order.indexOf(b.roomId)) || (a.startMin - b.startMin);
  });

  const out = scaffold();
  out.slots = final;

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
