/* app.js – dynamic fieldhouse + robust rendering
   - Detect turf vs court from events.json (rooms include NA/NB/SA/SB)
   - Build middle column cards (#fieldhousePager) accordingly
   - Cache-busted fetch + no-store
   - Show full names; hide empty subtitles
   - Only animate if >1 upcoming event
*/

(function () {
  const TICK_MS = 1000;
  const ROTATE_MS = 8000;
  const SLIDE_MS = 420;
  const NOW_PAD_MIN = 0; // don’t show events that already ended

  // South/North fixed in HTML
  const FIXED_ROOM_IDS = ['1A','1B','2A','2B','9A','9B','10A','10B'];

  // ---------- Time helpers ----------
  function minutesToRangeText(startMin, endMin) {
    const fmt = m => {
      let h = Math.floor(m / 60);
      const min = m % 60;
      const mer = h >= 12 ? 'pm' : 'am';
      if (h === 0) h = 12;
      else if (h > 12) h -= 12;
      return `${h}:${String(min).padStart(2, '0')}${mer}`;
    };
    return `${fmt(startMin)} – ${fmt(endMin)}`;
  }
  function nowMinutes() {
    const d = new Date();
    return d.getHours() * 60 + d.getMinutes();
  }

  // ---------- DOM helpers ----------
  const $ = (q, root=document) => root.querySelector(q);
  const $$ = (q, root=document) => Array.from(root.querySelectorAll(q));

  function cleanSubtitle(s) {
    if (!s) return '';
    return String(s).replace(/\s+/g, ' ').trim();
  }

  function createRoomCard(id, labelText) {
    const wrap = document.createElement('div');
    wrap.className = 'room';
    wrap.id = `room-${id}`;

    const header = document.createElement('div');
    header.className = 'roomHeader';
    const left = document.createElement('div');
    left.className = 'id';
    left.textContent = labelText || id;
    const right = document.createElement('div');
    right.className = 'count';
    right.innerHTML = 'reservations: <em>—</em>';
    header.appendChild(left);
    header.appendChild(right);

    const events = document.createElement('div');
    events.className = 'events';
    const rotor = document.createElement('div');
    rotor.className = 'single-rotor';
    events.appendChild(rotor);

    wrap.appendChild(header);
    wrap.appendChild(events);
    return wrap;
  }

  function setRoomCount(roomEl, count) {
    if (!roomEl) return;
    const badge = $('.roomHeader .count em', roomEl);
    if (badge) badge.textContent = String(count);
  }

  function createEventCard(slot) {
    const card = document.createElement('div');
    card.className = 'event';

    const who = document.createElement('div');
    who.className = 'who';
    who.textContent = slot.title || '';
    card.appendChild(who);

    const sub = cleanSubtitle(slot.subtitle);
    if (sub) {
      const what = document.createElement('div');
      what.className = 'what';
      what.textContent = sub;
      card.appendChild(what);
    }

    const when = document.createElement('div');
    when.className = 'when';
    when.textContent = minutesToRangeText(slot.startMin, slot.endMin);
    card.appendChild(when);

    return card;
  }

  // ---------- Rotor (animate only if >1) ----------
  function startRotor(container, events) {
    if (!container) return;
    container.innerHTML = '';

    if (!events || events.length === 0) return;

    if (events.length === 1) {
      container.appendChild(createEventCard(events[0]));
      return; // no animation
    }

    let idx = 0;
    const place = i => {
      const el = createEventCard(events[i]);
      el.style.position = 'absolute';
      el.style.inset = '0';
      return el;
    };

    let curr = place(idx);
    container.appendChild(curr);

    const step = () => {
      const nextIdx = (idx + 1) % events.length;
      const next = place(nextIdx);
      next.style.opacity = '0';
      next.style.transform = 'translateX(60px)';
      container.appendChild(next);

      requestAnimationFrame(() => {
        curr.style.transition = `transform ${SLIDE_MS}ms cubic-bezier(.22,.61,.36,1), opacity ${SLIDE_MS}ms cubic-bezier(.22,.61,.36,1)`;
        curr.style.transform = 'translateX(-60px)';
        curr.style.opacity = '0';

        next.style.transition = `transform ${SLIDE_MS}ms cubic-bezier(.22,.61,.36,1), opacity ${SLIDE_MS}ms cubic-bezier(.22,.61,.36,1)`;
        next.style.transform = 'translateX(0)';
        next.style.opacity = '1';

        setTimeout(() => {
          try { container.removeChild(curr); } catch {}
          curr = next;
          idx = nextIdx;
        }, SLIDE_MS + 20);
      });
    };

    container._rotorTimer && clearInterval(container._rotorTimer);
    container._rotorTimer = setInterval(step, ROTATE_MS);
  }

  function fillRoom(roomId, slots) {
    const roomEl = $(`#room-${CSS.escape(roomId)}`);
    if (!roomEl) return;

    const rotor = $('.events .single-rotor', roomEl);
    if (!rotor) return;

    const nowMin = nowMinutes();
    const upcoming = (slots || [])
      .filter(s => s.endMin > (nowMin + NOW_PAD_MIN))
      .sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);

    setRoomCount(roomEl, upcoming.length);
    startRotor(rotor, upcoming);
  }

  // ---------- Fieldhouse builder ----------
  function buildFieldhouse(isTurf) {
    const host = $('#fieldhousePager');
    if (!host) return { ids: [] };

    host.innerHTML = ''; // clear

    const grid = document.createElement('div');
    grid.className = isTurf ? 'rooms-fieldhouse turf' : 'rooms-fieldhouse courts';
    grid.style.display = 'grid';
    grid.style.gridTemplateColumns = isTurf ? '1fr 1fr' : 'repeat(3, 1fr)';
    grid.style.gridTemplateRows = isTurf ? '1fr 1fr' : '1fr 1fr';
    grid.style.gap = '12px';
    grid.style.minHeight = '0';

    const ids = isTurf
      ? ['SA','NA','SB','NB'] // order: top-left SA, top-right NA, bottom-left SB, bottom-right NB
      : ['3','4','5','6','7','8']; // courts 3..8

    const labels = {
      'SA': 'Quarter Turf SA',
      'SB': 'Quarter Turf SB',
      'NA': 'Quarter Turf NA',
      'NB': 'Quarter Turf NB'
    };

    ids.forEach(id => {
      const card = createRoomCard(id, labels[id] || id);
      grid.appendChild(card);
    });

    host.appendChild(grid);
    return { ids };
  }

  // ---------- Header clock ----------
  function updateHeader() {
    const d = new Date();
    const dow = d.toLocaleDateString(undefined, { weekday: 'long' });
    const date = d.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
    const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

    const dateEl = $('#headerDate');
    const clockEl = $('#headerClock');
    if (dateEl) dateEl.textContent = `${dow}, ${date}`;
    if (clockEl) clockEl.textContent = time;
  }

  // ---------- Boot ----------
  async function boot() {
    updateHeader();
    setInterval(updateHeader, TICK_MS);

    // Fetch events.json fresh
    const res = await fetch(`./events.json?cb=${Date.now()}`, { cache: 'no-store' });
    const data = await res.json();

    const slots = Array.isArray(data?.slots) ? data.slots : [];
    console.log('events.json loaded:', { totalSlots: slots.length });

    // Group by room
    const byRoom = new Map();
    for (const s of slots) {
      if (!s || !s.roomId) continue;
      if (!byRoom.has(s.roomId)) byRoom.set(s.roomId, []);
      byRoom.get(s.roomId).push(s);
    }

    // Detect turf season (rooms NA/NB/SA/SB present in JSON)
    const roomIdsInData = new Set((data.rooms || []).map(r => r.id));
    const turfIds = ['NA','NB','SA','SB'];
    const isTurf = turfIds.some(id => roomIdsInData.has(id) || byRoom.has(id));

    // Build Fieldhouse cards dynamically
    const { ids: fieldhouseIds } = buildFieldhouse(isTurf);

    // Render South/North (these boxes exist in your HTML)
    FIXED_ROOM_IDS.forEach(id => fillRoom(id, byRoom.get(id) || []));

    // Render Fieldhouse rooms we just created
    fieldhouseIds.forEach(id => fillRoom(id, byRoom.get(id) || []));

    // If you want a visual hint in the Fieldhouse title, uncomment:
    // const fhTitle = document.querySelector('section.group:nth-child(2) .title');
    // if (fhTitle) fhTitle.textContent = isTurf ? 'Fieldhouse (Turf)' : 'Fieldhouse (Courts 3–8)';
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => boot().catch(err => console.error('app init failed:', err)));
  } else {
    boot().catch(err => console.error('app init failed:', err));
  }
})();
