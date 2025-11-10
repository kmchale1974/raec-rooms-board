#!/usr/bin/env node
// scripts/transform.mjs
// Build events.json from latest CSV with RAEC-specific rules.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ---------- Paths ----------
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const INPUT_CSV   = process.env.IN_CSV  || path.join(__dirname, '..', 'data', 'inbox', 'latest.csv');
const OUTPUT_JSON = process.env.OUT_JSON || path.join(__dirname, '..', 'events.json');

// ---------- Small CSV parser (handles quotes & commas) ----------
function parseCSV(text) {
  const rows = [];
  let i = 0, cur = [], cell = '', inQ = false;
  while (i < text.length) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i += 2; continue; }
        inQ = false; i++; continue;
      }
      cell += ch; i++; continue;
    }
    if (ch === '"') { inQ = true; i++; continue; }
    if (ch === ',') { cur.push(cell); cell = ''; i++; continue; }
    if (ch === '\n') { cur.push(cell); rows.push(cur); cur = []; cell = ''; i++; continue; }
    if (ch === '\r') { i++; continue; }
    cell += ch; i++;
  }
  cur.push(cell); rows.push(cur);
  // trim trailing empty line
  if (rows.length && rows[rows.length - 1].every(x => x === '')) rows.pop();
  return rows;
}

function indexOfHeader(headers, name) {
  const needle = name.trim().toLowerCase();
  return headers.findIndex(h => String(h || '').trim().toLowerCase() === needle);
}

function clean(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

function personFromLastFirst(s) {
  const t = clean(s);
  if (!t) return '';
  // strip dangling "("
  const cleaned = t.replace(/\s*\($/, '');
  if (cleaned.includes(',')) {
    const [left, ...rest] = cleaned.split(',');
    const right = rest.join(',').trim();
    if (/^[A-Za-z'.-]+\s+[A-Za-z'.-]+/.test(right) && /^[A-Za-z'.-]+$/.test(left.trim())) {
      return `${right} ${left}`.replace(/\s+/g, ' ').trim();
    }
  }
  return cleaned;
}

function rangeToMinutes(text) {
  const m = String(text||'').match(/(\d{1,2}):(\d{2})\s*([ap])m\s*-\s*(\d{1,2}):(\d{2})\s*([ap])m/i);
  if (!m) return null;
  const toMin = (hh, mm, ap) => {
    let h = parseInt(hh, 10) % 12;
    if (ap.toLowerCase() === 'p') h += 12;
    return h * 60 + parseInt(mm, 10);
  };
  return { startMin: toMin(m[1],m[2],m[3]), endMin: toMin(m[4],m[5],m[6]) };
}

function isInstallOrInternal(purpose) {
  const t = String(purpose || '').toLowerCase();
  // These are truly non-display items
  return (
    /turf install per nm/.test(t) ||
    /fieldhouse installed per nm/.test(t) ||
    /internal hold per nm/.test(t)
  );
}

function extractWelchOrSimilarFromPurpose(purpose) {
  // Examples:
  // "Volleyball - Hold per NM for WELCH VB" => {title: "Welch VB", subtitle: "Volleyball"}
  const p = String(purpose || '');
  const sportMatch = p.match(/^(Volleyball|Basketball|Soccer|Flag Football|Pickleball)\b/i);
  const whoMatch   = p.match(/for\s+(.+?)\s*$/i);
  if (whoMatch) {
    const title    = clean(whoMatch[1].replace(/VB$/i, 'VB')); // leave as is
    const subtitle = sportMatch ? sportMatch[1] : '';
    if (title) return { title, subtitle };
  }
  return null;
}

function normalizeCatchCornerTitle(purpose) {
  // "CatchCorner (Prolific Basketball Booking #438632)" -> "Catch Corner"
  const t = String(purpose || '');
  if (/catch\s*corner/i.test(t) || /catchcorner/i.test(t)) {
    return 'Catch Corner';
  }
  return null;
}

function mapFacilityToRooms(facility) {
  const f = clean(facility).toLowerCase();

  // South 1/2
  if (/ac gym - half court 1a/i.test(f)) return ['1A'];
  if (/ac gym - half court 1b/i.test(f)) return ['1B'];
  if (/ac gym - court 1-ab/i.test(f))    return ['1A','1B'];

  if (/ac gym - half court 2a/i.test(f)) return ['2A'];
  if (/ac gym - half court 2b/i.test(f)) return ['2B'];
  if (/ac gym - court 2-ab/i.test(f))    return ['2A','2B'];

  if (/full gym 1ab & 2ab/i.test(f) || /championship court/i.test(f)) return ['1A','1B','2A','2B'];

  // North 9/10
  if (/ac gym - half court 9a/i.test(f)) return ['9A'];
  if (/ac gym - half court 9b/i.test(f)) return ['9B'];
  if (/ac gym - court 9-ab/i.test(f))    return ['9A','9B'];

  if (/ac gym - half court 10a/i.test(f)) return ['10A'];
  if (/ac gym - half court 10b/i.test(f)) return ['10B'];
  if (/ac gym - court 10-ab/i.test(f))    return ['10A','10B'];

  if (/full gym 9 & 10/i.test(f))         return ['9A','9B','10A','10B'];

  // Fieldhouse floor (3..8 when courts down)
  if (/ac fieldhouse - court\s*([3-8])$/i.test(clean(facility))) {
    return [String(RegExp.$1)];
  }
  if (/ac fieldhouse - court 3-8/i.test(f)) return ['3','4','5','6','7','8'];

  // Turf (we'll detect season separately)
  if (/ac fieldhouse - full turf/i.test(f)) return ['QT-ALL'];
  if (/ac fieldhouse - half turf north/i.test(f)) return ['QT-NA','QT-NB']; // north halves
  if (/ac fieldhouse - half turf south/i.test(f)) return ['QT-SA','QT-SB']; // south halves
  if (/ac fieldhouse - quarter turf na/i.test(f)) return ['QT-NA'];
  if (/ac fieldhouse - quarter turf nb/i.test(f)) return ['QT-NB'];
  if (/ac fieldhouse - quarter turf sa/i.test(f)) return ['QT-SA'];
  if (/ac fieldhouse - quarter turf sb/i.test(f)) return ['QT-SB'];

  return [];
}

function isTurfSeason(rows) {
  // turf when we see Full Turf + purpose mentions "Turf Install per NM"
  return rows.some(r =>
    /ac fieldhouse - full turf/i.test(r.facility || '') &&
    /turf install per nm/i.test(r.purpose || '')
  );
}

function toDisplayTitle(reservee, purpose) {
  const r = personFromLastFirst(reservee);
  // Pickleball override by either field
  if (/pickleball/i.test(r) || /pickleball/i.test(purpose || '')) {
    return { title: 'Open Pickleball', subtitle: '' };
  }
  // Catch Corner normalization
  const cc = normalizeCatchCornerTitle(purpose) || (/\bcatch\s*corner\b/i.test(r) ? 'Catch Corner' : null);
  if (cc) return { title: cc, subtitle: clean(purpose).replace(/Catch\s*Corner|CatchCorner/ig,'').replace(/\s+/g,' ').trim() };

  // RAEC Front Desk … “for WELCH VB”
  if (/^raec\s*front\s*desk/i.test(r)) {
    const wh = extractWelchOrSimilarFromPurpose(purpose);
    if (wh) return wh;
  }

  return { title: r, subtitle: clean(purpose) };
}

function overlaps(a, b) {
  return a.startMin < b.endMin && b.startMin < a.endMin;
}

// -------------------- MAIN --------------------
function main() {
  if (!fs.existsSync(INPUT_CSV) || fs.statSync(INPUT_CSV).size === 0) {
    const empty = scaffold([]);
    fs.writeFileSync(OUTPUT_JSON, JSON.stringify(empty, null, 2));
    console.log('transform: empty CSV -> empty scaffold');
    return;
  }

  const raw = fs.readFileSync(INPUT_CSV, 'utf8');
  const rowsCsv = parseCSV(raw);
  if (!rowsCsv.length) {
    const empty = scaffold([]);
    fs.writeFileSync(OUTPUT_JSON, JSON.stringify(empty, null, 2));
    console.log('transform: no rows -> empty scaffold');
    return;
  }

  const headers = rowsCsv[0];
  const iLoc = indexOfHeader(headers, 'Location:');
  const iFac = indexOfHeader(headers, 'Facility');
  const iTime= indexOfHeader(headers, 'Reserved Time');
  const iRes = indexOfHeader(headers, 'Reservee');
  const iPur = indexOfHeader(headers, 'Reservation Purpose');

  const rows = rowsCsv.slice(1).map(r => ({
    location: clean(r[iLoc]),
    facility: clean(r[iFac]),
    time:     clean(r[iTime]),
    reservee: clean(r[iRes]),
    purpose:  clean(r[iPur]),
  }));

  const turfMode = isTurfSeason(rows);

  const keep = [];
  const now = new Date();
  const nowMin = now.getHours()*60 + now.getMinutes();
  const GRACE = 10;

  for (const r of rows) {
    if (!/athletic\s*&\s*event\s*center/i.test(r.location || '')) continue;
    if (!r.facility || !r.time) continue;

    // Skip maintenance/internal only
    if (isInstallOrInternal(r.purpose)) continue;

    const range = rangeToMinutes(r.time);
    if (!range) continue;
    if (range.endMin < (nowMin - GRACE)) continue; // too far past

    let rooms = mapFacilityToRooms(r.facility);

    // Turf full -> expand to quarters
    if (turfMode) {
      if (rooms.includes('QT-ALL')) rooms = ['QT-NA','QT-NB','QT-SA','QT-SB'];
    }

    if (!rooms.length) continue;

    const { title, subtitle } = toDisplayTitle(r.reservee, r.purpose);

    keep.push({
      rooms,
      startMin: range.startMin,
      endMin:   range.endMin,
      title, subtitle,
      keyOrg: title.toLowerCase().replace(/\s+/g,' ').trim(), // for merging
    });
  }

  // Blanket-vs-specific resolution per org+time window per *room family*
  // Families: [1A,1B,1AB,Full], [2A,2B,2AB,Full], [9A,9B,9AB,Full9&10], [10A,10B,9AB,10AB,Full9&10]
  // Implementation: expand every item to (roomId, start,end,title,subtitle),
  // then remove blanket occurrences when a more specific for same org/time exists for that exact room.
  const expanded = [];
  for (const it of keep) {
    for (const r of it.rooms) {
      expanded.push({
        roomId: r,
        startMin: it.startMin,
        endMin: it.endMin,
        title: it.title,
        subtitle: it.subtitle,
        keyOrg: it.keyOrg,
        rawRooms: it.rooms
      });
    }
  }

  function isBlanket(roomId, rawRooms) {
    // blanket if:
    // - south/north AB bookings or Full Gym rows emitted both halves (2 rooms or 4 rooms)
    if (['1A','1B','2A','2B'].includes(roomId)) {
      return rawRooms.length > 1; // Championship / 1-AB / Full Gym produced >1
    }
    if (['9A','9B','10A','10B'].includes(roomId)) {
      return rawRooms.length > 1;
    }
    // Fieldhouse courts: similar behavior (Court 3-8 blanket vs single)
    if (['3','4','5','6','7','8'].includes(roomId)) {
      return rawRooms.length > 1;
    }
    // Turf: QT-ALL expands to four rooms; specific quarters have rawRooms = 1
    if (/^QT-/.test(roomId)) {
      return rawRooms.length > 1;
    }
    return false;
  }

  const result = [];
  for (const slot of expanded) {
    if (isBlanket(slot.roomId, slot.rawRooms)) {
      // Only keep blanket if no specific same-org overlapping single exists for that same room
      const hasSpecific = expanded.some(sp =>
        sp !== slot &&
        sp.roomId === slot.roomId &&
        sp.keyOrg === slot.keyOrg &&
        sp.rawRooms.length === 1 &&     // specific
        overlaps(sp, slot)
      );
      if (hasSpecific) continue; // drop blanket for this room
    }
    result.push({
      roomId: slot.roomId,
      startMin: slot.startMin,
      endMin: slot.endMin,
      title: slot.title,
      subtitle: slot.subtitle
    });
  }

  // Final trim & sort per room/time
  result.sort((a,b) => a.roomId.localeCompare(b.roomId) || a.startMin - b.startMin);

  const out = scaffold(result);
  fs.writeFileSync(OUTPUT_JSON, JSON.stringify(out, null, 2));

  // Debug summary
  const byRoom = {};
  for (const s of result) byRoom[s.roomId] = (byRoom[s.roomId]||0)+1;
  console.log(`transform: season=${turfMode ? 'turf' : 'courts'} • slots=${result.length} • byRoom=${JSON.stringify(byRoom)}`);
}

// ---------- scaffold (rooms list stays constant, UI builds fieldhouse dynamically) ----------
function scaffold(slots) {
  return {
    dayStartMin: 360,
    dayEndMin: 1380,
    rooms: [
      { id: '1A',  label: '1A', group: 'south' },
      { id: '1B',  label: '1B', group: 'south' },
      { id: '2A',  label: '2A', group: 'south' },
      { id: '2B',  label: '2B', group: 'south' },
      { id: '3',   label: '3',  group: 'fieldhouse' },
      { id: '4',   label: '4',  group: 'fieldhouse' },
      { id: '5',   label: '5',  group: 'fieldhouse' },
      { id: '6',   label: '6',  group: 'fieldhouse' },
      { id: '7',   label: '7',  group: 'fieldhouse' },
      { id: '8',   label: '8',  group: 'fieldhouse' },
      { id: '9A',  label: '9A', group: 'north' },
      { id: '9B',  label: '9B', group: 'north' },
      { id: '10A', label: '10A',group: 'north' },
      { id: '10B', label: '10B',group: 'north' }
    ],
    slots
  };
}

main();
