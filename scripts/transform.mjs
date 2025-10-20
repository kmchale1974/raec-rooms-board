// scripts/transform.mjs
// Node 20+ ESM

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// --- Config ---
const CSV_PATH = process.env.CSV_PATH || 'data/inbox/latest.csv';
const JSON_OUT = process.env.JSON_OUT || 'events.json';
const DAY_START_MIN = 6 * 60;   // 06:00
const DAY_END_MIN   = 23 * 60;  // 23:00

// --- Helpers ---
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

function readFileUtf8(p) {
  try { return fs.readFileSync(p, 'utf8'); }
  catch { return ''; }
}

function toMinutes(h12, m, ampm) {
  let h = parseInt(h12, 10);
  let min = parseInt(m, 10);
  if (ampm.toLowerCase() === 'pm' && h !== 12) h += 12;
  if (ampm.toLowerCase() === 'am' && h === 12) h = 0;
  return h * 60 + min;
}

function parseTimeRange(s) {
  // e.g. "9:30am - 12:30pm" or "4:00pm -  7:00pm"
  if (!s) return null;
  const m = s.toLowerCase().match(/(\d{1,2}):(\d{2})\s*(am|pm)\s*-\s*(\d{1,2}):(\d{2})\s*(am|pm)/i);
  if (!m) return null;
  const start = toMinutes(m[1], m[2], m[3]);
  const end   = toMinutes(m[4], m[5], m[6]);
  return { startMin: start, endMin: end };
}

function thirdMondayOfMarch(y) {
  const d = new Date(y, 2, 1); // Mar 1
  const day = d.getDay(); // 0..6 Sun..Sat
  const offset = (8 - day) % 7; // first Monday
  return new Date(y, 2, 1 + offset + 14); // third Monday
}
function secondMondayOfNovember(y) {
  const d = new Date(y, 10, 1); // Nov 1
  const day = d.getDay();
  const offset = (8 - day) % 7; // first Monday
  return new Date(y, 10, 1 + offset + 7); // second Monday
}
function isBasketballFloorDown(date = new Date()) {
  // Basketball floors: from 3rd Mon of March through 2nd Mon of Nov
  const y = date.getFullYear();
  const start = thirdMondayOfMarch(y);
  const end = secondMondayOfNovember(y);
  return date >= start && date < end;
}

function looksLikePickleball(purpose) {
  return /pickleball/i.test(purpose || '');
}

function cleanOrgName(s) {
  if (!s) return '';
  // Remove duplicate trailing segment after comma: "Extreme Volleyball, Extreme Volleyball" -> "Extreme Volleyball"
  const parts = s.split(',').map(x => x.trim()).filter(Boolean);
  if (parts.length >= 2) {
    const last = parts[parts.length - 1];
    const first = parts[0];
    if (last.toLowerCase() === first.toLowerCase()) {
      return first;
    }
  }
  // Remove “, Rentals - On Hold” etc. for public display
  return s.replace(/\s*,\s*Rentals\s*-\s*On\s*Hold/i, '').trim();
}

function cleanPurpose(s) {
  if (!s) return '';
  // Drop internal-only note
  return s.replace(/\s*internal hold per nm\s*/ig, '').trim();
}

function formatWhoWhat(reservee, purpose) {
  const who = cleanOrgName(reservee);
  let what = cleanPurpose(purpose);

  // Pickleball rule: title becomes "Open Pickleball"
  if (looksLikePickleball(purpose)) return { title: 'Open Pickleball', subtitle: '' };

  // If subtitle just repeats who, drop it
  if (what && who && what.toLowerCase() === who.toLowerCase()) what = '';
  return { title: who || what || '—', subtitle: (who && what && who.toLowerCase() !== what.toLowerCase()) ? what : '' };
}

function normalize(s) {
  return (s || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^\w\s:&]/g, '')
    .trim();
}

// Facility → rooms map (single-facility rows)
// Return array of room ids (strings)
function mapFacilityToRooms(facility) {
  const f = facility || '';

  // South gym
  if (/AC Gym - (Half Court 1[AB]|Court 1-AB|Full Gym 1AB & 2AB|Championship Court)/i.test(f)) {
    if (/Court 1-AB/i.test(f) || /Half Court 1[AB]/i.test(f)) return ['1'];
    // Championship Court is the same as Court 1 & 2 (both shown)
    if (/Championship Court/i.test(f)) return ['1','2'];
    if (/Full Gym 1AB & 2AB/i.test(f)) return ['1','2'];
  }
  if (/AC Gym - (Half Court 2[AB]|Court 2-AB|Full Gym 1AB & 2AB|Championship Court)/i.test(f)) {
    if (/Court 2-AB/i.test(f) || /Half Court 2[AB]/i.test(f)) return ['2'];
    if (/Championship Court/i.test(f)) return ['1','2'];
    if (/Full Gym 1AB & 2AB/i.test(f)) return ['1','2'];
  }

  // North gym
  if (/AC Gym - (Half Court 9[AB]|Court 9-AB|Full Gym 9 & 10)/i.test(f)) {
    if (/Court 9-AB/i.test(f) || /Half Court 9[AB]/i.test(f)) return ['9'];
    if (/Full Gym 9 & 10/i.test(f)) return ['9','10'];
  }
  if (/AC Gym - (Half Court 10[AB]|Court 10-AB|Full Gym 9 & 10)/i.test(f)) {
    if (/Court 10-AB/i.test(f) || /Half Court 10[AB]/i.test(f)) return ['10'];
    if (/Full Gym 9 & 10/i.test(f)) return ['9','10'];
  }

  // Fieldhouse (basketball floor down): explicit “Court X”
  if (/AC Fieldhouse - Court\s*[3-8]/i.test(f)) {
    const m = f.match(/Court\s*(\d+)/i);
    if (m) return [String(parseInt(m[1], 10))];
  }

  // Fieldhouse broad range: “AC Fieldhouse Court 3-8”
  if (/AC Fieldhouse Court 3-8/i.test(f)) {
    // we’ll resolve to specific courts later if we find overlapping specific rows
    return ['3','4','5','6','7','8'];
  }

  // Turf names — ignored when basketball floor is down
  if (/AC Fieldhouse - (Full Turf|Half Turf North|Half Turf South|Quarter Turf)/i.test(f)) {
    // handled outside depending on season
    return ['3','4','5','6','7','8']; // placeholder; filtered later if needed
  }

  return []; // unknown → ignore
}

function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

// --- CSV parsing (simple) ---
function parseCsv(text) {
  if (!text.trim()) return [];
  // Split lines tolerant of CRLF
  const lines = text.split(/\r?\n/).filter(Boolean);

  // Header row (support “Location:” vs “Location”)
  const header = lines[0].split(',').map(h => h.trim().replace(/:$/,'').toLowerCase());
  const idx = {
    location: header.findIndex(h => h === 'location'),
    facility: header.findIndex(h => h === 'facility'),
    reserved: header.findIndex(h => h.startsWith('reserved time')),
    reservee: header.findIndex(h => h === 'reservee'),
    purpose: header.findIndex(h => h.startsWith('reservation purpose')),
    headcount: header.findIndex(h => h === 'headcount'),
  };

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const raw = lines[i];
    // naïve split; works for these exports (no embedded commas in fields we care about)
    const cols = raw.split(',').map(s => s.trim());
    const rec = {
      location: cols[idx.location] || '',
      facility: cols[idx.facility] || '',
      reserved: cols[idx.reserved] || '',
      reservee: cols[idx.reservee] || '',
      purpose: cols[idx.purpose] || '',
      headcount: cols[idx.headcount] || '',
    };
    if (!rec.facility || !rec.reserved) continue;
    rows.push(rec);
  }
  return rows;
}

// --- Main transform ---
(function main() {
  const csvPath = path.resolve(__dirname, '..', CSV_PATH);
  const outPath = path.resolve(__dirname, '..', JSON_OUT);

  const csv = readFileUtf8(csvPath);
  if (!csv) {
    console.log('No CSV found; writing empty scaffold.');
    const empty = scaffold();
    fs.writeFileSync(outPath, JSON.stringify(empty, null, 2));
    return;
  }

  const now = new Date();
  const basketballDown = isBasketballFloorDown(now);

  const rows = parseCsv(csv);

  // 1) Pre-scan: for each (reservee, time window) collect specific fieldhouse courts 3..8
  // key: reserveeNorm|start|end  -> Set of court numbers (strings) in 3..8
  const specificFH = new Map();
  for (const r of rows) {
    const t = parseTimeRange(r.reserved);
    if (!t) continue;
    const f = r.facility || '';
    if (/AC Fieldhouse - Court\s*[3-8]/i.test(f)) {
      const m = f.match(/Court\s*(\d+)/i);
      if (!m) continue;
      const court = String(parseInt(m[1], 10));
      const key = [normalize(r.reservee), t.startMin, t.endMin].join('|');
      if (!specificFH.has(key)) specificFH.set(key, new Set());
      specificFH.get(key).add(court);
    }
  }

  // 2) Build raw slots (fan out per facility mapping)
  let slots = [];
  for (const r of rows) {
    // Only RAEC location (you said others shouldn't appear)
    if (r.location && !/athletic & event center/i.test(r.location)) continue;

    const t = parseTimeRange(r.reserved);
    if (!t) continue;

    // Ignore past completely
    if (t.endMin <= minutesNow()) continue;

    // Turf rows are ignored when basketball floor is down (your rule)
    const isTurf = /AC Fieldhouse - (Full Turf|Half Turf North|Half Turf South|Quarter Turf)/i.test(r.facility || '');
    if (basketballDown && isTurf) continue;

    let rooms = mapFacilityToRooms(r.facility);

    // Resolve Fieldhouse 3-8 override: if we have specific courts for same reservee+time, use only those
    if (rooms.length === 6 && rooms.every(id => ['3','4','5','6','7','8'].includes(id))) {
      const key = [normalize(r.reservee), t.startMin, t.endMin].join('|');
      const spec = specificFH.get(key);
      if (spec && spec.size) {
        rooms = Array.from(spec).sort((a,b) => parseInt(a)-parseInt(b));
      }
    }

    if (!rooms.length) continue;

    // Clean who/what (Pickleball rename, internal hold note scrub, duplicate commas, etc.)
    const { title, subtitle } = formatWhoWhat(r.reservee, r.purpose);

    for (const roomId of rooms) {
      slots.push({
        roomId,
        startMin: t.startMin,
        endMin: t.endMin,
        title,
        subtitle
      });
    }
  }

  // 3) De-duplicate per room
  const seen = new Set();
  slots = slots.filter(s => {
    const key = [s.roomId, normalize(s.title), normalize(s.subtitle), s.startMin, s.endMin].join('|');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // 4) Clamp to board day bounds (optional)
  slots = slots.map(s => ({
    ...s,
    startMin: Math.max(s.startMin, DAY_START_MIN),
    endMin: Math.min(s.endMin, DAY_END_MIN),
  })).filter(s => s.startMin < s.endMin);

  // 5) Sort by room, then start time
  slots.sort((a, b) => {
    const ra = parseInt(a.roomId, 10), rb = parseInt(b.roomId, 10);
    if (ra !== rb) return ra - rb;
    return a.startMin - b.startMin;
  });

  // 6) Write out
  const payload = scaffold(slots);
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
  console.log(`Wrote ${JSON_OUT} • rooms=${payload.rooms.length} • slots=${payload.slots.length}`);

  // --- helpers ---
  function minutesNow(d = new Date()) {
    return d.getHours() * 60 + d.getMinutes();
  }
})();

// Scaffold board schema
function scaffold(slots = []) {
  return {
    dayStartMin: DAY_START_MIN,
    dayEndMin: DAY_END_MIN,
    rooms: [
      { id: '1',  label: '1',  group: 'south' },
      { id: '2',  label: '2',  group: 'south' },
      { id: '3',  label: '3',  group: 'fieldhouse' },
      { id: '4',  label: '4',  group: 'fieldhouse' },
      { id: '5',  label: '5',  group: 'fieldhouse' },
      { id: '6',  label: '6',  group: 'fieldhouse' },
      { id: '7',  label: '7',  group: 'fieldhouse' },
      { id: '8',  label: '8',  group: 'fieldhouse' },
      { id: '9',  label: '9',  group: 'north' },
      { id: '10', label: '10', group: 'north' },
    ],
    slots
  };
}
