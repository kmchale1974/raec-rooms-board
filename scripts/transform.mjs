// scripts/transform.mjs
// Robust CSV -> events.json transformer (ESM)

import fs from 'fs';
import path from 'path';
import readline from 'readline';

// ---- Config / IO ----
const CSV_PATH   = process.env.OUT_CSV || 'data/inbox/latest.csv';
const JSON_OUT   = process.env.JSON_OUT || 'events.json';
const DAY_START  = 6 * 60;   // 06:00
const DAY_END    = 23 * 60;  // 23:00

// ---- Helpers ----
const trim = (s) => (s ?? '').toString().trim();
const norm = (s) => trim(s).replace(/\s+/g, ' ');

function toMinutes(h, m, ampm) {
  let hh = parseInt(h, 10);
  const mm = parseInt(m, 10) || 0;
  const a = ampm.toLowerCase();
  if (a === 'pm' && hh !== 12) hh += 12;
  if (a === 'am' && hh === 12) hh = 0;
  return hh * 60 + mm;
}

function parseRange(raw) {
  // e.g. "9:30am - 12:30pm" or "4:00pm -  7:00pm"
  const s = norm(raw).toLowerCase();
  const m = s.match(
    /(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*-\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)/
  );
  if (!m) return null;
  const [, sh, sm = '0', sa, eh, em = '0', ea] = m;
  const startMin = toMinutes(sh, sm, sa);
  const endMin   = toMinutes(eh, em, ea);
  return { startMin, endMin };
}

// 3rd Monday in March (courts go in), 2nd Monday in November (turf returns)
function nthWeekdayOfMonth(year, monthIndex, weekday, nth) {
  // weekday: 1=Mon..7=Sun; monthIndex: 0..11
  const first = new Date(year, monthIndex, 1);
  const firstW = ((first.getDay() + 6) % 7) + 1; // convert Sun=0..Sat=6 to Mon=1..Sun=7
  let day = 1 + ((weekday - firstW + 7) % 7) + (nth - 1) * 7;
  return new Date(year, monthIndex, day);
}
function isCourtsSeasonUTC(now = new Date()) {
  const y = now.getUTCFullYear();
  const thirdMonMarch = nthWeekdayOfMonth(y, 2, 1, 3); // Mar=2
  const secondMonNov  = nthWeekdayOfMonth(y,10, 1, 2); // Nov=10
  // compare in UTC by stripping time
  const d = new Date(Date.UTC(y, now.getUTCMonth(), now.getUTCDate()));
  const a = new Date(Date.UTC(y, 2, thirdMonMarch.getUTCDate()));
  const b = new Date(Date.UTC(y,10, secondMonNov.getUTCDate()));
  return d >= a && d < b;
}

function cleanOrgText(title) {
  // drop pure duplicate "X, X"
  let t = norm(title);
  const parts = t.split(',').map(p => p.trim());
  if (parts.length >= 2 && parts[0].toLowerCase() === parts[1].toLowerCase()) {
    t = parts[0] + (parts.length > 2 ? ', ' + parts.slice(2).join(', ') : '');
  }
  return t;
}

function isPickleball(purpose, title) {
  const p = (purpose || '').toLowerCase();
  const t = (title || '').toLowerCase();
  return p.includes('pickleball') || t.includes('pickleball');
}

function pickleballTitle() {
  return 'Open Pickleball';
}

function removeInternalHold(purpose) {
  // strip "Internal Hold per NM" and similar
  return norm((purpose || '').replace(/internal hold per nm/ig, '').replace(/\s{2,}/g, ' ').trim());
}

// Facility -> implied rooms (by number strings "1".."10")
function facilityToRooms(facility, courtsSeason) {
  const f = (facility || '').toLowerCase();

  // South gym
  if (f.includes('championship court')) return ['1','2'];
  if (f.includes('full gym 1ab & 2ab'))  return ['1','2'];
  if (f.includes('court 1-ab'))          return ['1'];
  if (f.includes('half court 1a') || f.includes('half court 1b')) return ['1'];
  if (f.includes('half court 2a') || f.includes('half court 2b')) return ['2'];
  if (f.includes('court 2-ab'))          return ['2'];

  // North gym
  if (f.includes('full gym 9 & 10'))     return ['9','10'];
  if (f.includes('court 9-ab'))          return ['9'];
  if (f.includes('half court 9a') || f.includes('half court 9b')) return ['9'];
  if (f.includes('court 10-ab'))         return ['10'];
  if (f.includes('half court 10a') || f.includes('half court 10b')) return ['10'];

  // Fieldhouse
  if (!courtsSeason) {
    // TURF season: map named turf zones to 3..8 (we’ll just mark fieldhouse used;
    // you asked to ignore showing turf when courts are down; here it’s not courts season).
    if (f.includes('fieldhouse')) {
      // during turf season you can choose to aggregate into 3..8 anyway, or skip.
      return ['3','4','5','6','7','8'];
    }
  } else {
    // COURTS season (now): ignore turf-only placeholders
    if (f.includes('full turf') || f.includes('half turf') || f.includes('quarter turf')) {
      return []; // ignore in courts season
    }
    // "AC Fieldhouse Court 3-8"
    if (f.match(/fieldhouse.*court\s*3-8/)) return ['3','4','5','6','7','8'];
    // "AC Fieldhouse - Court 6"
    const m = f.match(/fieldhouse.*court\s*(\d{1,2})/);
    if (m) {
      const n = m[1];
      if (+n >= 3 && +n <= 8) return [String(+n)];
    }
  }

  // As a catch-all: single gym “Full Gym 1AB & 2AB”/etc handled above.
  // If nothing matched, return []
  return [];
}

// Build empty rooms (1..10) with group tagging
function buildRooms() {
  const rooms = [];
  const push = (id, group) => rooms.push({ id: String(id), label: String(id), group });
  push(1, 'south'); push(2, 'south');
  for (let i=3;i<=8;i++) push(i, 'fieldhouse');
  push(9, 'north'); push(10, 'north');
  return rooms;
}

function formatRange(startMin, endMin) {
  function fmt(m) {
    let h = Math.floor(m/60);
    let mm = m % 60;
    let ampm = 'AM';
    if (h === 0) h = 12;
    else if (h === 12) ampm = 'PM';
    else if (h > 12) { h -= 12; ampm = 'PM'; }
    return `${h}:${mm.toString().padStart(2,'0')}${ampm}`;
  }
  return `${fmt(startMin)} - ${fmt(endMin)}`;
}

// ---- Main ----
async function run() {
  // If CSV missing or empty, write scaffold and exit 0 (so site stays up)
  if (!fs.existsSync(CSV_PATH) || fs.statSync(CSV_PATH).size === 0) {
    console.log('Empty CSV; writing empty scaffold.');
    const out = {
      dayStartMin: DAY_START,
      dayEndMin: DAY_END,
      rooms: buildRooms(),
      slots: []
    };
    fs.writeFileSync(JSON_OUT, JSON.stringify(out, null, 2));
    return;
  }

  // Read CSV streaming
  const rl = readline.createInterface({
    input: fs.createReadStream(CSV_PATH)
  });

  // Detect headers from first non-empty line
  let headers = null;
  const rows = [];
  for await (const lineRaw of rl) {
    const line = lineRaw.replace(/\uFEFF/g, ''); // strip BOM if any
    if (!line.trim()) continue;

    // Split on commas, but this is a simple heuristic (your CSV appears clean)
    // If quoted CSV becomes an issue later, we can switch to a parser.
    const cells = line.split(',').map(c => c.trim());
    if (!headers) {
      headers = cells.map(h => h.replace(/:$/,'').toLowerCase());
      continue;
    }
    rows.push(cells);
  }

  if (!headers) {
    console.log('CSV had no header; writing empty scaffold.');
    const out = { dayStartMin: DAY_START, dayEndMin: DAY_END, rooms: buildRooms(), slots: [] };
    fs.writeFileSync(JSON_OUT, JSON.stringify(out, null, 2));
    return;
  }

  // Map columns
  const idx = (nameOpts) => {
    const names = Array.isArray(nameOpts) ? nameOpts : [nameOpts];
    for (const n of names) {
      const i = headers.findIndex(h => h === n.toLowerCase());
      if (i !== -1) return i;
    }
    // try looser search
    for (let i=0;i<headers.length;i++) {
      const h = headers[i];
      if (names.some(n => h.includes(n.toLowerCase()))) return i;
    }
    return -1;
  };

  const iLoc   = idx(['location','location ']);
  const iFac   = idx(['facility']);
  const iTime  = idx(['reserved time','reservedtime']);
  const iRes   = idx(['reservee']);
  const iPurp  = idx(['reservation purpose','reservationpurpose']);

  const courtsSeason = isCourtsSeasonUTC(new Date());

  // Collect raw slot intents
  const intents = [];
  for (const cells of rows) {
    const location = iLoc >= 0 ? cells[iLoc] : '';
    // Only include Athletic & Event Center (per your rule)
    if (location && !/athletic\s*&?\s*event\s*center/i.test(location)) continue;

    const fac = iFac >= 0 ? cells[iFac] : '';
    const when = iTime >= 0 ? cells[iTime] : '';
    const reserver = iRes >= 0 ? cells[iRes] : '';
    const purposeRaw = iPurp >= 0 ? cells[iPurp] : '';

    const range = parseRange(when);
    if (!range) continue;

    let rooms = facilityToRooms(fac, courtsSeason);
    if (!rooms.length) continue;

    const isPick = isPickleball(purposeRaw, reserver);
    const title = isPick ? pickleballTitle() : cleanOrgText(reserver || purposeRaw || '').trim();
    let subtitle = isPick ? '' : removeInternalHold(purposeRaw);

    // Build one intent per implied room
    for (const r of rooms) {
      intents.push({
        room: r,
        startMin: Math.max(DAY_START, range.startMin),
        endMin:   Math.min(DAY_END,   range.endMin),
        title,
        subtitle,
        raw: { fac, reserver, purposeRaw }
      });
    }
  }

  // Consolidate Pickleball: if a time range spans 9/10 with various A/B/AB rows,
  // collapse to one per room per (start,end)
  function keyPick(i) { return `${i.startMin}-${i.endMin}`; }
  const pbByKey = new Map();
  for (const i of intents) {
    if (i.title === 'Open Pickleball') {
      const k = keyPick(i);
      if (!pbByKey.has(k)) pbByKey.set(k, new Set());
      pbByKey.get(k).add(i.room);
    }
  }
  // Remove all pickleball intents; re-add collapsed ones
  const nonPb = intents.filter(i => i.title !== 'Open Pickleball');
  const pbCollapsed = [];
  for (const [k, roomSet] of pbByKey.entries()) {
    const [s,e] = k.split('-').map(Number);
    // If union covers both 9 and 10 at that time, ensure both present
    // Rooms could be any combination; we just emit per room in the set.
    for (const r of roomSet) {
      pbCollapsed.push({ room: r, startMin: s, endMin: e, title: 'Open Pickleball', subtitle: '' });
    }
  }
  let items = nonPb.concat(pbCollapsed);

  // De-duplicate per room+time+title (subtitle ignored for dedupe)
  const seen = new Set();
  items = items.filter(i => {
    if (i.endMin <= i.startMin) return false;
    const k = `${i.room}|${i.startMin}|${i.endMin}|${i.title.toLowerCase()}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  // Final JSON shape
  const out = {
    dayStartMin: DAY_START,
    dayEndMin: DAY_END,
    rooms: buildRooms(),
    slots: items.map(i => ({
      roomId: i.room,
      startMin: i.startMin,
      endMin: i.endMin,
      title: i.title,
      subtitle: i.subtitle
    }))
  };

  fs.writeFileSync(JSON_OUT, JSON.stringify(out, null, 2));
  console.log(`Wrote ${JSON_OUT} • rooms=${out.rooms.length} • slots=${out.slots.length}`);
}

// run once
run().catch(err => {
  console.error('transform failed:', err?.stack || err);
  process.exit(1);
});
