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

// Do NOT strip trailing "("; keep org names intact (e.g. D1 Training (Stay 22uned, Inc.))
function personFromLastFirst(s) {
  const t = clean(s);
  if (!t) return '';
  if (t.includes(',')) {
    const [left, ...rest] = t.split(',');
    const right = rest.join(',').trim();
    if (/^[A-Za-z'.-]+\s+[A-Za-z'.-]+/.test(right) && /^[A-Za-z'.-]+$/.test(left.trim())) {
      return `${right} ${left}`.replace(/\s+/g, ' ').trim();
    }
  }
  return t;
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

// truly non-display maintenance items
function isInstallOrInternal(purpose) {
  const t = String(purpose || '').toLowerCase();
  return (
    /turf install per nm/.test(t) ||
    /fieldhouse installed per nm/.test(t) ||
    /internal hold per nm/.test(t)
  );
}

// e.g. “Volleyball - Hold per NM for WELCH VB” -> title “Welch VB”, subtitle “Volleyball”
function extractWelchOrSimilarFromPurpose(purpose) {
  const p = String(purpose || '');
  const sportMatch = p.match(/^(Volleyball|Basketball|Soccer|Flag Football|Pickleball)\b/i);
  const whoMatch   = p.match(/for\s+(.+?)\s*$/i);
  if (whoMatch) {
    const title    = clean(whoMatch[1]);
    const subtitle = sportMatch ? sportMatch[1] : '';
    if (title) return { title, subtitle };
  }
  return null;
}

function normalizeCatchCornerTitle(reservee, purpose) {
  const combined = `${reservee} ${purpose}`;
  if (/catch\s*corner/i.test(combined) || /catchcorner/i.test(combined)) {
    return 'Catch Corner';
  }
  return null;
}

function mapFacilityToRooms(facility) {
  const f = clean(facility).toLowerCase();

  // South (1/2 families)
  if (/ac gym - half court 1a/i.test(f)) return ['1A'];
  if (/ac gym - half court 1b/i.test(f)) return ['1B'];
  if (/ac gym - court 1-ab/i.test(f))    return ['1A','1B'];

  if (/ac gym - half court 2a/i.test(f)) return ['2A'];
  if (/ac gym - half court 2b/i.test(f)) return ['2B'];
  if (/ac gym - court 2-ab/i.test(f))    return ['2A','2B'];

  if (/full gym 1ab & 2ab/i.test(f) || /championship court/i.test(f)) return ['1A','1B','2A','2B'];

  // North (9/10 families)
  if (/ac gym - half court 9a/i.test(f)) return ['9A'];
  if (/ac gym - half court 9b/i.test(f)) return ['9B'];
  if (/ac gym - court 9-ab/i.test(f))    return ['9A','9B'];

  if (/ac gym - half court 10a/i.test(f)) return ['10A'];
  if (/ac gym - half court 10b/i.test(f)) return ['10B'];
  if (/ac gym - court 10-ab/i.test(f))    return ['10A','10B'];

  if (/full gym 9 & 10/i.test(f))         return ['9A','9B','10A','10B'];

  // Fieldhouse floor (3..8 courts)
  if (/^ac fieldhouse - court\s*([3-8])$/i.test(clean(facility))) {
    return [String(RegExp.$1)];
  }
  if (/ac fieldhouse - court 3-8/i.test(f)) return ['3','4','5','6','7','8'];

  // Turf
  if (/ac fieldhouse - full turf/i.test(f)) return ['QT-ALL'];
  if (/ac fieldhouse - half turf north/i.test(f)) return ['QT-NA','QT-NB'];
  if (/ac fieldhouse - half turf south/i.test(f)) return ['QT-SA','QT-SB'];
  if (/ac fieldhouse - quarter turf na/i.test(f)) return ['QT-NA'];
  if (/ac fieldhouse - quarter turf nb/i.test(f)) return ['QT-NB'];
  if (/ac fieldhouse - quarter turf sa/i.test(f)) return ['QT-SA'];
  if (/ac fieldhouse - quarter turf sb/i.test(f)) return ['QT-SB'];

  return [];
}

// turf season if we see Full Turf + “Turf Install per NM” in purpose anywhere in the CSV
function isTurfSeason(allRows) {
  // True if ANY Fieldhouse row mentions Quarter/Half/Full Turf,
  // OR if any Fieldhouse row's purpose says "Turf Install per NM".
  return allRows.some(r => {
    const fac = String(r.facility || '').toLowerCase();
    const pur = String(r.purpose  || '').toLowerCase();
    const isFieldhouse = /ac\s*fieldhouse/i.test(fac);
    const mentionsTurf =
      /quarter turf|half turf|full turf/.test(fac) || /turf install per nm/.test(pur);
    return isFieldhouse && mentionsTurf;
  });
}

  // Pickleball: any mention
  if (/pickleball/i.test(r) || /pickleball/i.test(purpose || '')) {
    return { title: 'Open Pickleball', subtitle: '' };
  }

  // Catch Corner normalization (strip noisy suffix, keep clean subtitle)
  const cc = normalizeCatchCornerTitle(r, purpose);
  if (cc) {
    const sub = clean(String(purpose || '')
      .replace(/Catch\s*Corner|CatchCorner/ig,'')
      .replace(/\(Prolific.*?\)/i,'')
      .replace(/Booking\s*#\d+/ig,'')
    ).trim();
    return { title: cc, subtitle: sub };
  }

  // RAEC Front Desk “for WELCH VB”
  if (/^raec\s*front\s*desk/i.test(r)) {
    const wh = extractWelchOrSimilarFromPurpose(purpose);
    if (wh) return wh;
  }

  // default
  return { title: r, subtitle: clean(purpose) };
}

function overlaps(a, b) { return a.startMin < b.endMin && b.startMin < a.endMin; }

function familyOf(roomId) {
  if (['1A','1B','2A','2B'].includes(roomId)) return 'south';
  if (['9A','9B','10A','10B'].includes(roomId)) return 'north';
  if (['3','4','5','6','7','8'].includes(roomId)) return 'fieldhouse-courts';
  if (/^QT-/.test(roomId)) return 'fieldhouse-turf';
  return 'other';
}

// -------------------- MAIN --------------------
function main() {
  // empty file -> scaffold
  if (!fs.existsSync(INPUT_CSV) || fs.statSync(INPUT_CSV).size === 0) {
    writeScaffold([]);
    console.log('transform: empty CSV');
    return;
  }

  const raw = fs.readFileSync(INPUT_CSV, 'utf8');
  const rowsCsv = parseCSV(raw);
  if (!rowsCsv.length) {
    writeScaffold([]);
    console.log('transform: no rows');
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

  const now = new Date();
  const nowMin = now.getHours()*60 + now.getMinutes();
  const GRACE = 10;

  // Build raw items
  const items = [];
  for (const r of rows) {
    if (!/athletic\s*&\s*event\s*center/i.test(r.location || '')) continue;
    if (!r.facility || !r.time) continue;

    // skip only the pure maintenance/internal items
    if (isInstallOrInternal(r.purpose)) continue;

    const range = rangeToMinutes(r.time);
    if (!range) continue;
    if (range.endMin < (nowMin - GRACE)) continue;

    let rooms = mapFacilityToRooms(r.facility);

    // Turf expansion
    if (turfMode && rooms.includes('QT-ALL')) {
      rooms = ['QT-NA','QT-NB','QT-SA','QT-SB'];
    }

    if (!rooms.length) continue;

    const { title, subtitle } = toDisplay(r.reservee, r.purpose);

    items.push({
      rooms,
      startMin: range.startMin,
      endMin:   range.endMin,
      title, subtitle,
      orgKey: title.toLowerCase().replace(/\s+/g,' ').trim(),
      rawFacility: r.facility
    });
  }

  // Expand for blanket/specific resolution
  const expanded = [];
  for (const it of items) {
    for (const r of it.rooms) {
      expanded.push({
        roomId: r,
        startMin: it.startMin,
        endMin: it.endMin,
        title: it.title,
        subtitle: it.subtitle,
        orgKey: it.orgKey,
        rawRoomsCount: it.rooms.length
      });
    }
  }

  // Blanket vs specific rules:
  // - If a room occurrence comes from a row that emitted multiple rooms (rawRoomsCount > 1),
  //   then it's a blanket. Drop it when a same-org overlapping *specific* (rawRoomsCount==1)
  //   exists for that exact room.
  // - Additional enhancement: if NO specific exists for *either* half in the family window,
  //   keep the blanket so “Full Gym 1AB & 2AB” occupies all four when that’s all we have.
  const result = [];

  // Helper: find if any specific exists for same family/time/org
  function specificExistsForFamily(slot) {
    const fam = familyOf(slot.roomId);
    const famRooms = {
      south: ['1A','1B','2A','2B'],
      north: ['9A','9B','10A','10B'],
      'fieldhouse-courts': ['3','4','5','6','7','8'],
      'fieldhouse-turf': ['QT-NA','QT-NB','QT-SA','QT-SB']
    }[fam] || [slot.roomId];

    return expanded.some(sp =>
      sp !== slot &&
      famRooms.includes(sp.roomId) &&
      sp.orgKey === slot.orgKey &&
      sp.rawRoomsCount === 1 &&
      overlaps(sp, slot)
    );
  }

  for (const slot of expanded) {
    if (slot.rawRoomsCount > 1) {
      // blanket
      const hasSpecificSameRoom = expanded.some(sp =>
        sp !== slot &&
        sp.roomId === slot.roomId &&
        sp.orgKey === slot.orgKey &&
        sp.rawRoomsCount === 1 &&
        overlaps(sp, slot)
      );
      if (hasSpecificSameRoom) continue;

      // if no specific in the whole family, keep blanket so it occupies the family
      // otherwise, keep blanket for rooms that were not covered by specifics
      // (the check above already drops the specific-covered room case)
      if (specificExistsForFamily(slot)) {
        // already dropped specific-covered rooms; keep this blanket for uncovered rooms
        result.push({ ...slot });
      } else {
        // no specifics anywhere: keep blanket (e.g., Chicago Sport & Social booking all courts)
        result.push({ ...slot });
      }
    } else {
      // specific
      result.push({ ...slot });
    }
  }

  // Final sort
  result.sort((a,b) => a.roomId.localeCompare(b.roomId) || a.startMin - b.startMin);

  // Write out
  writeScaffold(result);

  // Debug line
  const byRoom = {};
  for (const s of result) byRoom[s.roomId] = (byRoom[s.roomId]||0)+1;
  console.log(`transform: season=${turfMode ? 'turf' : 'courts'} • slots=${result.length} • byRoom=${JSON.stringify(byRoom)}`);
}

function writeScaffold(slots) {
  // If any slot is QT-*, we’re clearly turf. Otherwise fall back to detector
  const inferredTurf = slots.some(s => /^QT-/.test(s.roomId));
  const fieldhouseMode = inferredTurf ? 'turf' : 'courts';

  const out = {
    dayStartMin: 360,
    dayEndMin: 1380,
    fieldhouseMode,               // <— NEW: tells the UI how to lay out the middle column
    rooms: [
      { id: '1A',  label: '1A', group: 'south' },
      { id: '1B',  label: '1B', group: 'south' },
      { id: '2A',  label: '2A', group: 'south' },
      { id: '2B',  label: '2B', group: 'south' },

      // Court-season IDs (the UI swaps to QT-* when fieldhouseMode === 'turf')
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
  fs.writeFileSync(OUTPUT_JSON, JSON.stringify(out, null, 2));
}

main();
