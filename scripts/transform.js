import fs from "fs";
import { parse as parseCSV } from "csv-parse/sync";

// --- Config ---
const TZ = process.env.TZ || "America/Chicago";
const CSV_PATH = process.env.CSV_PATH || "data/inbox/latest.csv";
const JSON_OUT = process.env.JSON_OUT || "events.json";

// ----- helpers: “today” window in local tz -----
function makeLocalDate(y, m, d, hh = 0, mm = 0, ss = 0, ms = 0) {
  // Build a Date representing local time in TZ by formatting and reparsing.
  // (Node Dates are UTC internally, but this yields the correct wall time.)
  const pad = (n, len = 2) => String(n).padStart(len, "0");
  const s = `${pad(y, 4)}-${pad(m)}-${pad(d)}T${pad(hh)}:${pad(mm)}:${pad(ss)}.${pad(ms, 3)}`;
  // Force parse as if in TZ by using Intl to get UTC millis for that wall time.
  // We do this by formatting an instant that has those wall-time components.
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  // Trick: find today's date parts in TZ, then replace with our parts.
  const now = new Date();
  const parts = Object.fromEntries(fmt.formatToParts(now).map(p => [p.type, p.value]));
  const asLocal = new Date(
    `${s}` // ISO-like
  );
  // asLocal will be interpreted in local machine TZ; we’ll correct with getOffset:
  // Instead of fighting Date quirks, compute millis for desired local wall time in TZ:
  const utcMillis = Date.parse(`${s}Z`); // base
  // We want wall time s in TZ, so find its UTC millis by asking what UTC corresponds to s in TZ:
  const z = new Date(utcMillis);
  // The more robust way: use the today anchor in TZ, then set hours/minutes relative:
  return new Date(s); // Works for our use here; we'll align “today” using below function.
}

// Get start/end of “today” in TZ
function todayRangeInTZ() {
  const now = new Date();
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
  });
  const parts = Object.fromEntries(f.formatToParts(now).map(p => [p.type, p.value]));
  const y = Number(parts.year), m = Number(parts.month), d = Number(parts.day);

  // Create day start/end as if wall time in TZ, then convert to real Date via toLocaleString
  const dayStartLocal = new Date(`${y}-${String(m).padStart(2,"0")}-${String(d).padStart(2,"0")}T00:00:00`);
  const dayEndLocal   = new Date(`${y}-${String(m).padStart(2,"0")}-${String(d).padStart(2,"0")}T23:59:59.999`);

  return { dayStart: dayStartLocal, dayEnd: dayEndLocal, y, m, d };
}

// Parse “3:00pm - 4:30pm” into Date objects on **today** in TZ
function parseTimeRangeText(txt, y, m, d) {
  if (!txt) return [null, null];
  const parts = String(txt).split("-").map(p => p.trim().replace(/\s+/g, " "));
  if (parts.length !== 2) return [null, null];

  const tok = (t) => {
    const m = t.toLowerCase().match(/^(\d{1,2})(?::(\d{2}))?\s*(a|p)\.?m?\.?$/);
    if (!m) return null;
    let hh = parseInt(m[1], 10);
    const mm = m[2] ? parseInt(m[2], 10) : 0;
    const ap = m[3];
    if (ap === "p" && hh !== 12) hh += 12;
    if (ap === "a" && hh === 12) hh = 0;
    return { hh, mm };
  };

  const A = tok(parts[0]);
  const B = tok(parts[1]);
  if (!A || !B) return [null, null];

  const start = new Date(`${y}-${String(m).padStart(2,"0")}-${String(d).padStart(2,"0")}T${String(A.hh).padStart(2,"0")}:${String(A.mm).padStart(2,"0")}:00`);
  const end   = new Date(`${y}-${String(m).padStart(2,"0")}-${String(d).padStart(2,"0")}T${String(B.hh).padStart(2,"0")}:${String(B.mm).padStart(2,"0")}:00`);
  return [start, end];
}

// Room mapping (Courts 3–8, 9A/9B, 10A/10B, combos)
function roomsFromFacility(fac = "") {
  const s = String(fac).trim().toLowerCase();

  // Gym 9/10 combos
  if (s.includes("court 10-ab") || s.includes("court 10 - ab")) return ["10A", "10B"];
  if (s.includes("court 9-ab")  || s.includes("court 9 - ab"))  return ["9A", "9B"];

  // Half courts
  if (s.includes("half court 10a")) return ["10A"];
  if (s.includes("half court 10b")) return ["10B"];
  if (s.includes("half court 9a"))  return ["9A"];
  if (s.includes("half court 9b"))  return ["9B"];

  // Full courts 3–8 (e.g., “AC Gym - Court 3”)
  for (const n of [3,4,5,6,7,8]) {
    if (s.includes(`court ${n}`)) return [String(n)];
  }

  // Fallback: explicit codes in free text
  for (const code of ["1A","1B","2A","2B","3","4","5","6","7","8","9A","9B","10A","10B"]) {
    if (s.includes(code.toLowerCase())) return [code];
  }

  return [];
}

// Keep events that overlap today in TZ (should always be true once we build them for today)
function overlapsToday(start, end, dayStart, dayEnd) {
  return start < dayEnd && end > dayStart;
}

// --- main ---
(async () => {
  if (!fs.existsSync(CSV_PATH)) {
    await fs.promises.writeFile(JSON_OUT, JSON.stringify({ events: [] }, null, 2));
    console.log(`No CSV. Wrote ${JSON_OUT} with 0 events.`);
    return;
  }

  const csvBuf = await fs.promises.readFile(CSV_PATH);
  const text = csvBuf.toString();

  // Detect delimiter (comma or semicolon), then parse
  const delimiter = text.includes(";") && !text.includes(",") ? ";" : ",";
  const rows = parseCSV(text, { columns: true, skip_empty_lines: true, delimiter });

  const { dayStart, dayEnd, y, m, d } = todayRangeInTZ();

  const out = [];
  for (const row of rows) {
    const facility = row.facility ?? row.Facility ?? row["Facility"] ?? "";
    const rooms = roomsFromFacility(facility);
    if (!rooms.length) continue;

    // who / purpose
    const who = row.reservee ?? row["Reservee"] ?? "";
    const purpose = row.reservationpurpose ?? row["Reservation Purpose"] ?? "";

    // Times: prefer explicit start/end fields if they exist; else parse reservedtime text (e.g., “6:00pm - 9:00pm”)
    let start = row.start ? new Date(row.start) : null;
    let end   = row.end   ? new Date(row.end)   : null;

    if ((!start || !end) && (row.reservedtime || row["ReservedTime"])) {
      const [s, e] = parseTimeRangeText(row.reservedtime ?? row["ReservedTime"], y, m, d);
      start = start || s;
      end   = end   || e;
    }

    if (!start || !end) continue;
    if (!overlapsToday(start, end, dayStart, dayEnd)) continue;

    for (const room of rooms) {
      out.push({
        room,
        start: start.toISOString(),
        end: end.toISOString(),
        who,
        purpose,
        facility
      });
    }
  }

  // Sort output by room then start time (helps the renderer)
  out.sort((a, b) => {
    const roomOrder = [
      "1A","1B","2A","2B","3","4","5","6","7","8","9A","9B","10A","10B"
    ];
    const ra = roomOrder.indexOf(a.room);
    const rb = roomOrder.indexOf(b.room);
    if (ra !== rb) return ra - rb;
    return new Date(a.start) - new Date(b.start);
  });

  await fs.promises.writeFile(JSON_OUT, JSON.stringify({ events: out }, null, 2));
  console.log(`Wrote ${JSON_OUT} • events=${out.length}`);
})();
