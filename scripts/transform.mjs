#!/usr/bin/env node
// scripts/transform.mjs
// Robust CSV -> events.json with RAEC rules

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const INPUT_CSV   = process.env.IN_CSV   || path.join(__dirname, '..', 'data', 'inbox', 'latest.csv');
const OUTPUT_JSON = process.env.OUT_JSON || path.join(__dirname, '..', 'events.json');

// ---------- Minimal robust CSV parser (handles quotes/commas/newlines) ----------
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let i = 0, inQuotes = false;

  while (i < text.length) {
    const c = text[i];

    if (inQuotes) {
      if (c === '"') {
        if (text[i+1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }

    if (c === '"') { inQuotes = true; i++; continue; }

    if (c === ',') { row.push(field); field = ''; i++; continue; }

    if (c === '\r') { i++; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }

    field += c; i++;
  }
  // last field
  row.push(field);
  // push last row if not empty/extra
  if (row.length > 1 || (row.length === 1 && row[0].trim() !== '')) rows.push(row);

  return rows;
}

// ---------- Helpers ----------
function clean(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }
function normHeader(h) { return clean(h).replace(/[:()*]/g,'').toLowerCase(); }

function toMinutes(hhmm) {
  const m = String(hhmm).trim().toLowerCase().match(/^(\d{1,2}):(\d{2})\s*([ap])m$/);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const mer = m[3];
  if (h === 12) h = 0;
  if (mer === 'p') h += 12;
  return h*60 + min;
}
function parseRange(text) {
  if (!text) return null;
  const m = String(text).toLowerCase().replace(/\s+/g,' ')
    .match(/(\d{1,2}:\d{2}\s*[ap]m)\s*-\s*(\d{1,2}:\d{2}\s*[ap]m)/i);
  if (!m) return null;
  return { startMin: toMinutes(m[1]), endMin: toMinutes(m[2]) };
}

function nthWeekdayOfMonth(y, monthIdx, weekday, n) {
  const d = new Date(y, monthIdx, 1);
  let k = 0;
  while (d.getMonth() === monthIdx) {
    if (d.getDay() === weekday) { k++; if (k === n) return new Date(d); }
    d.setDate(d.getDate() + 1);
  }
  return null;
}
function isCourtSeason(d = new Date()) {
  const y = d.getFullYear();
  const thirdMonMar  = nthWeekdayOfMonth(y, 2, 1, 3); // March
  const secondMonNov = nthWeekdayOfMonth(y,10, 1, 2); // November
  if (!thirdMonMar || !secondMonNov) return true;
  return (d >= thirdMonMar && d < secondMonNov);
}

function reorderName(lastCommaFirst) {
  // "Llanos, David" -> "David Llanos"
  const m = String(lastCommaFirst).match(/^\s*([A-Za-z'.-]+)\s*,\s*([A-Za-z'.-]+)\s*$/);
  if (!m) return null;
  return `${m[2]} ${m[1]}`;
}

function normalizeReservee(raw) {
  const s = clean(raw);

  if (/^catch\s*corner/i.test(s)) {
    return { title: 'Catch Corner', subtitle: '', org: 'Catch Corner', contact: '' };
  }
  if (/raec\s*front\s*desk/i.test(s)) {
    return { title: 'RAEC Front Desk', subtitle: '', org: 'RAEC Front Desk', contact: '' };
  }

  // "Empower Volleyball (Rec), Dean Baxendale"
  const parts = s.split(',').map(x => x.trim());
  if (parts.length >= 2) {
    const left  = parts[0];
    const right = parts.slice(1).join(', ');

    // If pattern looks like Last, First
    const lf = reorderName(`${left}, ${parts[1]}`);
    if (lf) return { title: lf, subtitle: '', org: lf, contact: '' };

    // Otherwise treat as Org, Contact
    return { title: left, subtitle: right, org: left, contact: right };
  }

  // Single token; try "Last, First" shape anyway
  const lf2 = reorderName(s);
  if (lf2) return { title: lf2, subtitle: '', org: lf2, contact: '' };

  return { title: s, subtitle: '', org: s, contact: '' };
}

function isPickleball(purpose, reservee) {
  return /pickleball/i.test(String(purpose)) || /pickleball/i.test(String(reservee));
}

function cleanPurpose(p) {
  let s = clean(p);
  s = s.replace(/^\(+/, '').replace(/\)+$/, '');
  s = s.replace(/internal hold per nm/i, '').trim();
  return s;
}

// Facility → rooms + specificity
// specificity: 3 = half court (most specific)
//              2 = Court X-AB
//              1 = Full Gym group / Championship
//              0 = blanket/other
function mapFacility(fac) {
  const f = clean(fac).toLowerCase();

  // South 1/2
  if (f === 'ac gym - half court 1a') return { rooms:['1A'], spec:3, group:'south' };
  if (f === 'ac gym - half court 1b') return { rooms:['1B'], spec:3, group:'south' };
  if (f === 'ac gym - court 1-ab')    return { rooms:['1A','1B'], spec:2, group:'south' };

  if (f === 'ac gym - half court 2a') return { rooms:['2A'], spec:3, group:'south' };
  if (f === 'ac gym - half court 2b') return { rooms:['2B'], spec:3, group:'south' };
  if (f === 'ac gym - court 2-ab')    return { rooms:['2A','2B'], spec:2, group:'south' };

  if (/full gym 1ab & 2ab/i.test(f) || /championship court/i.test(f))
    return { rooms:['1A','1B','2A','2B'], spec:1, group:'south' };

  // North 9/10
  if (f === 'ac gym - half court 9a') return { rooms:['9A'], spec:3, group:'north' };
  if (f === 'ac gym - half court 9b') return { rooms:['9B'], spec:3, group:'north' };
  if (f === 'ac gym - court 9-ab')    return { rooms:['9A','9B'], spec:2, group:'north' };

  if (f === 'ac gym - half court 10a') return { rooms:['10A'], spec:3, group:'north' };
  if (f === 'ac gym - half court 10b') return { rooms:['10B'], spec:3, group:'north' };
  if (f === 'ac gym - court 10-ab')    return { rooms:['10A','10B'], spec:2, group:'north' };

  if (/full gym 9\s*&\s*10/i.test(f))
    return { rooms:['9A','9B','10A','10B'], spec:1, group:'north' };

  // Fieldhouse 3..8 (courts)
  const mCourt = f.match(/^ac fieldhouse - court\s*([3-8])$/i);
  if (mCourt) return { rooms:[mCourt[1]], spec:3, group:'fieldhouse' };
  if (f === 'ac fieldhouse - court 3-8') return { rooms:['3','4','5','6','7','8'], spec:1, group:'fieldhouse' };

  // Turf entries (we still map but will filter in court season)
  if (/^ac fieldhouse - full turf$/i.test(f)) return { rooms:['3','4','5','6','7','8'], spec:0, group:'fieldhouse', turf:true };
  if (/^ac fieldhouse - half turf north$/i.test(f)) return { rooms:['6','7','8'], spec:0, group:'fieldhouse', turf:true };
  if (/^ac fieldhouse - half turf south$/i.test(f)) return { rooms:['3','4','5'], spec:0, group:'fieldhouse', turf:true };
  if (/^ac fieldhouse - quarter turf n[ab]$/i.test(f)) return { rooms:['7','8'], spec:0, group:'fieldhouse', turf:true };
  if (/^ac fieldhouse - quarter turf s[ab]$/i.test(f)) return { rooms:['3','4'], spec:0, group:'fieldhouse', turf:true };

  return null;
}

function clusterKeySouthNorth(it) {
  // Cluster by org + exact start/end + group (‘south’ or ‘north’)
  return `${it.group}|${(it.org||'').toLowerCase()}|${it.startMin}|${it.endMin}`;
}
function clusterKeyField(it) {
  return `fh|${(it.org||'').toLowerCase()}|${it.startMin}|${it.endMin}`;
}

function nowChicagoMinutes() {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone:'America/Chicago', hour12:false,
    year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit'
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).map(p=>[p.type,p.value]));
  const iso = `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:00`;
  const d = new Date(iso);
  return d.getHours()*60 + d.getMinutes();
}

// ---------- Main ----------
function writeScaffold() {
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
    console.log('No CSV found or empty; writing scaffold.');
    writeScaffold();
    return;
  }

  const raw = fs.readFileSync(INPUT_CSV, 'utf8').replace(/^\uFEFF/, ''); // strip BOM
  const rows = parseCSV(raw);
  if (!rows.length) { writeScaffold(); return; }

  // Header scan (tolerant)
  const header = rows[0].map(h => normHeader(h));
  const H = (nameCandidates) => {
    for (const cand of nameCandidates) {
      let idx = header.indexOf(cand);
      if (idx !== -1) return idx;
    }
    return -1;
  };

  // common header variants
  const iLocation = H(['location','location ']);
  const iFacility = H(['facility']);
  const iTime     = H(['reserved time','reservation time','time','reservedtime']);
  const iReservee = H(['reservee','reserved by','reservedby']);
  const iPurpose  = H(['reservation purpose','purpose','event','notes']);

  const body = rows.slice(1);
  const courtMode = isCourtSeason(new Date());

  const items = [];

  for (const row of body) {
    const location = iLocation >= 0 ? clean(row[iLocation]) : '';
    const facility = iFacility >= 0 ? clean(row[iFacility]) : '';
    const timeText = iTime     >= 0 ? clean(row[iTime])     : '';
    const reservee = iReservee >= 0 ? clean(row[iReservee]) : '';
    const purpose  = iPurpose  >= 0 ? clean(row[iPurpose])  : '';

    if (!facility || !timeText) continue;
    if (location && !/athletic\s*&\s*event\s*center/i.test(location)) continue;

    const mapped = mapFacility(facility);
    if (!mapped) continue;

    // Filter turf during court season
    if (courtMode && mapped.turf) continue;

    const range = parseRange(timeText);
    if (!range || range.startMin == null || range.endMin == null) continue;

    // Build display attributes
    let { title, subtitle, org, contact } = normalizeReservee(reservee);
    const pur = cleanPurpose(purpose);

    // Pickleball override
    if (isPickleball(purpose, reservee)) {
      title = 'Open Pickleball';
      subtitle = '';
      org = 'Open Pickleball'; contact = '';
    } else {
      // If org title looked like a person ("Last, First" -> "First Last") done already
      // else keep org as title, and use purpose as subtitle if present
      if (pur) {
        // If we parsed “Org, Contact”, prefer showing purpose over contact when present
        subtitle = pur || subtitle;
      }
    }

    items.push({
      group: mapped.group,
      rooms: mapped.rooms,
      spec:  mapped.spec,
      startMin: range.startMin,
      endMin:   range.endMin,
      title, subtitle, org, contact,
      rawFacility: facility
    });
  }

  // Dedup & specificity logic per your rules
  const resultSlots = [];
  const nowMin = nowChicagoMinutes();

  // cluster south/north by org+time
  const clusters = new Map();
  for (const it of items.filter(x => x.group === 'south' || x.group === 'north')) {
    const key = clusterKeySouthNorth(it);
    if (!clusters.has(key)) clusters.set(key, []);
    clusters.get(key).push(it);
  }

  for (const [key, arr] of clusters) {
    const group = arr[0].group;
    const maxSpec = Math.max(...arr.map(a => a.spec));

    let chosenRooms = new Set();
    if (maxSpec === 3) {
      // Use ONLY the half-court rooms present
      arr.filter(a => a.spec === 3).forEach(a => a.rooms.forEach(r => chosenRooms.add(r)));
    } else if (maxSpec === 2) {
      // No halves; use Court AB rooms
      arr.filter(a => a.spec === 2).forEach(a => a.rooms.forEach(r => chosenRooms.add(r)));
    } else if (maxSpec === 1) {
      // Full gym / championship
      arr.filter(a => a.spec === 1).forEach(a => a.rooms.forEach(r => chosenRooms.add(r)));
    }

    // pick a representative display line (prefer non-empty title)
    const display = arr.find(a => a.title) || arr[0];

    for (const r of chosenRooms) {
      // hide past
      if (display.endMin <= nowMin) continue;
      resultSlots.push({
        roomId: r,
        startMin: display.startMin,
        endMin: display.endMin,
        title: display.title,
        subtitle: display.subtitle,
        org: display.org,
        contact: display.contact
      });
    }
  }

  // Fieldhouse clusters (treat blanket vs specific)
  const fhClusters = new Map();
  for (const it of items.filter(x => x.group === 'fieldhouse')) {
    const key = clusterKeyField(it);
    if (!fhClusters.has(key)) fhClusters.set(key, []);
    fhClusters.get(key).push(it);
  }

  for (const [key, arr] of fhClusters) {
    const hasSpecific = arr.some(a => a.spec >= 3 && a.rooms.length === 1);
    let chosenRooms = new Set();

    if (hasSpecific) {
      arr.filter(a => a.spec >= 3).forEach(a => a.rooms.forEach(r => chosenRooms.add(r)));
    } else {
      // take blanket
      arr.forEach(a => a.rooms.forEach(r => chosenRooms.add(r)));
    }

    const display = arr.find(a => a.title) || arr[0];
    for (const r of chosenRooms) {
      if (display.endMin <= nowMin) continue;
      resultSlots.push({
        roomId: r,
        startMin: display.startMin,
        endMin: display.endMin,
        title: display.title,
        subtitle: cleanPurpose(display.subtitle || ''),
        org: display.org,
        contact: display.contact
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
    slots: resultSlots
  };

  fs.writeFileSync(OUTPUT_JSON, JSON.stringify(json, null, 2));
  console.log(`Wrote events.json • rooms=${json.rooms.length} • slots=${json.slots.length}`);
}

main().catch(err => {
  console.error('transform.mjs failed:', err);
  process.exit(1);
});
