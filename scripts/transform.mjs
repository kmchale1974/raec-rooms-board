import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ---------- Paths ----------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CSV_IN = process.env.CSV_PATH || path.join(__dirname, '..', 'data', 'inbox', 'latest.csv');
const JSON_OUT = process.env.JSON_OUT || path.join(__dirname, '..', 'events.json');

// ---------- Helpers ----------
function readCSV(file) {
  if (!fs.existsSync(file)) return [];
  const raw = fs.readFileSync(file, 'utf8');
  if (!raw.trim()) return [];
  // basic CSV (the export looks clean: commas, no quoted commas in fields we use)
  const lines = raw.split(/\r?\n/).filter(l => l.trim().length);
  if (!lines.length) return [];

  const header = lines[0].split(',').map(h => h.trim());
  const idx = (nameCandidates) => {
    for (const cand of nameCandidates) {
      const i = header.findIndex(h => h.toLowerCase() === cand.toLowerCase());
      if (i >= 0) return i;
    }
    return -1;
  };

  const I = {
    location: idx(['Location', 'Location:', 'location', 'Location:']),
    facility: idx(['Facility', 'facility']),
    reserved: idx(['Reserved Time', 'reservedtime', 'ReservedTime']),
    reservee: idx(['Reservee', 'reservee']),
    purpose:  idx(['Reservation Purpose', 'reservationpurpose', 'ReservationPurpose']),
    headcount: idx(['Headcount', 'headcount']),
  };

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(','); // simple split OK for this export
    if (parts.length < 3) continue;
    const cell = (j) => (j >= 0 && j < parts.length ? parts[j].trim() : '');
    rows.push({
      location: cell(I.location),
      facility: cell(I.facility),
      reserved: cell(I.reserved),
      reservee: cell(I.reservee),
      purpose:  cell(I.purpose),
      headcount: cell(I.headcount)
    });
  }
  return rows;
}

function minutesFrom12h(t) {
  // "9:30am" or " 4:00pm" (allow extra spaces)
  const m = t.trim().match(/^(\d{1,2}):(\d{2})\s*([ap]m)$/i);
  if (!m) return null;
  let hr = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const ampm = m[3].toLowerCase();
  if (ampm === 'pm' && hr !== 12) hr += 12;
  if (ampm === 'am' && hr === 12) hr = 0;
  return hr * 60 + min;
}

function parseTimeRange(s) {
  // "9:30am - 12:30pm" (allow multiple spaces)
  const m = s.match(/(\d{1,2}:\d{2}\s*[ap]m)\s*-\s*(\d{1,2}:\d{2}\s*[ap]m)/i);
  if (!m) return null;
  const start = minutesFrom12h(m[1]);
  const end = minutesFrom12h(m[2]);
  if (start == null || end == null) return null;
  return { startMin: start, endMin: end };
}

function isCourtsSeason(date) {
  // Courts down: 3rd Monday in March → 2nd Monday in November (inclusive of start, exclusive of next season start)
  const y = date.getFullYear();
  const thirdMonMar = nthWeekdayOfMonth(y, 2, 1, 3);  // March, Monday=1, nth=3
  const secondMonNov = nthWeekdayOfMonth(y, 10, 1, 2); // Nov, Monday=1, nth=2
  return date >= thirdMonMar && date < secondMonNov;
}

function isTurfSeason(date) {
  return !isCourtsSeason(date);
}

function nthWeekdayOfMonth(year, monthIndex, weekday, nth) {
  // weekday: 0=Sun..6=Sat, but we want 1=Mon. Accept 1..7 with 1=Mon.
  const wd = ((weekday % 7) + 7) % 7; // if using 0..6 directly
  // Our calls pass Monday=1; convert to 1->1..7->0
  const target = (weekday === 1) ? 1 : weekday;
  // normalize to JS (0=Sun..6=Sat)
  const want = (target % 7);
  const first = new Date(year, monthIndex, 1);
  const firstJS = first.getDay(); // 0..6
  let diff = want - firstJS;
  if (diff < 0) diff += 7;
  const day = 1 + diff + (nth - 1) * 7;
  return new Date(year, monthIndex, day);
}

function cleanTitle(s) {
  if (!s) return '';
  const parts = s.split(',').map(p => p.trim()).filter(Boolean);
  if (parts.length === 2 && parts[0].toLowerCase() === parts[1].toLowerCase()) {
    return parts[0];
  }
  return s;
}

// Map facility -> list of roomIds, depending on season
function mapFacilityToRooms(facility, today, courtsSeason) {
  if (!facility) return [];

  // Normalize
  const f = facility.replace(/\s+/g, ' ').trim();

  // --- South/North gyms ---
  // Half Court 1A / 1B, 2A / 2B
  let m = f.match(/^AC Gym - Half Court (\d{1,2})([AB])$/i);
  if (m) return [`${m[1]}${m[2].toUpperCase()}`];

  // Court 10-AB, 1-AB, 2-AB -> single number
  m = f.match(/^AC Gym - Court (\d{1,2})-AB$/i);
  if (m) return [m[1]];

  // Full Gym 10 or Full Gym 1AB & 2AB -> single numbers
  if (/^AC Gym - Full Gym 9 & 10$/i.test(f)) return ['9','10'];
  if (/^AC Gym - Full Gym 1AB & 2AB$/i.test(f)) return ['1','2'];
  m = f.match(/^AC Gym - Full Gym (\d{1,2})$/i);
  if (m) return [m[1]];

  // Championship Court → same as Court 1 & 2
  if (/^AC Gym - Championship Court$/i.test(f)) return ['1','2'];

  // Half Court 9A/9B/10A/10B
  m = f.match(/^AC Gym - Half Court (\d{1,2})([AB])$/i);
  if (m) return [`${m[1]}${m[2].toUpperCase()}`];

  // Court 1-AB or 2-AB (alternative pattern)
  if (/^AC Gym - Court 1-AB$/i.test(f)) return ['1'];
  if (/^AC Gym - Court 2-AB$/i.test(f)) return ['2'];

  // --- Fieldhouse (3–8) ---
  // During courts season: accept Court 3..8 & 3-8 block; ignore turf variants
  if (courtsSeason) {
    // Single numbered court
    m = f.match(/^AC Fieldhouse - Court ([3-8])$/i);
    if (m) return [m[1]];
    // Block "Court 3-8"
    if (/^AC Fieldhouse Court 3-8$/i.test(f) || /^AC Fieldhouse - Court 3-8$/i.test(f)) {
      return ['3','4','5','6','7','8'];
    }
    // Ignore turf variants when courts are down
    if (/^AC Fieldhouse - (Full|Half|Quarter) Turf/i.test(f)) return [];
  } else {
    // Turf season: map turf variants onto 3–8
    if (/^AC Fieldhouse - Full Turf$/i.test(f)) return ['3','4','5','6','7','8'];
    if (/^AC Fieldhouse - Half Turf North$/i.test(f)) return ['6','7','8'];
    if (/^AC Fieldhouse - Half Turf South$/i.test(f)) return ['3','4','5'];
    if (/^AC Fieldhouse - Quarter Turf NA$/i.test(f)) return ['6','7'];
    if (/^AC Fieldhouse - Quarter Turf NB$/i.test(f)) return ['7','8'];
    if (/^AC Fieldhouse - Quarter Turf SA$/i.test(f)) return ['3','4'];
    if (/^AC Fieldhouse - Quarter Turf SB$/i.test(f)) return ['4','5'];
    // If CSV uses numbered court while turf season, keep it (some venues do that)
    m = f.match(/^AC Fieldhouse - Court ([3-8])$/i);
    if (m) return [m[1]];
    if (/^AC Fieldhouse Court 3-8$/i.test(f) || /^AC Fieldhouse - Court 3-8$/i.test(f)) {
      return ['3','4','5','6','7','8'];
    }
  }

  // Unknown: don’t crash, but don’t map
  return [];
}

function todayAtVenue() {
  const d = new Date(); // local timezone as used on the board/Yodeck
  d.setSeconds(0,0);
  return d;
}

// ---------- Main ----------
(function main(){
  const rows = readCSV(CSV_IN);

  const today = todayAtVenue();
  const courtsSeason = isCourtsSeason(today);

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
    slots: []
  };

  if (!rows.length) {
    fs.writeFileSync(JSON_OUT, JSON.stringify(out, null, 2));
    console.log('No rows; wrote empty scaffold.');
    return;
  }

  // Build slots
  const slots = [];
  let kept = 0, skippedLoc = 0, skippedTime = 0, skippedMap = 0;

  for (const r of rows) {
    // Location filter: only Athletic & Event Center (ignore others), but allow blank (some exports omit)
    if (r.location && r.location.toLowerCase() !== 'athletic & event center') {
      skippedLoc++; continue;
    }

    // Time
    const t = parseTimeRange(r.reserved || '');
    if (!t) { skippedTime++; continue; }

    // Map facility to room ids per season
    const roomIds = mapFacilityToRooms(r.facility || '', today, courtsSeason);
    if (!roomIds.length) { skippedMap++; continue; }

    // Prepare title/subtitle
    const title = cleanTitle(r.reservee || r.purpose || 'Reserved').trim() || 'Reserved';
    const subtitle = (r.purpose || '').trim();

    // Add one slot per mapped room
    for (const roomId of roomIds) {
      slots.push({
        roomId,
        startMin: t.startMin,
        endMin: t.endMin,
        title,
        subtitle
      });
      kept++;
    }
  }

  // Deduplicate exact duplicates (same room/time/title/subtitle)
  const seen = new Set();
  const deduped = [];
  for (const s of slots) {
    const key = `${s.roomId}|${s.startMin}|${s.endMin}|${s.title}|${s.subtitle}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(s);
  }

  out.slots = deduped;

  fs.writeFileSync(JSON_OUT, JSON.stringify(out, null, 2));
  console.log(`Wrote ${path.basename(JSON_OUT)} • rooms=${out.rooms.length} • slots=${out.slots.length}`);
  console.log(`Row stats • total=${rows.length} kept=${kept} skipLoc=${skippedLoc} skipMap=${skippedMap} skipTime=${skippedTime}`);
})();
