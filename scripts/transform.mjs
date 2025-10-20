// scripts/transform.mjs
// Node 20+, package.json should have: { "type": "module" }
import fs from 'fs';
import path from 'path';

const CSV_PATH  = process.env.CSV_PATH  || 'data/inbox/latest.csv';
const JSON_OUT  = process.env.JSON_OUT  || 'events.json';

// Day window (minutes after midnight) — your board expects 6:00–23:00
const dayStartMin = 6 * 60;
const dayEndMin   = 23 * 60;

// --- tiny CSV reader that handles quotes ---
function parseCsv(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').filter(Boolean);
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

// normalize headers like "Location:" -> "location"
const normKey = (h) => h.toLowerCase().replace(/[^a-z0-9]/g, '');

// map a facility string to a board “room number”
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

  // Fieldhouse (basketball floor period → ignore “turf” rows)
  // Courts 3..8 when floors are down:
  if (f.includes('fieldhouse - court 3')) return '3';
  if (f.includes('fieldhouse - court 4')) return '4';
  if (f.includes('fieldhouse - court 5')) return '5';
  if (f.includes('fieldhouse - court 6')) return '6';
  if (f.includes('fieldhouse - court 7')) return '7';
  if (f.includes('fieldhouse - court 8')) return '8';

  // Court range “3-8” → we’ll split later using reservee-specific overrides
  if (f.includes('court 3-8') || f.includes('court 3 – 8') || f.includes('fieldhouse court 3-8')) return '3-8';

  // Turf (ignore during basketball floor season)
  if (f.includes('full turf') || f.includes('half turf') || f.includes('quarter turf')) return null;

  return null;
}

// parse “4:30pm - 9:30pm” into [minutes, minutes]
function parseTimeRange(s) {
  if (!s) return null;
  const m = s.match(/(\d{1,2}:\d{2}\s*[ap]m)\s*-\s*(\d{1,2}:\d{2}\s*[ap]m)/i);
  if (!m) return null;
  const toMin = (t) => {
    const mm = t.trim().match(/(\d{1,2}):(\d{2})\s*([ap]m)/i);
    if (!mm) return null;
    let hh = parseInt(mm[1], 10);
    const min = parseInt(mm[2], 10);
    const ap = mm[3].toLowerCase();
    if (ap === 'pm' && hh !== 12) hh += 12;
    if (ap === 'am' && hh === 12) hh = 0;
    return hh * 60 + min;
  };
  const a = toMin(m[1]);
  const b = toMin(m[2]);
  if (a == null || b == null) return null;
  return [a, b];
}

// “clean” the who/what strings
function cleanTitle(str) {
  if (!str) return '';
  // Remove exact duplicates after comma (e.g., "X, X")
  str = str.replace(/\b([^,]+),\s*\1\b/gi, '$1');
  // Collapse repeated spaces
  return str.replace(/\s{2,}/g, ' ').trim();
}

// SPECIAL RULES:
// 1) Pickleball: if reservee contains “RAEC Front Desk, Rentals - On Hold” AND purpose contains “Open Pickleball”
//    → show “Open Pickleball” and HIDE the “Front Desk / Internal Hold” text.
// 2) Court 3–8 overrides: if an org appears both on “Court 3-8” AND specific 3/4/5/6/7/8 entries,
//    we keep only the specific courts for that org/time window.
function isPickleball(reservee, purpose) {
  const r = (reservee || '').toLowerCase();
  const p = (purpose || '').toLowerCase();
  return p.includes('pickleball') || r.includes('front desk') && p.includes('pickleball');
}

function pickleballWhoWhat(reservee, purpose) {
  // Force “Open Pickleball”; strip internal hold notes
  return { who: 'Open Pickleball', what: '' };
}

function orgKey(s) {
  return (s || '').toLowerCase()
    .replace(/raec front desk.*$/i, '') // drop the FD hold postfix
    .replace(/\s+/g, ' ')
    .trim();
}

function rangesOverlap(a1, a2, b1, b2) {
  return Math.max(a1, b1) < Math.min(a2, b2);
}

function main() {
  if (!fs.existsSync(CSV_PATH)) {
    console.log('No rows; wrote empty scaffold.');
    fs.writeFileSync(JSON_OUT, JSON.stringify({
      dayStartMin, dayEndMin,
      rooms: [
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
      ],
      slots: []
    }, null, 2));
    return;
  }

  const text = fs.readFileSync(CSV_PATH, 'utf8');
  const rows = parseCsv(text);
  if (!rows.length) {
    console.log('Empty CSV; writing empty scaffold.');
    return main();
  }

  // header map
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

  // collect preliminary slots
  const raw = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];

    const location = idx.location >= 0 ? r[idx.location] : '';
    // ignore non-RAEC locations if present
    if (location && !/athletic\s*&?\s*event\s*center/i.test(location)) continue;

    const facility = idx.facility >= 0 ? r[idx.facility] : '';
    const room = mapFacilityToRoom(facility);
    if (!room) continue; // ignore turf when floors are down, or unknowns

    const tr = idx.reservedtime >= 0 ? r[idx.reservedtime] : '';
    const range = parseTimeRange(tr);
    if (!range) continue;
    let [startMin, endMin] = range;

    // clamp to display day
    startMin = Math.max(startMin, dayStartMin);
    endMin   = Math.min(endMin,   dayEndMin);
    if (endMin <= startMin) continue;

    const reservee = idx.reservee >= 0 ? r[idx.reservee] : '';
    const purpose  = idx.reservationpurpose >= 0 ? r[idx.reservationpurpose] : '';

    // build who/what
    let who, what;
    if (isPickleball(reservee, purpose)) {
      ({ who, what } = pickleballWhoWhat(reservee, purpose));
    } else {
      who  = cleanTitle(reservee);
      what = cleanTitle(purpose);
    }

    // Expand “Court 3-8” into tentative courts 3..8 (we’ll dedupe/override later)
    if (room === '3-8') {
      for (const n of ['3','4','5','6','7','8']) {
        raw.push({ roomId: n, startMin, endMin, who, what, org: orgKey(reservee) });
      }
    } else {
      raw.push({ roomId: room, startMin, endMin, who, what, org: orgKey(reservee) });
    }
  }

  // --- Override logic for court 3–8 conflicts ---
  // If an org has both generic (from expanded 3-8) and specific court rows, drop the generic ones overlapping the specific ones.
  const keep = [];
  for (let i = 0; i < raw.length; i++) {
    const a = raw[i];
    let drop = false;

    // Generic ones are the items that came from expanding 3-8. We can't mark them now,
    // but we can detect they clash: if there exists another row for the same org, same time window,
    // and same roomId explicitly coming from a named “Court N”.
    // Heuristic: if there are duplicates (same org, roomId, overlapping time) keep only ONE of them.
    for (let j = 0; j < raw.length; j++) {
      if (i === j) continue;
      const b = raw[j];
      if (a.org !== b.org) continue;
      if (a.roomId !== b.roomId) continue;
      if (!rangesOverlap(a.startMin, a.endMin, b.startMin, b.endMin)) continue;

      // Prefer the entry whose `what` is not empty (specific reservation line often has better detail)
      if (b.what && !a.what) { drop = true; break; }

      // Or simply keep the earliest created (i > j → drop a)
      if (i > j) { drop = true; break; }
    }

    if (!drop) keep.push(a);
  }

  // Coalesce exact duplicates (same org, room, same time range) into one
  const dedupKey = (s) => `${s.org}|${s.roomId}|${s.startMin}|${s.endMin}|${s.who}|${s.what}`;
  const seen = new Set();
  const slots = [];
  for (const s of keep) {
    const k = dedupKey(s);
    if (seen.has(k)) continue;
    seen.add(k);
    slots.push({ roomId: s.roomId, startMin: s.startMin, endMin: s.endMin, title: s.who, subtitle: s.what });
  }

  // write out
  fs.writeFileSync(JSON_OUT, JSON.stringify({
    dayStartMin, dayEndMin,
    rooms: outRooms,
    slots
  }, null, 2));

  console.log(`Wrote ${JSON_OUT} • rooms=${outRooms.length} • slots=${slots.length}`);
}

main();
