// scripts/fetch_email.js
// Robust Gmail IMAP CSV fetcher for RAEC board
// Requires env: IMAP_USER, IMAP_PASS, OUT_CSV
// npm deps: imapflow, mailparser, pino-pretty (optional, for nicer logs)

import { ImapFlow } from 'imapflow';
import fs from 'fs/promises';
import path from 'path';

// --- Config from ENV ---
const IMAP_USER = process.env.IMAP_USER;
const IMAP_PASS = process.env.IMAP_PASS;
const OUT_CSV   = process.env.OUT_CSV || 'data/inbox/latest.csv';

if (!IMAP_USER) {
  console.error('Missing IMAP_USER env var (Gmail address).');
  process.exit(1);
}
if (!IMAP_PASS) {
  console.error('Missing IMAP_PASS env var (Gmail App Password).');
  process.exit(1);
}

// Helper: ensure folder exists
async function ensureDirFor(filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

// Build an IMAP date string (e.g., 25-Oct-2025)
function toImapDate(d) {
  const day = String(d.getDate()).padStart(2, '0');
  const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const mon = monthNames[d.getMonth()];
  const year = d.getFullYear();
  return `${day}-${mon}-${year}`;
}

// Subject matcher (case-insensitive "contains")
function subjectContains(env, needle) {
  return (env?.subject || '').toLowerCase().includes(needle.toLowerCase());
}

function isLikelyOurCsv(part) {
  // Text/Plain attachment, filename contains our pattern and ends with .csv
  const disp = part?.disposition?.toLowerCase?.() || '';
  const name = (part?.parameters?.name || part?.dispositionParameters?.filename || '').toString();
  return (
    disp.includes('attachment') &&
    name.toLowerCase().endsWith('.csv') &&
    name.toLowerCase().includes('daily facility global schedule')
  );
}

async function findLatestCsv(client, mailbox) {
  // Try subject search first, last 5 days
  const since = new Date();
  since.setDate(since.getDate() - 5);
  const sinceStr = toImapDate(since);

  console.log(`Searching "${mailbox}" since ${sinceStr} for subject "AC Daily Facility Report"...`);
  await client.mailboxOpen(mailbox, { readOnly: true });

  // Gmail supports: ['SINCE', 'DD-Mon-YYYY', 'HEADER', 'SUBJECT', 'AC Daily Facility Report']
  let uids = await client.search({
    since: since,
    header: ['subject', 'AC Daily Facility Report'],
  }).catch(() => []);

  // If not found by subject, broaden: any CSV attachment with our pattern
  if (!uids || uids.length === 0) {
    console.log('No subject matches; broadening to any message SINCE with CSV attachment name pattern…');
    // Search all messages since date; we’ll filter by bodystructure client-side
    uids = await client.search({ since }).catch(() => []);
  }

  if (!uids || uids.length === 0) {
    console.log(`No messages found in "${mailbox}" for date window.`);
    return null;
  }

  // Fetch BODYSTRUCTURE & ENVELOPE for candidates (limit to last 50 uids for speed)
  const tail = uids.slice(-50);
  let best = null;

  for await (const msg of client.fetch(tail, { uid: true, envelope: true, bodyStructure: true, internalDate: true })) {
    const env = msg.envelope || {};
    const hasGoodSubject = subjectContains(env, 'AC Daily Facility Report');

    // Walk bodystructure to find CSV parts
    const stack = Array.isArray(msg.bodyStructure) ? msg.bodyStructure : [msg.bodyStructure];
    const csvParts = [];
    const walk = (node) => {
      if (!node) return;
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      // node can be a multipart with childNodes
      if (node.childNodes && node.childNodes.length) node.childNodes.forEach(walk);

      // leaf
      if (!node.childNodes) {
        const disp = (node.disposition || '').toLowerCase();
        const name = (node.parameters?.name || node.dispositionParameters?.filename || '').toString();
        const size = Number(node.size || 0);
        if (disp.includes('attachment') && name.toLowerCase().endsWith('.csv')) {
          csvParts.push({ node, name, size });
        }
      }
    };
    walk(msg.bodyStructure);

    // Prefer files with our typical name and the largest size
    const priorityCsv = csvParts
      .filter(p => p.name.toLowerCase().includes('daily facility global schedule'))
      .sort((a, b) => b.size - a.size);

    const fallbackCsv = csvParts.sort((a, b) => b.size - a.size);

    let pick = priorityCsv[0] || fallbackCsv[0] || null;
    if (!pick) continue;

    // Score: prefer correct subject and recency/size
    const score =
      (hasGoodSubject ? 1000 : 0) +
      Math.min(500, Math.floor((new Date(msg.internalDate) - since) / 60000)) + // newer → more points
      Math.min(200, Math.floor((pick.size || 0) / 1024)); // larger → more points

    if (!best || score > best.score) {
      best = {
        uid: msg.uid,
        subject: env.subject || '(no subject)',
        internalDate: msg.internalDate,
        csvName: pick.name,
        csvSize: pick.size,
        csvPart: pick.node
      };
    }
  }

  if (!best) {
    console.log(`Found messages in "${mailbox}" but none with CSV attachments.`);
    return null;
  }

  console.log(`Chosen message uid=${best.uid} | ${best.internalDate} | ${best.subject}`);
  console.log(`CSV part: ${best.csvName} (${best.csvSize} bytes)`);

  // Download the CSV part
  const partId = best.csvPart.part || best.csvPart.partId || best.csvPart.partID || '2';
  const download = await client.download(best.uid, partId);
  const buf = await download.content.readAll();
  return { buf, name: best.csvName };
}

async function main() {
  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user: IMAP_USER, pass: IMAP_PASS },
    logger: false,
    // Give Gmail a generous timeout for large downloads
    socketTimeout: 60_000,
    logRaw: false
  });

  try {
    console.log(`Connecting to Gmail as ${IMAP_USER}…`);
    await client.connect();

    const mailboxesToTry = ['INBOX', '[Gmail]/All Mail'];
    let found = null;

    for (const mbox of mailboxesToTry) {
      try {
        found = await findLatestCsv(client, mbox);
        if (found) break;
      } catch (e) {
        console.log(`Search in "${mbox}" failed:`, e?.message || e);
      }
    }

    if (!found) {
      console.error('No suitable "AC Daily Facility Report" CSV found in INBOX or [Gmail]/All Mail.');
      process.exit(1);
    }

    await ensureDirFor(OUT_CSV);
    await fs.writeFile(OUT_CSV, found.buf);
    console.log(`Saved CSV → ${OUT_CSV}`);
  } finally {
    try { await client.logout(); } catch {}
  }
}

main().catch((err) => {
  console.error('fetch_email failed:', err?.message || err);
  process.exit(1);
});
