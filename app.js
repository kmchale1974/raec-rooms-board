// app.js (ESM) — Board, Now/Next, and Timeline + centered date + live clock

/* ------------------ Banner: date + clock ------------------ */
const bannerDay = document.querySelector("#banner-day");
const bannerDate = document.querySelector("#banner-date");
const bannerClock = document.querySelector("#banner-clock");

const today = new Date();
const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: "long" });
const dateFmt = new Intl.DateTimeFormat(undefined, { month: "long", day: "numeric", year: "numeric" });

function ordinal(n){ const s=["th","st","nd","rd"]; const v=n%100; return n+(s[(v-20)%10]||s[v]||s[0]); }
function setBannerDate(now = new Date()){
  const d = now.getDate();
  const [month] = dateFmt.format(now).split(" ");
  bannerDay.textContent = dayFmt.format(now).toUpperCase();
  bannerDate.innerHTML = `${month} ${ordinal(d)}, ${now.getFullYear()}`;
}
function tickClock(){
  const s = new Intl.DateTimeFormat(undefined, { hour:"numeric", minute:"2-digit", second:"2-digit" }).format(new Date());
  bannerClock.textContent = s.replace(" ", "");
}
setBannerDate(today);
tickClock();
setInterval(tickClock, 1000);

/* ------------------ Views switch ------------------ */
const btns = [...document.querySelectorAll(".view-btn")];
const viewGrid = document.getElementById("view-grid");
const viewCompact = document.getElementById("view-compact");
const viewTimeline = document.getElementById("view-timeline");

btns.forEach(b=>{
  b.addEventListener("click", ()=>{
    btns.forEach(x=>x.classList.remove("active"));
    b.classList.add("active");
    const v = b.dataset.view;
    viewGrid.classList.toggle("hidden", v !== "grid");
    viewCompact.classList.toggle("hidden", v !== "compact");
    viewTimeline.classList.toggle("hidden", v !== "timeline");
  });
});

/* ------------------ Buckets for grid ------------------ */
const buckets = {
  "1A": document.getElementById("room-1A"),
  "1B": document.getElementById("room-1B"),
  "2A": document.getElementById("room-2A"),
  "2B": document.getElementById("room-2B"),
  "3": document.getElementById("room-3"),
  "4": document.getElementById("room-4"),
  "5": document.getElementById("room-5"),
  "6": document.getElementById("room-6"),
  "7": document.getElementById("room-7"),
  "8": document.getElementById("room-8"),
  "9A": document.getElementById("room-9A"),
  "9B": document.getElementById("room-9B"),
  "10A": document.getElementById("room-10A"),
  "10B": document.getElementById("room-10B")
};
const ALL_ROOMS = ["2B","2A","1B","1A","5","8","4","7","3","6","10B","10A","9B","9A"];

/* Facility → board room(s) mapper (extend as needed) */
function roomsFromFacility(str = "") {
  const s = str.toLowerCase();
  if (s.includes("court 10-ab") || s.includes("court 10 - ab")) return ["10A","10B"];
  if (s.includes("court 9-ab")  || s.includes("court 9 - ab"))  return ["9A","9B"];
  if (s.includes("half court 10a")) return ["10A"];
  if (s.includes("half court 10b")) return ["10B"];
  if (s.includes("half court 9a"))  return ["9A"];
  if (s.includes("half court 9b"))  return ["9B"];
  for (const n of ["3","4","5","6","7","8"]) {
    if (s.includes(` ${n}`) || s.endsWith(`-${n}`) || s.includes(`court ${n}`)) return [n];
  }
  for (const code of ["1A","1B","2A","2B"]) if (s.includes(code.toLowerCase())) return [code];
  return [];
}

/* ------------ Time helpers (parse & format) ------------ */
function toTodayAt(h, m){
  const d = new Date(); d.setHours(h, m, 0, 0); return d;
}
function parseAmPmToken(tok){
  const m = tok.toLowerCase().match(/^(\d{1,2})(?::(\d{2}))?\s*(a|p)\.?m?\.?$/i);
  if(!m) return null;
  let hh = parseInt(m[1],10);
  const mm = m[2] ? parseInt(m[2],10) : 0;
  const ap = m[3].toLowerCase();
  if(ap === "p" && hh !== 12) hh += 12;
  if(ap === "a" && hh === 12) hh = 0;
  return {h:hh, m:mm};
}
/** Accepts "6:30pm - 8:00pm" (with optional double spaces) and returns [startDate, endDate] for today. */
function parseTimeRangeText(txt){
  if(!txt) return [null, null];
  const [a,b] = txt.split("-").map(s=>s.trim().replace(/\s+/g," "));
  const A = parseAmPmToken(a);
  const B = parseAmPmToken(b);
  if(!A || !B) return [null, null];
  return [toTodayAt(A.h, A.m), toTodayAt(B.h, B.m)];
}

function parseISOish(x){ try{ return x ? new Date(x) : null; } catch { return null; } }
function fmtTime(d){
  if (!d) return "";
  const f = new Intl.DateTimeFormat(undefined,{hour:"numeric",minute:"2-digit"});
  return f.format(d).replace(" ", "");
}
function timeRangeText(startISO, endISO, fallback) {
  if (fallback) return fallback;
  const s = parseISOish(startISO), e = parseISOish(endISO);
  if (!s || !e) return "";
  return `${fmtTime(s)} - ${fmtTime(e)}`;
}

/* ------------------ UI builders ------------------ */
function slotLine({ time, who, purpose }) {
  const el = document.createElement("div");
  el.className = "slot";
  const t = document.createElement("span"); t.className="time"; t.textContent=time||"";
  const w = document.createElement("span"); w.className="who";  w.textContent=who||"";
  const p = document.createElement("span"); p.className="note"; p.textContent=purpose||"";
  el.append(t, w, p);
  return el;
}

function card(room){
  const c = document.createElement("div");
  c.className="card";
  c.innerHTML = `
    <div class="title">
      <span>${room}</span>
      <span class="badge">Now / Next</span>
    </div>
    <div class="entry entry-now"><span class="when">NOW</span> <span class="who"></span> <span class="desc"></span></div>
    <div class="entry entry-next"><span class="when">NEXT</span> <span class="who"></span> <span class="desc"></span></div>
  `;
  return c;
}
function fillEntry(el, ev, emptyWord){
  const who = el.querySelector(".who");
  const desc = el.querySelector(".desc");
  const when = el.querySelector(".when");

  if (!ev){
    who.textContent = emptyWord || "";
    desc.textContent = "";
    when.classList.add("muted");
    return;
  }
  const time = ev.timeText || `${fmtTime(ev.start)} - ${fmtTime(ev.end)}`;
  when.textContent = time;
  who.textContent = ev.who || "";
  desc.textContent = ev.purpose || "";
}

/* ------------------ Load & render ------------------ */
async function loadEvents() {
  try {
    const res = await fetch("events.json", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const events = Array.isArray(data?.events) ? data.events : [];

    // Normalize to {rooms[], start, end, who, purpose, timeText}
    const normalized = [];
    for (const raw of events){
      const rooms = raw.roomCode ? [raw.roomCode] : roomsFromFacility(raw.facility || "");
      if (!rooms.length) continue;

      // Prefer ISO times; else parse reservedtime text (“6:30pm - 8:00pm”)
      let start = parseISOish(raw.start), end = parseISOish(raw.end), timeText = raw.timeText;
      if ((!start || !end) && (raw.reservedtime || raw.timeText)) {
        const [s,e] = parseTimeRangeText(raw.reservedtime || raw.timeText);
        start = start || s; end = end || e;
      }
      normalized.push({
        rooms,
        start,
        end,
        who: raw.who || raw.reservee || "",
        purpose: raw.purpose || raw.reservationpurpose || "",
        timeText: timeText || (start && end ? "" : (raw.reservedtime || ""))
      });
    }

    /* ---------- Board (grid) ---------- */
    if (!normalized.length) {
      demoPlaceholders();
    } else {
      for (const ev of normalized) {
        const displayTime = timeRangeText(ev.start?.toISOString(), ev.end?.toISOString(), ev.timeText);
        const line = slotLine({ time: displayTime, who: ev.who, purpose: ev.purpose });
        for (const rc of ev.rooms) buckets[rc]?.appendChild(line.cloneNode(true));
      }
    }

    /* ---------- Now / Next ---------- */
    buildCompact(normalized);

    /* ---------- Timeline ---------- */
    buildTimeline(normalized);

  } catch (err) {
    console.error("Failed to load events.json:", err);
    demoPlaceholders();
    buildCompact([]);
    buildTimeline([]);
  }
}

/* ----------- Compact (Now / Next) ----------- */
function buildCompact(events){
  const container = document.getElementById("now-next-grid");
  container.innerHTML = "";

  const byRoom = Object.fromEntries(ALL_ROOMS.map(r=>[r,[]]));
  for (const ev of events){
    const payload = {
      start: ev.start,
      end: ev.end,
      who: ev.who,
      purpose: ev.purpose,
      timeText: ev.timeText
    };
    for (const c of ev.rooms) byRoom[c]?.push(payload);
  }
  for (const r of ALL_ROOMS) byRoom[r].sort((a,b)=>(a.start?.getTime()||0)-(b.start?.getTime()||0));

  const nowMs = Date.now();

  for (const r of ALL_ROOMS){
    const c = card(r);
    const nowEl  = c.querySelector(".entry-now");
    const nextEl = c.querySelector(".entry-next");

    const list = byRoom[r];
    let current = null, upcoming = null;

    for (const e of list){
      const s = e.start?.getTime() ?? -Infinity;
      const en = e.end?.getTime() ?? Infinity;
      if (s <= nowMs && nowMs < en){ current = e; break; }
      if (!upcoming && s > nowMs){ upcoming = e; }
    }

    fillEntry(nowEl, current, "FREE");
    fillEntry(nextEl, upcoming, "");

    container.appendChild(c);
  }
}

/* ----------- Timeline (hours left→right) ----------- */
function minutesSince(d0, d){ return (d.getTime() - d0.getTime())/60000; }

function buildTimeline(events){
  const hoursEl = document.getElementById("tl-hours");
  const gridEl  = document.getElementById("tl-grid");
  hoursEl.innerHTML = "";
  gridEl.innerHTML  = "";

  // Determine day window: default 6:00 → 22:00, expand to fit events if needed
  let dayStart = toTodayAt(6,0);
  let dayEnd   = toTodayAt(22,0);
  for (const e of events){
    if (e.start && e.start < dayStart) dayStart = toTodayAt(e.start.getHours(), e.start.getMinutes());
    if (e.end && e.end > dayEnd) dayEnd = toTodayAt(e.end.getHours(), e.end.getMinutes());
  }
  // Snap to hour edges
  dayStart.setMinutes(0,0,0);
  dayEnd.setMinutes(0,0,0);

  const totalMinutes = Math.max(60, minutesSince(dayStart, dayEnd));
  const pxPerMinute  = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--tl-hour-w")) / 60;

  // Hours header
  for (let d = new Date(dayStart); d <= dayEnd; d.setHours(d.getHours()+1)){
    const h = document.createElement("div");
    h.className = "tl-hour";
    h.style.minWidth = `calc(var(--tl-hour-w))`;
    h.textContent = new Intl.DateTimeFormat(undefined, { hour:"numeric" }).format(d).replace(" ", "");
    hoursEl.appendChild(h);
  }

  // Rows per room
  const byRoom = Object.fromEntries(ALL_ROOMS.map(r=>[r,[]]));
  for (const ev of events){
    for (const r of ev.rooms){
      byRoom[r]?.push(ev);
    }
  }
  for (const r of ALL_ROOMS) byRoom[r].sort((a,b)=>(a.start?.getTime()||0)-(b.start?.getTime()||0));

  // Build rows
  for (const r of ALL_ROOMS){
    const row = document.createElement("div");
    row.className = "tl-row";

    const name = document.createElement("div");
    name.className = "tl-room";
    name.textContent = r;

    const track = document.createElement("div");
    track.className = "tl-track";
    track.style.width = `${totalMinutes * pxPerMinute}px`;

    // “Now” line
    const now = new Date();
    if (now >= dayStart && now <= dayEnd){
      const x = minutesSince(dayStart, now) * pxPerMinute;
      const nowLine = document.createElement("div");
      nowLine.className = "tl-now";
      nowLine.style.left = `${x}px`;
      track.appendChild(nowLine);
    }

    // Events
    for (const ev of byRoom[r]){
      const s = ev.start, e = ev.end;
      // If missing ISO but we have timeText, try parsing that
      let s2 = s, e2 = e;
      if ((!s2 || !e2) && ev.timeText){
        const [ps,pe] = parseTimeRangeText(ev.timeText);
        s2 = s2 || ps; e2 = e2 || pe;
      }
      if (!s2 || !e2) continue;

      // Clamp within the visible window
      const sClamped = s2 < dayStart ? dayStart : s2;
      const eClamped = e2 > dayEnd   ? dayEnd   : e2;
      if (eClamped <= dayStart || sClamped >= dayEnd) continue;

      const left = minutesSince(dayStart, sClamped) * pxPerMinute;
      const width= minutesSince(sClamped, eClamped) * pxPerMinute;

      const box = document.createElement("div");
      box.className = "tl-event";
      box.style.left = `${left}px`;
      box.style.width= `${width}px`;
      box.title = `${r}: ${ev.who || ""} — ${ev.purpose || ""}`;

      const t = document.createElement("span"); t.className="t"; t.textContent = `${fmtTime(s2)}–${fmtTime(e2)}`;
      const w = document.createElement("span"); w.className="w"; w.textContent = ev.who || "";
      const d = document.createElement("span"); d.className="d"; d.textContent = ev.purpose || "";

      box.append(t, w, d);
      track.appendChild(box);
    }

    row.append(name, track);
    gridEl.appendChild(row);
  }
}

/* ----------- Placeholders if no data ----------- */
function demoPlaceholders(){
  const sample = slotLine({ time:"7:00p - 9:00p", who:"PINK Elite", purpose:"" });
  const sample2= slotLine({ time:"7:30p - 9:30p", who:"FFB", purpose:"" });
  buckets["7"]?.appendChild(sample.cloneNode(true));
  buckets["5"]?.appendChild(sample2.cloneNode(true));
}

loadEvents();
