// app.js – grid-only board, bigger fonts, no extra room time line,
// past events fall off, and basic duplicate suppression.

const EVENTS_URL = `./events.json?ts=${Date.now()}`;

// ---- utils ----
const pad = n => String(n).padStart(2, '0');
function minsToLabel(mins) {
  const h24 = Math.floor(mins / 60);
  const m = mins % 60;
  const h = ((h24 + 11) % 12) + 1;
  const ampm = h24 >= 12 ? 'pm' : 'am';
  return `${h}:${m < 10 ? '0'+m : m}${ampm}`;
}

function formatRange(startMin, endMin) {
  return `${minsToLabel(startMin)} - ${minsToLabel(endMin)}`;
}

function nowMinutesLocal() {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

// Simple “same content” dedupe (room + time + normalized title/subtitle)
function dedupeSlots(slots) {
  const seen = new Set();
  const out = [];
  for (const s of slots) {
    const title = (s.title || '').trim().toLowerCase();
    const subtitle = (s.subtitle || '').trim().toLowerCase();
    const key = `${s.roomId}|${s.startMin}|${s.endMin}|${title}|${subtitle}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

// ---- render ----
function renderHeaderClock() {
  const dateEl = document.getElementById('headerDate');
  const clockEl = document.getElementById('headerClock');

  function tick() {
    const d = new Date();
    const y = d.getFullYear();
    const mo = d.toLocaleString(undefined, { month: 'long' });
    const day = d.getDate();
    const dow = d.toLocaleString(undefined, { weekday: 'long' });
    dateEl.textContent = `${dow}, ${mo} ${day}, ${y}`;

    const hh = d.getHours();
    const mm = pad(d.getMinutes());
    const ampm = hh >= 12 ? 'PM' : 'AM';
    const h12 = ((hh + 11) % 12) + 1;
    clockEl.textContent = `${h12}:${mm} ${ampm}`;
  }
  tick();
  setInterval(tick, 1000);
}

function renderGrid(data) {
  const grid = document.getElementById('grid');
  grid.innerHTML = '';

  // Build three sections
  const sections = [
    { id: 'south', title: 'South Gym', rows: ['1','2'], className: 'section--south' },
    { id: 'fieldhouse', title: 'Fieldhouse', rows: ['3','4','5','6','7','8'], className: 'section--fieldhouse' },
    { id: 'north', title: 'North Gym', rows: ['9','10'], className: 'section--north' },
  ];

  const now = nowMinutesLocal();

  // Filter: show only events that haven’t ended
  const futureSlots = (data.slots || []).filter(s => (s.endMin ?? 0) > now);

  // Suppress exact duplicates
  const slots = dedupeSlots(futureSlots);

  // Index slots by “roomId” (which is already collapsed to 1..10 by your transform)
  const byRoom = {};
  for (const s of slots) {
    if (!byRoom[s.roomId]) byRoom[s.roomId] = [];
    byRoom[s.roomId].push(s);
  }
  // Sort each room’s events by start time
  Object.values(byRoom).forEach(arr => arr.sort((a,b) => (a.startMin - b.startMin)));

  for (const sec of sections) {
    const secEl = document.createElement('div');
    secEl.className = `section ${sec.className}`;

    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = sec.title;

    const body = document.createElement('div');
    body.className = 'section-body';

    // Render each numbered room cell
    for (const roomNum of sec.rows) {
      const cell = document.createElement('div');
      cell.className = 'room-cell';

      const head = document.createElement('div');
      head.className = 'room-head';

      const rn = document.createElement('div');
      rn.className = 'room-num';
      rn.textContent = roomNum;

      // (Removed room-window time line per your request)

      head.appendChild(rn);
      cell.appendChild(head);

      // Chips
      const chips = document.createElement('div');
      chips.className = 'chips';

      const events = byRoom[roomNum] || [];
      if (events.length === 0) {
        // leave empty cell (no “No reservations” text)
      } else {
        for (const ev of events) {
          const chip = document.createElement('div');
          chip.className = 'chip';

          // Title with optional dedup of repeating ", X" part (e.g., "Extreme Volleyball, Extreme Volleyball")
          const cleanTitle = (() => {
            const t = (ev.title || '').trim();
            const parts = t.split(',').map(s => s.trim()).filter(Boolean);
            if (parts.length >= 2 && parts[0].toLowerCase() === parts[1].toLowerCase()) {
              return parts[0];
            }
            return t;
          })();

          // Subtitle optional
          const sub = (ev.subtitle || '').trim();

          // Time in chip (keep)
          const timeLabel = formatRange(ev.startMin, ev.endMin);

          chip.innerHTML =
            `<strong>${cleanTitle}</strong>` +
            (sub ? `<small>• ${sub}</small>` : ``) +
            `<small class="faint">• ${timeLabel}</small>`;

          chips.appendChild(chip);
        }
      }

      cell.appendChild(chips);
      body.appendChild(cell);
    }

    secEl.appendChild(title);
    secEl.appendChild(body);
    grid.appendChild(secEl);
  }
}

// ---- boot ----
async function loadData() {
  const resp = await fetch(EVENTS_URL, { cache: 'no-store' });
  if (!resp.ok) throw new Error(`Failed to fetch events.json: ${resp.status}`);
  const json = await resp.json();
  console.log('Loaded events.json', json);
  return json;
}

async function init() {
  renderHeaderClock();

  try {
    const data = await loadData();
    renderGrid(data);
  } catch (e) {
    console.error(e);
  }

  // Refresh the board every 60s so finished events drop off
  setInterval(async () => {
    try {
      const data = await loadData();
      renderGrid(data);
    } catch (e) {
      console.error(e);
    }
  }, 60_000);
}

document.addEventListener('DOMContentLoaded', init);
