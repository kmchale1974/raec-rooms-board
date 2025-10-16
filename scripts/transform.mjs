import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ---------------- paths & env ----------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CSV_IN = process.env.CSV_PATH || path.join(__dirname, '..', 'data', 'inbox', 'latest.csv');
const JSON_OUT = process.env.JSON_OUT || path.join(__dirname, '..', 'events.json');

// ---------------- tiny utils ----------------
const norm = (s='') =>
  s.replace(/^\uFEFF/, '')             // BOM
   .replace(/\u00A0/g, ' ')            // NBSP -> space
   .replace(/\s+/g, ' ')               // collapse spaces
   .trim();

const lc = (s='') => norm(s).toLowerCase();

// Robust 12h time like "9:30am"
function minutesFrom12h(t) {
  const m = norm(t).match(/^(\d{1,2}):(\d{2})\s*([ap]m)$/i);
  if (!m) return null;
  let hr = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const ampm = m[3].toLowerCase();
  if (ampm === 'pm' && hr !== 12) hr += 12;
  if (ampm === 'am' && hr === 12) hr = 0;
  return hr * 60 + min;
}

// "9:30am - 12:30pm"
function parseTimeRange(s='') {
  const m = s.match(/(\d{1,2}:\d{2}\s*[ap]m)\s*-\s*(\d{1,2}:\d{2}\s*[ap]m)/i);
  if (!m) return null;
  const startMin = minutesFrom12h(m[1]);
  const endMin   = minutesFrom12h(m[2]);
  if (startMin == null || endMin == null) return null;
  return { startMin, endMin };
}

// Remove “X, X”
function cleanTitle(s='') {
  const parts = s.split(',').map(p => norm(p)).filter(Boolean);
  if (parts.length === 2 && lc(parts[0]) === lc(parts[1])) return parts[0];
  return norm(s);
}

// ---------------- CSV parser (quote-aware) ----------------
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        // escaped quote?
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        row.push(field);
        field = '';
      } else if (ch === '\r') {
        // ignore; handle on \n
      } else if (ch === '\n') {
        row.push(field);
        rows.push(row);
        row = [];
        field = '';
      } else {
        field += ch;
      }
    }
  }
  // last field
  row.push(field);
  rows.push(row);

  // strip trailing blank lines
  while (rows.length && rows[rows.length - 1].every(c => norm(c) === '')) rows.pop();
  return rows;
}

// ---------------- season helpers ----------------
// Courts down: 3rd Monday in March → 2nd Monday in Nov
function isCourtsSeason(date) {
  const y = date.getFullYear();
  const start = nthWeekdayOfMonth(y, 2, 1, 3); // March (2), Monday(1), 3rd
  const stop  = nthWeekdayOfMonth(y, 10, 1, 2); // Nov (10), Monday(1), 2nd
  return date >= start && date < stop;
}

function nthWeekdayOfMonth(year, monthIndex, weekdayMon1, nth) {
  // weekdayMon1: 1=Mon..7=Sun
  const want = (weekdayMon1 % 7); // 1..6,0
  const first = new Date(year, monthIndex, 1);
  const firstJS = first.getDay(); // 0=Sun..6=Sat
  const wantJS = want; // since our 1..0 mapping above matches modulo
  let diff = wantJS - firstJS;
  if (diff < 0) diff += 7;
  const day = 1 + diff + (nth - 1) * 7;
  return new Date(year, monthIndex, day);
}

// ---------------- facility → rooms mapping ----------------
function mapFacilityToRooms(fac, courtsSeason) {
  const f = norm(fac);

  // South/North gyms (numbers 1,2,9,10; allow A/B if explicit)
  let m = f.match(/^AC Gym - Half Court (\d{1,2})([AB])$/i);
  if (m) return [`${parseInt(m[1],10)}${m[2].toUpperCase()}`];

  m = f.match(/^AC Gym - Court (\d{1,2})-AB$/i);
  if (m) return [String(parseInt(m[1],10))];

  if (/^AC Gym - Full Gym 9 & 10$/i.test(f)) return ['9','10'];
  if (/^AC Gym - Full Gym 1AB & 2AB$/i.test(f)) return ['1','2'];
  m = f.match(/^AC Gym - Full Gym (\d{1,2})$/i);
  if (m) return [String(parseInt(m[1],10))];

  if (/^AC Gym - Championship Court$/i.test(f)) return ['1','2'];

  // explicit alternatives
  if (/^AC Gym - Court 1-AB$/i.test(f)) return ['1'];
  if (/^AC Gym - Court 2-AB$/i.test(f)) return ['2'];

  // Fieldhouse
  if (courtsSeason) {
    // Courts season: accept “Court 3..8” and “Court 3-8”, ignore turf
    m = f.match(/^AC Fieldhouse - Court ([3-8])$/i);
    if (m) return [m[1]];
    if (/^AC Fieldhouse(?: -)? Court 3-8$/i.test(f)) return ['3','4','5','6','7','8'];
    if (/^AC Fieldhouse - (Full|Half|Quarter) Turf/i.test(f)) return [];
  } else {
    // Turf season: map turf → 3..8
    if (/^AC Fieldhouse - Full Turf$/i.test(f)) return ['3','4','5','6','7','8'];
    if (/^AC Fieldhouse - Half Turf North$/i.test(f)) return ['6','7','8'];
    if (/^AC Fieldhouse - Half Turf South$/i.test(f)) return ['3','4','5'];
    if (/^AC Fieldhouse - Quarter Turf NA$/i.test(f)) return ['6','7'];
    if (/^AC Fieldhouse - Quarter Turf NB$/i.test(f)) return ['7','8'];
    if (/^AC Fieldhouse - Quarter Turf SA$/i.test(f)) return ['3','4'];
    if (/^AC Fieldhouse - Quarter Turf SB$/i.test(f)) return ['4','5'];
    // If CSV still uses numbered courts, accept those too
    m = f.match(/^AC Fieldhouse - Court ([3-8])$/i);
    if (m) return [m[1]];
    if (/^AC Fieldhouse(?: -)? Court 3-8$/i.test(f)) return ['3','4','5','6','7','8'];
  }

  return [];
}

// ---------------- main ----------------
(function main(){
  if (!fs.existsSync(CSV_IN)) {
    console.log(`CSV not found at ${CSV_IN}. Writing empty scaffold.`);
    writeOut([]);
    return;
  }

  const raw = fs.readFileSync(CSV_IN, 'utf8');
  if (!raw.trim()) {
    console.log('CSV exists but is empty. Writing empty scaffold.');
    writeOut([]);
    return;
  }

  const rows = parseCSV(raw);
  if (!rows.length) {
    console.log('CSV parsed to 0 rows. Writing empty scaffold.');
    writeOut([]);
    return;
  }

  const header = rows[0].map(h => norm(h));
  const body = rows.slice(1).filter(r => r.some(c => norm(c) !== ''));

  // find header indices with tolerant matching
  const hidx = (cands) => {
    for (const c of cands) {
      const i = header.findIndex(h => lc(h) === lc(c));
      if (i >= 0) return i;
    }
    // also try contains (for stray colon)
    for (const c of cands) {
      const i = header.findIndex(h => lc(h).includes(lc(c)));
      if (i >= 0) return i;
    }
    return -1;
  };

  const I = {
    location:  hidx(['Location', 'Location:', 'location']),
    facility:  hidx(['Facility']),
    reserved:  hidx(['Reserved Time','reservedtime','ReservedTime']),
    reservee:  hidx(['Reservee']),
    purpose:   hidx(['Reservation Purpose','reservationpurpose']),
    headcount: hidx(['Headcount']),
  };

  // noisy logging so you can confirm in Actions
  console.log('Detected headers:', header.join(' | '));
  console.log('Header indices:', I);
  console.log('First 3 data rows (trimmed):',
    body.slice(0,3).map(r => r.map(c => norm(c)).join(' | '))
  );

  const today = new Date();
  today.setSeconds(0,0);
  const courtsSeason = isCourtsSeason(today);
  console.log(`Season: ${courtsSeason ? 'COURTS' : 'TURF'} (${today.toDateString()})`);

  const slots = [];
  let kept=0, skipLoc=0, skipTime=0, skipMap=0;

  for (const r of body) {
    const location = I.location >= 0 ? norm(r[I.location] || '') : '';
    // keep if blank OR contains the phrase
    if (location && !/athletic & event center/i.test(location)) { skipLoc++; continue; }

    const reserved = I.reserved >= 0 ? norm(r[I.reserved] || '') : '';
    const t = parseTimeRange(reserved);
    if (!t) { skipTime++; continue; }

    const facility = I.facility >= 0 ? r[I.facility] || '' : '';
    const rooms = mapFacilityToRooms(facility, courtsSeason);
    if (!rooms.length) { skipMap++; continue; }

    const title = cleanTitle(I.reservee >= 0 ? r[I.reservee] || '' : '') || 'Reserved';
    const subtitle = norm(I.purpose >= 0 ? r[I.purpose] || '' : '');

    for (const roomId of rooms) {
      slots.push({ roomId, startMin: t.startMin, endMin: t.endMin, title, subtitle });
      kept++;
    }
  }

  // dedupe exact matches
  const seen = new Set();
  const deduped = [];
  for (const s of slots) {
    const key = `${s.roomId}|${s.startMin}|${s.endMin}|${s.title}|${s.subtitle}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(s);
  }

  console.log(`Row stats • total=${body.length} kept=${kept} skipLoc=${skipLoc} skipMap=${skipMap} skipTime=${skipTime}`);
  writeOut(deduped);
})();

function writeOut(slots) {
  const out = {
    dayStartMin: 360,  // 6:00
    dayEndMin: 1380,   // 23:00
    rooms: [
      { id:'1', label:'1', group:'south' },
      { id:'2', label:'2', group:'south' },
      { id:'3', label:'3', group:'fieldhouse' },
      { id:'4', label:'4', group:'fieldhouse' },
      { id:'5', label:'5', group:'fieldhouse' },
      { id:'6', label:'6', group:'fieldhouse' },
      { id:'7', label:'7', group:'fieldhouse' },
      { id:'8', label:'8', group:'fieldhouse' },
      { id:'9', label:'9', group:'north' },
      { id:'10', label:'10', group:'north' },
    ],
    slots
  };
  fs.writeFileSync(JSON_OUT, JSON.stringify(out, null, 2));
  console.log(`Wrote ${path.basename(JSON_OUT)} • rooms=${out.rooms.length} • slots=${out.slots.length}`);
}
