// scripts/transform.mjs
import fs from 'fs';
import path from 'path';
import readline from 'readline';

const CSV_PATH = process.env.CSV_PATH || 'data/inbox/latest.csv';
const JSON_OUT = process.env.JSON_OUT || 'events.json';

// ---------------- Time helpers ----------------
function parseTimeRange(raw) {
  if (!raw) return null;
  const t = raw.replace(/\s+/g, ' ').trim();
  const m = t.match(/^(\d{1,2}:\d{2}\s*[ap]m)\s*-\s*(\d{1,2}:\d{2}\s*[ap]m)$/i);
  if (!m) return null;
  return { startMin: toMin(m[1]), endMin: toMin(m[2]) };
}
function toMin(hm) {
  const s = hm.toLowerCase().replace(/\s+/g, '');
  const mm = s.match(/^(\d{1,2}):(\d{2})(am|pm)$/);
  if (!mm) return 0;
  let h = parseInt(mm[1], 10);
  const min = parseInt(mm[2], 10);
  const ampm = mm[3];
  if (ampm === 'pm' && h !== 12) h += 12;
  if (ampm === 'am' && h === 12) h = 0;
  return h * 60 + min;
}
function clampDay(startMin, endMin, dayStartMin = 360, dayEndMin = 1380) {
  const s = Math.max(startMin, dayStartMin);
  const e = Math.min(endMin, dayEndMin);
  return e > s ? { startMin: s, endMin: e } : null;
}

// ---------------- CSV helpers ----------------
function csvSplit(line, delim = ',') {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
      else { inQ = !inQ; }
    } else if (ch === delim && !inQ) {
      out.push(cur); cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map(s => s.trim());
}
const norm = s => (s || '').trim();
const includes = (s, sub) => (s || '').toLowerCase().includes(sub.toLowerCase());
const anyIncludes = (s, arr) => arr.some(k => includes(s, k));

// ---------------- Season logic: turf vs courts ----------------
// Turf season: 2nd Monday in Nov  -> 3rd Monday in Mar (next year)
function nthMonday(year, monthIndex, n) {
  const d = new Date(Date.UTC(year, monthIndex, 1));
  const day = d.getUTCDay();
  const firstMon = 1 + ((8 - day) % 7);
  const date = firstMon + 7 * (n - 1);
  return new Date(Date.UTC(year, monthIndex, date));
}
function isTurfSeason(dateUtc) {
  const y = dateUtc.getUTCFullYear();
  const nov2 = nthMonday(y, 10, 2);
  const mar3 = nthMonday(y + 1, 2, 3);
  return dateUtc >= nov2 && dateUtc <= mar3;
}

// ---------------- Mapping & normalization ----------------
function cleanReservee(reservee) {
  const t = norm(reservee);
  if (!t) return t;
  // collapse "Extreme Volleyball, Extreme Volleyball" -> "Extreme Volleyball"
  const parts = t.split(',').map(s => s.trim()).filter(Boolean);
  const uniq = [];
  for (const p of parts) if (!uniq.includes(p)) uniq.push(p);
  return uniq.join(', ');
}

function isPickleballRow(row) {
  const purpose = (row['reservation purpose'] || row['reservationpurpose'] || '').toLowerCase();
  return purpose.includes('pickleball');
}

function cleanPurposeForPublic(purpose, isPickleball) {
  let p = norm(purpose);
  if (!p) return '';
  // Hide internal notes
  p = p.replace(/internal hold.*$/i, '').trim();
  // For pickleball, don't repeat the word (title already "Open Pickleball")
  if (isPickleball) {
    p = p.replace(/open\s*pickleball/ig, '').trim();
  }
  return p;
}

// We tag coverage so we can collapse A/B later
// coverage: 'A', 'B', 'AB', 'FULL_PAIR' (9&10 or 1&2), or undefined (single full room)
function mapFacilityToCoverage(facility, turfSeason) {
  const f = (facility || '').toLowerCase().replace(/\s+/g, ' ').trim();

  // ---- Championship Court => rooms 1 & 2 (pair)
  if (includes(f, 'championship court')) return { rooms: ['1', '2'], coverage: 'FULL_PAIR' };

  // ---- Full gym pairs
  if (includes(f, 'full gym 1ab & 2ab')) return { rooms: ['1', '2'], coverage: 'FULL_PAIR' };
  if (includes(f, 'full gym 9 & 10'))    return { rooms: ['9', '10'], coverage: 'FULL_PAIR' };

  // ---- Court X-AB
  const courtAB = f.match(/court\s+(1|2|9|10)-ab/);
  if (courtAB) return { rooms: [courtAB[1]], coverage: 'AB' };

  // ---- Half Court X[A/B]
  const half = f.match(/half court\s*(1|2|9|10)\s*([ab])/);
  if (half) return { rooms: [half[1]], coverage: half[2].toUpperCase() }; // 'A' or 'B'

  // ---- Plain Court X (rare in feed)
  const singleCourt = f.match(/\bac gym - court\s*(1|2|9|10)\b/);
  if (singleCourt) return { rooms: [singleCourt[1]] };

  // ---- Fieldhouse courts and ranges
  const fhSingle = f.match(/fieldhouse\s*-\s*court\s*(3|4|5|6|7|8)/);
  if (fhSingle) return { rooms: [fhSingle[1]] };

  if (includes(f, 'fieldhouse court 3-8')) return { rooms: ['3','4','5','6','7','8'], coverage: 'AB' }; // treat like a general range (multi)

  // ---- Turf labels (only respected in turf season)
  const isTurf =
    includes(f, 'full turf') ||
    includes(f, 'half turf north') ||
    includes(f, 'half turf south') ||
    includes(f, 'quarter turf na') ||
    includes(f, 'quarter turf nb') ||
    includes(f, 'quarter turf sa') ||
    includes(f, 'quarter turf sb');

  if (isTurf) {
    if (!turfSeason) return { rooms: [] };
    if (includes(f, 'full turf'))        return { rooms: ['3','4','5','6','7','8'], coverage: 'AB' };
    if (includes(f, 'half turf north'))  return { rooms: ['6','7','8'] };
    if (includes(f, 'half turf south'))  return { rooms: ['3','4','5'] };
    if (includes(f, 'quarter turf na'))  return { rooms: ['6'] };
    if (includes(f, 'quarter turf nb'))  return { rooms: ['7'] };
    if (includes(f, 'quarter turf sa'))  return { rooms: ['3'] };
    if (includes(f, 'quarter turf sb'))  return { rooms: ['4'] };
  }

  return { rooms: [] };
}

// ---------------- Collapse A/B to single room when fully covered ----------------
// We collect coverage fragments for each logical key and then materialize slots.
function collapseCoverage(frags) {
  // key: room|start|end|title -> set of coverages observed
  const byKey = new Map(); // key -> { roomId, startMin, endMin, title, subtitle?, flags:Set, hasPair:boolean }
  const keyOf = f => `${f.roomId}|${f.startMin}|${f.endMin}|${f.title}`;

  for (const f of frags) {
    const k = keyOf(f);
    if (!byKey.has(k)) {
      byKey.set(k, {
        roomId: f.roomId,
        startMin: f.startMin,
        endMin: f.endMin,
        title: f.title,
        subtitle: f.subtitle || '',
        flags: new Set(),
        pairRooms: new Set([f.roomId]) // will be unioned if FULL_PAIR contributed
      });
    }
    const rec = byKey.get(k);
    if (f.coverage) rec.flags.add(f.coverage); // A, B, AB, FULL_PAIR
    if (f.pairRooms) f.pairRooms.forEach(r => rec.pairRooms.add(r));
    // keep the richest subtitle if needed (longer)
    if ((f.subtitle || '').length > (rec.subtitle || '').length) rec.subtitle = f.subtitle || '';
  }

  const out = [];
  for (const rec of byKey.values()) {
    const flags = rec.flags;
    const hasAB = flags.has('AB');
    const hasA = flags.has('A');
    const hasB = flags.has('B');
    const hasPair = flags.has('FULL_PAIR');

    // If FULL_PAIR, materialize one slot per room in pair (1&2 or 9&10). No lane.
    if (hasPair) {
      for (const r of rec.pairRooms) {
        out.push({
          roomId: r, startMin: rec.startMin, endMin: rec.endMin,
          title: rec.title, subtitle: rec.subtitle
        });
      }
      continue;
    }

    // For single room: if AB present, or A+B both present, collapse to one (no lane)
    if (hasAB || (hasA && hasB)) {
      out.push({
        roomId: rec.roomId, startMin: rec.startMin, endMin: rec.endMin,
        title: rec.title, subtitle: rec.subtitle
      });
    } else if (hasA || hasB) {
      // Only one half observed -> still show (with lane badge)
      out.push({
        roomId: rec.roomId, startMin: rec.startMin, endMin: rec.endMin,
        title: rec.title, subtitle: rec.subtitle, lane: hasA ? 'A' : 'B'
      });
    } else {
      // No half markers — treat as a plain full-room reservation
      out.push({
        roomId: rec.roomId, startMin: rec.startMin, endMin: rec.endMin,
        title: rec.title, subtitle: rec.subtitle
      });
    }
  }

  // De-dupe per {room, start, end, title} in case multiple identical records came in
  const seen = new Set();
  const deduped = [];
  for (const s of out) {
    const k = `${s.roomId}|${s.startMin}|${s.endMin}|${s.title}`;
    if (seen.has(k)) continue;
    seen.add(k);
    deduped.push(s);
  }
  return deduped;
}

// ---------------- Fieldhouse de-dup (range vs specific) ----------------
function dedupeFieldhouse(slots) {
  const field = new Set(['3','4','5','6','7','8']);
  // If the exact same {title,start,end} appears across many fieldhouse rooms AND also appears
  // as a single-court entry, keep one per room but drop duplicates created by the "range" rows.
  const key = s => `${s.title}|${s.startMin}|${s.endMin}|${s.subtitle || ''}`;
  const byKeyRoom = new Map(); // `${key}|room` -> count
  const countsByKey = new Map(); // key -> count across fieldhouse

  for (const s of slots) {
    if (!field.has(s.roomId)) continue;
    const k = key(s);
    countsByKey.set(k, (countsByKey.get(k) || 0) + 1);
    const kr = `${k}|${s.roomId}`;
    byKeyRoom.set(kr, (byKeyRoom.get(kr) || 0) + 1);
  }

  const toDrop = new Set();
  slots.forEach((s, idx) => {
    if (!field.has(s.roomId)) return;
    const k = key(s);
    // If the key is present many times (range) we only keep one per room.
    const kr = `${k}|${s.roomId}`;
    const countInRoom = byKeyRoom.get(kr) || 0;
    if (countInRoom > 1) {
      // drop extras beyond 1
      // The first occurrence wins; the rest are dropped
      if (byKeyRoom.get(kr) > 1) {
        byKeyRoom.set(kr, 1); // mark we've kept one
      } else {
        toDrop.add(idx);
      }
    }
  });

  return slots.filter((_, i) => !toDrop.has(i));
}

// ---------------- Default rooms ----------------
function defaultRooms() {
  return [
    { id: '1',  label: '1',  group: 'south' },
    { id: '2',  label: '2',  group: 'south' },
    { id: '3',  label: '3',  group: 'fieldhouse' },
    { id: '4',  label: '4',  group: 'fieldhouse' },
    { id: '5',  label: '5',  group: 'fieldhouse' },
    { id: '6',  label: '6',  group: 'fieldhouse' },
    { id: '7',  label: '7',  group: 'fieldhouse' },
    { id: '8',  label: '8',  group: 'fieldhouse' },
    { id: '9',  label: '9',  group: 'north' },
    { id: '10', label: '10', group: 'north' }
  ];
}

// ---------------- Main ----------------
async function run() {
  if (!fs.existsSync(CSV_PATH)) {
    writeJson({ dayStartMin: 360, dayEndMin: 1380, rooms: defaultRooms(), slots: [] });
    return;
  }

  const rl = readline.createInterface({
    input: fs.createReadStream(CSV_PATH, 'utf8'),
    crlfDelay: Infinity
  });

  let headers = [];
  const rows = [];
  let lineNo = 0;
  for await (const line of rl) {
    lineNo++;
    if (lineNo === 1) {
      headers = csvSplit(line).map(h => h.replace(/:$/, '').trim());
      continue;
    }
    if (!line.trim()) continue;
    const cols = csvSplit(line);
    const row = {};
    headers.forEach((h, i) => row[h.toLowerCase()] = cols[i] ?? '');
    rows.push(row);
  }

  const today = new Date();
  const utc = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()));
  const turfSeason = isTurfSeason(utc);

  const dayStartMin = 360;
  const dayEndMin = 1380;

  // Collect fragments with coverage tags
  const frags = [];

  for (const r of rows) {
    const loc = norm(r['location'] || r['Location:']);
    if (loc && loc !== 'Athletic & Event Center') continue; // ignore other locations

    const fac = norm(r['facility']);
    const rt  = norm(r['reserved time'] || r['reservedtime']);
    const tr = parseTimeRange(rt);
    if (!tr) continue;
    const clamp = clampDay(tr.startMin, tr.endMin, dayStartMin, dayEndMin);
    if (!clamp) continue;

    const pickle = isPickleballRow(r);
    let title = pickle ? 'Open Pickleball' : cleanReservee(r['reservee']);
    // Special case: “RAEC Front Desk, Rentals - On Hold” => suppress for pickleball
    if (pickle && includes(title, 'raec front desk')) title = 'Open Pickleball';

    const purpose = r['reservation purpose'] || r['reservationpurpose'] || '';
    const subtitle = cleanPurposeForPublic(purpose, pickle);

    const mapped = mapFacilityToCoverage(fac, turfSeason);
    const rooms = mapped.rooms || [];
    const coverage = mapped.coverage; // 'A'|'B'|'AB'|'FULL_PAIR'|undefined

    if (!rooms.length) continue;

    for (const room of rooms) {
      const frag = {
        roomId: room,
        startMin: clamp.startMin,
        endMin: clamp.endMin,
        title,
        subtitle
      };
      if (coverage) frag.coverage = coverage;
      // If FULL_PAIR, annotate the pair (1&2 or 9&10)
      if (coverage === 'FULL_PAIR') {
        frag.pairRooms = new Set(rooms);
      }
      frags.push(frag);
    }
  }

  // Collapse A/B -> single, materialize pairs, and de-duplicate per room
  let slots = collapseCoverage(frags);

  // Fieldhouse de-dup (range vs specific per-court)
  slots = dedupeFieldhouse(slots);

  // Sort by time then title
  slots.sort((a, b) => a.startMin - b.startMin || (a.title || '').localeCompare(b.title || ''));

  writeJson({ dayStartMin, dayEndMin, rooms: defaultRooms(), slots });
}

function writeJson(obj) {
  fs.writeFileSync(JSON_OUT, JSON.stringify(obj, null, 2));
  console.log(`Wrote ${JSON_OUT} • rooms=${Array.isArray(obj.rooms)?obj.rooms.length:0} • slots=${Array.isArray(obj.slots)?obj.slots.length:0}`);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
