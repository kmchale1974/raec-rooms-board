// scripts/fetch_email.js
// Node ESM file (package.json should have: "type": "module")

import fs from 'node:fs/promises';
import path from 'node:path';
import { ImapFlow } from 'imapflow';

const IMAP_HOST = 'imap.gmail.com';
const IMAP_PORT = 993;

const {
  IMAP_USER,
  IMAP_PASS,
  OUT_CSV = 'data/inbox/latest.csv',
} = process.env;

if (!IMAP_USER) {
  console.error('Missing IMAP_USER env var.');
  process.exit(1);
}
if (!IMAP_PASS) {
  console.error('Missing IMAP_PASS env var (Gmail App Password).');
  process.exit(1);
}

const CSV_NAME_RE = /AC\s*-\s*Daily\s*Facility\s*Global\s*Schedule.*\.csv$/i;
const SUBJECT_RE = /^AC\s+Daily\s+Facility\s+Report/i;

// Search since 7 days ago by default (adjust as you like)
function sinceDate(days = 7) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  // IMAP literal for SINCE uses date only, English three-letter month
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${d.getDate()}-${months[d.getMonth()]}-${d.getFullYear()}`;
}

async function ensureDir(p) {
  await fs.mkdir(path.dirname(p), { recursive: true });
}

async function findNewestBySubject(client, mailbox, sinceStr) {
  // Returns { uid, envelope } | null
  // Search by subject first
  try {
    await client.mailboxOpen(mailbox);
    const bySubject = await client.search({
      since: sinceStr,
      header: ['subject', 'AC Daily Facility Report'],
    });
    const uids = Array.isArray(bySubject) ? bySubject : [];
    if (uids.length) {
      // Take the newest UID
      const uid = uids[uids.length - 1];
      const [msg] = await client.fetchOne(uid, { envelope: true }, { uid: true }) || [];
      return { uid, envelope: msg?.envelope || null };
    }
  } catch (err) {
    console.warn(`Search in "${mailbox}" failed (subject): ${err?.message || err}`);
  }

  // Fall back: any CSV attachment with our filename pattern
  try {
    await client.mailboxOpen(mailbox);
    const bySince = await client.search({ since: sinceStr });
    const uids = Array.isArray(bySince) ? bySince : [];
    // Walk newest → oldest
    for (let i = uids.length - 1; i >= 0; i--) {
      const uid = uids[i];
      const body = await client.fetchOne(uid, { bodyStructure: true, envelope: true }, { uid: true });
      const bs = body?.bodyStructure;
      if (!bs) continue;

      const parts = flattenParts(bs);
      const csvPart = parts.find(p => {
        const name = (p.disposition?.params?.filename) || p.parameters?.name || '';
        return CSV_NAME_RE.test(name);
      });

      if (csvPart) {
        return { uid, envelope: body?.envelope || null };
      }
    }
  } catch (err) {
    console.warn(`Search in "${mailbox}" failed (fallback): ${err?.message || err}`);
  }

  return null;
}

function flattenParts(struct) {
  // Returns a flat array of leaf parts with common fields
  const out = [];
  (function walk(node, pathIdx = []) {
    if (!node) return;
    if (Array.isArray(node.childNodes) && node.childNodes.length) {
      node.childNodes.forEach((child, idx) => walk(child, pathIdx.concat(idx + 1)));
      return;
    }
    // Normalize fields we’ll need
    out.push({
      type: node.type,
      subtype: node.subtype,
      parameters: node.parameters || {},
      disposition: node.disposition || {},
      id: node.id,
      part: node.part, // string like "2"
      pathIdx,
    });
  })(struct);
  return out;
}

async function downloadCsv(client, mailbox, uid, outPath) {
  await client.mailboxOpen(mailbox);
  const msg = await client.fetchOne(uid, { bodyStructure: true, envelope: true }, { uid: true });
  if (!msg?.bodyStructure) throw new Error('No BODYSTRUCTURE');

  const parts = flattenParts(msg.bodyStructure);

  // Prefer CSV with our expected filename, otherwise any text/plain or application/octet-stream with .csv name
  const csvCandidate =
    parts.find(p => {
      const name = (p.disposition?.params?.filename) || p.parameters?.name || '';
      return CSV_NAME_RE.test(name);
    }) ||
    parts.find(p => {
      const name = (p.disposition?.params?.filename) || p.parameters?.name || '';
      return /\.csv$/i.test(name);
    });

  if (!csvCandidate?.part) {
    throw new Error('No CSV attachment part found in BODYSTRUCTURE.');
  }

  const download = await client.download(uid, csvCandidate.part, { uid: true });
  if (!download?.content) throw new Error('download() had no content stream.');

  await ensureDir(outPath);
  const write = (await import('node:stream/promises')).pipeline;
  await write(download.content, (await import('node:fs')).createWriteStream(outPath));
}

async function main() {
  console.log(`Connecting to Gmail as ${IMAP_USER}…`);

  const client = new ImapFlow({
    host: IMAP_HOST,
    port: IMAP_PORT,
    secure: true,
    auth: { user: IMAP_USER, pass: IMAP_PASS },
    logger: false,
  });

  await client.connect();

  try {
    const sinceStr = sinceDate(7);
    console.log(`Searching "INBOX" since ${new Date(Date.now() - 7*24*3600*1000)} for subject "AC Daily Facility Report"...`);
    let found = await findNewestBySubject(client, 'INBOX', sinceStr);

    if (!found) {
      console.log(`Searching "[Gmail]/All Mail" since ${new Date(Date.now() - 7*24*3600*1000)} for subject "AC Daily Facility Report"...`);
      found = await findNewestBySubject(client, '[Gmail]/All Mail', sinceStr);
    }

    if (!found) {
      console.error('No suitable "AC Daily Facility Report" CSV found in INBOX or [Gmail]/All Mail.');
      process.exit(1);
    }

    const subj = found.envelope?.subject || '(no subject)';
    const when = found.envelope?.date ? new Date(found.envelope.date) : 'unknown date';
    console.log(`Chosen uid=${found.uid} | ${when} | ${subj}`);

    await downloadCsv(client, client.mailbox?.path || 'INBOX', found.uid, OUT_CSV);
    console.log(`Saved CSV to ${OUT_CSV}`);
  } finally {
    try { await client.logout(); } catch {}
  }
}

main().catch(err => {
  console.error('fetch_email failed:', err?.message || err);
  process.exit(1);
});
