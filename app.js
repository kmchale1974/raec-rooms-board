// app.js (ESM) — dark theme board + “Now / Next” compact view

/* ------------------ Date banner ------------------ */
const bannerDay = document.querySelector("#banner-day");
const bannerDate = document.querySelector("#banner-date");

const now = new Date();
const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: "long" });
const dateFmt = new Intl.DateTimeFormat(undefined, { month: "long", day: "numeric", year: "numeric" });

function ordinal(n){ const s=["th","st","nd","rd"]; const v=n%100; return n+(s[(v-20)%10]||s[v]||s[0]); }
bannerDay.textContent = dayFmt.format(now).toUpperCase();
const dayNum = now.getDate();
const [month] = dateFmt.format(now).split(" ");
bannerDate.innerHTML = `${month} ${ordinal(dayNum)}, ${now.getFullYear()}`;

/* ------------------ Views switch ------------------ */
const btns = [...document.querySelectorAll(".view-btn")];
const viewGrid = document.getElementById("view-grid");
const viewCompact = document.getElementById("view-compact");

btns.forEach(b=>{
  b.addEventListener("click", ()=>{
    btns.forEach(x=>x.classList.remove("active"));
    b.classList.add("active");
    const v = b.dataset.view;
    if (v === "grid"){
      viewGrid.classList.remove("hidden");
      viewCompact.classList.add("hidden");
    } else {
      viewCompact.classList.remove("hidden");
      viewGrid.classList.add("hidden");
    }
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

/* Line (grid mode) */
function slotLine({ time, who, purpose }) {
  const el = document.createElement("div");
  el.className = "slot";
  const t = document.createElement("span"); t.className="time"; t.textContent=time||"";
  const w = document.createElement("span"); w.className="who";  w.textContent=who||"";
  const p = document.createElement("span"); p.className="note"; p.textContent=purpose||"";
  el.append(t, w, p);
  return el;
}

/* Compact card components */
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

/* Helpers */
function parseISOish(x){ try{ return x ? new Date(x) : null; } catch { return null; } }
function fmtTime(d){
  if (!d) return "";
  const f = new Intl.DateTimeFormat(undefined,{hour:"numeric",minute:"2-digit"});
  return f.format(d).replace(" ", "");
}
function formatTimeRange(startISO, endISO, fallback) {
  if (fallback) return fallback;
  const s = parseISOish(startISO), e = parseISOish(endISO);
  if (!s || !e) return "";
  return `${fmtTime(s)} - ${fmtTime(e)}`;
}

/* ------------------ Load & render ------------------ */
async function loadEvents() {
  try {
    const res = await fetch("events.json", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const events = Array.isArray(data?.events) ? data.events : [];

    // GRID (board look)
    if (!events.length) {
      demoPlaceholders();
    } else {
      for (const ev of events) {
        const roomCodes = ev.roomCode ? [ev.roomCode] : roomsFromFacility(ev.facility || "");
        if (!roomCodes.length) continue;

        const time = formatTimeRange(ev.start, ev.end, ev.timeText);
        const line = slotLine({
          time,
          who: ev.who || ev.reservee || "",
          purpose: ev.purpose || ev.reservationpurpose || ""
        });

        for (const rc of roomCodes) {
          const bucket = buckets[rc];
          if (bucket) bucket.appendChild(line.cloneNode(true));
        }
      }
    }

    // COMPACT (Now / Next)
    buildCompact(events);

  } catch (err) {
    console.error("Failed to load events.json:", err);
    demoPlaceholders();
    buildCompact([]);
  }
}

/* Compact view */
function buildCompact(events){
  const container = document.getElementById("now-next-grid");
  container.innerHTML = "";

  const allRooms = ["2B","2A","1B","1A","5","8","4","7","3","6","10B","10A","9B","9A"];
  const byRoom = Object.fromEntries(allRooms.map(r=>[r,[]]));

  // Assign events to rooms
  for (const ev of events){
    const codes = ev.roomCode ? [ev.roomCode] : roomsFromFacility(ev.facility || "");
    const payload = {
      start: parseISOish(ev.start),
      end: parseISOish(ev.end),
      who: ev.who || ev.reservee || "",
      purpose: ev.purpose || ev.reservationpurpose || "",
      timeText: ev.timeText || ""
    };
    for (const c of codes) byRoom[c]?.push(payload);
  }
  // sort each room by start time
  for (const r of allRooms) byRoom[r].sort((a,b)=>(a.start?.getTime()||0)-(b.start?.getTime()||0));

  const nowMs = Date.now();

  for (const r of allRooms){
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
    // if no 'current', use first future as next; then next future as next2 (but we display only one)
    if (!current && !upcoming && list.length) {
      // all past — leave NEXT empty
    }

    fillEntry(nowEl, current, "FREE");
    fillEntry(nextEl, upcoming, "");

    container.appendChild(c);
  }
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

/* Placeholders when no data */
function demoPlaceholders(){
  const sample = slotLine({ time:"7:00p - 9:00p", who:"PINK Elite", purpose:"" });
  const sample2= slotLine({ time:"7:30p - 9:30p", who:"FFB", purpose:"" });
  buckets["7"]?.appendChild(sample.cloneNode(true));
  buckets["5"]?.appendChild(sample2.cloneNode(true));
}

loadEvents();
