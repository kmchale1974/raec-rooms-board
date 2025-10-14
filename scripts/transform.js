// ...imports and CSV read remain the same

// ===== 1) ROOM MAPPING (add Courts 3–8) =====
function roomsFromFacility(fac = "") {
  const s = String(fac).trim().toLowerCase();

  // 10 / 9 combo courts
  if (s.includes("court 10-ab") || s.includes("court 10 - ab")) return ["10A", "10B"];
  if (s.includes("court 9-ab")  || s.includes("court 9 - ab"))  return ["9A", "9B"];

  // Half-courts explicitly called out
  if (s.includes("half court 10a")) return ["10A"];
  if (s.includes("half court 10b")) return ["10B"];
  if (s.includes("half court 9a"))  return ["9A"];
  if (s.includes("half court 9b"))  return ["9B"];

  // Full courts 3–8 (AC Gym - Court 3 .. Court 8)
  for (const n of [3,4,5,6,7,8]) {
    if (s.includes(`court ${n}`)) return [String(n)];
  }

  // Fallback: look for direct codes in text (1A/1B/2A/2B/9A/9B/10A/10B)
  for (const code of ["1A","1B","2A","2B","9A","9B","10A","10B"]) {
    if (s.includes(code.toLowerCase())) return [code];
  }

  return [];
}

// ===== 2) REPORT DATE HANDLING =====
// If your CSV has NO calendar date, we need a base day.
// Option A: set REPORT_DATE=YYYY-MM-DD in the workflow.
// Option B: we assume "today".
const reportDateStr = process.env.REPORT_DATE || null;
function toReportDateAt(h, m) {
  const d = reportDateStr ? new Date(`${reportDateStr}T00:00:00`) : new Date();
  d.setHours(h, m, 0, 0);
  return d;
}

// Parse “3:00pm - 4:30pm” style into concrete Date on report day
function parseTimeRangeText(txt) {
  if (!txt) return [null, null];
  const parts = String(txt).split("-").map(p => p.trim().replace(/\s+/g, " "));
  if (parts.length !== 2) return [null, null];

  const parseTok = (t) => {
    const m = t.toLowerCase().match(/^(\d{1,2})(?::(\d{2}))?\s*(a|p)\.?m?\.?$/);
    if (!m) return null;
    let hh = parseInt(m[1], 10);
    const mm = m[2] ? parseInt(m[2], 10) : 0;
    const ap = m[3];
    if (ap === "p" && hh !== 12) hh += 12;
    if (ap === "a" && hh === 12) hh = 0;
    return { hh, mm };
  };

  const A = parseTok(parts[0]);
  const B = parseTok(parts[1]);
  if (!A || !B) return [null, null];

  return [toReportDateAt(A.hh, A.mm), toReportDateAt(B.hh, B.mm)];
}

// ===== 3) FILTERING ON THE REPORT DAY =====
// Keep events that overlap the report day (00:00–24:00 of REPORT_DATE or today)
function overlapsReportDay(start, end) {
  const dayStart = toReportDateAt(0, 0);
  const dayEnd   = toReportDateAt(23, 59, 59, 999);
  return start < dayEnd && end > dayStart;
}

// ===== 4) MAIN TRANSFORM =====
function normalizeRow(row) {
  const facility = row.facility || row.Facility || "";
  const rooms = roomsFromFacility(facility);
  if (!rooms.length) return null;

  const who = row.reservee || row.who || row["Reservee"] || "";
  const purpose = row.reservationpurpose || row.purpose || row["Reservation Purpose"] || "";

  // Prefer explicit ISO start/end if present, else parse reservedtime text
  let start = row.start ? new Date(row.start) : null;
  let end   = row.end   ? new Date(row.end)   : null;

  if ((!start || !end) && (row.reservedtime || row.timeText)) {
    const [s, e] = parseTimeRangeText(row.reservedtime || row.timeText);
    start = start || s;
    end   = end   || e;
  }
  if (!start || !end) return null;
  if (!overlapsReportDay(start, end)) return null;

  return { rooms, start: start.toISOString(), end: end.toISOString(), who, purpose };
}

// … read CSV -> rows array

const out = [];
for (const r of rows) {
  const n = normalizeRow(r);
  if (n) out.push(n);
}

await fs.promises.writeFile(
  process.env.JSON_OUT || "events.json",
  JSON.stringify({ events: out }, null, 2)
);
console.log(`Wrote events.json • events=${out.length}`);
