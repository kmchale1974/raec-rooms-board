/* app.js – polished renderer (no layout changes)
   - Cache-bust + no-store for events.json
   - Smooth single-rotor animation only when >1 event
   - Hide empty subtitles
   - Use textContent (no HTML truncation by JS)
   - Robust: skips missing DOM nodes without crashing
*/

(function () {
  const TICK_MS = 1000;
  const ROTATE_MS = 8000;           // time between slides
  const SLIDE_MS = 420;             // CSS should match/slightly exceed
  const NOW_PAD_MIN = 0;            // don’t show events that ended already

  const ROOMS_FIXED = [
    '1A', '1B', '2A', '2B',
    // Fieldhouse/turf may be dynamic; we’ll render only if boxes exist
    '3','4','5','6','7','8','NA','NB','SA','SB',
    '9A', '9B', '10A', '10B'
  ];

  // ---------- time helpers ----------
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

  // ---------- content helpers ----------
  function cleanSubtitle(s) {
    if (!s) return '';
    const t = String(s).replace(/\s+/g, ' ').trim();
    return t;
  }

  function el(q, root = document) {
    return root.querySelector(q);
  }

  function createEventCard(slot) {
    const card = document.createElement('div');
    card.className = 'event';

    // Who (title)
    const who = document.createElement('div');
    who.className = 'who';
    who.textContent = slot.title || ''; // show full text; no truncation in JS
    card.appendChild(who);

    // What (subtitle) – hide if empty
    const sub = cleanSubtitle(slot.subtitle);
    if (sub) {
      const what = document.createElement('div');
      what.className = 'what';
      what.textContent = sub;
      card.appendChild(what);
    }

    // When
    const when = document.createElement('div');
    when.className = 'when';
    when.textContent = minutesToRangeText(slot.startMin, slot.endMin);
    card.appendChild(when);

    return card;
  }

  // ---------- rotor (slides only when >1) ----------
  function startRotor(container, events) {
    // container is .single-rotor
    if (!container) return;
    container.innerHTML = '';

    // If nothing upcoming → leave empty (per your preference)
    if (!events || events.length === 0) {
      return;
    }

    // If only one → render once, no animation
    if (events.length === 1) {
      const only = createEventCard(events[0]);
      container.appendChild(only);
      return;
    }

    // More than one → animate left
    let idx = 0;

    const place = (i) => {
      const card = createEventCard(events[i]);
      card.style.position = 'absolute';
      card.style.inset = '0';
      return card;
    };

    // current and next
    let curr = place(idx);
    container.appendChild(curr);

    const step = () => {
      const nextIdx = (idx + 1) % events.length;
      const next = place(nextIdx);

      // set start positions
      next.style.opacity = '0';
      next.style.transform = 'translateX(60px)';

      container.appendChild(next);

      // trigger transition (ensure layout reflow)
      requestAnimationFrame(() => {
        // animate current out
        curr.style.transition = `transform ${SLIDE_MS}ms cubic-bezier(.22,.61,.36,1), opacity ${SLIDE_MS}ms cubic-bezier(.22,.61,.36,1)`;
        curr.style.transform = 'translateX(-60px)';
        curr.style.opacity = '0';

        // animate next in
        next.style.transition = `transform ${SLIDE_MS}ms cubic-bezier(.22,.61,.36,1), opacity ${SLIDE_MS}ms cubic-bezier(.22,.61,.36,1)`;
        next.style.transform = 'translateX(0)';
        next.style.opacity = '1';

        // cleanup after animation
        setTimeout(() => {
          container.removeChild(curr);
          curr = next;
          idx = nextIdx;
        }, SLIDE_MS + 20);
      });
    };

    // rotate
    const timer = setInterval(step, ROTATE_MS);
    // store to allow future cleanup if needed
    container._rotorTimer = timer;
  }

  function setRoomCount(roomEl, count) {
    if (!roomEl) return;
    const badge = el('.roomHeader .count em', roomEl);
    if (badge) badge.textContent = String(count);
  }

  function fillFixedRoom(roomId, slots) {
    // room markup: #room-<id> .events .single-rotor
    const roomEl = el(`#room-${CSS.escape(roomId)}`);
    if (!roomEl) return;

    const rotor = el('.events .single-rotor', roomEl);
    if (!rotor) return;

    // future-only, sorted by start time
    const nowMin = nowMinutes();
    const upcoming = (slots || [])
      .filter(s => s.endMin > (nowMin + NOW_PAD_MIN))
      .sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);

    // update count
    setRoomCount(roomEl, upcoming.length);

    // render
    startRotor(rotor, upcoming);
  }

  // ---------- header clock ----------
  function updateHeader() {
    const d = new Date();
    const dow = d.toLocaleDateString(undefined, { weekday: 'long' });
    const date = d.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
    const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

    const dateEl = el('#headerDate');
    const clockEl = el('#headerClock');

    if (dateEl) dateEl.textContent = `${dow}, ${date}`;
    if (clockEl) clockEl.textContent = time;
  }

  // ---------- boot ----------
  async function boot() {
    updateHeader();
    setInterval(updateHeader, TICK_MS);

    // Fetch events.json (cache-busted, no-store)
    const res = await fetch(`./events.json?cb=${Date.now()}`, { cache: 'no-store' });
    const data = await res.json();

    const slots = Array.isArray(data?.slots) ? data.slots : [];
    console.log('events.json loaded:', { totalSlots: slots.length });

    // group slots by roomId
    const byRoom = new Map();
    for (const s of slots) {
      if (!s || !s.roomId) continue;
      if (!byRoom.has(s.roomId)) byRoom.set(s.roomId, []);
      byRoom.get(s.roomId).push(s);
    }

    // render all known rooms that exist in the DOM
    ROOMS_FIXED.forEach(rid => {
      const roomEl = el(`#room-${CSS.escape(rid)}`);
      if (!roomEl) return; // skip if this card doesn't exist in HTML
      fillFixedRoom(rid, byRoom.get(rid) || []);
    });

    // Also render any dynamic rooms present in JSON but not in ROOMS_FIXED
    // (won’t hurt if HTML has matching cards)
    if (Array.isArray(data.rooms)) {
      data.rooms.forEach(r => {
        if (!r?.id) return;
        if (ROOMS_FIXED.includes(r.id)) return; // already covered
        const roomEl = el(`#room-${CSS.escape(r.id)}`);
        if (!roomEl) return;
        fillFixedRoom(r.id, byRoom.get(r.id) || []);
      });
    }
  }

  // Wait for DOM
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => boot().catch(err => console.error('app init failed:', err)));
  } else {
    boot().catch(err => console.error('app init failed:', err));
  }
})();
