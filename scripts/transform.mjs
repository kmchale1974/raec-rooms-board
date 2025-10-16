// scripts/transform.mjs
// Node 18+/20+ (ESM). Converts a CSV attachment into events.json for the client grid.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// -------- Config in via env --------
const CSV_PATH = process.env.CSV_PATH || 'data/inbox/latest.csv';
const JSON_OUT = process.env.JSON_OUT || 'events.json';
const SEASON_FORCE = process.env.SEASON_FORCE || ''; // 'turf' or 'court' for testing only

// -------- Helpers --------
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = p => fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';

function trim(s) { return (s || '').toString().trim(); }

function cleanReservee(s) {
  // Collapse “Name, Name” duplicates, and strip redundant repeating chunks
  const t = trim(s).replace(/\s+/g, ' ');
  // Remove simple “, <same text>” duplicates (case-insensitive)
  const parts = t.split(',').map(x => x.trim()).filter(Boolean);
  if (parts.length >= 2) {
    const first = parts[0];
    const dedup = [first];
    for (let i = 1; i < parts.length; i++) {
      if (parts[i].toLowerCase() !== first.toLowerCase()) dedup.push(parts[i]);
    }
    return dedup.join(', ');
  }
  return t;
}

function cleanPurpose(s) {
  return trim(s).replace(/\s+/g, ' ');
}

function parseTimeRange(range) {
  // "9:00am - 10:00pm" | "4:30pm -  6:00pm" → [startMin, endMin]
  const m = String(range).match(/(\d{1,2}:\d{2}\s*[ap]m)\s*-\s*(\d{1,2}:\d{2}\s*[ap]m)/i);
  if (!m) return null;
  const toMin = t => {
    const z = t.match(/(\d{1,2}):(\d{2})\s*([ap]m)/i);
    if (!z) return null;
    let h = parseInt(z[1], 10);
    const n = parseInt(z[2], 10);
    const ap = z[3].toLowerCase();
    if (ap === 'pm' && h !== 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
    return h * 60 + n;
  };
  const a = toMin(m[1]), b = toMin(m[2]);
  if (a == null || b == null) return null;
  return [a, b];
}

// --- Season windows ---
// Basketball-floor season: from 3rd Monday in March through 2nd Monday in November (inclusive).
function nthMonday(year, monthIdx, n) {
  // monthIdx 0=Jan. Return Date
  const d = new Date(Date.UTC(year, monthIdx, 1));
  // day 0=Sun..6=Sat -> want Monday=1
  const firstMon = (8 - d.getUTCDay()) % 7 || 7; // move to Mon of first week
  return new Date(Date.UTC(year, monthIdx, firstMon + 7 * (n - 1)));
}
function isBasketballFloorSeason(dateUTC) {
  const y = dateUTC.getUTCFullYear();
  const start = nthMonday(y, 2, 3);  // 3rd Mon in March
  const end = nthMonday(y, 10, 2);   // 2nd Mon in Nov
  // season is inclusive [start .. end)
  return dateUTC >= start && dateUTC < end;
}

// Fieldhouse detection
function isFieldhouseFacility(f) {
  return /^ac\s*fieldhouse/i.test(f);
}
function isFieldhouseCourtFacility(f) {
  // Basketball-floor court labels like: "AC Fieldhouse - Court 6" or "AC Fieldhouse Court 3-8"
  return /fieldhouse.*court/i.test(f);
}
function isFieldhouseTurfFacility(f) {
  // Turf labels
  return /fieldhouse.*turf/i.test(f) || /quarter\s*turf|half\s*turf/i.test(f);
}

// Expand “Court 3-8” into [3,4,5,6,7,8]
function expandCourtRange(fac) {
  const m = fac.match(/court\s*(\d)\s*-\s*(\d)/i);
  if (!m) return null;
  const a = parseInt(m[1], 10);
  const b = parseInt(m[2], 10);
  if (Number.isNaN(a) || Number.isNaN(b) || a > b) return null;
  const out = [];
  for (let i = a; i <= b; i++) out.push(i);
  return out;
}
function extractSpecificCourt(fac) {
  const m = fac.match(/court\s*(\d+)/i);
  return m ? parseInt(m[1], 10) : null;
}

// Map gym facilities to court numbers (1..10)
function mapGymToNumber(fac) {
  // Examples:
  // "AC Gym - Half Court 10A"   -> 10
  // "AC Gym - Court 10-AB"      -> 10
  // "AC Gym - Half Court 1B"    -> 1
  // "AC Gym - Championship Court" -> treat as both 1 and 2 (but we’ll dedupe ranges later)
  const s = fac.toLowerCase();
  if (s.includes('championship court')) return [1, 2];

  const mNum = s.match(/court\s*(\d{1,2})(?:-ab)?/i);
  if (mNum) {
    const n = parseInt(mNum[1], 10);
    if (n >= 1 && n <= 10) return [n];
  }
  const mHalf = s.match(/half\s*court\s*(\d{1,2})[ab]?/i);
  if (mHalf) {
    const n = parseInt(mHalf[1], 10);
    if (n >= 1 && n <= 10) return [n];
  }
  return null;
}

// Build rooms list based on season
function buildRooms(season) {
  // South gym: 1,2 • North gym: 9,10 always
  const south = [{ id: '1', label: '1', group: 'south' }, { id: '2', label: '2', group: 'south' }];
  const north = [{ id: '9', label: '9', group: 'north' }, { id: '10', label: '10', group: 'north' }];

  if (season === 'court') {
    const fh = [3,4,5,6,7,8].map(n => ({ id: String(n), label: String(n), group: 'fieldhouse' }));
    return [...south, ...fh, ...north];
  } else {
    // Turf season: we expose turf slices. We’ll include all 7 possible labels; unused ones just remain empty.
    // order: Full, Half N, Half S, Quarter NA, NB, SA, SB
    return [
      ...south,
      { id: 'FT',  label: 'Full Turf',        group: 'fieldhouse' },
      { id: 'HN',  label: 'Half Turf North',  group: 'fieldhouse' },
      { id: 'HS',  label: 'Half Turf South',  group: 'fieldhouse' },
      { id: 'QNA', label: 'Quarter Turf NA',  group: 'fieldhouse' },
      { id: 'QNB', label: 'Quarter Turf NB',  group: 'fieldhouse' },
      { id: 'QSA', label: 'Quarter Turf SA',  group: 'fieldhouse' },
      { id: 'QSB', label: 'Quarter Turf SB',  group: 'fieldhouse' },
      ...north,
    ];
  }
}

// Turf facility → room id mapping (turf season)
function turfRoomId(fac) {
  const s = fac.toLowerCase();
  if (s.includes('full turf')) return 'FT';
  if (s.includes('half turf') && s.includes('north')) return 'HN';
  if (s.includes('half turf') && s.includes('south')) return 'HS';
  if (/quarter\s*turf.*\bna\b/i.test(fac)) return 'QNA';
  if (/quarter\s*turf.*\bnb\b/i.test(fac)) return 'QNB';
  if (/quarter\s*turf.*\bsa\b/i.test(fac)) return 'QSA';
  if (/quarter\s*turf.*\bsb\b/i.test(fac)) return 'QSB';
  return null;
}

// Dedupe: drop “Court 3-8” if specific court(s) exist for same reservee and overlapping time
function shouldDropRange(rangeSlot, specificSlots) {
  // rangeSlot: { courts: [3..8], startMin, endMin, titleKey }
  // specificSlots: list of { court, startMin, endMin, titleKey }
  // If *every* court in range has an overlapping specific match for the same titleKey, drop the range.
  return rangeSlot.courts.every(c =>
    specificSlots.some(s =>
      s.court === c &&
      s.titleKey === rangeSlot.titleKey &&
      !(s.endMin <= rangeSlot.startMin || s.startMin >= rangeSlot.endMin)
    )
  );
}

function titleKeyForCompare(reservee, purpose) {
  return `${cleanReservee(reservee)}|${cleanPurpose(purpose)}`.toLowerCase();
}

// -------- Main --------

const csv = read(CSV_PATH);
if (!csv) {
  console.log('No CSV found; writing scaffold.');
  const rooms = buildRooms('court'); // harmless default
  fs.writeFileSync(JSON_OUT, JSON.stringify({ dayStartMin: 360, dayEndMin: 1380, rooms, slots: [] }, null, 2));
  process.exit(0);
}

// detect headers
// We support both "Location:" and "Location" (some exports have a colon).
const lines = csv.split(/\r?\n/).filter(Boolean);
const header = lines[0].split(',').map(h => h.trim().replace(/:$/, ''));
const idx = (name) => header.findIndex(h => h.toLowerCase() === name.toLowerCase());

const ixLocation = idx('Location') !== -1 ? idx('Location') : idx('Location');
const ixFacility = idx('Facility');
const ixReserved = idx('Reserved Time');
const ixReservee = idx('Reservee');
const ixPurpose  = idx('Reservation Purpose');
const ixHead     = idx('Headcount');

let dateUTC = new Date(); // run time
let season = isBasketballFloorSeason(dateUTC) ? 'court' : 'turf';
if (SEASON_FORCE === 'court' || SEASON_FORCE === 'turf') season = SEASON_FORCE;

const rooms = buildRooms(season);

// Parse rows
const rawSlots = [];
for (let i = 1; i < lines.length; i++) {
  const row = lines[i].split(',').map(x => x.trim());
  if (!row.length || row.length < header.length) continue;

  const location = trim(row[ixLocation] || row[ixLocation === -1 ? 0 : ixLocation]); // be resilient
  if (location && !/^athletic\s*&?\s*event\s*center/i.test(location)) {
    // Per your rule: ignore rows not for RAEC unless location differs (this report is only RAEC)
    continue;
  }

  const fac = trim(row[ixFacility]);
  const time = trim(row[ixReserved]);
  const reservee = cleanReservee(row[ixReservee]);
  const purpose = cleanPurpose(row[ixPurpose]);
  const timePair = parseTimeRange(time);
  if (!fac || !timePair) continue;
  const [startMin, endMin] = timePair;

  // GYM (south/north) mapping (always active year-round)
  const gymNums = mapGymToNumber(fac) || [];
  if (gymNums.length) {
    const tkey = titleKeyForCompare(reservee, purpose);
    for (const n of gymNums) {
      rawSlots.push({
        source: 'gym',
        roomId: String(n),
        startMin, endMin,
        title: reservee,
        subtitle: purpose,
        titleKey: tkey,
      });
    }
    continue;
  }

  // FIELDHOUSE
  const isFH = isFieldhouseFacility(fac);
  if (!isFH) continue;

  if (season === 'court') {
    // Ignore *turf* facilities during court season
    if (isFieldhouseTurfFacility(fac)) continue;

    // Accept “Court N” or “Court A-B”
    const courtsFromRange = expandCourtRange(fac);
    const courtSpecific = extractSpecificCourt(fac);
    const tkey = titleKeyForCompare(reservee, purpose);

    if (courtsFromRange) {
      rawSlots.push({
        source: 'fh-range',
        courts: courtsFromRange.slice(),
        startMin, endMin,
        title: reservee,
        subtitle: purpose,
        titleKey: tkey,
      });
    } else if (courtSpecific && courtSpecific >= 3 && courtSpecific <= 8) {
      rawSlots.push({
        source: 'fh-specific',
        court: courtSpecific,
        roomId: String(courtSpecific),
        startMin, endMin,
        title: reservee,
        subtitle: purpose,
        titleKey: tkey,
      });
    }
  } else {
    // Turf season: ignore “Court N” or “Court 3-8” labels; accept turf labels
    if (isFieldhouseCourtFacility(fac)) continue;
    const rid = turfRoomId(fac);
    if (!rid) continue;
    const tkey = titleKeyForCompare(reservee, purpose);
    rawSlots.push({
      source: 'turf',
      roomId: rid,
      startMin, endMin,
      title: reservee,
      subtitle: purpose,
      titleKey: tkey,
    });
  }
}

// Dedupe: drop fieldhouse range rows that are fully covered by specifics for the same titleKey/time overlap
let slotsOut = [];
if (season === 'court') {
  const specifics = rawSlots.filter(s => s.source === 'fh-specific');
  const ranges = rawSlots.filter(s => s.source === 'fh-range');

  for (const r of ranges) {
    if (!shouldDropRange(r, specifics)) {
      // expand range into per-court slots (for courts not covered by specifics of same titleKey)
      for (const c of r.courts) {
        const covered = specifics.some(s =>
          s.court === c &&
          s.titleKey === r.titleKey &&
          !(s.endMin <= r.startMin || s.startMin >= r.endMin)
        );
        if (!covered) {
          slotsOut.push({
            source: 'fh-range-expanded',
            roomId: String(c),
            startMin: r.startMin,
            endMin: r.endMin,
            title: r.title,
            subtitle: r.subtitle
          });
        }
      }
    }
  }
  // keep specifics as-is
  for (const s of specifics) {
    slotsOut.push({
      roomId: s.roomId, startMin: s.startMin, endMin: s.endMin, title: s.title, subtitle: s.subtitle
    });
  }
  // plus all gym slots
  for (const g of rawSlots.filter(s => s.source === 'gym')) {
    slotsOut.push({
      roomId: g.roomId, startMin: g.startMin, endMin: g.endMin, title: g.title, subtitle: g.subtitle
    });
  }
} else {
  // Turf season: keep turf + gym
  for (const s of rawSlots) {
    slotsOut.push({
      roomId: s.roomId, startMin: s.startMin, endMin: s.endMin, title: s.title, subtitle: s.subtitle
    });
  }
}

// Clamp to building hours (6:00–23:00)
const dayStartMin = 6 * 60;
const dayEndMin = 23 * 60;
slotsOut = slotsOut
  .map(s => ({ ...s, startMin: Math.max(dayStartMin, s.startMin), endMin: Math.min(dayEndMin, s.endMin) }))
  .filter(s => s.endMin > s.startMin);

// Final JSON
const out = {
  dayStartMin,
  dayEndMin,
  rooms,   // array with group metadata
  slots: slotsOut
};

fs.writeFileSync(JSON_OUT, JSON.stringify(out, null, 2));
console.log(`Wrote ${JSON_OUT} • rooms=${rooms.length} • slots=${slotsOut.length} • Season=${season}`);
