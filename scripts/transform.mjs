#!/usr/bin/env node
// Transform latest CSV → events.json with RAEC logic (v2025-11-05)

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const INPUT_CSV = process.env.IN_CSV || path.join(__dirname, "..", "data", "inbox", "latest.csv");
const OUTPUT_JSON = path.join(__dirname, "..", "events.json");

// ---------- Helpers ----------
function clean(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function parseRangeToMinutes(text) {
  if (!text) return null;
  const m = String(text)
    .trim()
    .match(/(\d{1,2}:\d{2})\s*(am|pm)\s*-\s*(\d{1,2}:\d{2})\s*(am|pm)/i);
  if (!m) return null;
  const toMin = (h, m, ap) => {
    let hh = parseInt(h, 10),
      mm = parseInt(m, 10);
    if (ap.toLowerCase() === "pm" && hh !== 12) hh += 12;
    if (ap.toLowerCase() === "am" && hh === 12) hh = 0;
    return hh * 60 + mm;
  };
  return { startMin: toMin(m[1].split(":")[0], m[1].split(":")[1], m[2]), endMin: toMin(m[3].split(":")[0], m[3].split(":")[1], m[4]) };
}

function nthWeekdayOfMonth(year, monthIdx, weekday, n) {
  const d = new Date(year, monthIdx, 1);
  let count = 0;
  while (d.getMonth() === monthIdx) {
    if (d.getDay() === weekday) {
      count++;
      if (count === n) return new Date(d);
    }
    d.setDate(d.getDate() + 1);
  }
  return null;
}

function isCourtSeason(d = new Date()) {
  const y = d.getFullYear();
  const thirdMonMar = nthWeekdayOfMonth(y, 2, 1, 3);
  const secondMonNov = nthWeekdayOfMonth(y, 10, 1, 2);
  return d >= thirdMonMar && d < secondMonNov;
}

function isPickleballText(s) {
  if (!s) return false;
  return /\bpickle\s*ball\b|\bpickleball\b|\bopen\s*pb\b|\bopen\s*pickleball\b/i.test(String(s));
}

// ----------- Mapping ----------
function mapFacilityToRooms(f) {
  const facility = clean(f).toLowerCase();

  // South Gym
  if (/championship court/i.test(f)) return ["1A", "1B", "2A", "2B"];
  if (/full gym 1ab & 2ab/i.test(f)) return ["1A", "1B", "2A", "2B"];
  if (/half court 1a/i.test(f)) return ["1A"];
  if (/half court 1b/i.test(f)) return ["1B"];
  if (/court 1-ab/i.test(f)) return ["1A", "1B"];
  if (/half court 2a/i.test(f)) return ["2A"];
  if (/half court 2b/i.test(f)) return ["2B"];
  if (/court 2-ab/i.test(f)) return ["2A", "2B"];

  // Fieldhouse
  if (/fieldhouse - court 3-8/i.test(f)) return ["3", "4", "5", "6", "7", "8"];
  if (/fieldhouse - court (\d)/i.test(f)) return [RegExp.$1];
  if (/half turf north/i.test(f)) return ["6", "7", "8"];
  if (/half turf south/i.test(f)) return ["3", "4", "5"];
  if (/quarter turf n/i.test(f)) return ["7", "8"];
  if (/quarter turf s/i.test(f)) return ["3", "4"];
  if (/full turf/i.test(f)) return ["3", "4", "5", "6", "7", "8"];

  // North Gym
  if (/full gym 9 & 10/i.test(f)) return ["9A", "9B", "10A", "10B"];
  if (/half court 9a/i.test(f)) return ["9A"];
  if (/half court 9b/i.test(f)) return ["9B"];
  if (/court 9-ab/i.test(f)) return ["9A", "9B"];
  if (/half court 10a/i.test(f)) return ["10A"];
  if (/half court 10b/i.test(f)) return ["10B"];
  if (/court 10-ab/i.test(f)) return ["10A", "10B"];

  return [];
}

function normalizeReservee(raw) {
  const s = clean(raw);
  if (/raec front desk/i.test(s)) return { type: "system", org: "RAEC Front Desk", contact: "" };
  if (/catch/i.test(s)) return { type: "catch", org: "Catch Corner", contact: "" };
  const parts = s.split(",").map((x) => x.trim());
  if (parts.length >= 2) {
    const left = parts[0];
    const right = parts.slice(1).join(", ");
    if (/club|elite|training|athletics|sport|volleyball|basketball|academy|united/i.test(left))
      return { type: "org+contact", org: left, contact: right };
    if (/^[A-Za-z'.-]+\s+[A-Za-z'.-]+/.test(right))
      return { type: "person", person: `${right} ${left}`.trim(), org: "", contact: "" };
    return { type: "org+contact", org: left, contact: right };
  }
  return { type: "org", org: s, contact: "" };
}

function cleanPurpose(s) {
  return String(s || "")
    .replace(/\(.*?\)/g, "")
    .replace(/internal hold per nm/i, "")
    .trim();
}

function overlaps(a, b) {
  return a.startMin < b.endMin && b.startMin < a.endMin;
}

// ---------- Main ----------
async function main() {
  if (!fs.existsSync(INPUT_CSV)) {
    console.error("No CSV found");
    return;
  }
  const raw = fs.readFileSync(INPUT_CSV, "utf8");
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) {
    console.error("CSV empty");
    return;
  }

  const header = lines[0].split(",");
  const idx = (name) => header.findIndex((h) => h.trim().toLowerCase() === name.toLowerCase());
  const iLoc = idx("Location:");
  const iFac = idx("Facility");
  const iTime = idx("Reserved Time");
  const iRes = idx("Reservee");
  const iPur = idx("Reservation Purpose");

  const courtMode = isCourtSeason(new Date());

  const items = [];
  const dropped = { internal: 0, past: 0 };

  for (let i = 1; i < lines.length; i++) {
    const row = lines[i].split(",");
    const loc = clean(row[iLoc]);
    const fac = clean(row[iFac]);
    const tim = clean(row[iTime]);
    const res = clean(row[iRes]);
    const pur = clean(row[iPur]);
    if (!fac || !tim) continue;
    if (loc && !/athletic/i.test(loc)) continue;

    // ignore turf during court season
    if (courtMode && /turf/i.test(fac)) continue;

    const range = parseRangeToMinutes(tim);
    if (!range) continue;
    const rooms = mapFacilityToRooms(fac);
    if (!rooms.length) continue;

    const who = normalizeReservee(res);
    const purpose = cleanPurpose(pur);
    const isPB = isPickleballText(purpose) || isPickleballText(res);

    const looksInternal =
      /front\s*desk|internal\s*hold|hold\s*per\s*nm|per\s*nm/i.test(res) ||
      /front\s*desk|internal\s*hold|hold\s*per\s*nm|per\s*nm/i.test(purpose) ||
      who.type === "system";

    if (looksInternal && !isPB) {
      dropped.internal++;
      continue;
    }

    let title = "",
      subtitle = "",
      org = "",
      contact = "";

    if (isPB) {
      title = "Open Pickleball";
      subtitle = "";
      org = "Open Pickleball";
      contact = "";
    } else if (who.type === "catch") {
      title = "Catch Corner";
      subtitle = purpose;
      org = "Catch Corner";
      contact = "";
    } else if (who.type === "person") {
      title = who.person;
      subtitle = purpose;
      org = who.person;
      contact = "";
    } else if (who.type === "org+contact") {
      title = who.org;
      subtitle = purpose || who.contact;
      org = who.org;
      contact = who.contact;
    } else {
      title = who.org || "Reservation";
      subtitle = purpose;
      org = who.org || "";
      contact = who.contact || "";
    }

    items.push({ rooms, startMin: range.startMin, endMin: range.endMin, title, subtitle, org, contact });
  }

  // De-duplicate overlapping blanket vs specific
  const results = [];
  const specifics = items.filter((it) => it.rooms.length <= 2);
  for (const it of items) {
    if (it.rooms.length >= 4 && it.rooms.every((r) => /^[3-8]$/.test(r))) {
      const keepRooms = it.rooms.filter((r) => {
        const conflict = specifics.some(
          (sp) => sp.org === it.org && overlaps(sp, it) && sp.rooms.includes(r)
        );
        return !conflict;
      });
      keepRooms.forEach((r) =>
        results.push({ roomId: r, startMin: it.startMin, endMin: it.endMin, title: it.title, subtitle: it.subtitle, org: it.org, contact: it.contact })
      );
    } else {
      it.rooms.forEach((r) =>
        results.push({ roomId: r, startMin: it.startMin, endMin: it.endMin, title: it.title, subtitle: it.subtitle, org: it.org, contact: it.contact })
      );
    }
  }

  const json = {
    dayStartMin: 360,
    dayEndMin: 1380,
    rooms: [
      { id: "1A", label: "1A", group: "south" },
      { id: "1B", label: "1B", group: "south" },
      { id: "2A", label: "2A", group: "south" },
      { id: "2B", label: "2B", group: "south" },
      { id: "3", label: "3", group: "fieldhouse" },
      { id: "4", label: "4", group: "fieldhouse" },
      { id: "5", label: "5", group: "fieldhouse" },
      { id: "6", label: "6", group: "fieldhouse" },
      { id: "7", label: "7", group: "fieldhouse" },
      { id: "8", label: "8", group: "fieldhouse" },
      { id: "9A", label: "9A", group: "north" },
      { id: "9B", label: "9B", group: "north" },
      { id: "10A", label: "10A", group: "north" },
      { id: "10B", label: "10B", group: "north" },
    ],
    slots: results,
  };

  console.log(`transform: rows=${lines.length - 1} kept=${items.length} slots=${results.length} drop=${JSON.stringify(dropped)}`);
  fs.writeFileSync(OUTPUT_JSON, JSON.stringify(json, null, 2));
  console.log(`Wrote ${OUTPUT_JSON} • slots=${results.length}`);
}

main().catch((err) => {
  console.error("transform.mjs failed:", err);
  process.exit(1);
});
