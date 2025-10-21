// scripts/transform.mjs
// Node 20+, package.json should have: { "type": "module" }
import fs from 'fs';

// Inputs (defaults match your repo)
const CSV_PATH = process.env.CSV_PATH || 'data/inbox/latest.csv';
const JSON_OUT = process.env.JSON_OUT || 'events.json';

// Board day window
const dayStartMin = 6 * 60;   // 06:00
const dayEndMin   = 23 * 60;  // 23:00

// --- utils ---
function parseCsv(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    .split('\n')
    // keep empty fields but drop completely empty trailing lines
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

function mapFacilityToRoom(facility) {
  if (!facility) return null;
  const f = facility.toLowerCase();

  // South gym (1–2)
  if (f.includes('half court 1a') || f.includes('court 1-ab') || f.includes('full gym 1ab') || f.includes('championship')) return '1';
  if (f.includes('half court 1b')) return '1';
  if (f.includes('half court 2a') || f.includes('court 2-ab') || f.includes('full gym 1ab & 2ab')) return '2';
  if (f.includes('half court 2b')) return '2';

  // North gym (9–10)
  if (f.includes('half court 9a') || f.includes('court 9-ab') || f.includes('full gym 9 & 10')) return '9';
  if (f.includes('half court 9b')) return '9';
  if (f.includes('half court 10a') || f.includes('court 10-ab')) return '10';
  if (f.includes('half court 10b')) return '10';

  // Fieldhouse – basketball floors (ignore turf terms)
  if (f.includes('fieldhouse - court 3')) return '3';
  if (f.includes('fieldhouse - court 4')) return '4';
  if (f.includes('fieldhouse - court 5')) return '5';
  if (f.includes('fieldhouse - court 6')) return '6';
  if (f.includes('fieldhouse - court 7')) return '7';
  if (f.includes('fieldhouse - court 8')) return '8';

  if (f.includes('court 3-8') || f.includes('court 3 – 8') || f.includes('fieldhouse court 3-8')) return '3-8';

  // Turf rows ignored during floor season
  if (f.includes('full turf') || f.includes('half turf') || f.includes('quarter turf')) return null;

  return null;
}

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
  return str.replace(/\s{2,}/g, ' ').trim();
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

// scaffold writer
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

function main() {
  // 1) Missing or empty file → write scaffold and exit
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

  // 2) Normal parsing
  const header = rows[0].map(normKey);
  const idx = {
    location: header.indexOf('location'),
    facility: header.indexOf('facility'),
    reservedtime: header.indexOf('reservedtime'),
    reservee: header.indexOf('reservee'),
    reservationpurpose: header.indexOf('reservationpurpose'),
    headcount: header.indexOf('headcount'),
  };

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
    const room = mapFacilityToRoom(facility);
    if (!room) continue;

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

    if (room === '3-8') {
      for (const n of ['3','4','5','6','7','8']) {
        raw.push({ roomId: n, startMin, endMin, who, what, org: orgKey(reservee) });
      }
    } else {
      raw.push({ roomId: room, startMin, endMin, who, what, org: orgKey(reservee) });
    }
  }

  // 3) Drop generic 3–8 rows when an org also has specific courts overlapping
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
      if (b.what && !a.what) { drop = true; break; }
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
