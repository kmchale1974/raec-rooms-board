// app.js  — grid-only board, signage-friendly
// - Loads ./events.json (cache-busted)
// - Hides past events (falls off after end time)
// - Collapses 1A/1B into "1" (same for 2,9,10). Multiple events stack in that cell.
// - De-duplicates repeated items (same room/time + same title/purpose)
// - Normalizes titles like "Extreme Volleyball, Extreme Volleyball" -> "Extreme Volleyball"
// - Renders rooms in 3 blocks: South (1–2), Fieldhouse (3–8), North (9–10)

const EVENTS_URL = `./events.json`;

// ------------------------- Utilities -------------------------

const pad = (n) => (n < 10 ? `0${n}` : `${n}`);

function minutesToLabel(m) {
  const h24 = Math.floor(m / 60);
  const min = m % 60;
  // 24h -> 12h with am/pm
  const ampm = h24 >= 12 ? 'pm' : 'am';
  const h12 = ((h24 + 11) % 12) + 1;
  return `${h12}:${pad(min)}${ampm}`;
}

function todayMinutes() {
  const now = new Date();
  return now.getHours() * 60 + now.getMinutes();
}

function normalizeTitle(t) {
  if (!t) return '';
  // Remove exact duplicate after comma: "X, X" -> "X"
  const parts = t.split(',').map(s => s.trim()).filter(Boolean);
  if (parts.length >= 2 && parts[0].toLowerCase() === parts[1].toLowerCase()) {
    return parts[0];
  }
  return t;
}

function normalizeRoomId(rawId) {
  if (!rawId) return rawId;
  // Collapse A/B (e.g., "1A" -> "1", "10B" -> "10")
  const m = String(rawId).match(/^(\d{1,2})([AB])?$/i);
  return m ? m[1] : String(rawId);
}

function shallowEq(a, b, keys) {
  return keys.every(k => (a?.[k] ?? null) === (b?.[k] ?? null));
}

// Remove duplicates: same roomId, same startMin, same endMin, same title, same subtitle
function dedupeSlots(slots) {
  const seen = new Set();
  const out = [];
  for (const s of slots) {
    const key = JSON.stringify([s.roomId, s.startMin, s.endMin, s.title || '', s.subtitle || '']);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(s);
    }
  }
  return out;
}

// ------------------------- Data load / transform -------------------------

async function loadEvents() {
  const url = `${EVENTS_URL}?ts=${Date.now()}`;
  const resp = await fetch(url, { cache: 'no-store' });
  if (!resp.ok) throw new Error(`Failed to fetch ${url}: ${resp.status}`);
  const data = await resp.json();
  return data || {};
}

// Apply our business rules:
// - collapse A/B into numeric room
// - normalize titles
// - hide past events
// - sort by start time per room
function transformData(data) {
  const nowMin = todayMinutes();

  const rooms = Array.isArray(data.rooms)
    ? data.rooms
    : // fallback: craft from 1..10 if file uses object-form or is missing
      Object.values(data.rooms || {}).length
        ? Object.values(data.rooms)
        : [
            { id: '1', label: '1', group: 'south' },
            { id: '2', label: '2', group: 'south' },
            { id: '3', label: '3', group: 'fieldhouse' },
            { id: '4', label: '4', group: 'fieldhouse' },
            { id: '5', label: '5', group: 'fieldhouse' },
            { id: '6', label: '6', group: 'fieldhouse' },
            { id: '7', label: '7', group: 'fieldhouse' },
            { id: '8', label: '8', group: 'fieldhouse' },
            { id: '9', label: '9', group: 'north' },
            { id: '10', label: '10', group: 'north' },
          ];

  const rawSlots = Array.isArray(data.slots) ? data.slots : [];

  // collapse + normalize + hide past
  let slots = rawSlots.map((s) => ({
    ...s,
    roomId: normalizeRoomId(s.roomId),
    title: normalizeTitle(s.title),
    subtitle: s.subtitle || '',
  }))
  .filter((s) => typeof s.startMin === 'number' && typeof s.endMin === 'number')
  .filter((s) => s.endMin > nowMin); // auto-hide past events

  // remove duplicates
  slots = dedupeSlots(slots);

  // bucket by room
  const byRoom = new Map(rooms.map(r => [String(r.id), []]));
  for (const s of slots) {
    const key = String(s.roomId);
    if (byRoom.has(key)) byRoom.get(key).push(s);
  }
  // sort each room’s list
  for (const [k, arr] of byRoom.entries()) {
    arr.sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);
  }

  return { rooms, byRoom, dayStartMin: data.dayStartMin ?? 360, dayEndMin: data.dayEndMin ?? 1380 };
}

// ------------------------- Render -------------------------

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function renderHeaderClock() {
  const dateEl = document.getElementById('headerDate');
  const clockEl = document.getElementById('headerClock');
  if (!dateEl || !clockEl) return;
  const now = new Date();
  dateEl.textContent = now.toLocaleDateString(undefined, {
    weekday:'long', month:'long', day:'numeric', year:'numeric'
  });
  clockEl.textContent = now.toLocaleTimeString(undefined, {
    hour:'2-digit', minute:'2-digit'
  });
}

function groupOrder(rooms) {
  // Keep fixed group order and internal sort by numeric id
  const order = ['south','fieldhouse','north'];
  const grouped = new Map(order.map(g => [g, []]));
  for (const r of rooms) {
    const g = (r.group || '').toLowerCase();
    if (!grouped.has(g)) grouped.set(g, []);
    grouped.get(g).push(r);
  }
  for (const g of grouped.keys()) {
    grouped.get(g).sort((a,b) => Number(a.id) - Number(b.id));
  }
  return order.map(g => ({ group: g, rooms: grouped.get(g) || [] }));
}

function renderGrid({ rooms, byRoom }) {
  const container = document.getElementById('grid');
  if (!container) return;

  // wipe
  container.innerHTML = '';

  // Build a 3-column layout: South (1,2) | Fieldhouse (3..8) | North (9,10)
  const colWrap = el('div');
  colWrap.style.display = 'grid';
  colWrap.style.gridTemplateColumns = '1fr 1.8fr 1fr'; // give fieldhouse more width
  colWrap.style.gap = '16px';
  colWrap.style.height = '100%';

  const sections = groupOrder(rooms);
  for (const sect of sections) {
    const col = el('div');
    col.style.display = 'grid';
    col.style.gridTemplateRows = `28px repeat(${sect.rooms.length}, 1fr)`;
    col.style.gap = '8px';
    col.style.height = '100%';

    // group label
    const gl = el('div', null, sect.group === 'south' ? 'South Gym' :
                          sect.group === 'north' ? 'North Gym' : 'Fieldhouse');
    gl.style.color = 'var(--muted)';
    gl.style.fontSize = '14px';
    gl.style.borderBottom = '1px solid var(--grid)';
    gl.style.display = 'flex';
    gl.style.alignItems = 'center';
    gl.style.padding = '0 6px';
    col.appendChild(gl);

    // rows
    for (const r of sect.rooms) {
      const cell = el('div');
      cell.style.border = '1px solid var(--grid)';
      cell.style.borderRadius = '12px';
      cell.style.padding = '10px';
      cell.style.display = 'grid';
      cell.style.gridTemplateRows = 'auto 1fr';
      cell.style.gap = '8px';
      cell.style.overflow = 'hidden';
      cell.style.background = 'rgba(255,255,255,0.01)';

      // top label (room number)
      const label = el('div', null, r.label || r.id);
      label.style.fontWeight = '700';
      label.style.fontSize = '18px';
      label.style.color = 'var(--ink)';
      cell.appendChild(label);

      // events list
      const list = el('div');
      list.style.display = 'flex';
      list.style.flexDirection = 'column';
      list.style.gap = '6px';
      list.style.overflow = 'hidden';

      const events = byRoom.get(String(r.id)) || [];
      if (events.length === 0) {
        // blank cell (no placeholder per your request)
      } else {
        for (const ev of events) {
          const item = el('div');
          item.style.background = 'var(--chip)';
          item.style.border = '1px solid var(--grid)';
          item.style.borderRadius = '8px';
          item.style.padding = '8px 10px';
          item.style.fontSize = '14px';
          item.style.lineHeight = '1.2';
          item.style.display = 'grid';
          item.style.gridTemplateColumns = 'auto 1fr';
          item.style.columnGap = '10px';
          item.style.alignItems = 'center';
          item.style.minHeight = '32px';
          item.style.maxHeight = '48px';
          item.style.overflow = 'hidden';

          const time = el('div', null, `${minutesToLabel(ev.startMin)}–${minutesToLabel(ev.endMin)}`);
          time.style.color = 'var(--muted)';
          time.style.fontSize = '12px';
          time.style.whiteSpace = 'nowrap';

          const textWrap = el('div');
          textWrap.style.overflow = 'hidden';
          textWrap.style.textOverflow = 'ellipsis';
          textWrap.style.whiteSpace = 'nowrap';

          const title = el('span', null, ev.title || '');
          title.style.fontWeight = '600';

          const subtitle = ev.subtitle ? ` • ${ev.subtitle}` : '';
          const sub = el('span', null, subtitle);
          sub.style.opacity = '.8';

          textWrap.appendChild(title);
          if (subtitle) textWrap.appendChild(sub);

          item.appendChild(time);
          item.appendChild(textWrap);
          list.appendChild(item);
        }
      }

      cell.appendChild(list);
      col.appendChild(cell);
    }

    colWrap.appendChild(col);
  }

  container.appendChild(colWrap);
}

// ------------------------- Boot / Refresh -------------------------

async function renderOnce() {
  try {
    const raw = await loadEvents();
    console.log('Loaded events.json', raw);
    const data = transformData(raw);
    renderGrid(data);
  } catch (err) {
    console.error('Failed to render board:', err);
  }
}

// update clock and re-render periodically so past events fall off naturally
function startLoops() {
  renderHeaderClock();
  const clockId = setInterval(renderHeaderClock, 15_000);
  const refreshId = setInterval(renderOnce, 60_000); // every minute

  // Render immediately
  renderOnce();

  // Cleanups are not strictly needed for signage, but harmless if page hot-reloads
  window.addEventListener('beforeunload', () => {
    clearInterval(clockId);
    clearInterval(refreshId);
  });
}

// Start
document.addEventListener('DOMContentLoaded', startLoops);
