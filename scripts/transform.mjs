// scripts/transform.mjs
import fs from 'fs';
import path from 'path';
import readline from 'readline';

const CSV_PATH = process.env.CSV_PATH || 'data/inbox/latest.csv';
const JSON_OUT = process.env.JSON_OUT || 'events.json';

// ---------- Helpers ----------
function parseTimeRange(raw) {
  // handles: "9:30am - 12:30pm" and "3:00pm -  4:30pm" (note double space)
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
function csvSplit(line, delim = ',') {
  // minimal CSV split (double-quote safe enough for our export)
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQ && line[i + 1] === '"') {
        cur += '"'; i++;
      } else {
        inQ = !inQ;
      }
    } else if (ch === delim && !inQ) {
      out.push(cur); cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map(s => s.trim());
}
function normalize(s) { return (s || '').trim(); }
function includesAny(s, arr) {
  const t = s.toLowerCase();
  return arr.some(k => t.includes(k));
}

// ---------- Season Logic (turf vs courts) ----------
// Turf available from the **second Monday in November** through the **third Monday in March** (inclusive).
// Outside of that period, we treat fieldhouse as 3–8 courts and **ignore turf-labeled facilities**.
function nthMonday(year, monthIndex, n) {
  // monthIndex: 0=Jan ... 11=Dec
  const d = new Date(Date.UTC(year, monthIndex, 1));
  const day = d.getUTCDay(); // 0=Sun..6=Sat
  // first Monday date:
  const firstMon = 1 + ((8 - day) % 7);
  const date = firstMon + 7 * (n - 1);
  return new Date(Date.UTC(year, monthIndex, date));
}
function isTurfSeason(dateUtc) {
  const y = dateUtc.getUTCFullYear();
  const nov2 = nthMonday(y, 10, 2);      // Nov (10) 2nd Monday
  const mar3 = nthMonday(y + 1, 2, 3);   // Mar (2) 3rd Monday, next year

  // Window spans across year boundary: [nov2..mar3]
  return dateUtc >= nov2 && dateUtc <= mar3;
}

// ---------- Facility Mapping ----------
function mapFacilityToRooms(rawFacility, turfSeason) {
  const f = (rawFacility || '').toLowerCase().replace(/\s+/g, ' ').trim();

  // South gym: 1/2; North gym: 9/10
  // Half Court => same room id + lane
  // Court X-AB or Full Gym X => map to the single room number X (or both for combined)
  // Championship Court => same as courts 1 and 2 (both rooms)
  // Fieldhouse (courts 3–8) vs turf (full/half/quarter); ignore turf outside turf season.

  // --- Championship Court -> 1 and 2
  if (includesAny(f, ['championship court'])) return { rooms: ['1', '2'] };

  // --- Full gym combos
  if (includesAny(f, ['full gym 1ab & 2ab'])) return { rooms: ['1', '2'] };
  if (includesAny(f, ['full gym 9 & 10'])) return { rooms: ['9', '10'] };

  // --- Specific court ranges
  // “Court 1-AB”, “Court 2-AB”, “Court 9-AB”, “Court 10-AB”
  const courtAB = f.match(/court\s+(1|2|9|10)-ab/);
  if (courtAB) return { rooms: [courtAB[1]] };

  // Single specific court “- Court N”
  const fieldhouseCourt = f.match(/fieldhouse\s*-\s*court\s*(3|4|5|6|7|8)/);
  if (fieldhouseCourt) return { rooms: [fieldhouseCourt[1]] };

  // Group range “Fieldhouse Court 3-8”
  if (includesAny(f, ['fieldhouse court 3-8'])) return { rooms: ['3','4','5','6','7','8'] };

  // Half Court lanes A/B
  const halfCourt = f.match(/ac gym - half court\s*(1|2|9|10)\s*([ab])/);
  if (halfCourt) {
    const room = halfCourt[1];
    const lane = halfCourt[2].toUpperCase();
    return { rooms: [room], lane };
  }

  // “AC Gym - Court X-AB”
  const acGymCourtAB = f.match(/ac gym - court\s*(1|2|9|10)-ab/);
  if (acGymCourtAB) return { rooms: [acGymCourtAB[1]] };

  // Turf labels (only when turf season)
  const turfLabels = [
    'full turf',
    'half turf north',
    'half turf south',
    'quarter turf na',
    'quarter turf nb',
    'quarter turf sa',
    'quarter turf sb'
  ];
  if (turfLabels.some(t => f.includes(t))) {
    if (!turfSeason) return { rooms: [] }; // ignore turf when courts are down
    // During turf season, we still display by turf “zones” using 3–8 boxes:
    // Full turf => show across 3–8; half north => 6–8; half south => 3–5; quarters map to single courts.
    if (f.includes('full turf')) return { rooms: ['3','4','5','6','7','8'] };
    if (f.includes('half turf north')) return { rooms: ['6','7','8'] };
    if (f.includes('half turf south')) return { rooms: ['3','4','5'] };
    if (f.includes('quarter turf na')) return { rooms: ['6'] };
    if (f.includes('quarter turf nb')) return { rooms: ['7'] };
    if (f.includes('quarter turf sa')) return { rooms: ['3'] };
    if (f.includes('quarter turf sb')) return { rooms: ['4'] };
  }

  // Plain “AC Gym - Court X” (rare)
  const acCourtSingle = f.match(/ac gym - court\s*(1|2|9|10)\b/);
  if (acCourtSingle) return { rooms: [acCourtSingle[1]] };

  // If we reach here and it’s a half/quarter/fieldhouse generic we can’t map -> []
  return { rooms: [] };
}

function isPickleball(row) {
  const purpose = (row['Reservation Purpose'] || row['reservationpurpose'] || '').toLowerCase();
  return purpose.includes('pickleball');
}
function cleanTitle(reservee) {
  const t = normalize(reservee);
  if (!t) return t;
  // collapse "Extreme Volleyball, Extreme Volleyball" -> "Extreme Volleyball"
  const parts = t.split(',').map(s => s.trim()).filter(Boolean);
  const uniq = [];
  for (const p of parts) if (!uniq.includes(p)) uniq.push(p);
  return uniq.join(', ');
}

// ---------- Main ----------
async function run() {
  // Read CSV
  if (!fs.existsSync(CSV_PATH)) {
    console.log('No CSV found; writing empty scaffold.');
    return writeJson({ rooms: defaultRooms(), slots: [], dayStartMin: 360, dayEndMin: 1380 });
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

  // Determine season (UTC date so it’s deterministic in GH Actions too)
  const today = new Date(); // local is fine for signage; change to UTC if you prefer
  const turfSeason = isTurfSeason(new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())));

  const slots = [];
  const dayStartMin = 360;  // 6:00a
  const dayEndMin   = 1380; // 11:00p

  // Collect events raw
  for (const r of rows) {
    const loc = normalize(r['location'] || r['Location:']);
    if (loc && loc !== 'Athletic & Event Center') {
      // your instruction: ignore other locations (report is for RAEC only)
      continue;
    }
    const fac = normalize(r['facility']);
    const rt  = normalize(r['reserved time'] || r['reservedtime']);
    const titleRaw = r['reservee'];
    const purpose = r['reservation purpose'] || r['reservationpurpose'] || '';

    const tr = parseTimeRange(rt);
    if (!tr) continue;
    const clamped = clampDay(tr.startMin, tr.endMin, dayStartMin, dayEndMin);
    if (!clamped) continue;

    // Replace "RAEC Front Desk..." + purpose contains "Pickleball" => show "Open Pickleball"
    let title = cleanTitle(titleRaw);
    if (isPickleball(r)) title = 'Open Pickleball';

    const mapped = mapFacilityToRooms(fac, turfSeason);
    const rooms = mapped.rooms || [];
    const lane = mapped.lane; // A or B when Half Court

    for (const room of rooms) {
      slots.push({
        roomId: room,
        startMin: clamped.startMin,
        endMin: clamped.endMin,
        title,
        subtitle: normalize(purpose),
        lane
      });
    }
  }

  // Fieldhouse “3–8” vs specific per-court de-dup:
  // If an event targets general set (3..8) and there is a matching event for a specific court in the same time window
  // with the same title, drop the general one for that court to avoid duplicates.
  const result = dedupeFieldhouse(slots);

  // Sort by time then title
  result.sort((a, b) => a.startMin - b.startMin || (a.title || '').localeCompare(b.title || ''));

  const payload = {
    dayStartMin,
    dayEndMin,
    rooms: defaultRooms(), // fixed 1..10 with groups
    slots: result
  };

  writeJson(payload);
}

// Build fixed room list 1..10
function defaultRooms() {
  return [
    { id: '1', label: '1', group: 'south' },
    { id: '2', label: '2', group: 'south' },
    { id: '3', label: '3', group: 'fieldhouse' },
    { id: '4', label: '4', group: 'fieldhouse' },
    { id: '5', label: '5', group: 'fieldhouse' },
    { id: '6', label: '6', group: 'fieldhouse' },
    { id: '7', label: '7', group: 'fieldhouse' },
    { id: '8', label: '8', group: 'fieldhouse' },
    { id: '9', label: '9', group: 'north' },
    { id: '10', label: '10', group: 'north' }
  ];
}

function overlaps(a, b) {
  return a.startMin < b.endMin && b.startMin < a.endMin;
}
function dedupeFieldhouse(slots) {
  const field = new Set(['3','4','5','6','7','8']);
  const byRoom = new Map(); // roomId -> slots[]
  for (const s of slots) {
    if (!byRoom.has(s.roomId)) byRoom.set(s.roomId, []);
    byRoom.get(s.roomId).push(s);
  }

  // For each general “3-8” source, we can’t easily detect, but we approximate:
  // If a slot appears for multiple fieldhouse rooms with same title/time, and also appears for a single
  // specific room with same title/time, drop the “duplicate” general in that room.
  // We detect multi-room clones by a key.
  const key = s => `${s.title}|${s.startMin}|${s.endMin}|${s.subtitle || ''}`;

  // Gather keys that appear in multiple fieldhouse rooms
  const keyRooms = new Map(); // key -> Set(rooms)
  for (const s of slots) {
    if (!field.has(s.roomId)) continue;
    const k = key(s);
    if (!keyRooms.has(k)) keyRooms.set(k, new Set());
    keyRooms.get(k).add(s.roomId);
  }

  // If an event also appears as a “unique specific” (e.g., “- Court 6”) we keep the specific instance.
  // Here we approximate: if key appears 3+ rooms AND also appears in a single-room occurrence
  // that we consider “specific”, we will drop the general from the rooms that also have a “specific duplicate”.
  // (In practice, your CSV provides both the range row and per-court rows for the actual assignment.)
  const toDrop = new Set(); // indexes of slots to drop
  // Build fast lookup by key + room
  const byKeyRoom = new Map(); // k|room -> [indices]
  slots.forEach((s, idx) => {
    const k = key(s);
    const kr = `${k}|${s.roomId}`;
    if (!byKeyRoom.has(kr)) byKeyRoom.set(kr, []);
    byKeyRoom.get(kr).push(idx);
  });

  for (const [k, rooms] of keyRooms.entries()) {
    if (rooms.size <= 1) continue; // only a single room has it—fine
    // If the same k has any explicit single-room rows in the CSV (we treat presence itself as specificity),
    // then for each of those rooms, drop the duplicates in that room beyond one instance.
    for (const r of rooms) {
      const list = byKeyRoom.get(`${k}|${r}`) || [];
      // keep only one (the “specific”) — drop others
      for (let i = 1; i < list.length; i++) toDrop.add(list[i]);
    }
  }

  return slots.filter((_, idx) => !toDrop.has(idx));
}

function writeJson(obj) {
  fs.writeFileSync(JSON_OUT, JSON.stringify(obj, null, 2));
  console.log(`Wrote ${JSON_OUT} • rooms=${Array.isArray(obj.rooms)?obj.rooms.length:0} • slots=${Array.isArray(obj.slots)?obj.slots.length:0}`);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
