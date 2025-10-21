// scripts/transform.mjs
import fs from "fs";
import path from "path";

// ---- config
const CSV_PATH = process.env.CSV_PATH || "data/inbox/latest.csv";
const JSON_OUT = process.env.JSON_OUT || "events.json";

// fieldhouse floor/turf season (US Central rules you gave)
function isBasketballFloorInstalled(d) {
  // Basketball floor: from 3rd Monday in March through the day before 2nd Monday in November
  const y = d.getFullYear();
  const thirdMonMar = nthWeekdayOfMonth(y, 2, 1, 3);   // 2=March, Monday=1, nth=3
  const secondMonNov = nthWeekdayOfMonth(y, 10, 1, 2); // 10=Nov, Monday=1, nth=2
  return d >= thirdMonMar && d < secondMonNov;
}
function nthWeekdayOfMonth(year, monthIndex, weekday, nth) {
  // weekday: 0..6 (Sun..Sat). You gave Monday, so 1.
  const first = new Date(year, monthIndex, 1);
  const firstW = first.getDay();
  const delta = (weekday - firstW + 7) % 7;
  const day = 1 + delta + (nth - 1) * 7;
  return new Date(year, monthIndex, day);
}

// ---- tiny CSV parser (handles quotes & commas)
function parseCSV(text) {
  const rows = [];
  let i = 0, field = "", row = [], inQ = false;
  while (i <= text.length) {
    const c = text[i++] || "\n";
    if (inQ) {
      if (c === '"') {
        if (text[i] === '"') { field += '"'; i++; }
        else inQ = false;
      } else field += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ",") { row.push(field.trim()); field = ""; }
      else if (c === "\n" || c === "\r") {
        if (field || row.length) { row.push(field.trim()); rows.push(row); field = ""; row = []; }
      } else field += c;
    }
  }
  return rows;
}

// minutes since midnight from "h:mmam - h:mmpm"
function parseRange(s) {
  if (!s) return null;
  const t = s.replace(/\s+/g, " ").trim();
  const m = t.match(/(\d{1,2}):?(\d{2})?\s*(am|pm)\s*-\s*(\d{1,2}):?(\d{2})?\s*(am|pm)/i);
  if (!m) return null;
  const sh = parseInt(m[1], 10), sm = parseInt(m[2] || "0", 10), sampm = m[3].toLowerCase();
  const eh = parseInt(m[4], 10), em = parseInt(m[5] || "0", 10), eampm = m[6].toLowerCase();
  const toMin = (h, m, ap) => {
    let H = h % 12; if (ap === "pm") H += 12; return H * 60 + m;
  };
  return { startMin: toMin(sh, sm, sampm), endMin: toMin(eh, em, eampm) };
}

// Map facility to implied room set (numbers only)
function facilityToRooms(fac) {
  const f = fac.toLowerCase();

  // South & North gym numerics
  const mCourtAB = f.match(/ac gym\s*-\s*court\s*(\d+)-ab/);
  if (mCourtAB) {
    const n = mCourtAB[1];
    if (n === "1") return ["1", "2"]; // 1-AB implies 1 & 2
    if (n === "2") return ["1", "2"];
    if (n === "9") return ["9"]; // 9-AB implies 9 (we collapse A/B to just the number)
    if (n === "10") return ["10"];
  }

  const mFull = f.match(/ac gym\s*-\s*full gym\s*(\d+).*?(\d+)?/);
  if (mFull) {
    const a = mFull[1], b = mFull[2];
    if ((a === "1" && b === "2") || a === "1") return ["1", "2"];
    if ((a === "9" && b === "10") || a === "9") return ["9", "10"];
  }

  const mHalf = f.match(/ac gym\s*-\s*half court\s*(\d+)[ab]?/);
  if (mHalf) return [mHalf[1]];

  // Championship Court == 1 & 2
  if (f.includes("championship court")) return ["1", "2"];

  // Fieldhouse — basketball floor mode: 3..8, otherwise turf sets
  if (f.includes("fieldhouse")) {
    if (f.includes("court ") && f.match(/court\s*[3-8](?:-?[3-8])?/)) {
      // "AC Fieldhouse - Court 7" -> ["7"]
      const m = f.match(/court\s*(\d)(?:-(\d))?/);
      if (m) {
        if (m[2]) {
          const a = +m[1], b = +m[2];
          const arr = [];
          for (let k = Math.min(a, b); k <= Math.max(a, b); k++) arr.push(String(k));
          return arr;
        }
        return [m[1]];
      }
    }
    if (f.includes("court 3-8")) return ["3","4","5","6","7","8"];
    // Turf labels (we return placeholders; they will be ignored when floor installed)
    if (f.includes("full turf")) return ["FH_FULL_TURF"];
    if (f.includes("half turf north")) return ["FH_HALF_N"];
    if (f.includes("half turf south")) return ["FH_HALF_S"];
    if (f.includes("quarter turf")) return ["FH_Q"];
  }

  return []; // unknown facility => drop later
}

// Name normalization
function parseReservee(raw) {
  const s = (raw || "").trim();
  if (!s) return { title: "" };

  // Pattern: "Org, Person Name"
  const parts = s.split(",").map(v => v.trim()).filter(Boolean);
  if (parts.length >= 2) {
    // If first looks like an org (contains a keyword or multiple words w/o comma in second)
    const org = parts[0];
    const rest = parts.slice(1).join(", ");
    // If rest is a person "Last First" OR "First Last" — just present as-is
    return { org, contact: rest };
  }

  // Pattern: "Last, First" (exactly one comma) — (handled by >=2 above)
  // If single token with comma present (unlikely), fall through.
  // If "Last, First" actually came through as one comma split -> handled.

  // Maybe "Last, First" didn’t split earlier? (no comma) -> try "Last First"
  const nameFlip = s.match(/^([^,]+),\s*([^,]+)$/);
  if (nameFlip) return { title: `${nameFlip[2]} ${nameFlip[1]}` };

  // Plain
  return { title: s };
}

// Reservation purpose cleanup for Pickleball
function prettifyPurpose(purpose, reservee) {
  const p = (purpose || "").toLowerCase();
  const r = (reservee || "").toLowerCase();
  if (p.includes("pickleball")) return "Open Pickleball";
  if (r.includes("pickleball")) return "Open Pickleball";
  return purpose || "";
}

// Dedup key
function slotKey(roomId, startMin, endMin, org, contact, title, subtitle) {
  return [roomId, startMin, endMin, org||"", contact||"", title||"", subtitle||""].join("|");
}

async function main() {
  if (!fs.existsSync(CSV_PATH) || fs.statSync(CSV_PATH).size === 0) {
    console.log("Empty CSV; writing empty scaffold.");
    writeOut({ rooms: defaultRooms(), slots: [] });
    return;
  }

  const raw = fs.readFileSync(CSV_PATH, "utf8");
  const rows = parseCSV(raw);
  if (!rows.length) {
    writeOut({ rooms: defaultRooms(), slots: [] });
    return;
  }

  // header detection
  const header = rows[0].map(h => h.toLowerCase().trim());
  const idx = {
    location: header.findIndex(h => h.startsWith("location")),
    facility: header.findIndex(h => h.startsWith("facility")),
    time: header.findIndex(h => h.startsWith("reserved time")),
    reservee: header.findIndex(h => h.startsWith("reservee")),
    purpose: header.findIndex(h => h.startsWith("reservation purpose")),
    qa: header.findIndex(h => h.startsWith("questionanswerall")),
  };

  const today = new Date();
  const floorOn = isBasketballFloorInstalled(today);

  // First pass: collect raw claims
  const claims = []; // {rooms[], startMin, endMin, reservee, purpose}
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || !r.length) continue;
    const location = idx.location >= 0 ? r[idx.location] : "";
    if (location && location.toLowerCase().indexOf("athletic & event center") === -1) continue;

    const fac = idx.facility >= 0 ? r[idx.facility] : "";
    const range = idx.time >= 0 ? r[idx.time] : "";
    const reservee = idx.reservee >= 0 ? r[idx.reservee] : "";
    const purpose  = idx.purpose >= 0 ? r[idx.purpose] : "";

    const mins = parseRange(range);
    if (!mins) continue;

    // Turf ignoring rule when floor installed
    const facLower = (fac || "").toLowerCase();
    const isTurf = /full turf|half turf|quarter turf|turf/.test(facLower);
    if (floorOn && facLower.includes("fieldhouse") && isTurf) {
      // ignore turf rows while basketball floor is down
      continue;
    }

    const rooms = facilityToRooms(fac);
    if (!rooms.length) continue;

    claims.push({
      rooms,
      startMin: mins.startMin,
      endMin: mins.endMin,
      reservee,
      purpose,
      facility: fac
    });
  }

  // Second pass: narrow Fieldhouse “3-8” using specific court rows by same org/time
  // For each org/time window, if it has "3-8" and also specific courts subset -> use the specific subset
  function orgKeyForClaim(c) {
    // normalize reservee for matching (org + contact + cleaned)
    return (c.reservee || "").toLowerCase().replace(/\s+/g," ");
  }
  const groupedByOrgTime = new Map(); // key => array of claims
  for (const c of claims) {
    const k = [orgKeyForClaim(c), c.startMin, c.endMin].join("|");
    if (!groupedByOrgTime.has(k)) groupedByOrgTime.set(k, []);
    groupedByOrgTime.get(k).push(c);
  }
  const refined = [];
  for (const arr of groupedByOrgTime.values()) {
    const has38 = arr.filter(x => x.rooms.length === 6 && x.rooms.join(",") === "3,4,5,6,7,8");
    const specifics = new Set(arr.flatMap(x => x.rooms.filter(r => /^[3-8]$/.test(r))));
    if (has38.length && specifics.size) {
      // drop 3-8 rows, keep specifics
      for (const c of arr) {
        if (c.rooms.length === 6 && c.rooms.join(",") === "3,4,5,6,7,8") continue;
        refined.push(c);
      }
    } else {
      refined.push(...arr);
    }
  }

  // Third pass: collapse “both courts” for (1,2) and (9,10) families
  // If within the same org/time window the union implies full coverage, emit only {1,2} or {9,10}
  const collapsed = [];
  const groupedByOrgTime2 = new Map();
  for (const c of refined) {
    const fam = familyOfRooms(c.rooms);
    const k = [orgKeyForClaim(c), c.startMin, c.endMin, fam].join("|");
    if (!groupedByOrgTime2.has(k)) groupedByOrgTime2.set(k, []);
    groupedByOrgTime2.get(k).push(c);
  }
  for (const arr of groupedByOrgTime2.values()) {
    const union = new Set(arr.flatMap(a => a.rooms));
    const fam = familyOfRooms([...union]);
    if (fam === "1-2" && union.has("1") && union.has("2")) {
      collapsed.push(mergeRooms(arr, ["1","2"]));
    } else if (fam === "9-10" && union.has("9") && union.has("10")) {
      collapsed.push(mergeRooms(arr, ["9","10"]));
    } else {
      // keep individuals
      for (const r of arr) collapsed.push(r);
    }
  }

  // Build final slots
  const seen = new Set();
  const slots = [];
  for (const c of collapsed) {
    const titleBits = parseReservee(c.reservee);
    const subtitle = prettifyPurpose(c.purpose, c.reservee);

    for (const rid of c.rooms) {
      if (!/^\d+$/.test(rid)) continue; // ignore turf placeholders

      const slot = {
        roomId: rid,
        startMin: c.startMin,
        endMin: c.endMin,
        title: titleBits.title || (titleBits.org ? titleBits.org : ""),
        subtitle: subtitle,
        org: titleBits.org || undefined,
        contact: titleBits.contact || undefined
      };

      // if title is empty but org exists, set display title to org
      if (!slot.title && slot.org) slot.title = slot.org;

      // Deduplicate
      const key = slotKey(slot.roomId, slot.startMin, slot.endMin, slot.org, slot.contact, slot.title, slot.subtitle);
      if (seen.has(key)) continue;
      seen.add(key);

      slots.push(slot);
    }
  }

  // Output
  const out = {
    dayStartMin: 360,
    dayEndMin: 1380,
    rooms: [
      { id:"1",  label:"1",  group:"south"      },
      { id:"2",  label:"2",  group:"south"      },
      { id:"3",  label:"3",  group:"fieldhouse" },
      { id:"4",  label:"4",  group:"fieldhouse" },
      { id:"5",  label:"5",  group:"fieldhouse" },
      { id:"6",  label:"6",  group:"fieldhouse" },
      { id:"7",  label:"7",  group:"fieldhouse" },
      { id:"8",  label:"8",  group:"fieldhouse" },
      { id:"9",  label:"9",  group:"north"      },
      { id:"10", label:"10", group:"north"      }
    ],
    slots
  };

  writeOut(out);
}

// family classifier for collapsing
function familyOfRooms(rooms) {
  const set = new Set(rooms);
  if (set.has("1") || set.has("2")) return "1-2";
  if (set.has("9") || set.has("10")) return "9-10";
  return "other";
}
function mergeRooms(arr, roomsOut) {
  // Keep any one claim as skeleton
  const base = { ...arr[0] };
  base.rooms = roomsOut;
  return base;
}

function defaultRooms() {
  return [
    { id:"1",  label:"1",  group:"south"      },
    { id:"2",  label:"2",  group:"south"      },
    { id:"3",  label:"3",  group:"fieldhouse" },
    { id:"4",  label:"4",  group:"fieldhouse" },
    { id:"5",  label:"5",  group:"fieldhouse" },
    { id:"6",  label:"6",  group:"fieldhouse" },
    { id:"7",  label:"7",  group:"fieldhouse" },
    { id:"8",  label:"8",  group:"fieldhouse" },
    { id:"9",  label:"9",  group:"north"      },
    { id:"10", label:"10", group:"north"      }
  ];
}

function writeOut(obj) {
  fs.writeFileSync(JSON_OUT, JSON.stringify(obj, null, 2));
  console.log(`Wrote ${JSON_OUT} • rooms=${obj.rooms?.length||0} • slots=${obj.slots?.length||0}`);
}

main().catch(err => {
  console.error("transform failed:", err);
  process.exit(1);
});
