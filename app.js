// app.js
// Defensive renderer that (1) loads events.json, (2) builds the skeleton into .grid,
// then (3) renders reservations. Avoids "Cannot set properties of null" by not
// assuming containers exist ahead of time.

const QS  = (sel, el = document) => el.querySelector(sel);
const QSA = (sel, el = document) => Array.from(el.querySelectorAll(sel));

const fmtTime12 = (mins) => {
  const h24 = Math.floor(mins / 60);
  const m = mins % 60;
  const h12 = ((h24 + 11) % 12) + 1;
  const ampm = h24 >= 12 ? "PM" : "AM";
  return `${h12}:${m.toString().padStart(2,"0")}${ampm.toLowerCase()}`;
};

const NOW_MIN = (() => {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
})();

async function loadData() {
  const url = `./events.json?ts=${Date.now()}`;
  const resp = await fetch(url, { cache: 'no-store' });
  const data = await resp.json();
  console.log('Loaded events.json', data && typeof data === 'object' ? data : {});
  return data || {};
}

function safeSetText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

function updateHeaderClock() {
  const d = new Date();
  const dateStr = d.toLocaleDateString(undefined, { weekday:'long', month:'long', day:'numeric' });
  const timeStr = d.toLocaleTimeString(undefined, { hour: 'numeric', minute:'2-digit' });
  safeSetText('headerDate', dateStr);
  safeSetText('headerClock', timeStr);
}

function buildSkeletonFromData(data) {
  // Build the entire board into .grid, based on data.rooms[].group and id/label
  const gridRoot = QS('.grid');
  if (!gridRoot) return;

  const rooms = Array.isArray(data.rooms) ? data.rooms : [];
  const byGroup = {
    south: rooms.filter(r => r.group === 'south'),
    fieldhouse: rooms.filter(r => r.group === 'fieldhouse'),
    north: rooms.filter(r => r.group === 'north')
  };

  // Return block for a single room card
  const roomCard = (room) => {
    const rid = String(room.id);
    return `
      <div class="room" data-room-id="${rid}">
        <div class="roomHeader">
          <div class="id">${room.label || rid}</div>
          <div class="count" id="count-${rid}" aria-live="polite"></div>
        </div>
        <div class="events" id="events-${rid}"></div>
      </div>
    `;
  };

  // South/North stack: keep order as provided
  const stack = (arr) => `
    <div class="rooms-stack">
      ${arr.map(roomCard).join('')}
    </div>
  `;

  // Fieldhouse: 3 columns x 2 rows (3..8) if we have 6 items; otherwise just flow
  const fieldhouseGrid = (arr) => {
    if (arr.length === 6) {
      return `
        <div class="rooms-fieldhouse">
          ${arr.map(roomCard).join('')}
        </div>
      `;
    }
    // Fallback: stack neatly if not exactly 6
    return stack(arr);
  };

  const section = (title, id, inner) => `
    <section class="group" id="${id}">
      <div class="title">${title}</div>
      ${inner}
    </section>
  `;

  const southHTML = section('South Gym', 'group-south', stack(byGroup.south));
  const fieldHTML = section('Fieldhouse', 'group-fieldhouse', fieldhouseGrid(byGroup.fieldhouse));
  const northHTML = section('North Gym', 'group-north', stack(byGroup.north));

  gridRoot.innerHTML = southHTML + fieldHTML + northHTML;
}

function normalizeReservation(slot) {
  // Handles Pickleball & Catch Corner display rules and person-name flipping
  const titleRaw = (slot.title || '').trim();
  const subtitleRaw = (slot.subtitle || '').trim();
  let title = titleRaw;
  let subtitle = subtitleRaw;

  // ---- Pickleball special rule ----
  // Display as "Open Pickleball" (bold) and do not duplicate "internal" text
  if (/pickleball/i.test(title) || /pickleball/i.test(subtitle)) {
    return {
      who: "Open Pickleball",
      what: "",
      when: `${fmtTime12(slot.startMin)} – ${fmtTime12(slot.endMin)}`
    };
  }

  // ---- Catch Corner special rule ----
  // Show bold "Catch Corner" and use "Reservation Purpose" details from subtitle,
  // stripping a leading repeated "CatchCorner (" and any trailing ")"
  if (/^catch\s*corner/i.test(title)) {
    // remove leading "CatchCorner (" and trailing ")" if present
    let clean = subtitle.replace(/^CatchCorner\s*\(\s*/i, '').replace(/\)\s*$/, '');
    return {
      who: "Catch Corner",
      what: clean,
      when: `${fmtTime12(slot.startMin)} – ${fmtTime12(slot.endMin)}`
    };
  }

  // ---- Person-name detection ----
  // If title looks like "Last, First", flip to "First Last" in bold
  const m = title.match(/^\s*([A-Za-z'’\-]+)\s*,\s*([A-Za-z'’\-]+)\s*$/);
  if (m) {
    const first = m[2];
    const last = m[1];
    return {
      who: `${first} ${last}`,
      what: subtitle,
      when: `${fmtTime12(slot.startMin)} – ${fmtTime12(slot.endMin)}`
    };
  }

  // ---- Organization + contact (if present in slot.org / slot.contact) ----
  const org = slot.org || title;
  const contact = slot.contact || '';
  let whatLine = subtitle;
  if (contact && contact !== org) {
    // If we have a distinct contact (like "Brandon Brown"), show under org name
    whatLine = contact + (subtitle ? ` — ${subtitle}` : '');
  }

  return {
    who: org,
    what: whatLine,
    when: `${fmtTime12(slot.startMin)} – ${fmtTime12(slot.endMin)}`
  };
}

function renderReservations(data) {
  const slots = Array.isArray(data.slots) ? data.slots : [];

  // Only show reservations that are still ongoing or upcoming
  const filtered = slots.filter(s => Number.isFinite(s.endMin) && s.endMin > NOW_MIN);

  // Group by roomId
  const byRoom = new Map();
  for (const s of filtered) {
    const rid = String(s.roomId);
    if (!byRoom.has(rid)) byRoom.set(rid, []);
    byRoom.get(rid).push(s);
  }

  // Sort each room’s reservations by start time
  for (const arr of byRoom.values()) {
    arr.sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);
  }

  // Render
  const roomIds = Array.isArray(data.rooms) ? data.rooms.map(r => String(r.id)) : [];
  for (const rid of roomIds) {
    const listEl = document.getElementById(`events-${rid}`);
    const countEl = document.getElementById(`count-${rid}`);
    if (!listEl) continue;

    const list = byRoom.get(rid) || [];
    if (countEl) countEl.textContent = list.length ? `${list.length} reservation${list.length>1?'s':''}` : '';

    if (!list.length) {
      listEl.innerHTML = `<div class="event"><div class="what" style="opacity:.7">No reservations</div></div>`;
      continue;
    }

    // Build cards (one per reservation)
    listEl.innerHTML = list.map(slot => {
      const v = normalizeReservation(slot);
      return `
        <div class="event">
          <div class="who">${v.who}</div>
          ${v.what ? `<div class="what">${v.what}</div>` : ``}
          <div class="when">${v.when}</div>
        </div>
      `;
    }).join('');
  }
}

function chooseWifiDefaults() {
  // Feel free to customize if you set these elsewhere.
  const ssid = 'RAEC-Public';
  const pass = 'Publ!c00';
  safeSetText('wifiSsid', ssid);
  safeSetText('wifiPass', pass);
}

async function init() {
  try {
    const data = await loadData();

    // Defensive: Make sure the header is populated even if index had IDs renamed/missing
    updateHeaderClock();
    chooseWifiDefaults();
    setInterval(updateHeaderClock, 1000 * 30);

    // Build skeleton fresh from data to ensure containers exist
    buildSkeletonFromData(data);

    // Render reservations
    renderReservations(data);
  } catch (err) {
    console.error('Init failed:', err);
  }
}

document.addEventListener('DOMContentLoaded', init);
