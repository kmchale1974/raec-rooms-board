#!/usr/bin/env node
// scripts/transform.mjs — build events.json from latest CSV

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parse } from 'csv-parse/sync';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const INPUT_CSV   = process.env.IN_CSV   || path.join(__dirname, '..', 'data', 'inbox', 'latest.csv');
const OUTPUT_JSON = process.env.OUT_JSON || path.join(__dirname, '..', 'events.json');

// ---------- tiny utils ----------
const clean = s => String(s ?? '').replace(/\s+/g, ' ').trim();

function parseRangeToMinutes(text) {
  if (!text) return null;
  const m = String(text).match(/(\d{1,2}:\d{2}\s*[ap]m)\s*-\s*(\d{1,2}:\d{2}\s*[ap]m)/i);
  if (!m) return null;
  return { startMin: toMin(m[1]), endMin: toMin(m[2]) };
}
function toMin(hhmmampm) {
  const s = String(hhmmampm).trim().toLowerCase();
  const m = s.match(/^(\d{1,2}):(\d{2})\s*([ap])m$/);
  if (!m) return null;
  let h  = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  const mer = m[3];
  if (h === 12) h = 0;
  if (mer === 'p') h += 12;
  return h * 60 + mm;
}

function nowMinutes() {
  const d = new Date();
  return d.getHours()*60 + d.getMinutes();
}

// ---------- normalize reservee & titles ----------
function normalizePerson(lastCommaFirst) {
  const s = clean(lastCommaFirst);
  const parts = s.split(',').map(p => p.trim()).filter(Boolean);
  if (parts.length >= 2 && /^[A-Za-z'.-]+$/.test(parts[0])) {
    // "Last, First ..." → "First Last"
    return `${parts.slice(1).join(' ')} ${parts[0]}`.replace(/\s+/g,' ').trim();
  }
  return s;
}

function extractWelch(purpose) {
  const s = clean(purpose);
  // e.g., "Volleyball - Hold per NM for WELCH VB"
  const m = s.match(/hold\s+per\s+nm\s+for\s+(.+?)(?:\s*vb)?\s*$/i);
  if (m) {
    const who = clean(m[1]).replace(/\s+vb$/i,'');
    return `${who} VB`;
  }
  return null;
}

function makeTitleSubtitle(row) {
  const reservee = clean(row['Reservee'] || '');
  const purpose  = clean(row['Reservation Purpose'] || '');

  // Pickleball
  if (/pickleball/i.test(reservee) || /pickleball/i.test(purpose)) {
    return { title: 'Open Pickleball', subtitle: '' };
  }

  // Extract "Welch VB" from Holds
  const possibleWelch = extractWelch(purpose);
  if (possibleWelch) {
    return { title: possibleWelch, subtitle: 'Volleyball' };
  }

  // RAEC Front Desk *holds* (we hide them later, but title just in case)
  if (/^raec\s*front\s*desk/i.test(reservee)) {
    return { title: 'Internal Hold', subtitle: '' };
  }

  // Org + contact: "D1 Training (Stay 22uned, Inc.), John Doe"
  // We’ll strip trailing unmatched "(" artifacts and keep left part as "org"
  const orgPerson = reservee.split(',').map(s => s.trim());
  let org = clean(orgPerson[0] || '');
  org = org.replace(/\($/, ''); // trim stray '(' if present

  // If looks like "Last, First", prefer person
  if (orgPerson.length >= 2 && /^[A-Za-z'.-]+$/.test(orgPerson[0])) {
    const person = normalizePerson(reservee);
    return { title: person, subtitle: clean(purpose) };
  }

  // Otherwise show org, then purpose
  return { title: org || reservee || 'Reservation', subtitle: clean(purpose) };
}

// ---------- facility → rooms mapping ----------
const SOUTH_HALF = {
  'AC GYM - HALF COURT 1A': ['1A'],
  'AC GYM - HALF COURT 1B': ['1B'],
  'AC GYM - COURT 1-AB':    ['1A','1B'],
  'AC GYM - HALF COURT 2A': ['2A'],
  'AC GYM - HALF COURT 2B': ['2B'],
  'AC GYM - COURT 2-AB':    ['2A','2B'],
  'AC GYM - FULL GYM 1AB & 2AB': ['1A','1B','2A','2B'],
  'AC GYM - CHAMPIONSHIP COURT': ['1A','1B','2A','2B'], // treat as full south
};

const NORTH_HALF = {
  'AC GYM - HALF COURT 9A': ['9A'],
  'AC GYM - HALF COURT 9B': ['9B'],
  'AC GYM - COURT 9-AB':    ['9A','9B'],
  'AC GYM - HALF COURT 10A':['10A'],
  'AC GYM - HALF COURT 10B':['10B'],
  'AC GYM - COURT 10-AB':   ['10A','10B'],
  'AC GYM - FULL GYM 9 & 10':['9A','9B','10A','10B'],
};

function isSouth(fac) {
  const F = clean(fac).toUpperCase();
  return /(COURT\s*1|COURT\s*2|HALF COURT\s*1|HALF COURT\s*2|FULL GYM 1AB)/.test(F) || /CHAMPIONSHIP COURT/.test(F);
}
function isNorth(fac) {
  const F = clean(fac).toUpperCase();
  return /(COURT\s*9|COURT\s*10|HALF COURT\s*9|HALF COURT\s*10|FULL GYM 9\s*&\s*10)/.test(F);
}

function mapSouthFacility(fac) {
  const F = clean(fac).toUpperCase();
  // exact keys first
  for (const k of Object.keys(SOUTH_HALF)) {
    if (F === k) return SOUTH_HALF[k];
  }
  // loosen
  if (/HALF COURT 1A/i.test(F)) return ['1A'];
  if (/HALF COURT 1B/i.test(F)) return ['1B'];
  if (/COURT 1-AB/i.test(F))    return ['1A','1B'];
  if (/HALF COURT 2A/i.test(F)) return ['2A'];
  if (/HALF COURT 2B/i.test(F)) return ['2B'];
  if (/COURT 2-AB/i.test(F))    return ['2A','2B'];
  if (/FULL GYM 1AB\s*&\s*2AB/i.test(F)) return ['1A','1B','2A','2B'];
  if (/CHAMPIONSHIP COURT/i.test(F))     return ['1A','1B','2A','2B'];
  return [];
}

function mapNorthFacility(fac) {
  const F = clean(fac).toUpperCase();
  for (const k of Object.keys(NORTH_HALF)) {
    if (F === k) return NORTH_HALF[k];
  }
  if (/HALF COURT 9A/i.test(F)) return ['9A'];
  if (/HALF COURT 9B/i.test(F)) return ['9B'];
  if (/COURT 9-AB/i.test(F))    return ['9A','9B'];
  if (/HALF COURT 10A/i.test(F))return ['10A'];
  if (/HALF COURT 10B/i.test(F))return ['10B'];
  if (/COURT 10-AB/i.test(F))   return ['10A','10B'];
  if (/FULL GYM 9\s*&\s*10/i.test(F)) return ['9A','9B','10A','10B'];
  return [];
}

function mapFieldhouseCourtMode(fac) {
  const F = clean(fac).toUpperCase();
  // Courts 3..8
  const m = F.match(/AC\s*FIELDHOUSE\s*-\s*COURT\s*([3-8])$/i);
  if (m) return [m[1]];
  if (/COURT\s*3-8/i.test(F))  return ['3','4','5','6','7','8'];
  return [];
}

function mapFieldhouseTurfMode(fac) {
  const F = clean(fac).toUpperCase();
  if (/QUARTER TURF\s*NA/i.test(F)) return ['QT-NA'];
  if (/QUARTER TURF\s*NB/i.test(F)) return ['QT-NB'];
  if (/QUARTER TURF\s*SA/i.test(F)) return ['QT-SA'];
  if (/QUARTER TURF\s*SB/i.test(F)) return ['QT-SB'];
  if (/HALF TURF\s*NORTH/i.test(F)) return ['QT-NA','QT-NB'];
  if (/HALF TURF\s*SOUTH/i.test(F)) return ['QT-SA','QT-SB'];
  if (/FULL TURF/i.test(F))         return ['QT-NA','QT-NB','QT-SA','QT-SB'];
  return [];
}

// ---------- specificity selection for South/North ----------
// We group by (block=South|North, personOrOrg, startMin, endMin) and then:
//  Half Court beats Court AB beats Full Gym beats Championship
function groupKeySouthNorth(block, who, startMin, endMin) {
  return `${block}__${who}__${startMin}-${endMin}`;
}
function specificityScore(fac) {
  const F = clean(fac).toUpperCase();
  if (/HALF COURT/.test(F)) return 4;
  if (/COURT\s*\d+-AB/.test(F)) return 3;
  if (/FULL GYM/.test(F)) return 2;
  if (/CHAMPIONSHIP COURT/.test(F)) return 1;
  return 0;
}

// ---------- main ----------
async function main() {
  if (!fs.existsSync(INPUT_CSV) || fs.statSync(INPUT_CSV).size === 0) {
    // write empty scaffold
    const scaffold = {
      fieldhouseMode: 'courts',
      dayStartMin: 360,
      dayEndMin: 1380,
      rooms: baseRooms('courts'),
      slots: []
    };
    fs.writeFileSync(OUTPUT_JSON, JSON.stringify(scaffold, null, 2));
    console.log(`Wrote ${OUTPUT_JSON} • slots=0`);
    return;
  }

  const raw = fs.readFileSync(INPUT_CSV, 'utf8');
  const rows = parse(raw, {
    columns: true,
    skip_empty_lines: true
  });

  // detect season
  let fieldhouseMode = 'courts';
  for (const r of rows) {
    const fac = clean(r['Facility']);
    const pur = clean(r['Reservation Purpose']);
    if (/AC FIELDHOUSE - FULL TURF/i.test(fac) && /TURF INSTALL PER NM/i.test(pur)) {
      fieldhouseMode = 'turf';
      break;
    }
    if (/AC FIELDHOUSE - COURT\s*[3-8]/i.test(fac) && /FIELDHOUSE INSTALLED PER NM/i.test(pur)) {
      fieldhouseMode = 'courts';
    }
  }

  const nowMin = nowMinutes();

  // Build preliminary items with specificity
  const prelim = [];
  for (const r of rows) {
    const location = clean(r['Location:'] || r['Location'] || '');
    if (location && !/athletic\s*&\s*event\s*center/i.test(location)) continue;

    const fac = clean(r['Facility']);
    const timeText = clean(r['Reserved Time']);
    const reservee = clean(r['Reservee']);
    const purpose  = clean(r['Reservation Purpose']);

    // skip internal holds from display (but used for season detection already)
    if (/^raec\s*front\s*desk/i.test(reservee)) {
      // Skip from display
      continue;
    }

    const range = parseRangeToMinutes(timeText);
    if (!range) continue;
    if (range.endMin <= nowMin) continue; // hide past

    const { title, subtitle } = makeTitleSubtitle(r);

    // SOUTH / NORTH groups with specificity
    if (isSouth(fac)) {
      prelim.push({
        block: 'SOUTH',
        fac,
        rooms: mapSouthFacility(fac),
        score: specificityScore(fac),
        startMin: range.startMin,
        endMin: range.endMin,
        whoKey: title.toLowerCase(),
        title,
        subtitle
      });
      continue;
    }
    if (isNorth(fac)) {
      prelim.push({
        block: 'NORTH',
        fac,
        rooms: mapNorthFacility(fac),
        score: specificityScore(fac),
        startMin: range.startMin,
        endMin: range.endMin,
        whoKey: title.toLowerCase(),
        title,
        subtitle
      });
      continue;
    }

    // Fieldhouse
    if (fieldhouseMode === 'turf') {
      const rooms = mapFieldhouseTurfMode(fac);
      if (rooms.length) {
        prelim.push({
          block: 'FIELDHOUSE',
          fac,
          rooms,
          score: 5, // not competing with south/north logic
          startMin: range.startMin,
          endMin: range.endMin,
          whoKey: title.toLowerCase(),
          title,
          subtitle
        });
      }
    } else {
      const rooms = mapFieldhouseCourtMode(fac);
      if (rooms.length) {
        prelim.push({
          block: 'FIELDHOUSE',
          fac,
          rooms,
          score: 5,
          startMin: range.startMin,
          endMin: range.endMin,
          whoKey: title.toLowerCase(),
          title,
          subtitle
        });
      }
    }
  }

  // Resolve south/north overlaps by specificity
  const chosen = [];

  // Group SOUTH
  const southGroups = new Map();
  for (const it of prelim.filter(p => p.block === 'SOUTH')) {
    const key = groupKeySouthNorth('S', it.whoKey, it.startMin, it.endMin);
    if (!southGroups.has(key)) southGroups.set(key, []);
    southGroups.get(key).push(it);
  }
  for (const arr of southGroups.values()) {
    // if we have any HALF COURT rows → keep only those; else if COURT AB → keep those; else FULL/CHAMPIONSHIP
    const maxScore = Math.max(...arr.map(a => a.score));
    const best = arr.filter(a => a.score === maxScore);
    best.forEach(b => chosen.push(b));
  }

  // Group NORTH
  const northGroups = new Map();
  for (const it of prelim.filter(p => p.block === 'NORTH')) {
    const key = groupKeySouthNorth('N', it.whoKey, it.startMin, it.endMin);
    if (!northGroups.has(key)) northGroups.set(key, []);
    northGroups.get(key).push(it);
  }
  for (const arr of northGroups.values()) {
    const maxScore = Math.max(...arr.map(a => a.score));
    const best = arr.filter(a => a.score === maxScore);
    best.forEach(b => chosen.push(b));
  }

  // Fieldhouse entries go straight through
  prelim.filter(p => p.block === 'FIELDHOUSE').forEach(p => chosen.push(p));

  // Expand to room slots
  const slots = [];
  for (const it of chosen) {
    for (const r of it.rooms) {
      slots.push({
        roomId: r,
        startMin: it.startMin,
        endMin: it.endMin,
        title: it.title,
        subtitle: it.subtitle
      });
    }
  }

  // Sort slots by start/end
  slots.sort((a,b) => a.roomId.localeCompare(b.roomId) || a.startMin - b.startMin || a.endMin - b.endMin);

  // Build rooms array per mode
  const rooms = baseRooms(fieldhouseMode);

  const out = {
    fieldhouseMode,
    dayStartMin: 360,
    dayEndMin: 1380,
    rooms,
    slots
  };

  fs.writeFileSync(OUTPUT_JSON, JSON.stringify(out, null, 2));
  console.log(`transform: season=${fieldhouseMode} • slots=${slots.length}`);
}

function baseRooms(mode) {
  const fixed = [
    { id:'1A', label:'1A', group:'south' },
    { id:'1B', label:'1B', group:'south' },
    { id:'2A', label:'2A', group:'south' },
    { id:'2B', label:'2B', group:'south' },
    { id:'9A', label:'9A', group:'north' },
    { id:'9B', label:'9B', group:'north' },
    { id:'10A',label:'10A',group:'north' },
    { id:'10B',label:'10B',group:'north' },
  ];
  const middleCourts = [
    { id:'3', label:'3', group:'fieldhouse' },
    { id:'4', label:'4', group:'fieldhouse' },
    { id:'5', label:'5', group:'fieldhouse' },
    { id:'6', label:'6', group:'fieldhouse' },
    { id:'7', label:'7', group:'fieldhouse' },
    { id:'8', label:'8', group:'fieldhouse' },
  ];
  const middleTurf = [
    { id:'QT-NA', label:'NA', group:'fieldhouse' },
    { id:'QT-NB', label:'NB', group:'fieldhouse' },
    { id:'QT-SA', label:'SA', group:'fieldhouse' },
    { id:'QT-SB', label:'SB', group:'fieldhouse' },
  ];
  return mode === 'turf' ? [...fixed, ...middleTurf] : [...fixed, ...middleCourts];
}

main().catch(err => {
  console.error('transform.mjs failed:', err);
  process.exit(1);
});
