// board.js (ESM)
const app = document.getElementById('app');
const dateEl = document.getElementById('date');

const fmtDate = (iso, tz) =>
  new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: tz }).format(new Date(iso));
const fmtTime = (iso, tz) =>
  new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: tz }).format(new Date(iso));

async function load() {
  const res = await fetch('events.json', { cache: 'no-store' });
  if (!res.ok) throw new Error(`Failed to load events.json (${res.status})`);
  const data = await res.json();
  render(data);
}

function render(data) {
  const { rooms = [], events = [], tz = 'America/Chicago', generatedAt } = data;

  // header date
  const todayISO = new Date().toISOString();
  dateEl.textContent = `${fmtDate(todayISO, tz)} • ${new Date(generatedAt || todayISO).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;

  // group events by room
  const byRoom = new Map(rooms.map(r => [r, []]));
  for (const ev of events) {
    if (!byRoom.has(ev.room)) byRoom.set(ev.room, []);
    byRoom.get(ev.room).push(ev);
  }
  for (const list of byRoom.values()) {
    list.sort((a,b) => a.start.localeCompare(b.start));
  }

  // draw cards
  app.innerHTML = '';
  for (const room of rooms.length ? rooms : [...new Set(events.map(e => e.room))]) {
    const card = document.createElement('section');
    card.className = 'room-card';

    const header = document.createElement('div');
    header.className = 'room-header';
    const h2 = document.createElement('h2');
    h2.textContent = room;
    const badge = document.createElement('span');
    badge.className = 'badge';
    const count = (byRoom.get(room) || []).length;
    badge.textContent = count ? `${count} event${count>1?'s':''}` : 'no events';
    header.append(h2, badge);

    const body = document.createElement('div');
    body.className = 'room-body';

    const list = byRoom.get(room) || [];
    if (!list.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'No reservations yet';
      body.append(empty);
    } else {
      for (const ev of list) {
        const row = document.createElement('div');
        row.className = 'event';
        const time = document.createElement('div');
        time.className = 'time';
        time.textContent = `${fmtTime(ev.start, tz)} – ${fmtTime(ev.end, tz)}`;
        const title = document.createElement('div');
        title.className = 'title';
        title.textContent = ev.title || 'Reserved';
        row.append(time, title);
        body.append(row);
      }
    }

    card.append(header, body);
    app.append(card);
  }
}

load().catch(err => {
  app.innerHTML = `<pre style="color:#b91c1c;background:#fee2e2;padding:12px;border-radius:8px;overflow:auto">Failed to load board:\n${err?.stack || err}</pre>`;
});
