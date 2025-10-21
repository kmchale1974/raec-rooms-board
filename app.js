// app.js
const STAGE_W = 1920, STAGE_H = 1080;

// --------- helpers
const pad = n => (n < 10 ? "0" + n : "" + n);
function minsTo12h(mm) {
  let h = Math.floor(mm / 60);
  const m = mm % 60;
  const ampm = h >= 12 ? "pm" : "am";
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:${pad(m)}${ampm}`;
}
function formatRange(s, e) {
  return `${minsTo12h(s)} - ${minsTo12h(e)}`;
}

// --------- auto-fit 1920×1080 with safe margins (prevents right/bottom clipping)
(function fitStageSetup() {
  const MARGIN = 16; // safe outer margin so content never kisses edges
  function fit() {
    const availW = window.innerWidth - MARGIN * 2;
    const availH = window.innerHeight - MARGIN * 2;
    const sx = availW / STAGE_W;
    const sy = availH / STAGE_H;
    const s = Math.min(sx, sy);

    const stage = document.querySelector(".stage");
    const wrap = document.querySelector(".wrap");
    if (!stage || !wrap) return;

    stage.style.transform = `scale(${s})`;
    stage.style.transformOrigin = "top left";
    wrap.style.padding = `${MARGIN}px`;
    wrap.style.display = "flex";
    wrap.style.justifyContent = "center";
    wrap.style.alignItems = "flex-start";
    wrap.style.height = "100vh";
    wrap.style.boxSizing = "border-box";
  }
  window.addEventListener("resize", fit);
  window.addEventListener("orientationchange", fit);
  document.addEventListener("DOMContentLoaded", fit);
})();

// --------- renderers
function setHeader() {
  const now = new Date();
  const dateEl = document.getElementById("headerDate");
  const clockEl = document.getElementById("headerClock");
  const opts = { weekday: "long", month: "long", day: "numeric", year: "numeric" };
  dateEl.textContent = now.toLocaleDateString(undefined, opts);
  const tick = () => {
    const t = new Date();
    let hh = t.getHours(), mm = pad(t.getMinutes());
    const ampm = hh >= 12 ? "pm" : "am";
    hh = hh % 12; if (hh === 0) hh = 12;
    clockEl.textContent = `${hh}:${mm}${ampm}`;
  };
  tick();
  setInterval(tick, 1000 * 15);
}

function roomCard(roomId, events) {
  const card = document.createElement("div");
  card.className = "room";

  const hdr = document.createElement("div");
  hdr.className = "roomHeader";
  const id = document.createElement("div");
  id.className = "id";
  id.textContent = roomId;
  hdr.appendChild(id);
  card.appendChild(hdr);

  const list = document.createElement("div");
  list.className = "events";

  if (!events.length) {
    const empty = document.createElement("div");
    empty.className = "event event--empty";
    empty.textContent = "—";
    list.appendChild(empty);
  } else {
    for (const ev of events) {
      const it = document.createElement("div");
      it.className = "event";

      const who = document.createElement("div");
      who.className = "who";
      who.innerHTML = ev.org
        ? `<strong>${ev.org}</strong>${ev.contact ? `<div class="contact">${ev.contact}</div>` : ""}`
        : `<strong>${ev.title}</strong>`;

      const what = document.createElement("div");
      what.className = "what";
      what.textContent = ev.subtitle || "";

      const when = document.createElement("div");
      when.className = "when";
      when.textContent = formatRange(ev.startMin, ev.endMin);

      it.appendChild(who);
      if (ev.subtitle) it.appendChild(what);
      it.appendChild(when);
      list.appendChild(it);
    }
  }

  card.appendChild(list);
  return card;
}

function renderGrid(data) {
  // data.rooms: [{id:"1", group:"south"|"fieldhouse"|"north"}, ...]
  // data.slots: [{roomId:"1", startMin, endMin, title, subtitle, org?, contact?}, ...]

  // Filter out past events
  const nowMin = new Date();
  const now = nowMin.getHours() * 60 + nowMin.getMinutes();
  const slots = (data.slots || []).filter(s => s.endMin > now);

  // group slots by room id
  const byRoom = new Map();
  for (const r of data.rooms) byRoom.set(r.id, []);
  for (const s of slots) {
    if (!byRoom.has(String(s.roomId))) byRoom.set(String(s.roomId), []);
    byRoom.get(String(s.roomId)).push(s);
  }
  // sort inside room by start time
  for (const arr of byRoom.values()) arr.sort((a, b) => a.startMin - b.startMin);

  // mount
  const southEl = document.getElementById("southRooms");
  const fieldEl = document.getElementById("fieldhouseRooms");
  const northEl = document.getElementById("northRooms");
  southEl.innerHTML = "";
  fieldEl.innerHTML = "";
  northEl.innerHTML = "";

  const south = data.rooms.filter(r => r.group === "south").sort((a,b)=>+a.id - +b.id); // 1,2
  const field = data.rooms.filter(r => r.group === "fieldhouse").sort((a,b)=>+a.id - +b.id); // 3..8
  const north = data.rooms.filter(r => r.group === "north").sort((a,b)=>+a.id - +b.id); // 9,10

  for (const r of south) southEl.appendChild(roomCard(r.label, byRoom.get(r.id) || []));
  for (const r of field) fieldEl.appendChild(roomCard(r.label, byRoom.get(r.id) || []));
  for (const r of north) northEl.appendChild(roomCard(r.label, byRoom.get(r.id) || []));
}

async function loadData() {
  const url = `./events.json?ts=${Date.now()}`;
  const resp = await fetch(url, { cache: "no-store" });
  if (!resp.ok) throw new Error(`fetch ${url}: ${resp.status}`);
  return resp.json();
}

async function init() {
  setHeader();
  try {
    const data = await loadData();
    console.log("Loaded events.json", data);
    renderGrid(data);
  } catch (e) {
    console.error(e);
  }
  // refresh grid every 2 minutes so past events fall off naturally
  setInterval(async () => {
    try {
      const data = await loadData();
      renderGrid(data);
    } catch {}
  }, 120000);
}

document.addEventListener("DOMContentLoaded", init);
