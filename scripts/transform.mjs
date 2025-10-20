// scripts/transform.mjs
// Node 18+/ESM
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ---------- helpers ----------
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const CSV_IN  = process.env.CSV_PATH || 'data/inbox/latest.csv';
const JSON_OUT = process.env.JSON_OUT || 'events.json';

// RAEC daily window (6:00–23:00 local, minutes)
const DAY_START_MIN = 6 * 60;
const DAY_END_MIN   = 23 * 60;

// Fieldhouse mode by calendar (courts vs turf)
// Courts down: 3rd Monday in March → 2nd Monday in November (inclusive of those days)
// Turf down: otherwise
function nthMondayOfMonth(year, monthIndex, n) {
  // monthIndex: 0..11
  const d = new Date(Date.UTC(year, monthIndex, 1));
  const firstDay = d.getUTCDay(); // 0 Sun .. 6 Sat
  const offset = (1 - firstDay + 7) % 7; // days to first Monday
  const day = 1 + offset + (n - 1) * 7;
  return new Date(Date.UTC(year, monthIndex, day));
}
function isCourtsSeason(dtUtc) {
  const y = dtUtc.getUTCFullYear();
  const start = nthMondayOfMonth(y, 2, 3); // March, 3rd Monday
  const end   = nthMondayOfMonth(y, 10, 2); // November, 2nd Monday
  return dtUtc >= start && dtUtc < end;
}

// read CSV quickly (no external deps)
function parseCSV(text) {
  // very simple CSV splitter that handles quoted fields and commas
  const rows = [];
  let i = 0, field = '', row = [], inQuotes = false;
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { row.push(field); rows.push(row); field = ''; row = []; i++; continue; }
    field += c; i++;
  }
  // last field
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function toMinutes12h(s) {
  // "6:00pm" or "7:30 am" etc -> minutes since 0:00
  if (!s) return null;
  const t = s.trim().toLowerCase();
  const m = t.match(/^(\d{1,2})(?::(\d{2}))?\s*([ap]m)$/);
  if (!m) return null;
  let hh = parseInt(m[1],10);
  const mm = parseInt(m[2]||'0',10);
  const ap = m[3];
  if (ap === 'pm' && hh !== 12) hh += 12;
  if (ap === 'am' && hh === 12) hh = 0;
  return hh*60 + mm;
}

function overlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

function norm(s){ return (s||'').replace(/\s+/g,' ').trim().toLowerCase(); }

// map Facility -> initial target(s)
const FH_RANGE_RE   = /AC\s*Fieldhouse\s*Court\s*3-8/i;
const FH_SPEC_RE    = /AC\s*Fieldhouse\s*-\s*Court\s*([3-8])/i;
const FH_ANY_TURF_RE = /AC\s*Fieldhouse.*turf/i;

const GYM_HALF_RE   = /AC\s*Gym\s*-\s*Half\s*Court\s*(\d{1,2})([AB])/i;
const GYM_FULL_RE   = /AC\s*Gym\s*-\s*Court\s*(\d{1,2})-AB/i;
const GYM_BOTH_RE   = /AC\s*Gym\s*-\s*Full\s*Gym\s*(\d{1,2})AB\s*&\s*(\d{1,2})AB/i;
const CHAMP_RE      = /AC\s*Gym\s*-\s*Championship\s*Court/i;

function facilityToTargets(facility, courtsMode /* 'courts' | 'turf' */) {
  const f = facility || '';

  // Championship Court == Courts 1 & 2
  if (CHAMP_RE.test(f)) return [{type:'specific', rooms:['1','2']}];

  // Gym mapping
  let m;
  if ((m = GYM_HALF_RE.exec(f))) {
    const num = m[1];
    const letter = m[2]; // A or B
    return [{type:'specific', rooms:[String(num)]}]; // collapse A/B to the number
  }
  if ((m = GYM_FULL_RE.exec(f))) {
    const num = m[1];
    return [{type:'specific', rooms:[String(num)]}];
  }
  if ((m = GYM_BOTH_RE.exec(f))) {
    const n1 = m[1], n2 = m[2];
    return [{type:'specific', rooms:[String(n1), String(n2)]}];
  }

  // Fieldhouse mode
  if (courtsMode === 'courts') {
    if (FH_RANGE_RE.test(f)) {
      return [{type:'range', rooms:['3','4','5','6','7','8']}];
    }
    if ((m = FH_SPEC_RE.exec(f))) {
      return [{type:'specific', rooms:[m[1]]}];
    }
    // Ignore any turf references while courts are down
    if (FH_ANY_TURF_RE.test(f)) {
      return []; // suppressed
    }
  } else {
    // Turf season: keep turf; ignore 3..8 court calls
    if (FH_ANY_TURF_RE.test(f)) {
      // You could map full/half/quarters here if you want to render the turf layout.
      // For the grid, we suppress turf so Fieldhouse cards stay empty (as requested earlier).
      return [];
    }
    if (FH_RANGE_RE.test(f) || FH_SPEC_RE.test(f)) {
      return []; // suppress courts when turf is down
    }
  }

  return [];
}

function cleanTitles({reservee, purpose}) {
  // Pickleball clean-up and generic RAEC internal hold removal
  const r = reservee || '';
  const p = purpose || '';

  const isPickle = /pickleball/i.test(p) || /pickleball/i.test(r);
  if (isPickle) {
    return { title: 'Open Pickleball', subtitle: '' };
  }

  // Remove internal-only noise
  const stripList = [
    /RAEC\s*Front\s*Desk,?\s*Rentals\s*-\s*On\s*Hold/gi,
    /Internal\s*Hold\s*per\s*NM/gi
  ];
  let title = r;
  let subtitle = p;
  stripList.forEach(rx => {
    title = title.replace(rx,'').replace(/\s{2,}/g,' ').trim();
    subtitle = subtitle.replace(rx,'').replace(/\s{2,}/g,' ').trim();
  });

  // If title became empty, fall back to purpose
  if (!title) title = subtitle || 'Reserved';

  // Trim duplicate org names like "Extreme Volleyball, Extreme Volleyball"
  title = title.replace(/\b(.+?)\s*,\s*\1\b/gi, '$1').trim();

  return { title, subtitle };
}

// ---------- main ----------
async function main() {
  let csv = '';
  try {
    csv = fs.readFileSync(CSV_IN, 'utf8');
  } catch {
    console.log('No CSV found; writing empty scaffold.');
    fs.writeFileSync(JSON_OUT, JSON.stringify({
      dayStartMin: DAY_START_MIN,
      dayEndMin: DAY_END_MIN,
      rooms: [
        {id:'1',label:'1',group:'south'},
        {id:'2',label:'2',group:'south'},
        {id:'3',label:'3',group:'fieldhouse'},
        {id:'4',label:'4',group:'fieldhouse'},
        {id:'5',label:'5',group:'fieldhouse'},
        {id:'6',label:'6',group:'fieldhouse'},
        {id:'7',label:'7',group:'fieldhouse'},
        {id:'8',label:'8',group:'fieldhouse'},
        {id:'9',label:'9',group:'north'},
        {id:'10',label:'10',group:'north'},
      ],
      slots:[]
    }, null, 2));
    return;
  }

  const rows = parseCSV(csv);
  if (!rows.length) {
    console.log('Empty CSV; wrote empty scaffold.');
    fs.writeFileSync(JSON_OUT, JSON.stringify({
      dayStartMin: DAY_START_MIN, dayEndMin: DAY_END_MIN, rooms:[], slots:[]
    }, null, 2));
    return;
  }

  // header map
  const header = rows[0].map(h => h.trim().toLowerCase());
  const ix = {
    location: header.findIndex(h => h.startsWith('location')),
    facility: header.findIndex(h => h.startsWith('facility')),
    reservedtime: header.findIndex(h => h.startsWith('reserved time') || h.includes('reservedtime')),
    reservee: header.findIndex(h => h.startsWith('reservee')),
    purpose: header.findIndex(h => h.startsWith('reservation purpose') || h === 'reservationpurpose'),
    headcount: header.findIndex(h => h.startsWith('headcount')),
  };

  // figure out today's date in UTC for season calc (assume CSV is "today")
  const todayUtc = new Date(); // GH runner UTC
  const courtsMode = isCourtsSeason(todayUtc) ? 'courts' : 'turf';

  // Step 1: parse records + initial mapping
  const records = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const location = (ix.location >= 0) ? row[ix.location] : '';
    if (location && !/athletic\s*&\s*event\s*center/i.test(location)) {
      // We only show this site; skip others
      continue;
    }

    const facility = (ix.facility >= 0) ? row[ix.facility] : '';
    const reserved = (ix.reservedtime >= 0) ? row[ix.reservedtime] : '';
    const reservee = (ix.reservee >= 0) ? row[ix.reservee] : '';
    const purpose  = (ix.purpose  >= 0) ? row[ix.purpose]  : '';

    // time like "6:00pm - 9:00pm"
    const tm = reserved.match(/(\d{1,2}(?::\d{2})?\s*[ap]m)\s*-\s*(\d{1,2}(?::\d{2})?\s*[ap]m)/i);
    if (!tm) continue;
    const startMin = toMinutes12h(tm[1]);
    const endMin   = toMinutes12h(tm[2]);
    if (startMin == null || endMin == null) continue;

    const targets = facilityToTargets(facility, courtsMode);
    if (!targets.length) continue;

    const who = reservee || '';
    const what = purpose || '';

    for (const t of targets) {
      // Each target may contain multiple rooms
      for (const room of t.rooms) {
        records.push({
          kind: t.type,           // 'specific' | 'range'
          area: 'fh',             // only used for fieldhouse logic (we also push gyms thru here)
          room,
          reservee: who,
          reserveeNorm: norm(who),
          purpose: what,
          startMin, endMin,
          facilityRaw: facility
        });
      }
    }
  }

  // Step 2: “specific beats broad” for Fieldhouse ranges per reservee/time
  // Group by reservee for quick lookups
  const byReservee = new Map();
  for (const rec of records) {
    const key = rec.reserveeNorm;
    if (!byReservee.has(key)) byReservee.set(key, []);
    byReservee.get(key).push(rec);
  }

  const keep = [];
  for (const [, list] of byReservee) {
    // Partition list into 'range' and 'specific'
    const ranges   = list.filter(x => x.kind === 'range');
    const specifics = list.filter(x => x.kind === 'specific');

    if (ranges.length === 0) {
      keep.push(...specifics); continue;
    }

    if (specifics.length === 0) {
      keep.push(...ranges); continue;
    }

    // Build a mask for which range items should survive
    // If any specific overlaps a given range, we DROP that range entirely
    // and rely only on the specifics to express true occupancy.
    // (This also solves the “Court 6 only 7:30–9:00” case.)
    const drop = new Set(ranges.map((_, i) => i)); // pessimistically drop all ranges that are overlapped
    for (let i = 0; i < ranges.length; i++) {
      const rg = ranges[i];
      const anySpecOverlap = specifics.some(sp => overlap(rg.startMin, rg.endMin, sp.startMin, sp.endMin));
      if (!anySpecOverlap) {
        // no specific overlaps this range: keep it
        drop.delete(i);
      }
    }
    // push kept ranges
    ranges.forEach((rg, i) => { if (!drop.has(i)) keep.push(rg); });
    // always push all specifics
    keep.push(...specifics);
  }

  // Step 3: collapse to UI slots, clean titles, dedupe
  const dedupe = new Set();
  const slots = [];

  for (const rec of keep) {
    const { title, subtitle } = cleanTitles({reservee: rec.reservee, purpose: rec.purpose});

    // Ignore fully past items (transform keeps everything; the UI also filters by 'now')
    if (rec.endMin <= DAY_START_MIN || rec.startMin >= DAY_END_MIN) continue;

    const key = `${rec.room}|${rec.startMin}|${rec.endMin}|${norm(title)}|${norm(subtitle)}`;
    if (dedupe.has(key)) continue;
    dedupe.add(key);

    slots.push({
      roomId: rec.room,
      startMin: Math.max(DAY_START_MIN, rec.startMin),
      endMin:   Math.min(DAY_END_MIN,   rec.endMin),
      title,
      subtitle
    });
  }

  // Final payload with rooms (fixed layout)
  const rooms = [
    {id:'1',label:'1',group:'south'},
    {id:'2',label:'2',group:'south'},
    {id:'3',label:'3',group:'fieldhouse'},
    {id:'4',label:'4',group:'fieldhouse'},
    {id:'5',label:'5',group:'fieldhouse'},
    {id:'6',label:'6',group:'fieldhouse'},
    {id:'7',label:'7',group:'fieldhouse'},
    {id:'8',label:'8',group:'fieldhouse'},
    {id:'9',label:'9',group:'north'},
    {id:'10',label:'10',group:'north'},
  ];

  const out = {
    dayStartMin: DAY_START_MIN,
    dayEndMin: DAY_END_MIN,
    rooms,
    slots
  };

  fs.writeFileSync(JSON_OUT, JSON.stringify(out, null, 2));
  console.log(`Wrote ${JSON_OUT} • rooms=${rooms.length} • slots=${slots.length}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
