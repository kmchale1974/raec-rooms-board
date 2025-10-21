// scripts/transform.mjs
// Node 20+, package.json should have: { "type": "module" }
import fs from 'fs';

// Inputs (defaults match your repo)
const CSV_PATH = process.env.CSV_PATH || 'data/inbox/latest.csv';
const JSON_OUT = process.env.JSON_OUT || 'events.json';

// Board day window
const dayStartMin = 6 * 60;   // 06:00
const dayEndMin   = 23 * 60;  // 23:00

// ---------- Season helpers ----------
function nthWeekdayOfMonth(year, month /* 0-11 */, weekday /*0=Sun..6=Sat*/, n /*1..5*/) {
  const d = new Date(year, month, 1);
  const offset = (weekday - d.getDay() + 7) % 7;
  const day = 1 + offset + (n - 1) * 7;
  return new Date(year, month, day);
}
function isFloorSeason(date = new Date()) {
  const y = date.getFullYear();
  const thirdMondayMarch = nthWeekdayOfMonth(y, 2, 1, 3);   // March (2), Monday(1), 3rd
  const secondMondayNov  = nthWeekdayOfMonth(y, 10, 1, 2);  // Nov (10), Monday(1), 2nd
  return date >= thirdMondayMarch && date < secondMondayNov;
}
function mapTurfToCourts(facilityLower) {
  // Return an array of strings (court IDs) OR null if not a turf label
  if (facilityLower.includes('full turf')) return ['3','4','5','6','7','8'];
  if (facilityLower.includes('half turf north')) return ['6','7','8'];
  if (facilityLower.includes('half turf south')) return ['3','4','5'];
  if (facilityLower.includes('quarter turf na')) return ['3'];
  if (facilityLower.includes('quarter turf nb')) return ['4'];
  if (facilityLower.includes('quarter turf sa')) return ['5'];
  if (facilityLower.includes('quarter turf sb')) return ['6'];
  return null;
}

// ---------- CSV utils ----------
function parseCsv(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    .split('\n')
    .filter((ln, i, arr) => !(ln.trim() === '' && i === arr.length - 1));

  if (!lines.length) return [];

  const rows = [];
  for (const line of lines) {
    const out = [];
    let cur = '';
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQ) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') { inQ = false; }
        else cur += ch;
      } else {
        if (ch === '"') inQ = true;
        else if (ch === ',') { out.push(cur.trim()); cur = ''; }
        else cur += ch;
      }
    }
    out.push(cur.trim());
    rows.push(out);
  }
  return rows;
}
const normKey = (h) => h.toLowerCase().replace(/[^a-z0-9]/g, '');

// ---------- Mapping ----------
function mapFacilityToRoomOrCourts(facility, floorSeason) {
  if (!facility) return { courts: null, genericGroup: null };

  const f = facility.toLowerCase();

  // South gym (1–2)
  if (f.includes('half court 1a') || f.includes('court 1-ab') || f.includes('full gym 1ab') || f.includes('championship')) return { courts: ['1'], genericGroup: null };
  if (f.includes('half court 1b')) return { courts: ['1'], genericGroup: null };
  if (f.includes('half court 2a') || f.includes('court 2-ab') || f.includes('full gym 1ab & 2ab')) return { courts: ['2'], genericGroup: null };
  if (f.includes('half court 2b')) return { courts: ['2'], genericGroup: null };

  // North gym (9–10)
  if (f.includes('half court 9a') || f.includes('court 9-ab') || f.includes('full gym 9 & 10')) return { courts: ['9'], genericGroup: null };
  if (f.includes('half court 9b')) return { courts: ['9'], genericGroup: null };
  if (f.includes('half court 10a') || f.includes('court 10-ab')) return { courts: ['10'], genericGroup: null };
  if (f.includes('half court 10b')) return { courts: ['10'], genericGroup: null };

  // Fieldhouse – basketball floors
  if (f.includes('fieldhouse - court 3')) return { courts: ['3'], genericGroup: null };
  if (f.includes('fieldhouse - court 4')) return { courts: ['4'], genericGroup: null };
  if (f.includes('fieldhouse - court 5')) return { courts: ['5'], genericGroup: null };
  if (f.includes('fieldhouse - court 6')) return { courts: ['6'], genericGroup: null };
  if (f.includes('fieldhouse - court 7')) return { courts: ['7'], genericGroup: null };
  if (f.includes('fieldhouse - court 8')) return { courts: ['8'], genericGroup: null };

  if (f.includes('court 3-8') || f.includes('court 3 – 8') || f.includes('fieldhouse court 3-8')) {
    return { courts: ['3','4','5','6','7','8'], genericGroup: '3-8' };
  }

  // Fieldhouse – turf labels
  const turfCourts = mapTurfToCourts(f);
  if (turfCourts) {
    if (floorSeason) {
      // Ignore turf in floor season
      return { courts: null, genericGroup: null };
    }
    return { courts: turfCourts, genericGroup: 'turf' };
  }

  return { courts: null, genericGroup: null };
}

// ---------- Time & text ----------
function parseTimeRange(s) {
  if (!s) return null;
  const m = s.match(/(\d{1,2}:\d{2}\s*[ap]m)\s*-\s*(\d{1,2}:\d{2}\s*[ap]m)/i);
  if (!m) return null;
  const toMin = (t) => {
    const mm = t.trim().match(/(\d{1,2}):(\d{2})\s*([ap]m)/i);
    if (!mm) return null;
    let hh = parseInt(mm[1], 10);
    const mi = parseInt(mm[2], 10);
    const ap = mm[3].toLowerCase();
    if (ap === 'pm' && hh !== 12) hh += 12;
    if (ap === 'am' && hh === 12) hh = 0;
    return hh * 60 + mi;
  };
  const a = toMin(m[1]);
  const b = toMin(m[2]);
  if (a == null || b == null) return null;
  return [a, b];
}

function cleanTitle(str) {
  if (!str) return '';
  // remove duplicated segment after comma: "X, X" -> "X"
  str = str.replace(/\b([^,]+),\s*\1\b/gi, '$1');
  // trim internal "Internal Hold per NM" noise
  str = str.replace(/\binternal hold per nm\b/gi, '').replace(/\s{2,}/g, ' ').trim();
  return str;
}

function isPickleball(reservee, purpose) {
  const r = (reservee || '').toLowerCase();
  const p = (purpose || '').toLowerCase();
  return p.includes('pickleball') || (r.includes('front desk') && p.includes('pickleball'));
}
function pickleballWhoWhat() { return { who: 'Open Pickleball', what: '' }; }
function orgKey(s) {
  return (s || '').toLowerCase()
    .replace(/raec front desk.*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}
const rangesOverlap = (a1,a2,b1,b2)=> Math.max(a1,b1) < Math.min(a2,b2);

// ---------- scaffold ----------
function writeScaffold() {
  const rooms = [
    { id: '1', label: '1', group: 'south' },
    { id: '2', label: '2', group: 'south' },
    { id: '3', label: '3', group: 'fieldhouse' },
    { id: '4', label: '4', group: 'fieldhouse' },
    { id: '5', label: '5', group: 'fieldhouse' },
    { id: '6', label: '6', group: 'fieldhouse' },
    { id: '7', label: '7', group: 'fieldhouse' },
    { id: '8', label: '8', group: 'fieldhouse' },
    { id: '9', label: '9', group: 'north' },
    { id: '10', label: '10', group: 'north' },
  ];
  fs.writeFileSync(JSON_OUT, JSON.stringify({ dayStartMin, dayEndMin, rooms, slots: [] }, null, 2));
}

// ---------- main ----------
function main() {
  const floorSeason = isFloorSeason();
  console.log('Season:', floorSeason ? 'FLOOR (courts 3–8)' : 'TURF');

  // 1) Missing/empty CSV → scaffold
  if (!fs.existsSync(CSV_PATH)) {
    console.log('CSV missing; writing empty scaffold.');
    writeScaffold();
    return;
  }
  const text = fs.readFileSync(CSV_PATH, 'utf8');
  if (!text || !text.trim()) {
    console.log('CSV empty content; writing empty scaffold.');
    writeScaffold();
    return;
  }

  const rows = parseCsv(text);
  if (!rows.length) {
    console.log('CSV parsed to zero rows; writing empty scaffold.');
    writeScaffold();
    return;
  }

  // 2) Header map + debug
  const header = rows[0].map(normKey);
  console.log('Detected headers:', header.join(', '));
  const idx = {
    location: header.indexOf('location'),
    facility: header.indexOf('facility'),
    reservedtime: header.indexOf('reservedtime'),
    reservee: header.indexOf('reservee'),
    reservationpurpose: header.indexOf('reservationpurpose'),
    headcount: header.indexOf('headcount'),
  };

  // show a couple sample values for quick debugging
  for (let i = 1; i < Math.min(rows.length, 5); i++) {
    const r = rows[i];
    console.log('Sample', i, {
      location: idx.location >= 0 ? r[idx.location] : undefined,
      facility: idx.facility >= 0 ? r[idx.facility] : undefined,
      reservedtime: idx.reservedtime >= 0 ? r[idx.reservedtime] : undefined,
    });
  }

  const outRooms = [
    { id: '1', label: '1', group: 'south' },
    { id: '2', label: '2', group: 'south' },
    { id: '3', label: '3', group: 'fieldhouse' },
    { id: '4', label: '4', group: 'fieldhouse' },
    { id: '5', label: '5', group: 'fieldhouse' },
    { id: '6', label: '6', group: 'fieldhouse' },
    { id: '7', label: '7', group: 'fieldhouse' },
    { id: '8', label: '8', group: 'fieldhouse' },
    { id: '9', label: '9', group: 'north' },
    { id: '10', label: '10', group: 'north' },
  ];

  const raw = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r.length === 0) continue;

    const location = idx.location >= 0 ? r[idx.location] : '';
    if (location && !/athletic\s*&?\s*event\s*center/i.test(location)) continue;

    const facility = idx.facility >= 0 ? r[idx.facility] : '';
    const { courts, genericGroup } = mapFacilityToRoomOrCourts(facility, floorSeason);
    if (!courts || courts.length === 0) continue;

    const tr = idx.reservedtime >= 0 ? r[idx.reservedtime] : '';
    const range = parseTimeRange(tr);
    if (!range) continue;
    let [startMin, endMin] = range;

    startMin = Math.max(startMin, dayStartMin);
    endMin   = Math.min(endMin,   dayEndMin);
    if (endMin <= startMin) continue;

    const reservee = idx.reservee >= 0 ? r[idx.reservee] : '';
    const purpose  = idx.reservationpurpose >= 0 ? r[idx.reservationpurpose] : '';

    let who, what;
    if (isPickleball(reservee, purpose)) {
      ({ who, what } = pickleballWhoWhat());
    } else {
      who  = cleanTitle(reservee);
      what = cleanTitle(purpose);
    }

    for (const c of courts) {
      raw.push({ roomId: c, startMin, endMin, who, what, org: orgKey(reservee), generic: genericGroup });
    }
  }

  // 3) Prefer specific-court rows over generic 3–8 blocks (and over coarse turf groupings)
  const keep = [];
  for (let i = 0; i < raw.length; i++) {
    const a = raw[i];
    let drop = false;
    for (let j = 0; j < raw.length; j++) {
      if (i === j) continue;
      const b = raw[j];
      if (a.org !== b.org) continue;
      if (a.roomId !== b.roomId) continue;
      if (!rangesOverlap(a.startMin, a.endMin, b.startMin, b.endMin)) continue;

      // If one is generic block (3-8 or turf) and the other is a specific court time for same org,
      // drop the generic one.
      const aGeneric = !!a.generic;
      const bGeneric = !!b.generic;
      if (aGeneric && !bGeneric) { drop = true; break; }
      if (!aGeneric && bGeneric) { /* keep a */ continue; }

      // Otherwise dedupe later by ordering
      if (i > j) { drop = true; break; }
    }
    if (!drop) keep.push(a);
  }

  // 4) Dedup identical rows
  const seen = new Set();
  const slots = [];
  for (const s of keep) {
    const k = `${s.org}|${s.roomId}|${s.startMin}|${s.endMin}|${s.who}|${s.what}`;
    if (seen.has(k)) continue;
    seen.add(k);
    slots.push({ roomId: s.roomId, startMin: s.startMin, endMin: s.endMin, title: s.who, subtitle: s.what });
  }

  fs.writeFileSync(JSON_OUT, JSON.stringify({ dayStartMin, dayEndMin, rooms: outRooms, slots }, null, 2));
  console.log(`Wrote ${JSON_OUT} • rooms=${outRooms.length} • slots=${slots.length}`);
}

main();
