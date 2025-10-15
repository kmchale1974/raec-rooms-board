// app.mjs

// --- 1) Fetch events.json with cache-busting and strict error checks ---
async function loadData() {
  // add a timestamp so the browser (and Yodeck) won’t serve a cached file
  const url = `./events.json?ts=${Date.now()}`;

  const resp = await fetch(url, { cache: 'no-store' });
  if (!resp.ok) {
    // surface HTTP errors clearly in console
    throw new Error(`Failed to fetch ${url}: ${resp.status} ${resp.statusText}`);
  }

  const data = await resp.json();

  // quick sanity log so you see it in DevTools
  const roomCount = data?.rooms ? Object.keys(data.rooms).length : 0;
  const slotCount = Array.isArray(data?.slots) ? data.slots.length : 0;
  console.log('Loaded events:', { rooms: roomCount, slots: slotCount });

  return data;
}

// --- 2) Example init wiring (keep your existing render calls) ---
async function init() {
  try {
    const data = await loadData();

    // If you already have these in your app, keep them.
    // Otherwise, replace with your own render functions.
    if (typeof renderHeader === 'function') renderHeader(data);
    if (typeof renderGridBackdrop === 'function') renderGridBackdrop(data);
    if (typeof renderSlots === 'function') renderSlots(data);
  } catch (err) {
    console.error('Init failed:', err);
  }
}

document.addEventListener('DOMContentLoaded', init);
