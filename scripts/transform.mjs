#!/usr/bin/env node
// RAEC transform with Fieldhouse auto-mode (turf vs courts) and correct quarter/court mapping.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parse } from 'csv-parse/sync';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const INPUT_CSV   = process.env.IN_CSV   || path.join(__dirname, '..', 'data', 'inbox', 'latest.csv');
const OUTPUT_JSON = process.env.OUT_JSON || path.join(__dirname, '..', 'events.json');

// --------------- helpers ---------------
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

// “Last, First” → “First Last”
function normalizePersonName(reserveeRaw) {
  const s = clean(reserveeRaw);
  const m = s.match(/^\s*([A-Za-z'.-]+)\s*,\s*([A-Za-z'.-]+)\s*$/);
  return m ? `${m[2]} ${m[1]}` : s;
}

// Drop true system placeholders; we still use them for mode detection.
function isSystemDrop(reservee, purpose) {
  const r = lc(reservee);
  const p = lc(purpose);
  if (r.includes('raec front desk')) return true;
  if (p.includes('turf install per nm')) return true;
  if (p.includes('fieldhouse installed per nm')) return true;
  return false;
}

function makeDisplay(reservee, purpose) {
  const rRaw = clean(reservee);
  const pRaw = clean(purpose);

  // Pickleball normalization
  if (/pickleball/i.test(rRaw) || /pickleball/i.test(pRaw)) {
    return { title: 'Open Pickleball', subtitle: '', org: 'Open Pickleball', contact: '' };
  }

  // Org , Contact → show org as title, purpose as subtitle
  if (rRaw.includes(',')) {
    const left  = rRaw.split(',')[0].trim();
    const right = rRaw.split(',').slice(1).join(',').trim();
    if (/\b(Volleyball|Club|Academy|Athletics|Sports|United|Elite|Training|Catch Corner|High School|HS|SPED|School)\b/i.test(left)) {
      return { title: left, subtitle: pRaw, org: left, contact: right };
    }
  }

  // Person fallback
  const maybePerson = normalizePersonName(rRaw);
  if (/\s/.test(maybePerson) &&
      !/\b(Volleyball|Club|Academy|Athletics|Sports|United|Elite|Training|Catch Corner|High School|HS|SPED|School)\b/i.test(maybePerson)) {
    return { title: maybePerson, subtitle: pRaw, org: maybePerson, contact: '' };
  }
  return { title: maybePerson, subtitle: pRaw, org: maybePerson, contact: '' };
}

// --------------- Fieldhouse mode detection ---------------
function detectFieldhouseMode(allRows, iFacility, iPurpose) {
  let seenTurfInstall = false;
  let seenFieldInstalled = false;

  for (let r = 1; r < allRows.length; r++) {
    const rec = allRows[r];
    const facility = clean(rec[iFacility] ?? '');
    const purpose  = clean(rec[iPurpose] ?? '');

    if (/ac fieldhouse - full turf/i.test(facility) && /turf install per nm/i.test(purpose)) {
      seenTurfInstall = true;
    }
    if (/ac fieldhouse - full turf/i.test(facility) && /fieldhouse installed per nm/i.test(purpose)) {
      seenFieldInstalled = true;
    }
  }
  // If both appear, prefer turf (more current/explicit signal).
  if (seenTurfInstall) return 'turf';
  if (seenFieldInstalled) return 'court';
  // Default to court if nothing is present
  return 'court';
}

// --------------- facility → tokens depending on mode ---------------
function classifyFacility(facility, mode /* 'turf' | 'court' */) {
  const f = lc(facility);

  // South
  if (f === 'ac gym - half court 1a') return { tokens: ['S1A'], explicitHalf: true };
  if (f === 'ac gym - half court 1b') return { tokens: ['S1B'], explicitHalf: true };
  if (f === 'ac gym - court 1-ab')    return { tokens: ['S1PAIR'], explicitHalf: false };

  if (f === 'ac gym - half court 2a') return { tokens: ['S2A'], explicitHalf: true };
  if (f === 'ac gym - half court 2b') return { tokens: ['S2B'], explicitHalf: true };
  if (f === 'ac gym - court 2-ab')    return { tokens: ['S2PAIR'], explicitHalf: false };

  if (f.includes('full gym 1ab & 2ab')) return { tokens: ['SALL'],   explicitHalf: false };
  if (f.includes('championship court'))  return { tokens: ['SCHAMP'], explicitHalf: false };

  // North
  if (f === 'ac gym - half court 9a')  return { tokens: ['N9A'],  explicitHalf: true };
  if (f === 'ac gym - half court 9b')  return { tokens: ['N9B'],  explicitHalf: true };
  if (f === 'ac gym - court 9-ab')     return { tokens: ['N9PAIR'], explicitHalf: false };

  if (f === 'ac gym - half court 10a') return { tokens: ['N10A'], explicitHalf: true };
  if (f === 'ac gym - half court 10b') return { tokens: ['N10B'], explicitHalf: true };
  if (f === 'ac gym - court 10-ab')    return { tokens: ['N10PAIR'], explicitHalf: false };

  if (f.includes('full gym 9 & 10'))   return { tokens: ['NALL'], explicitHalf: false };

  // Fieldhouse (mode-sensitive)
  if (mode === 'court') {
    // Courts 3..8
    const m = clean(facility).match(/^AC Fieldhouse - Court\s*([3-8])$/i);
    if (m) return { tokens: [m[1]], explicitHalf: true };
    if (f === 'ac fieldhouse - court 3-8') return { tokens: ['3','4','5','6','7','8'], explicitHalf: true };

    // Any turf-labeled entries (Full/Half/Quarter) are system/holds in court mode → no tokens
    if (f.startsWith('ac fieldhouse - full turf'))       return { tokens: [], explicitHalf: false };
    if (f.startsWith('ac fieldhouse - half turf north')) return { tokens: [], explicitHalf: false };
    if (f.startsWith('ac fieldhouse - half turf south')) return { tokens: [], explicitHalf: false };
    if (f.startsWith('ac fieldhouse - quarter turf'))    return { tokens: [], explicitHalf: false };

  } else {
    // TURF mode: quarters map to QSA,QSB,QNA,QNB
    if (f === 'ac fieldhouse - full turf')       return { tokens: ['QSA','QSB','QNA','QNB'], explicitHalf: true };
    if (f === 'ac fieldhouse - half turf north') return { tokens: ['QNA','QNB'], explicitHalf: true };
    if (f === 'ac fieldhouse - half turf south') return { tokens: ['QSA','QSB'], explicitHalf: true };

    if (f === 'ac fieldhouse - quarter turf sa') return { tokens: ['QSA'], explicitHalf: true };
    if (f === 'ac fieldhouse - quarter turf sb') return { tokens: ['QSB'], explicitHalf: true };
    if (f === 'ac fieldhouse - quarter turf na') return { tokens: ['QNA'], explicitHalf: true };
    if (f === 'ac fieldhouse - quarter turf nb') return { tokens: ['QNB'], explicitHalf: true };

    // “Court 3-8” rows in turf mode are system rows used by RecTrac to signal reconfig → ignore
    if (f === 'ac fieldhouse - court 3-8')       return { tokens: [], explicitHalf: false };
    const mCourt = clean(facility).match(/^AC Fieldhouse - Court\s*([3-8])$/i);
    if (mCourt) return { tokens: [], explicitHalf: false };
  }

  return { tokens: [], explicitHalf: false };
}

function resolveRoomsFromTokens(tokenSet, mode) {
  const t = tokenSet;

  // South explicit halves first
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

  // North explicit halves first
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

  // Fieldhouse based on mode
  const field = [];
  if (mode === 'court') {
    for (const k of t) if (/^[3-8]$/.test(k)) field.push(k);
  } else {
    if (t.has('QSA')) field.push('QSA');
    if (t.has('QNA')) field.push('QNA');
    if (t.has('QSB')) field.push('QSB');
    if (t.has('QNB')) field.push('QNB');
  }

  const rooms = Array.from(new Set([...southFinal, ...northFinal, ...field]));
  const order = ['1A','1B','2A','2B',
                 ...(mode === 'court' ? ['3','4','5','6','7','8'] : ['QSA','QNA','QSB','QNB']),
                 '9A','9B','10A','10B'];
  rooms.sort((a,b)=>order.indexOf(a)-order.indexOf(b));
  return rooms;
}

function canon(s){ return clean(s).toLowerCase(); }
function groupKey(reservee, purpose, startMin, endMin) {
  const p = canon(purpose).replace(/#\d{4,}/g,'').replace(/\(booking[^)]*\)/g,'').trim();
  const r = canon(reservee);
  return `${r}|${p}|${startMin}|${endMin}`;
}

function scaffold(mode) {
  return {
    dayStartMin: 360,
    dayEndMin: 1380,
    fieldhouseMode: mode, // "court" or "turf" (for the front-end layout)
    rooms: [
      { id:'1A',  label:'1A',  group:'south' },
      { id:'1B',  label:'1B',  group:'south' },
      { id:'2A',  label:'2A',  group:'south' },
      { id:'2B',  label:'2B',  group:'south' },
      ...(mode === 'court'
        ? [
            { id:'3', label:'3', group:'fieldhouse' },
            { id:'4', label:'4', group:'fieldhouse' },
            { id:'5', label:'5', group:'fieldhouse' },
            { id:'6', label:'6', group:'fieldhouse' },
            { id:'7', label:'7', group:'fieldhouse' },
            { id:'8', label:'8', group:'fieldhouse' },
          ]
        : [
            { id:'QSA', label:'Quarter Turf SA', group:'fieldhouse' }, // top-left
            { id:'QNA', label:'Quarter Turf NA', group:'fieldhouse' }, // top-right
            { id:'QSB', label:'Quarter Turf SB', group:'fieldhouse' }, // bottom-left
            { id:'QNB', label:'Quarter Turf NB', group:'fieldhouse' }, // bottom-right
          ]),
      { id:'9A',  label:'9A',  group:'north' },
      { id:'9B',  label:'9B',  group:'north' },
      { id:'10A', label:'10A', group:'north' },
      { id:'10B', label:'10B', group:'north' },
    ],
    slots: []
  };
}

// --------------- main ---------------
async function main(){
  if (!fs.existsSync(INPUT_CSV) || fs.statSync(INPUT_CSV).size === 0) {
    const out = scaffold('court');
    fs.writeFileSync(OUTPUT_JSON, JSON.stringify(out, null, 2));
    console.log('transform: no csv -> scaffold (court)');
    return;
  }

  const raw = fs.readFileSync(INPUT_CSV, 'utf8');
  const rows = parse(raw, { bom:true, skip_empty_lines:true });
  if (!rows.length) {
    const out = scaffold('court');
    fs.writeFileSync(OUTPUT_JSON, JSON.stringify(out, null, 2));
    console.log('transform: empty rows -> scaffold (court)');
    return;
  }

  const header = rows[0].map(h => lc(h));
  const col = (name) => header.findIndex(h => h === name.toLowerCase());
  const iLocation = col('location:');
  const iFacility = col('facility');
  const iTime     = col('reserved time');
  const iReservee = col('reservee');
  const iPurpose  = col('reservation purpose');

  const mode = (iFacility >= 0 && iPurpose >= 0) ? detectFieldhouseMode(rows, iFacility, iPurpose) : 'court';

  if (iFacility < 0 || iTime < 0 || iReservee < 0 || iPurpose < 0) {
    const out = scaffold(mode);
    fs.writeFileSync(OUTPUT_JSON, JSON.stringify(out, null, 2));
    console.log(`transform: headers missing -> scaffold (${mode})`);
    return;
  }

  const nowMin = nowMinutesLocal();
  const PAST_GRACE_MIN = 15; // keep events until 15 min after their end

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

    // Past with small grace
    if (range.endMin < (nowMin - PAST_GRACE_MIN)) { dropPast++; continue; }

    // System placeholders never display (we still used them for mode)
    if (isSystemDrop(reservee, purpose)) { dropSystem++; continue; }

    const { tokens } = classifyFacility(facility, mode);
    if (!tokens.length) { dropNoMap++; continue; }

    kept.push({ reservee, purpose, startMin: range.startMin, endMin: range.endMin, tokens });
  }

  // group identical (reservee/purpose/time) across multiple facility rows
  const groups = new Map();
  for (const it of kept) {
    const key = groupKey(it.reservee, it.purpose, it.startMin, it.endMin);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(it);
  }

  const slots = [];
  for (const arr of groups.values()) {
    const tokenSet = new Set();
    for (const it of arr) for (const tk of it.tokens) tokenSet.add(tk);

    const rooms = resolveRoomsFromTokens(tokenSet, mode);
    if (!rooms.length) continue;

    const any = arr[0];
    const { title, subtitle, org, contact } = makeDisplay(any.reservee, any.purpose);

    for (const roomId of rooms) {
      slots.push({ roomId, startMin: any.startMin, endMin: any.endMin, title, subtitle, org, contact });
    }
  }

  // dedup + order
  const seen = new Set();
  const final = [];
  const sortOrder = ['1A','1B','2A','2B',
    ...(mode === 'court' ? ['3','4','5','6','7','8'] : ['QSA','QNA','QSB','QNB']),
    '9A','9B','10A','10B'
  ];

  for (const s of slots) {
    const k = `${s.roomId}|${s.startMin}|${s.endMin}|${s.title}|${s.subtitle}`;
    if (!seen.has(k)) { seen.add(k); final.push(s); }
  }
  final.sort((a,b)=>{
    return (sortOrder.indexOf(a.roomId) - sortOrder.indexOf(b.roomId)) || (a.startMin - b.startMin);
  });

  const out = scaffold(mode);
  out.slots = final;

  fs.writeFileSync(OUTPUT_JSON, JSON.stringify(out, null, 2));
  console.log(
    `transform: fieldhouseMode=${mode} rows=${rows.length-1} kept=${kept.length} slots=${out.slots.length} ` +
    `drop[system=${dropSystem} past=${dropPast} notRAEC=${dropNotRAEC} noTime=${dropNoTime} noMap=${dropNoMap}]`
  );
}

main().catch(err => {
  console.error('transform.mjs failed:', err);
  process.exit(1);
});
